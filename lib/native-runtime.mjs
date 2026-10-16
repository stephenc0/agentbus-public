import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const processAlive = (pid) => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
export function runNative(binary, args, options = {}) {
  return new Promise((resolve) => execFile(binary, args, { encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024, ...options }, (error, stdout, stderr) => resolve({ ok: !error, stdout: stdout || '', stderr: stderr || '', error: error?.message || null })));
}

// A successful native inventory is authoritative; missing discovery alone is not.
export async function claudeJobs(binary, cwd) {
  const r = await runNative(binary, ['agents', '--json', '--all'], { cwd });
  if (!r.ok) return { ok: false, error: r.error };
  try { const jobs = JSON.parse(r.stdout); if (!Array.isArray(jobs)) throw Error('expected native job array'); return { ok: true, jobs }; }
  catch { return { ok: false, error: 'invalid native claude inventory' }; }
}
export function matchClaudeJob(jobs, record) {
  const sid = record.agentId?.replace(/^claude:/, '');
  const matches = jobs.filter((j) => j.kind === 'background' && typeof j.sessionId === 'string' && (sid ? j.sessionId === sid : record.nativeJobId && j.sessionId.startsWith(record.nativeJobId)));
  return matches.length === 1 ? matches[0] : matches.length ? { ambiguous: true } : null;
}
export const claudeJobExited = (job) => !job || (!job.ambiguous && !job.pid && ['done', 'stopped', 'failed'].includes(job.state));
export async function stopClaudeJob(record, { inventory = claudeJobs, run = runNative } = {}) {
  const jobId = record.nativeJobId || record.agentId?.replace(/^claude:/, '').slice(0, 8);
  if (!jobId) return { ok: false, error: 'native job id is not known; stop remains pending' };
  const before = await inventory(record.binary, record.request.cwd);
  const beforeJob = before.ok ? matchClaudeJob(before.jobs, record) : null;
  const registrationExpired = Number.isFinite(record.createdAt) && Date.now() - record.createdAt >= 60000;
  if (before.ok && claudeJobExited(beforeJob) && (beforeJob || registrationExpired || record.nativeSeen)) return { ok: true, state: 'stopped' };
  const result = await run(record.binary, ['stop', jobId], { cwd: record.request.cwd, timeout: 5000 });
  for (let i = 0; i < 4; i++) {
    const current = await inventory(record.binary, record.request.cwd);
    const job = current.ok ? matchClaudeJob(current.jobs, record) : null;
    if (current.ok && claudeJobExited(job) && (job || result.ok || registrationExpired || record.nativeSeen)) return { ok: true, state: 'stopped' };
    if (i < 3) await delay(150);
  }
  return { ok: false, error: result.ok ? 'native stop returned but termination is not confirmed' : result.stderr || result.error || 'native stop failed' };
}

// The helper pins process handles and verifies identity before mutation. A
// disappeared leader cannot be adopted by pid; retain uncertainty instead.
export async function terminateWindowsChild(child, { run = runNative, supervisorPid = process.pid } = {}) {
  if (!child?.pid) return;
  if (child.exitCode !== null || child.signalCode !== null) throw Error('runtime leader already exited; descendant termination cannot be verified');
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = await run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    fileURLToPath(new URL('./windows-process-tree.ps1', import.meta.url)), '-LeaderPid', String(child.pid), '-SupervisorPid', String(supervisorPid)], { timeout: 12000 });
  let verified;
  try { verified = JSON.parse(result.stdout); } catch {}
  if (!result.ok || verified?.ok !== true || verified.leaderPid !== child.pid || !Array.isArray(verified.killed) || !verified.killed.includes(child.pid) || !Array.isArray(verified.survivors) || verified.survivors.length) {
    throw Error('owned process tree termination is unconfirmed: ' + (verified?.error || result.error || 'invalid helper acknowledgement'));
  }
}

// Only call for a child this supervisor owns. Windows verifies pinned identities.
export async function terminateChild(child) {
  if (!child?.pid) return; // spawn failed before a native process existed
  if (process.platform === 'win32') return terminateWindowsChild(child);
  // The leader may exit before its descendants. Detached ownership gives us a
  // stable process group to terminate and verify even after the leader exits.
  const groupAlive = () => {
    try { process.kill(-child.pid, 0); return true; }
    catch (e) { if (e.code === 'ESRCH') return false; if (e.code === 'EPERM') return true; throw e; }
  };
  const signal = (name) => { try { process.kill(-child.pid, name); } catch (e) { if (e.code !== 'ESRCH') throw e; } };
  if (!groupAlive()) return;
  signal('SIGTERM');
  for (let i = 0; i < 20 && groupAlive(); i++) await delay(50);
  if (groupAlive()) signal('SIGKILL');
  for (let i = 0; i < 40 && groupAlive(); i++) await delay(50);
  if (groupAlive()) throw Error('owned runtime process group is still present after stop');
}

export function createRuntimeProbe({ run = runNative, now = Date.now, successTtlMs = 60000, failureTtlMs = 3000 } = {}) {
  const cache = new Map();
  function keyFor(binary) {
    try { const s = fs.statSync(binary); return `${binary}:${s.size}:${s.mtimeMs}`; } catch { return String(binary); }
  }
  function refresh(binary, kind) {
    if (!binary) return Promise.resolve({ available: false, state: 'unconfigured', version: null });
    const key = kind + ':' + keyFor(binary), old = cache.get(key);
    if (old?.pending) return old.pending;
    if (old && old.until > now()) return Promise.resolve(old.value);
    const entry = { value: old?.value || { available: null, state: 'probing', version: null } };
    const pending = (async () => {
      const [help, version] = await Promise.all([run(binary, ['--help']), run(binary, ['--version'])]);
      const available = help.ok && help.stdout.includes(kind === 'codex' ? 'app-server' : '--background');
      const value = { available, state: available ? 'available' : 'unavailable', version: version.ok ? version.stdout.trim().slice(0, 160) : null, desktop: kind === 'claude' && help.ok && help.stdout.includes('--desktop'), ...(help.ok ? {} : { error: help.error }), checkedAt: now() };
      cache.set(key, { value, until: now() + (available ? successTtlMs : failureTtlMs) });
      return value;
    })();
    entry.pending = pending; cache.set(key, entry); return pending;
  }
  function snapshot(binary, kind) {
    if (!binary) return { available: false, state: 'unconfigured', version: null };
    const key = kind + ':' + keyFor(binary), entry = cache.get(key);
    refresh(binary, kind).catch(() => {});
    return entry && entry.until > now() ? entry.value : { available: null, state: 'probing', version: entry?.value?.version || null };
  }
  return { refresh, snapshot };
}
