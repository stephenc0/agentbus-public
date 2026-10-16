import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter, once } from 'node:events';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { attachProxy } from '../lib/codex-proxy.mjs';
import { requestBridge, flushQueued, bridgeListenPath, bridgeThreads, listBridges } from '../lib/codex-push.mjs';
import { bridgeStatus } from '../lib/codex-install.mjs';
import { desktopLaunchArgs } from '../lib/codex-launch.mjs';

const bus = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-test-'));
process.env.AGENTBUS_DIR = bus;
const { deliverToCodex, drainInbox } = await import('../lib/core.mjs');
const target = { threadId: 'test-thread', id: 'codex:test-thread', status: 'busy' };
const sender = { id: 'claude:test', name: 'test', kind: 'claude' };
const tick = () => new Promise((r) => setImmediate(r));

async function harness(t, handler, timeout = 500, initialize = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-proxy-'));
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough();
  const input = new PassThrough(), output = new PassThrough();
  const requests = [], clientFrames = [];
  const send = (m) => child.stdout.write(JSON.stringify(m) + '\n');
  readline.createInterface({ input: output }).on('line', (l) => clientFrames.push(JSON.parse(l)));
  const commands = readline.createInterface({ input: child.stdin });
  commands.on('line', (l) => { const m = JSON.parse(l); requests.push(m); if (m.method === 'initialize' && initialize) send({ id: m.id, result: { userAgent: 'test' } }); else handler?.(m, send); });
  const proxy = attachProxy({ child, input, output, busDir: dir, timeout });
  await once(proxy.server, 'listening');
  t.after(() => { proxy.close(); input.destroy(); output.destroy(); commands.close(); child.stdin.destroy(); child.stdout.destroy(); fs.rmSync(dir, { recursive: true, force: true }); });
  if (initialize) input.write('{"id":0,"method":"initialize","params":{}}\n');
  await tick();
  clientFrames.length = 0;
  return { ...proxy, requests, clientFrames, input, send };
}
const request = (id = 'message-1') => ({ threadId: 'thread-1', message: { msg_id: id, content: 'peer update' } });
const standard = (m, send) => {
  if (m.method === 'thread/loaded/list') send({ id: m.id, result: { data: ['thread-1'], nextCursor: null } });
  if (m.method === 'turn/start') send({ id: m.id, result: { turn: { id: 'new-turn', status: 'inProgress' } } });
  if (m.method === 'turn/steer') send({ id: m.id, result: { turnId: m.params.expectedTurnId } });
};

test('initialize success enables desktop push without initialized notification', async (t) => {
  const h = await harness(t, standard);
  const status = await requestBridge(h.endpoint, { op: 'status' });
  assert.equal(status.ready, true);
  assert.equal(status.protocolVersion, 3);
  assert(!h.requests.some((m) => m.method === 'initialized'));
  assert.equal((await requestBridge(h.endpoint, request())).status, 'accepted');
});

test('status distinguishes configured launcher, live bridge and live target ownership without starting turns', async (t) => {
  const h = await harness(t, standard);
  const busDir = path.dirname(path.dirname(h.socketPath));
  const wrapper = '/test/wrapper';
  fs.writeFileSync(path.join(busDir, 'bridge-config.json'), JSON.stringify({ wrapper }));
  const options = { busDir, launcherOverride: wrapper };
  const owned = await bridgeStatus('codex:thread-1', options);
  assert.equal(owned.configured, true);
  assert.equal(owned.liveReady, true);
  assert.equal(owned.deliveryReady, true);
  const unowned = await bridgeStatus('another-thread', options);
  assert.equal(unowned.liveReady, true);
  assert.equal(unowned.deliveryReady, false);
  assert(!h.requests.some((r) => ['turn/start', 'turn/steer', 'thread/resume'].includes(r.method)));
  h.close();
  const dead = await bridgeStatus('thread-1', options);
  assert.equal(dead.configured, true);
  assert.equal(dead.liveReady, false);
  assert.equal(dead.deliveryReady, false);
});

