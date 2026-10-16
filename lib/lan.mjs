import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const VERSION = '1';
const WIN = process.platform === 'win32';
// Windows has no filesystem unix sockets in node; libuv only listens on named pipes.
// Derive a stable per-state-dir pipe name so test/alternate AGENTBUS_DIRs don't collide.
export const daemonSocketPath = (dir) => WIN
  ? `\\\\.\\pipe\\agentbus-lan-${crypto.createHash('sha256').update(path.resolve(dir).toLowerCase()).digest('hex').slice(0, 16)}`
  : path.join(dir, 'daemon.sock');
// POSIX modes are meaningless on windows. Restrict with an explicit owner-only DACL instead.
const winSystemTool = (name) => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', `${name}.exe`);
const nativeOptions = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 };
// Cold PowerShell startup can exceed 5s on contended Windows CI runners.
// Allow bounded startup headroom without retrying a possibly applied DACL
// mutation or relaxing the shorter deadlines for whoami/icacls.
const powershellOptions = { ...nativeOptions, timeout: 30000 };
const icacls = (args) => execFileSync(winSystemTool('icacls'), args, nativeOptions);
let resolvedSid;
const currentSid = () => {
  if (resolvedSid) return resolvedSid;
  const sid = /"(S-1-[0-9-]+)"/.exec(execFileSync(winSystemTool('whoami'), ['/user', '/fo', 'csv', '/nh'], nativeOptions))?.[1];
  if (!sid) throw Error('could not resolve current user sid');
  // The process token is stable; USERDOMAIN/USERNAME and translated account
  // display names are neither authoritative nor necessarily equivalent.
  return resolvedSid = sid;
};
export function restrictToOwner(p) {
  if (!WIN) return;
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // Replace access rules only: /grant:r leaves foreign explicit ACEs, while
  // icacls /restore requires privileges unavailable to a normal file owner.
  execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    fileURLToPath(new URL('./windows-restrict-owner.ps1', import.meta.url)), '-LiteralPath', path.resolve(p), '-Sid', currentSid()], powershellOptions);
}

const administratorSid = /^S-1-5-21-\d+-\d+-\d+-500$/;
let resolvedLocalAdministratorSid;
const localAdministratorSid = () => {
  if (resolvedLocalAdministratorSid) return resolvedLocalAdministratorSid;
  // LA is account-domain-relative, not the Administrators group. Resolve it
  // through Windows instead of equating it to any caller whose RID is 500.
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const command = "([System.Security.AccessControl.RawSecurityDescriptor]::new('D:(A;;FA;;;LA)')).DiscretionaryAcl[0].SecurityIdentifier.Value";
  const sid = execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], powershellOptions).trim();
  if (!administratorSid.test(sid)) throw Error('could not resolve local administrator sid');
  return resolvedLocalAdministratorSid = sid;
};

