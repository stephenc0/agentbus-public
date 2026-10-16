import { atomicWriteFileSync } from './atomic-file.mjs';
// codex writer-lock liveness on windows. codex >= 0.162 keeps CODEX_HOME/thread-writer-locks/<thread>.lock
// and holds it with LockFileEx while the thread is loaded in an app-server; the file outlives the owner.
// we never take the lock ourselves (that would race codex's own try-lock). the Restart Manager reports
// which processes hold the file open, and a holder counts only if it is a live codex process whose start
// time still matches (pid reuse). evidence source is "rm-handle": an open handle by a validated codex
// owner, not a lock-state query.
//
// the probe is a powershell cold start (~0.5-1.5s), so callers never wait on it: readLockSnapshot() is
// synchronous and returns the last good snapshot (or unknown), and kicks one async refresh when stale.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./codex-locks-win.ps1', import.meta.url));
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
export const LOCK_SNAPSHOT_TTL_MS = 3000;
export const LOCK_PROBE_TIMEOUT_MS = 8000;
export const MAX_LOCKS = 512;
const CODEX_IMAGE = /^codex(-[a-z0-9-]+)?\.exe$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// desktop = app-server spawned by the packaged app (WindowsApps/OpenAI.Codex_*/app/ChatGPT.exe or Codex.exe).
// its own executable is the copied core under %LOCALAPPDATA%/OpenAI/Codex/bin/<hash>/codex.exe.
const DESKTOP_PARENT = /[\\/]WindowsApps[\\/]OpenAI\.Codex_[^\\/]+[\\/]app[\\/](ChatGPT|Codex)\.exe$/i;

const unknown = (error) => ({ ok: false, error, threads: new Map() });

// raw probe output -> { ok, at, truncated, threads: Map<threadId, {held, owners:[...]}>, errors }
export function parseLockProbe(text) {
  let raw;
  try { raw = JSON.parse(String(text).trim().split(/\r?\n/).pop()); } catch { return unknown('unparseable probe output'); }
  if (!raw?.ok) return unknown(raw?.error || 'probe failed');
  const threads = new Map(), errors = {};
  for (const [id, l] of Object.entries(raw.locks || {})) {
    if (!UUID.test(id)) continue;
    if (l.error) { errors[id] = l.error; continue; }
    const owners = [];
    for (const h of [].concat(l.holders || [])) {
      const [pid, start] = String(h).split(':');
      const p = raw.processes?.[pid];
      // holder gone since RmGetList, pid reused, or not codex (indexer, AV, our own tooling): not an owner
      if (!p || !CODEX_IMAGE.test(p.image || '') || String(p.startTime) !== start) continue;
      owners.push({ pid: Number(pid), image: p.image, path: p.path || null, appServer: !!p.appServer, listen: p.listen || null, parentPid: p.parentPid ?? null, parentImage: p.parentImage || null, parentPath: p.parentPath || null, owner: ownerKind(p), source: 'rm-handle' });
    }
    threads.set(id, { held: owners.length > 0, owners });
  }
  return { ok: true, at: raw.at, truncated: !!raw.truncated, missingDir: !!raw.missingDir, threads, errors };
}

export function ownerKind(p) {
  if (!p?.appServer) return 'codex';
  if (DESKTOP_PARENT.test(p.parentPath || '')) return 'desktop';
  return p.listen ? 'app-server-listener' : 'app-server';
}

export function windowsLockProbeSupported() {
  return process.platform === 'win32' && fs.existsSync(SCRIPT) && fs.existsSync(POWERSHELL);
}

export function probeLockOwners(lockDir, { timeoutMs = LOCK_PROBE_TIMEOUT_MS, maxLocks = MAX_LOCKS } = {}) {
  if (!windowsLockProbeSupported()) return Promise.resolve(unknown('unsupported platform'));
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-LockDir', lockDir, '-MaxLocks', String(maxLocks)];
  return new Promise((resolve) => execFile(POWERSHELL, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    (e, out) => resolve(e ? unknown(e.killed ? 'probe timeout' : e.message) : parseLockProbe(out))));
}

