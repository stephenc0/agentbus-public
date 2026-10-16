// Supported native queue API only: never resume a thread or start a foreign turn.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { buildInfo } from './build-info.mjs';
import { runNative, terminateChild, processAlive, delay } from './native-runtime.mjs';

let transportChain = Promise.resolve();
export function createNativeQueueTransport({ binary, codexHome, cwd, lockDir, timeoutMs = 5000, run = runNative } = {}) {
  let schema;
  async function exclusive(work) {
    if (!lockDir) return work();
    const file = path.join(lockDir, 'native-queue.lock'), deadline = Date.now() + timeoutMs;
    let fd;
    while (fd === undefined) {
      try { fd = fs.openSync(file, 'wx', 0o600); }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        try {
          const original = fs.readFileSync(file, 'utf8'), owner = JSON.parse(original);
          if (Number.isInteger(owner.pid) && !processAlive(owner.pid) && fs.readFileSync(file, 'utf8') === original) fs.unlinkSync(file);
        } catch {}
        if (Date.now() >= deadline) throw Error('native queue helper busy; no message dispatched');
        await delay(25);
      }
    }
    try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })); return await work(); }
    finally { fs.closeSync(fd); fs.unlinkSync(file); }
  }
  const serial = (work) => { const result = transportChain.then(() => exclusive(work)); transportChain = result.catch(() => {}); return result; };
  async function supported() {
    if (schema && schema.until > Date.now()) return schema.ok;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-q-schema-'));
    let ok = false;
    try {
      const result = await run(binary, ['app-server', 'generate-json-schema', '--experimental', '--out', dir], { cwd, timeout: timeoutMs });
      if (result.ok) {
        const read = (name) => JSON.parse(fs.readFileSync(path.join(dir, 'v2', name + '.json'), 'utf8'));
        const add = read('ThreadQueueAddParams'), reply = read('ThreadQueueAddResponse'), list = read('ThreadQueueListResponse');
        ok = !!(add.properties?.threadId && add.properties?.clientUserMessageId && add.properties?.input && reply.properties?.queuedSubmission && list.properties?.data);
      }
    } catch {} finally { fs.rmSync(dir, { recursive: true, force: true }); }
    schema = { ok, until: Date.now() + (ok ? 300000 : 3000) }; return ok;
  }
  async function session(work) {
    const child = spawn(binary, ['app-server'], { cwd, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CODEX_HOME: codexHome } });
    const pending = new Map(); let seq = 0, closed = false;
    const fail = (error) => { closed = true; for (const p of pending.values()) p.reject(error); pending.clear(); };
    child.on('error', fail); child.on('exit', () => fail(Error('native queue app-server exited')));
    child.stdin.on('error', fail); child.stderr.resume();
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      let frame; try { frame = JSON.parse(line); } catch { return; }
      const p = pending.get(frame.id); if (!p || frame.method) return;
      pending.delete(frame.id);
      frame.error ? p.reject(Object.assign(Error(frame.error.message), { rejected: true, code: frame.error.code })) : p.resolve(frame.result);
    });
    const rpc = (method, params) => new Promise((resolve, reject) => {
      if (closed) return reject(Error('native queue app-server closed'));
      const id = ++seq; pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
    let timer, outcome;
    try {
      outcome = await Promise.race([
        (async () => {
          await rpc('initialize', { clientInfo: { name: 'agentbus_native_queue', version: buildInfo.version }, capabilities: { experimentalApi: true } });
          child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
          return work(rpc);
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => { const e = Error('native queue operation timed out'); fail(e); reject(e); }, timeoutMs); }),
      ]);
      return outcome;
    } finally {
      clearTimeout(timer); lines.close(); fail(Error('native queue operation complete'));
      // Keep the leader alive until owned descendant cleanup. Closing stdin
      // first could orphan plugin/MCP children before Windows taskkill /T.
      try { await terminateChild(child); }
      catch (e) {
        const warning = `native queue helper cleanup unconfirmed: ${e.message}`;
        if (outcome && typeof outcome === 'object') outcome.cleanupWarning = warning;
        else process.stderr.write(warning + '\n');
      }
      child.stdin.destroy();
    }
  }
  function probe(threadIds) {
    return serial(async () => {
      if (!await supported()) return Object.fromEntries(threadIds.map((id) => [id, { ready: false, error: 'configured runtime does not expose native queue API' }]));
      const results = {};
      try {
        await session(async (rpc) => {
          for (const id of threadIds) {
            try { const r = await rpc('thread/queue/list', { threadId: id }); results[id] = { ready: Array.isArray(r.data), error: Array.isArray(r.data) ? null : 'invalid native queue list' }; }
            catch (e) { results[id] = { ready: false, error: e.message }; }
          }
        });
      } catch (e) { for (const id of threadIds) results[id] ||= { ready: false, error: e.message }; }
      return results;
    });
  }
  function add(threadId, message) {
    return serial(async () => {
      if (!await supported()) return { status: 'unavailable', error: 'configured runtime does not expose native queue API' };
      let dispatched = false;
      try {
        return await session(async (rpc) => {
          // A never-prompted thread may be loaded yet have no rollout. Do not
          // create one or move its ownership just to make this transport work.
          await rpc('thread/queue/list', { threadId });
          dispatched = true;
          const result = await rpc('thread/queue/add', { threadId, clientUserMessageId: message.msg_id, input: [{ type: 'text', text: message.content }] });
          const queued = result?.queuedSubmission;
          if (typeof queued?.id !== 'string' || queued.clientUserMessageId !== message.msg_id) return { status: 'uncertain', error: 'native queue acknowledgement did not match message' };
          return { status: 'accepted', method: 'thread/queue/add', queueId: queued.id };
        });
      } catch (e) { return { status: dispatched ? (e.rejected ? 'rejected' : 'uncertain') : 'unavailable', error: e.message }; }
    });
  }
  return { probe, add };
}

