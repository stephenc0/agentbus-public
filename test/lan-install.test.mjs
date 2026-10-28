import { serialize } from './serial-lock.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runnerTargets, killRunners } from '../lib/lan-install.mjs';

const win = process.platform === 'win32';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const RUNNER = 'C:\\Users\\k\\.agentbus\\lan\\lan-serve.cmd';
const t0 = Date.parse('2026-10-27T10:00:00.000Z');
const proc = (pid, ppid, s, name, cmd = name) => ({ pid, ppid, created: new Date(t0 + s * 1000).toISOString(), name, cmd });
const table = () => [
  proc(10, 1, 0, 'conhost.exe', 'conhost.exe --headless cmd.exe /d /c "C:\\Users\\k\\.agentbus\\lan\\lan-serve.cmd"'),
  proc(11, 10, 1, 'cmd.exe', `cmd.exe /d /c "${RUNNER}"`),
  proc(12, 11, 2, 'node.exe', '"C:\\node.exe" "C:\\ab\\bin\\agentbus.mjs" lan serve'),
  proc(13, 12, 3, 'powershell.exe', 'powershell.exe -File presence-win.ps1'),
  proc(14, 12, 4, 'node.exe', '"C:\\node.exe" C:\\ab\\bin\\session-worker.mjs C:\\Users\\k\\.agentbus\\launches\\a.json'),
  proc(15, 14, 5, 'claude.exe', 'claude.exe --bg'),
  proc(16, 15, 6, 'node.exe', 'mcp-server.js'),
  proc(17, 12, 7, 'codex.exe', 'codex.exe app-server'),
  // pid 18 reused: it names the daemon as parent but predates it
  proc(18, 12, -60, 'notepad.exe'),
  proc(20, 1, 0, 'cmd.exe', 'cmd.exe /d /c "C:\\other\\lan-serve.cmd.bak"'),
  proc(21, 1, 0, 'CMD.EXE', `cmd /d /c "${RUNNER.toUpperCase()}"`),
];

test('runner targets: loop, daemon and its own children; session-worker subtrees and reused pids spared', () => {
  const r = runnerTargets(table(), RUNNER);
  // pid 21: a second loop instance, matched case-insensitively like the previous killRunners
  assert.deepEqual(r.kill.map((p) => p.pid).sort((a, b) => a - b), [11, 12, 13, 17, 21]);
  assert.deepEqual(r.spared.map((p) => p.pid), [14]);
  assert(!r.kill.some((p) => [10, 14, 15, 16, 18, 20].includes(p.pid)));
});

test('runner targets: a worker is node with session-worker.mjs as entry script, not any mention of it', () => {
  const procs = [
    proc(11, 1, 1, 'cmd.exe', `cmd.exe /d /c "${RUNNER}"`),
    // daemon that merely passes the worker path along: walked, so its children are reached
    proc(12, 11, 2, 'node.exe', '"C:\\node.exe" "C:\\ab\\daemon.mjs" "C:\\ab\\bin\\session-worker.mjs" out.json'),
    proc(13, 12, 3, 'node.exe', '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\k k\\ab\\bin\\session-worker.mjs" C:\\x\\a.json'),
    proc(14, 12, 4, 'powershell.exe', 'powershell.exe -File C:\\ab\\bin\\session-worker.mjs'),
    proc(15, 12, 5, 'node.exe', 'node -e "x" C:\\ab\\bin\\session-worker.mjs'),
  ];
  const r = runnerTargets(procs, RUNNER);
  assert.deepEqual(r.kill.map((p) => p.pid), [11, 12, 14, 15]);
  assert.deepEqual(r.spared.map((p) => p.pid), [13]);
});

test('runner targets: rescan from killed identities finds only late children', () => {
  const procs = [...table(), proc(30, 11, 20, 'node.exe', '"C:\\node.exe" "C:\\ab\\bin\\agentbus.mjs" lan serve'), proc(31, 30, 21, 'node.exe', '"C:\\node.exe" C:\\ab\\bin\\session-worker.mjs b.json')];
  const first = runnerTargets(table(), RUNNER);
  const late = runnerTargets(procs, RUNNER, first.kill);
  assert.deepEqual(late.kill.map((p) => p.pid), [30]);
  assert.deepEqual(late.spared.map((p) => p.pid).sort(), [14, 31]);
});

