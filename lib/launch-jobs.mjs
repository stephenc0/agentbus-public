// compute claims: a spawn request may say `claims: ['gpu']`. the DESTINATION host then publishes, in its
// presence payload, that it is running a compute job for a peer while that launch's native job is working.
// derived from the launch receipts the session worker already rewrites every poll: no runner cooperation,
// no ttl, no extra process spawns. the claim drops when the job ends, is stopped, or its receipt goes stale.
// a live launch WITHOUT claims is published separately as `unclaimed`: informational only, never compute or
// gpu=avoid. a session nobody spawned through agentbus has no receipt and shows up in neither (only as gpu load).
import fs from 'node:fs';
import path from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLAIM = /^[a-z][a-z0-9_-]{0,31}$/;
export const MAX_CLAIMS = 8;
export const MAX_JOBS = 8;
// a claude-code worker rewrites its receipt every native poll (5s); a receipt older than this with no live
// worker is a dead supervisor, and we stop vouching for its job (the native job may still run: see docs).
export const JOB_FRESH_MS = 60000;
// a non-terminal receipt whose worker is dead and whose native job is exited/blocked for this long no longer
// counts toward maxSessions. nothing is closed automatically; `agentbus sessions reconcile` does that.
export const STALE_AFTER_MS = 2 * 3600 * 1000;
export const TERMINAL = ['stopped', 'failed', 'awaiting_user'];

const clean = (v, n) => typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, n) : null;
const num = (v) => Number.isFinite(v) && v >= 0 ? v : null;
const processAlive = (pid) => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// strict: throw on anything that is not a short lowercase token (spawn validation). lenient: drop it (peer data).
export function sanitizeClaims(claims, { strict = false } = {}) {
  if (claims === undefined || claims === null) return [];
  if (!Array.isArray(claims)) { if (strict) throw Error('claims must be an array of short lowercase tokens, e.g. ["gpu"]'); return []; }
  if (strict && claims.length > MAX_CLAIMS) throw Error(`at most ${MAX_CLAIMS} claims`);
  const out = [];
  for (const c of claims) {
    if (typeof c === 'string' && CLAIM.test(c)) { if (!out.includes(c)) out.push(c); }
    else if (strict) throw Error('claims must be an array of short lowercase tokens, e.g. ["gpu"]');
  }
  return out.slice(0, MAX_CLAIMS);
}

// source is `<hostId>/<agentId>` for a lan launch, `local/<agentId>` or `local` for a local one.
export function splitSource(source) {
  const s = typeof source === 'string' ? source : '';
  const slash = s.indexOf('/');
  const head = slash < 0 ? s : s.slice(0, slash), agent = slash < 0 ? '' : s.slice(slash + 1);
  return { host: UUID.test(head) ? head : 'local', agent: agent || null };
}

// is this receipt's native job doing work right now, claimed or not? pure; `alive` is injectable for tests.
// claude-code: `claude agents --json` keeps a background job `working` while its session is parked on a
// background shell (session registry status `shell`), through the whole wait, and only flips to `done` once
// the shell finishes and the turn ends (observed on 2.1.309 and 2.1.311). so a long gpu shell needs no extra signal.
export function liveLaunch(record, { now = Date.now(), alive = processAlive } = {}) {
  if (!record || typeof record !== 'object' || record.corrupt) return null;
  const request = record.request || {};
  const claims = sanitizeClaims(request.claims);
  if (TERMINAL.includes(record.state)) return null;
  const fresh = num(record.updatedAt) !== null && now - record.updatedAt <= JOB_FRESH_MS;
  let working = false;
  if (request.runtime === 'claude-code') working = record.state === 'running' && record.nativeState === 'working' && (fresh || alive(record.workerPid));
  else if (request.runtime === 'codex') working = record.state === 'running' && record.lastTurn === 'inProgress' && alive(record.workerPid);
  if (!working) return null;
  const { host, agent } = splitSource(record.source);
  return { id: request.id, name: clean(request.name, 80) || request.runtime, runtime: request.runtime, source: host, sourceAgent: agent, agentId: clean(record.agentId, 80), since: num(record.createdAt), claims };
}
// a compute job: a live launch that declared a claim. the claim is the only thing that sets compute/gpu=avoid.
export function liveJob(record, options) {
  const job = liveLaunch(record, options);
  return job?.claims.length ? job : null;
}

