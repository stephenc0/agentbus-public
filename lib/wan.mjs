// Wan/overlay helpers: peer resolution for direct dials, the pasteable invite, its leak check, doctor.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadLan, lanDir, localLanRequest, peerRequest, encodeJoinToken, decodeJoinToken, detectOverlayIPv4, overlayIPv4, UUID, tailscaleIPv4, rawConnect, listenInfo, DEFAULT_SOCKS5, parseSocks5 } from './lan.mjs';
import { uploadFile, downloadFile, blobPurge, blobStat } from './blob.mjs';
import { validateHostCost } from './host-capabilities.mjs';
import { buildInfo } from './build-info.mjs';

export const DEFAULT_WAN_PORT = 47800;

// Peers this host can dial: the daemon's authenticated view when it is running, else configured static peers.
export async function knownPeers(busDir) {
  const status = await localLanRequest({ op: 'status' }, { busDir, timeout: 3000 }).catch(() => null);
  if (status?.ok) return { daemon: true, self: status, peers: status.peers || [] };
  const config = loadLan(busDir);
  return { daemon: false, self: { hostId: config.hostId, name: config.name }, peers: config.peers.map((p) => ({ ...p, name: p.name || p.hostId.slice(0, 8), storage: [] })) };
}
export async function resolvePeer(host, busDir) {
  const { peers } = await knownPeers(busDir);
  const matches = peers.filter((p) => p.hostId === host || p.name === host || (host && p.hostId.startsWith(host)));
  if (matches.length !== 1) throw Error(matches.length ? `host ${host} is ambiguous` : `no known peer ${host}; known: ${peers.map((p) => p.name).join(', ') || 'none'}`);
  return matches[0];
}
export function ownedStorage(peer, storageId) {
  const owned = (peer.storage || []).filter((s) => s.ownerHostId === peer.hostId && s.access === 'rw' && (!storageId || s.id === storageId));
  if (storageId) return storageId;
  if (owned.length === 1) return owned[0].id;
  return undefined; // the owner picks its single rw entry, or reports why it cannot
}