test('dead registrations are removed on every platform without touching live entries or queued mail', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-stale-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'bridges'));
  const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
  assert.throws(() => process.kill(deadPid, 0), { code: 'ESRCH' });
  const dead = bridgeListenPath(path.join(dir, 'bridges'), deadPid, 'abcdabcd');
  const live = bridgeListenPath(path.join(dir, 'bridges'), process.pid, 'abcdabcd');
  for (const b of [dead, live]) {
    fs.writeFileSync(b.entry, b.listen);
    fs.writeFileSync(b.entry.replace(/\.sock$/, '.state.json'), '{}');
  }
  fs.mkdirSync(path.join(dir, 'inbox', 'thread'), { recursive: true });
  for (const suffix of ['.json', '.json.push', '.json.uncertain']) fs.writeFileSync(path.join(dir, 'inbox', 'thread', 'mail' + suffix), 'preserve');
  assert.deepEqual(listBridges(dir).map((b) => b.pid), [process.pid]);
  assert(!fs.existsSync(dead.entry));
  assert(!fs.existsSync(dead.entry.replace(/\.sock$/, '.state.json')));
  assert(fs.existsSync(live.entry));
  assert.equal(fs.readdirSync(path.join(dir, 'inbox', 'thread')).length, 3);
});

test('desktop launch supplies wrapper directly to outer app without shell interpolation', () => {
  const args = desktopLaunchArgs({ binary: '/Applications/Chat GPT.app/Contents/Resources/CodexCLI.app/Contents/MacOS/codex', wrapper: '/Users/test/a $b/wrapper' });
  assert.deepEqual(args, ['-a', '/Applications/Chat GPT.app', '--env', 'CODEX_CLI_PATH=/Users/test/a $b/wrapper']);
  assert.throws(() => desktopLaunchArgs({ binary: '/usr/bin/codex', wrapper: '/x' }));
});

test('failed or pending initialize cannot be made ready by initialized notification', async (t) => {
  const h = await harness(t, (m, send) => { if (m.method === 'initialize') send({ id: m.id, error: { message: 'no' } }); }, 500, false);
  assert.equal((await requestBridge(h.endpoint, { op: 'status' })).ready, false);
  h.input.write('{"id":1,"method":"initialize","params":{}}\n{"method":"initialized"}\n');
  await tick();
  assert.equal((await requestBridge(h.endpoint, request())).status, 'unavailable');
  assert.equal((await requestBridge(h.endpoint, { op: 'status' })).ready, false);
  assert(h.clientFrames.some((m) => m.id === 1 && m.error));
});

