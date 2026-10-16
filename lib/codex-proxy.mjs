import { atomicWriteFileSync } from './atomic-file.mjs';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { flushQueued, bridgeListenPath } from './codex-push.mjs';

// A single upstream connection remains owned/initialized by the desktop client.
// Server approval requests and notifications pass through unchanged.
export function attachProxy({ child, input, output, busDir, timeout = 10000 }) {
  const nonce = crypto.randomUUID();
  const pending = new Map(), desktop = new Map(), turns = new Map(), chains = new Map(), seen = new Map();
  const threadMeta = new Map();
  let ready = false, closed = false, counter = 0;
  const send = (frame) => child.stdin.write(JSON.stringify(frame) + '\n');
  const id = (kind) => `agentbus:${nonce}:${kind}:${++counter}`;
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const requestId = id('push');
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(Object.assign(Error(`${method} timed out`), { uncertain: true }));
    }, timeout);
    pending.set(requestId, { resolve, reject, timer });
    send({ id: requestId, method, params });
  });
  const incoming = readline.createInterface({ input });
  incoming.on('line', (line) => {
    let frame;
    try { frame = JSON.parse(line); } catch { child.stdin.write(line + '\n'); return; }
    if (frame.method && frame.id !== undefined) {
      const requestId = id('desktop');
      desktop.set(requestId, { id: frame.id, method: frame.method });
      frame.id = requestId;
    }
    send(frame);
  });
  incoming.on('close', () => { ready = false; child.stdin.end(); });
  const upstream = readline.createInterface({ input: child.stdout });
  upstream.on('line', (line) => {
    let frame;
    try { frame = JSON.parse(line); } catch { output.write(line + '\n'); return; }
    const p = frame.params || {};
    if (frame.method === 'thread/started') { rememberThread(p); schedulePublish(); }
    if (frame.method === 'thread/closed') { turns.delete(p.threadId); threadMeta.delete(p.threadId); schedulePublish(); }
    if (frame.method === 'turn/started') { turns.set(p.threadId, p.turn?.id); schedulePublish(); }
    if (frame.method === 'turn/completed' && turns.get(p.threadId) === p.turn?.id) { turns.delete(p.threadId); schedulePublish(); }
    if (!frame.method && pending.has(frame.id)) {
      const task = pending.get(frame.id); pending.delete(frame.id); clearTimeout(task.timer);
      if (frame.error) task.reject(Object.assign(Error(frame.error.message), { rejected: true }));
      else task.resolve(frame.result);
      return;
    }
    // Swallow late responses to our requests, never leak them into the desktop.
    if (!frame.method && typeof frame.id === 'string' && frame.id.startsWith(`agentbus:${nonce}:push:`)) return;
    if (!frame.method && desktop.has(frame.id)) {
      const original = desktop.get(frame.id); desktop.delete(frame.id); frame.id = original.id;
      // Desktop clients can omit the optional initialized notification. The
      // successful initialize response is the authoritative readiness signal.
      if (original.method === 'initialize' && !frame.error && frame.result) { ready = true; schedulePublish(); }
      if (!frame.error && ['thread/start', 'thread/resume', 'thread/fork'].includes(original.method)) {
        rememberThread(frame.result); schedulePublish();
      }
    }
    output.write(JSON.stringify(frame) + '\n');
  });

  function rememberThread(result) {
    const thread = result?.thread;
    if (typeof thread?.id !== 'string') return;
    const old = threadMeta.get(thread.id) || {};
    threadMeta.set(thread.id, { ...old,
      ...(typeof (result.cwd || thread.cwd) === 'string' ? { cwd: result.cwd || thread.cwd } : {}),
      ...(typeof result.model === 'string' ? { model: result.model } : {}),
      ...(typeof thread.name === 'string' ? { name: thread.name } : {}),
    });
    const active = thread.turns?.find((turn) => turn.status === 'inProgress');
    if (active?.id) turns.set(thread.id, active.id);
  }
  async function loadedThreads() {
    const loaded = [], cursors = new Set(); let cursor;
    do {
      const page = await rpc('thread/loaded/list', { cursor, limit: 100 });
      if (!Array.isArray(page.data) || page.data.some((id) => typeof id !== 'string')) throw Error('invalid loaded thread response');
      loaded.push(...page.data); cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw Error('repeated loaded thread cursor');
      cursors.add(cursor);
    } while (cursor);
    return loaded;
  }
  async function deliver({ threadId, message }) {
    if (!ready || closed) return { status: 'unavailable', error: 'app-server not initialized' };
    let dispatched = false;
    try {
      // A saved thread is not necessarily owned by this process. Never resume it
      // into a second runtime just to deliver mail.
      if (!(await loadedThreads()).includes(threadId)) return { status: 'unavailable', error: 'thread is not loaded in this app-server' };
      const turnId = turns.get(threadId);
      const method = turnId ? 'turn/steer' : 'turn/start';
      const params = { threadId, input: [{ type: 'text', text: message.content }], clientUserMessageId: message.msg_id };
      if (turnId) params.expectedTurnId = turnId;
      dispatched = true;
      const result = await rpc(method, params);
      const activeId = result.turnId || result.turn?.id;
      if (activeId) turns.set(threadId, activeId);
      schedulePublish();
      return { status: 'accepted', method, turn_id: activeId };
    } catch (e) {
      return { status: dispatched ? (e.rejected ? 'rejected' : 'uncertain') : 'unavailable', error: e.message };
    }
  }
  function enqueue(request) {
    const key = `${request.threadId}:${request.message.msg_id}`;
    if (seen.has(key)) return seen.get(key);
    const before = chains.get(request.threadId) || Promise.resolve();
    const task = before.then(() => deliver(request));
    chains.set(request.threadId, task);
    seen.set(key, task);
    task.then((result) => {
      if (chains.get(request.threadId) === task) chains.delete(request.threadId);
      if (result.status === 'unavailable' || result.status === 'rejected') seen.delete(key);
      // This is an in-process retry cache, not an exactly-once guarantee.
      if (seen.size > 10000) seen.delete(seen.keys().next().value);
    });
    return task;
  }
  const dir = path.join(busDir, 'bridges');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const { entry: socketPath, listen } = bridgeListenPath(dir, process.pid, nonce.slice(0, 8));
  const statePath = socketPath.replace(/\.sock$/, '.state.json');
  // Publish what this app-server has loaded so discovery works without per-thread lock files
  // (including threads not yet persisted). Busy = a turn we saw start and not complete.
  async function publishState() {
    const loaded = await loadedThreads();
    const state = { pid: process.pid, ready, at: Date.now(), loaded,
      metadata: Object.fromEntries([...threadMeta].filter(([t]) => loaded.includes(t))),
      active: Object.fromEntries([...turns].filter(([t]) => loaded.includes(t))) };
    if (closed) return;
    atomicWriteFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
  }
  let publishQueued = false;
  function schedulePublish() {
    if (publishQueued) return; publishQueued = true;
    setTimeout(() => { publishQueued = false; if (ready && !closed) publishState().catch((e) => process.stderr.write(`agentbus bridge state: ${e.message}\n`)); }, 50).unref();
  }
  const clients = new Set();
  const server = net.createServer((socket) => {
    clients.add(socket); socket.on('close', () => clients.delete(socket)); socket.on('error', () => {});
    socket.setTimeout(30000, () => socket.destroy());
    let data = '', handled = false;
    socket.on('data', async (chunk) => {
      if (handled) return;
      data += chunk;
      if (data.length > 1024 * 1024) { handled = true; socket.end(JSON.stringify({ status: 'rejected', error: 'message too large' }) + '\n'); return; }
      const end = data.indexOf('\n'); if (end < 0) return;
      handled = true;
      let request;
      try {
        request = JSON.parse(data.slice(0, end));
        if (request.op === 'status') {
          let ownsThread;
          if (request.threadId !== undefined) {
            if (typeof request.threadId !== 'string' || !request.threadId) throw Error('invalid threadId');
            ownsThread = false;
            if (ready && !closed) {
              ownsThread = (await loadedThreads()).includes(request.threadId);
            }
          }
          socket.end(JSON.stringify({ status: 'accepted', ready: ready && !closed, pid: process.pid, protocolVersion: 3, ...(ownsThread === undefined ? {} : { ownsThread, deliveryReady: ownsThread, wakeCapability: ownsThread ? (turns.has(request.threadId) ? 'turn/steer' : 'turn/start') : 'hook-only', unavailableReason: ownsThread ? null : (ready ? 'thread is not loaded in this app-server' : 'app-server not initialized') }) }) + '\n');
          return;
        }
        if (typeof request.threadId !== 'string' || !request.threadId || typeof request.message?.msg_id !== 'string' || typeof request.message?.content !== 'string') throw Error('invalid request');
      } catch { socket.end(JSON.stringify({ status: 'rejected', error: 'invalid request' }) + '\n'); return; }
      const result = await enqueue(request);
      if (!socket.destroyed) socket.end(JSON.stringify(result) + '\n');
    });
  });
  server.on('error', (e) => process.stderr.write(`agentbus bridge: ${e.message}\n`));
  server.listen(listen, () => {
    if (listen === socketPath) fs.chmodSync(socketPath, 0o600);
    else fs.writeFileSync(socketPath, listen, { mode: 0o600 });
  });
  let flushing = false;
  const poll = setInterval(async () => {
    if (!ready || closed || flushing) return;
    flushing = true;
    try { await publishState(); }
    catch (e) { process.stderr.write(`agentbus bridge state: ${e.message}\n`); }
    try { await flushQueued(busDir, enqueue); }
    catch (e) { process.stderr.write(`agentbus inbox recovery: ${e.message}\n`); }
    finally { flushing = false; }
  }, 3000);
  poll.unref();
  const close = () => {
    if (closed) return; closed = true;
    clearInterval(poll);
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(Error('app-server exited')); }
    pending.clear();
    for (const client of clients) client.destroy();
    server.close();
    for (const f of [socketPath, statePath]) { try { fs.unlinkSync(f); } catch {} }
    incoming.close(); upstream.close();
  };
  child.stdin.on('error', close);
  child.once('close', close);
  return { socketPath, endpoint: listen, close, server };
}