function matchesOwner(binary, ownerBinary) {
  if (!ownerBinary) return true;
  try { const a = fs.realpathSync(binary), b = fs.realpathSync(ownerBinary); return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b; } catch { return false; }
}
const instances = new Map();
function configured(busDir, codexHome) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(busDir, 'native-queue-config.json'), 'utf8'));
    if (config.enabled !== true || !path.isAbsolute(config.binary || '')) return null;
    const stat = fs.statSync(config.binary);
    if (!stat.isFile()) return null;
    const key = `${busDir}:${config.binary}:${stat.size}:${stat.mtimeMs}:${codexHome}`;
    if (!instances.has(key)) instances.set(key, { binary: config.binary, transport: createNativeQueueTransport({ binary: config.binary, codexHome, lockDir: busDir }), checked: new Map(), waiting: new Set(), scheduled: false });
    return instances.get(key);
  } catch { return null; }
}
function scheduleProbe(instance, threadId) {
  if (instance.waiting.size >= 256) return;
  instance.waiting.add(threadId);
  if (instance.scheduled) return;
  instance.scheduled = true;
  setTimeout(async () => {
    while (instance.waiting.size) {
      const ids = [...instance.waiting].slice(0, 32); ids.forEach((id) => instance.waiting.delete(id));
      const results = await instance.transport.probe(ids).catch((e) => Object.fromEntries(ids.map((id) => [id, { ready: false, error: e.message }])));
      for (const id of ids) instance.checked.set(id, { ...results[id], at: Date.now() });
    }
    instance.scheduled = false;
  }, 25).unref();
}
export function nativeQueueReadiness(busDir, codexHome, threadId, rolloutPath, ownerBinary) {
  const instance = configured(busDir, codexHome);
  if (!instance) return null;
  if (!matchesOwner(instance.binary, ownerBinary)) return { deliveryReady: false, wakeCapability: 'hook-only', unavailableReason: 'configured native queue runtime differs from the owning runtime', deliveryCheckedAt: null };
  const value = instance.checked.get(threadId), fresh = value && Date.now() - value.at < (value.ready ? 300000 : 30000);
  // Discovery knows whether a persisted rollout exists. Avoid probing untouched
  // UI threads: there is no queue substrate for them yet.
  if (!fresh && rolloutPath && fs.existsSync(rolloutPath)) scheduleProbe(instance, threadId);
  return { deliveryReady: !!(fresh && value.ready), wakeCapability: fresh && value.ready ? 'native-queue' : 'hook-only',
    unavailableReason: fresh && value.ready ? null : (fresh ? value.error : rolloutPath ? 'native queue readiness pending' : 'thread has no persisted rollout; native queue wake unavailable'),
    deliveryCheckedAt: value?.at || null };
}
export async function pushNativeQueue(busDir, codexHome, threadId, message, ownerBinary) {
  const instance = configured(busDir, codexHome);
  if (!instance) return { status: 'unavailable', error: 'native queue transport is not configured' };
  if (!matchesOwner(instance.binary, ownerBinary)) return { status: 'unavailable', error: 'configured native queue runtime differs from the owning runtime' };
  const result = await instance.transport.add(threadId, message).catch((e) => ({ status: 'unavailable', error: e.message }));
  if (result.status === 'accepted') instance.checked.set(threadId, { ready: true, at: Date.now() });
  return result;
}
