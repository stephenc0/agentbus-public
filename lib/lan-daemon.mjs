import { sanitizeUsage } from './usage.mjs';
import { atomicWriteFileSync } from './atomic-file.mjs';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { Bonjour } from 'bonjour-service';
import { VERSION, UUID, AGENT_ID, MAX_FRAME, TLS_OPTIONS, remoteId, parseRemoteId, privateIPv4, overlayIPv4, peerRequest, probeRequest, daemonSocketPath, resolveMdnsInterface, readStaticPeers, readHostCost, listenInfo, updateLanConfig, isHostRole, detectOverlayIPv4 } from './lan.mjs';
import { createTailnetDiscovery } from './tailnet-discovery.mjs';
import { createBlobStore, BLOB_OPS } from './blob.mjs';
import { hostCapabilities, hostAdvertisement, sessionAdvertisement, sanitizeCapabilities, hostCost } from './host-capabilities.mjs';
import { smsGateway } from './lan-sms.mjs';
import { sanitizePresence } from './presence.mjs';
import { storageTracker, sanitizeStorage, storageAdvertisement } from './storage.mjs';
import { createLauncher, launcherCapabilities } from './session-launch.mjs';
import { buildInfo } from './build-info.mjs';
import { createKnownHosts, shareKnownHosts, sanitizeSharedKnownHosts } from './known-hosts.mjs';
import { createProvisioner, sanitizeCloud, sanitizeBlobActivity } from './cloud.mjs';

const clean = (v, n = 160) => typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, n) : '';
export function publicAgent(a) {
  return { id: a.id, name: clean(a.name), kind: a.kind, clientType: clean(a.clientType || a.kind, 32), model: clean(a.model, 96) || null, modelSource: clean(a.modelSource || 'unknown', 32), status: clean(a.status, 32), statusAt: Number(a.statusAt) || 0, project: clean(a.project), deliveryReady: a.deliveryReady === true, wakeCapability: clean(a.wakeCapability, 48) || 'unknown', unavailableReason: clean(a.unavailableReason, 240) || null, deliveryBasis: clean(a.deliveryBasis, 240) || null, deliveryCheckedAt: Number(a.deliveryCheckedAt) || null };
}
export function discoveryPeer(service, selfId, allowLoopback = false) {
  const hostId = service.txt?.id;
  if (String(service.txt?.v) !== VERSION || !UUID.test(hostId || '') || hostId === selfId) return null;
  const address = [service.referer?.address, ...(service.addresses || [])].find((a) => privateIPv4(a, allowLoopback));
  if (!address || !Number.isInteger(service.port) || service.port < 1 || service.port > 65535) return null;
  // no name from mdns: the service name is unauthenticated and literally `agentbus-<hostId>`. the daemon fills in
  // the last authenticated name (see knownName) until the peer's own inventory answers.
  return { hostId, address, port: service.port, name: null, agents: [], checkedAt: 0 };
}

