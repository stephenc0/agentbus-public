import { localUsage, sanitizeUsage, formatUsage } from './usage.mjs';
import { atomicWriteFileSync } from './atomic-file.mjs';
// host presence: is a human using this machine, and is it a bad time for gpu-heavy work?
// sampled by the lan daemon (or on demand), shared with peers only over the authenticated
// inventory channel, never in mdns txt records.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHomePresenceSampler, sanitizeHomePresence, readHomePresenceConfig } from './home-presence.mjs';

export const busDir = () => process.env.AGENTBUS_DIR || path.join(os.homedir(), '.agentbus');
const overridePath = (dir = busDir()) => path.join(dir, 'presence-override.json');
const snapshotPath = (dir = busDir()) => path.join(dir, 'presence.json');
export const AWAY_AFTER_SEC = 600;      // no input for 10 minutes = away
export const GPU_BUSY_PCT = 50;         // sustained load above this = someone is using it

// SHQueryUserNotificationState
const QUNS = { 1: 'not_present', 2: 'busy', 3: 'd3d_fullscreen', 4: 'presentation', 5: 'accepts_notifications', 6: 'quiet_time', 7: 'app' };

const run = (cmd, args, timeout = 4000) => new Promise((resolve) => execFile(cmd, args, { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (e, out) => resolve(e ? '' : out)));

async function nvidiaGpu() {
  const out = await run('nvidia-smi', ['--query-gpu=utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits']);
  const rows = out.trim().split(/\r?\n/).filter(Boolean).map((l) => l.split(',').map((s) => Number(s.trim())));
  if (!rows.length || rows.some((r) => r.some((n) => !Number.isFinite(n)))) return null;
  return { gpuUtil: Math.max(...rows.map((r) => r[0])), gpuMemUsedMiB: rows.reduce((a, r) => a + r[1], 0), gpuMemTotalMiB: rows.reduce((a, r) => a + r[2], 0), gpuProbe: 'nvidia-smi' };
}
async function macProbe() {
  const [hid, accel] = await Promise.all([run('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4', '-r']), run('/usr/sbin/ioreg', ['-r', '-d', '1', '-c', 'IOAccelerator'])]);
  const idleNs = /"HIDIdleTime"\s*=\s*(\d+)/.exec(hid)?.[1];
  const utils = [...accel.matchAll(/"Device Utilization %"\s*=\s*(\d+)/g)].map((m) => Number(m[1]));
  return { userIdleSec: idleNs ? Math.round(Number(idleNs) / 1e9) : null, fullscreen: null, locked: null, gpuUtil: utils.length ? Math.max(...utils) : null, gpuProbe: utils.length ? 'ioreg' : null };
}

// Notification suppression is not a window measurement. QUNS_BUSY can mean a
// presentation or fullscreen app, but does not identify either; QUNS_APP merely
// means a Store app is running. Keep that uncertainty instead of inventing a name.
export function normalizeWindowsProbe(r, gpu = null) {
  const ok = r?.ok === true;
  const state = ok ? QUNS[r.notificationState] || null : null;
  const coverage = ok && typeof r.foregroundCoversMonitor === 'boolean' ? r.foregroundCoversMonitor : null;
  const basis = coverage === true ? 'foreground-monitor' : state === 'd3d_fullscreen' ? 'shell-d3d' : null;
  const fullscreen = basis ? true : !ok || state === 'busy' ? null : coverage === false ? false : null;
  return { userIdleSec: ok && Number.isFinite(r.idleMs) && r.idleMs >= 0 && r.idleMs < 2 ** 52 ? Math.round(r.idleMs / 1000) : null,
    fullscreen, fullscreenApp: coverage === true ? clean(r.foreground, 80) : null, fullscreenBasis: basis,
    shellState: state, foregroundCoversMonitor: coverage, foreground: ok ? clean(r.foreground, 80) : null,
    foregroundPid: ok && Number.isInteger(r.foregroundPid) && r.foregroundPid > 0 ? r.foregroundPid : null,
    probeObservedAt: ok ? num(r.observedAt) : null,
    locked: state === 'not_present' ? true : ok ? false : null, ...(gpu || { gpuUtil: null }) };
}

