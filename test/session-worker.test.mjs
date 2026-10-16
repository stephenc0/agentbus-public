import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { configureLaunch, createLauncher, readLaunch, launchEnvironment } from '../lib/session-launch.mjs';
import { bridgeThreads, pushToCodex } from '../lib/codex-push.mjs';
import { processAlive } from '../lib/native-runtime.mjs';
import { runSessionSmoke } from '../bin/session-smoke.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, timeout = 8000) {
  const end = Date.now() + timeout;
  do { const result = await check(); if (result) return result; await sleep(30); } while (Date.now() < end);
  throw Error('test condition timed out');
}
const fakeSource = `
const fs = require('node:fs');
const {spawn} = require('node:child_process');
const readline = require('node:readline');
const tid = '00000000-0000-4000-8000-000000000017';
const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'});
fs.writeFileSync('native-pids.json', JSON.stringify({runtime:process.pid, descendant:child.pid}));
const send = (m) => process.stdout.write(JSON.stringify(m)+'\\n');
let n = 0;
readline.createInterface({input:process.stdin}).on('line', (line) => {
 const m=JSON.parse(line); fs.appendFileSync('rpc.jsonl', JSON.stringify(m)+'\\n');
 const result=(r)=>send({id:m.id,result:r});
 if(m.method==='initialize') result({userAgent:'fake-native-worker'});
 else if(m.method==='thread/start') result({thread:{id:tid,cwd:process.cwd(),turns:[]},model:'fake-model',approvalPolicy:'never',sandbox:{type:'workspaceWrite',networkAccess:fs.existsSync('bad-permissions'),writableRoots:m.params.config['sandbox_workspace_write.writable_roots']}});
 else if(m.method==='thread/name/set') result({});
 else if(m.method==='thread/loaded/list') result({data:[tid],nextCursor:null});
 else if(m.method==='thread/read') result({thread:{id:tid,cwd:process.cwd(),turns:[]}});
 else if(m.method==='turn/start') {
   const turn={id:'turn-'+(++n),status:'inProgress'};
   result({turn}); send({method:'turn/started',params:{threadId:tid,turn}});
   setTimeout(()=>{
     send({method:'item/completed',params:{threadId:tid,turnId:turn.id,item:{type:'agentMessage',text:m.params.input[0].text}}});
     send({method:'turn/completed',params:{threadId:tid,turn:{id:turn.id,status:'completed'}}});
   },50);
 }
 else if(m.id!==undefined) send({id:m.id,error:{code:-32601,message:'unexpected method '+m.method}});
});
`;
async function fixture(t, badPermissions = false) {
  const dir = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'ab-wk-'));
  const cwd = path.join(dir, 'work'), bus = path.join(dir, 'bus'); fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, 'app-server'), fakeSource);
  if (badPermissions) fs.writeFileSync(path.join(cwd, 'bad-permissions'), '');
  configureLaunch({ roots: [cwd], runtimes: { codex: process.execPath }, maxSessions: 2 }, bus);
  const workers = [], errors = [];
  const launcher = createLauncher({ busDir: bus, capabilities: async () => ({ runtimes: { codex: true } }),
    listLocal: () => [...bridgeThreads(bus)].map(([threadId, m]) => ({ id: 'codex:' + threadId, kind: 'codex', model: m.model })),
    startWorker: (file) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/session-worker.mjs', import.meta.url)), file], { env: { ...launchEnvironment(), AGENTBUS_DIR: bus }, stdio: ['ignore', 'ignore', 'pipe'] });
      child.stderr.on('data', (b) => errors.push(b.toString())); workers.push(child);
    },
  });
  const id = crypto.randomUUID();
  t.after(async () => {
    try { await launcher.stop(id); } catch {}
    for (const worker of workers) {
      await until(() => worker.exitCode !== null || worker.signalCode !== null, 6000).catch(() => worker.kill('SIGKILL'));
    }
    // Emergency cleanup is restricted to PIDs created by this test, never production jobs.
    try { const pids = JSON.parse(fs.readFileSync(path.join(cwd, 'native-pids.json'), 'utf8')); for (const pid of Object.values(pids)) { try { process.kill(pid, 'SIGKILL'); } catch {} } } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, cwd, bus, launcher, id, workers, errors };
}