test('queue recovery claims once, preserves unavailable mail and isolates uncertainty', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-recover-'));
  const inbox = path.join(dir, 'inbox', 'thread'); fs.mkdirSync(inbox, { recursive: true });
  const file = path.join(inbox, '1.json');
  fs.writeFileSync(file, JSON.stringify({ msg_id: '1', content: 'hello' }));
  await flushQueued(dir, async () => ({ status: 'unavailable' }));
  assert(fs.existsSync(file));
  let deliveries = 0;
  const deliver = async () => { deliveries++; await tick(); return { status: 'accepted' }; };
  await Promise.all([flushQueued(dir, deliver), flushQueued(dir, deliver)]);
  assert.equal(deliveries, 1); assert(!fs.existsSync(file));
  fs.writeFileSync(file, JSON.stringify({ msg_id: '2', content: 'hello' }));
  await flushQueued(dir, async () => ({ status: 'uncertain' }));
  assert(fs.existsSync(file + '.uncertain'));
  await flushQueued(dir, deliver); assert.equal(deliveries, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('idle delivery starts once, duplicates reuse acknowledgement, active delivery steers', async (t) => {
  const h = await harness(t, standard);
  assert.equal((await requestBridge(h.endpoint, request())).method, 'turn/start');
  assert.equal((await requestBridge(h.endpoint, request())).status, 'accepted');
  assert.equal(h.requests.filter((m) => m.method === 'turn/start').length, 1);
  const next = await requestBridge(h.endpoint, request('message-2'));
  assert.equal(next.method, 'turn/steer');
  assert.equal(next.turn_id, 'new-turn');
  assert.equal(h.clientFrames.length, 0);
  if (process.platform !== 'win32') assert.equal(fs.statSync(h.socketPath).mode & 0o777, 0o600);
  else assert.equal(fs.readFileSync(h.socketPath, 'utf8'), h.endpoint);
});

test('desktop request ids, server approval requests and turn notifications survive routing', async (t) => {
  const h = await harness(t, (m, send) => {
    standard(m, send);
    if (m.method === 'model/list') send({ id: m.id, result: { data: [] } });
  });
  h.input.write(JSON.stringify({ id: 12, method: 'model/list', params: {} }) + '\n');
  h.send({ id: 12, method: 'item/commandExecution/requestApproval', params: {} });
  h.input.write(JSON.stringify({ id: 12, result: { decision: 'decline' } }) + '\n');
  h.send({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'working' } } });
  await tick();
  assert(h.clientFrames.some((m) => m.id === 12 && m.result));
  assert(h.clientFrames.some((m) => m.id === 12 && m.method?.includes('requestApproval')));
  assert(h.requests.some((m) => m.id === 12 && m.result?.decision === 'decline'));
  assert.equal((await requestBridge(h.endpoint, request())).turn_id, 'working');
  h.send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'working' } } });
  await tick();
  assert.equal((await requestBridge(h.endpoint, request('after'))).method, 'turn/start');
});

test('unowned thread never starts or resumes; loaded list pagination works', async (t) => {
  const h = await harness(t, (m, send) => {
    if (m.method === 'thread/loaded/list') send({ id: m.id, result: { data: m.params.cursor ? ['thread-1'] : [], nextCursor: m.params.cursor ? null : 'next' } });
    else standard(m, send);
  });
  assert.equal((await requestBridge(h.endpoint, request())).status, 'accepted');
  const other = { ...request(), threadId: 'not-owned' };
  assert.equal((await requestBridge(h.endpoint, other)).status, 'unavailable');
  assert.equal(h.requests.filter((m) => m.method === 'turn/start').length, 1);
  assert(!h.requests.some((m) => m.method === 'thread/resume'));
});

test('definite rejection permits fallback; timed out write remains uncertain and late reply is hidden', async (t) => {
  let late;
  const h = await harness(t, (m, send) => {
    if (m.method === 'turn/start') {
      if (m.params.clientUserMessageId === 'reject') send({ id: m.id, error: { code: -1, message: 'rejected' } });
      else late = () => send({ id: m.id, result: { turn: { id: 'late' } } });
    } else standard(m, send);
  }, 40);
  assert.equal((await requestBridge(h.endpoint, request('reject'))).status, 'rejected');
  assert.equal((await requestBridge(h.endpoint, request())).status, 'uncertain');
  late(); await tick();
  assert.equal(h.clientFrames.length, 0);
  assert.equal((await requestBridge(h.endpoint, request())).status, 'uncertain');
  assert.equal(h.requests.filter((m) => m.method === 'turn/start').length, 2);
});

test('socket disconnect after acceptance is ambiguous, never unavailable', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-drop-'));
  const { listen: sock } = bridgeListenPath(dir, process.pid, '0000d0d0');
  const server = net.createServer((s) => s.once('data', () => s.destroy())).listen(sock);
  await once(server, 'listening');
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.equal((await requestBridge(sock, request())).status, 'uncertain');
});

test('no bridge queues durable mail; a hook can claim it only once', async () => {
  const result = await deliverToCodex(target, sender, 'hello');
  assert.equal(result.delivery, 'queued');
  const pending = drainInbox(target.threadId, { peek: true });
  assert.equal(pending.length, 1);
  assert.match(pending[0].content, /<cross-session-message from="claude:test"/);
  assert(pending[0].content.endsWith('</cross-session-message>'));
  assert(!pending[0].content.includes('reply with'));
  assert.equal(drainInbox(target.threadId).length, 1);
  assert.equal(drainInbox(target.threadId).length, 0);
});

