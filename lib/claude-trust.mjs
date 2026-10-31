// Claude code workspace trust, as seen from the account that launches background sessions.
//
// `claude --bg` refuses an untrusted workspace with "Workspace not trusted" and no dialog can appear from a
// daemon (docs: permissions, "Background sessions"). Trust lives in the launching account's `.claude.json`
// under projects[<path>].hasTrustDialogAccepted, and the oauth login in <config dir>/.credentials.json
// (windows/linux) or the keychain (macos). Both are resolved relative to the launching process's home, so a
// daemon started by a boot task in a profile other than the one that accepted trust and logged in sees
// neither, and claude's generic trust error hides that. This module reads the same state claude reads and
// turns the failure into a diagnosis: headless profile without claude state, or a genuinely untrusted folder.
// It never decides for claude: claude's own check stays authoritative; this only explains its answer.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { atomicWriteFileSync } from './atomic-file.mjs';

export const claudeConfigDir = (env = process.env, home = os.homedir()) => env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
// claude keeps .claude.json next to its config dir when CLAUDE_CONFIG_DIR is set (undocumented; the default
// location is documented). Prefer the override when it exists, otherwise the documented ~/.claude.json.
export function claudeConfigFile(env = process.env, home = os.homedir()) {
  if (env.CLAUDE_CONFIG_DIR) {
    const inDir = path.join(env.CLAUDE_CONFIG_DIR, '.claude.json');
    if (fs.existsSync(inDir)) return inDir;
  }
  return path.join(home, '.claude.json');
}
// windows keys in .claude.json appear with either separator and any case (claude-code #73269); unix keys are exact.
export const normalizeKey = (p, platform = process.platform) => {
  let s = String(p || '');
  if (platform === 'win32') s = s.replace(/\//g, '\\').toLowerCase();
  s = s.replace(/[\\/]+$/, '');
  return s;
};
function readConfig(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { exists: e.code !== 'ENOENT', readable: false, config: null, error: e.code || e.message }; }
  try { const config = JSON.parse(text); return { exists: true, readable: !!config && typeof config === 'object', config: config && typeof config === 'object' ? config : null, error: config && typeof config === 'object' ? null : 'not an object' }; }
  catch (e) { return { exists: true, readable: false, config: null, error: `invalid json (${text.length} bytes${/^\0*$/.test(text) ? ', zero-filled' : ''})` }; }
}
// realpath of the nearest existing ancestor with the missing tail re-appended (a task folder may not exist yet).
function realpathNearest(p) {
  let cur = path.resolve(p); const tail = [];
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...tail.reverse()); }
    catch { const parent = path.dirname(cur); if (parent === cur) return path.resolve(p); tail.push(path.basename(cur)); cur = parent; }
  }
}
// cwd as given and as resolved through symlinks: the dialog may have stored either form (macos /var vs /private/var).
function ancestors(cwd, platform) {
  const starts = [path.resolve(cwd)], real = realpathNearest(cwd);
  if (real !== starts[0]) starts.push(real);
  const out = [];
  for (let cur of starts) for (;;) { out.push(cur); const parent = path.dirname(cur); if (parent === cur) break; cur = parent; }
  return out.map((p) => ({ raw: p, key: normalizeKey(p, platform) }));
}
// What the launching account's claude state says about cwd. trusted is null when it cannot be read.
export function readClaudeTrust(cwd, { env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  const configFile = claudeConfigFile(env, home), configDir = claudeConfigDir(env, home);
  const { exists, readable, config, error } = readConfig(configFile);
  const credentialsFile = path.join(configDir, '.credentials.json');
  const credentials = platform === 'darwin' ? 'keychain-or-file' : fs.existsSync(credentialsFile) ? 'present' : 'missing';
  const base = { configFile, configExists: exists, configReadable: readable, configError: error, credentialsFile, credentials, onboarding: config ? config.hasCompletedOnboarding === true : null, projectCount: config?.projects && typeof config.projects === 'object' ? Object.keys(config.projects).length : 0 };
  if (!readable) return { ...base, trusted: null, trustedRoot: null, reason: exists ? 'config-unreadable' : 'config-missing' };
  const projects = config.projects && typeof config.projects === 'object' ? config.projects : {};
  const homeKeys = new Set([normalizeKey(home, platform), normalizeKey(realpathNearest(home), platform)]);
  const trustedKeys = new Map(Object.entries(projects).filter(([, v]) => v && v.hasTrustDialogAccepted === true).map(([k]) => [normalizeKey(k, platform), k]));
  // claude never persists trust for the home directory itself, so a stored key there is not evidence.
  const hit = ancestors(cwd, platform).find((a) => !homeKeys.has(a.key) && trustedKeys.has(a.key));
  return { ...base, trusted: !!hit, trustedRoot: hit ? trustedKeys.get(hit.key) : null, reason: hit ? 'trusted' : 'no-trusted-ancestor' };
}
// Mark launch roots trusted (and onboarding done) in the launching account's .claude.json, the way accepting the
// dialog does. This is the documented manual route for headless hosts (docs: permissions, "what runs before you
// trust a folder") and what the runpod pod image does for its task root. Only existing directories that are not
// the home directory or a filesystem root are accepted. Write with no claude session open: claude rewrites this
// file on exit and can clobber a concurrent edit.
export function seedClaudeTrust(roots, { env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  const configFile = claudeConfigFile(env, home);
  const { exists, readable, config, error } = readConfig(configFile);
  if (exists && !readable) throw Error(`${configFile} exists but is not readable json (${error}); repair or move it aside before seeding trust`);
  const next = { ...(config || {}) }, projects = { ...(next.projects && typeof next.projects === 'object' ? next.projects : {}) };
  const homeKeys = new Set([normalizeKey(home, platform), normalizeKey(realpathNearest(home), platform)]), seeded = [], alreadyTrusted = [];
  for (const given of roots) {
    if (typeof given !== 'string' || !path.isAbsolute(given)) throw Error('trust roots must be absolute paths');
    const root = fs.realpathSync(given);
    if (!fs.statSync(root).isDirectory()) throw Error(`${root} is not a directory`);
    const key = normalizeKey(root, platform);
    if (homeKeys.has(key) || key === normalizeKey(path.parse(root).root, platform)) throw Error(`refusing to trust ${root}: claude does not persist trust for a home directory or a filesystem root`);
    const existing = Object.keys(projects).find((k) => normalizeKey(k, platform) === key) || root;
    if (projects[existing]?.hasTrustDialogAccepted === true) { alreadyTrusted.push(existing); continue; }
    projects[existing] = { ...(projects[existing] || {}), hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true };
    seeded.push(existing);
  }
  next.projects = projects; next.hasCompletedOnboarding = true;
  if (seeded.length || !exists) atomicWriteFileSync(configFile, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, fsync: true });
  return { configFile, seeded, alreadyTrusted, note: 'trust only; a background launch still needs this account\'s claude login (credentials in its config dir)' };
}
const WIN_SESSION = "ConvertTo-Json -Compress @{ sessionId = (Get-Process -Id $PID).SessionId; interactive = [Environment]::UserInteractive; consoleUser = (Get-CimInstance Win32_ComputerSystem).UserName; userProfile = $env:USERPROFILE }";
function runPowershell(args, timeout) {
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve) => execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', ...args], { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 1 << 20 }, (e, out) => resolve(e ? null : out)));
}
// Which windows session the launcher lives in and who, if anyone, is at the console. Session 0 (services, boot
// tasks) has no interactive desktop; a boot-task daemon stays there even after someone signs in.
export async function windowsSessionContext({ run = runPowershell, timeoutMs = 8000 } = {}) {
  const out = await run([WIN_SESSION], timeoutMs);
  if (!out) return { sessionId: null, interactive: null, consoleUser: null, userProfile: null, error: 'session probe unavailable' };
  try {
    const v = JSON.parse(out);
    return { sessionId: Number.isInteger(v.sessionId) ? v.sessionId : null, interactive: typeof v.interactive === 'boolean' ? v.interactive : null, consoleUser: typeof v.consoleUser === 'string' && v.consoleUser ? v.consoleUser : null, userProfile: typeof v.userProfile === 'string' ? v.userProfile : null };
  } catch { return { sessionId: null, interactive: null, consoleUser: null, userProfile: null, error: 'session probe returned no json' }; }
}
// The launcher's own identity as claude would see it. Cached per process: it cannot change while we run.
let contextPromise = null;
export function launchContext({ env = process.env, home = os.homedir(), platform = process.platform, session = windowsSessionContext, fresh = false } = {}) {
  if (contextPromise && !fresh) return contextPromise;
  contextPromise = (async () => {
    let account = null; try { account = os.userInfo().username; } catch {}
    const configFile = claudeConfigFile(env, home), configDir = claudeConfigDir(env, home);
    const win = platform === 'win32' ? await session() : null;
    return { account, home, configFile, claudeConfig: fs.existsSync(configFile) ? 'present' : 'missing', claudeCredentials: platform === 'darwin' ? 'keychain-or-file' : fs.existsSync(path.join(configDir, '.credentials.json')) ? 'present' : 'missing',
      ...(win ? { windowsSessionId: win.sessionId, interactive: win.interactive, consoleUser: win.consoleUser, headless: win.sessionId === 0 || win.interactive === false } : { headless: false }), checkedAt: Date.now() };
  })();
  return contextPromise;
}
// kinds: headless-profile (launcher runs outside an interactive session and its profile holds no claude state),
// profile-untrusted (profile has claude state, cwd has no trusted ancestor), config-unreadable, trusted-anyway
// (claude refused what this profile says is trusted: path keying or a claude bug), unknown.
export function classifyTrustFailure(trust, context) {
  const noState = !trust.configExists && trust.credentials === 'missing';
  if (context?.headless && (noState || !trust.configExists)) return 'headless-profile';
  if (!trust.configExists) return 'profile-without-claude-state';
  if (trust.trusted === null) return 'config-unreadable';
  if (trust.trusted === true) return 'trusted-anyway';
  return 'profile-untrusted';
}
export const TRUST_ADVICE = {
  'headless-profile': 'the launcher runs in a windows session with no interactive desktop, under a profile that has no claude config; this is a headless-host problem, not a folder-trust problem. run the daemon in the profile that accepted trust and is logged in (sign in and start the interactive daemon, or register the task with a stored password so that account\'s profile loads), or seed trust for the launch roots in this profile with `agentbus sessions trust-claude-roots` and log claude in there',
  'profile-without-claude-state': 'the launching account has never run claude: no .claude.json. accept trust and log in as this account, or seed trust with `agentbus sessions trust-claude-roots` and log in',
  'config-unreadable': 'the launching account\'s .claude.json is not valid json (a hard reset can zero-fill it); restore it from a backup or run `claude` interactively once as this account to recreate it, then re-accept trust',
  'trusted-anyway': 'this profile marks an ancestor of the workspace trusted, yet claude refused it: compare the stored key with the path claude checks (separator and case on windows, git root inside a repository) and retry',
  'profile-untrusted': 'no ancestor of the workspace is trusted in the launching account\'s .claude.json: run `claude` in that folder once as this account and accept the trust dialog, or seed the launch root with `agentbus sessions trust-claude-roots`',
  unknown: 'inspect the launching account\'s .claude.json and credentials',
};
export async function diagnoseTrustFailure(cwd, options = {}) {
  const trust = readClaudeTrust(cwd, options);
  let context = null; try { context = await launchContext(options); } catch {}
  const kind = classifyTrustFailure(trust, context);
  const where = context ? `launcher account ${context.account || 'unknown'}, home ${context.home}${context.windowsSessionId !== undefined ? `, windows session ${context.windowsSessionId ?? '?'}${context.consoleUser ? ` (console user ${context.consoleUser})` : ' (no console user)'}` : ''}` : `home ${trust.configFile.replace(/[\\/]\.claude\.json$/, '')}`;
  const state = `${trust.configFile}: ${trust.configExists ? trust.configReadable ? `${trust.projectCount} project(s), ${trust.trusted ? `trusted via ${trust.trustedRoot}` : 'no trusted ancestor'}` : `unreadable (${trust.configError})` : 'missing'}; credentials ${trust.credentials}`;
  return { kind, trust, context, summary: `[${kind}] ${where}; ${state}. ${TRUST_ADVICE[kind] || TRUST_ADVICE.unknown}` };
}