test('owned codex worker initializes native app-server, completes, wakes idle through bridge, and stops the native process tree', { timeout: 20000 }, async (t) => {
  const f = await fixture(t);
  const started = await f.launcher.launch({ id: f.id, runtime: 'codex', cwd: f.cwd, name: 'fake worker', prompt: 'boot-nonce' });
  assert.equal(started.ok, true);
  const boot = await until(async () => { const s = await f.launcher.status(f.id); return s.lastResponse === 'boot-nonce' && s.lastTurn === 'completed' && s; });
  assert.equal(boot.effectivePermissions.sandbox.networkAccess, false);
  assert.equal(boot.effectivePermissions.approvalPolicy, 'never');
  const threadId = boot.agentId.slice('codex:'.length);
  await until(() => bridgeThreads(f.bus).has(threadId));
  const pushed = await pushToCodex(f.bus, threadId, { msg_id: crypto.randomUUID(), content: 'idle-nonce' });
  assert.equal(pushed.status, 'accepted'); assert.equal(pushed.method, 'turn/start');
  await until(async () => { const s = await f.launcher.status(f.id); return s.lastResponse === 'idle-nonce' && s.lastTurn === 'completed'; });
  const rpc = fs.readFileSync(path.join(f.cwd, 'rpc.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rpc.filter((r) => r.method === 'initialize').length, 1);
  assert.equal(rpc.filter((r) => r.method === 'turn/start').length, 2);
  assert.equal(rpc.find((r) => r.method === 'thread/start').params.approvalPolicy, 'never');
  assert.equal(rpc.find((r) => r.method === 'thread/start').params.sandbox, 'workspace-write');
  const pids = JSON.parse(fs.readFileSync(path.join(f.cwd, 'native-pids.json'), 'utf8'));
  assert(processAlive(pids.runtime)); assert(processAlive(pids.descendant));
  await f.launcher.stop(f.id);
  await until(async () => (await f.launcher.status(f.id)).state === 'stopped');
  await until(() => !processAlive(pids.runtime) && !processAlive(pids.descendant));
  await until(() => f.workers.every((w) => w.exitCode !== null));
  assert.equal(readLaunch(path.join(f.bus, 'launches', f.id + '.json')).state, 'stopped');
  assert.equal(f.errors.join(''), '');
});

test('worker rejects an unexpected native permission grant before sending any task', { timeout: 15000 }, async (t) => {
  const f = await fixture(t, true);
  await f.launcher.launch({ id: f.id, runtime: 'codex', cwd: f.cwd, prompt: 'must not execute' });
  const failed = await until(async () => { const s = await f.launcher.status(f.id); return s.state === 'failed' && s; });
  assert.match(failed.error, /unexpected writable roots\/network/);
  const rpc = fs.readFileSync(path.join(f.cwd, 'rpc.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert(!rpc.some((r) => r.method === 'turn/start'));
  const pids = JSON.parse(fs.readFileSync(path.join(f.cwd, 'native-pids.json'), 'utf8'));
  await until(() => !processAlive(pids.runtime) && !processAlive(pids.descendant));
});

test('smoke runner stores stable request id, tests completion rather than dispatch, and stops only its receipt', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-smoke-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let request, stopped = false, idleResponse, calls = 0; const stops = [];
  const agentId = 'codex:00000000-0000-4000-8000-000000000018';
  const api = {
    status: async () => !request ? { ok: false, error: 'unknown launch id' } : { ok: true, state: stopped ? 'stopped' : 'running', agentId, lastTurn: 'completed', lastResponse: idleResponse || /finish your turn with exactly (.*)\.$/.exec(request.prompt)[1] },
    launch: async (r) => { calls++; request = r; return { ok: true, state: 'running', agentId }; },
    agents: async () => [{ id: agentId, status: 'idle', deliveryReady: true }],
    send: async (m) => { idleResponse = /finish your turn with exactly (.*)\.$/.exec(m.message)[1]; return { ok: true, delivery: 'accepted' }; },
    stop: async (id) => { stops.push(id); stopped = true; return { ok: true, state: 'stopped' }; },
    sleep,
  };
  const options = { cwd: dir, runtime: 'codex', from: 'codex:00000000-0000-4000-8000-000000000019', report: path.join(dir, 'report.json'), timeoutMs: 1000 };
  const report = await runSessionSmoke(options, api);
  assert.equal(report.ok, true); assert.equal(report.cleanup.ok, true); assert.equal(report.messageAcknowledged, true);
  assert.deepEqual(stops, [report.requestId]);
  const rerun = await runSessionSmoke(options, api); assert.equal(rerun.requestId, report.requestId); assert.equal(calls, 1);
});

test('smoke runner never retries uncertain messages and cleans up its own launch', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-smoke-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let request, stopped = false, sends = 0; const stops = [];
  const agentId = 'codex:00000000-0000-4000-8000-000000000018';
  const api = {
    status: async () => !request ? { ok: false, error: 'unknown launch id' } : { ok: true, state: stopped ? 'stopped' : 'running', agentId, lastTurn: 'completed', lastResponse: /finish your turn with exactly (.*)\.$/.exec(request.prompt)[1] },
    launch: async (r) => { request = r; return { ok: true }; }, agents: async () => [{ id: agentId, status: 'idle', deliveryReady: true }],
    send: async () => { sends++; return { ok: false, delivery: 'uncertain' }; },
    stop: async (id) => { stops.push(id); stopped = true; return { ok: true }; }, sleep,
  };
  const report = await runSessionSmoke({ cwd: dir, runtime: 'codex', from: 'codex:00000000-0000-4000-8000-000000000019', report: path.join(dir, 'report.json'), timeoutMs: 1000 }, api);
  assert.equal(report.ok, false); assert.match(report.error, /uncertain/); assert.equal(sends, 1);
  assert.deepEqual(stops, [report.requestId]); assert.equal(report.cleanup.ok, true);
});

test('smoke runner does not adopt or stop an existing unrelated receipt', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-smoke-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let launches = 0, stops = 0;
  const api = { status: async () => ({ ok: true, state: 'running' }), launch: async () => { launches++; }, stop: async () => { stops++; }, sleep };
  const report = await runSessionSmoke({ cwd: dir, runtime: 'codex', from: 'codex:00000000-0000-4000-8000-000000000019', report: path.join(dir, 'report.json'), timeoutMs: 1000 }, api);
  assert.equal(report.ok, false); assert.match(report.error, /already used/); assert.equal(launches, 0); assert.equal(stops, 0);
});

test('smoke runner times out missing execution acknowledgement and still verifies cleanup', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-smoke-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let launched = false, stopped = false;
  const api = { status: async () => !launched ? { ok: false, error: 'unknown launch id' } : { ok: true, state: stopped ? 'stopped' : 'running' }, launch: async () => { launched = true; return { ok: true }; }, stop: async () => { stopped = true; return { ok: true }; }, sleep };
  const report = await runSessionSmoke({ cwd: dir, runtime: 'codex', from: 'codex:00000000-0000-4000-8000-000000000019', report: path.join(dir, 'report.json'), timeoutMs: 1000 }, api);
  assert.equal(report.ok, false); assert.match(report.error, /boot acknowledgement timed out/); assert.equal(report.cleanup.ok, true);
});

