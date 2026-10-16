import { atomicWriteFileSync } from './atomic-file.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { UUID, localLanRequest, restrictToOwner } from './lan.mjs';
import { normalizeProfiles, resolvePermissions } from './launch-permissions.mjs';
import { createRuntimeProbe, claudeJobs, matchClaudeJob, claudeJobExited, stopClaudeJob, delay } from './native-runtime.mjs';
import { buildInfo } from './build-info.mjs';

export const launchDir = (bus) => path.join(bus, 'launches');
export const defaultBus = () => process.env.AGENTBUS_DIR || path.join(os.homedir(), '.agentbus');
const alive = (pid) => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
export function readLaunch(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
export function writeLaunch(file, value) {

  atomicWriteFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}
export function launchPolicy(bus = defaultBus()) {
  return readLaunch(path.join(bus, 'launch-config.json')) || { enabled: false, remote: false, roots: [], maxSessions: 4, runtimes: {} };
}
export function configureLaunch(policy, bus = defaultBus()) {
  if (!Array.isArray(policy.roots) || !policy.roots.length) throw Error('at least one allowed workspace root is required');
  const roots = policy.roots.map((p) => { if (!path.isAbsolute(p) || !fs.statSync(p).isDirectory()) throw Error('workspace roots must be existing absolute directories'); return fs.realpathSync(p); });
  const maxSessions = policy.maxSessions ?? 4;
  if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 32) throw Error('maxSessions must be 1..32');
  const runtimes = {};
  for (const kind of ['codex', 'claude']) {
    const binary = policy.runtimes?.[kind] || findRuntime(kind);
    if (binary) { if (!path.isAbsolute(binary)) throw Error('runtime must be an absolute executable path'); fs.accessSync(binary, fs.constants.X_OK); runtimes[kind] = binary; }
  }
  fs.mkdirSync(bus, { recursive: true, mode: 0o700 });
  const result = { enabled: true, remote: !!policy.remote, roots: [...new Set(roots)], maxSessions, runtimes, permissionProfiles: normalizeProfiles(policy.permissionProfiles, roots) };
  const file = path.join(bus, 'launch-config.json'); writeLaunch(file, result); restrictToOwner(file);
  return result;
}
export function findRuntime(kind) {
  // Never execute a .cmd through a shell: resolve npm's native codex binary instead.
  const dirs = [...(process.env.PATH || '').split(path.delimiter), path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const dir of dirs) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, kind + (process.platform === 'win32' ? '.exe' : ''));
    // claude's launcher is a symlink into versions/<x.y.z>, which auto-update deletes: keep the stable link.
    try { fs.accessSync(candidate, fs.constants.X_OK); return kind === 'claude' ? candidate : fs.realpathSync(candidate); } catch {}
    if (kind === 'codex' && process.platform === 'win32') {
      const packageRoot = path.join(dir, 'node_modules', '@openai', 'codex');
      try {
        const require = createRequire(import.meta.url);
        const platformRoot = path.dirname(require.resolve(`@openai/codex-win32-${process.arch}/package.json`, { paths: [packageRoot] }));
        const native = path.join(platformRoot, 'vendor', `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-pc-windows-msvc`, 'bin', 'codex.exe');
        if (fs.existsSync(native)) return native;
      } catch {}
      for (const arch of ['x86_64', 'aarch64']) {
        for (const prefix of [path.join(dir, 'node_modules', '@openai', 'codex'), path.join(dir, 'node_modules', '@openai', `codex-win32-${arch === 'x86_64' ? 'x64' : 'arm64'}`)]) {
          const native = path.join(prefix, 'vendor', `${arch}-pc-windows-msvc`, 'bin', 'codex.exe');
          if (fs.existsSync(native)) return native;
        }
      }
    }
  }
  return null;
}
const runtimeProbe = createRuntimeProbe();
// A configured runtime path can vanish (claude auto-update removes old versions). Fall back to discovery
// rather than failing every launch until someone reruns `sessions configure`.
export function runtimePath(policy, kind) {
  const configured = policy.runtimes?.[kind];
  if (configured) { try { fs.accessSync(configured, fs.constants.X_OK); return configured; } catch {} }
  return findRuntime(kind) || configured;
}
export function launcherCapabilities(bus = defaultBus()) {
  const policy = launchPolicy(bus);
  const probes = { codex: runtimeProbe.snapshot(runtimePath(policy, 'codex'), 'codex'), claude: runtimeProbe.snapshot(runtimePath(policy, 'claude'), 'claude') };
  return { build: buildInfo, enabled: policy.enabled === true, remote: policy.remote === true, maxSessions: policy.maxSessions, roots: policy.roots, permissionProfiles: policy.permissionProfiles || {},
    runtimes: { codex: probes.codex.available, 'claude-code': probes.claude.available, 'claude-desktop': probes.claude.state === 'probing' ? null : !!probes.claude.desktop && ['darwin', 'win32'].includes(process.platform), 'claude-chat': false }, runtimeProbes: probes,
    desktopScope: 'code composer handoff only: user must confirm folder and send; ordinary chat is not routable', permissions: 'codex defaults workspace-write/never, network off; explicit destination profiles only; claude native configured permissions and trust' };
}
export async function refreshLauncherCapabilities(bus = defaultBus()) {
  const policy = launchPolicy(bus);
  await Promise.all(['codex', 'claude'].map((kind) => runtimeProbe.refresh(runtimePath(policy, kind), kind)));
  return launcherCapabilities(bus);
}
export function validateLaunch(request, policy, source = 'local') {
  for (const key of ['config', 'sandbox', 'sandboxPolicy', 'approvalPolicy', 'permissions', 'permissionSource', 'writableRoots', 'networkAccess']) if (request[key] !== undefined) throw Error('caller permission overrides are forbidden; select a destination permission_profile');
  if (request.permission_profile !== undefined && (typeof request.permission_profile !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(request.permission_profile))) throw Error('invalid permission_profile');
  if (!UUID.test(request.id || '')) throw Error('request id must be a UUID');
  if (!['codex', 'claude-code', 'claude-desktop'].includes(request.runtime)) throw Error('unsupported runtime; claude-desktop means the code tab, not chat');
  if (request.runtime === 'claude-desktop' && (request.name || request.model)) throw Error('desktop handoff uses app settings; choose its name/model in the app');
  if (typeof request.prompt !== 'string' || !request.prompt.trim() || Buffer.byteLength(request.prompt) > 32768) throw Error('prompt must be 1..32768 bytes');
  if (request.runtime === 'claude-desktop' && request.prompt.length > 14000) throw Error('desktop prompt exceeds the deep-link limit');
  for (const [key, max] of [['model', 120], ['name', 80]]) if (request[key] !== undefined && (typeof request[key] !== 'string' || !request[key].trim() || request[key].length > max || /[\x00-\x1f]/.test(request[key]))) throw Error(`invalid ${key}`);
  if (!policy.enabled) throw Error('session launching is disabled on this host; configure it locally');
  if (typeof request.cwd !== 'string' || !path.isAbsolute(request.cwd)) throw Error('cwd must be an absolute path on the destination host');
  const cwd = fs.realpathSync(request.cwd);
  if (!fs.statSync(cwd).isDirectory() || !policy.roots.some((root) => { const rel = path.relative(fs.realpathSync(root), cwd); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); })) throw Error('workspace is outside this host\'s allowed roots');
  return { id: request.id, runtime: request.runtime, cwd, prompt: request.prompt, ...(request.model ? { model: request.model } : {}), ...(request.name ? { name: request.name } : {}), ...(request.permission_profile ? { permission_profile: request.permission_profile } : {}), permissionSource: source === 'local' ? `local/${request.from || ''}` : source, permissions: resolvePermissions({ ...request, cwd }, policy, source === 'local' ? `local/${request.from || ''}` : source) };
}
export function claudeLaunchArgs(request) {
  return ['--bg', ...(request.model ? ['--model', request.model] : []), ...(request.name ? ['--name', request.name] : []), '--', request.prompt];
}
export function claudeJobId(output) {
  return /backgrounded[^\r\n]*?\b([0-9a-f]{8})\b/i.exec(output)?.[1]?.toLowerCase() || null;
}
export function desktopLaunch(request, platform = process.platform) {
  const url = 'claude://code/new?' + new URLSearchParams({ q: request.prompt, folder: request.cwd });
  if (url.length > 30000) throw Error('encoded desktop link too long');
  if (platform === 'darwin') return { binary: '/usr/bin/open', args: [url], env: {} };
  if (platform === 'win32') return { binary: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; Start-Process -FilePath $env:AGENTBUS_DESKTOP_URL"], env: { AGENTBUS_DESKTOP_URL: url } };
  throw Error('desktop handoff supports macos and windows');
}
export function launchEnvironment(env = process.env) {
  // A launched session must not inherit the caller's identity or inbox token.
  return Object.fromEntries(Object.entries(env).filter(([k]) => !/^(CLAUDE_CODE_(MESSAGING_|SESSION_ID$|ENTRYPOINT$)|CLAUDECODE$|CODEX_THREAD_ID$|CODEX_INTERNAL_|AGENTBUS_SELF$|AGENTBUS_PUSH_BRIDGE_PID$)/.test(k)));
}
export function createLauncher({ busDir = defaultBus(), listLocal = () => [], startWorker, capabilities = () => refreshLauncherCapabilities(busDir), inventory = claudeJobs, nativeStop = stopClaudeJob, registrationGraceMs = 60000 } = {}) {
  const dir = launchDir(busDir); fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); restrictToOwner(dir);
  const fileFor = (id) => { if (!UUID.test(id || '')) throw Error('request id must be a UUID'); return path.join(dir, id + '.json'); };
  const agentFor = (record) => {
    const matches = listLocal().filter((a) => a.id === record.agentId || (record.nativeJobId && a.kind === 'claude' && a.id.startsWith('claude:' + record.nativeJobId)));
    return matches.length === 1 ? matches[0] : null;
  };
  async function reconcile(record, agent) {
    if (record.request.runtime !== 'claude-code' || ['stopped', 'failed'].includes(record.state) || agent || alive(record.workerPid) || Date.now() - record.createdAt < registrationGraceMs || (!record.nativeJobId && !record.agentId)) return record;
    const result = await inventory(record.binary, record.request.cwd);
    let patch;
    if (!result.ok) patch = { state: 'uncertain', error: 'native job inventory unavailable; launch reservation retained' };
    else {
      const job = matchClaudeJob(result.jobs, record);
      patch = claudeJobExited(job) ? { state: 'stopped', nativeState: job?.state || 'removed', error: null, note: 'native inventory confirmed job exit; reservation released' }
        : { state: 'awaiting_registration', nativeState: job?.state || 'unknown', error: null, note: 'native job remains active or blocked; reservation retained' };
    }
    // An old supervisor may have updated the receipt during the query.
    const file = fileFor(record.request.id), current = readLaunch(file);
    if (JSON.stringify(current) !== JSON.stringify(record)) return current || record;
    const updated = { ...record, ...patch, updatedAt: Date.now() }; writeLaunch(file, updated); return updated;
  }
  async function status(id, source) {
    let record = readLaunch(fileFor(id)); if (!record) return { ok: false, error: 'unknown launch id' };
    if (source && source !== record.source) return { ok: false, error: 'launch belongs to a different sender' };
    const agent = agentFor(record);
    let persistenceError = null;
    try { persistenceError = readLaunch(fileFor(id) + '.persistence-error'); } catch { persistenceError = { code: 'unreadable' }; }
    record = await reconcile(record, agent);
    const state = persistenceError ? 'uncertain' : fs.existsSync(fileFor(id) + '.stop') && !['stopped', 'failed', 'uncertain'].includes(record.state) ? 'stopping' : agent && !['stopped', 'failed', 'uncertain'].includes(record.state) ? 'running' : record.state === 'running' && !alive(record.workerPid) ? 'uncertain' : record.state === 'starting' && Date.now() - record.createdAt > 60000 && !alive(record.workerPid) ? 'uncertain' : record.state;
    return { ok: !persistenceError && !['failed', 'uncertain'].includes(state), ...(persistenceError ? { persistenceError, receiptStale: true } : {}), requestId: id, runtime: record.request.runtime, workerAlive: alive(record.workerPid), build: record.workerBuild || null, permissionProfile: record.request.permission_profile || null, permissions: record.request.runtime === 'codex' ? record.request.permissions || null : null, effectivePermissions: record.effectivePermissions || null, state, agentId: agent?.id || record.agentId || null, cwd: agent?.cwd || record.nativeCwd || record.request.cwd, routable: !!agent && !['stopped', 'failed'].includes(state), deliveryReady: !!agent?.deliveryReady && !['stopped', 'failed', 'stopping'].includes(state), wakeCapability: agent?.wakeCapability || 'unknown', unavailableReason: agent?.unavailableReason || (!agent ? 'session is not discovered' : null), nativeState: record.nativeState || null, cleanupScope: record.cleanupScope || null, model: agent?.model || record.model || record.request.model || null, ...(record.lastTurn ? { lastTurn: record.lastTurn } : {}), ...(record.lastResponse ? { lastResponse: record.lastResponse } : {}), ...(record.error ? { error: record.error } : {}), ...(record.note ? { note: record.note } : {}) };
  }
  async function launchUnlocked(request, source) {
    const file = fileFor(request.id), previous = readLaunch(file);
    const hash = crypto.createHash('sha256').update(JSON.stringify({ source, ...(request.permission_profile ? { from: request.from } : {}), runtime: request.runtime, cwd: request.cwd, model: request.model, name: request.name, prompt: request.prompt, permission_profile: request.permission_profile })).digest('hex');
    if (previous) return previous.hash === hash ? status(request.id) : { ok: false, error: 'launch id reused with different contents or sender' };
    const policy = launchPolicy(busDir);
    if (source !== 'local' && !policy.remote) throw Error('remote launching is disabled on this host');
    const normalized = validateLaunch(request, policy, source);
    if (!(await capabilities()).runtimes[request.runtime]) throw Error('runtime is not available on this host');
    let records = fs.readdirSync(dir).filter((f) => UUID.test(f.replace(/\.json$/, '')) && f.endsWith('.json')).map((f) => readLaunch(path.join(dir, f)));
    records = await Promise.all(records.map((r) => r ? reconcile(r, agentFor(r)) : r));
    if (records.filter((r) => r && !['stopped', 'failed'].includes(r.state)).length >= policy.maxSessions) throw Error('host session limit reached (unresolved launches count toward limit)');
    const record = { hash, source, request: normalized, state: 'starting', createdAt: Date.now(), binary: runtimePath(policy, request.runtime === 'codex' ? 'codex' : 'claude') };
    // Exclusive durable intent precedes process creation. Never repeat a launch after a crash.
    const receipt = fs.openSync(file, 'wx', 0o600);
    try { fs.writeFileSync(receipt, JSON.stringify(record)); fs.fsyncSync(receipt); } finally { fs.closeSync(receipt); }
    try {
      if (startWorker) startWorker(file, record);
      else {
        const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/session-worker.mjs', import.meta.url)), file], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...launchEnvironment(), AGENTBUS_DIR: busDir } });
        child.once('error', (e) => writeLaunch(file, { ...record, state: 'failed', error: e.message })); child.unref();
      }
    } catch (e) { writeLaunch(file, { ...record, state: 'failed', error: e.message }); }
    return status(request.id);
  }
  async function launch(request, source = 'local') {
    // Serialize quota checks + durable intents across MCP/CLI/daemon processes.
    const lock = path.join(dir, 'launch.lock');
    let fd;
    const deadline = Date.now() + 7000;
    while (fd === undefined) {
      try { fd = fs.openSync(lock, 'wx', 0o600); }
      catch (e) { if (e.code !== 'EEXIST') throw e; if (Date.now() >= deadline) throw Error('launcher busy or stale launch.lock; retry the same request id (inspect lock owner after a crash)'); await delay(50); }
    }
    try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() })); return await launchUnlocked(request, source); }
    finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  }
  async function stop(id, source) {
    const file = fileFor(id), record = readLaunch(file);
    if (!record) return { ok: false, error: 'unknown launch id' };
    if (source && source !== record.source) return { ok: false, error: 'launch belongs to a different sender' };
    if (record.state === 'stopped') return { ok: true, requestId: id, state: 'stopped', note: 'already stopped' };
    fs.writeFileSync(file + '.stop', '', { mode: 0o600 });
    // A live supervisor resolves registration before stopping its native child.
    if (alive(record.workerPid)) return { ok: true, requestId: id, state: 'stopping', note: 'stop requested; inspect status for verified termination' };
    if (record.request.runtime === 'claude-code') {
      if (!record.nativeJobId && !record.agentId) return { ok: false, requestId: id, state: 'uncertain', error: 'native job id unknown; stop marker retained for registration/recovery' };
      const result = await nativeStop(record, { inventory });
      if (!result.ok) return { ok: false, requestId: id, state: 'uncertain', error: result.error };
    } else if (record.request.runtime === 'codex' && (agentFor(record) || alive(record.runtimePid))) {
      return { ok: false, requestId: id, state: 'uncertain', error: 'supervisor is gone but native runtime remains; cannot verify ownership for process termination' };
    } else if (record.request.runtime === 'codex' && (record.runtimePid || ['running', 'uncertain'].includes(record.state))) {
      return { ok: false, requestId: id, state: 'uncertain', error: 'supervisor is gone; descendant termination is unverified, inspect before closing receipt' };
    } else if (record.state === 'starting' && Date.now() - record.createdAt < registrationGraceMs) {
      return { ok: true, requestId: id, state: 'stopping', note: 'stop marker saved; worker will stop before launching' };
    }
    const current = readLaunch(file);
    if (JSON.stringify(current) !== JSON.stringify(record)) return { ok: true, requestId: id, state: 'stopping', note: 'worker advanced; stop marker retained' };
    writeLaunch(file, { ...record, state: 'stopped', error: null, updatedAt: Date.now() });
    return { ok: true, requestId: id, state: 'stopped', note: record.request.runtime === 'claude-desktop' ? 'handoff receipt closed; close any desktop conversation in the app' : 'termination verified; conversation retained' };
  }
  return { launch, status, stop, capabilities, snapshot: () => launcherCapabilities(busDir) };
}
export async function spawnSession(request, { busDir = defaultBus(), listLocal = () => [] } = {}) {
  const id = request.id || crypto.randomUUID();
  if (!request.host || request.host === 'local') {
    try { return { ...await createLauncher({ busDir, listLocal }).launch({ ...request, id }), requestId: id }; }
    catch (e) { return { ok: false, requestId: id, error: e.message }; }
  }
  return { ...await localLanRequest({ ...request, op: 'spawn', id }, { busDir, timeout: 10000 }), requestId: id };
}