// windows needs user32/shell32; one long-lived powershell child amortizes the Add-Type cost.
function windowsProbe() {
  let child, lines, waiting = [];
  const start = () => {
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./presence-win.ps1', import.meta.url))], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (l) => { const w = waiting.shift(); if (w) { clearTimeout(w.timer); try { w.resolve(JSON.parse(l)); } catch { w.resolve(null); } } });
    child.on('exit', () => { for (const w of waiting.splice(0)) { clearTimeout(w.timer); w.resolve(null); } child = null; });
    child.on('error', () => {});
  };
  const sample = () => new Promise((resolve) => {
    if (!child) start();
    const w = { resolve, timer: setTimeout(() => { waiting = waiting.filter((x) => x !== w); resolve(null); child?.kill(); }, 8000) };
    waiting.push(w); child.stdin.write('\n');
  });
  return {
    async sample() {
      const [r, gpu] = await Promise.all([sample(), nvidiaGpu()]);
      return normalizeWindowsProbe(r, gpu);
    },
    close() { child?.kill(); },
  };
}

export function createPresenceSampler({ platform = process.platform } = {}) {
  if (platform === 'win32') return windowsProbe();
  if (platform === 'darwin') return { sample: macProbe, close() {} };
  return { async sample() { return { userIdleSec: null, fullscreen: null, locked: null, ...((await nvidiaGpu()) || { gpuUtil: null }) }; }, close() {} };
}

export function readOverride(dir, now = Date.now()) {
  try {
    const o = JSON.parse(fs.readFileSync(overridePath(dir), 'utf8'));
    if (!['busy', 'available'].includes(o.state) || (o.until && o.until <= now)) return null;
    return { state: o.state, reason: typeof o.reason === 'string' ? o.reason.slice(0, 160) : '', until: Number(o.until) || null, at: Number(o.at) || null };
  } catch { return null; }
}
export function setOverride(state, { reason = '', forMs, dir } = {}) {
  const file = overridePath(dir);
  if (state === 'auto') { fs.rmSync(file, { force: true }); return null; }
  if (!['busy', 'available'].includes(state)) throw Error('state must be busy, available or auto');
  const o = { state, reason: String(reason).slice(0, 160), until: forMs ? Date.now() + forMs : null, at: Date.now() };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(file, JSON.stringify(o), { mode: 0o600 });
  return o;
}
export function parseDuration(s) {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$/.exec(String(s || '').trim());
  if (!m) throw Error('duration like 90m, 2h or 1d');
  return Math.round(Number(m[1]) * { s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7 }[m[2] || 'm']);
}

