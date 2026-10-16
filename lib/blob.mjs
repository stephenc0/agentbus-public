// Streaming blob lane for shared task storage. Lets a peer that cannot mount the owner's smb share
// (wan/overlay peers) upload job inputs and download results, without mirroring anything.
//
// Wire: one json header line on the authenticated lan tls-psk socket, then op-specific framing:
//   blob-stat    -> one json line {ok, path, in:[...], out:[...], sha256?}
//   blob-put     -> server line {ok, ready, have}; client sends exactly size-have raw bytes;
//                   server line {ok, have, sha256}. bytes land in <name>.part (resumable).
//   blob-commit  -> server verifies sha256 of the part, then atomically renames it into place.
//   blob-get     -> server line {ok, size}; raw bytes from offset until the server ends the stream.
//   blob-purge   -> removes one file (and its partial) or a whole task directory.
// Files live at <owned storage>/tasks/<task uuid>/<in|out>/<relative name>. Only the host that owns a
// registered rw storage entry serves it. Every peer of the psk group is trusted to use it.
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { UUID, TLS_OPTIONS } from './lan.mjs';
import { readStorage } from './storage.mjs';
import { replaceFileSync } from './atomic-file.mjs';

export const BLOB_OPS = new Set(['blob-stat', 'blob-put', 'blob-commit', 'blob-get', 'blob-purge']);
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/;
const MAX_LIST = 10000, IDLE_MS = 120000, HEADROOM = 1024 ** 3, MAX_SIZE = 2 ** 50;
const internal = (n) => /\.(part|part\.json|tmp)$/i.test(n);

export function validName(name) {
  if (typeof name !== 'string' || name.length > 512) return false;
  const parts = name.split('/');
  return parts.length <= 8 && parts.every((p) => SEGMENT.test(p) && p !== '.' && p !== '..' && !p.endsWith(' ') && !p.endsWith('.')) && !internal(parts.at(-1));
}
export async function hashFile(file, start = 0) {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { start })) h.update(chunk);
  return h.digest('hex');
}
const line = (socket, value) => { if (!socket.destroyed) socket.write(JSON.stringify(value) + '\n'); };
const finish = (socket, value) => { if (!socket.destroyed) socket.end(JSON.stringify(value) + '\n'); };

