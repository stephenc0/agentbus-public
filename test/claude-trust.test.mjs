import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readClaudeTrust, seedClaudeTrust, classifyTrustFailure, windowsSessionContext, diagnoseTrustFailure, normalizeKey, claudeConfigFile, launchContext } from '../lib/claude-trust.mjs';
import { createLauncher, writeLaunch, readLaunch } from '../lib/session-launch.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-trust-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const posix = { platform: 'linux', env: {} };

test('trust is read from the launching account\'s .claude.json and inherited from a trusted ancestor, never from the home dir', (t) => {
  const h = home(t), root = path.join(h, 'tasks'), task = path.join(root, 'tasks', 'abc'); fs.mkdirSync(task, { recursive: true });
  const o = { ...posix, home: h };
  let r = readClaudeTrust(task, o);
  assert.equal(r.trusted, null); assert.equal(r.reason, 'config-missing'); assert.equal(r.configExists, false); assert.equal(r.credentials, 'missing');
  fs.writeFileSync(path.join(h, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, projects: { [h]: { hasTrustDialogAccepted: true }, [path.join(h, 'other')]: { hasTrustDialogAccepted: true } } }));
  r = readClaudeTrust(task, o);
  assert.equal(r.trusted, false); assert.equal(r.reason, 'no-trusted-ancestor'); assert.equal(r.projectCount, 2); assert.equal(r.onboarding, true);
  fs.writeFileSync(path.join(h, '.claude.json'), JSON.stringify({ projects: { [root + '/']: { hasTrustDialogAccepted: true } } }));
  r = readClaudeTrust(task, o);
  assert.equal(r.trusted, true); assert.equal(r.trustedRoot, root + '/');
  fs.mkdirSync(path.join(h, '.claude')); fs.writeFileSync(path.join(h, '.claude', '.credentials.json'), '{}');
  assert.equal(readClaudeTrust(task, o).credentials, 'present');
  // a zero-filled file (ntfs after a hard reset) is reported as such, not as "untrusted"
  fs.writeFileSync(path.join(h, '.claude.json'), Buffer.alloc(64));
  r = readClaudeTrust(task, o);
  assert.equal(r.trusted, null); assert.equal(r.reason, 'config-unreadable'); assert.match(r.configError, /zero-filled/);
});
test('windows keys match across separators and case; CLAUDE_CONFIG_DIR is honoured when its .claude.json exists', (t) => {
  assert.equal(normalizeKey('G:/AgentbusTasks/', 'win32'), 'g:\\agentbustasks');
  assert.equal(normalizeKey('/Users/you/Desktop/', 'linux'), '/Users/you/Desktop');
  const h = home(t), cfg = path.join(h, 'alt'); fs.mkdirSync(cfg);
  assert.equal(claudeConfigFile({ CLAUDE_CONFIG_DIR: cfg }, h), path.join(h, '.claude.json'), 'falls back to the documented location when the override has no .claude.json');
  fs.writeFileSync(path.join(cfg, '.claude.json'), '{}');
  assert.equal(claudeConfigFile({ CLAUDE_CONFIG_DIR: cfg }, h), path.join(cfg, '.claude.json'));
  // windows keying is a pure string comparison, so it can be exercised on any host with win32-style paths
  fs.writeFileSync(path.join(h, '.claude.json'), JSON.stringify({ projects: { 'g:/agentbustasks': { hasTrustDialogAccepted: true } } }));
  const win = { platform: 'win32', env: {}, home: h };
  const r = readClaudeTrust('G:\\AgentbusTasks\\tasks\\abc', win);
  if (process.platform === 'win32') { assert.equal(r.trusted, true); assert.equal(r.trustedRoot, 'g:/agentbustasks'); }
  else assert.equal(r.trusted, false, 'path.resolve on posix cannot walk a drive path; the key logic itself is covered by normalizeKey');
});
test('seeding trust writes what the dialog writes, is idempotent, and refuses home and filesystem roots', (t) => {
  const h = home(t), root = path.join(h, 'tasks'); fs.mkdirSync(root);
  const o = { ...posix, home: h };
  let r = seedClaudeTrust([root], o);
  assert.deepEqual(r.seeded, [fs.realpathSync(root)]); assert.deepEqual(r.alreadyTrusted, []);
  const doc = JSON.parse(fs.readFileSync(path.join(h, '.claude.json'), 'utf8'));
  assert.equal(doc.hasCompletedOnboarding, true); assert.equal(doc.projects[fs.realpathSync(root)].hasTrustDialogAccepted, true); assert.equal(doc.projects[fs.realpathSync(root)].hasCompletedProjectOnboarding, true);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(h, '.claude.json')).mode & 0o777, 0o600);
  // existing unrelated keys survive; a second run changes nothing
  fs.writeFileSync(path.join(h, '.claude.json'), JSON.stringify({ ...doc, oauthAccount: { x: 1 }, projects: { ...doc.projects, '/elsewhere': { allowedTools: [] } } }));
  r = seedClaudeTrust([root], o);
  assert.deepEqual(r.seeded, []); assert.deepEqual(r.alreadyTrusted, [fs.realpathSync(root)]);
  const after = JSON.parse(fs.readFileSync(path.join(h, '.claude.json'), 'utf8'));
  assert.deepEqual(after.oauthAccount, { x: 1 }); assert.deepEqual(after.projects['/elsewhere'], { allowedTools: [] });
  assert.equal(readClaudeTrust(path.join(root, 'tasks', 'x'), o).trusted, true);
  assert.throws(() => seedClaudeTrust([h], o), /home directory/);
  assert.throws(() => seedClaudeTrust([path.parse(h).root], o), /filesystem root/);
  assert.throws(() => seedClaudeTrust(['relative'], o), /absolute/);
  fs.writeFileSync(path.join(h, '.claude.json'), Buffer.alloc(8));
  assert.throws(() => seedClaudeTrust([root], o), /not readable json/);
});
test('a trust refusal is classified by whose profile claude read and whether that profile has a desktop', () => {
  const missing = { configExists: false, credentials: 'missing', trusted: null };
  assert.equal(classifyTrustFailure(missing, { headless: true }), 'headless-profile');
  assert.equal(classifyTrustFailure(missing, { headless: false }), 'profile-without-claude-state');
  assert.equal(classifyTrustFailure({ configExists: true, credentials: 'present', trusted: null }, { headless: false }), 'config-unreadable');
  assert.equal(classifyTrustFailure({ configExists: true, credentials: 'present', trusted: false }, { headless: true }), 'profile-untrusted');
  assert.equal(classifyTrustFailure({ configExists: true, credentials: 'present', trusted: true }, null), 'trusted-anyway');
});
test('windows session probe parses the powershell answer and degrades to nulls', async () => {
  let s = await windowsSessionContext({ run: async () => JSON.stringify({ sessionId: 0, interactive: false, consoleUser: null, userProfile: 'C:\\Windows\\system32\\config\\systemprofile' }) });
  assert.deepEqual(s, { sessionId: 0, interactive: false, consoleUser: null, userProfile: 'C:\\Windows\\system32\\config\\systemprofile' });
  s = await windowsSessionContext({ run: async () => JSON.stringify({ sessionId: 1, interactive: true, consoleUser: 'HOST\\owner', userProfile: 'C:\\Users\\you' }) });
  assert.equal(s.sessionId, 1); assert.equal(s.consoleUser, 'HOST\\owner');
  s = await windowsSessionContext({ run: async () => null });
  assert.equal(s.sessionId, null); assert.match(s.error, /unavailable/);
  s = await windowsSessionContext({ run: async () => 'garbage' });
  assert.equal(s.sessionId, null);
});
test('diagnosis names the account, the file claude read and the case; headless session 0 without claude state is not "untrusted"', async (t) => {
  const h = home(t), cwd = path.join(h, 'tasks', 'job'); fs.mkdirSync(cwd, { recursive: true });
  const session = async () => ({ sessionId: 0, interactive: false, consoleUser: null, userProfile: h });
  let d = await diagnoseTrustFailure(cwd, { platform: 'win32', env: {}, home: h, session, fresh: true });
  assert.equal(d.kind, 'headless-profile');
  assert.match(d.summary, /^\[headless-profile\] launcher account \S+, home .*windows session 0 \(no console user\); .*\.claude\.json: missing; credentials missing\. the launcher runs in a windows session with no interactive desktop/);
  assert.equal(d.context.headless, true); assert.equal(d.context.claudeConfig, 'missing');
  fs.writeFileSync(path.join(h, '.claude.json'), JSON.stringify({ projects: { [path.join(h, 'elsewhere')]: { hasTrustDialogAccepted: true } } }));
  d = await diagnoseTrustFailure(cwd, { ...posix, home: h, fresh: true });
  assert.equal(d.kind, 'profile-untrusted'); assert.match(d.summary, /1 project\(s\), no trusted ancestor/); assert.equal(d.context.headless, false);
  fs.writeFileSync(path.join(h, '.claude.json'), JSON.stringify({ projects: { [path.join(h, 'tasks')]: { hasTrustDialogAccepted: true } } }));
  d = await diagnoseTrustFailure(cwd, { ...posix, home: h, fresh: true });
  assert.equal(d.kind, 'trusted-anyway'); assert.match(d.summary, /trusted via/);
  const ctx = await launchContext({ ...posix, home: h, fresh: true });
  assert.equal(typeof ctx.account, 'string'); assert.equal(ctx.headless, false); assert.equal(ctx.windowsSessionId, undefined);
});
test('a claude --bg trust refusal fails the launch with the diagnosis in the receipt and status', async (t) => {
  const bus = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-trust-worker-')); t.after(() => fs.rmSync(bus, { recursive: true, force: true }));
  const cwd = path.join(bus, 'work'); fs.mkdirSync(cwd);
  // a fake claude: refuses the workspace the way the real one does from a script
  const fake = path.join(bus, 'claude.mjs');
  fs.writeFileSync(fake, "process.stderr.write('Workspace not trusted. Run `claude` in ' + process.cwd() + ' once and accept the trust prompt, then retry\\n'); process.exit(1);\n");
  const wrapper = path.join(bus, process.platform === 'win32' ? 'claude.cmd' : 'claude');
  if (process.platform === 'win32') fs.writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" "${fake}" %*\r\n`);
  else { fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`); fs.chmodSync(wrapper, 0o755); }
  const fakeHome = path.join(bus, 'home'); fs.mkdirSync(fakeHome);
  writeLaunch(path.join(bus, 'launch-config.json'), { enabled: true, remote: true, roots: [cwd], maxSessions: 2, runtimes: { claude: wrapper } });
  const launcher = createLauncher({ busDir: bus, capabilities: () => ({ runtimes: { 'claude-code': true } }), startWorker: (file) => {
    // the worker resolves claude's state from its own home: point it at an empty one so the diagnosis is deterministic
    const env = { ...process.env, AGENTBUS_DIR: bus, HOME: fakeHome, USERPROFILE: fakeHome };
    delete env.CLAUDE_CONFIG_DIR;
    spawn(process.execPath, [fileURLToPath(new URL('../bin/session-worker.mjs', import.meta.url)), file], { stdio: 'ignore', env, detached: true }).unref();
  } });
  const id = '0b7a4b1e-7c6b-4d6e-9f1c-2a3b4c5d6e7f';
  await launcher.launch({ id, runtime: 'claude-code', cwd, prompt: 'hello' });
  const file = path.join(bus, 'launches', id + '.json');
  let record; const end = Date.now() + 20000;
  while (Date.now() < end) { record = readLaunch(file); if (record?.state === 'failed') break; await sleep(50); }
  assert.equal(record.state, 'failed', JSON.stringify(record));
  assert.match(record.error, /Workspace not trusted/);
  assert.match(record.error, /\[(profile-without-claude-state|headless-profile)\] launcher account/);
  assert.equal(record.claudeTrust.configExists, false); assert.equal(record.claudeTrust.trusted, null);
  assert.equal(record.launchContext.claudeConfig, 'missing');
  const status = await launcher.status(id);
  assert.equal(status.ok, false); assert.equal(status.state, 'failed');
  assert.equal(status.trustDiagnosis, record.trustDiagnosis); assert.equal(status.launchContext.claudeConfig, 'missing');
  assert.equal(status.claudeTrust.configExists, false);
});