// pure: raw probe + override -> verdict. `gpu`: free | shared | avoid. `user`: away | present | busy | unknown.
export function assessPresence(raw = {}, override = null, now = Date.now(), history = []) {
  const reasons = [];
  const r = { ...raw };
  // require two consecutive high samples so one spike doesn't flip the verdict.
  const util = Number.isFinite(r.gpuUtil) ? r.gpuUtil : null;
  const sustained = util !== null && util >= GPU_BUSY_PCT && (history.length === 0 || history.at(-1) >= GPU_BUSY_PCT);
  let user = 'unknown', gpu = 'shared';
  if (r.locked) user = 'away';
  else if (Number.isFinite(r.userIdleSec)) user = r.userIdleSec >= AWAY_AFTER_SEC ? 'away' : 'present';
  if (r.fullscreen) { user = 'busy'; gpu = 'avoid'; reasons.push(r.fullscreenBasis === 'shell-d3d' ? 'exclusive d3d fullscreen (shell evidence; process unidentified)' : `fullscreen app${r.fullscreenApp ? ` ${r.fullscreenApp}` : ''}${r.fullscreenBasis === 'foreground-monitor' ? ' (foreground covers monitor)' : ''}`); }
  if (r.shellState === 'presentation') { user = 'busy'; gpu = 'avoid'; reasons.push('windows presentation mode (shell evidence)'); }
  if (sustained) { gpu = 'avoid'; reasons.push(`gpu at ${util}%`); }
  if (gpu !== 'avoid') gpu = user === 'away' ? 'free' : 'shared';
  if (r.shellState === 'busy' && !r.fullscreen) {
    if (gpu !== 'avoid') gpu = 'shared';
    reasons.push('windows shell busy; fullscreen/presentation unconfirmed');
  }
  if (user === 'away' && !r.locked && Number.isFinite(r.userIdleSec)) reasons.push(`no input for ${Math.round(r.userIdleSec / 60)}m`);
  if (r.locked) reasons.push('session locked');
  if (user === 'present' && !r.fullscreen) reasons.push(`user active ${r.userIdleSec}s ago`);
  if (override?.state === 'busy') { user = 'busy'; gpu = 'avoid'; reasons.unshift(`marked busy${override.reason ? `: ${override.reason}` : ''}`); }
  if (override?.state === 'available') { gpu = sustained ? 'avoid' : 'free'; reasons.unshift(`marked available${override.reason ? `: ${override.reason}` : ''}`); }
  const guidance = gpu === 'avoid' ? 'do not start gpu-heavy or long cpu-heavy work here now; defer or ask'
    : gpu === 'shared' ? 'host active or availability uncertain; light work is fine, ask before heavy gpu jobs'
    : 'idle; heavy work is fine';
  return { at: now, user, host_activity: { state: user, observed_at: now, scope: 'host_input_not_home_presence' }, home: sanitizeHomePresence(r.home, now), gpu, reasons, guidance, userIdleSec: r.userIdleSec ?? null, fullscreen: r.fullscreen ?? null, fullscreenApp: r.fullscreenApp ?? null, ...windowEvidence(r), gpuUtil: util, gpuMemUsedMiB: r.gpuMemUsedMiB ?? null, gpuMemTotalMiB: r.gpuMemTotalMiB ?? null, override: override || null };
}

const clean = (v, n) => typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, n) : null;
const num = (v) => Number.isFinite(v) && v >= 0 ? v : null;
function windowEvidence(p) {
  return { shellState: Object.values(QUNS).includes(p.shellState) ? p.shellState : null,
    fullscreenBasis: ['foreground-monitor', 'shell-d3d'].includes(p.fullscreenBasis) ? p.fullscreenBasis : null,
    foregroundCoversMonitor: typeof p.foregroundCoversMonitor === 'boolean' ? p.foregroundCoversMonitor : null,
    foreground: clean(p.foreground, 80), foregroundPid: Number.isInteger(p.foregroundPid) && p.foregroundPid > 0 ? p.foregroundPid : null,
    probeObservedAt: num(p.probeObservedAt) };
}
export function sanitizePresence(p) {
  if (!p || typeof p !== 'object') return null;
  return {
    host_activity: { state: ['away', 'present', 'busy', 'unknown'].includes(p.user) ? p.user : 'unknown', observed_at: num(p.at), scope: 'host_input_not_home_presence' }, home: sanitizeHomePresence(p.home),
    at: num(p.at), user: ['away', 'present', 'busy', 'unknown'].includes(p.user) ? p.user : 'unknown', gpu: ['free', 'shared', 'avoid'].includes(p.gpu) ? p.gpu : 'shared',
    reasons: (Array.isArray(p.reasons) ? p.reasons : []).slice(0, 6).map((s) => clean(s, 160)).filter(Boolean), guidance: clean(p.guidance, 200),
    userIdleSec: num(p.userIdleSec), fullscreen: typeof p.fullscreen === 'boolean' ? p.fullscreen : null, fullscreenApp: clean(p.fullscreenApp, 80), ...windowEvidence(p),
    gpuUtil: num(p.gpuUtil), gpuMemUsedMiB: num(p.gpuMemUsedMiB), gpuMemTotalMiB: num(p.gpuMemTotalMiB),
    override: p.override && ['busy', 'available'].includes(p.override.state) ? { state: p.override.state, reason: clean(p.override.reason, 160) || '', until: num(p.override.until) } : null,
  };
}