test('killRunners: loop before daemon, never a tree kill, spared workers reported once', () => {
  const killed = [];
  const r = killRunners(RUNNER, { list: table, kill: (pid) => killed.push(pid) });
  assert.equal(killed[0], 11);
  assert(killed.indexOf(11) < killed.indexOf(12));
  assert.deepEqual(r.spared, [14]);
  assert.deepEqual(new Set(r.killed), new Set([11, 12, 13, 17, 21]));
  assert(!killed.includes(14) && !killed.includes(15));
});

test('killRunners: snapshot failure kills nothing', () => {
  const killed = [];
  assert.deepEqual(killRunners(RUNNER, { list: () => { throw Error('cim down'); }, kill: (pid) => killed.push(pid) }), { killed: [], spared: [] });
  assert.deepEqual(killed, []);
});

// real processes: a .cmd keepalive loop like lan-serve.cmd runs a fake daemon that spawns a supervisor exactly like
// createLauncher's default startWorker (detached, stdio ignore) whose runtime child is not detached, as on win32.
test('lan stop leaves detached session workers and their runtimes running', { skip: !win, timeout: 300000 }, async (t) => {
  await serialize(t, 'process-trees'); // never overlaps the other file's process-tree tests, cleanup included
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-lanstop-'));
  fs.mkdirSync(path.join(dir, 'bin'));
  const pidsFile = path.join(dir, 'pids.json'), workerFile = path.join(dir, 'worker.json'), stray = path.join(dir, 'stray.json');
  fs.writeFileSync(path.join(dir, 'bin', 'session-worker.mjs'), `import {spawn} from 'node:child_process'; import fs from 'node:fs';
const rt = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
fs.writeFileSync(process.argv[2], JSON.stringify({ worker: process.pid, runtime: rt.pid })); setInterval(() => {}, 1000);\n`);
  fs.writeFileSync(path.join(dir, 'daemon.mjs'), `import {spawn} from 'node:child_process'; import fs from 'node:fs';
const [pidsFile, workerScript, workerFile, stray] = process.argv.slice(2);
if (fs.existsSync(pidsFile)) { fs.writeFileSync(stray, String(process.pid)); setInterval(() => {}, 1000); } else {
spawn(process.execPath, [workerScript, workerFile], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
const probe = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const other = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, windowsHide: true, stdio: 'ignore' }); other.unref();
fs.writeFileSync(pidsFile, JSON.stringify({ daemon: process.pid, probe: probe.pid, other: other.pid })); setInterval(() => {}, 1000); }\n`);
  const runner = path.join(dir, 'lan-serve.cmd');
  fs.writeFileSync(runner, ['@echo off', ':loop', `"${process.execPath}" "${path.join(dir, 'daemon.mjs')}" "${pidsFile}" "${path.join(dir, 'bin', 'session-worker.mjs')}" "${workerFile}" "${stray}"`, 'ping -n 3 127.0.0.1 >nul', 'goto loop', ''].join('\r\n'));
  const loop = spawn('cmd.exe', ['/d', '/c', runner], { detached: true, stdio: 'ignore', windowsHide: true }); loop.unref();
  let pids = {};
  t.after(() => {
    let s = null; try { s = +fs.readFileSync(stray, 'utf8'); } catch {}
    for (const pid of [loop.pid, ...Object.values(pids), s].filter(Boolean)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });
  for (let i = 0; i < 200 && !(fs.existsSync(pidsFile) && fs.existsSync(workerFile)); i++) await sleep(50);
  pids = { ...JSON.parse(fs.readFileSync(pidsFile, 'utf8')), ...JSON.parse(fs.readFileSync(workerFile, 'utf8')) };
  for (const pid of Object.values(pids)) assert(alive(pid));
  const r = killRunners(runner);
  assert(r.killed.includes(loop.pid) && r.killed.includes(pids.daemon), JSON.stringify(r));
  assert.deepEqual(r.spared, [pids.worker]);
  await sleep(4000); // past one ping gap: a surviving loop would have respawned the daemon
  assert(!alive(loop.pid), 'runner loop dead');
  assert(!alive(pids.daemon) && !alive(pids.probe) && !alive(pids.other), 'daemon and its non-worker children dead');
  assert(!fs.existsSync(stray), 'daemon not respawned');
  assert(alive(pids.worker) && alive(pids.runtime), 'worker and runtime survive');
});
