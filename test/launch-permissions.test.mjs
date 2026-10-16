import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { terminateChild, delay } from '../lib/native-runtime.mjs';
import readline from 'node:readline';
import { normalizeProfiles, codexThreadParams, verifyNativePermissions } from '../lib/launch-permissions.mjs';
import { validateLaunch, createLauncher, writeLaunch, readLaunch } from '../lib/session-launch.mjs';

function fixture(t, cleanup = true) {
  const bus = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-perms-'));
  const cwd = path.join(bus, 'workspace'), extra = path.join(bus, 'scratch'), other = path.join(bus, 'other');
  for (const d of [cwd, extra, other]) fs.mkdirSync(d);
  if (cleanup) t.after(() => fs.rmSync(bus, { recursive: true, force: true }));
  const from = 'codex:' + crypto.randomUUID();
  const policy = { enabled: true, roots: [cwd, other], maxSessions: 4, runtimes: { codex: process.execPath }, permissionProfiles: {
    research: { workspaces: [cwd], allowedSources: ['local/' + from], sandbox: 'danger-full-access' },
    scratch: { workspaces: [cwd], allowedSources: ['local/' + from], sandbox: 'workspace-write', writableRoots: [extra] },
  } };
  const request = { id: crypto.randomUUID(), from, runtime: 'codex', cwd, prompt: 'test' };
  return { bus, cwd, extra, other, from, policy, request };
}
test('defaults stay restricted; full access requires explicit authorized profile and workspace', async (t) => {
  const f = fixture(t);
  const normal = codexThreadParams(validateLaunch(f.request, f.policy), f.policy);
  assert.equal(normal.sandbox, 'workspace-write');
  assert.equal(normal.config['sandbox_workspace_write.network_access'], false);
  assert.deepEqual(normal.config['sandbox_workspace_write.writable_roots'], []);
  const request = { ...f.request, permission_profile: 'research' };
  const full = codexThreadParams(validateLaunch(request, f.policy), f.policy);
  assert.equal(full.sandbox, 'danger-full-access'); assert.equal(full.approvalPolicy, 'never');
  for (const mutation of [{ from: 'codex:' + crypto.randomUUID() }, { from: undefined }, { permission_profile: 'unknown' }, { runtime: 'claude-code' }, { cwd: f.other }]) assert.throws(() => validateLaunch({ ...request, ...mutation }, f.policy));
  assert.throws(() => validateLaunch(request, f.policy, crypto.randomUUID() + '/' + f.from), /sender/);
  for (const key of ['config', 'sandbox', 'sandboxPolicy', 'approvalPolicy', 'permissions', 'permissionSource', 'writableRoots', 'networkAccess']) assert.throws(() => validateLaunch({ ...request, [key]: {} }, f.policy), /overrides/);
});
test('scoped filesystem grants canonicalize paths and reject symlink escape and policy revocation', async (t) => {
  const f = fixture(t);
  const valid = validateLaunch({ ...f.request, permission_profile: 'scratch' }, f.policy);
  assert.deepEqual(codexThreadParams(valid, f.policy).config['sandbox_workspace_write.writable_roots'], [fs.realpathSync(f.extra)]);
  fs.symlinkSync(f.other, path.join(f.cwd, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => validateLaunch({ ...f.request, cwd: path.join(f.cwd, 'escape'), permission_profile: 'scratch' }, f.policy), /workspace/);
  const changed = structuredClone(f.policy); changed.permissionProfiles.scratch.writableRoots = [];
  assert.throws(() => codexThreadParams(valid, changed), /changed/);
  delete changed.permissionProfiles.scratch;
  assert.throws(() => codexThreadParams(valid, changed), /unknown/);
  fs.rmdirSync(f.extra); fs.symlinkSync(f.other, f.extra, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => codexThreadParams(valid, f.policy), /changed/);
});
test('profiles reject arbitrary config, network expansion and ambiguous full-access scope', async (t) => {
  const f = fixture(t), p = f.policy.permissionProfiles.research;
  for (const mutation of [{ config: {} }, { networkAccess: true }, { network: { allowedDomains: ['*'] } }, { allowedSources: ['*'] }, { sandbox: 'externalSandbox' }, { writableRoots: [f.extra] }, { workspaces: [f.bus] }]) assert.throws(() => normalizeProfiles({ bad: { ...p, ...mutation } }, f.policy.roots));
});
test('profile choice and sender are durable and cannot be changed on retry', async (t) => {
  const f = fixture(t); writeLaunch(path.join(f.bus, 'launch-config.json'), f.policy);
  let count = 0;
  const launcher = createLauncher({ busDir: f.bus, capabilities: () => ({ runtimes: { codex: true } }), startWorker: () => count++ });
  const request = { ...f.request, permission_profile: 'research' };
  const launched = (await launcher.launch(request));
  assert.equal(launched.permissions.sandbox, 'danger-full-access');
  assert.equal((await launcher.launch(request)).state, 'starting');
  assert.equal((await launcher.launch({ ...request, permission_profile: 'scratch' })).ok, false);
  assert.equal((await launcher.launch({ ...request, from: 'codex:' + crypto.randomUUID() })).ok, false);
  assert.equal(count, 1);
  assert.equal(readLaunch(path.join(f.bus, 'launches', request.id + '.json')).request.permissionSource, 'local/' + f.from);
});
test('installed native runtime accepts explicit full access and restricted profile parameters', { skip: !process.env.AGENTBUS_TEST_CODEX, timeout: 45000 }, async (t) => {
  const f = fixture(t, false); const codexHome = path.join(f.bus, 'codex'); fs.mkdirSync(codexHome);
  // An empty Windows home otherwise silently narrows workspace-write to readOnly.
  // Configure only this disposable fixture; do not change the user's runtime.
  if (process.platform === 'win32') fs.writeFileSync(path.join(codexHome, 'config.toml'), '[windows]\nsandbox = \"unelevated\"\n');
  const child = spawn(process.env.AGENTBUS_TEST_CODEX, ['app-server'], { cwd: f.cwd, detached: process.platform !== 'win32', env: { ...process.env, CODEX_HOME: codexHome }, stdio: ['pipe', 'pipe', 'pipe'] });
  let error = '', bodyPassed = false; child.stderr.on('data', (b) => { error = (error + b).slice(-16000); });
  const pending = new Map(); let count = 0;
  const lines = readline.createInterface({ input: child.stdout });
  const rejectPending = (e) => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(e); } pending.clear(); };
  lines.on('line', (s) => { let m; try { m = JSON.parse(s); } catch { return; } const p = pending.get(m.id); if (p) { pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(Error(JSON.stringify({ method: p.method, params: p.params, nativeError: m.error, stderr: error }))) : p.resolve(m.result); } });
  child.on('error', rejectPending); child.stdin.on('error', rejectPending);
  child.on('exit', (code) => rejectPending(Error(`native exited ${code}: ${error}`)));
  t.after(async () => {
    let cleanupError;
    try { await terminateChild(child); } catch (e) { cleanupError = e; t.diagnostic(`runtime cleanup: ${e.message}`); }
    rejectPending(Error('test cleanup')); lines.close(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    for (let attempt = 0; attempt < 10; attempt++) {
      try { fs.rmSync(f.bus, { recursive: true, force: true }); break; }
      catch (e) { if (attempt === 9) t.diagnostic(`temporary directory retained after bounded cleanup: ${f.bus}: ${e.message}`); else await delay(100); }
    }
    if (bodyPassed && cleanupError) throw cleanupError;
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++count, timer = setTimeout(() => { pending.delete(id); reject(Error(JSON.stringify({ method, params, error: 'native RPC timed out', stderr: error }))); }, 10000);
    pending.set(id, { resolve, reject, timer, method, params }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  await rpc('initialize', { clientInfo: { name: 'ab_permissions_test', version: '1' }, capabilities: {} });
  child.stdin.write('{"method":"initialized"}\n');
  for (const profile of [undefined, 'scratch', 'research']) {
    const params = codexThreadParams(validateLaunch({ ...f.request, ...(profile ? { permission_profile: profile } : {}) }, f.policy), f.policy);
    const result = await rpc('thread/start', { ...params, ephemeral: true });
    try { assert.equal(verifyNativePermissions(result, params).approvalPolicy, 'never'); }
    catch (e) { t.diagnostic(JSON.stringify({ profile: profile || 'default', params, nativeResult: result, stderr: error })); throw e; }
    assert.equal(result.sandbox.type, profile === 'research' ? 'dangerFullAccess' : 'workspaceWrite');
    if (profile !== 'research') {
      assert.equal(result.sandbox.networkAccess, false);
      assert.deepEqual(result.sandbox.writableRoots, profile === 'scratch' ? [fs.realpathSync(f.extra)] : []);
    }
  }
  bodyPassed = true;
});

test('native refusal or wider effective permissions fail before task execution', () => {
  const params = { sandbox: 'workspace-write', config: { 'sandbox_workspace_write.writable_roots': [] } };
  for (const response of [
    { approvalPolicy: 'never', sandbox: { type: 'dangerFullAccess' } },
    { approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false } },
    { approvalPolicy: 'never', sandbox: { type: 'workspaceWrite', writableRoots: ['/unexpected'], networkAccess: false } },
    { approvalPolicy: 'never', sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: true } },
  ]) assert.throws(() => verifyNativePermissions(response, params));
});
