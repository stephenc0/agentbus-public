// The receiving Claude MCP child owns its inbox token. Never copy that token to disk
// or send it over LAN. Local callers use a separate owner-only relay capability.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { UUID, restrictToOwner, ownerOnly } from './lan.mjs';
import { createOwnerAclCache } from './owner-acl-cache.mjs';
import { requestBridge } from './codex-push.mjs';
const live = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

export function writeClaudeInbox(socketPath, token, frame, timeout = 5000) {
  return new Promise((resolve) => {
    let done = false, started = false;
    const socket = net.createConnection(socketPath);
    const finish = (result) => { if (done) return; done = true; socket.destroy(); resolve(result); };
    const failed = () => finish({ status: started ? 'uncertain' : 'unavailable', error: 'native claude inbox write failed' });
    socket.setTimeout(timeout, failed); socket.on('error', failed); socket.on('close', failed);
    socket.on('connect', () => {
      // Order is essential: native Windows Claude discards unauthenticated frames.
      if (token) socket.write(JSON.stringify({ type: 'auth', token }) + '\n');
      started = true;
      socket.end(JSON.stringify(frame) + '\n', () => finish({ status: 'accepted', delivery: 'queued', authenticated: !!token, note: 'frame written to native claude inbox; model consumption is not acknowledged' }));
    });
  });
}

export async function startClaudeRelay({ busDir, sessionId, socketPath, token }) {
  if (!UUID.test(sessionId || '') || !socketPath || !token) return null;
  const dir = path.join(busDir, 'claude-relays'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700); restrictToOwner(dir);
  const nonce = crypto.randomBytes(8).toString('hex'), key = crypto.randomBytes(32).toString('hex');
  const basename = `${process.pid}-${nonce}`;
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\agentbus-claude-${basename}` : path.join(dir, basename + '.sock');
  const registry = path.join(dir, basename + '.json');
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    socket.setTimeout(7000, () => socket.destroy());
    let input = '', handled = false;
    socket.on('data', async (chunk) => {
      if (handled) return; input += chunk;
      if (Buffer.byteLength(input) > 100000) { socket.destroy(); return; }
      if (!input.includes('\n')) return; handled = true;
      let result;
      try {
        const req = JSON.parse(input.split('\n')[0]);
        if (req.key !== key || typeof req.content !== 'string' || !req.content || Buffer.byteLength(req.content) > 80000 || typeof req.from !== 'string' || req.from.length > 512) result = { status: 'rejected', error: 'invalid relay request' };
        else result = await writeClaudeInbox(socketPath, token, { msgV: 1, msg_id: crypto.randomUUID(), type: 'user', message: { role: 'user', content: req.content }, priority: 'next', from: req.from });
      } catch { result = { status: 'rejected', error: 'invalid relay request' }; }
      if (!socket.destroyed) socket.end(JSON.stringify(result) + '\n');
    });
  });
  server.maxConnections = 32; server.listen(endpoint); await once(server, 'listening');
  if (process.platform !== 'win32') fs.chmodSync(endpoint, 0o600);
  fs.writeFileSync(registry, JSON.stringify({ version: 1, sessionId, socketPath, pid: process.pid, endpoint, key, at: Date.now() }), { mode: 0o600 });
  let closed = false;
  const cleanup = () => { try { fs.unlinkSync(registry); } catch {} };
  process.once('exit', cleanup);
  return { endpoint, registry, async close() { if (closed) return; closed = true; cleanup(); process.removeListener('exit', cleanup); for (const s of sockets) s.destroy(); await new Promise((r) => server.close(r)); } };
}

const relayAcls = createOwnerAclCache();
function relayFiles(busDir) {
  const dir = path.join(busDir, 'claude-relays');
  try {
    // Dead registry owners cannot receive. Do not spend native ACL probes on their debris.
    return fs.readdirSync(dir).filter((f) => /^\d+-[a-f0-9]{16}\.json$/.test(f) && live(Number(f.split('-')[0]))).slice(0, 128).map((f) => path.join(dir, f));
  } catch { return []; }
}
function matchingRelays(busDir, target, files = relayFiles(busDir), verified) {
  const dir = path.join(busDir, 'claude-relays');
  if (process.platform === 'win32' && !verified) verified = relayAcls.snapshot(files);
  const relays = [];
  for (const file of files) {
    try {
      const name = path.basename(file);
      if (process.platform === 'win32' ? !verified.has(file) : !ownerOnly(file)) continue;
      const r = JSON.parse(fs.readFileSync(file, 'utf8'));
      // Match on the inbox socket, not sessionId: /clear and --resume rotate the session id
      // while the same claude process keeps its socket and token.
      if (r.version !== 1 || !target.socket || r.socketPath !== target.socket || !live(r.pid) || !/^[a-f0-9]{64}$/.test(r.key)) continue;
      const expected = process.platform === 'win32' ? `\\\\.\\pipe\\agentbus-claude-${name.slice(0, -5)}` : path.join(dir, name.replace(/\.json$/, '.sock'));
      if (r.endpoint === expected && (process.platform === 'win32' || fs.existsSync(r.endpoint))) relays.push({ ...r, aclCheckedAt: process.platform === 'win32' ? relayAcls.checkedAt(file) : Date.now() });
    } catch { /* missing/stale registration */ }
  }
  relays.sort((a, b) => b.at - a.at);
  return relays;
}

// Discovery is evidence of a registered delivery route, not model acceptance.
// Never include relay keys/tokens/endpoints in advertised diagnostics.
export function claudeDeliveryReadiness(busDir, target) {
  const relay = matchingRelays(busDir, target)[0];
  return {
    deliveryReady: !!relay,
    wakeCapability: relay ? 'authenticated-relay' : 'unavailable',
    unavailableReason: relay ? null : process.platform === 'win32' ? 'no live relay with fresh owner-only ACL proof; cold or stale ACL checks refresh asynchronously' : 'no live authenticated claude relay; reload agentbus MCP in the receiving session',
    deliveryCheckedAt: relay?.aclCheckedAt || Date.now(),
    deliveryBasis: relay ? 'live relay registration; model consumption is not acknowledged' : 'no relay registration',
  };
}

export async function relayToClaude(busDir, target, content, from) {
  const files = relayFiles(busDir);
  const verified = process.platform === 'win32' ? await relayAcls.verify(files) : undefined;
  for (const r of matchingRelays(busDir, target, files, verified)) {
    const result = await requestBridge(r.endpoint, { key: r.key, sessionId: r.sessionId, content, from }, 6500);
    if (result.status !== 'unavailable') return result;
  }
  return { status: 'unavailable' };
}