// a receipt that holds a session slot but cannot be live: dead worker, native job exited or blocked (or codex
// runtime gone) for longer than the stale window. returns the reason, or null. `agent` is the discovered session.
export function staleLaunch(record, { now = Date.now(), alive = processAlive, agent = null } = {}) {
  if (!record || record.corrupt || TERMINAL.includes(record.state) || agent || alive(record.workerPid)) return null;
  const idle = now - (num(record.updatedAt) ?? num(record.createdAt) ?? now);
  if (idle < STALE_AFTER_MS) return null;
  const hours = Math.floor(idle / 3600000);
  const runtime = record.request?.runtime;
  if (runtime === 'claude-code' && ['done', 'stopped', 'failed', 'removed', 'blocked'].includes(record.nativeState)) return `worker dead; native job ${record.nativeState} for ${hours}h`;
  if (runtime === 'codex' && !alive(record.runtimePid)) return `worker dead; codex runtime gone for ${hours}h`;
  if (record.state === 'starting' || record.state === 'uncertain') return `worker dead; ${record.state} for ${hours}h`;
  return null;
}

export function readKnownHostNames(busDir) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(busDir, 'lan', 'known-hosts.json'), 'utf8'));
    return new Map((Array.isArray(v?.hosts) ? v.hosts : []).filter((h) => UUID.test(h?.hostId || '')).map((h) => [h.hostId, clean(h.name, 63) || '']));
  } catch { return new Map(); }
}

// every parseable receipt in <busDir>/launches. corrupt files are skipped (the launcher quarantines them).
export function scanLaunches(busDir) {
  const dir = path.join(busDir, 'launches');
  let names; try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const f of names) {
    if (!f.endsWith('.json') || !UUID.test(f.slice(0, -5))) continue;
    try { const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); if (r && typeof r === 'object') out.push(r); } catch {}
  }
  return out;
}

// what the presence payload publishes. cheap enough for the daemon tick: one readdir plus small json reads, no spawns.
// every live launch, claimed first then unclaimed, each oldest first and capped at MAX_JOBS; splitLaunches separates them.
export function listLiveLaunches(busDir, { now = Date.now(), alive = processAlive, hostNames = readKnownHostNames(busDir) } = {}) {
  const live = [];
  for (const record of scanLaunches(busDir)) {
    const job = liveLaunch(record, { now, alive });
    if (job) live.push({ ...job, sourceName: job.source === 'local' ? 'local' : hostNames.get(job.source) || null });
  }
  const { jobs, unclaimed } = splitLaunches(live.sort((a, b) => (a.since ?? 0) - (b.since ?? 0)));
  return [...jobs, ...unclaimed];
}
export const listLaunchJobs = (busDir, options) => splitLaunches(listLiveLaunches(busDir, options)).jobs;
// `jobs` (claimed: compute) and `unclaimed` (informational), each capped. input order is kept.
export function splitLaunches(launches) {
  const all = Array.isArray(launches) ? launches : [];
  const claimed = (j) => Array.isArray(j?.claims) && j.claims.length > 0;
  return { jobs: all.filter(claimed).slice(0, MAX_JOBS), unclaimed: all.filter((j) => !claimed(j)).slice(0, MAX_JOBS) };
}

export function sanitizeJobs(jobs, { limit = MAX_JOBS } = {}) {
  if (!Array.isArray(jobs)) return [];
  return jobs.filter((j) => j && typeof j === 'object' && UUID.test(j.id || '')).slice(0, limit).map((j) => ({
    id: j.id, name: clean(j.name, 80) || 'job', runtime: ['codex', 'claude-code'].includes(j.runtime) ? j.runtime : null,
    source: UUID.test(j.source || '') ? j.source : 'local', sourceName: clean(j.sourceName, 63) || null, sourceAgent: clean(j.sourceAgent, 80) || null,
    agentId: clean(j.agentId, 80) || null, since: num(j.since), claims: sanitizeClaims(j.claims),
  }));
}
export const describeJob = (j) => `${j.name}${j.claims?.length ? ` [${j.claims.join(',')}]` : ''} for ${j.source === 'local' ? 'local' : j.sourceName || j.source.slice(0, 8)}`;
