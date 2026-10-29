// the one place that knows where the tailscale cli lives. PATH first (the user's choice), then the platform's fixed spots:
// the macos app bundles (app store and standalone) never link `tailscale` into PATH, the windows installer puts it
// under program files, linux packages use /usr/bin or /usr/local/bin. every candidate that exists is tried in order
// until one answers, so a cli on PATH whose daemon is not running does not shadow the app bundle's.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const TAILSCALE_APP_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
export function tailscaleCandidates({ platform = process.platform, env = process.env } = {}) {
  const win = platform === 'win32', p = win ? path.win32 : path.posix, exe = win ? 'tailscale.exe' : 'tailscale';
  const fromPath = String(env.PATH ?? env.Path ?? '').split(win ? ';' : ':').map((d) => d.trim()).filter(Boolean).map((d) => p.join(d, exe));
  const fixed = platform === 'darwin' ? [TAILSCALE_APP_CLI, '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale']
    : win ? [...new Set([env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)']].filter(Boolean))].map((pf) => p.join(pf, 'Tailscale', exe))
    : ['/usr/bin/tailscale', '/usr/local/bin/tailscale', '/usr/sbin/tailscale'];
  return [...new Set([...fromPath, ...fixed])];
}
export function locateTailscale({ platform, env, exists = fs.existsSync } = {}) {
  return tailscaleCandidates({ platform, env }).filter((bin) => { try { return exists(bin); } catch { return false; } });
}
// run `tailscale <args>` and return stdout, or '' when no cli answers. the last binary that answered is tried first.
export function createTailscaleRunner({ exec = execFileSync, locate = locateTailscale, timeout = 5000 } = {}) {
  let preferred = null;
  const run = (args) => {
    const found = locate();
    const order = preferred && found.includes(preferred) ? [preferred, ...found.filter((b) => b !== preferred)] : found;
    for (const bin of order) {
      try { const out = exec(bin, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, maxBuffer: 8 * 1024 * 1024 }); preferred = bin; return String(out ?? ''); }
      catch { preferred = preferred === bin ? null : preferred; }
    }
    return '';
  };
  run.binary = () => preferred;
  return run;
}
export const runTailscale = createTailscaleRunner();
// parsed `tailscale status --json` (ipnstate.Status), or null when the cli is missing, tailscaled is down or the output
// is not json. the parsed object is handed to callers as is; nothing from it is logged here.
export function tailscaleStatus(run = runTailscale) {
  const text = run(['status', '--json']);
  if (!text) return null;
  try { const status = JSON.parse(text); return status && typeof status === 'object' && !Array.isArray(status) ? status : null; } catch { return null; }
}
