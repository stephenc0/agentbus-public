import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createLauncher, validateLaunch, claudeLaunchArgs, claudeJobId, desktopLaunch, launchEnvironment, readLaunch, writeLaunch, activeSessionCount, launcherCapabilities } from '../lib/session-launch.mjs';
import { sanitizeLaunching } from '../lib/lan-daemon.mjs';

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
  const reused = await a.launch(f.request);
  assert.equal(reused.ok, false); assert.equal(reused.state, 'corrupt'); assert.match(reused.error, /unreadable receipt/);
});
test('a zero-filled receipt (ntfs after a hard reset) reports corrupt, holds its slot, and does not block new launches', async (t) => {
  const f = fixture(t);
  const a = createLauncher({ busDir: f.bus, capabilities: () => ({ runtimes: { codex: true } }), startWorker: () => {} });
  const dir = path.join(f.bus, 'launches'); fs.mkdirSync(dir, { recursive: true });
  const dead = crypto.randomUUID(), file = path.join(dir, dead + '.json');
  fs.writeFileSync(file, Buffer.alloc(512));
  const status = await a.status(dead);
  assert.equal(status.ok, false); assert.equal(status.state, 'corrupt'); assert.equal(status.receiptFile, file); assert.match(status.error, /unreadable receipt/);
  assert.equal((await a.stop(dead)).state, 'corrupt');
  assert.equal((await a.launch(f.request)).state, 'starting');
  await assert.rejects(async () => (await a.launch({ ...f.request, id: crypto.randomUUID() })), /limit/);
  assert.equal(fs.readFileSync(file).every((b) => b === 0), true, 'corrupt receipt is left in place for inspection');
  fs.renameSync(file, file + '.corrupt-' + Date.now());
  assert.equal((await a.launch({ ...f.request, id: crypto.randomUUID() })).state, 'starting');
  assert.equal((await a.status(dead)).error, 'unknown launch id');
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')).length, 0, 'receipts are written via temp + rename, no leftovers');
});
test('a corrupt receipt from before the current boot is quarantined automatically and releases its slot; one written since boot is kept', async (t) => {
  const f = fixture(t); let calls = 0;
  const bootAt = Date.now() - 60_000;
  const a = createLauncher({ busDir: f.bus, capabilities: () => ({ runtimes: { codex: true } }), startWorker: () => { calls++; }, bootAt: () => bootAt });
  const dir = path.join(f.bus, 'launches'); fs.mkdirSync(dir, { recursive: true });
  const stale = (id) => { const file = path.join(dir, id + '.json'); fs.writeFileSync(file, Buffer.alloc(512)); const before = new Date(bootAt - 600_000); fs.utimesSync(file, before, before); return file; };
  const dead = crypto.randomUUID(), file = stale(dead);
  const s = await a.status(dead);
  assert.equal(s.ok, false); assert.equal(s.state, 'corrupt'); assert.match(s.error, /before the current boot/); assert.match(s.note, /slot released/);
  assert.equal(fs.existsSync(file), false, 'quarantined receipt is moved aside');
  assert.match(s.receiptFile, /\.json\.corrupt-\d{8}T\d{6}$/); assert.equal(fs.existsSync(s.receiptFile), true);
  assert.equal(fs.readFileSync(s.receiptFile).every((b) => b === 0), true, 'moved aside intact for inspection');
  assert.equal((await a.status(dead)).error, 'unknown launch id');
  // the quarantined id itself fails closed on reuse and does not spawn
  const reused = crypto.randomUUID(); stale(reused);
  assert.equal((await a.launch({ ...f.request, id: reused })).state, 'corrupt'); assert.equal(calls, 0);
  // slots released: the policy allows two, both are available
  assert.equal((await a.launch(f.request)).state, 'starting');
  assert.equal((await a.launch({ ...f.request, id: crypto.randomUUID() })).state, 'starting'); assert.equal(calls, 2);
  // a corrupt receipt written since boot is evidence and stays put
  const fresh = crypto.randomUUID(), freshFile = path.join(dir, fresh + '.json'); fs.writeFileSync(freshFile, Buffer.alloc(16));
  const kept = await a.status(fresh);
  assert.equal(kept.state, 'corrupt'); assert.equal(kept.receiptFile, freshFile); assert.equal(fs.existsSync(freshFile), true);
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')).length, 0);
});
test('worker receipt updates are fsynced before the rename publishes them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-fsync-')); const file = path.join(dir, 'r.json');
  const original = fs.fsyncSync; let synced = 0; fs.fsyncSync = (fd) => { synced++; return original(fd); };
  try { writeLaunch(file, { a: 1 }); } finally { fs.fsyncSync = original; fs.rmSync(dir, { recursive: true, force: true }); }
  assert.ok(synced >= 1, 'writeLaunch fsyncs the receipt');
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

