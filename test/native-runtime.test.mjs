import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeProbe, stopClaudeJob, claudeJobExited, matchClaudeJob } from '../lib/native-runtime.mjs';

test('probe snapshots never block, concurrent refresh deduplicates and failures expire', async () => {
  let now = 0, calls = 0, succeed = false, release;
  const gate = new Promise((r) => { release = r; });
  const probe = createRuntimeProbe({ now: () => now, failureTtlMs: 100, run: async (_binary, args) => { calls++; await gate; return { ok: succeed, stdout: args[0] === '--help' ? 'app-server' : '1.0', error: 'cold start' }; } });
  assert.equal(probe.snapshot('/fake/codex', 'codex').state, 'probing');
  const first = probe.refresh('/fake/codex', 'codex');
  assert.equal(calls, 2); release();
  assert.equal((await first).available, false);
  succeed = true;
  assert.equal((await probe.refresh('/fake/codex', 'codex')).available, false);
  now = 101;
  assert.equal((await probe.refresh('/fake/codex', 'codex')).available, true);
  assert.equal(calls, 4);
});

test('native done with a live pid and pidless blocked are not exits', () => {
  assert.equal(claudeJobExited({ state: 'done', pid: process.pid }), false);
  assert.equal(claudeJobExited({ state: 'blocked' }), false);
  assert.equal(claudeJobExited({ state: 'working' }), false);
  assert.equal(claudeJobExited({ state: 'done' }), true);
  assert.equal(claudeJobExited({ state: 'stopped' }), true);
  assert.equal(claudeJobExited(null), true);
});

test('stop uses the recorded job id without discovery and requires native exit evidence', async () => {
  const record = { nativeJobId: '12345678', binary: '/fake/claude', request: { cwd: '/tmp' } };
  let stopped = false, calls = [];
  const jobs = [{ kind: 'background', sessionId: '12345678-1234-4234-8234-123456789abc', state: 'done', pid: 42 }];
  const inventory = async () => ({ ok: true, jobs: stopped ? [{ ...jobs[0], pid: undefined }] : jobs });
  const run = async (_binary, args) => { calls.push(args); stopped = true; return { ok: true }; };
  assert.equal((await stopClaudeJob(record, { inventory, run })).ok, true);
  assert.deepEqual(calls, [['stop', '12345678']]);
  assert.equal((await stopClaudeJob(record, { inventory, run })).ok, true);
  assert.equal(calls.length, 1);
  const failure = await stopClaudeJob(record, { inventory: async () => ({ ok: false }), run: async () => ({ ok: false, stderr: 'permission denied' }) });
  assert.equal(failure.ok, false); assert.equal(failure.error, 'permission denied');
  assert.equal(matchClaudeJob(jobs.concat({ ...jobs[0], sessionId: '12345678-0000-4000-8000-000000000000' }), record).ambiguous, true);
});

test('termination cleans owned descendants after their POSIX leader already exited', { skip: process.platform === 'win32', timeout: 7000 }, async () => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const { terminateChild, processAlive } = await import('../lib/native-runtime.mjs');
  const leader = spawn(process.execPath, ['-e', `const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(c.pid); c.unref();`], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let output = ''; leader.stdout.on('data', (chunk) => { output += chunk; });
  await once(leader, 'close');
  const descendant = Number(output.trim());
  try {
    assert.equal(leader.exitCode, 0);
    assert(descendant > 0 && processAlive(descendant), 'test descendant survived the leader');
    await terminateChild(leader);
    assert.equal(processAlive(descendant), false, 'all owned descendants are gone before success');
  } finally { try { process.kill(-leader.pid, 'SIGKILL'); } catch {} }
});

test('windows exited leader cannot certify descendant cleanup', { skip: process.platform !== 'win32' }, async () => {
  const { terminateChild } = await import('../lib/native-runtime.mjs');
  await assert.rejects(terminateChild({ pid: 12345, exitCode: 0, signalCode: null }), /descendant termination cannot be verified/);
});

test('replacing the runtime binary or switching paths invalidates successful probes immediately', async (t) => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-probe-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = path.join(dir, 'first'), second = path.join(dir, 'second');
  fs.writeFileSync(first, 'one'); fs.writeFileSync(second, 'two');
  let calls = 0;
  const probe = createRuntimeProbe({ run: async () => { calls++; return { ok: true, stdout: 'app-server' }; } });
  await probe.refresh(first, 'codex'); await probe.refresh(first, 'codex'); assert.equal(calls, 2);
  fs.writeFileSync(first, 'replacement-longer');
  await probe.refresh(first, 'codex'); assert.equal(calls, 4);
  await probe.refresh(second, 'codex'); assert.equal(calls, 6);
});

test('fresh missing inventory does not turn a failed native stop into success', async () => {
  const record = { createdAt: Date.now(), nativeJobId: '12345678', binary: '/fake/claude', request: { cwd: '/tmp' } };
  let stops = 0;
  const result = await stopClaudeJob(record, { inventory: async () => ({ ok: true, jobs: [] }), run: async () => { stops++; return { ok: false, stderr: 'not registered yet' }; } });
  assert.equal(stops, 1); assert.equal(result.ok, false);
});

test('windows tree cleanup requires identity-scoped helper evidence, never localized taskkill prose', async () => {
  const { terminateWindowsChild } = await import('../lib/native-runtime.mjs');
  const child = { pid: 12345, exitCode: null, signalCode: null };
  let calls = 0;
  const run = async (_binary, args) => {
    calls++;
    assert(args.includes('-SupervisorPid')); assert(args.includes(String(process.pid))); assert(args.includes('-LeaderPid'));
    return { ok: true, stdout: JSON.stringify({ ok: true, leaderPid: child.pid, killed: [child.pid, 23456], survivors: [] }) };
  };
  await terminateWindowsChild(child, { run }); assert.equal(calls, 1);
  for (const value of [null, { ok: true }, { ok: true, leaderPid: child.pid, killed: [], survivors: [] }, { ok: true, leaderPid: child.pid, killed: [child.pid], survivors: [23456] }]) {
    await assert.rejects(terminateWindowsChild(child, { run: async () => ({ ok: true, stdout: JSON.stringify(value) }) }), /unconfirmed/);
  }
  await assert.rejects(terminateWindowsChild({ ...child, exitCode: 0 }, { run }), /leader already exited/);
  assert.equal(calls, 1);
});

test('pidless failed native jobs are terminal without treating live or uncertain states as exits', async () => {
  for (const state of ['done', 'stopped', 'failed']) {
    assert.equal(claudeJobExited({ state }), true);
    assert.equal(claudeJobExited({ state, pid: process.pid }), false);
    assert.equal(claudeJobExited({ state, ambiguous: true }), false);
  }
  for (const state of ['blocked', 'working', 'unknown', 'future-state', undefined]) assert.equal(claudeJobExited({ state }), false);
  const job = { kind: 'background', sessionId: '12345678-1234-4234-8234-123456789abc', state: 'failed' };
  const record = { nativeJobId: '12345678', binary: '/fake/claude', request: { cwd: '/tmp' } };
  const inventory = async () => ({ ok: true, jobs: [job] });
  assert.equal((await stopClaudeJob(record, { inventory, run: async () => { assert.fail('already failed job needs no native stop'); } })).ok, true);
});
