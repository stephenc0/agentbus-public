import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import readline from 'node:readline';
import { parseLockProbe, lockState, readLockSnapshot, refreshLockSnapshot, ownerKind, probeLockOwners, windowsLockProbeSupported, _resetLockCacheForTests } from '../lib/codex-locks.mjs';

const T = '01a13745-9c82-76b1-82c6-5c9659bef916', U = '01a13745-9c99-74a3-a8bf-831224258b90';
const desktopProc = { image: 'codex.exe', path: 'C:\\Users\\u\\AppData\\Local\\OpenAI\\Codex\\bin\\abc\\codex.exe', startTime: '134363990029377747', parentPid: 1, parentImage: 'ChatGPT.exe', parentPath: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1007.2314.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe', appServer: true, listen: null };
const probe_ = (locks, processes = {}, extra = {}) => JSON.stringify({ ok: true, at: 1, truncated: false, locks, processes, ...extra });

test('held only when a live codex holder matches pid and start time', () => {
  const s = parseLockProbe(probe_({ [T]: { holders: ['13500:134363990029377747'] }, [U]: { holders: [] } }, { 13500: desktopProc }));
  assert.equal(lockState(s, T).state, 'held');
  assert.equal(lockState(s, T).owners[0].owner, 'desktop');
  assert.equal(lockState(s, T).owners[0].path, desktopProc.path);
  assert.equal(lockState(s, U).state, 'stale', 'a lock file with no holder is not liveness');
});

test('pid reuse, exited holder and non-codex holders are not owners', () => {
  const s = parseLockProbe(probe_({
    [T]: { holders: ['13500:134363990029377746'] }, // start time differs: pid reused
    [U]: { holders: ['9:1', '77:5'] },
  }, { 13500: desktopProc, 9: { ...desktopProc, image: 'SearchProtocolHost.exe', startTime: '1' } }));
  assert.equal(lockState(s, T).state, 'stale');
  assert.equal(lockState(s, U).state, 'stale');
});

test('probe failure, per-lock errors and truncation are unknown, never absent', () => {
  assert.equal(lockState(parseLockProbe('{"ok":false,"error":"RmStartSession 5"}'), T).state, 'unknown');
  assert.equal(lockState(parseLockProbe('garbage'), T).state, 'unknown');
  assert.equal(lockState(parseLockProbe(probe_({ [T]: { error: 'RmGetList 5' } }, {})), T).state, 'unknown');
  assert.equal(lockState(parseLockProbe(probe_({}, {}, { truncated: true })), T).state, 'unknown');
  assert.equal(lockState(parseLockProbe(probe_({}, {})), T).state, 'absent');
  assert.equal(lockState(null, T).state, 'unknown');
});

test('owner kinds', () => {
  assert.equal(ownerKind(desktopProc), 'desktop');
  assert.equal(ownerKind({ ...desktopProc, parentPath: 'C:\\Program Files\\nodejs\\node.exe' }), 'app-server');
  assert.equal(ownerKind({ ...desktopProc, parentPath: null, listen: 'ws://127.0.0.1:1' }), 'app-server-listener');
  assert.equal(ownerKind({ ...desktopProc, appServer: false }), 'codex');
});

test('readLockSnapshot never blocks, dedups refreshes and ages out to unknown', async () => {
  _resetLockCacheForTests();
  let t = 1000, probes = 0, release; const now = () => t;
  const probe = () => { probes++; return new Promise((r) => { release = () => r(parseLockProbe(probe0)); }); };
  const probe0 = probe_({ [T]: { holders: [] } });
  const first = readLockSnapshot('X', { now, probe });
  assert.equal(lockState(first, T).state, 'unknown', 'no snapshot yet');
  readLockSnapshot('X', { now, probe }); assert.equal(probes, 1, 'in-process dedup while refreshing');
  release(); await refreshLockSnapshot('X', { now, probe });
  assert.equal(probes, 1);
  assert.equal(lockState(readLockSnapshot('X', { now, probe }), T).state, 'stale', 'fresh snapshot used');
  t += 5000;
  const old = readLockSnapshot('X', { now, probe });
  assert.equal(old.stale, true); assert.equal(lockState(old, T).state, 'unknown', 'aged snapshot is unknown');
  assert.equal(probes, 2, 'stale read kicked one refresh');
  release(); await new Promise((r) => setImmediate(r));
});

test('failed refresh keeps last good snapshot but never reports absent', async () => {
  _resetLockCacheForTests();
  let t = 0; const now = () => t;
  await refreshLockSnapshot('Y', { now, probe: async () => parseLockProbe(probe_({ [T]: { holders: [] } })) });
  t = 10000;
  const r = await refreshLockSnapshot('Y', { now, probe: async () => parseLockProbe('{"ok":false,"error":"RmStartSession 5"}') });
  assert.equal(r.ok, false);
  const s = readLockSnapshot('Y', { now, refresh: false });
  assert.equal(lockState(s, T).state, 'unknown');
  assert.equal(lockState(s, U).state, 'unknown', 'not absent');
});

test('shared cache file is used across processes and survives torn writes', async () => {
  _resetLockCacheForTests();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-locks-')); const cacheFile = path.join(dir, 'c.json');
  try {
    let t = 100; const now = () => t;
    await refreshLockSnapshot('Z', { cacheFile, now, probe: async () => parseLockProbe(probe_({ [T]: { holders: ['13500:134363990029377747'] } }, { 13500: desktopProc })) });
    _resetLockCacheForTests(); // another process: empty memory
    let probes = 0; const s = readLockSnapshot('Z', { cacheFile, now, probe: async () => { probes++; return parseLockProbe('x'); } });
    assert.equal(probes, 0); assert.equal(lockState(s, T).state, 'held');
    assert.equal(readLockSnapshot('other', { cacheFile, now, refresh: false }).ok, false, 'keyed by lock dir');
    fs.writeFileSync(cacheFile, '{torn'); _resetLockCacheForTests();
    assert.equal(lockState(readLockSnapshot('Z', { cacheFile, now, refresh: false }), T).state, 'unknown');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// Opt-in: real codex app-server in a temporary home. No model request is made (thread/start only).
test('real app-server: held while loaded, stale after exit', { skip: !(windowsLockProbeSupported() && process.env.AGENTBUS_TEST_CODEX), timeout: 60000 }, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-locks-live-'));
  const child = spawn(process.env.AGENTBUS_TEST_CODEX, ['-c', 'analytics.enabled=false', 'app-server'], { env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit').catch(() => {}); }
    // codex helpers can hold the home briefly after the app-server exits; don't fail the lock assertions on that
    try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 }); } catch (e) { t.diagnostic(`cleanup deferred: ${e.code} ${home}`); }
  });
  const pending = new Map(); let next = 0;
  readline.createInterface({ input: child.stdout }).on('line', (l) => { try { const m = JSON.parse(l); pending.get(m.id)?.(m); pending.delete(m.id); } catch {} });
  const rpc = (method, params) => new Promise((resolve) => { const id = ++next; pending.set(id, resolve); child.stdin.write(JSON.stringify({ id, method, params }) + '\n'); });
  await rpc('initialize', { clientInfo: { name: 'agentbus_lock_test', version: '0' }, capabilities: { experimentalApi: true } });
  const { result } = await rpc('thread/start', { cwd: home, approvalPolicy: 'never', sandbox: 'read-only' });
  const id = result.thread.id; const lockDir = path.join(home, 'thread-writer-locks');
  const held = await probeLockOwners(lockDir);
  assert.equal(lockState(held, id).state, 'held', JSON.stringify(held));
  assert.equal(lockState(held, id).owners[0].pid, child.pid);
  child.stdin.end(); child.kill(); await once(child, 'exit');
  let after; for (let i = 0; i < 20; i++) { after = await probeLockOwners(lockDir); if (lockState(after, id).state === 'stale') break; await new Promise((r) => setTimeout(r, 250)); }
  assert.equal(lockState(after, id).state, 'stale', 'file remains, owner gone');
  assert(fs.existsSync(path.join(lockDir, `${id}.lock`)));
});
