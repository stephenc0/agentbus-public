import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../lib/windows-process-tree.ps1', import.meta.url));
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const win = process.platform === 'win32';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
function tree(pid, args = [], supervisor = process.pid) {
  return new Promise((resolve) => execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-LeaderPid', String(pid), '-SupervisorPid', String(supervisor), ...args], { windowsHide: true, timeout: 30000 }, (error, stdout, stderr) => {
    let json; try { json = JSON.parse(stdout.trim().split('\n').pop()); } catch {}
    resolve({ code: error ? error.code : 0, json, stdout, stderr });
  }));
}
// Leader -> mid -> grandchild, plus bounded concurrent short-lived children
// (taskkill's "no running instance" race). Inner spawns are detached so they
// stay out of libuv's kill-on-close job, like native runtime descendants.
const nodeTree = `
const {spawn}=require('node:child_process'); const fs=require('node:fs'); const out=process.argv[1];
const keep=(code,...a)=>spawn(process.execPath,['-e',code,...a],{stdio:'ignore',detached:true});
const mid=keep("const {spawn}=require('node:child_process'); const g=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true}); require('fs').writeFileSync(process.argv[1], String(g.pid)); setInterval(()=>{},1000)", out+'.g');
const churn=keep("const {spawn}=require('node:child_process'); let live=0; setInterval(()=>{if(live>=2)return; live++; const c=spawn(process.execPath,['-e','setTimeout(()=>{},30)'],{stdio:'ignore',detached:true}); c.once('exit',()=>live--); c.once('error',()=>live--);},50)");
let live=0; const late=()=>setInterval(()=>{if(live>=2)return; live++; const c=spawn(process.execPath,['-e','setTimeout(()=>{},200)'],{stdio:'ignore',detached:true}); c.once('exit',()=>live--); c.once('error',()=>live--);},50);
late();
fs.writeFileSync(out, JSON.stringify({leader:process.pid, mid:mid.pid, churn:churn.pid}));
setInterval(()=>{},1000);
`;
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-tree-'));
  const out = path.join(dir, 'pids.json');
  const child = spawn(process.execPath, ['-e', nodeTree, out], { stdio: 'ignore', windowsHide: true });
  t.after(() => {
    // Emergency cleanup is limited to pids this fixture recorded.
    const pids = []; try { pids.push(...Object.values(JSON.parse(fs.readFileSync(out, 'utf8')))); } catch {} try { pids.push(+fs.readFileSync(out + '.g', 'utf8')); } catch {}
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  for (let i = 0; i < 200 && !(fs.existsSync(out) && fs.existsSync(out + '.g')); i++) await sleep(25);
  const pids = { ...JSON.parse(fs.readFileSync(out, 'utf8')), grand: +fs.readFileSync(out + '.g', 'utf8') };
  await sleep(300);
  return { child, pids };
}

test('kills a live tree with churning and late-forking descendants and certifies absence', { skip: !win, timeout: 90000 }, async (t) => {
  for (let round = 0; round < 5; round++) {
    const { pids, child } = await fixture(t);
    const r = await tree(child.pid);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.json.ok, true); assert.deepEqual(r.json.survivors, []);
    for (const pid of Object.values(pids)) { assert(r.json.killed.includes(pid), `${pid} captured`); assert(!alive(pid), `${pid} dead`); }
  }
});

test('exited leader fails closed and leaves orphans untouched', { skip: !win, timeout: 30000 }, async (t) => {
  const { child, pids } = await fixture(t);
  process.kill(pids.leader, 'SIGKILL'); await new Promise((r) => child.once('exit', r));
  const r = await tree(pids.leader);
  assert.equal(r.code, 1); assert.equal(r.json.ok, false); assert.match(r.json.error, /cannot be proven/);
  assert(alive(pids.mid) && alive(pids.grand), 'orphans untouched');
});

test('leader not spawned by the claimed supervisor is never killed', { skip: !win, timeout: 30000 }, async (t) => {
  const { child, pids } = await fixture(t);
  // The fixture's mid process is live but its parent is the leader, not us.
  const r = await tree(pids.mid);
  assert.equal(r.code, 1); assert.match(r.json.error, /does not match the supervisor/);
  const wrong = await tree(child.pid, [], pids.churn);
  assert.equal(wrong.code, 1); assert.match(wrong.json.error, /does not match the supervisor/);
  for (const pid of Object.values(pids)) assert(alive(pid), `${pid} untouched`);
});

// Real native runtime: initialize and start an ephemeral thread under the
// windows sandbox so the runtime spawns its helper descendants, then certify.
test('installed codex app-server tree is terminated and certified', { skip: !(win && process.env.AGENTBUS_TEST_CODEX), timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-tree-codex-'));
  const home = path.join(dir, 'codex'), cwd = path.join(dir, 'work'); fs.mkdirSync(home); fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(home, 'config.toml'), `[windows]\nsandbox = "${process.env.TREE_WINDOWS_SANDBOX || 'unelevated'}"\n`);
  const child = spawn(process.env.AGENTBUS_TEST_CODEX, ['-c', 'analytics.enabled=false', 'app-server'], { cwd, env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} for (let i = 0; i < 10; i++) { try { fs.rmSync(dir, { recursive: true, force: true }); break; } catch {} } });
  const pending = new Map(); let id = 0;
  readline.createInterface({ input: child.stdout }).on('line', (s) => { let m; try { m = JSON.parse(s); } catch { return; } pending.get(m.id)?.(m); });
  const rpc = (method, params) => new Promise((resolve, reject) => { const n = ++id; const timer = setTimeout(() => reject(Error(method + ' timed out')), 15000); pending.set(n, (m) => { clearTimeout(timer); m.error ? reject(Error(JSON.stringify(m.error))) : resolve(m.result); }); child.stdin.write(JSON.stringify({ id: n, method, params }) + '\n'); });
  await rpc('initialize', { clientInfo: { name: 'ab_tree_test', version: '1' }, capabilities: {} });
  child.stdin.write('{"method":"initialized"}\n');
  await rpc('thread/start', { cwd, sandbox: 'workspace-write', approvalPolicy: 'never', ephemeral: true });
  const snap = await tree(child.pid, ['-Mode', 'snapshot']);
  t.diagnostic('snapshot ' + JSON.stringify(snap.json));
  const r = await tree(child.pid);
  t.diagnostic('kill ' + JSON.stringify(r.json));
  assert.equal(r.code, 0, r.stdout + r.stderr); assert.deepEqual(r.json.survivors, []);
  for (const pid of snap.json.captured) assert(!alive(pid), `${pid} dead`);
  await new Promise((resolve) => child.exitCode !== null ? resolve() : child.once('exit', resolve));
});