// ---- cached snapshot -------------------------------------------------------------------------------
// one in-process entry per lock dir; optionally shared across processes (hooks, mcp servers, daemon)
// through an atomically replaced json file. only successful probes are cached; a failure keeps the last
// good snapshot but it ages out to unknown, so "probe broken" never reads as "no live threads".
const mem = new Map(); // lockDir -> { snap, refreshing: Promise|null }
const toJson = (s) => JSON.stringify({ ...s, threads: Object.fromEntries(s.threads) });
const fromJson = (o) => ({ ...o, threads: new Map(Object.entries(o.threads || {})) });

function readShared(cacheFile, lockDir) {
  try { const s = fromJson(JSON.parse(fs.readFileSync(cacheFile, 'utf8'))); return s.ok && s.lockDir === lockDir ? s : null; } catch { return null; }
}
function writeShared(cacheFile, s) {
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });

    atomicWriteFileSync(cacheFile, toJson(s));
  } catch { /* the shared cache is an optimization */ }
}

export function refreshLockSnapshot(lockDir, { cacheFile = null, probe = probeLockOwners, now = Date.now } = {}) {
  const e = mem.get(lockDir) || { snap: null, refreshing: null };
  mem.set(lockDir, e);
  if (e.refreshing) return e.refreshing; // in-process dedup
  e.refreshing = (async () => {
    try {
      const s = await probe(lockDir);
      if (s.ok) {
        const snap = { ...s, lockDir, probedAt: now() };
        e.snap = snap;
        if (cacheFile) writeShared(cacheFile, snap);
        return snap;
      }
      return { ...s, lockDir, probedAt: now() };
    } finally { e.refreshing = null; }
  })();
  return e.refreshing;
}

// never blocks. fresh (<= maxAgeMs) good snapshot -> returned as is; otherwise a refresh starts in the
// background and the caller gets the last good snapshot marked stale, or unknown when there is none.
export function readLockSnapshot(lockDir, { cacheFile = null, maxAgeMs = LOCK_SNAPSHOT_TTL_MS, now = Date.now, refresh = true, probe } = {}) {
  const e = mem.get(lockDir);
  let snap = e?.snap || null;
  if (cacheFile) { const shared = readShared(cacheFile, lockDir); if (shared && (!snap || shared.probedAt > snap.probedAt)) snap = shared; }
  const age = snap ? now() - snap.probedAt : Infinity;
  const fresh = !!snap && age >= 0 && age <= maxAgeMs;
  if (!fresh && refresh) refreshLockSnapshot(lockDir, { cacheFile, now, ...(probe ? { probe } : {}) }).catch(() => {});
  if (!snap) return { ...unknown('no snapshot yet'), lockDir, stale: true };
  return { ...snap, stale: !fresh };
}

// held = a validated codex owner had the lock open. stale snapshots and failures are unknown, never absent.
export function lockState(snapshot, threadId) {
  if (!snapshot?.ok) return { state: 'unknown', reason: snapshot?.error || 'no snapshot' };
  if (snapshot.stale) return { state: 'unknown', reason: 'snapshot stale' };
  if (snapshot.errors?.[threadId]) return { state: 'unknown', reason: snapshot.errors[threadId] };
  const t = snapshot.threads.get(threadId);
  if (!t) return snapshot.truncated ? { state: 'unknown', reason: 'truncated' } : { state: 'absent' };
  return t.held ? { state: 'held', owners: t.owners } : { state: 'stale' };
}

export const defaultLockCache = () => path.join(process.env.AGENTBUS_DIR || path.join(os.homedir(), '.agentbus'), 'cache', 'codex-locks.json');
export const _resetLockCacheForTests = () => mem.clear();
