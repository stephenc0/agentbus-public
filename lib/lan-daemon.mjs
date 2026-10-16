import { sanitizeUsage } from './usage.mjs';
import { atomicWriteFileSync } from './atomic-file.mjs';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { Bonjour } from 'bonjour-service';
import { VERSION, UUID, AGENT_ID, MAX_FRAME, TLS_OPTIONS, remoteId, parseRemoteId, privateIPv4, overlayIPv4, peerRequest, daemonSocketPath, resolveMdnsInterface, readStaticPeers } from './lan.mjs';
import { createBlobStore, BLOB_OPS } from './blob.mjs';
import { hostCapabilities, hostAdvertisement, sessionAdvertisement, sanitizeCapabilities } from './host-capabilities.mjs';
import { smsGateway } from './lan-sms.mjs';
import { sanitizePresence } from './presence.mjs';
import { storageTracker, sanitizeStorage, storageAdvertisement } from './storage.mjs';
import { createLauncher, launcherCapabilities } from './session-launch.mjs';
import { buildInfo } from './build-info.mjs';
import { createKnownHosts } from './known-hosts.mjs';

const clean = (v, n = 160) => typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, n) : '';
export function publicAgent(a) {
  return { id: a.id, name: clean(a.name), kind: a.kind, clientType: clean(a.clientType || a.kind, 32), model: clean(a.model, 96) || null, modelSource: clean(a.modelSource || 'unknown', 32), status: clean(a.status, 32), statusAt: Number(a.statusAt) || 0, project: clean(a.project), deliveryReady: a.deliveryReady === true, wakeCapability: clean(a.wakeCapability, 48) || 'unknown', unavailableReason: clean(a.unavailableReason, 240) || null, deliveryBasis: clean(a.deliveryBasis, 240) || null, deliveryCheckedAt: Number(a.deliveryCheckedAt) || null };
}
export function discoveryPeer(service, selfId, allowLoopback = false) {
  const hostId = service.txt?.id;
  if (String(service.txt?.v) !== VERSION || !UUID.test(hostId || '') || hostId === selfId) return null;
  const address = [service.referer?.address, ...(service.addresses || [])].find((a) => privateIPv4(a, allowLoopback));
  if (!address || !Number.isInteger(service.port) || service.port < 1 || service.port > 65535) return null;
  return { hostId, address, port: service.port, name: clean(service.name), agents: [], checkedAt: 0 };
}

