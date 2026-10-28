import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { classifyClaudeLog, sanitizeLogTail, claudeJobLogs } from '../lib/native-runtime.mjs';

test('crash classifier recognizes worker crash loops and ignores ordinary startup output', () => {
  const crash = classifyClaudeLog('starting session\nworker crashed: SIGKILL (137), respawning\nworker crashed: SIGKILL (137), respawning');
  assert.equal(crash.crashing, true); assert.equal(crash.lastExitCode, 137); assert.equal(crash.respawns, 2);
  assert.equal(classifyClaudeLog('child exited with code 139').lastExitCode, 139);
  assert.equal(classifyClaudeLog('Out of memory: worker killed').crashing, true);
  for (const benign of ['reading README.md\nall good', 'ran 137 tests', 'exit code 0', 'the crashpad handler started']) assert.equal(classifyClaudeLog(benign).crashing, false, benign);
});

test('log tails drop terminal escapes and control bytes and stay bounded', () => {
  const tail = sanitizeLogTail('\x1b[31mred\x1b[0m line\r\nnext\x07\n' + 'x\n'.repeat(100), { lines: 5 });
  assert.equal(tail.split('\n').length, 5); assert.doesNotMatch(tail, /\x1b|\x07|\r/);
  assert.equal(sanitizeLogTail('a'.repeat(5000)).length, 2000);
});

test('native logs only accept a native job id', async () => {
  let called = false;
  const r = await claudeJobLogs('/x/claude', '/tmp', '../../etc', { run: async () => { called = true; return { ok: true, stdout: '' }; } });
  assert.equal(r.ok, false); assert.equal(called, false);
});

function fakeClaude(dir, { logs }) {
  const runtime = path.join(dir, 'fake-claude');
  const registered = path.join(dir, 'registered'), stopped = path.join(dir, 'native-stopped');
  fs.writeFileSync(runtime, `#!${process.execPath}
const fs=require('node:fs');
const sid='abc12345-0000-4000-8000-000000000000', stopped=${JSON.stringify(stopped)}, registered=${JSON.stringify(registered)};
const a=process.argv.slice(2);
if(a.includes('--bg')) console.log('backgrounded · abc12345 · fake');
else if(a[0]==='stop') { fs.writeFileSync(stopped,''); console.log('stopped abc12345'); }
else if(a[0]==='logs') console.log(${JSON.stringify(logs)});
else if(a[0]==='agents') { const done=fs.existsSync(stopped), reg=fs.existsSync(registered);
  console.log(JSON.stringify([{kind:'background',id:'abc12345',sessionId:sid,cwd:${JSON.stringify(dir)},state:done?'stopped':'working',...(!done&&reg?{pid:process.ppid}:{})}])); }
`, { mode: 0o700 });
  return { runtime, registered };
}
async function supervise(t, logs, env = {}) {
  const dir = fs.mkdtempSync(path.join('/tmp', 'ab-claude-crash-'));
  const launches = path.join(dir, 'launches'); fs.mkdirSync(launches);
  const { runtime, registered } = fakeClaude(dir, { logs });
  const id = crypto.randomUUID(), receipt = path.join(launches, id + '.json');
  fs.writeFileSync(receipt, JSON.stringify({ state: 'starting', createdAt: Date.now(), binary: runtime, request: { id, runtime: 'claude-code', cwd: dir, prompt: 'test' } }));
  const worker = spawn(process.execPath, [fileURLToPath(new URL('../bin/session-worker.mjs', import.meta.url)), receipt],
    { env: { ...process.env, AGENTBUS_DIR: dir, AGENTBUS_NATIVE_POLL_MS: '50', AGENTBUS_UNREGISTERED_LOG_AFTER_MS: '0', AGENTBUS_UNREGISTERED_LOG_EVERY_MS: '0', ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = ''; worker.stderr.on('data', (b) => { errors += b; });
  t.after(() => { if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); });
  const read = () => JSON.parse(fs.readFileSync(receipt, 'utf8'));
  const until = async (check, what) => { for (let n = 0; n < 200; n++) { const r = read(); if (check(r)) return r; await new Promise((res) => setTimeout(res, 25)); } assert.fail(`${what}: ${JSON.stringify(read())} ${errors}`); };
  return { receipt, worker, registered, read, until };
}

test('a background job that crash-loops before registering is reported as crashing, keeps its slot, and still stops', { skip: process.platform === 'win32', timeout: 15000 }, async (t) => {
  const s = await supervise(t, 'boot\nworker crashed: SIGKILL (137), respawning\nworker crashed: SIGKILL (137), respawning');
  const r = await s.until((x) => x.state === 'crashing', 'never marked crashing');
  assert.equal(r.crash.lastExitCode, 137); assert.equal(r.crash.respawns, 2);
  assert.match(r.error, /crashing before its session registers \(exit 137, 2 respawn/);
  assert.match(r.note, /claude logs abc12345/); assert.match(r.nativeLogTail, /SIGKILL/);
  assert.equal(r.nativeState, 'working', 'the native inventory alone still says working');
  fs.writeFileSync(s.receipt + '.stop', '');
  await s.until((x) => x.state === 'stopped', 'stop did not complete');
  for (let n = 0; n < 150 && s.worker.exitCode === null; n++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(s.worker.exitCode, 0);
});

test('a slow but healthy job is reported as stalled, never crashing, and clears once it registers', { skip: process.platform === 'win32', timeout: 15000 }, async (t) => {
  const s = await supervise(t, 'loading plugins\nconnecting mcp servers', { AGENTBUS_UNREGISTERED_STALL_MS: '0' });
  const r = await s.until((x) => x.stall, 'never marked stalled');
  assert.equal(r.state, 'awaiting_registration'); assert.equal(r.crash, undefined);
  assert.match(r.note, /has not registered a session/);
  fs.writeFileSync(s.registered, '');
  const done = await s.until((x) => x.state === 'running', 'never became running');
  assert.equal(done.stall, null); assert.equal(done.nativeLogTail, null);
  fs.writeFileSync(s.receipt + '.stop', '');
  await s.until((x) => x.state === 'stopped', 'stop did not complete');
});
