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

export async function launchDesktop({ timeoutMs = 30000 } = {}) {
  if (process.platform !== 'darwin') throw Error('desktop launcher requires macos');
  const busDir = process.env.AGENTBUS_DIR || path.join(os.homedir(), '.agentbus');
  const config = JSON.parse(fs.readFileSync(path.join(busDir, 'bridge-config.json'), 'utf8'));
  const args = desktopLaunchArgs(config);
  fs.accessSync(config.wrapper, fs.constants.X_OK);
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