// launch capabilities pass through as the peer sent them; only the slot count, which dashboards graph, is pinned to a
// non-negative integer (null when absent, e.g. an older peer).
export function sanitizeLaunching(launching) {
  if (!launching || typeof launching !== 'object' || Array.isArray(launching)) return null;
  const n = launching.activeSessions;
  return { ...launching, activeSessions: Number.isInteger(n) && n >= 0 && n <= 1024 ? n : null };
}
export async function startLan({ config, listLocal, deliverLocal, smsCall, capabilities = hostCapabilities(), presence = null, usage = null, storage = storageTracker({ dir: path.dirname(config.dir) }), launcher = createLauncher({ busDir: path.dirname(config.dir), listLocal }), mdns = true, allowLoopback = false, pollMs = 10000, cloud, tailnet, log = (s) => process.stderr.write(`agentbus lan: ${s}\n`) }) {
  const wantedIface = mdns ? config.mdnsInterface || (config.bind && config.bind !== '0.0.0.0' ? config.bind : undefined) : undefined;
  const iface = resolveMdnsInterface(wantedIface);
  // Fail before listening rather than advertise on the wrong segment; the service manager retries.
  if (wantedIface && !iface) throw Error(`mdns interface ${wantedIface} has no private IPv4 yet`);
  fs.mkdirSync(config.dir, { recursive: true, mode: 0o700 }); fs.chmodSync(config.dir, 0o700);
  const receiptDir = path.join(config.dir, 'receipts'); fs.mkdirSync(receiptDir, { mode: 0o700, recursive: true });
  const peers = new Map(), active = new Map(), sockets = new Set();
  const knownHosts = createKnownHosts(path.join(config.dir, 'known-hosts.json'), { selfId: config.hostId });
  const advertisements = new Map();
  // hardware is probed once; the price comes from config and follows edits on the next poll (see readHostCost).
  // a client (the default) never samples or shares presence or account usage and accepts no launches. only a peer that
  // itself answers role: "host" is treated as one; an older build that says nothing is a client (see lan.mjs validateRole).
  const client = !isHostRole(config), role = client ? 'client' : 'host';
  if (client) { presence = null; usage = null; }
  const CLIENT_LAUNCHING = { enabled: false, remote: false, role: 'client', maxSessions: 0, activeSessions: 0, runtimes: {}, roots: [] };
  let cost = hostCost(config);
  // cloud provisioner: only on a host with ~/.agentbus/cloud/config.json (or injected options in tests). a broken cloud
  // config disables provisioning, never the daemon.
  let provisioner = null;
  if (cloud !== false) { try { provisioner = createProvisioner({ config, busDir: path.dirname(config.dir), peers, forget: (id) => knownHosts.forget(id), log, pollMs, ...(cloud || {}) }); if (provisioner) log(`cloud provisioner: offers ${provisioner.offers().join(', ')}`); } catch (e) { log(`cloud provisioner disabled: ${e.message}`); } }
  const caps = () => ({ ...capabilities, ...cost });
  let closing = false, refreshing = false, bonjour, browser, timer;
  const socketPath = daemonSocketPath(config.dir), pipe = process.platform === 'win32';
  // a peer that stopped answering keeps its last presence sample internally, but status never hands it out as current:
  // consumers (host_status, dashboards) would show a host that left hours ago as present. only its sample time remains.
  const live = (p) => !p.error && Date.now() - p.checkedAt < 30000;
  const snapshot = () => [...peers.values()].map(({ agents, ...p }) => ({ ...p, presence: live(p) ? p.presence : null, lastPresenceAt: p.presence?.at ?? null, storage: sanitizeStorage(p.storage), usage: p.role === 'host' ? sanitizeUsage(p.usage) : null, agentCount: agents.length }));
  const remoteList = () => [...peers.values()].filter((p) => Date.now() - p.checkedAt < 30000 && !p.error).flatMap((p) => p.agents.map((a) => ({ ...a, localId: a.id, id: remoteId(p.hostId, a.id), name: `${a.name}@${p.name}`, hostId: p.hostId, hostName: p.name, hostCapabilities: p.capabilities, hostPresence: p.presence || null, hostStorage: sanitizeStorage(p.storage), remote: true }))).slice(0, 256);

  async function receive(request, sourceHost, socket) {
    // a tailnet discovery probe (lan.mjs probeRequest) does not know our id yet: it authenticated with the group key like
    // any request, is learned like any inventory request (so we dial the prober back) and is answered with our identity.
    const probe = request.op === 'agents' && request.recipient === null && request.discover === true;
    if (request.recipient !== config.hostId && !probe) return { ok: false, error: 'wrong recipient host' };
    if (request.op === 'agents') learn(sourceHost, socket, request.listen);
    if (request.op === 'agents') return { ok: true, reachBack: (() => { const p = peers.get(sourceHost); return !!p && !p.error && Date.now() - p.checkedAt < 30000; })(), hostId: config.hostId, name: config.name, capabilities: caps(), role, ephemeral: config.ephemeral === true, ...(process.env.AGENTBUS_CODE_SOURCE ? { codeSource: clean(process.env.AGENTBUS_CODE_SOURCE, 120) } : {}), ...(provisioner ? { cloud: provisioner.snapshot() } : {}), ...(config.ephemeral ? { blob: blobs.activity() } : {}), introductions: introductions(), build: buildInfo, launching: client ? CLIENT_LAUNCHING : launcher.snapshot ? launcher.snapshot() : await launcher.capabilities(), presence: presence?.current() || null, usage: client ? null : sanitizeUsage(usage?.current()), storage: storage.current(), smsPrimary: config.smsPrimary || null, knownHosts: shareKnownHosts(knownHosts.snapshot()), agents: listLocal().filter((a) => AGENT_ID.test(a.id)).map(publicAgent).slice(0, 256) };
    if (['spawn', 'spawn-status', 'spawn-stop'].includes(request.op)) {
      if (client) return { ok: false, error: 'this machine is a client: it accepts no session launches (agentbus lan role host to change that)' };
      if (!AGENT_ID.test(request.from || '') || !remoteList().some((a) => a.id === remoteId(sourceHost, request.from))) return { ok: false, error: 'spawn sender must be a live agent on an authenticated peer' };
      try {
        const source = sourceHost + '/' + request.from;
        const result = request.op === 'spawn' ? await launcher.launch(request, source) : request.op === 'spawn-stop' ? await launcher.stop(request.id, source) : await launcher.status(request.id, source);
        return { ...result, ...(result.agentId ? { agentId: remoteId(config.hostId, result.agentId) } : {}) };
      } catch (e) { return { ok: false, error: e.message }; }
    }
    if (request.op === 'cloud') {
      if (!provisioner) return { ok: false, error: 'this host provisions no cloud offers' };
      if (request.action !== 'status' && (!AGENT_ID.test(request.from || '') || !remoteList().some((a) => a.id === remoteId(sourceHost, request.from)))) return { ok: false, error: 'cloud up/down sender must be a live agent on an authenticated peer' };
      try { return await provisioner.request(request, { hostId: sourceHost, hostName: peers.get(sourceHost)?.name || null, agentId: request.from || null }); } catch (e) { return { ok: false, error: e.message }; }
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
  // a live pod announced by a provisioner is dialed directly by every group host, so a requester's blob and spawn
  // traffic never relays through the provisioner. only overlay (tailscale) addresses, or loopback in tests.
  function hint(pod, name, { ephemeral = true } = {}) {
    if (!pod || !UUID.test(pod.hostId || '') || pod.hostId === config.hostId || peers.has(pod.hostId) || peers.size >= 64) return;
    if (!(overlayIPv4(pod.address) || (allowLoopback && /^127\./.test(pod.address || ''))) || !Number.isInteger(pod.port)) return;
    peers.set(pod.hostId, { hostId: pod.hostId, address: pod.address, port: pod.port, name: clean(name, 63) || knownName(pod.hostId), agents: [], checkedAt: 0, learned: true, learnedAt: Date.now(), ...(ephemeral ? { ephemeral: true } : { introduced: true }) });
    log(`${ephemeral ? 'cloud pod' : 'introduced host'} ${name} at ${pod.address}:${pod.port}`);
  }
  const hintAll = (cloudView) => { for (const o of cloudView?.offers || []) if (o.state === 'live' && o.pod) hint(o.pod, o.name); };
  // provisioners this host can vouch for (itself, or an authenticated peer that advertised its own tailscale address)
  function introductions() {
    const out = [];
    const self = provisioner?.snapshot().provisioner;
    if (self) out.push(self);
    for (const p of peers.values()) if (p.cloud?.provisioner && !p.error && Date.now() - p.checkedAt < 30000 && p.cloud.provisioner.hostId === p.hostId) out.push(p.cloud.provisioner);
    return out.slice(0, 4);
  }
  // what this host sees of a live pod: whether it is authenticated here and whether the pod reaches back
  const fromHere = (o) => { const p = o.pod && peers.get(o.pod.hostId); return o.state === 'live' ? { ...o, fromHere: p ? { authenticated: !p.error && Date.now() - p.checkedAt < 30000, reachBack: p.reachBack === true } : { authenticated: false, reachBack: false, note: 'not dialed yet; within one poll (~10s) of the provisioner announcing it' } } : o; };
  async function localCloud(request) {
    if (!['status', 'up', 'down'].includes(request.action)) return { ok: false, error: 'cloud action must be status, up or down' };
    if (request.action !== 'status' && !listLocal().some((a) => a.id === request.from)) return { ok: false, error: 'sender must be a live local agent; pass from=<local id>' };
    const provisioners = [...peers.values()].filter((p) => p.cloud?.offers?.length && !p.error && Date.now() - p.checkedAt < 30000);
    const self = provisioner && (!request.host || request.host === config.name || request.host === config.hostId);
    if (request.action === 'status' && !request.host) {
      const out = [];
      if (provisioner) out.push({ hostId: config.hostId, name: config.name, ...provisioner.snapshot() });
      for (const p of provisioners) out.push({ hostId: p.hostId, name: p.name, ...p.cloud });
      return { ok: true, provisioners: out.map((v) => ({ ...v, offers: v.offers.map(fromHere) })) };
    }
    if (self) { const r = await provisioner.request(request, { hostId: config.hostId, hostName: config.name, agentId: request.from || null }); if (r.offer) r.offer = fromHere(r.offer); return r; }
    const matches = provisioners.filter((p) => (!request.host || p.hostId === request.host || p.name === request.host) && (!request.offer || p.cloud.offers.some((o) => o.name === request.offer)));
    if (matches.length !== 1) return { ok: false, error: matches.length ? 'several provisioners match; pass host' : `no authenticated provisioner offers ${request.offer || 'cloud pods'}; see cloud_status` };
    const r = await peerRequest(config, matches[0], { op: 'cloud', action: request.action, offer: request.offer, maxHours: request.maxHours, maxUsd: request.maxUsd, force: request.force, purgeAll: request.purgeAll, from: request.from }, 30000);
    if (r.offer) { const o = sanitizeCloud({ offers: [r.offer] })?.offers[0]; if (o) { hintAll({ offers: [o] }); r.offer = fromHere(o); } }
    if (Array.isArray(r.offers)) { const c = sanitizeCloud(r); hintAll(c); r.offers = c.offers.map(fromHere); }
    return { ...r, provisioner: matches[0].name };
  }
  async function localRequest(request) {
    if (request.op === 'forget-host') {
      const peer = peers.get(request.hostId);
      if (peer && !peer.error && Date.now() - peer.checkedAt < 30000) return { ok: false, error: 'host is still authenticated and live; it cannot be retired yet' };
      // a retired peer also leaves the live table (learned/mdns entries only; a configured static peer stays until `lan peer remove`),
      // so status and host_status stop listing a dead host as unreachable for the rest of the learned-peer grace period.
      if (peer && !peer.static) peers.delete(request.hostId);
      try { knownHosts.forget(request.hostId); return { ok: true, hostId: request.hostId, note: 'removed from presence expectations only; future authenticated discovery remembers it again' }; }
      catch (e) { return { ok: false, error: e.message }; }
    }
    if (request.op === 'status') return { ok: true, hostId: config.hostId, name: config.name, capabilities: caps(), role, ...(provisioner ? { cloud: provisioner.snapshot() } : {}), tailnet: discovery ? discovery.snapshot() : { enabled: false }, build: buildInfo, launching: client ? CLIENT_LAUNCHING : launcher.snapshot ? launcher.snapshot() : await launcher.capabilities(), presence: presence?.current() || null, usage: client ? null : sanitizeUsage(usage?.current()), storage: storage.current(), smsPrimary: config.smsPrimary || null, smsRole: config.smsPrimary === config.hostId ? 'primary' : config.smsPrimary ? 'follower' : 'disabled', port: server.address()?.port, peers: snapshot(), knownHosts: knownHosts.snapshot(), knownHostCoverageComplete: knownHosts.complete };
    if (['spawn', 'spawn-status', 'spawn-stop'].includes(request.op)) {
      if (!listLocal().some((a) => a.id === request.from)) return { ok: false, error: 'sender must be a live local agent; pass from=<local id>' };
      const matches = [...peers.values()].filter((p) => p.hostId === request.host || p.name === request.host);
      if (matches.length !== 1) return { ok: false, error: 'host must identify exactly one paired peer' };
      const peer = matches[0];
      if (peer.role !== 'host' && request.op === 'spawn') return { ok: false, error: `${peer.name} is a client: it accepts no session launches` };
      if (peer.error || Date.now() - peer.checkedAt >= 30000) return { ok: false, error: 'remote host is not authenticated/reachable' };
      return peerRequest(config, peer, request, 10000);
    }
    if (request.op === 'cloud') return localCloud(request);
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
  // tailnet discovery (tailnet-discovery.mjs): the node list from the local tailscale, probed on the agentbus port with
  // the normal psk inventory request. a member that answers joins the peer table as a learned peer, never the config.
  // `tailnet: false` (tests) skips it; a config "tailnetDiscovery": false makes it a no-op that status still reports.
  const discovery = tailnet === false ? null : createTailnetDiscovery({
    config, log, allowLoopback, ...(tailnet || {}),
    probe: (address, port, timeout) => probeRequest(config, { address, port }, listenInfo(config, server.address().port, address), timeout),
    hasPeer: (hostId) => peers.has(hostId),
    peerAt: (address, port) => [...peers.values()].some((p) => p.address === address && p.port === port),
    selfAddresses: () => [config.advertiseAddress, overlayIPv4(config.bind) ? config.bind : null, ...detectOverlayIPv4()].filter(Boolean),
    add: ({ hostId, address, port, name }) => {
      if (closing || peers.has(hostId) || peers.size >= 64) return;
      const shown = clean(name, 63) || knownName(hostId);
      peers.set(hostId, { hostId, address, port, name: shown, agents: [], checkedAt: 0, learned: true, learnedAt: Date.now(), discovered: true });
      log(`tailnet discovery: member ${shown} at ${address}:${port}`);
    },
  });
  if (discovery) { const d = discovery.snapshot(); log(d.enabled ? `tailnet discovery: on, probing port ${d.port}${d.includeShared ? ' (shared nodes too)' : ''}` : 'tailnet discovery: off (config tailnetDiscovery)'); }

  async function refreshPeer(peer) {
    const response = await peerRequest(config, peer, { op: 'agents', listen: listenInfo(config, server.address().port, peer.address) }, peer.static || peer.learned ? 8000 : 3000);
    if (peers.get(peer.hostId) !== peer || closing) return;
    if (response.ok && response.hostId === peer.hostId && Array.isArray(response.agents)) {
      peer.name = clean(response.name, 63);
      peer.capabilities = sanitizeCapabilities(response.capabilities);
      // only a peer that declares itself a host has its presence and usage used; an older build that still sends them
      // without a role is a client, and they are dropped
      peer.role = response.role === 'host' ? 'host' : 'client';
      peer.presence = peer.role === 'host' ? sanitizePresence(response.presence) : null;
      peer.usage = peer.role === 'host' ? sanitizeUsage(response.usage) : null;
      peer.storage = sanitizeStorage(response.storage);
      peer.launching = sanitizeLaunching(response.launching);
      peer.build = response.build;
      peer.codeSource = clean(response.codeSource, 120) || null;
      peer.smsPrimary = response.smsPrimary;
      peer.reachBack = response.reachBack === true;
      peer.knownHosts = sanitizeSharedKnownHosts(response);
      peer.ephemeral = response.ephemeral === true;
      peer.cloud = sanitizeCloud(response.cloud);
      peer.blob = sanitizeBlobActivity(response.blob);
      hintAll(peer.cloud);
      for (const intro of Array.isArray(response.introductions) ? response.introductions.slice(0, 4) : []) hint(intro, intro?.name, { ephemeral: false });
      peer.agents = response.agents.filter((a) => a && AGENT_ID.test(a.id || '') && a.kind === a.id.split(':')[0]).slice(0, 256).map(publicAgent);
      peer.checkedAt = Date.now(); delete peer.error;
      // an ephemeral host (a rented cloud pod) is never written to the host history: once it is gone, presence must not
      // keep expecting it. a record from before it declared itself ephemeral is dropped.
      if (peer.introduced && !peer.ephemeral) {
        delete peer.introduced;
        try {
          updateLanConfig(path.dirname(config.dir), (c) => (c.peers || []).some((p) => p.hostId === peer.hostId) ? c : { ...c, peers: [...(c.peers || []), { hostId: peer.hostId, address: peer.address, port: peer.port, ...(/^[a-zA-Z0-9_. -]{1,63}$/.test(peer.name || '') ? { name: peer.name } : {}) }] });
          log(`introduced host ${peer.name} saved as a static peer (${peer.address}:${peer.port})`);
        } catch (e) { log(`could not save introduced host ${peer.name} as a static peer: ${e.message}`); }
      }
      if (peer.ephemeral) { if (knownHosts.snapshot().some((h) => h.hostId === peer.hostId)) { try { knownHosts.forget(peer.hostId); } catch { log('could not drop an ephemeral host from host history'); } } }
      else if (!knownHosts.observe(peer)) log('could not persist authenticated host history; presence coverage is partial');
    } else { peer.agents = []; peer.error = 'unreachable or pairing key/identity mismatch'; }
  }
  // a peer re-found at a new address/port (its daemon restarted) keeps the name it last authenticated with instead of a
  // placeholder, so `lan status` never shows a known host under its id while it re-authenticates.
  const knownName = (hostId) => peers.get(hostId)?.name || knownHosts.snapshot().find((h) => h.hostId === hostId)?.name || hostId.slice(0, 8);
  function discover(service) {
    const peer = discoveryPeer(service, config.hostId, allowLoopback);
    if (!peer || closing || (!peers.has(peer.hostId) && peers.size >= 64)) return;
    const old = peers.get(peer.hostId);
    if (old?.address === peer.address && old.port === peer.port) return;
    peers.set(peer.hostId, { ...peer, name: knownName(peer.hostId) });
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
      peers.set(p.hostId, { hostId: p.hostId, address: p.address, port: p.port, name: p.name || knownName(p.hostId), agents: [], checkedAt: 0, static: true });
    }
  }
  // A psk-authenticated inventory request from an unknown host teaches us where to dial it back: the
  // tcp source address plus its advertised listen port. Only overlay/private sources, never replacing
  // configured or mdns peers. Learned peers that stay unreachable for 10 minutes are dropped.
  function learn(hostId, socket, listen) {
    if (!UUID.test(hostId || '') || hostId === config.hostId) return;
    const source = String(socket?.remoteAddress || '').replace(/^::ffff:/, '');
    // the tcp source is the dial-back address, except where it cannot be: on a userspace-tailscale host every inbound
    // connection comes from loopback, so the sender's advertised tailscale ip is used. only an overlay address is accepted.
    const advertised = overlayIPv4(listen?.address) ? listen.address : null;
    const address = advertised && (config.userspaceTailscale || /^127\./.test(source)) ? advertised : source;
    const port = Number(listen?.port);
    if (!(overlayIPv4(address) || privateIPv4(address, allowLoopback)) || !Number.isInteger(port) || port < 1 || port > 65535) return;
    const known = peers.get(hostId);
    // a learned peer that restarted on a new (os-assigned) port or address is followed, not dropped
    // so is a stale mdns entry (host left the lan and now reaches us over tailscale); configured static peers are never overridden
    if (known && !known.static && (known.learned || known.error) && (known.address !== address || known.port !== port)) { known.learned = true; known.address = address; known.port = port; known.learnedAt = Date.now(); delete known.error; return; }
    if (known || peers.size >= 64) return;
    peers.set(hostId, { hostId, address, port, name: knownName(hostId), agents: [], checkedAt: 0, learned: true, learnedAt: Date.now() });
    log(`learned peer ${hostId.slice(0, 8)} at ${address}:${port}`);
  }
  function expireLearned() {
    // ephemeral hosts (cloud pods) go after a minute of silence, others after ten
    for (const [id, p] of peers) if (p.learned && p.error && Date.now() - Math.max(p.checkedAt || 0, p.learnedAt) > (p.ephemeral ? 60000 : 600000)) peers.delete(id);
  }
  async function refresh() {
    if (refreshing || closing) return; refreshing = true;
    try {
      // Usage is slow network IO: never stall presence sampling or LAN discovery.
      if (usage) void usage.update().catch(() => {});
      if (presence) await presence.update().catch((e) => log(`presence: ${e.message}`));
      await storage.update();
      cost = readHostCost(config.dir) ?? cost;
      if (provisioner) void provisioner.tick().catch((e) => log(`cloud: ${e.message}`));
      await advertise();
      browser?.expire(); browser?.update();
      for (const announced of browser?.services || []) discover(announced);
      syncStatic(); expireLearned();
      // discovered members land in the table before this poll's refresh, so they are inventoried in the same cycle
      if (discovery) await discovery.scan().catch((e) => log(`tailnet discovery: ${e.message}`));
      if (closing) return;
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
    const wanted = new Map([['host', { name: `agentbus-${config.hostId}`, type: 'agentbus', txt: hostAdvertisement(config, caps(), agents.length) }]]);
    if (!client) for (const agent of agents) wanted.set(agent.id, { name: crypto.createHash('sha256').update(`${config.hostId}/${agent.id}`).digest('hex').slice(0, 48), type: 'agentbus-agent', txt: sessionAdvertisement(config.hostId, agent) });
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
    closing = true; clearInterval(timer); browser?.stop(); presence?.close(); provisioner?.close(); discovery?.close();
    if (bonjour) await new Promise((resolve) => bonjour.unpublishAll(resolve));
    bonjour?.destroy();
    for (const socket of sockets) socket.destroy();
    blobs.close();
    fs.rmSync(path.join(config.dir, 'remote-agents.json'), { force: true });
    await Promise.all([new Promise((r) => local.close(r)), new Promise((r) => server.close(r))]);
  }
  return { port: server.address().port, socketPath, discover, forget, refresh, peers, close, provisioner, discovery };
}