export function writeSnapshot(p, { raw, history } = {}, dir) {
  const file = snapshotPath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(file, JSON.stringify({ ...p, raw, history }), { mode: 0o600 });
}
// a sampler plus the short gpu history the sustained-load rule needs.
export function presenceTracker({ sampler = createPresenceSampler(), dir, keep = 3, homeSampler = createHomePresenceSampler({ dir }) } = {}) {
  const history = []; let last = null;
  return {
    async update() {
      const before = [...history], [host, home] = await Promise.all([sampler.sample(), homeSampler.sample()]), raw = { ...host, home }, at = Date.now();
      if (Number.isFinite(raw.gpuUtil)) { history.push(raw.gpuUtil); if (history.length > keep) history.shift(); }
      last = { raw, at, before };
      const p = assessPresence(raw, readOverride(dir), at, before);
      try { writeSnapshot(p, { raw, history: before }, dir); } catch {}
      return p;
    },
    // re-assessed on read so a fresh override applies immediately, not at the next sample.
    current() { return last ? { ...assessPresence(last.raw, readOverride(dir), last.at, last.before), home: sanitizeHomePresence(last.raw.home) } : null; },
    close() { sampler.close(); homeSampler.close(); },
  };
}
export function readSnapshot(dir, maxAgeMs = 30000) {
  try { const p = JSON.parse(fs.readFileSync(snapshotPath(dir), 'utf8')); return Date.now() - p.at < maxAgeMs ? p : null; } catch { return null; }
}
// fresh daemon snapshot when available, else a one-shot probe (slower: spawns the platform probe).
export async function localPresence({ dir, homeSampler = createHomePresenceSampler({ dir }) } = {}) {
  // re-assess from the stored raw sample so a just-set override applies without waiting for the daemon.
  const snap = readSnapshot(dir);
  if (snap?.raw) {
    const config = readHomePresenceConfig(dir);
    // During a rolling upgrade an old daemon can still write fresh host-only
    // snapshots. Do not misreport an enabled home adapter as disabled.
    const refreshHome = !config.enabled || !snap.raw.home || snap.raw.home.status === 'disabled';
    try {
      const home = refreshHome ? await homeSampler.sample() : sanitizeHomePresence({ ...snap.raw.home, max_age_ms: config.maxAgeMs });
      return { ...assessPresence(snap.raw, readOverride(dir), snap.at, snap.history || []), home };
    } finally { homeSampler.close(); }
  }
  const sampler = createPresenceSampler();
  try { const [raw, home] = await Promise.all([sampler.sample(), homeSampler.sample()]); return assessPresence({ ...raw, home }, readOverride(dir)); } finally { sampler.close(); homeSampler.close(); }
}

// Evidence across hosts, never a claim about a specific person's location or absence.
// A positive signal wins; a negative requires fresh evidence from every known source.
export function summarizeNetworkPresence({ local, peers = [], lan = 'ok', knownHosts = [], coverageKnown = true } = {}, { now = Date.now(), maxAgeMs = 30000 } = {}) {
  const freshAt = (at, ttl) => Number.isFinite(at) && at >= 0 && at <= now && now - at <= ttl;
  const seen = new Set([local, ...peers].filter(Boolean).map(h => h.hostId));
  const missing = knownHosts.filter(h => h?.hostId && !seen.has(h.hostId)).map(h => ({ ...h, available: false, presence: { home: { status: 'unknown' } } }));
  const sources = [local, ...peers, ...missing].filter(Boolean).map((host) => {
    const p = host.presence, observed_at = num(p?.at);
    const connected = host.available !== false && (host.checkedAt === undefined || freshAt(host.checkedAt, maxAgeMs));
    const fresh = connected && freshAt(observed_at, maxAgeMs);
    const state = fresh && ['away', 'present', 'busy'].includes(p?.user) ? p.user : 'unknown';
    const home = sanitizeHomePresence(p?.home, now);
    return { hostId: clean(host.hostId, 64), name: clean(host.name, 100), host_activity: { state, observed_at, fresh },
      home: { status: home.status, occupancy: home.occupancy, motion: home.motion, observed_at: home.observed_at, checked_at: home.checked_at } };
  });
  const active = sources.some((s) => ['present', 'busy'].includes(s.host_activity.state));
  const allIdle = sources.length > 0 && sources.every((s) => s.host_activity.state === 'away');
  const homeSources = sources.filter((s) => s.home.status !== 'disabled');
  const aggregate = (key, positive) => homeSources.some((s) => s.home[key] === positive) ? positive
    : coverageKnown && homeSources.length && homeSources.every((s) => s.home[key] === 'not_detected') ? 'not_detected' : 'unknown';
  return { scope: 'not_person_identity', at: now, anyHostActive: active ? true : allIdle && lan === 'ok' && coverageKnown ? false : null,
    homeOccupancy: aggregate('occupancy', 'occupied'), homeMotion: aggregate('motion', 'detected'),
    hostCoverage: sources.length && sources.every((s) => s.host_activity.state !== 'unknown') && lan === 'ok' && coverageKnown ? 'complete' : 'partial', sources };
}