// ----- invite -----
// Anything resembling a phone number, email, or a known local secret must never ride along in an invite.
// The token itself carries only the group key, host ids, names, addresses and ports.
const PHONE = /(?:\+?\d[\d\s().-]{8,}\d)/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
function localSecrets(home = os.homedir()) {
  const out = [];
  const tryJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const claw = tryJson(path.join(home, '.claw-messenger', 'config.json'));
  if (claw?.apiKey) out.push(String(claw.apiKey));
  const routes = tryJson(path.join(home, '.claw-messenger', 'routes.json'));
  if (routes && typeof routes === 'object') out.push(...Object.keys(routes));
  const cred = tryJson(path.join(home, '.agentbus', 'storage-credential.json'));
  if (typeof cred?.password === 'string') out.push(cred.password);
  return out.filter((s) => s.length >= 6);
}
export function leakCheck(text, { secrets = localSecrets(), allow = [] } = {}) {
  const findings = [];
  // uuids (host/agent ids) contain digit-and-dash runs that look like phone numbers; they are not identifying.
  const scrubbed = allow.reduce((t, a) => t.split(a).join(''), text).replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, ' ');
  for (const m of scrubbed.matchAll(PHONE)) if (m[0].replace(/\D/g, '').length >= 10 && !/^\s*\d{1,3}(\.\d{1,3}){3}\s*$/.test(m[0])) findings.push(`phone-like number "${m[0].trim().slice(0, 4)}…"`);
  for (const m of scrubbed.matchAll(EMAIL)) findings.push(`email address "${m[0].slice(0, 3)}…"`);
  for (const s of secrets) {
    const digits = s.replace(/\D/g, '').slice(-10);
    if (text.includes(s) || (digits.length >= 10 && text.replace(/\D/g, '').includes(digits))) findings.push('a local secret or paired phone number');
  }
  return [...new Set(findings)];
}
export async function buildInvite({ busDir, peerSpecs, name, repo, port = DEFAULT_WAN_PORT, tailscaleAuthKey, host = false }) {
  if (tailscaleAuthKey !== undefined && !/^tskey-auth-[A-Za-z0-9-]{10,200}$/.test(tailscaleAuthKey)) throw Error('tailscale auth key must look like tskey-auth-...');
  const config = loadLan(busDir);
  const key = fs.readFileSync(path.join(lanDir(busDir), 'key'), 'utf8').trim();
  if (!peerSpecs.length) throw Error('pass at least one --peer NAME=ADDRESS[:PORT] (use self for this host)');
  const { peers: known } = await knownPeers(busDir);
  const peers = peerSpecs.map((spec) => {
    const m = /^([^=]+)=([^:]+)(?::(\d+))?$/.exec(spec) || /^(self)$/.exec(spec);
    if (!m) throw Error(`bad --peer ${spec}; expected NAME=ADDRESS[:PORT]`);
    const [, who, address0, port0] = m;
    const self = who === 'self' || who === config.name || who === config.hostId;
    const peer = self ? null : known.find((p) => p.name === who || p.hostId === who);
    if (!self && !peer) throw Error(`unknown host ${who}; it must be an authenticated peer of this host`);
    const address = address0 || (self ? detectOverlayIPv4()[0] : undefined);
    if (!address) throw Error(`no tailscale address for ${who}; pass ${who}=100.x.y.z`);
    const p = Number(port0) || (self ? config.port : peer.port);
    if (!p) throw Error(`${who} listens on an os-assigned port; give it a fixed port (lan config "port") and restart its daemon first`);
    return { hostId: self ? config.hostId : peer.hostId, name: self ? config.name : peer.name, address, port: p };
  });
  // the group's provisioner (an always-on host offering cloud pods) rides along when its tailscale address is known
  const { self: me } = await knownPeers(busDir);
  for (const pv of [me?.cloud?.provisioner, ...known.map((p) => p.cloud?.provisioner)]) {
    if (pv && overlayIPv4(pv.address) && pv.port && !peers.some((p) => p.hostId === pv.hostId)) peers.push({ hostId: pv.hostId, name: pv.name || pv.hostId.slice(0, 8), address: pv.address, port: pv.port });
  }
  const token = encodeJoinToken({ key, peers });
  const joinName = name && /^[a-zA-Z0-9_. -]{1,63}$/.test(name) ? name : 'remote';
  const text = inviteText({ token, peers, repo, name: joinName, port, tailscaleAuthKey, host });
  const findings = leakCheck(text, { allow: [token, ...(tailscaleAuthKey ? [tailscaleAuthKey] : [])] });
  // The token is opaque base64: inspect what it decodes to as well.
  findings.push(...leakCheck(JSON.stringify(decodeJoinToken(token).peers)));
  if (findings.length) throw Error(`refusing to print the invite: it would include ${[...new Set(findings)].join(', ')}`);
  return { text, token, peers };
}
export function inviteText({ token, peers, repo, name, port, tailscaleAuthKey, host = false }) {
  const docs = /^https:\/\/github\.com\/[^/]+\/[^/]+?\/?$/.test(repo || '') ? `${repo.replace(/\/$/, '')}/blob/main/docs/join.md` : `${repo} (docs/join.md)`;
  const lines = [
    `agentbus invite for ${name}. paste this whole message into claude code on the machine that should join.`,
    '',
    `set this machine up as an agentbus peer: clone ${repo} into ~/agentbus (windows: %USERPROFILE%\\agentbus) and follow docs/join.md in it (${docs}).`,
    'the values below are secrets: use them only as that doc says, never print, log or commit them.',
    '',
    `AGENTBUS_NAME=${name}`,
    `AGENTBUS_PEER=${peers.map((p) => `${p.name} ${p.address}:${p.port}`).join(', ')}`,
    ...(port && port !== DEFAULT_WAN_PORT ? [`AGENTBUS_PORT=${port}`] : []),
    `AGENTBUS_JOIN_TOKEN=${token}`,
    ...(host ? ['AGENTBUS_ROLE=host'] : []),
    ...(tailscaleAuthKey ? [`TS_AUTHKEY=${tailscaleAuthKey}`] : []),
  ];
  return lines.join('\n') + '\n';
}

