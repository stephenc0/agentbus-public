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
const psRows = () => execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,etime=,comm='], { encoding: 'utf8' }).split('\n')
  .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/)).filter(Boolean)
  .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), ageSec: etimeSeconds(m[3]), comm: m[4] }));
export function appMainProcess(rows, appPath) {
  const main = rows.find((r) => r.comm.startsWith(appPath + '/Contents/MacOS/') && !r.comm.includes('/Helpers/'));
  return main ? { pid: main.pid, ageSec: main.ageSec } : null;
}
// a ready bridge counts only when its process is a child of this app's own processes, not a stale or cli bridge.
export function bridgeOwner(bridges, rows, appPath) {
  const appPids = new Set(rows.filter((r) => r.comm.startsWith(appPath + '/Contents/MacOS/')).map((r) => r.pid));
  return bridges.find((b) => b.ready && b.status === 'accepted' && rows.some((r) => r.pid === b.pid && appPids.has(r.ppid))) || null;
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
const realSystem = () => ({
  ps: psRows, bridges: async () => (await bridgeStatus()).bridges, quit: quitGracefully, now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  setenv: (wrapper) => execFileSync('/bin/launchctl', ['setenv', 'CODEX_CLI_PATH', wrapper]), open: (args) => execFileSync('/usr/bin/open', args),
  busyThreads: async () => { const { listAgents } = await import('./core.mjs'); return listAgents().filter((a) => a.kind === 'codex' && a.status === 'busy').length; },
});
const REFUSAL = 'desktop bridge not ready. an already running app cannot inherit a new environment; checkpoint it, quit normally, then run agentbus launch-codex. no processes were stopped';

// Login runs race whatever else opens the app (a login item, macos window restore, the user clicking it): the
// app can appear before or just after `open` and then lacks the bridge env. So at login: exit 0 without touching
// anything if the app is already bridged; otherwise loop (bounded) launching it, and quit+relaunch only an app
// that is idle and either started after this job did or within maxAgeSec of it. an older or busy app is the
// user's: refuse and leave it running, as interactive runs always do.
export async function launchDesktop({ timeoutMs = 30000, atLogin = false, loginBudgetMs = 180000, maxRelaunches = 3, maxAgeSec = 240, log = (s) => process.stderr.write(s + '\n'), system, config: given } = {}) {
  if (!system && process.platform !== 'darwin') throw Error('desktop launcher requires macos');
  const sys = system || realSystem();
  const config = given || JSON.parse(fs.readFileSync(path.join(process.env.AGENTBUS_DIR || path.join(os.homedir(), '.agentbus'), 'bridge-config.json'), 'utf8'));
  const args = desktopLaunchArgs(config), app = args[1];
  if (!system) fs.accessSync(config.wrapper, fs.constants.X_OK);
  const stamp = () => new Date(sys.now()).toISOString();
  const owner = async () => bridgeOwner(await sys.bridges(), sys.ps(), app);
  const ready = (o, action) => ({ desktopReady: true, bridgePid: o.pid, application: app, action });
  const waitBridge = async (ms) => {
    const deadline = sys.now() + ms;
    do { const o = await owner(); if (o) return o; await sys.sleep(500); } while (sys.now() < deadline);
    return null;
  };
  const launch = async () => {
    // Retain the default for subsequent ordinary launches, but do not rely on
    // login-item ordering or inherited launchd environment for this launch.
    sys.setenv(config.wrapper); sys.open(args);
    return waitBridge(timeoutMs);
  };
  if (!atLogin) {
    const o = await launch();
    if (o) return ready(o, 'launched');
    // Never kill an existing app automatically: it may own running research.
    throw Error(REFUSAL);
  }
  const started = sys.now();
  let o = await owner();
  if (o) { log(`${stamp()} login: ${app} already bridged (pid ${o.pid}); nothing to do`); return ready(o, 'already-bridged'); }
  for (let relaunches = 0; sys.now() - started < loginBudgetMs;) {
    const running = appMainProcess(sys.ps(), app);
    if (!running) {
      if ((o = await launch())) { log(`${stamp()} login: launched ${app} bridged`); return ready(o, 'launched'); }
      log(`${stamp()} login: launched ${app} but no bridge within ${timeoutMs / 1000}s; another launch probably won the race, re-checking`);
      continue;
    }
    // something else opened it after our setenv: it may have inherited the env anyway, so give it a moment first.
    sys.setenv(config.wrapper);
    if ((o = await waitBridge(Math.min(timeoutMs, 15000)))) { log(`${stamp()} login: ${app} came up bridged`); return ready(o, 'bridged'); }
    const busyThreads = await sys.busyThreads(), sinceStartSec = Math.round((sys.now() - started) / 1000);
    if (relaunches >= maxRelaunches || !restoredAppSafeToRelaunch({ appAgeSec: running.ageSec, busyThreads, maxAgeSec: maxAgeSec + sinceStartSec })) {
      log(`${stamp()} login: unbridged app running for ${running.ageSec}s with ${busyThreads} busy thread(s) after ${relaunches} relaunch(es); not touching it`);
      throw Error(REFUSAL);
    }
    relaunches++;
    log(`${stamp()} login: ${app} opened without the bridge ${running.ageSec}s ago and runs no turn; quitting it normally to relaunch bridged (${relaunches}/${maxRelaunches})`);
    if (!(await sys.quit(app, running.pid))) throw Error('restored app did not quit normally within 20s; left running, nothing killed');
  }
  throw Error(`desktop bridge not ready within ${loginBudgetMs / 1000}s of login; nothing killed`);
}
