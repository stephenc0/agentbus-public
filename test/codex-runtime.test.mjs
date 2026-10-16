import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { terminateChild, delay } from '../lib/native-runtime.mjs';
import readline from 'node:readline';
import { createNativeQueueTransport } from '../lib/codex-native-queue.mjs';
import { requestBridge, bridgeThreads, bridgeEndpoint } from '../lib/codex-push.mjs';

// Opt-in integration test: real Codex, temporary home, local Responses stub.
// Never sends a request to a model provider or to an existing thread.
test('installed codex supports wrapped idle wakeup and active steering', { skip: !process.env.AGENTBUS_TEST_CODEX, timeout: 45000 }, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-live-'));
  fs.mkdirSync(path.join(home, '.codex'));
  const busDir = path.join(home, 'bus'); let calls = 0, bodyPassed = false; const modelRequests = [], responseTimers = new Set();
  const model = http.createServer((req, res) => {
    let body = ''; req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      calls++; modelRequests.push(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      const responseId = `resp_${calls}`;
      emit('response.created', { response: { id: responseId, status: 'in_progress', output: [] } });
      const responseTimer = setTimeout(() => {
        responseTimers.delete(responseTimer);
        if (res.destroyed) return;
        const message = { type: 'message', id: `msg_${calls}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ack', annotations: [] }] };
        emit('response.output_item.added', { output_index: 0, item: { ...message, status: 'in_progress', content: [] } });
        emit('response.output_text.delta', { item_id: message.id, output_index: 0, content_index: 0, delta: 'ack' });
        emit('response.output_item.done', { output_index: 0, item: message });
        emit('response.completed', { response: { id: responseId, status: 'completed', output: [message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
        res.end();
      }, 200);
      responseTimers.add(responseTimer);
    });
  }).listen(0, '127.0.0.1');
  await once(model, 'listening');
  const binary = process.env.AGENTBUS_TEST_CODEX;
  const args = ['bin/codex-bridge.mjs', '-c', 'model_provider="agentbus_test"', '-c', 'model="agentbus-test"', '-c', 'model_providers.agentbus_test.name="agentbus test"', '-c', `model_providers.agentbus_test.base_url="http://127.0.0.1:${model.address().port}/v1"`, '-c', 'model_providers.agentbus_test.wire_api="responses"', '-c', 'model_providers.agentbus_test.requires_openai_auth=false', 'app-server'];
  const child = spawn(process.execPath, args, { detached: process.platform !== 'win32', env: { ...process.env, HOME: home, CODEX_HOME: path.join(home, '.codex'), AGENTBUS_DIR: busDir, AGENTBUS_CODEX_REAL: binary }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', (b) => { stderr += b; });
  const pending = new Map(), notifications = []; let next = 0;
  const rejectPending = (e) => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(e); } pending.clear(); };
  child.on('error', rejectPending); child.stdin.on('error', rejectPending);
  child.on('exit', (code) => rejectPending(Error(`bridge exited ${code}: ${stderr}`)));
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); }
    else notifications.push(m);
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(Error(`${method} timeout: ${stderr}`)); }, 10000);
    pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  t.after(async () => {
    let cleanupError;
    try { await terminateChild(child); } catch (e) { cleanupError = e; t.diagnostic(`runtime cleanup: ${e.message}`); }
    rejectPending(Error('test cleanup')); lines.close(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    for (const timer of responseTimers) clearTimeout(timer);
    model.closeAllConnections(); await new Promise((resolve) => model.close(resolve));
    for (let attempt = 0; attempt < 10; attempt++) {
      try { fs.rmSync(home, { recursive: true, force: true }); break; }
      catch (e) { if (attempt === 9) t.diagnostic(`temporary directory retained after bounded cleanup: ${home}: ${e.message}`); else await delay(100); }
    }
    if (bodyPassed && cleanupError) throw cleanupError;
  });
  await rpc('initialize', { clientInfo: { name: 'agentbus_test', version: '0.3.0' }, capabilities: { experimentalApi: true } });
  // The desktop sends initialize but no initialized notification.
  const { thread } = await rpc('thread/start', { ephemeral: false, cwd: home, model: 'agentbus-test', approvalPolicy: 'on-request', sandbox: 'read-only' });
  const dir = path.join(busDir, 'bridges');
  const entry = path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith('.sock')));
  const socket = bridgeEndpoint(entry);
  assert(socket, 'bridge registry must resolve to the platform socket or named pipe');
  const discoveryDeadline = Date.now() + 2000;
  while (!bridgeThreads(busDir).has(thread.id) && Date.now() < discoveryDeadline) await new Promise((r) => setTimeout(r, 20));
  const discovered = bridgeThreads(busDir).get(thread.id);
  assert.equal(discovered?.cwd, home, 'untouched persisted thread must be discoverable before its first turn');
  assert.equal(discovered?.model, 'agentbus-test');
  assert.equal(discovered?.activeTurn, null);
  assert.equal(calls, 0, 'no user or model turn has run');
  const readiness = await requestBridge(socket, { op: 'status', threadId: thread.id });
  assert.equal(readiness.deliveryReady, true);
  assert.equal(readiness.wakeCapability, 'turn/start');
  const first = await requestBridge(socket, { threadId: thread.id, message: { msg_id: 'live-one', content: 'reply ack' } });
  assert.equal(first.status, 'accepted', JSON.stringify(first) + stderr);
  assert.equal(first.method, 'turn/start');
  const second = await requestBridge(socket, { threadId: thread.id, message: { msg_id: 'live-two', content: 'also acknowledge this update' } });
  assert.equal(second.status, 'accepted', JSON.stringify(second) + stderr);
  assert.equal(second.method, 'turn/steer');
  const deadline = Date.now() + 10000;
  while (!notifications.some((m) => m.method === 'turn/completed') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  const completed = notifications.find((m) => m.method === 'turn/completed');
  assert.equal(completed?.params.turn.status, 'completed', JSON.stringify(completed) + stderr);
  assert(calls > 0, 'local model stub handled inference');
  assert(modelRequests.every((request) => request.model === 'agentbus-test'), 'wake inherits selected model');
  const sessionDir = path.join(home, '.codex', 'sessions');
  const rollouts = fs.readdirSync(sessionDir, { recursive: true }).filter((f) => f.endsWith('.jsonl'));
  const contexts = rollouts.flatMap((file) => fs.readFileSync(path.join(sessionDir, file), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))).filter((row) => row.type === 'turn_context');
  assert(contexts.length > 0, 'runtime persisted a turn context');
  for (const { payload } of contexts) {
    assert.equal(payload.approval_policy, 'on-request');
    assert.equal(payload.sandbox_policy.type, 'read-only');
    assert.equal(payload.model, 'agentbus-test');
  }
  const inbox = path.join(busDir, 'inbox', thread.id); fs.mkdirSync(inbox, { recursive: true });
  const queued = path.join(inbox, 'queued.json');
  fs.writeFileSync(queued, JSON.stringify({ msg_id: 'queued-on-restart', content: 'reply ack again' }));
  const recoveryDeadline = Date.now() + 10000;
  while (notifications.filter((m) => m.method === 'turn/completed').length < 2 && Date.now() < recoveryDeadline) await new Promise((r) => setTimeout(r, 20));
  assert.equal(notifications.filter((m) => m.method === 'turn/completed').length, 2, stderr);
  assert(!fs.existsSync(queued), 'queued message should be acknowledged and removed');
  await t.test('foreign native queue wakes its owner when supported', async (q) => {
    const foreignQueue = createNativeQueueTransport({ binary, codexHome: path.join(home, '.codex') });
  const foreign = await foreignQueue.add(thread.id, { msg_id: 'foreign-queue-message', content: 'foreign native queue nonce' });
  if (foreign.status === 'unavailable' && /does not expose native queue API/.test(foreign.error || '')) { q.skip(foreign.error); return; }
  assert.equal(foreign.status, 'accepted', JSON.stringify(foreign));
  assert.equal(foreign.method, 'thread/queue/add');
  const foreignDeadline = Date.now() + 12000;
  while (notifications.filter((m) => m.method === 'turn/completed').length < 3 && Date.now() < foreignDeadline) await new Promise((r) => setTimeout(r, 20));
  assert.equal(notifications.filter((m) => m.method === 'turn/completed').length, 3, 'owning runtime must drain foreign native queue');
  assert(modelRequests.every((request) => request.model === 'agentbus-test'), 'foreign queue retains owner model');
  assert(JSON.stringify(modelRequests).includes('foreign native queue nonce'));
  });
  assert(!notifications.some((m) => typeof m.id === 'string' && m.id.startsWith('agentbus:')), 'internal responses leaked');
  bodyPassed = true;
});