export async function startLan({ config, listLocal, deliverLocal, smsCall, capabilities = hostCapabilities(), presence = null, usage = null, storage = storageTracker({ dir: path.dirname(config.dir) }), launcher = createLauncher({ busDir: path.dirname(config.dir), listLocal }), mdns = true, allowLoopback = false, pollMs = 10000, log = (s) => process.stderr.write(`agentbus lan: ${s}\n`) }) {
  const wantedIface = mdns ? config.mdnsInterface || (config.bind && config.bind !== '0.0.0.0' ? config.bind : undefined) : undefined;
  const iface = resolveMdnsInterface(wantedIface);
  // Fail before listening rather than advertise on the wrong segment; the service manager retries.
  if (wantedIface && !iface) throw Error(`mdns interface ${wantedIface} has no private IPv4 yet`);
  fs.mkdirSync(config.dir, { recursive: true, mode: 0o700 }); fs.chmodSync(config.dir, 0o700);
  const receiptDir = path.join(config.dir, 'receipts'); fs.mkdirSync(receiptDir, { mode: 0o700, recursive: true });
  const peers = new Map(), active = new Map(), sockets = new Set();
  const knownHosts = createKnownHosts(path.join(config.dir, 'known-hosts.json'), { selfId: config.hostId });
  const advertisements = new Map();
  let closing = false, refreshing = false, bonjour, browser, timer;
  const socketPath = daemonSocketPath(config.dir), pipe = process.platform === 'win32';
  const snapshot = () => [...peers.values()].map(({ agents, ...p }) => ({ ...p, storage: sanitizeStorage(p.storage), usage: sanitizeUsage(p.usage), agentCount: agents.length }));
  const remoteList = () => [...peers.values()].filter((p) => Date.now() - p.checkedAt < 30000 && !p.error).flatMap((p) => p.agents.map((a) => ({ ...a, localId: a.id, id: remoteId(p.hostId, a.id), name: `${a.name}@${p.name}`, hostId: p.hostId, hostName: p.name, hostCapabilities: p.capabilities, hostPresence: p.presence || null, hostStorage: sanitizeStorage(p.storage), remote: true }))).slice(0, 256);

  async function receive(request, sourceHost, socket) {
    if (request.recipient !== config.hostId) return { ok: false, error: 'wrong recipient host' };
    if (request.op === 'agents') learn(sourceHost, socket, request.listen);
    if (request.op === 'agents') return { ok: true, reachBack: (() => { const p = peers.get(sourceHost); return !!p && !p.error && Date.now() - p.checkedAt < 30000; })(), hostId: config.hostId, name: config.name, capabilities, build: buildInfo, launching: launcher.snapshot ? launcher.snapshot() : await launcher.capabilities(), presence: presence?.current() || null, usage: sanitizeUsage(usage?.current()), storage: storage.current(), smsPrimary: config.smsPrimary || null, agents: listLocal().filter((a) => AGENT_ID.test(a.id)).map(publicAgent).slice(0, 256) };
    if (['spawn', 'spawn-status', 'spawn-stop'].includes(request.op)) {
      if (!AGENT_ID.test(request.from || '') || !remoteList().some((a) => a.id === remoteId(sourceHost, request.from))) return { ok: false, error: 'spawn sender must be a live agent on an authenticated peer' };
      try {
        const source = sourceHost + '/' + request.from;
        const result = request.op === 'spawn' ? await launcher.launch(request, source) : request.op === 'spawn-stop' ? await launcher.stop(request.id, source) : await launcher.status(request.id, source);
        return { ...result, ...(result.agentId ? { agentId: remoteId(config.hostId, result.agentId) } : {}) };
      } catch (e) { return { ok: false, error: e.message }; }
    }
    if (request.op === 'sms') return smsGateway(request, sourceHost, { config, call: smsCall, knownAgent: (host, id) => peers.get(host)?.smsPrimary === config.hostId && remoteList().some((a) => a.id === remoteId(host, id)) });
    const smsReply = request.op === 'sms-reply' && sourceHost === config.smsPrimary && request.from?.id === 'service:claw-messenger';
    if ((!smsReply && request.op !== 'send') || !UUID.test(request.id || '') || !AGENT_ID.test(request.to || '') || (!smsReply && !AGENT_ID.test(request.from?.id || '')) || typeof request.message !== 'string' || !request.message.trim() || Buffer.byteLength(request.message) > 65536) return { ok: false, error: 'invalid send request' };
    const key = `${sourceHost}-${request.id}`, file = path.join(receiptDir, key + '.json');
    const hash = crypto.createHash('sha256').update(JSON.stringify({ to: request.to, from: request.from, message: request.message })).digest('hex');
    if (active.has(key)) {
      if (active.get(key).hash !== hash) return { ok: false, error: 'message id reused with different contents' };
      return active.get(key).promise;
    }
    let previous; try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') return { ok: false, delivery: 'uncertain', error: 'unreadable delivery receipt' }; }
    if (previous) return previous.hash === hash ? previous.result : { ok: false, error: 'message id reused with different contents' };
    const target = listLocal().find((a) => a.id === request.to);
    if (!target) return { ok: false, delivery: 'unavailable', error: 'target is not live on this host' };
    const pending = { ok: false, delivery: 'uncertain', msg_id: request.id, error: 'delivery started; acknowledgement unavailable' };
    // Write before delivery. A restart never blindly repeats a possibly applied send.
    fs.writeFileSync(file, JSON.stringify({ hash, result: pending }), { mode: 0o600, flag: 'wx' });
    const promise = (async () => {
      let result;
      const from = { id: smsReply ? 'service:claw-messenger' : remoteId(sourceHost, request.from.id), name: `${clean(request.from.name)}@${sourceHost.slice(0, 8)}`, kind: request.from.id.split(':')[0] };
      try { result = await deliverLocal(target, from, request.message); }
      catch (e) { result = { ok: false, delivery: 'uncertain', error: e.message }; }
      // Don't expose local recovery paths, socket names, or filesystem errors.
      const reply = { ok: !!result.ok, delivery: result.delivery || (result.ok ? 'accepted' : 'uncertain'), msg_id: request.id, note: clean(result.note, 500), ...(result.error ? { error: result.delivery === 'unavailable' ? 'target unavailable' : 'remote delivery failed; inspect receiver status' } : {}) };
      atomicWriteFileSync(file, JSON.stringify({ hash, result: reply }), { mode: 0o600 });
      return reply;
    })();
    active.set(key, { hash, promise });
    try { return await promise; } finally { active.delete(key); }
  }

  async function sendToPeer(request) {
    const to = parseRemoteId(request.to);
    if (!to || !UUID.test(request.id || '') || typeof request.message !== 'string' || !request.message.trim() || Buffer.byteLength(request.message) > 65536) return { ok: false, error: 'invalid remote target/message' };
    const smsReply = request.op === 'sms-reply' && config.smsPrimary === config.hostId;
    const from = smsReply ? { id: 'service:claw-messenger', name: 'claw-messenger' } : listLocal().find((a) => a.id === request.from);
    if (!from) return { ok: false, error: 'sender must be a live local agent; pass from=<local id>' };
    const peer = peers.get(to.hostId);
    if (!peer || peer.error || Date.now() - peer.checkedAt >= 30000) return { ok: false, delivery: 'unavailable', error: 'remote host is not authenticated/reachable' };
    return peerRequest(config, peer, { op: smsReply ? 'sms-reply' : 'send', id: request.id, to: to.agentId, from: { id: from.id, name: clean(from.name) }, message: request.message }, 15000);
  }
  async function localRequest(request) {
    if (request.op === 'forget-host') {
      const peer = peers.get(request.hostId);
      if (peer && !peer.error && Date.now() - peer.checkedAt < 30000) return { ok: false, error: 'host is still authenticated and live; it cannot be retired yet' };
      try { knownHosts.forget(request.hostId); return { ok: true, hostId: request.hostId, note: 'removed from presence expectations only; future authenticated discovery remembers it again' }; }
      catch (e) { return { ok: false, error: e.message }; }
    }
    if (request.op === 'status') return { ok: true, hostId: config.hostId, name: config.name, capabilities, build: buildInfo, launching: launcher.snapshot ? launcher.snapshot() : await launcher.capabilities(), presence: presence?.current() || null, usage: sanitizeUsage(usage?.current()), storage: storage.current(), smsPrimary: config.smsPrimary || null, smsRole: config.smsPrimary === config.hostId ? 'primary' : config.smsPrimary ? 'follower' : 'disabled', port: server.address()?.port, peers: snapshot(), knownHosts: knownHosts.snapshot(), knownHostCoverageComplete: knownHosts.complete };
    if (['spawn', 'spawn-status', 'spawn-stop'].includes(request.op)) {
      if (!listLocal().some((a) => a.id === request.from)) return { ok: false, error: 'sender must be a live local agent; pass from=<local id>' };
      const matches = [...peers.values()].filter((p) => p.hostId === request.host || p.name === request.host);
      if (matches.length !== 1) return { ok: false, error: 'host must identify exactly one paired peer' };
      const peer = matches[0];
      if (peer.error || Date.now() - peer.checkedAt >= 30000) return { ok: false, error: 'remote host is not authenticated/reachable' };
      return peerRequest(config, peer, request, 10000);
    }
    if (request.op === 'list') return { ok: true, agents: remoteList() };
    if (request.op === 'send') return sendToPeer(request);
    if (request.op === 'sms-reply') {
      if (config.smsPrimary !== config.hostId) return { ok: false, error: 'only the sms primary can forward replies' };
      return sendToPeer(request);
    }
    if (request.op === 'sms') {
      const primary = peers.get(config.smsPrimary);
      if (!primary || primary.error || Date.now() - primary.checkedAt >= 30000 || primary.smsPrimary !== config.smsPrimary) return { ok: false, error: 'configured sms primary is unavailable; no automatic failover' };
      const agent = request.agent || request.body?.agent || request.body?.holder;
      if (request.method !== 'GET' && !listLocal().some((a) => a.id === agent)) return { ok: false, error: 'sms actor must be a live local session' };
      return peerRequest(config, primary, { ...request, agent }, 50000);
    }
    return { ok: false, error: 'unknown operation' };
  }
  function handle(socket, handler, streamHandler) {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    if (sockets.size > 128) { socket.destroy(); return; }
    const deadline = setTimeout(() => socket.destroy(), 55000);
    socket.on('close', () => clearTimeout(deadline));
    let size = 0, chunks = [], handled = false;
    socket.on('data', async function onData(chunk) {
      if (handled) return;
      size += chunk.length; if (size > MAX_FRAME) { socket.destroy(); return; }
      chunks.push(chunk); if (!chunk.includes(10)) return;
      handled = true;
      if (streamHandler) {
        // Blob ops own the socket after their header line: raw bytes follow, so no 1 MiB cap or 55s deadline.
        const all = Buffer.concat(chunks), nl = all.indexOf(10);
        let head = null; try { head = JSON.parse(all.subarray(0, nl).toString('utf8')); } catch {}
        if (head && BLOB_OPS.has(head.op)) {
          socket.removeListener('data', onData); clearTimeout(deadline); socket.pause();
          if (nl + 1 < all.length) socket.unshift(all.subarray(nl + 1));
          try { await streamHandler(head, socket); } catch (e) { log(`blob: ${e.message}`); socket.destroy(); }
          return;
        }
      }
      let result;
      try { const request = JSON.parse(Buffer.concat(chunks).toString('utf8').split('\n')[0]); result = request && typeof request === 'object' ? await handler(request) : { ok: false, error: 'invalid request' }; }
      catch (e) { log(e.message); result = { ok: false, delivery: 'uncertain', error: 'request failed' }; }
      if (!socket.destroyed) socket.end(JSON.stringify(result) + '\n');
    });
  }
  const blobs = createBlobStore({ busDir: path.dirname(config.dir), hostId: config.hostId, log });
  const server = tls.createServer({ ...TLS_OPTIONS, handshakeTimeout: 5000, pskCallback(socket, identity) {
    const id = identity?.replace(/^agentbus:/, '');
    if (!identity?.startsWith('agentbus:') || !UUID.test(id || '') || id === config.hostId) return null;
    socket.agentbusHostId = id; return config.key;
  } }, (socket) => handle(socket, (r) => receive(r, socket.agentbusHostId, socket), (r, s) => r.recipient === config.hostId ? blobs.serve(r, s, socket.agentbusHostId) : blobs.reject(s, 'wrong recipient host')));
  server.on('tlsClientError', () => {});
  server.maxConnections = 128;
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  const local = net.createServer((socket) => handle(socket, localRequest));
  // An active socket is never removed. Refused sockets can be leftovers of a crash.
  if (fs.existsSync(socketPath)) {
    const alive = await new Promise((resolve) => { const s = net.createConnection(socketPath); s.on('connect', () => { s.destroy(); resolve(true); }); s.on('error', (e) => resolve(e.code !== 'ECONNREFUSED')); s.setTimeout(1000, () => { s.destroy(); resolve(true); }); });
    if (alive) throw Error('lan daemon already running (or socket inaccessible)');
    if (!pipe) fs.unlinkSync(socketPath); // named pipes vanish with their owner
  }
  local.listen(socketPath);
  await once(local, 'listening'); if (!pipe) fs.chmodSync(socketPath, 0o600);
  try { server.listen(config.port, config.bind); await once(server, 'listening'); }
  catch (e) { local.close(); throw e; }

  async function refreshPeer(peer) {
    const response = await peerRequest(config, peer, { op: 'agents', listen: { port: server.address().port } }, peer.static || peer.learned ? 8000 : 3000);
    if (peers.get(peer.hostId) !== peer || closing) return;
    if (response.ok && response.hostId === peer.hostId && Array.isArray(response.agents)) {
      peer.name = clean(response.name, 63);
      peer.capabilities = sanitizeCapabilities(response.capabilities);
      peer.presence = sanitizePresence(response.presence);
      peer.usage = sanitizeUsage(response.usage);
      peer.storage = sanitizeStorage(response.storage);
      peer.launching = response.launching;
      peer.build = response.build;
      peer.smsPrimary = response.smsPrimary;
      peer.reachBack = response.reachBack === true;
      peer.agents = response.agents.filter((a) => a && AGENT_ID.test(a.id || '') && a.kind === a.id.split(':')[0]).slice(0, 256).map(publicAgent);
      peer.checkedAt = Date.now(); delete peer.error;
      if (!knownHosts.observe(peer)) log('could not persist authenticated host history; presence coverage is partial');
    } else { peer.agents = []; peer.error = 'unreachable or pairing key/identity mismatch'; }
  }
  function discover(service) {
    const peer = discoveryPeer(service, config.hostId, allowLoopback);
    if (!peer || closing || (!peers.has(peer.hostId) && peers.size >= 64)) return;
    const old = peers.get(peer.hostId);
    if (old?.address === peer.address && old.port === peer.port) return;
    peers.set(peer.hostId, peer);
    // Refresh in the bounded polling loop, not once per unauthenticated packet.
  }
  function forget(service) {
    const peer = peers.get(service.txt?.id);
    if (peer && peer.port === service.port && !peer.static) peers.delete(peer.hostId);
  }
  // Static peers come from config (re-read every poll, so `lan peer add` needs no restart). They are
  // dialed directly: overlay/wan links where multicast discovery cannot reach. mdns may still find the
  // same host on a shared lan; the lan address then wins until it disappears.
  function syncStatic() {
    const wanted = readStaticPeers(config.dir, config.hostId);
    if (!wanted) return;
    const ids = new Set(wanted.map((p) => p.hostId));
    for (const [id, p] of peers) if (p.static && !ids.has(id)) peers.delete(id);
    for (const p of wanted) {
      const old = peers.get(p.hostId);
      // a working mdns (lan) entry wins; one that stopped answering (host left the lan without an mdns goodbye) yields to the static route
      if (old && !old.static && !old.learned && !old.error) continue;
      if (old?.static && old.address === p.address && old.port === p.port) continue;
      if (!old && peers.size >= 64) continue;
      peers.set(p.hostId, { hostId: p.hostId, address: p.address, port: p.port, name: p.name || p.hostId.slice(0, 8), agents: [], checkedAt: 0, static: true });
    }
  }
  // A psk-authenticated inventory request from an unknown host teaches us where to dial it back: the
  // tcp source address plus its advertised listen port. Only overlay/private sources, never replacing
  // configured or mdns peers. Learned peers that stay unreachable for 10 minutes are dropped.
  function learn(hostId, socket, listen) {
    if (!UUID.test(hostId || '') || hostId === config.hostId) return;
    const address = String(socket?.remoteAddress || '').replace(/^::ffff:/, '');
    const port = Number(listen?.port);
    if (!(overlayIPv4(address) || privateIPv4(address, allowLoopback)) || !Number.isInteger(port) || port < 1 || port > 65535) return;
    const known = peers.get(hostId);
    // a learned peer that restarted on a new (os-assigned) port or address is followed, not dropped
    // so is a stale mdns entry (host left the lan and now reaches us over tailscale); configured static peers are never overridden
    if (known && !known.static && (known.learned || known.error) && (known.address !== address || known.port !== port)) { known.learned = true; known.address = address; known.port = port; known.learnedAt = Date.now(); delete known.error; return; }
    if (known || peers.size >= 64) return;
    peers.set(hostId, { hostId, address, port, name: hostId.slice(0, 8), agents: [], checkedAt: 0, learned: true, learnedAt: Date.now() });
    log(`learned peer ${hostId.slice(0, 8)} at ${address}:${port}`);
  }
  function expireLearned() {
    for (const [id, p] of peers) if (p.learned && p.error && Date.now() - Math.max(p.checkedAt || 0, p.learnedAt) > 600000) peers.delete(id);
  }
  async function refresh() {
    if (refreshing || closing) return; refreshing = true;
    try {
      // Usage is slow network IO: never stall presence sampling or LAN discovery.
      if (usage) void usage.update().catch(() => {});
      if (presence) await presence.update().catch((e) => log(`presence: ${e.message}`));
      await storage.update();
      await advertise();
      browser?.expire(); browser?.update();
      for (const announced of browser?.services || []) discover(announced);
      syncStatic(); expireLearned();
      const all = [...peers.values()];
      for (let i = 0; i < all.length && !closing; i += 4) await Promise.all(all.slice(i, i + 4).map(refreshPeer));
      if (closing) return;
      const snapshotPath = path.join(config.dir, 'remote-agents.json');
      atomicWriteFileSync(snapshotPath, JSON.stringify({ at: Date.now(), agents: remoteList().map((a) => ({ id: a.id })) }), { mode: 0o600 });
    } finally { refreshing = false; }
  }
  async function advertise() {
    if (!bonjour || closing) return;
    const agents = listLocal().filter((a) => AGENT_ID.test(a.id)).slice(0, 256);
    const wanted = new Map([['host', { name: `agentbus-${config.hostId}`, type: 'agentbus', txt: hostAdvertisement(config, capabilities, agents.length) }]]);
    for (const agent of agents) wanted.set(agent.id, { name: crypto.createHash('sha256').update(`${config.hostId}/${agent.id}`).digest('hex').slice(0, 48), type: 'agentbus-agent', txt: sessionAdvertisement(config.hostId, agent) });
    for (const entry of storage.current()) wanted.set(`storage:${entry.id}`, { name: crypto.createHash('sha256').update(`${config.hostId}/storage/${entry.id}`).digest('hex').slice(0, 48), type: 'agentbus-store', txt: storageAdvertisement(config.hostId, entry) });
    for (const [id, old] of advertisements) {
      if (JSON.stringify(wanted.get(id)) !== old.fingerprint) {
        old.service.destroyed = true;
        await new Promise((r) => old.service.stop(r)); advertisements.delete(id);
      }
    }
    for (const [id, entry] of wanted) {
      if (advertisements.has(id) || closing) continue;
      const published = bonjour.publish({ ...entry, protocol: 'tcp', port: server.address().port, disableIPv6: true, probe: false });
      published.on('error', (e) => log(`advertisement: ${e.message}`));
      advertisements.set(id, { service: published, fingerprint: JSON.stringify(entry) });
    }
  }
  if (mdns) {
    if (iface) log(`mdns on ${iface}${wantedIface !== iface ? ` (${wantedIface})` : ''}`);
    bonjour = new Bonjour(iface ? { interface: iface } : {}, (e) => log(`mdns: ${e.message}`));
    browser = bonjour.find({ type: 'agentbus', protocol: 'tcp' });
    browser.on('up', discover); browser.on('srv-update', discover); browser.on('txt-update', discover); browser.on('down', forget);
    await advertise();
  }
  syncStatic();
  timer = setInterval(() => refresh().catch((e) => log(e.message)), pollMs); timer.unref();
  async function close() {
    if (closing) return;
    closing = true; clearInterval(timer); browser?.stop(); presence?.close();
    if (bonjour) await new Promise((resolve) => bonjour.unpublishAll(resolve));
    bonjour?.destroy();
    for (const socket of sockets) socket.destroy();
    blobs.close();
    fs.rmSync(path.join(config.dir, 'remote-agents.json'), { force: true });
    await Promise.all([new Promise((r) => local.close(r)), new Promise((r) => server.close(r))]);
  }
  return { port: server.address().port, socketPath, discover, forget, refresh, peers, close };
}
