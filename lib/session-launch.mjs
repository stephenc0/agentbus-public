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
import { sanitizeClaims, staleLaunch, TERMINAL } from './launch-jobs.mjs';

export const launchDir = (bus) => path.join(bus, 'launches');
export const defaultBus = () => process.env.AGENTBUS_DIR || path.join(os.homedir(), '.agentbus');
const alive = (pid) => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// A receipt that exists but cannot be parsed (zero-filled after a hard reset,
// truncated, foreign bytes) is evidence, not an exception: one bad file must not
// take every launch on the host down. Callers see a marker and fail closed for
// that id only; the file stays in place for inspection (like a stale launch.lock).
export function readLaunch(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  try { return JSON.parse(text); } catch (e) { return { corrupt: true, file, error: `unreadable receipt: ${e.message}` }; }
}
export const isCorrupt = (record) => !!record && record.corrupt === true && typeof record.file === 'string';
const corruptResult = (id, record) => ({ ok: false, requestId: id, state: 'corrupt', error: record.error, receiptFile: record.quarantined || record.file, note: record.quarantined
  ? 'receipt was unreadable and predates the current boot: no worker survived that reset, so it was moved aside and its session slot released. never retry this request id automatically; inspect the native runtime before starting a new one'
  : 'receipt exists but is not valid JSON; inspect the native runtime for a surviving process, then rename the file aside (for example to <name>.corrupt-<timestamp>) to release its slot. never retry this request id automatically' });
