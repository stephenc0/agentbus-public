import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createLauncher, validateLaunch, claudeLaunchArgs, claudeJobId, desktopLaunch, launchEnvironment, readLaunch, writeLaunch } from '../lib/session-launch.mjs';

function fixture(t) {
  const bus = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-spawn-'));
  const cwd = path.join(bus, 'work'); fs.mkdirSync(cwd);
  const policy = { enabled: true, remote: true, roots: [cwd], maxSessions: 2, runtimes: { codex: process.execPath, claude: process.execPath } };
  writeLaunch(path.join(bus, 'launch-config.json'), policy);
  t.after(() => fs.rmSync(bus, { recursive: true, force: true }));
  const request = { id: crypto.randomUUID(), cwd, runtime: 'codex', prompt: 'test' };
  return { bus, cwd, policy, request };
}
test('launches are durable and retries do not create duplicate workers, including after restart', async (t) => {
  const f = fixture(t); let calls = 0;
  const opts = { busDir: f.bus, capabilities: () => ({ runtimes: { codex: true } }), startWorker: () => { calls++; } };
  const a = createLauncher(opts);
  assert.equal((await a.launch(f.request)).state, 'starting');
  assert.equal((await a.launch(f.request)).state, 'starting');
  assert.equal((await createLauncher(opts).launch(f.request)).state, 'starting');
  assert.equal(calls, 1);
  assert.equal((await a.launch({ ...f.request, prompt: 'different' })).ok, false);
  assert.equal((await a.launch(f.request, 'different-host')).ok, false);
  assert.equal(calls, 1);
});
test('workspace policy rejects prefix siblings, traversal, symlinks and disabled remote spawning', async (t) => {
  const f = fixture(t);
  const sibling = path.join(f.bus, 'work-other'); fs.mkdirSync(sibling);
  for (const cwd of [f.bus, sibling, path.join(f.cwd, '..'), 'relative']) assert.throws(() => validateLaunch({ ...f.request, cwd }, f.policy));
  fs.symlinkSync(sibling, path.join(f.cwd, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => validateLaunch({ ...f.request, cwd: path.join(f.cwd, 'escape') }, f.policy), /outside/);
  writeLaunch(path.join(f.bus, 'launch-config.json'), { ...f.policy, remote: false });
  await assert.rejects(async () => (await createLauncher({ busDir: f.bus }).launch(f.request, 'remote')), /remote launching is disabled/);
});
test('unresolved launches consume quota; failed launches release it; unreadable receipts fail closed', async (t) => {
  const f = fixture(t);
  const a = createLauncher({ busDir: f.bus, capabilities: () => ({ runtimes: { codex: true } }), startWorker: () => {} });
  (await a.launch(f.request)); (await a.launch({ ...f.request, id: crypto.randomUUID() }));
  await assert.rejects(async () => (await a.launch({ ...f.request, id: crypto.randomUUID() })), /limit/);
  const file = path.join(f.bus, 'launches', f.request.id + '.json');
  writeLaunch(file, { ...readLaunch(file), state: 'failed' });
  assert.equal((await a.launch({ ...f.request, id: crypto.randomUUID() })).state, 'starting');
  fs.writeFileSync(file, '{bad');
  await assert.rejects(async () => (await a.launch(f.request)));
});
test('native desktop/background commands preserve prompt as data, and sessions never inherit identity tokens', () => {
  const request = { runtime: 'claude-code', model: 'test-model', name: 'test name', prompt: '--dangerously-skip-permissions $(echo unsafe)' };
  const args = claudeLaunchArgs(request, crypto.randomUUID());
  assert.equal(args[0], '--bg'); assert.equal(args.at(-2), '--'); assert.equal(args.at(-1), request.prompt);
  assert(!args.includes('--session-id'));
  assert.equal(claudeJobId('backgrounded · b185c39f · test\n  claude agents'), 'b185c39f');
  assert.equal(claudeJobId('Workspace not trusted'), null);
  const desktop = { prompt: 'hello & $(evil) "quote"', cwd: 'C:\\task path' };
  const mac = desktopLaunch(desktop, 'darwin'); assert.equal(new URL(mac.args[0]).searchParams.get('q'), desktop.prompt);
  const win = desktopLaunch(desktop, 'win32'); assert(!win.args.join(' ').includes(desktop.prompt)); assert.equal(new URL(win.env.AGENTBUS_DESKTOP_URL).searchParams.get('folder'), desktop.cwd);
  assert.deepEqual(launchEnvironment({ PATH: 'path', CLAUDE_CODE_MESSAGING_TOKEN: 'secret', CLAUDE_CODE_MESSAGING_SOCKET: 'socket', CLAUDECODE: '1', CODEX_THREAD_ID: 'old', AGENTBUS_SELF: 'old', AGENTBUS_PUSH_BRIDGE_PID: '123' }), { PATH: 'path' });
  assert.deepEqual(launchEnvironment({ CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_SESSION_ID: 'old', CLAUDE_CODE_ENTRYPOINT: 'cli' }), { CLAUDE_CODE_USE_BEDROCK: '1' });
});
test('remote receipt access and stopping are restricted to the original sender; stop prevents restart', async (t) => {
  const f = fixture(t), source = 'host/agent';
  const a = createLauncher({ busDir: f.bus, capabilities: () => ({ runtimes: { codex: true } }), startWorker: () => {} });
  (await a.launch(f.request, source));
  assert.equal((await a.status(f.request.id, 'other')).ok, false);
  assert.equal((await a.stop(f.request.id, 'other')).ok, false);
  assert.equal((await a.stop(f.request.id, source)).ok, true);
  assert.equal((await a.launch(f.request, source)).state, 'stopping');
  const file = path.join(f.bus, 'launches', f.request.id + '.json');
  writeLaunch(file, { ...readLaunch(file), state: 'stopped' });
  assert.equal((await a.launch(f.request, source)).state, 'stopped');
});
test('native claude short job ids resolve uniquely to the real session, not a requested UUID', async (t) => {
  const f = fixture(t), id = 'b185c39f-b252-48b1-b320-d615b7f48cb0';
  let live = [{ id: 'claude:' + id, kind: 'claude' }];
  const a = createLauncher({ busDir: f.bus, listLocal: () => live, capabilities: () => ({ runtimes: { codex: true } }), startWorker: (file, r) => writeLaunch(file, { ...r, nativeJobId: 'b185c39f', state: 'awaiting_registration' }) });
  assert.equal((await a.launch(f.request)).agentId, 'claude:' + id);
  live.push({ id: 'claude:b185c39f-0000-0000-0000-000000000000', kind: 'claude' });
  assert.equal((await a.status(f.request.id)).routable, false);
});
test('launcher success does not falsely claim routability; native discovery confirms it', async (t) => {
  const f = fixture(t); let live = [];
  const agentId = 'codex:' + crypto.randomUUID();
  const a = createLauncher({ busDir: f.bus, capabilities: () => ({ runtimes: { codex: true } }), listLocal: () => live, startWorker: (file, record) => writeLaunch(file, { ...record, agentId, state: 'awaiting_registration' }) });
  assert.equal((await a.launch(f.request)).routable, false);
  live = [{ id: agentId, model: 'confirmed-model' }];
  assert.equal((await a.status(f.request.id)).routable, true); assert.equal((await a.status(f.request.id)).model, 'confirmed-model');
});

test('legacy claude receipts reconcile confirmed exits and preserve blocked jobs or unknown inventory', async (t) => {
  const f = fixture(t); f.policy.maxSessions = 1; writeLaunch(path.join(f.bus, 'launch-config.json'), f.policy);
  let jobs = [{ kind: 'background', sessionId: '12345678-1234-4234-8234-123456789abc', state: 'blocked' }], available = true;
  const a = createLauncher({ busDir: f.bus, registrationGraceMs: 0, capabilities: () => ({ runtimes: { 'claude-code': true } }), inventory: async () => available ? { ok: true, jobs } : { ok: false }, startWorker: (file, record) => writeLaunch(file, { ...record, state: 'awaiting_registration', nativeJobId: '12345678' }) });
  const request = { ...f.request, runtime: 'claude-code' };
  await a.launch(request);
  assert.equal((await a.status(request.id)).nativeState, 'blocked');
  await assert.rejects(a.launch({ ...request, id: crypto.randomUUID() }), /limit/);
  available = false;
  assert.equal((await a.status(request.id)).state, 'uncertain');
  await assert.rejects(a.launch({ ...request, id: crypto.randomUUID() }), /limit/);
  available = true; jobs = [{ ...jobs[0], state: 'done', pid: process.pid }];
  assert.equal((await a.status(request.id)).state, 'awaiting_registration');
  jobs = [{ ...jobs[0], pid: undefined }];
  assert.equal((await a.status(request.id)).state, 'stopped');
  assert.equal(readLaunch(path.join(f.bus, 'launches', request.id + '.json')).state, 'stopped');
  assert.equal((await a.launch({ ...request, id: crypto.randomUUID() })).ok, true);
});

test('legacy stop uses native job id despite absent discovery; failed stop retains reservation', async (t) => {
  const f = fixture(t); let stops = 0, succeeds = false;
  const a = createLauncher({ busDir: f.bus, capabilities: () => ({ runtimes: { 'claude-code': true } }), nativeStop: async (r) => { assert.equal(r.nativeJobId, '12345678'); stops++; return { ok: succeeds, error: 'blocked stop' }; }, startWorker: (file, r) => writeLaunch(file, { ...r, state: 'awaiting_registration', nativeJobId: '12345678' }) });
  const request = { ...f.request, runtime: 'claude-code' };
  await a.launch(request);
  assert.equal((await a.stop(request.id)).ok, false); assert.equal(stops, 1);
  assert.notEqual((await a.status(request.id)).state, 'stopped');
  succeeds = true;
  assert.equal((await a.stop(request.id)).state, 'stopped');
  assert.equal((await a.stop(request.id)).state, 'stopped'); assert.equal(stops, 2);
});

test('concurrent identical launches wait for the lock and start one worker', async (t) => {
  const f = fixture(t); let starts = 0;
  const a = createLauncher({ busDir: f.bus, capabilities: async () => { await new Promise((r) => setTimeout(r, 100)); return { runtimes: { codex: true } }; }, startWorker: () => { starts++; } });
  const results = await Promise.all([a.launch(f.request), a.launch(f.request)]);
  assert.equal(starts, 1); assert(results.every((r) => r.ok));
});

test('dead supervisor cannot claim to stop a surviving codex runtime', async (t) => {
  const f = fixture(t), agentId = 'codex:' + crypto.randomUUID();
  const a = createLauncher({ busDir: f.bus, listLocal: () => [{ id: agentId }], capabilities: () => ({ runtimes: { codex: true } }), startWorker: (file, r) => writeLaunch(file, { ...r, state: 'running', agentId, runtimePid: process.pid }) });
  await a.launch(f.request);
  const result = await a.stop(f.request.id);
  assert.equal(result.ok, false); assert.equal(result.state, 'uncertain');
  assert.equal(readLaunch(path.join(f.bus, 'launches', f.request.id + '.json')).state, 'running');
});

test('dead codex supervisors retain quota even when the runtime leader disappeared', async (t) => {
  const f = fixture(t); writeLaunch(path.join(f.bus, 'launch-config.json'), { ...f.policy, maxSessions: 1 });
  const a = createLauncher({ busDir: f.bus, capabilities: () => ({ runtimes: { codex: true } }), startWorker: (file, r) => writeLaunch(file, { ...r, state: 'running', runtimePid: 2147483647 }) });
  assert.equal((await a.launch(f.request)).state, 'uncertain');
  await assert.rejects(a.launch({ ...f.request, id: crypto.randomUUID() }), /limit/);
  assert.equal((await a.stop(f.request.id)).state, 'uncertain');
  assert.equal(readLaunch(path.join(f.bus, 'launches', f.request.id + '.json')).state, 'running');
});

test('receipt persistence failures remain actionable uncertainty until the owner clears the marker', async (t) => {
  const f = fixture(t);
  const a = createLauncher({ busDir: f.bus, capabilities: () => ({ runtimes: { codex: true } }), startWorker: () => {} });
  await a.launch(f.request);
  const marker = path.join(f.bus, 'launches', f.request.id + '.json.persistence-error');
  fs.writeFileSync(marker, JSON.stringify({ code: 'EPERM', at: Date.now(), workerPid: process.pid }));
  const status = await a.status(f.request.id);
  assert.equal(status.ok, false); assert.equal(status.state, 'uncertain'); assert.equal(status.receiptStale, true); assert.equal(status.persistenceError.code, 'EPERM');
  fs.rmSync(marker);
  assert.equal((await a.status(f.request.id)).state, 'starting');
});

test('quota check reconciles dead-worker failed Claude receipts without prior status polling', async (t) => {
  const f = fixture(t);
  writeLaunch(path.join(f.bus, 'launch-config.json'), { ...f.policy, maxSessions: 1 });
  const sid = '12345678-1234-4234-8234-123456789abc';
  let job = { kind: 'background', sessionId: sid, state: 'working' }, starts = 0;
  const a = createLauncher({
    busDir: f.bus, registrationGraceMs: 0,
    capabilities: () => ({ runtimes: { 'claude-code': true } }),
    inventory: async () => ({ ok: true, jobs: [job] }),
    startWorker: (file, record) => {
      starts++;
      writeLaunch(file, { ...record, state: 'awaiting_registration', workerPid: 2147483647, nativeJobId: '12345678', agentId: 'claude:' + sid });
    },
  });
  const request = { ...f.request, runtime: 'claude-code' };
  await a.launch(request);
  job = { ...job, state: 'failed', pid: process.pid };
  await assert.rejects(a.launch({ ...request, id: crypto.randomUUID() }), /limit/);
  job = { ...job, pid: undefined };
  // No status()/stop() on the old receipt: launch's own quota reconciliation must recover it.
  assert.equal((await a.launch({ ...request, id: crypto.randomUUID() })).ok, true);
  assert.equal(starts, 2);
  const old = readLaunch(path.join(f.bus, 'launches', request.id + '.json'));
  assert.equal(old.state, 'stopped'); assert.equal(old.nativeState, 'failed');
  const status = await a.status(request.id);
  assert.equal(status.state, 'stopped'); assert.equal(status.nativeState, 'failed'); assert.equal(status.workerAlive, false);
  assert.equal((await a.stop(request.id)).state, 'stopped');
});

test('a configured runtime that disappeared (claude auto-update) falls back to discovery instead of failing launches', async () => {
  const { runtimePath } = await import('../lib/session-launch.mjs');
  assert.equal(runtimePath({ runtimes: { codex: process.execPath } }, 'codex'), process.execPath);
  const missing = path.join(os.tmpdir(), `agentbus-gone-${crypto.randomUUID()}`, 'versions', '2.1.0');
  const resolved = runtimePath({ runtimes: { claude: missing } }, 'claude');
  assert.notEqual(resolved, undefined);
  if (resolved !== missing) fs.accessSync(resolved, fs.constants.X_OK); // discovered a real launcher on this machine
});