export function createBlobStore({ busDir, hostId, log = () => {} }) {
  const memo = new Map(); // `${file}:${size}:${mtimeMs}` -> sha256, so commit/stat never rehash unchanged files
  const sha = async (file) => {
    const st = fs.statSync(file), key = `${file}:${st.size}:${st.mtimeMs}`;
    if (!memo.has(key)) { memo.set(key, await hashFile(file)); if (memo.size > 4096) memo.delete(memo.keys().next().value); }
    return memo.get(key);
  };
  function storageFor(storageId) {
    const owned = readStorage(busDir).filter((e) => e.ownerHostId === hostId && e.access === 'rw' && (!storageId || e.id === storageId));
    if (owned.length !== 1) throw Error(storageId ? 'this host does not own that rw storage id' : 'this host owns no single rw storage entry; pass storageId');
    const marker = JSON.parse(fs.readFileSync(path.join(owned[0].localPath, '.agentbus-storage.json'), 'utf8'));
    if (marker.id !== owned[0].id || marker.ownerHostId !== hostId) throw Error('storage identity marker mismatch');
    return owned[0];
  }
  function locate(req, { needName = true } = {}) {
    if (!UUID.test(req.task || '')) throw Error('task must be a uuid');
    const entry = storageFor(req.storageId);
    const taskDir = path.join(entry.localPath, 'tasks', req.task);
    if (!needName) return { entry, taskDir };
    if (!['in', 'out'].includes(req.area)) throw Error('area must be in or out');
    if (!validName(req.name)) throw Error('invalid name: up to 8 /-separated segments of letters, digits, . _ - space; no .part/.tmp suffix');
    const areaDir = path.join(taskDir, req.area), file = path.join(areaDir, ...req.name.split('/'));
    const rel = path.relative(areaDir, file);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw Error('name escapes the task area');
    return { entry, taskDir, areaDir, file, part: file + '.part', meta: file + '.part.json' };
  }
  function list(areaDir) {
    const out = [];
    const walk = (dir, prefix) => {
      let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (out.length >= MAX_LIST) return;
        const rel = prefix ? `${prefix}/${e.name}` : e.name, abs = path.join(dir, e.name);
        if (e.isDirectory()) { walk(abs, rel); continue; }
        if (!e.isFile()) continue;
        if (e.name.endsWith('.part')) {
          let meta = {}; try { meta = JSON.parse(fs.readFileSync(abs + '.json', 'utf8')); } catch {}
          out.push({ name: rel.slice(0, -5), complete: false, have: fs.statSync(abs).size, size: Number.isSafeInteger(meta.size) ? meta.size : null });
        } else if (!internal(e.name)) {
          const st = fs.statSync(abs); out.push({ name: rel, complete: true, size: st.size, mtime: st.mtimeMs });
        }
      }
    };
    walk(areaDir, ''); return out;
  }
  async function stat(req, socket) {
    const { taskDir } = locate(req, { needName: false });
    const result = { ok: true, task: req.task, path: taskDir, exists: fs.existsSync(taskDir), in: list(path.join(taskDir, 'in')), out: list(path.join(taskDir, 'out')) };
    if (req.hash) { const { file } = locate({ ...req, ...req.hash }); result.sha256 = fs.existsSync(file) ? await sha(file) : null; }
    finish(socket, result);
  }
  async function put(req, socket) {
    const { taskDir, file, part, meta } = locate(req);
    if (!Number.isSafeInteger(req.size) || req.size < 0 || req.size > MAX_SIZE || !Number.isSafeInteger(req.offset) || req.offset < 0) return finish(socket, { ok: false, error: 'invalid size/offset' });
    if (fs.existsSync(file)) return finish(socket, { ok: false, error: 'exists', size: fs.statSync(file).size });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let prior = null; try { prior = JSON.parse(fs.readFileSync(meta, 'utf8')); } catch {}
    if (req.offset === 0 || (prior && prior.size !== req.size)) { fs.rmSync(part, { force: true }); prior = null; }
    const have = fs.existsSync(part) ? fs.statSync(part).size : 0;
    if (req.offset !== have || have > req.size) return finish(socket, { ok: false, error: 'offset mismatch', have });
    const fsStat = fs.statfsSync(taskDir), free = fsStat.bavail * fsStat.bsize;
    if (free < req.size - have + HEADROOM) return finish(socket, { ok: false, error: 'insufficient space on owner', free });
    if (!prior) fs.writeFileSync(meta, JSON.stringify({ size: req.size, startedAt: Date.now() }));
    line(socket, { ok: true, ready: true, have });
    const hash = have === 0 ? crypto.createHash('sha256') : null;
    let remaining = req.size - have;
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(part, { flags: 'a' });
      let failed = false;
      const fail = (e) => { if (failed) return; failed = true; socket.removeListener('data', onData); ws.end(); reject(e); };
      function onData(chunk) {
        if (chunk.length > remaining) { fail(Error('peer sent more bytes than declared')); socket.destroy(); return; }
        remaining -= chunk.length; hash?.update(chunk);
        if (!ws.write(chunk)) socket.pause();
        if (remaining === 0) { socket.removeListener('data', onData); ws.end(); }
      }
      ws.on('drain', () => socket.resume());
      ws.on('error', fail);
      ws.on('finish', () => { if (!failed) resolve(); });
      socket.on('close', () => { if (remaining > 0) fail(Error('connection closed mid-upload; partial kept for resume')); });
      if (remaining === 0) ws.end(); else { socket.on('data', onData); socket.resume(); }
    });
    const digest = hash ? hash.digest('hex') : await hashFile(part);
    const st = fs.statSync(part); memo.set(`${part}:${st.size}:${st.mtimeMs}`, digest);
    finish(socket, { ok: true, have: req.size, sha256: digest });
  }
  async function commit(req, socket) {
    const { file, part, meta } = locate(req);
    if (fs.existsSync(file)) return finish(socket, { ok: false, error: 'exists', size: fs.statSync(file).size });
    let m; try { m = JSON.parse(fs.readFileSync(meta, 'utf8')); } catch { return finish(socket, { ok: false, error: 'no partial upload' }); }
    const have = fs.existsSync(part) ? fs.statSync(part).size : 0;
    if (have !== m.size) return finish(socket, { ok: false, error: 'incomplete', have, size: m.size });
    const digest = await sha(part);
    if (digest !== req.sha256) { fs.rmSync(part, { force: true }); fs.rmSync(meta, { force: true }); return finish(socket, { ok: false, error: 'sha256 mismatch; partial removed, upload again', sha256: digest }); }
    replaceFileSync(part, file); fs.rmSync(meta, { force: true });
    finish(socket, { ok: true, size: m.size, sha256: digest });
  }
  async function get(req, socket) {
    const { file } = locate(req);
    let st; try { st = fs.statSync(file); } catch { return finish(socket, { ok: false, error: 'not found' }); }
    if (!st.isFile()) return finish(socket, { ok: false, error: 'not a file' });
    const offset = Number.isSafeInteger(req.offset) ? req.offset : 0;
    if (offset < 0 || offset > st.size) return finish(socket, { ok: false, error: 'offset beyond end', size: st.size });
    line(socket, { ok: true, size: st.size });
    await pipeline(fs.createReadStream(file, { start: offset }), socket);
  }
  function purge(req, socket) {
    if (req.name !== undefined) {
      const { file, part, meta } = locate(req);
      for (const f of [file, part, meta]) fs.rmSync(f, { force: true });
    } else {
      const { taskDir } = locate(req, { needName: false });
      fs.rmSync(taskDir, { recursive: true, force: true });
    }
    finish(socket, { ok: true });
  }
  const ops = { 'blob-stat': stat, 'blob-put': put, 'blob-commit': commit, 'blob-get': get, 'blob-purge': purge };
  return {
    async serve(req, socket, sourceHost) {
      socket.setTimeout(IDLE_MS, () => socket.destroy());
      try { await ops[req.op](req, socket); }
      catch (e) { log(`${req.op} from ${String(sourceHost).slice(0, 8)}: ${e.message}`); finish(socket, { ok: false, error: e.message }); }
    },
    reject(socket, error) { finish(socket, { ok: false, error }); },
    close() { memo.clear(); },
  };
}

