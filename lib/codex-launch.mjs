import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { bridgeStatus } from './codex-install.mjs';

export function desktopLaunchArgs(config) {
  // Use the outer application, not the embedded CodexCLI.app.
  const match = config.binary.match(/^(.*?\.app)\/Contents\//);
  if (!match || !path.isAbsolute(config.wrapper)) throw Error('desktop bundle and absolute wrapper required');
  return ['-a', match[1], '--env', `CODEX_CLI_PATH=${config.wrapper}`];
}

// ps etime: [[dd-]hh:]mm:ss -> seconds
export function etimeSeconds(etime) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(etime || '').trim());
  return m ? ((Number(m[1] || 0) * 24 + Number(m[2] || 0)) * 60 + Number(m[3])) * 60 + Number(m[4]) : null;
}
// At login the desktop app may be restored by macos before this launcher runs, without the bridge
// environment. Relaunching is only safe when nothing can be lost: the app started moments ago and no codex
// turn is running. Anything else keeps the conservative refusal (never kill a possibly working app).
export function restoredAppSafeToRelaunch({ appAgeSec, busyThreads, maxAgeSec = 240 }) {
  return Number.isFinite(appAgeSec) && appAgeSec <= maxAgeSec && busyThreads === 0;
}
function appMainProcess(appPath) {
  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,etime=,comm='], { encoding: 'utf8' }).split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/)).filter(Boolean);
  const main = rows.find((r) => r[3].startsWith(appPath + '/Contents/MacOS/') && !r[3].includes('/Helpers/'));
  return main ? { pid: Number(main[1]), ageSec: etimeSeconds(main[2]) } : null;
}
async function quitGracefully(appPath, pid, timeoutMs = 20000) {
  // the same as cmd-q: the app saves state and exits on its own. no signals.
  execFileSync('/usr/bin/osascript', ['-e', `tell application ${JSON.stringify(appPath)} to quit`], { timeout: 15000 });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return true; }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

export async function launchDesktop({ timeoutMs = 30000, atLogin = false, log = (s) => process.stderr.write(s + '\n') } = {}) {
  if (process.platform !== 'darwin') throw Error('desktop launcher requires macos');
  const busDir = process.env.AGENTBUS_DIR || path.join(os.homedir(), '.agentbus');
  const config = JSON.parse(fs.readFileSync(path.join(busDir, 'bridge-config.json'), 'utf8'));
  const args = desktopLaunchArgs(config);
  fs.accessSync(config.wrapper, fs.constants.X_OK);
  if (atLogin) {
    const running = appMainProcess(args[1]);
    const ready = (await bridgeStatus()).bridges.some((b) => b.ready && b.status === 'accepted');
    if (running && !ready) {
      const { listAgents } = await import('./core.mjs');
      const busyThreads = listAgents().filter((a) => a.kind === 'codex' && a.status === 'busy').length;
      if (restoredAppSafeToRelaunch({ appAgeSec: running.ageSec, busyThreads })) {
        log(`${new Date().toISOString()} login: ${args[1]} was restored without the bridge ${running.ageSec}s ago and runs no turn; quitting it normally to relaunch bridged`);
        if (!(await quitGracefully(args[1], running.pid))) throw Error('restored app did not quit normally within 20s; left running, nothing killed');
      } else log(`${new Date().toISOString()} login: unbridged app running for ${running.ageSec}s with ${busyThreads} busy thread(s); not touching it`);
    }
  }
  // Retain the default for subsequent ordinary launches, but do not rely on
  // login-item ordering or inherited launchd environment for this launch.
  execFileSync('/bin/launchctl', ['setenv', 'CODEX_CLI_PATH', config.wrapper]);
  execFileSync('/usr/bin/open', args);
  const deadline = Date.now() + timeoutMs;
  do {
    const status = await bridgeStatus();
    const processes = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' })
      .split('\n').map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)).filter(Boolean);
    const appPids = new Set(processes.filter((p) => p[3].startsWith(args[1] + '/Contents/MacOS/')).map((p) => Number(p[1])));
    const owner = status.bridges.find((b) => b.ready && b.status === 'accepted' && processes.some((p) => Number(p[1]) === b.pid && appPids.has(Number(p[2]))));
    if (owner) return { desktopReady: true, bridgePid: owner.pid, application: args[1] };
    await new Promise((r) => setTimeout(r, 500));
  } while (Date.now() < deadline);
  // Never kill an existing app automatically: it may own running research.
  throw Error('desktop bridge not ready. an already running app cannot inherit a new environment; checkpoint it, quit normally, then run agentbus launch-codex. no processes were stopped');
}