// icacls /save uses machine-readable DACL SDDL, independent of localized names.
// Unknown/object/conditional ACE forms are rejected rather than approximated.
export function ownerOnlySddl(sddl, sid, localAdminSid) {
  if (typeof sddl !== 'string' || !/^S-1-[0-9-]+$/.test(sid || '') || sddl.length > 1024 * 1024) return false;
  const match = /^D:(?:P|AI|AR)*(\(.*\))$/.exec(sddl.trim());
  if (!match) return false; // includes absent, null and empty DACLs
  const aces = match[1].match(/\([^()]*\)/g);
  if (!aces?.length || aces.join('') !== match[1]) return false;
  const aliases = { SY: 'S-1-5-18', LS: 'S-1-5-19', NS: 'S-1-5-20' };
  if (administratorSid.test(localAdminSid || '')) aliases.LA = localAdminSid;
  return aces.every((ace) => {
    const fields = ace.slice(1, -1).split(';');
    return fields.length === 6 && ['A', 'D'].includes(fields[0]) && /^(?:OI|CI|NP|IO|ID)*$/.test(fields[1]) && /^(?:0x[0-9a-fA-F]+|(?:CC|DC|LC|SW|RP|WP|DT|LO|CR|SD|RC|WD|WO|GA|GR|GW|GX|FA|FR|FW|FX)+)$/.test(fields[2]) && fields[3] === '' && fields[4] === '' && (aliases[fields[5]] || fields[5]) === sid;
  });
}
export function ownerOnlyAclExport(data, sid, localAdminSid) {
  if (!Buffer.isBuffer(data) || data.length > 1024 * 1024) return false;
  // icacls /save emits UTF-16LE without a BOM. Detect the ASCII DACL's
  // zero bytes rather than the filename's first character (which may be Unicode).
  const bom = data.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]));
  const utf16 = bom || data.includes(0);
  if (utf16 && data.length % 2 !== 0) return false;
  const text = utf16 ? data.subarray(bom ? 2 : 0).toString('utf16le') : data.toString('utf8');
  if (text.includes('\0')) return false;
  const lines = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  // Exactly one named object and its DACL; wildcard or recursive exports cannot
  // accidentally certify only the first file. No localized CLI prose is parsed.
  return lines.length === 2 && lines[0].length > 0 && ownerOnlySddl(lines[1], sid, localAdminSid);
}
export function ownerOnly(p) {
  if (!WIN) return !(fs.statSync(p).mode & 0o077);
  let temporary;
  try {
    const sid = currentSid();
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-acl-'));
    restrictToOwner(temporary);
    const file = path.join(temporary, 'dacl.txt');
    icacls([p, '/save', file, '/q']);
    return ownerOnlyAclExport(fs.readFileSync(file), sid, administratorSid.test(sid) ? localAdministratorSid() : undefined);
  } catch { return false; }
  finally { if (temporary) { try { fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { return false; } } }
}
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const AGENT_ID = /^(claude|codex):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const MAX_FRAME = 1024 * 1024;
export const TLS_OPTIONS = { ciphers: 'PSK-AES256-GCM-SHA384', minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' };
export const lanDir = (bus = process.env.AGENTBUS_DIR || path.join(os.homedir(), '.agentbus')) => path.join(bus, 'lan');
export const remoteId = (hostId, agentId) => `lan:${hostId}/${agentId}`;
export function parseRemoteId(id) {
  const m = /^lan:([^/]+)\/(.+)$/.exec(id || '');
  return m && UUID.test(m[1]) && AGENT_ID.test(m[2]) ? { hostId: m[1], agentId: m[2] } : null;
}
export function privateIPv4(address, loopback = false) {
  if (net.isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (loopback && a === 127);
}
// tailscale (and other overlay) addresses: carrier-grade nat range 100.64.0.0/10.
export function overlayIPv4(address) {
  if (net.isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 100 && b >= 64 && b <= 127;
}
const bindable = (address) => address === '0.0.0.0' || privateIPv4(address, true) || overlayIPv4(address);
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
// static peers are dialed directly (no mdns): wan/overlay links. psk still authenticates every request.
export function validatePeers(peers, selfId) {
  if (peers === undefined) return [];
  if (!Array.isArray(peers) || peers.length > 32) throw Error('peers must be an array of at most 32 entries');
  const seen = new Set();
  return peers.map((p) => {
    if (!p || typeof p !== 'object' || !UUID.test(p.hostId || '') || p.hostId === selfId || seen.has(p.hostId)) throw Error('peer hostId must be a unique host UUID other than this host');
    if (typeof p.address !== 'string' || !(privateIPv4(p.address, true) || overlayIPv4(p.address) || (net.isIP(p.address) === 0 && HOSTNAME.test(p.address)))) throw Error(`peer address must be a private/overlay IPv4 or hostname: ${p.address}`);
    if (!Number.isInteger(p.port) || p.port < 1 || p.port > 65535) throw Error('peer port must be 1..65535');
    if (p.name !== undefined && !/^[a-zA-Z0-9_. -]{1,63}$/.test(p.name)) throw Error('invalid peer name');
    seen.add(p.hostId);
    return { hostId: p.hostId, address: p.address, port: p.port, ...(p.name ? { name: p.name } : {}) };
  });
}
export function readStaticPeers(dir, selfId) {
  try { return validatePeers(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).peers, selfId); } catch { return null; }
}
export function updateLanConfig(busDir, mutate) {
  const dir = lanDir(busDir), file = path.join(dir, 'config.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  const next = mutate(structuredClone(config));
  next.peers = validatePeers(next.peers, next.hostId);
  if (!next.peers.length) delete next.peers;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, file); restrictToOwner(file);
  return next;
}
export function detectOverlayIPv4(interfaces = os.networkInterfaces()) {
  const found = Object.values(interfaces).flat().filter((a) => a && a.family === 'IPv4' && !a.internal && overlayIPv4(a.address)).map((a) => a.address);
  return [...new Set(found)];
}
// one pasteable token carrying the group key and the peers to dial. it is a secret: anyone holding it joins the trust group.
const TOKEN_PREFIX = 'agentbus-join-v1:';
export function encodeJoinToken({ key, peers }) {
  if (!/^[a-f0-9]{64}$/i.test(key)) throw Error('invalid key');
  return TOKEN_PREFIX + Buffer.from(JSON.stringify({ k: key.toLowerCase(), p: validatePeers(peers) })).toString('base64url');
}
export function decodeJoinToken(token) {
  const t = String(token || '').trim();
  if (!t.startsWith(TOKEN_PREFIX)) throw Error('not an agentbus join token');
  let body; try { body = JSON.parse(Buffer.from(t.slice(TOKEN_PREFIX.length), 'base64url').toString('utf8')); } catch { throw Error('malformed join token'); }
  if (!/^[a-f0-9]{64}$/.test(body?.k || '')) throw Error('join token has no valid key');
  const peers = validatePeers(body.p);
  if (!peers.length) throw Error('join token lists no peers');
  return { key: body.k, peers };
}
// multicast-dns sends from the OS default multicast interface unless told otherwise. on windows with
// hyper-v/wsl that is often the vEthernet switch, so peers never hear us. accept an adapter name
// (stable across dhcp) or a private IPv4; resolve to the adapter's current private IPv4 at start.
const MDNS_IFACE = /^[a-zA-Z0-9_. ()-]{1,64}$/;
export function resolveMdnsInterface(value, interfaces = os.networkInterfaces()) {
  if (!value) return undefined;
  if (net.isIP(value) === 4) return privateIPv4(value) ? value : undefined;
  return (interfaces[value] || []).find((a) => a.family === 'IPv4' && !a.internal && privateIPv4(a.address) && !a.address.startsWith('169.254.'))?.address;
}
export function initLan({ busDir, name = os.hostname(), keyFile, keyHex, port = 0, bind = '0.0.0.0', smsPrimary, mdnsInterface, peers, mdns = true } = {}) {
  const dir = lanDir(busDir);
  if (fs.existsSync(path.join(dir, 'config.json'))) throw Error('lan is already initialized; edit its config or use the existing key');
  if (!/^[a-zA-Z0-9_. -]{1,63}$/.test(name)) throw Error('name must be 1-63 letters, digits, spaces, dots, underscores or dashes');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('invalid port');
  if (!bindable(bind)) throw Error('bind must be 0.0.0.0, a private IPv4 or an overlay (tailscale 100.64/10) IPv4 address');
  const key = keyHex ? String(keyHex).trim() : keyFile ? fs.readFileSync(keyFile, 'utf8').trim() : crypto.randomBytes(32).toString('hex');
  if (!/^[a-f0-9]{64}$/i.test(key)) throw Error('key file must contain a 32-byte hex pairing key');
  if (smsPrimary && smsPrimary !== 'self' && !UUID.test(smsPrimary)) throw Error('sms primary must be self or a host UUID');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700); restrictToOwner(dir);
  fs.writeFileSync(path.join(dir, 'key'), key + '\n', { mode: 0o600, flag: 'wx' });
  if (mdnsInterface !== undefined && !MDNS_IFACE.test(mdnsInterface)) throw Error('mdns interface must be an adapter name or private IPv4');
  const hostId = crypto.randomUUID(), staticPeers = validatePeers(peers, hostId);
  if (staticPeers.length && !port) throw Error('a fixed --port is required when static peers are configured (peers dial it back)');
  const config = { hostId, name, port, bind, ...(mdnsInterface ? { mdnsInterface } : {}), ...(mdns === false ? { mdns: false } : {}), ...(staticPeers.length ? { peers: staticPeers } : {}) };
  if (smsPrimary) config.smsPrimary = smsPrimary === 'self' ? config.hostId : smsPrimary;
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return { ...config, keyFile: path.join(dir, 'key'), note: 'copy the key securely to participating hosts; run lan serve on each host' };
}
export function loadLan(busDir) {
  const dir = lanDir(busDir), config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  const keyPath = path.join(dir, 'key');
  if (!ownerOnly(keyPath)) throw Error(WIN ? 'lan key must be accessible only by the current user (owner-only acl)' : 'lan key must have mode 0600');
  const hex = fs.readFileSync(keyPath, 'utf8').trim();
  if (!UUID.test(config.hostId) || !/^[a-zA-Z0-9_. -]{1,63}$/.test(config.name) || !/^[a-f0-9]{64}$/i.test(hex)) throw Error('invalid lan config or key');
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535 || !bindable(config.bind)) throw Error('invalid lan bind/port');
  config.peers = validatePeers(config.peers, config.hostId);
  if (config.mdns !== undefined && typeof config.mdns !== 'boolean') throw Error('invalid mdns flag');
  if (config.smsPrimary && !UUID.test(config.smsPrimary)) throw Error('invalid sms primary id');
  if (config.mdnsInterface !== undefined && (typeof config.mdnsInterface !== 'string' || !MDNS_IFACE.test(config.mdnsInterface))) throw Error('invalid mdns interface');
  return { ...config, key: Buffer.from(hex, 'hex'), dir };
}

// One bounded request/response per connection. Never retry a possibly sent write.
export function exchange(connect, frame, { timeout = 20000, secure = false } = {}) {
  return new Promise((resolve) => {
    let sent = false, done = false, bytes = 0, chunks = [];
    const socket = connect();
    const finish = (result) => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); resolve(result); };
    const fail = (e) => finish({ ok: false, delivery: sent && ['send', 'sms', 'sms-reply', 'spawn', 'spawn-stop'].includes(frame.op) ? 'uncertain' : 'unavailable', error: e.message });
    const timer = setTimeout(() => fail(Error('lan request timed out')), timeout);
    socket.on(secure ? 'secureConnect' : 'connect', () => { sent = true; socket.write(JSON.stringify(frame) + '\n'); });
    socket.on('data', (b) => {
      bytes += b.length;
      if (bytes > MAX_FRAME) return fail(Error('oversized lan response'));
      chunks.push(b);
      if (!b.includes(10)) return;
      try { finish(JSON.parse(Buffer.concat(chunks).toString('utf8').split('\n')[0])); }
      catch { fail(Error('invalid lan response')); }
    });
    socket.on('error', fail);
    socket.on('close', () => { if (!done) fail(Error('lan connection closed')); });
  });
}
export function peerRequest(config, peer, frame, timeout) {
  return exchange(() => tls.connect({ ...TLS_OPTIONS, host: peer.address, port: peer.port,
    checkServerIdentity: () => undefined, // PSK authenticates the group; there is no certificate.
    pskCallback: () => ({ identity: `agentbus:${config.hostId}`, psk: config.key }),
  }), { ...frame, recipient: peer.hostId }, { secure: true, timeout });
}
export function localLanRequest(frame, { busDir, timeout } = {}) {
  return exchange(() => net.createConnection(daemonSocketPath(lanDir(busDir))), frame, { timeout });
}
export async function remoteAgents() {
  // win32 named pipes report EBUSY to existsSync while live; the request below fails fast if absent.
  if (!WIN && !fs.existsSync(daemonSocketPath(lanDir()))) return [];
  const result = await localLanRequest({ op: 'list' }, { timeout: 2000 });
  return result.ok && Array.isArray(result.agents) ? result.agents : [];
}
export function sendRemote(to, from, message) {
  return localLanRequest({ op: 'send', id: crypto.randomUUID(), to, from: from?.id, message });
}

export function lanSettings(busDir) {
  try { return JSON.parse(fs.readFileSync(path.join(lanDir(busDir), 'config.json'), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
export function remoteLockAgents(busDir) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(lanDir(busDir), 'remote-agents.json'), 'utf8'));
    return Date.now() - state.at < 30000 && Array.isArray(state.agents) ? state.agents.filter((a) => parseRemoteId(a.id)) : [];
  } catch { return []; }
}
