import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadLan } from './lan.mjs';
const label = 'local.agentbus.lan';
const plistPath = path.join(os.homedir(), 'Library/LaunchAgents', `${label}.plist`);
const xml = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
// windows: per-user logon task (no elevation needed). task scheduler's restart-on-failure doesn't
// cover a process that simply exits, so a generated .cmd loop is the keepalive. conhost --headless
// keeps windows terminal from popping a console in the interactive session.
const taskName = 'agentbus-lan';
const schtasks = (args) => execFileSync('schtasks', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
// a restart must not take launched sessions with it. session-worker supervisors are spawned detached by the daemon
// but still name it as ParentProcessId, so `taskkill /t` from the runner reached them (and their runtimes). walk the
// runner's descendants ourselves and spare each session-worker subtree. identity is (pid, creation time): a process
// created before the parent it names holds a reused pid and is not a descendant. roots: already-killed identities
// to rescan for children forked between snapshot and kill.
// a worker is node running session-worker.mjs as its entry script; the path appearing in any later argument is not one.
const isWorker = (p) => /^node(\.exe)?$/i.test(p.name || '') && /[\\/]session-worker\.mjs$/i.test((/^\s*(?:"[^"]*"|\S+)\s+("[^"]*"|\S+)/.exec(p.cmd || '')?.[1] || '').replaceAll('"', ''));
export function runnerTargets(procs, runner, roots = null) {
  const at = (p) => Date.parse(p.created) || 0, key = runner.toLowerCase();
  const start = roots || procs.filter((p) => /^cmd\.exe$/i.test(p.name || '') && (p.cmd || '').toLowerCase().includes(key));
  const seen = new Set(start.map((p) => p.pid)), all = [...start], spared = [];
  for (let i = 0; i < all.length; i++) for (const c of procs) {
    if (c.ppid !== all[i].pid || seen.has(c.pid) || at(c) < at(all[i])) continue;
    seen.add(c.pid);
    if (isWorker(c)) spared.push(c); else all.push(c);
  }
  return { kill: roots ? all.slice(start.length) : all, spared };
}
const SNAPSHOT = `ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,Name,CommandLine | ForEach-Object { @{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; created = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') } else { $null }); name = $_.Name; cmd = $_.CommandLine } })`;
const snapshot = () => JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SNAPSHOT], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20 }));
// runner loop first so it cannot respawn the daemon, then top-down without /t. the daemon's non-detached children
// sit in libuv's kill-on-close job and go with it.
export function killRunners(runner, { list = snapshot, kill = (pid) => execFileSync('taskkill', ['/pid', String(pid), '/f'], { stdio: 'ignore', windowsHide: true }) } = {}) {
  let first; try { first = runnerTargets(list(), runner); } catch { return { killed: [], spared: [] }; }
  const end = (ps) => ps.forEach((p) => { try { kill(p.pid); } catch {} });
  end(first.kill);
  let late = { kill: [], spared: [] }; try { late = runnerTargets(list(), runner, first.kill); } catch {}
  end(late.kill);
  return { killed: [...first.kill, ...late.kill].map((p) => p.pid), spared: [...new Set([...first.spared, ...late.spared].map((p) => p.pid))] };
}
const taskExists = () => { try { schtasks(['/query', '/tn', taskName]); return true; } catch { return false; } };
function installWindows(config) {
  const script = fileURLToPath(new URL('../bin/agentbus.mjs', import.meta.url));
  const runner = path.join(config.dir, 'lan-serve.cmd'), log = path.join(config.dir, 'daemon.log');
  if ([process.execPath, script, runner, log, config.dir].some((p) => /["%^&|<>]/.test(p))) throw Error('paths containing cmd metacharacters are not supported');
  fs.writeFileSync(runner, ['@echo off', `set "AGENTBUS_DIR=${path.dirname(config.dir)}"`, ':loop',
    `"${process.execPath}" "${script}" lan serve >> "${log}" 2>&1`,
    'ping -n 11 127.0.0.1 >nul', 'goto loop', ''].join('\r\n'));
  const user = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
  const task = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>agentbus lan daemon (mdns discovery + tls-psk delivery)</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(user)}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${xml(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Hidden>true</Hidden>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author"><Exec><Command>${xml(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'conhost.exe'))}</Command><Arguments>--headless cmd.exe /d /c "${xml(runner)}"</Arguments></Exec></Actions>
</Task>
`;
  const xmlPath = path.join(config.dir, 'task.xml');
  fs.writeFileSync(xmlPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(task, 'utf16le')]));
  const existed = taskExists();
  try { schtasks(['/create', '/tn', taskName, '/xml', xmlPath, '/f']); } finally { fs.rmSync(xmlPath, { force: true }); }
  if (!existed) schtasks(['/run', '/tn', taskName]);
  return { installed: true, task: taskName, runner, log, hostId: config.hostId, smsPrimary: config.smsPrimary || null, ...(existed ? { note: 'task updated; stop then install to restart the running daemon' } : {}) };
}
export function installLan() {
  if (process.platform === 'win32') return installWindows(loadLan());
  if (process.platform !== 'darwin') throw Error('lan install supports macos and windows; use lan serve under your service manager on other systems');
  const config = loadLan();
  const script = fileURLToPath(new URL('../bin/agentbus.mjs', import.meta.url));
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(script)}</string><string>lan</string><string>serve</string></array><key>EnvironmentVariables</key><dict><key>AGENTBUS_DIR</key><string>${xml(path.dirname(config.dir))}</string><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>${xml(path.join(config.dir, 'daemon.log'))}</string><key>StandardErrorPath</key><string>${xml(path.join(config.dir, 'daemon.log'))}</string></dict></plist>\n`, { mode: 0o600 });
  execFileSync('/usr/bin/plutil', ['-lint', plistPath]);
  try { execFileSync('/bin/launchctl', ['print', `gui/${process.getuid()}/${label}`], { stdio: 'ignore' }); return { installed: true, note: 'job already loaded; stop then install to restart', plistPath }; } catch {}
  execFileSync('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, plistPath]);
  return { installed: true, plistPath, hostId: config.hostId, smsPrimary: config.smsPrimary || null };
}
export function stopLan() {
  if (process.platform === 'win32') {
    if (taskExists()) { try { schtasks(['/end', '/tn', taskName]); } catch {} schtasks(['/delete', '/tn', taskName, '/f']); }
    // /end only kills conhost; the cmd keepalive loop and its node child survive and keep the port.
    const { killed, spared } = killRunners(path.join(loadLan().dir, 'lan-serve.cmd'));
    return { stopped: true, killed, spared, note: 'pairing config and key retained; session workers left running' };
  }
  if (process.platform !== 'darwin') throw Error('stop the foreground lan serve process or your service manager');
  execFileSync('/bin/launchctl', ['bootout', `gui/${process.getuid()}/${label}`]);
  fs.rmSync(plistPath, { force: true });
  return { stopped: true, note: 'pairing config and key retained' };
}