// ---------- client ----------
function dial(config, peer) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ ...TLS_OPTIONS, host: peer.address, port: peer.port, checkServerIdentity: () => undefined,
      pskCallback: () => ({ identity: `agentbus:${config.hostId}`, psk: config.key }) });
    const timer = setTimeout(() => { socket.destroy(); reject(Error(`connect to ${peer.name || peer.hostId} timed out`)); }, 15000);
    socket.once('secureConnect', () => { clearTimeout(timer); socket.setTimeout(IDLE_MS, () => socket.destroy(Error('peer idle for 120s'))); resolve(socket); });
    socket.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}
// Buffered reader: json lines first, then the remaining raw bytes as a stream.
function reader(socket) {
  let buf = Buffer.alloc(0), waiting = null, ended = false, error = null;
  const onData = (c) => { buf = Buffer.concat([buf, c]); if (buf.length > 1 << 20 && !buf.includes(10)) socket.destroy(Error('oversized response line')); waiting?.(); };
  socket.on('data', onData);
  socket.on('end', () => { ended = true; waiting?.(); });
  socket.on('close', () => { ended = true; waiting?.(); });
  socket.on('error', (e) => { error = e; waiting?.(); });
  return {
    async line() {
      for (;;) {
        const nl = buf.indexOf(10);
        if (nl >= 0) { const l = buf.subarray(0, nl).toString('utf8'); buf = buf.subarray(nl + 1); return JSON.parse(l); }
        if (error) throw error;
        if (ended) throw Error('peer closed the connection');
        await new Promise((r) => { waiting = () => { waiting = null; r(); }; });
      }
    },
    detach() { socket.removeListener('data', onData); const rest = buf; buf = Buffer.alloc(0); return rest; },
  };
}
async function call(config, peer, head) {
  const socket = await dial(config, peer);
  try { const r = reader(socket); socket.write(JSON.stringify({ ...head, recipient: peer.hostId }) + '\n'); return await r.line(); }
  finally { socket.destroy(); }
}
export const blobStat = (config, peer, { storageId, task, hash }) => call(config, peer, { op: 'blob-stat', storageId, task, ...(hash ? { hash } : {}) });
export const blobPurge = (config, peer, { storageId, task, area, name }) => call(config, peer, { op: 'blob-purge', storageId, task, ...(name !== undefined ? { area, name } : {}) });

const transient = (e) => !e.permanent;
const permanent = (msg, extra = {}) => Object.assign(Error(msg), { permanent: true, ...extra });
async function withRetries(fn, { retries = 20, onRetry = () => {} } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); }
    catch (e) {
      if (!transient(e) || attempt >= retries) throw e;
      const wait = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
      onRetry(e, attempt + 1, wait); await new Promise((r) => setTimeout(r, wait));
    }
  }
}

