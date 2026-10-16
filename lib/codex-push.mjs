import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';

// bridges/<pid>-<nonce>.sock is the bridge's registry entry on every platform. on posix it is the
// unix socket itself. windows can't listen on filesystem paths, so there it is a marker file
// holding the named pipe path; the marker keeps directory scans and hook ownership checks uniform.
const WIN = process.platform === 'win32';
const PIPE = /^\\\\\.\\pipe\\agentbus-bridge-[0-9]+-[0-9a-f]{8}-[0-9a-f]{12}$/;
export function bridgeListenPath(dir, pid, nonce) {
  const entry = path.join(dir, `${pid}-${nonce}.sock`);
  if (!WIN) return { entry, listen: entry };
  const tag = crypto.createHash('sha256').update(path.resolve(dir).toLowerCase()).digest('hex').slice(0, 12);
  return { entry, listen: `\\\\.\\pipe\\agentbus-bridge-${pid}-${nonce}-${tag}` };
}
export function bridgeEndpoint(entry) {
  if (!WIN) return entry;
  try { const pipe = fs.readFileSync(entry, 'utf8').trim(); return PIPE.test(pipe) ? pipe : null; } catch { return null; }
}
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
export function listBridges(busDir) {
  const dir = path.join(busDir, 'bridges');
  let names; try { names = fs.readdirSync(dir).filter((f) => /^[0-9]+-[0-9a-f]{8}\.sock$/.test(f)); } catch { return []; }
  const out = [];
  for (const name of names) {
    const pid = Number(name.split('-')[0]), entry = path.join(dir, name);
    // Crashes/reboots leave both POSIX sockets and Windows markers behind.
    // Only ESRCH proves the owner gone. Never unlink a live/reused PID's entry
    // just because a connection failed, or touch any inbox/uncertain records.
    if (pid <= 0) continue;
    let gone = false;
    try { process.kill(pid, 0); } catch (e) { gone = e.code === 'ESRCH'; }
    if (gone) { for (const f of [entry, entry.replace(/\.sock$/, '.state.json')]) { try { fs.unlinkSync(f); } catch {} } continue; }
    const endpoint = bridgeEndpoint(entry);
    if (endpoint) out.push({ name, pid, entry, endpoint });
  }
  return out;
}
// loaded threads + active turns as last observed by each live bridge. synchronous on purpose:
// hooks and claw-messenger lock ownership use synchronous discovery.
export function bridgeThreads(busDir, maxAgeMs = 15000) {
  const threads = new Map();
  for (const b of listBridges(busDir)) {
    let s; try { s = JSON.parse(fs.readFileSync(b.entry.replace(/\.sock$/, '.state.json'), 'utf8')); } catch { continue; }
    if (!s?.ready || s.pid !== b.pid || Date.now() - s.at > maxAgeMs || !pidAlive(b.pid) || !Array.isArray(s.loaded)) continue;
    for (const id of s.loaded) if (typeof id === 'string') threads.set(id, { ...s.metadata?.[id], bridgePid: b.pid, activeTurn: s.active?.[id] || null, at: s.at });
  }
  return threads;
}

// No retry after a connected socket fails: the server may already have accepted
// the turn. Only an explicit unavailable/rejected reply permits inbox fallback.
export function requestBridge(socketPath, request, timeout = 15000) {
  return new Promise((resolve) => {
    let connected = false, done = false, data = '';
    const socket = net.createConnection(socketPath);
    const finish = (result) => { if (done) return; done = true; socket.destroy(); resolve(result); };
    socket.setTimeout(timeout, () => finish({ status: connected ? 'uncertain' : 'unavailable', error: 'bridge timeout' }));
    socket.on('connect', () => { connected = true; socket.write(JSON.stringify(request) + '\n'); });
    socket.on('data', (chunk) => {
      data += chunk;
      if (data.length > 65536) return finish({ status: 'uncertain', error: 'oversized bridge reply' });
      const end = data.indexOf('\n');
      if (end < 0) return;
      try {
        const reply = JSON.parse(data.slice(0, end));
        if (!['accepted', 'unavailable', 'rejected', 'uncertain'].includes(reply.status)) throw Error('invalid reply');
        finish(reply);
      } catch { finish({ status: 'uncertain', error: 'invalid bridge reply' }); }
    });
    socket.on('error', (e) => finish({ status: connected ? 'uncertain' : 'unavailable', error: e.message }));
    socket.on('close', () => finish({ status: connected ? 'uncertain' : 'unavailable', error: 'bridge closed' }));
  });
}

export async function pushToCodex(busDir, threadId, message) {
  const bridges = listBridges(busDir);
  if (!bridges.length) return { status: 'unavailable', error: 'no live codex bridge; launch the desktop through the managed agentbus launcher' };
  // try the bridge that reported owning this thread first; the rest still verify ownership themselves.
  const owner = bridgeThreads(busDir).get(threadId)?.bridgePid;
  bridges.sort((a, b) => (b.pid === owner) - (a.pid === owner));
  const errors = [];
  for (const { name, endpoint } of bridges) {
    const result = await requestBridge(endpoint, { threadId, message });
    if (result.status !== 'unavailable') return result;
    if (result.error) errors.push(`${name}: ${result.error}`);
  }
  return { status: 'unavailable', ...(errors.length ? { error: errors.join('; ') } : {}) };
}

// Retry only hook-visible queued mail. Never retry ambiguous .push/.uncertain
// records. Atomic rename arbitrates between bridges, hooks and explicit reads.
export async function flushQueued(busDir, deliver) {
  const inbox = path.join(busDir, 'inbox');
  let threads; try { threads = fs.readdirSync(inbox, { withFileTypes: true }); } catch { return; }
  for (const thread of threads) {
    if (!thread.isDirectory()) continue;
    const dir = path.join(inbox, thread.name);
    for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
      const file = path.join(dir, name), claim = file + '.push';
      try { fs.renameSync(file, claim); } catch { continue; }
      let result;
      try {
        const message = JSON.parse(fs.readFileSync(claim, 'utf8'));
        result = await deliver({ threadId: thread.name, message });
      } catch (e) { result = { status: 'uncertain', error: e.message }; }
      if (result.status === 'accepted') fs.unlinkSync(claim);
      else if (result.status === 'unavailable' || result.status === 'rejected') {
        fs.renameSync(claim, file);
        break; // Don't repeatedly probe an unowned/unavailable thread this pass.
      } else fs.renameSync(claim, file + '.uncertain');
    }
  }
}