test('accepted push never enters hook inbox; ambiguous push is retained separately', async (t) => {
  const dir = path.join(bus, 'bridges'); fs.mkdirSync(dir, { recursive: true });
  const { entry, listen: sock } = bridgeListenPath(dir, process.pid, '0000beef'); let mode = 'accepted';
  const server = net.createServer((s) => s.once('data', () => s.end(JSON.stringify({ status: mode, method: 'turn/start' }) + '\n'))).listen(sock);
  await once(server, 'listening');
  if (entry !== sock) fs.writeFileSync(entry, sock);
  t.after(() => { server.close(); fs.rmSync(entry, { force: true }); });
  assert.equal((await deliverToCodex(target, sender, 'one')).delivery, 'accepted');
  assert.equal(drainInbox(target.threadId).length, 0);
  mode = 'uncertain';
  const result = await deliverToCodex(target, sender, 'two');
  assert.equal(result.delivery, 'uncertain');
  assert(fs.existsSync(result.recovery_file));
  assert.equal(drainInbox(target.threadId).length, 0);
});

test('bridge publishes loaded threads and active turns for lock-free discovery', async (t) => {
  const h = await harness(t, standard);
  h.send({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'busy-turn' } } });
  const dir = path.dirname(h.socketPath), busDir = path.dirname(dir);
  let threads;
  for (let i = 0; i < 50 && !threads?.size; i++) { await new Promise((r) => setTimeout(r, 20)); threads = bridgeThreads(busDir); }
  assert.equal(threads.get('thread-1')?.activeTurn, 'busy-turn');
  assert.equal(threads.get('thread-1')?.bridgePid, process.pid);
  h.send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'busy-turn' } } });
  for (let i = 0; i < 50 && bridgeThreads(busDir).get('thread-1')?.activeTurn; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(bridgeThreads(busDir).get('thread-1')?.activeTurn, null);
  h.close();
  assert.equal(bridgeThreads(busDir).size, 0, 'closed bridge must stop advertising threads');
});

test('windows extended paths and project roots match case-insensitively', async () => {
  const { plainPath, projectFor } = await import('../lib/core.mjs');
  assert.equal(plainPath('\\\\?\\C:\\Users\\alice'), 'C:\\Users\\alice');
  assert.equal(plainPath('\\\\?\\UNC\\srv\\share'), '\\\\?\\UNC\\srv\\share');
  const roots = [['Fund', 'C:\\Users\\alice\\Desktop\\fund'], ['Mac', '/Users/alice/proj']];
  assert.equal(projectFor('\\\\?\\c:\\users\\alice\\desktop\\fund\\src', null, roots), 'Fund');
  assert.equal(projectFor('C:\\Users\\alice\\Desktop\\fundraiser', null, roots), null);
  assert.equal(projectFor('/Users/alice/proj/a', null, roots), 'Mac');
  assert.equal(projectFor('/Users/alice/PROJ/a', null, roots), null);
  assert.equal(projectFor('/x', 'Explicit', roots), 'Explicit');
});