// this host plus every fresh lan peer (via the local daemon's status op, which needs no key access).
export async function hostStatuses({ dir } = {}) {
  const [local, usage] = await Promise.all([localPresence({ dir }), localUsage({ dir })]);
  let peers = [], inventory = [], knownHosts = [], coverageKnown = false, lan = 'not running', localHostId = null;
  try {
    const { localLanRequest } = await import('./lan.mjs');
    const s = await localLanRequest({ op: 'status' }, { timeout: 2000 });
    if (s?.ok) {
      lan = 'ok'; localHostId = s.hostId || null;
      knownHosts = Array.isArray(s.knownHosts) ? s.knownHosts : []; coverageKnown = s.knownHostCoverageComplete === true;
      inventory = (s.peers || []).map((p) => ({ hostId: p.hostId, name: p.name, checkedAt: p.checkedAt, available: !p.error, presence: sanitizePresence(p.presence) }));
      peers = (s.peers || []).filter((p) => !p.error && Date.now() - p.checkedAt < 30000)
        .map((p) => ({ hostId: p.hostId, name: p.name, presence: sanitizePresence(p.presence), usage: sanitizeUsage(p.usage) }));
    }
  } catch {}
  const localHost = { hostId: localHostId, name: os.hostname(), presence: local, usage };
  return { local: localHost, peers, lan, networkPresence: summarizeNetworkPresence({ local: localHost, peers: inventory, lan, knownHosts, coverageKnown }) };
}
export function formatHostStatuses({ local, peers, lan, networkPresence }) {
  const rows = [`this host (${local.name}): ${formatPresence(local.presence)}`, formatUsage(local.usage)];
  for (const p of peers) rows.push(`${p.name} [lan:${p.hostId}]: ${formatPresence(p.presence)}`, formatUsage(p.usage));
  rows.push('usage is account-scoped, not per-host capacity; do not sum host quotas.');
  if (networkPresence) rows.push(`network: any host active=${networkPresence.anyHostActive ?? 'unknown'}, home occupancy=${networkPresence.homeOccupancy}, motion=${networkPresence.homeMotion} (not person identity)`);
  if (lan !== 'ok') rows.push(`(lan daemon ${lan}; remote hosts not shown)`);
  return rows.join('\n');
}

export function formatPresence(p) {
  if (!p) return 'presence unknown';
  const home = sanitizeHomePresence(p.home);
  const homeText = home.status === 'disabled' ? '' : `; home occupancy=${home.occupancy}, motion=${home.motion} (${home.status}; not person identity)`;
  const evidence = p.shellState ? `; shell=${p.shellState}, foreground=${p.foreground || 'unknown'}${p.foregroundPid ? ` (pid ${p.foregroundPid})` : ''}, monitor coverage=${p.foregroundCoversMonitor ?? 'unknown'}, sample age=${Number.isFinite(p.at) && p.at <= Date.now() ? `${Math.floor((Date.now() - p.at) / 1000)}s` : 'unknown'}` : '';
  return `${p.user}, gpu=${p.gpu}${p.gpuUtil !== null && p.gpuUtil !== undefined ? ` (${p.gpuUtil}%)` : ''}${p.reasons?.length ? ` [${p.reasons.join('; ')}]` : ''} -> ${p.guidance}${homeText}${evidence}`;
}