// The worker rewrites its receipt every poll, so without fsync a hard reset almost
// always catches one mid-flight and ntfs leaves a zero-filled file.
export function writeLaunch(file, value) {
  atomicWriteFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, fsync: true });
}
export const bootedAt = () => Date.now() - os.uptime() * 1000;
// A corrupt receipt last written before the current boot cannot belong to a live
// worker (nothing survives a reset), so keeping it in place buys no evidence while
// it holds a session slot. Move it aside under the same name a manual repair would
// use and release the slot. Anything written since boot stays put: a live process
// or foreign tool may be responsible and a human should look.
const predatesBoot = (record, bootAt, marginMs) => { try { return fs.statSync(record.file).mtimeMs < bootAt - marginMs; } catch { return false; } };
export function quarantineStale(record, bootAt = bootedAt(), { marginMs = 120000 } = {}) {
  if (!isCorrupt(record) || record.quarantined || !predatesBoot(record, bootAt, marginMs)) return record;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  let target = `${record.file}.corrupt-${stamp}`;
  if (fs.existsSync(target)) target += `-${process.pid}`;
  try { fs.renameSync(record.file, target); } catch { return record; }
  return { ...record, quarantined: target, error: `${record.error}; written before the current boot (hard reset), moved to ${path.basename(target)}` };
}
// does this receipt hold one of the host's maxSessions slots? the spawn-time limit check and the published
// activeSessions count share it. corrupt receipts count (unresolved); quarantined, closed and stale ones do not.
export function holdsSlot(record, agent = null) {
  return !!record && !record.quarantined && !['stopped', 'failed'].includes(record.state) && !(record.request && staleLaunch(record, { agent }));
}
// holdsSlot with discovery deferred: a discovered session only matters for a receipt that is otherwise stale.
const countsTowardLimit = (r, agentFor) => holdsSlot(r) || (!!r?.request && !['stopped', 'failed'].includes(r.state) && holdsSlot(r, agentFor(r)));
const matchAgent = (record, agents) => {
  const matches = agents.filter((a) => a.id === record.agentId || (record.nativeJobId && a.kind === 'claude' && a.id.startsWith('claude:' + record.nativeJobId)));
  return matches.length === 1 ? matches[0] : null;
};
// read-only slot count for capabilities: no native inventory, no receipt rewrite, no quarantine rename. a corrupt
// receipt from before the boot is skipped (a launch would move it aside first). the limit check also reconciles
// dead-worker claude-code receipts against `claude agents` first, so this can run ahead of it by receipts whose
// native job already exited but that no launch/status call has reconciled yet. agents are discovered lazily,
// only for a receipt that would otherwise be stale.
export function activeSessionCount(bus = defaultBus(), { listLocal = () => [], bootAt = bootedAt(), marginMs = 120000 } = {}) {
  const dir = launchDir(bus);
  let names; try { names = fs.readdirSync(dir); } catch { return 0; }
  let agents = null;
  const agentFor = (r) => matchAgent(r, agents ??= (() => { try { return listLocal() || []; } catch { return []; } })());
  let n = 0;
  for (const f of names) {
    if (!f.endsWith('.json') || !UUID.test(f.slice(0, -5))) continue;
    let r; try { r = readLaunch(path.join(dir, f)); } catch { n++; continue; } // unreadable: the limit check would refuse, so fail closed
    if (!r || (isCorrupt(r) && predatesBoot(r, bootAt, marginMs))) continue;
    if (countsTowardLimit(r, agentFor)) n++;
  }
  return n;
}
export function launchPolicy(bus = defaultBus()) {
  const policy = readLaunch(path.join(bus, 'launch-config.json'));
  if (isCorrupt(policy)) throw Error(policy.error);
  return policy || { enabled: false, remote: false, roots: [], maxSessions: 4, runtimes: {} };
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
export function launcherCapabilities(bus = defaultBus(), { listLocal } = {}) {
  const policy = launchPolicy(bus);
  let activeSessions = null; try { activeSessions = activeSessionCount(bus, { listLocal }); } catch {}
  const probes = { codex: runtimeProbe.snapshot(runtimePath(policy, 'codex'), 'codex'), claude: runtimeProbe.snapshot(runtimePath(policy, 'claude'), 'claude') };
  return { build: buildInfo, enabled: policy.enabled === true, remote: policy.remote === true, maxSessions: policy.maxSessions, activeSessions, roots: policy.roots, permissionProfiles: policy.permissionProfiles || {},
    runtimes: { codex: probes.codex.available, 'claude-code': probes.claude.available, 'claude-desktop': probes.claude.state === 'probing' ? null : !!probes.claude.desktop && ['darwin', 'win32'].includes(process.platform), 'claude-chat': false }, runtimeProbes: probes,
    desktopScope: 'code composer handoff only: user must confirm folder and send; ordinary chat is not routable', permissions: 'codex defaults workspace-write/never, network off; explicit destination profiles only; claude native configured permissions and trust' };
}
export async function refreshLauncherCapabilities(bus = defaultBus(), options = {}) {
  const policy = launchPolicy(bus);
  await Promise.all(['codex', 'claude'].map((kind) => runtimeProbe.refresh(runtimePath(policy, kind), kind)));
  return launcherCapabilities(bus, options);
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
  // resource claims (e.g. ['gpu']): while this launch's native job works, this host publishes compute=true / gpu=avoid.
  const claims = sanitizeClaims(request.claims, { strict: true });
  if (claims.length && request.runtime === 'claude-desktop') throw Error('claims need a supervised runtime (codex or claude-code); a desktop handoff has no job to watch');
  return { id: request.id, runtime: request.runtime, cwd, prompt: request.prompt, ...(request.model ? { model: request.model } : {}), ...(request.name ? { name: request.name } : {}), ...(request.permission_profile ? { permission_profile: request.permission_profile } : {}), ...(claims.length ? { claims } : {}), permissionSource: source === 'local' ? `local/${request.from || ''}` : source, permissions: resolvePermissions({ ...request, cwd }, policy, source === 'local' ? `local/${request.from || ''}` : source) };
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
export function createLauncher({ busDir = defaultBus(), listLocal = () => [], startWorker, capabilities = () => refreshLauncherCapabilities(busDir, { listLocal }), inventory = claudeJobs, nativeStop = stopClaudeJob, registrationGraceMs = 60000, bootAt = bootedAt } = {}) {
  const dir = launchDir(busDir); fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); restrictToOwner(dir);
  const fileFor = (id) => { if (!UUID.test(id || '')) throw Error('request id must be a UUID'); return path.join(dir, id + '.json'); };
  const readReceipt = (file) => quarantineStale(readLaunch(file), bootAt());
  const agentFor = (record) => matchAgent(record, listLocal());
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
    // A retained reservation is not news: rewriting it would bump updatedAt on every launch attempt and
    // keep a dead-worker receipt looking fresh forever (see staleLaunch).
    if (Object.keys(patch).every((k) => (record[k] ?? null) === (patch[k] ?? null))) return record;
    const updated = { ...record, ...patch, updatedAt: Date.now() }; writeLaunch(file, updated); return updated;
  }
  // receipts holding a slot that cannot be live (dead worker, native job exited/blocked past the stale window).
  function stale() {
    return fs.readdirSync(dir).filter((f) => UUID.test(f.replace(/\.json$/, '')) && f.endsWith('.json')).map((f) => readLaunch(path.join(dir, f)))
      .map((r) => r && !isCorrupt(r) ? { record: r, reason: staleLaunch(r, { agent: agentFor(r) }) } : null)
      .filter((x) => x?.reason)
      .map(({ record, reason }) => ({ requestId: record.request.id, runtime: record.request.runtime, name: record.request.name || null, source: record.source, state: record.state, nativeState: record.nativeState || null, workerPid: record.workerPid || null, updatedAt: record.updatedAt || null, stopMarker: fs.existsSync(fileFor(record.request.id) + '.stop'), reason }));
  }
  // host owner's manual close of a receipt whose worker is gone. local only (never offered over the lan);
  // termination is unverified by definition, so the note says so and the stop marker is left in place.
  function close(id) {
    const file = fileFor(id), record = readReceipt(file);
    if (!record) return { ok: false, error: 'unknown launch id' };
    if (isCorrupt(record)) return corruptResult(id, record);
    if (TERMINAL.includes(record.state)) return { ok: true, requestId: id, state: record.state, note: 'already closed' };
    const reason = staleLaunch(record, { agent: agentFor(record) });
    if (!reason) return { ok: false, requestId: id, state: record.state, error: alive(record.workerPid) ? 'worker is alive; use stop' : 'receipt is not stale yet; stop it, or wait for the stale window' };
    writeLaunch(file, { ...record, state: 'stopped', error: null, updatedAt: Date.now(), note: `closed by host owner reconcile (${reason}); termination unverified, native runtime not inspected` });
    return { ok: true, requestId: id, state: 'stopped', reason, note: 'receipt closed and slot released; termination unverified: check the native runtime if the job matters' };
  }
  async function status(id, source) {
    let record = readReceipt(fileFor(id)); if (!record) return { ok: false, error: 'unknown launch id' };
    if (isCorrupt(record)) return corruptResult(id, record);
    if (source && source !== record.source) return { ok: false, error: 'launch belongs to a different sender' };
    const agent = agentFor(record);
    let persistenceError = null;
    try { persistenceError = readLaunch(fileFor(id) + '.persistence-error'); } catch { persistenceError = { code: 'unreadable' }; }
    if (isCorrupt(persistenceError)) persistenceError = { code: 'unreadable' };
    record = await reconcile(record, agent);
    if (isCorrupt(record)) return corruptResult(id, record);
    const state = persistenceError ? 'uncertain' : fs.existsSync(fileFor(id) + '.stop') && !['stopped', 'failed', 'uncertain'].includes(record.state) ? 'stopping' : agent && !['stopped', 'failed', 'uncertain'].includes(record.state) ? 'running' : record.state === 'running' && !alive(record.workerPid) ? 'uncertain' : record.state === 'starting' && Date.now() - record.createdAt > 60000 && !alive(record.workerPid) ? 'uncertain' : record.state;
    const staleReason = staleLaunch(record, { agent });
    return { ok: !persistenceError && !['failed', 'uncertain', 'crashing'].includes(state), ...(persistenceError ? { persistenceError, receiptStale: true } : {}), requestId: id, runtime: record.request.runtime, workerAlive: alive(record.workerPid), build: record.workerBuild || null, permissionProfile: record.request.permission_profile || null, claims: record.request.claims || [], ...(staleReason ? { stale: staleReason, staleNote: 'no longer counts toward the session limit; the host owner can close it with `agentbus sessions reconcile --close <id>`' } : {}), permissions: record.request.runtime === 'codex' ? record.request.permissions || null : null, effectivePermissions: record.effectivePermissions || null, state, agentId: agent?.id || record.agentId || null, cwd: agent?.cwd || record.nativeCwd || record.request.cwd, routable: !!agent && !['stopped', 'failed'].includes(state), deliveryReady: !!agent?.deliveryReady && !['stopped', 'failed', 'stopping'].includes(state), wakeCapability: agent?.wakeCapability || 'unknown', unavailableReason: agent?.unavailableReason || (!agent ? 'session is not discovered' : null), nativeState: record.nativeState || null, cleanupScope: record.cleanupScope || null, model: agent?.model || record.model || record.request.model || null, ...(record.lastTurn ? { lastTurn: record.lastTurn } : {}), ...(record.lastResponse ? { lastResponse: record.lastResponse } : {}), ...(record.crash ? { crash: record.crash } : {}), ...(record.stall ? { stall: record.stall } : {}), ...(record.nativeLogTail ? { nativeLogTail: record.nativeLogTail } : {}), ...(record.error ? { error: record.error } : {}), ...(record.note ? { note: record.note } : {}) };
  }
  async function launchUnlocked(request, source) {
    const file = fileFor(request.id), previous = readReceipt(file);
    const hash = crypto.createHash('sha256').update(JSON.stringify({ source, ...(request.permission_profile ? { from: request.from } : {}), runtime: request.runtime, cwd: request.cwd, model: request.model, name: request.name, prompt: request.prompt, permission_profile: request.permission_profile, ...(Array.isArray(request.claims) && request.claims.length ? { claims: request.claims } : {}) })).digest('hex');
    if (isCorrupt(previous)) return corruptResult(request.id, previous);
    if (previous) return previous.hash === hash ? status(request.id) : { ok: false, error: 'launch id reused with different contents or sender' };
    const policy = launchPolicy(busDir);
    if (source !== 'local' && !policy.remote) throw Error('remote launching is disabled on this host');
    const normalized = validateLaunch(request, policy, source);
    if (!(await capabilities()).runtimes[request.runtime]) throw Error('runtime is not available on this host');
    let records = fs.readdirSync(dir).filter((f) => UUID.test(f.replace(/\.json$/, '')) && f.endsWith('.json')).map((f) => readReceipt(path.join(dir, f)));
    // Corrupt receipts written since boot are unresolved launches: they hold their slot until
    // inspected. Ones from before the boot were just quarantined and no longer count.
    records = await Promise.all(records.map((r) => r && !isCorrupt(r) ? reconcile(r, agentFor(r)) : r));
    // Stale receipts (dead worker, native job exited/blocked past the window) keep their file for inspection but no slot.
    if (records.filter((r) => countsTowardLimit(r, agentFor)).length >= policy.maxSessions) throw Error('host session limit reached (unresolved launches count toward limit; `agentbus sessions reconcile` lists stale ones)');
    const record = { hash, source, request: normalized, state: 'starting', createdAt: Date.now(), binary: runtimePath(policy, request.runtime === 'codex' ? 'codex' : 'claude') };
    // Durable intent precedes process creation (launch.lock serializes the exclusivity check above).
    // Temp file + fsync + rename: a crash leaves no half-written or zero-filled receipt. Never repeat a launch after a crash.
    atomicWriteFileSync(file, JSON.stringify(record), { mode: 0o600, fsync: true });
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
    const file = fileFor(id), record = readReceipt(file);
    if (!record) return { ok: false, error: 'unknown launch id' };
    if (isCorrupt(record)) return corruptResult(id, record);
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
  return { launch, status, stop, stale, close, capabilities, snapshot: () => launcherCapabilities(busDir, { listLocal }) };
}
export async function spawnSession(request, { busDir = defaultBus(), listLocal = () => [] } = {}) {
  const id = request.id || crypto.randomUUID();
  if (!request.host || request.host === 'local') {
    try { return { ...await createLauncher({ busDir, listLocal }).launch({ ...request, id }), requestId: id }; }
    catch (e) { return { ok: false, requestId: id, error: e.message }; }
  }
  return { ...await localLanRequest({ ...request, op: 'spawn', id }, { busDir, timeout: 10000 }), requestId: id };
}