test('stop hook continues for fresh mail once, including stop_hook_active', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-hook-'));
  const hookBus = path.join(home, 'bus'), id = 'test-stop';
  fs.mkdirSync(path.join(hookBus, 'inbox', id), { recursive: true });
  fs.writeFileSync(path.join(hookBus, 'inbox', id, 'message.json'), JSON.stringify({ at: 'now', from_name: 'peer', from: 'claude:test', content: 'new work' }));
  const env = { ...process.env, HOME: home, CODEX_HOME: path.join(home, '.codex'), AGENTBUS_DIR: hookBus };
  fs.mkdirSync(path.join(hookBus, 'bridges'));
  fs.writeFileSync(path.join(hookBus, 'bridges', '123-test.sock'), '');
  const opened = spawnSync(process.execPath, ['hooks/codex-hook.mjs'], { env: { ...env, AGENTBUS_PUSH_BRIDGE_PID: '123' }, input: JSON.stringify({ session_id: id, hook_event_name: 'SessionStart' }), encoding: 'utf8' });
  assert.equal(opened.status, 0);
  const startup = JSON.parse(opened.stdout).hookSpecificOutput.additionalContext;
  assert.match(startup, /list_agents for the full roster/);
  assert(!startup.includes('live peers'));
  assert(!startup.includes('reply with'));
  assert(startup.length < 260);
  assert(fs.existsSync(path.join(hookBus, 'inbox', id, 'message.json')), 'opening a bridged thread must leave queued mail for wakeup');
  const unbridged = spawnSync(process.execPath, ['hooks/codex-hook.mjs'], { env, input: JSON.stringify({ session_id: id, hook_event_name: 'SessionStart' }), encoding: 'utf8' });
  assert.equal(unbridged.status, 0);
  assert(fs.existsSync(path.join(hookBus, 'inbox', id, 'message.json')), 'unbridged SessionStart must not consume mail without running a turn');
  const run = () => spawnSync(process.execPath, ['hooks/codex-hook.mjs'], { env, input: JSON.stringify({ session_id: id, hook_event_name: 'Stop', stop_hook_active: true }), encoding: 'utf8' });
  const first = run(); assert.equal(first.status, 0); assert.equal(JSON.parse(first.stdout).decision, 'block');
  const next = run(); assert.equal(next.status, 0); assert.equal(next.stdout, '');
  fs.rmSync(home, { recursive: true, force: true });
});

test.after(() => fs.rmSync(bus, { recursive: true, force: true }));