test('a crashing claude launch reports not ok with its crash evidence and still holds a session slot', async (t) => {
  const f = fixture(t);
  const a = createLauncher({ busDir: f.bus, capabilities: () => ({ runtimes: { codex: true, 'claude-code': true } }), startWorker: () => {} });
  const crashed = { ...f.request, id: crypto.randomUUID(), runtime: 'claude-code' };
  await a.launch(crashed);
  const file = path.join(f.bus, 'launches', crashed.id + '.json');
  writeLaunch(file, { ...readLaunch(file), state: 'crashing', nativeJobId: 'abc12345', workerPid: process.pid, crash: { evidence: ['worker crashed: SIGKILL (137), respawning'], respawns: 1, lastExitCode: 137 }, nativeLogTail: 'worker crashed: SIGKILL (137), respawning', error: 'native worker is crashing' });
  const s = await a.status(crashed.id);
  assert.equal(s.ok, false); assert.equal(s.state, 'crashing'); assert.equal(s.crash.lastExitCode, 137); assert.match(s.nativeLogTail, /SIGKILL/);
  await a.launch({ ...f.request, id: crypto.randomUUID() });
  await assert.rejects(a.launch({ ...f.request, id: crypto.randomUUID() }), /session limit/, 'the crash-looping job still counts toward maxSessions');
});

test('spawn claims are validated, frozen in the receipt and its hash, and reported by status', async (t) => {
  const f = fixture(t);
  const a = createLauncher({ busDir: f.bus, capabilities: () => ({ runtimes: { codex: true, 'claude-code': true, 'claude-desktop': true } }), startWorker: () => {} });
  const request = { ...f.request, claims: ['gpu', 'gpu'] };
  const first = await a.launch(request);
  assert.equal(first.state, 'starting'); assert.deepEqual(first.claims, ['gpu']);
  assert.deepEqual(readLaunch(path.join(f.bus, 'launches', request.id + '.json')).request.claims, ['gpu']);
  assert.equal((await a.launch(request)).state, 'starting', 'identical retry is idempotent');
  assert.match((await a.launch({ ...request, claims: ['cpu'] })).error, /reused with different contents/);
  assert.deepEqual((await a.launch({ ...f.request, id: crypto.randomUUID() })).claims, [], 'no claims is the default');
  assert.throws(() => validateLaunch({ ...f.request, claims: 'gpu' }, f.policy), /claims must be an array/);
  assert.throws(() => validateLaunch({ ...f.request, claims: ['GPU!'] }, f.policy), /lowercase/);
  assert.throws(() => validateLaunch({ ...f.request, runtime: 'claude-desktop', claims: ['gpu'] }, f.policy), /desktop handoff has no job/);
  assert.equal(validateLaunch({ ...f.request, claims: [] }, f.policy).claims, undefined);
});

