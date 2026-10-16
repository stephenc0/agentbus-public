import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { requestBridge, listBridges } from './codex-push.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const bus = process.env.AGENTBUS_DIR || path.join(os.homedir(), '.agentbus');
const configPath = path.join(bus, 'bridge-config.json');
const label = 'local.agentbus.codex-bridge';
const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
const shellQuote = (v) => "'" + v.replaceAll("'", "'\\''") + "'";
const xml = (v) => v.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const getEnv = () => { if (process.platform !== 'darwin') return process.env.CODEX_CLI_PATH || ''; try { return execFileSync('/bin/launchctl', ['getenv', 'CODEX_CLI_PATH'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };

export async function withAppServer(binary, work) {
  const child = spawn(binary, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let count = 0;
  child.stderr.resume();
  const lines = readline.createInterface({ input: child.stdout });
  const fail = (error) => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); };
  child.on('error', fail); child.on('exit', () => fail(Error('app-server exited')));
  lines.on('line', (line) => {
    let m; try { m = JSON.parse(line); } catch { return; }
    const p = pending.get(m.id); if (!p) return;
    pending.delete(m.id); clearTimeout(p.timer);
    m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result);
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++count;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`${method} timeout`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  try {
    await rpc('initialize', { clientInfo: { name: 'agentbus_setup', version: '0.3.0' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    return await work(rpc);
  } finally { lines.close(); child.stdin.end(); child.kill(); fail(Error('setup complete')); }
}

export async function installBridge(binary) {
  // windows: the desktop app treats a CODEX_CLI_PATH override as "not the app-contained core". it skips
  // contained-core startup and strips CODEX_WINDOWS_REGISTERED_CORE / CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY,
  // which changes how codex reaches its sandbox service. a bridge would weaken sandboxing, so refuse.
  if (process.platform === 'win32') throw Error('codex desktop bridge is not supported on windows: overriding CODEX_CLI_PATH disables the app-contained core and its sandbox service wiring. use hooks (README: windows codex)');
  if (process.platform !== 'darwin') throw Error('desktop installation currently supports macos only');
  fs.mkdirSync(bus, { recursive: true, mode: 0o700 });
  let previous; try { previous = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
  binary ||= previous?.binary || execFileSync('/usr/bin/which', ['codex'], { encoding: 'utf8' }).trim();
  binary = fs.realpathSync(binary);
  const wrapper = path.join(bus, 'codex-bridge');
  if (binary === wrapper || binary === path.join(root, 'bin/codex-bridge.mjs')) throw Error('real codex binary required');
  fs.accessSync(binary, fs.constants.X_OK);
  const priorEnv = previous?.priorEnv ?? getEnv();
  const config = { binary, wrapper, priorEnv };
  if (fs.existsSync(configPath)) fs.copyFileSync(configPath, configPath + '.bak');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(path.join(root, 'bin/codex-bridge.mjs'))} "$@"\n`, { mode: 0o700 });
  fs.chmodSync(wrapper, 0o700);
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(path.join(root, 'bin/agentbus.mjs'))}</string><string>launch-codex</string><string>--at-login</string></array><key>RunAtLoad</key><true/><key>StandardOutPath</key><string>${xml(path.join(bus, 'desktop-launch.log'))}</string><key>StandardErrorPath</key><string>${xml(path.join(bus, 'desktop-launch.log'))}</string></dict></plist>\n`, { mode: 0o600 });
  execFileSync('/usr/bin/plutil', ['-lint', plist]);
  execFileSync('/bin/launchctl', ['setenv', 'CODEX_CLI_PATH', wrapper]);
  return { configured: getEnv() === wrapper, binary, wrapper, plist, activation: 'restart the desktop app to activate; current sessions are unchanged' };
}

export function uninstallBridge() {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  try { execFileSync('/bin/launchctl', ['bootout', `gui/${process.getuid()}/${label}`], { stdio: 'ignore' }); } catch {}
  if (getEnv() === config.wrapper) execFileSync('/bin/launchctl', config.priorEnv ? ['setenv', 'CODEX_CLI_PATH', config.priorEnv] : ['unsetenv', 'CODEX_CLI_PATH']);
  fs.rmSync(plist, { force: true });
  // Keep the wrapper/config for still-running clients; only remove activation.
  return { configured: false, activation: 'restart the desktop app to stop using the bridge' };
}

export async function bridgeStatus(threadId, { busDir = bus, launcherOverride = getEnv() } = {}) {
  threadId = threadId?.replace(/^codex:/, '');
  let config; try { config = JSON.parse(fs.readFileSync(path.join(busDir, 'bridge-config.json'), 'utf8')); } catch {}
  const bridges = await Promise.all(listBridges(busDir).map(async ({ entry, endpoint }) => ({ socket: entry, ...(await requestBridge(endpoint, { op: 'status', ...(threadId ? { threadId } : {}) }, threadId ? 12000 : 1000)) })));
  const readyBridges = bridges.filter((b) => b.status === 'accepted' && b.ready);
  const owningBridge = threadId ? readyBridges.find((b) => b.ownsThread === true) : undefined;
  return { launcherOverride: launcherOverride || null, configured: !!config && launcherOverride === config.wrapper, config: config || null,
    liveReady: readyBridges.length > 0, ...(threadId ? { threadId, deliveryReady: !!owningBridge, owningBridgePid: owningBridge?.pid ?? null } : {}), bridges,
    note: threadId ? (owningBridge ? 'live owning bridge verified' : 'no live owning bridge verified; queued mail requires hooks or explicit inbox reads') : 'liveReady does not establish ownership; use --thread ID to verify delivery readiness' };
}