test('queued claude transport only passes after a separate execution nonce acknowledgement', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-smoke-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let request, stopped = false, sends = 0;
  const agentId = 'claude:00000000-0000-4000-8000-000000000018';
  const writeNonce = (prompt) => {
    const nonce = /finish your turn with exactly (.*)\.$/.exec(prompt)[1];
    const file = / to "([^"]+\.txt)"\./.exec(prompt)[1];
    fs.writeFileSync(path.join(dir, file), nonce);
  };
  const api = {
    status: async () => !request ? { ok: false, error: 'unknown launch id' } : { ok: true, state: stopped ? 'stopped' : 'running', agentId },
    launch: async (r) => { request = r; writeNonce(r.prompt); return { ok: true }; }, agents: async () => [{ id: agentId, status: 'idle', deliveryReady: true }],
    send: async (m) => { sends++; writeNonce(m.message); return { ok: true, delivery: 'queued' }; },
    stop: async () => { stopped = true; return { ok: true }; }, sleep,
  };
  const report = await runSessionSmoke({ cwd: dir, runtime: 'claude-code', from: 'codex:00000000-0000-4000-8000-000000000019', report: path.join(dir, 'report.json'), timeoutMs: 1000 }, api);
  assert.equal(report.ok, true); assert.equal(sends, 1); assert.equal(report.idleEvidence, 'workspace_nonce_file');
  assert.equal(report.events.find((e) => e.name === 'idle_message').result.delivery, 'queued');
});

test('cleanup failure replay only stops the same receipt and preserves original test result', async (t) => {
  for (const executionPasses of [true, false]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-smoke-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    let request, stopped = false, cleanupFails = true, idleResponse, launches = 0, sends = 0, stops = 0;
    const agentId = 'codex:00000000-0000-4000-8000-000000000018';
    const api = {
      status: async () => !request ? { ok: false, error: 'unknown launch id' } : { ok: true, state: stopped ? 'stopped' : 'running', agentId, lastTurn: 'completed', lastResponse: idleResponse || /finish your turn with exactly (.*)\.$/.exec(request.prompt)[1] },
      launch: async (r) => { launches++; request = r; return { ok: true }; }, agents: async () => [{ id: agentId, status: 'idle', deliveryReady: true }],
      send: async (m) => { sends++; idleResponse = /finish your turn with exactly (.*)\.$/.exec(m.message)[1]; return executionPasses ? { ok: true, delivery: 'accepted' } : { ok: false, delivery: 'uncertain' }; },
      stop: async () => { stops++; if (cleanupFails) throw Error('temporary stop failure'); stopped = true; return { ok: true }; }, sleep,
    };
    const options = { cwd: dir, runtime: 'codex', from: 'codex:00000000-0000-4000-8000-000000000019', report: path.join(dir, 'report.json'), timeoutMs: 1000 };
    const first = await runSessionSmoke(options, api);
    assert.equal(first.ok, false); assert.equal(first.cleanup.ok, false); assert.equal(first.testResult.ok, executionPasses);
    cleanupFails = false;
    const recovered = await runSessionSmoke(options, api);
    assert.equal(recovered.requestId, first.requestId); assert.equal(recovered.cleanup.ok, true);
    assert.equal(recovered.testResult.ok, executionPasses); assert.equal(recovered.ok, executionPasses);
    assert.equal(launches, 1); assert.equal(sends, 1); assert.equal(stops, 2);
    if (!executionPasses) assert.match(recovered.error, /uncertain/);
  }
});