test('stale receipts stop counting toward maxSessions; the host owner can list and close them', async (t) => {
  const f = fixture(t); writeLaunch(path.join(f.bus, 'launch-config.json'), { ...f.policy, maxSessions: 1 });
  const { STALE_AFTER_MS } = await import('../lib/launch-jobs.mjs');
  const old = Date.now() - STALE_AFTER_MS - 60000;
  // the metis2 runner shape: claude-code, worker gone, native inventory still says blocked days later, no stop ever landed.
  // the receipt already carries the reconcile verdict, so a reconcile that changes nothing must not rewrite it.
  const sid = '12345678-1234-4234-8234-123456789abc';
  const a = createLauncher({ busDir: f.bus, registrationGraceMs: 0, inventory: async () => ({ ok: true, jobs: [{ kind: 'background', sessionId: sid, state: 'blocked' }] }), capabilities: () => ({ runtimes: { codex: true, 'claude-code': true } }), startWorker: (file, r) => writeLaunch(file, { ...r, state: 'awaiting_registration', nativeState: 'blocked', error: null, note: 'native job remains active or blocked; reservation retained', workerPid: 2147483647, nativeJobId: '12345678', agentId: 'claude:' + sid, updatedAt: old }) });
  const blocked = { ...f.request, runtime: 'claude-code' };
  await a.launch(blocked);
  const s = await a.status(blocked.id);
  assert.match(s.stale, /native job blocked for \d+h/); assert.equal(s.state, 'awaiting_registration');
  const file = path.join(f.bus, 'launches', blocked.id + '.json');
  assert.equal(readLaunch(file).updatedAt, old, 'an unchanged reconcile does not refresh updatedAt');
  const b = createLauncher({ busDir: f.bus, capabilities: () => ({ runtimes: { codex: true } }), startWorker: () => {} });
  const freshLaunch = await b.launch({ ...f.request, id: crypto.randomUUID() });
  assert.equal(freshLaunch.state, 'starting', 'the stale slot is free'); const fresh = freshLaunch.requestId;
  const stale = a.stale();
  assert.equal(stale.length, 1); assert.equal(stale[0].requestId, blocked.id); assert.equal(stale[0].nativeState, 'blocked'); assert.match(stale[0].reason, /blocked/);
  assert.equal(a.close(crypto.randomUUID()).ok, false);
  await assert.rejects(b.launch({ ...f.request, id: crypto.randomUUID() }), /limit/);
  assert.match(a.close(fresh).error, /not stale yet/);
  const closed = a.close(blocked.id);
  assert.equal(closed.ok, true); assert.equal(closed.state, 'stopped'); assert.match(closed.note, /termination unverified/);
  assert.equal(readLaunch(file).state, 'stopped'); assert.match(readLaunch(file).note, /closed by host owner reconcile/);
  assert.equal(a.close(blocked.id).note, 'already closed');
  assert.deepEqual(a.stale(), []);
  // a dead codex supervisor whose runtime is gone past the window is stale too; a fresh one is not (existing rule)
  const codexFile = path.join(f.bus, 'launches', crypto.randomUUID() + '.json');
  writeLaunch(codexFile, { hash: 'x', source: 'local', request: { id: path.basename(codexFile, '.json'), runtime: 'codex', cwd: f.cwd, prompt: 'p' }, state: 'running', workerPid: 2147483647, runtimePid: 2147483646, createdAt: old, updatedAt: old });
  assert.match(a.stale()[0].reason, /codex runtime gone/);
  writeLaunch(codexFile, { ...readLaunch(codexFile), updatedAt: Date.now() });
  assert.deepEqual(a.stale(), []);
});