test('new untouched thread metadata is published immediately and wake retains native settings', async (t) => {
  let loaded = [];
  const h = await harness(t, (m, send) => {
    if (m.method === 'thread/loaded/list') send({ id: m.id, result: { data: loaded, nextCursor: null } });
    else if (m.method === 'thread/start') {
      loaded = ['thread-1'];
      send({ id: m.id, result: { thread: { id: 'thread-1', cwd: '/untouched', turns: [] }, cwd: '/untouched', model: 'chosen-model', approvalPolicy: 'on-request', sandbox: { type: 'read-only' } } });
    } else standard(m, send);
  });
  h.input.write(JSON.stringify({ id: 42, method: 'thread/start', params: { cwd: '/untouched', model: 'chosen-model', approvalPolicy: 'on-request', sandbox: 'read-only' } }) + '\n');
  const dir = path.dirname(path.dirname(h.socketPath));
  for (let i = 0; i < 50 && !bridgeThreads(dir).has('thread-1'); i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(bridgeThreads(dir).get('thread-1')?.cwd, '/untouched');
  assert.equal(bridgeThreads(dir).get('thread-1')?.model, 'chosen-model');
  const status = await requestBridge(h.endpoint, { op: 'status', threadId: 'thread-1' });
  assert.equal(status.deliveryReady, true);
  assert.equal(status.wakeCapability, 'turn/start');
  await requestBridge(h.endpoint, request());
  assert.deepEqual(Object.keys(h.requests.find((r) => r.method === 'turn/start').params).sort(), ['clientUserMessageId', 'input', 'threadId']);
  assert.equal((await requestBridge(h.endpoint, { op: 'status', threadId: 'missing' })).unavailableReason, 'thread is not loaded in this app-server');
});

test('malformed loaded-list pagination fails closed without a turn', async (t) => {
  const h = await harness(t, (m, send) => {
    if (m.method === 'thread/loaded/list') send({ id: m.id, result: { data: [], nextCursor: 'repeat' } });
  });
  const result = await requestBridge(h.endpoint, request());
  assert.equal(result.status, 'unavailable');
  assert.match(result.error, /repeated loaded thread cursor/);
  assert(!h.requests.some((r) => r.method === 'turn/start'));
});

test('bare remote agent ids resolve uniquely and remain ambiguous across hosts', async () => {
  const { resolveTarget } = await import('../lib/core.mjs');
  const a = { id: 'lan:host-a/codex:thread-id', name: 'a' };
  const b = { id: 'lan:host-b/codex:thread-id', name: 'b' };
  assert.equal(resolveTarget('codex:thread-id', [a]).agent, a);
  assert.equal(resolveTarget('codex:thread-id', [a, b]).ok, false);
  assert.equal(resolveTarget(a.id, [a, b]).agent, a);
});

test('claude readiness requires a live authenticated relay, never session discovery alone', async (t) => {
  const { startClaudeRelay, claudeDeliveryReadiness } = await import('../lib/claude-relay.mjs');
  // macOS UNIX sockets have a 104-byte path limit; runner TMPDIR is long.
  const dir = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'ab-ready-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = { socket: '/native/inbox' };
  assert.equal(claudeDeliveryReadiness(dir, target).deliveryReady, false);
  const relay = await startClaudeRelay({ busDir: dir, sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', socketPath: target.socket, token: 'private-native-token' });
  t.after(() => relay.close());
  let ready = claudeDeliveryReadiness(dir, target);
  if (process.platform === 'win32') {
    assert.equal(ready.deliveryReady, false, 'cold ACL discovery is asynchronous, never presumed ready');
    const deadline = Date.now() + 10000;
    while (!ready.deliveryReady && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      ready = claudeDeliveryReadiness(dir, target);
    }
  }
  assert.equal(ready.deliveryReady, true);
  assert.equal(ready.wakeCapability, 'authenticated-relay');
  assert(!JSON.stringify(ready).includes('private-native-token'));
  assert.equal(claudeDeliveryReadiness(dir, { socket: '/different/inbox' }).deliveryReady, false);
  // /clear rotates session IDs while the authenticated native inbox remains valid.
  assert.equal(claudeDeliveryReadiness(dir, { ...target, sessionId: 'another' }).deliveryReady, true);
  await relay.close();
  assert.equal(claudeDeliveryReadiness(dir, target).deliveryReady, false);
});

test('core discovers untouched threads without hooks or state db and reports stale bridge readiness', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-discovery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const registry = path.join(dir, 'bus', 'bridges'); fs.mkdirSync(registry, { recursive: true });
  const b = bridgeListenPath(registry, process.pid, '0000cafe'); fs.writeFileSync(b.entry, b.listen);
  const stateFile = b.entry.replace(/\.sock$/, '.state.json');
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const state = { pid: process.pid, ready: true, at: Date.now(), loaded: [id], metadata: { [id]: { cwd: '/untouched', model: 'chosen-model' } }, active: {} };
  fs.writeFileSync(stateFile, JSON.stringify(state));
  const run = () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', "import {listCodexSessions} from './lib/core.mjs'; console.log(JSON.stringify(listCodexSessions()))"], { env: { ...process.env, HOME: dir, CODEX_HOME: path.join(dir, 'codex'), AGENTBUS_DIR: path.join(dir, 'bus') }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
  };
  let rows = run(); assert.equal(rows.length, 1);
  assert.equal(rows[0].cwd, '/untouched'); assert.equal(rows[0].model, 'chosen-model');
  assert.equal(rows[0].deliveryReady, true); assert.equal(rows[0].wakeCapability, 'turn/start');
  const records = path.join(dir, 'bus', 'codex-sessions'); fs.mkdirSync(records, { recursive: true });
  fs.writeFileSync(path.join(records, id + '.json'), JSON.stringify({ session_id: id, pid: process.pid }));
  fs.writeFileSync(stateFile, JSON.stringify({ ...state, at: Date.now() - 60000 }));
  rows = run(); assert.equal(rows[0].deliveryReady, false); assert.equal(rows[0].wakeCapability, 'hook-only');
});