export async function uploadFile(config, peer, { storageId, task, area = 'in', name, file, overwrite = false, onProgress = () => {}, retries, onRetry }) {
  if (!validName(name)) throw permanent(`invalid remote name ${name}`);
  const size = fs.statSync(file).size;
  return withRetries(async () => {
    const st = await blobStat(config, peer, { storageId, task });
    if (!st.ok) throw permanent(st.error);
    const remote = st[area].find((f) => f.name === name);
    let localSha = null;
    if (remote?.complete) {
      localSha = await hashFile(file);
      const check = await blobStat(config, peer, { storageId, task, hash: { area, name } });
      if (check.sha256 === localSha) { onProgress(size, size); return { name, size, sha256: localSha, skipped: true }; }
      if (!overwrite) throw permanent(`${area}/${name} already exists on the owner with different contents (use --overwrite)`);
      await blobPurge(config, peer, { storageId, task, area, name });
    }
    let offset = remote && !remote.complete && remote.size === size && remote.have <= size ? remote.have : 0;
    const socket = await dial(config, peer);
    try {
      const r = reader(socket);
      socket.write(JSON.stringify({ op: 'blob-put', recipient: peer.hostId, storageId, task, area, name, size, offset }) + '\n');
      const ready = await r.line();
      if (!ready.ok) { if (ready.error === 'offset mismatch') throw Error('offset mismatch, retrying from the owner\'s byte count'); throw permanent(ready.error); }
      offset = ready.have;
      const hash = offset === 0 ? crypto.createHash('sha256') : null;
      let closed = false; socket.once('close', () => { closed = true; });
      const drained = () => new Promise((resolve, reject) => {
        if (closed) return reject(Error('connection closed during upload'));
        const onDrain = () => { socket.removeListener('close', onClose); resolve(); };
        const onClose = () => { socket.removeListener('drain', onDrain); reject(Error('connection closed during upload')); };
        socket.once('drain', onDrain); socket.once('close', onClose);
      });
      let sent = offset; onProgress(sent, size);
      for await (const chunk of fs.createReadStream(file, { start: offset, highWaterMark: 1 << 20 })) {
        hash?.update(chunk);
        if (!socket.write(chunk)) await drained();
        sent += chunk.length; onProgress(sent, size);
      }
      const done = await r.line();
      if (!done.ok) throw permanent(done.error);
      localSha = hash ? hash.digest('hex') : (localSha || await hashFile(file));
      if (done.sha256 !== localSha) { await blobPurge(config, peer, { storageId, task, area, name }); throw Error('owner received different bytes; restarting upload'); }
    } finally { socket.destroy(); }
    const committed = await call(config, peer, { op: 'blob-commit', storageId, task, area, name, sha256: localSha });
    if (!committed.ok) { if (committed.error === 'incomplete') throw Error('owner reports incomplete upload; resuming'); throw permanent(committed.error); }
    return { name, size, sha256: localSha };
  }, { retries, onRetry });
}

export async function downloadFile(config, peer, { storageId, task, area = 'out', name, dest, onProgress = () => {}, retries, onRetry }) {
  if (!validName(name)) throw permanent(`invalid remote name ${name}`);
  fs.mkdirSync(path.dirname(path.resolve(dest)), { recursive: true });
  const part = dest + '.part';
  return withRetries(async () => {
    const st = await blobStat(config, peer, { storageId, task });
    if (!st.ok) throw permanent(st.error);
    const remote = st[area].find((f) => f.name === name && f.complete);
    if (!remote) throw permanent(`${area}/${name} is not a complete file on the owner`);
    let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
    if (have > remote.size) { fs.rmSync(part); have = 0; }
    const socket = await dial(config, peer);
    let received = have;
    try {
      const r = reader(socket);
      socket.write(JSON.stringify({ op: 'blob-get', recipient: peer.hostId, storageId, task, area, name, offset: have }) + '\n');
      const head = await r.line();
      if (!head.ok) throw permanent(head.error);
      if (head.size !== remote.size) throw Error('file changed on the owner; restarting');
      const ws = fs.createWriteStream(part, { flags: 'a' });
      const rest = r.detach();
      await new Promise((resolve, reject) => {
        const take = (c) => { received += c.length; if (received > head.size) { socket.destroy(); reject(Error('owner sent too many bytes')); return; } onProgress(received, head.size); if (!ws.write(c)) socket.pause(); };
        ws.on('drain', () => socket.resume()); ws.on('error', reject);
        if (rest.length) take(rest);
        socket.on('data', take);
        let settled = false;
        const complete = () => { if (settled) return; settled = true; ws.end(() => (received === head.size ? resolve() : reject(Error('connection closed during download; partial kept for resume')))); };
        socket.once('end', complete); socket.once('close', complete);
      });
    } finally { socket.destroy(); }
    if (received !== remote.size) throw Error('short download; resuming');
    const [localSha, check] = [await hashFile(part), await blobStat(config, peer, { storageId, task, hash: { area, name } })];
    if (check.sha256 !== localSha) { fs.rmSync(part, { force: true }); throw Error('sha256 mismatch after download; restarting'); }
    replaceFileSync(part, dest);
    return { name, size: remote.size, sha256: localSha, dest };
  }, { retries, onRetry });
}