test('activeSessions publishes the slot count the limit check enforces, read-only', async (t) => {
  const f = fixture(t), dir = path.join(f.bus, 'launches');
  const { STALE_AFTER_MS } = await import('../lib/launch-jobs.mjs');
  let discoveries = 0; const agents = [];
  const listLocal = () => { discoveries++; return agents; };
  const a = createLauncher({ busDir: f.bus, listLocal, capabilities: () => ({ runtimes: { codex: true } }), startWorker: () => {} });
  const count = () => activeSessionCount(f.bus, { listLocal });
  assert.equal(count(), 0); assert.equal(a.snapshot().activeSessions, 0); assert.equal(a.snapshot().maxSessions, 2);
  await a.launch(f.request); assert.equal(count(), 1);
  await a.launch({ ...f.request, id: crypto.randomUUID() }); assert.equal(count(), 2);
  await assert.rejects(a.launch({ ...f.request, id: crypto.randomUUID() }), /limit/);
  assert.equal(count(), f.policy.maxSessions, 'full means full on both sides');
  const file = path.join(dir, f.request.id + '.json');
  writeLaunch(file, { ...readLaunch(file), state: 'failed' }); assert.equal(count(), 1, 'failed releases');
  // an uncertain receipt (the studio case) holds a slot, as it does at spawn time
  writeLaunch(file, { ...readLaunch(file), state: 'uncertain' }); assert.equal(count(), 2);
  writeLaunch(file, { ...readLaunch(file), state: 'stopped' }); assert.equal(count(), 1);
  // stale: dead worker, native job blocked past the window. free unless its session is still discovered
  const sid = '12345678-1234-4234-8234-123456789abc', old = Date.now() - STALE_AFTER_MS - 60000;
  const staleFile = path.join(dir, crypto.randomUUID() + '.json');
  writeLaunch(staleFile, { hash: 'x', source: 'local', request: { id: path.basename(staleFile, '.json'), runtime: 'claude-code', cwd: f.cwd, prompt: 'p' }, state: 'awaiting_registration', nativeState: 'blocked', workerPid: 2147483647, nativeJobId: '12345678', agentId: 'claude:' + sid, createdAt: old, updatedAt: old });
  discoveries = 0; assert.equal(count(), 1, 'stale receipt holds no slot'); assert.equal(discoveries, 1, 'discovery runs once, only because a receipt was otherwise stale');
  agents.push({ id: 'claude:' + sid, kind: 'claude' }); assert.equal(count(), 2, 'a discovered session is never stale');
  agents.length = 0; fs.rmSync(staleFile);
  discoveries = 0; count(); assert.equal(discoveries, 0, 'no stale receipt, no discovery');
  // corrupt: since boot holds its slot; from before boot is skipped and NOT moved (the launcher quarantines, capabilities only read)
  const freshCorrupt = path.join(dir, crypto.randomUUID() + '.json'); fs.writeFileSync(freshCorrupt, Buffer.alloc(16));
  assert.equal(count(), 2);
  const bootAt = Date.now() - 60_000, before = new Date(bootAt - 600_000); fs.utimesSync(freshCorrupt, before, before);
  const listing = () => fs.readdirSync(dir).sort().map((n) => [n, fs.statSync(path.join(dir, n)).mtimeMs]);
  const snap = listing();
  assert.equal(activeSessionCount(f.bus, { listLocal, bootAt }), 1);
  assert.deepEqual(listing(), snap, 'counting renames, rewrites and touches nothing');
  // and the spawn-time check agrees once it quarantines that file itself
  const b = createLauncher({ busDir: f.bus, listLocal, capabilities: () => ({ runtimes: { codex: true } }), startWorker: () => {}, bootAt: () => bootAt });
  assert.equal((await b.launch({ ...f.request, id: crypto.randomUUID() })).state, 'starting');
  assert.equal(activeSessionCount(f.bus, { listLocal, bootAt }), 2);
  await assert.rejects(b.launch({ ...f.request, id: crypto.randomUUID() }), /limit/);
  assert.equal(activeSessionCount(path.join(f.bus, 'nope')), 0, 'no launches dir yet');
  assert.equal(launcherCapabilities(f.bus).activeSessions, 2);
});

test('peer launch capabilities: activeSessions is a non-negative integer or null, the rest passes through', () => {
  assert.deepEqual(sanitizeLaunching({ maxSessions: 4, activeSessions: 3, roots: ['G:\\x'] }), { maxSessions: 4, activeSessions: 3, roots: ['G:\\x'] });
  for (const v of [undefined, -1, 1.5, '2', 5000, null]) assert.equal(sanitizeLaunching({ maxSessions: 4, activeSessions: v }).activeSessions, null, String(v));
  assert.equal(sanitizeLaunching(undefined), null); assert.equal(sanitizeLaunching([1]), null);
});