// ----- doctor -----
export async function doctor({ busDir, roundtrip = true, log = console.log }) {
  let ok = true;
  const check = (label, pass, detail = '', hint = '') => { ok &&= pass; log(`${pass ? 'ok  ' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}${!pass && hint ? `\n     fix: ${hint}` : ''}`); return pass; };
  let config;
  try { config = loadLan(busDir); check('config', true, `${config.name} ${config.hostId.slice(0, 8)} bind ${config.bind}:${config.port}`); }
  catch (e) { check('config', false, e.message, 'run `agentbus lan join <token>` (or lan init)'); return false; }
  const overlay = detectOverlayIPv4();
  if (config.userspaceTailscale) {
    const ts = tailscaleIPv4();
    check('tailscale address (userspace)', ts.includes(config.advertiseAddress), ts.join(', ') || 'none', ts.length ? `config advertises ${config.advertiseAddress} but tailscale has ${ts.join(', ')}; rerun lan join --userspace-tailscale` : 'start tailscaled --tun=userspace-networking --socks5-server=' + config.socks5 + ' and tailscale up');
    const proxy = await rawConnect({}, parseSocks5(config.socks5).host, parseSocks5(config.socks5).port).then((s) => { s.destroy(); return null; }, (e) => e.code || e.message);
    check('tailscale socks5 proxy', !proxy, proxy || config.socks5, `tailscaled must run with --socks5-server=${config.socks5}`);
  } else if (overlayIPv4(config.bind) || config.peers.some((p) => overlayIPv4(p.address))) {
    check('tailscale address', overlay.length > 0 && (!overlayIPv4(config.bind) || overlay.includes(config.bind)), overlay.join(', ') || 'none', overlay.length ? `this config binds ${config.bind} but tailscale has ${overlay.join(', ')}; rerun lan join --bind <current address>` : 'start tailscale and log in');
  }
  const status = await localLanRequest({ op: 'status' }, { busDir, timeout: 3000 }).catch((e) => ({ ok: false, error: e.message }));
  check('daemon running', !!status.ok, status.ok ? `port ${status.port}` : status.error, 'run `agentbus lan install` (or `agentbus lan serve` in the foreground to see errors)');
  const targets = status.ok ? status.peers : config.peers;
  if (!targets.length) check('peers', false, 'none configured or discovered', 'agentbus lan peer add --id HOST_UUID --address 100.x.y.z --port 47800');
  for (const p of targets) {
    const label = `peer ${p.name || p.hostId.slice(0, 8)} ${p.address}:${p.port}`;
    const tcp = await Promise.race([rawConnect(config, p.address, p.port).then((s) => { s.destroy(); return null; }, (e) => e.code || e.message), new Promise((r) => setTimeout(() => r('timeout'), 5000).unref())]);
    if (!check(`${label} tcp`, !tcp, tcp || 'reachable', `\`tailscale ping ${p.address}\`; if that works, the peer's daemon is down or its firewall blocks tcp ${p.port} on the tailscale adapter`)) continue;
    const r = await peerRequest(config, { ...p }, { op: 'agents', listen: listenInfo(config, config.port, p.address) }, 8000);
    if (!check(`${label} authenticated`, r.ok && r.hostId === p.hostId, r.ok ? `${r.name}, ${r.agents?.length ?? 0} agents` : r.error, 'the join token is wrong or the group key changed; ask for a fresh invite')) continue;
    // a different build is reported, not failed: hosts upgrade one at a time
    const theirs = String(r.build?.sourceHash || '').slice(0, 8), ours = buildInfo.sourceHash.slice(0, 8);
    log(theirs === ours ? `ok   ${label} build: same (${ours})` : `WARN ${label} build: ${theirs || 'unknown'}${r.build?.version ? ` v${r.build.version}` : ''} vs this host ${ours} v${buildInfo.version}${typeof r.codeSource === 'string' ? ` (${r.codeSource.slice(0, 80)})` : ''}`);
    // A fresh daemon learns us on our first poll and dials back on its next one.
    let back = r.reachBack;
    for (let i = 0; !back && status.ok && i < 3; i++) { await new Promise((res) => setTimeout(res, 11000)); back = (await peerRequest(config, { ...p }, { op: 'agents', listen: listenInfo(config, config.port, p.address) }, 8000)).reachBack; }
    check(`${label} reach back`, !!back, back ? 'peer can dial this host' : 'peer cannot dial this host', 'needs two-way tailscale reachability: same tailnet, or share this machine back; also the daemon must be running here');
    let owned = (r.storage || []).filter((s) => s.ownerHostId === p.hostId && s.access === 'rw');
    // storage is probed on the peer's poll cycle; a just-started daemon advertises it within ~10s.
    for (let i = 0; !owned.length && roundtrip && i < 2; i++) { await new Promise((res) => setTimeout(res, 11000)); owned = ((await peerRequest(config, { ...p }, { op: 'agents', listen: listenInfo(config, config.port, p.address) }, 8000)).storage || []).filter((s) => s.ownerHostId === p.hostId && s.access === 'rw'); }
    if (!owned.length) log(`     ${p.name || p.hostId.slice(0, 8)} owns no shared task storage (fine unless you send jobs to it)`);
    if (owned.length) log(`     storage: ${owned.map((s) => `${s.name} [${s.id.slice(0, 8)}] ${s.status} ${s.freeBytes ? (s.freeBytes / 1024 ** 3).toFixed(0) + ' GiB free' : ''}`).join('; ')}`);
    if (roundtrip && owned.length) {
      const task = crypto.randomUUID(), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-doctor-'));
      try {
        const src = path.join(tmp, 'probe.bin'); fs.writeFileSync(src, crypto.randomBytes(4 * 1024 * 1024));
        const t0 = Date.now();
        const up = await uploadFile(config, p, { task, area: 'in', name: 'probe.bin', file: src, retries: 1 });
        const st = await blobStat(config, p, { task });
        const down = await downloadFile(config, p, { task, area: 'in', name: 'probe.bin', dest: path.join(tmp, 'back.bin'), retries: 1 });
        check(`${label} blob roundtrip`, up.sha256 === down.sha256, `4 MiB up+down in ${((Date.now() - t0) / 1000).toFixed(1)}s, owner path ${st.path}`);
      } catch (e) { check(`${label} blob roundtrip`, false, e.message, 'see the owner\'s daemon log; the owner needs a registered rw storage entry'); }
      finally { await blobPurge(config, p, { task }).catch(() => {}); fs.rmSync(tmp, { recursive: true, force: true }); }
    }
  }
  return ok;
}
// userspace tailscale (no tun device): bind loopback (tailscaled redials inbound tailnet tcp there), dial out via its socks5
// proxy, and advertise the node's tailscale ip. ephemeral marks a rented host whose identity dies with it.
function userspaceFields({ socks5 = DEFAULT_SOCKS5, advertiseAddress, ephemeral, tailscaleIp = tailscaleIPv4 } = {}) {
  parseSocks5(socks5);
  let address = advertiseAddress;
  if (!address) {
    const found = tailscaleIp();
    if (found.length !== 1) throw Error(found.length ? `several tailscale addresses (${found.join(', ')}); pass --advertise-address` : 'tailscale ip -4 returned no 100.64/10 address; start tailscaled --tun=userspace-networking and tailscale up first');
    address = found[0];
  }
  if (!overlayIPv4(address)) throw Error('--advertise-address must be a tailscale 100.64/10 IPv4');
  return { userspaceTailscale: true, bind: '127.0.0.1', socks5, advertiseAddress: address, ...(ephemeral ? { ephemeral: true } : {}) };
}
export async function join({ busDir, token, name = os.hostname().replace(/[^a-zA-Z0-9_. -]/g, '-').slice(0, 63), port = DEFAULT_WAN_PORT, bind, userspace, cost, role }) {
  const roleFields = role === 'host' ? { role: 'host' } : {};
  const us = userspace ? userspaceFields(userspace) : null;
  if (us && bind) throw Error('--bind and --userspace-tailscale are exclusive (userspace binds loopback)');
  const { initLan, updateLanConfig } = await import('./lan.mjs');
  const { key, peers } = decodeJoinToken(token);
  const configFile = path.join(lanDir(busDir), 'config.json');
  if (fs.existsSync(configFile)) {
    const existing = loadLan(busDir);
    if (existing.key.toString('hex') !== key) throw Error('this host already belongs to a different agentbus group (different key); refusing to overwrite');
    // Already a member (e.g. set up at the owner's place, now remote): keep key, host id and mdns; add the
    // overlay peers, and fix only what cannot work away from that lan.
    const local = Object.values(os.networkInterfaces()).flat().filter((a) => a?.family === 'IPv4').map((a) => a.address);
    const overlay = detectOverlayIPv4();
    const notes = [];
    const next = updateLanConfig(busDir, (c) => {
      const out = { ...c, ...(cost || {}), ...roleFields, peers: [...(c.peers || []).filter((p) => !peers.some((n) => n.hostId === p.hostId)), ...peers] };
      if (us) {
        if (c.bind !== us.bind || c.advertiseAddress !== us.advertiseAddress || !c.userspaceTailscale) notes.push(`userspace tailscale: bind ${us.bind}, advertise ${us.advertiseAddress}, socks5 ${us.socks5}`);
        Object.assign(out, us, { mdns: false }); if (!c.port) { out.port = port; notes.push(`listen port fixed at ${port}`); }
        return out;
      }
      if (!c.port) { out.port = port; notes.push(`listen port was os-assigned; now fixed at ${port} so peers can dial back`); }
      if (c.bind !== '0.0.0.0' && !local.includes(c.bind)) {
        if (bind || overlay.length === 1) { out.bind = bind || overlay[0]; notes.push(`previous bind ${c.bind} is not on this machine anymore; now ${out.bind}`); }
        else notes.push(`previous bind ${c.bind} is not on this machine and no single tailscale address was found; pass --bind`);
      }
      return out;
    });
    return { updated: true, hostId: next.hostId, name: next.name, bind: next.bind, port: next.port, peers: next.peers, notes, restart: 'run `agentbus lan stop` then `agentbus lan install` so the daemon loads this config' };
  }
  if (us) bind = us.bind;
  else if (!bind) {
    const found = detectOverlayIPv4();
    if (found.length !== 1) throw Error(found.length ? `several overlay addresses (${found.join(', ')}); pass --bind` : 'no tailscale (100.64/10) address on this machine; start tailscale and log in first');
    bind = found[0];
  }
  for (const p of peers) if (!UUID.test(p.hostId)) throw Error('invalid peer');
  if (cost) validateHostCost(cost);
  const created = initLan({ busDir, name, keyHex: key, port, bind, peers, mdns: false });
  if (!us && !cost && !role) return created;
  // initLan knows nothing of userspace, cost or role fields; add them in one validated rewrite
  const next = updateLanConfig(busDir, (c) => ({ ...c, ...(us || {}), ...(cost || {}), ...roleFields }));
  return { ...created, ...next, keyFile: created.keyFile };
}
