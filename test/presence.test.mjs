import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assessPresence, sanitizePresence, setOverride, readOverride, parseDuration, presenceTracker, readSnapshot, createPresenceSampler, AWAY_AFTER_SEC } from '../lib/presence.mjs';

test('a fullscreen game means busy and avoid, whatever the gpu reads; unknown apps count as games', () => {
  const p = assessPresence({ userIdleSec: 0, fullscreen: true, fullscreenApp: 'WardogsClient-Win64-Shipping', gpuUtil: 10 });
  assert.equal(p.user, 'busy');
  assert.equal(p.gpu, 'avoid'); assert.equal(p.fullscreenGame, true);
  assert.match(p.reasons[0], /fullscreen game: WardogsClient.*not on the non-game list/);
  const unnamed = assessPresence({ userIdleSec: 0, fullscreen: true, gpuUtil: 0 });
  assert.equal(unnamed.gpu, 'avoid'); assert.match(unnamed.reasons[0], /fullscreen game: unidentified app/);
});

test('fullscreen non-game apps (video, browser, slides) mark the human busy but leave the gpu shared', () => {
  for (const app of ['chrome', 'Chrome', 'msedge.exe', 'vlc', 'mpv', 'POWERPNT', 'potplayermini64']) {
    const p = assessPresence({ userIdleSec: 0, fullscreen: true, fullscreenApp: app, fullscreenBasis: 'foreground-monitor', shellState: 'busy', gpuUtil: 20 });
    assert.equal(p.user, 'busy', app); assert.equal(p.gpu, 'shared', app); assert.equal(p.fullscreenGame, false, app);
    assert.match(p.reasons[0], /fullscreen non-game app .* \(foreground covers monitor; gpu stays shared\)/, app);
  }
  const yt = { userIdleSec: 0, fullscreen: true, fullscreenApp: 'chrome', fullscreenBasis: 'foreground-monitor' };
  // every other avoid path still applies on top of a non-game fullscreen
  assert.equal(assessPresence({ ...yt, gpuUtil: 90 }, null, Date.now(), [90]).gpu, 'avoid');
  assert.equal(assessPresence({ ...yt, gpuUtil: 0 }, { state: 'busy' }).gpu, 'avoid');
  // the shell saying exclusive d3d outranks the process name
  const d3d = assessPresence({ ...yt, shellState: 'd3d_fullscreen', gpuUtil: 0 });
  assert.equal(d3d.gpu, 'avoid'); assert.match(d3d.reasons[0], /fullscreen game: chrome .*exclusive d3d/);
  assert.equal(sanitizePresence(assessPresence({ ...yt, gpuUtil: 0 })).fullscreenGame, false);
  assert.equal(sanitizePresence({ fullscreenGame: 'yes' }).fullscreenGame, null);
});

test('idle and locked hosts are free; active hosts are shared', () => {
  assert.equal(assessPresence({ userIdleSec: AWAY_AFTER_SEC + 1, fullscreen: false, gpuUtil: 0 }).gpu, 'free');
  assert.equal(assessPresence({ userIdleSec: 5, locked: true, gpuUtil: 0 }).user, 'away');
  const active = assessPresence({ userIdleSec: 5, fullscreen: false, gpuUtil: 0 });
  assert.equal(active.user, 'present');
  assert.equal(active.gpu, 'shared');
  assert.equal(assessPresence({}).user, 'unknown');
});

test('gpu load must be sustained across two samples', () => {
  const raw = { userIdleSec: 9999, fullscreen: false, gpuUtil: 90 };
  assert.equal(assessPresence(raw, null, Date.now(), [3]).gpu, 'free');
  assert.equal(assessPresence(raw, null, Date.now(), [80]).gpu, 'avoid');
  assert.equal(assessPresence(raw, null, Date.now(), []).gpu, 'avoid'); // first sample: no evidence it is a spike
});

test('overrides: busy always wins, available yields to real load, expiry and auto clear', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-ovr-'));
  try {
    const idle = { userIdleSec: 9999, fullscreen: false, gpuUtil: 0 };
    setOverride('busy', { reason: 'rendering', dir });
    const busy = assessPresence(idle, readOverride(dir));
    assert.equal(busy.gpu, 'avoid');
    assert.match(busy.reasons[0], /marked busy: rendering/);
    setOverride('available', { dir });
    assert.equal(assessPresence({ userIdleSec: 1, fullscreen: true, gpuUtil: 0 }, readOverride(dir)).gpu, 'free');
    assert.equal(assessPresence({ userIdleSec: 1, gpuUtil: 99 }, readOverride(dir), Date.now(), [99]).gpu, 'avoid');
    setOverride('busy', { forMs: 1000, dir });
    assert.equal(readOverride(dir, Date.now() + 2000), null);
    setOverride('auto', { dir });
    assert.equal(readOverride(dir), null);
    assert.throws(() => setOverride('maybe', { dir }));
    assert.equal(parseDuration('2h'), 7.2e6);
    assert.equal(parseDuration('90'), 5.4e6);
    assert.throws(() => parseDuration('soon'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('peer presence is sanitized', () => {
  const p = sanitizePresence({ at: 1, user: 'root', gpu: 'yes', reasons: ['a\nb', 5, 'x'.repeat(500)], fullscreenApp: 'g\x1b[31m', gpuUtil: -4, override: { state: 'pwn' }, raw: { secret: 1 } });
  assert.equal(p.user, 'unknown');
  assert.equal(p.gpu, 'shared');
  assert.deepEqual(p.reasons.map((r) => r.length), [3, 160]);
  assert.equal(p.fullscreenApp, 'g [31m');
  assert.equal(p.gpuUtil, null);
  assert.equal(p.override, null);
  assert.equal(p.raw, undefined);
  assert.equal(sanitizePresence('nope'), null);
});

test('tracker snapshots raw samples and applies a new override without resampling', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-trk-'));
  try {
    const samples = [{ userIdleSec: 9999, gpuUtil: 80 }, { userIdleSec: 9999, gpuUtil: 85 }];
    let n = 0;
    const t = presenceTracker({ sampler: { sample: async () => samples[n++], close() {} }, dir });
    assert.equal(t.current(), null);
    assert.equal((await t.update()).gpu, 'avoid');
    assert.equal((await t.update()).gpu, 'avoid');
    assert.equal(readSnapshot(dir).raw.gpuUtil, 85);
    setOverride('busy', { dir });
    assert.equal(t.current().override.state, 'busy');
    t.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('live probe returns a well-formed sample on this platform', { timeout: 20000 }, async () => {
  const s = createPresenceSampler();
  try {
    const raw = await s.sample();
    assert(raw && typeof raw === 'object');
    // Service/CI sessions may have no interactive desktop. Unknown is valid,
    // but malformed or negative input telemetry is not. Strict live checks are opt-in.
    assert(raw.userIdleSec === null || (Number.isFinite(raw.userIdleSec) && raw.userIdleSec >= 0), JSON.stringify(raw));
    if (process.env.AGENTBUS_REQUIRE_LIVE_PRESENCE === '1') assert(Number.isFinite(raw.userIdleSec), JSON.stringify(raw));
    const p = assessPresence(raw);
    assert(['free', 'shared', 'avoid'].includes(p.gpu));
  } finally { s.close(); }
});

test('home occupancy never overrides host activity or GPU scheduling', () => {
  const now = Date.now(), signal = { value: true, observed_at: now, succeeded: true };
  const home = { status: 'ok', sensors: [{ id: 'test', reachable: true, occupancy: signal, motion: signal }] };
  const p = assessPresence({ userIdleSec: 9999, gpuUtil: 0, home }, null, now);
  assert.equal(p.user, 'away'); assert.equal(p.gpu, 'free');
  assert.equal(p.host_activity.scope, 'host_input_not_home_presence');
  assert.equal(p.home.occupancy, 'occupied');
  assert.equal(sanitizePresence(p).home.occupancy, 'occupied');
  assert.equal(sanitizePresence({ user: 'present', at: now }).home.status, 'disabled');
});

test('network presence: active mac overrides idle windows without claiming user location', async () => {
  const { summarizeNetworkPresence } = await import('../lib/presence.mjs');
  const now = Date.now(), mac = { name: 'mac', presence: { at: now, user: 'present', gpu: 'shared' } }, windows = { name: 'windows', presence: { at: now, user: 'away', gpu: 'free' } };
  const before = JSON.stringify({ mac, windows });
  const p = summarizeNetworkPresence({ local: windows, peers: [mac] }, { now });
  assert.equal(p.anyHostActive, true); assert.equal(p.scope, 'not_person_identity'); assert.equal(p.homeOccupancy, 'unknown');
  assert.deepEqual(p.sources.map((s) => s.name), ['windows', 'mac']);
  assert.equal(p.sources[1].host_activity.observed_at, now);
  assert.equal(JSON.stringify({ mac, windows }), before);
});

test('network presence preserves uncertainty for stale, future, unreachable or unknown hosts', async () => {
  const { summarizeNetworkPresence } = await import('../lib/presence.mjs');
  const now = Date.now(), local = { name: 'mac', presence: { at: now, user: 'away' } };
  assert.equal(summarizeNetworkPresence({ local }, { now }).anyHostActive, false);
  assert.equal(summarizeNetworkPresence({ local, lan: 'not running' }, { now }).anyHostActive, null);
  for (const peer of [
    { presence: { at: now - 30001, user: 'present' } }, { presence: { at: now + 1, user: 'present' } },
    { presence: { at: now, user: 'unknown' } }, { presence: null },
    { available: false, presence: { at: now, user: 'present' } },
    { checkedAt: now - 30001, presence: { at: now, user: 'present' } },
  ]) assert.equal(summarizeNetworkPresence({ local, peers: [peer] }, { now }).anyHostActive, null);
  assert.equal(summarizeNetworkPresence({}, { now }).anyHostActive, null);
});

test('network occupancy uses fresh successful sensor reads and disabled hosts do not dilute readings', async () => {
  const { summarizeNetworkPresence } = await import('../lib/presence.mjs');
  const now = Date.now(), signal = { value: true, observed_at: now, succeeded: true };
  const home = { status: 'ok', checked_at: now, max_age_ms: 1000, sensors: [{ id: 'test', reachable: true, occupancy: signal, motion: signal }] };
  const mac = { name: 'mac', presence: { at: now, user: 'away', home } }, windows = { name: 'windows', presence: { at: now, user: 'away' } };
  const p = summarizeNetworkPresence({ local: mac, peers: [windows] }, { now });
  assert.equal(p.anyHostActive, false); assert.equal(p.homeOccupancy, 'occupied'); assert.equal(p.homeMotion, 'detected');
  assert.equal(p.sources[0].home.observed_at, now); assert.equal(p.sources[1].home.status, 'disabled');
  const stale = summarizeNetworkPresence({ local: mac, peers: [windows] }, { now: now + 1001 });
  assert.equal(stale.homeOccupancy, 'unknown'); assert.equal(stale.homeMotion, 'unknown');
  const negative = structuredClone(mac); negative.presence.home.sensors[0].occupancy.value = false;
  assert.equal(summarizeNetworkPresence({ local: negative, peers: [windows] }, { now }).homeOccupancy, 'not_detected');
  const offline = { presence: { at: now, user: 'away', home: { status: 'offline' } } };
  assert.equal(summarizeNetworkPresence({ local: negative, peers: [offline] }, { now }).homeOccupancy, 'unknown');
});

test('local presence upgrades legacy host snapshots and immediately honors home opt-out', async (t) => {
  const { localPresence, writeSnapshot } = await import('../lib/presence.mjs');
  const { setHomePresenceConfig } = await import('../lib/home-presence.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-legacy-pres-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const raw = { userIdleSec: 12, gpuUtil: 1 }, now = Date.now();
  writeSnapshot(assessPresence(raw, null, now), { raw }, dir);
  setHomePresenceConfig({ enabled: true, sensors: ['26BEBD21-C4AF-5CBA-ADF6-E97319A7719D'] }, { dir });
  let reads = 0, closes = 0;
  const homeSampler = { sample: async () => { reads++; return { status: 'ok', occupancy: 'occupied' }; }, close: () => closes++ };
  const legacy = await localPresence({ dir, homeSampler });
  assert.equal(legacy.user, 'present'); assert.equal(legacy.at, now); assert.equal(legacy.home.occupancy, 'occupied');
  assert.equal(reads, 1); assert.equal(closes, 1);
  writeSnapshot(assessPresence({ ...raw, home: { status: 'ok' } }, null, now), { raw: { ...raw, home: { status: 'ok', occupancy: 'occupied' } } }, dir);
  setHomePresenceConfig({ enabled: false }, { dir });
  assert.equal((await localPresence({ dir })).home.status, 'disabled');
});

import { normalizeWindowsProbe, formatPresence } from '../lib/presence.mjs';
const windowsSample = (notificationState, extra = {}) => normalizeWindowsProbe({ ok: true, idleMs: 700_000, notificationState, foregroundCoversMonitor: false, foreground: 'editor', foregroundPid: 123, observedAt: 1_000, ...extra }, { gpuUtil: 0 });
test('windows busy notification state is unconfirmed, not invented fullscreen', () => {
  const raw = windowsSample(2), p = assessPresence(raw, null, 1_000);
  assert.equal(raw.fullscreen, null); assert.equal(raw.fullscreenApp, null);
  assert.equal(p.user, 'away'); assert.equal(p.gpu, 'shared');
  assert.match(p.reasons.join(';'), /shell busy; fullscreen\/presentation unconfirmed/);
  assert(!p.reasons.join(';').includes('fullscreen app busy'));
  assert.equal(p.shellState, 'busy'); assert.equal(p.foreground, 'editor');
  assert.equal(p.foregroundPid, 123); assert.equal(p.foregroundCoversMonitor, false);
  assert.equal(p.probeObservedAt, 1_000);
  assert.match(formatPresence(p), /shell=busy, foreground=editor \(pid 123\), monitor coverage=false, sample age=/);
});
test('windows D3D and unknown covering apps stay protected at zero utilization; presentation is busy but shared', () => {
  const d3d = assessPresence(windowsSample(3));
  assert.equal(d3d.gpu, 'avoid'); assert.equal(d3d.fullscreen, true);
  assert.equal(d3d.fullscreenApp, null); assert.equal(d3d.fullscreenBasis, 'shell-d3d');
  assert.match(d3d.reasons[0], /fullscreen game: exclusive d3d .*process unidentified/);
  for (const state of [2, 5, 7]) {
    const p = assessPresence(windowsSample(state, { foregroundCoversMonitor: true, foreground: 'game' }));
    assert.equal(p.gpu, 'avoid'); assert.equal(p.fullscreenApp, 'game');
    assert.equal(p.fullscreenBasis, 'foreground-monitor');
  }
  const presentation = assessPresence(windowsSample(4));
  assert.equal(presentation.gpu, 'shared'); assert.equal(presentation.user, 'busy');
  assert.equal(presentation.fullscreen, false); assert.equal(presentation.fullscreenApp, null);
  assert.match(presentation.reasons[0], /presentation mode .*not a game/);
  const video = assessPresence(windowsSample(2, { foregroundCoversMonitor: true, foreground: 'chrome' }));
  assert.equal(video.user, 'busy'); assert.equal(video.gpu, 'shared'); assert.equal(video.fullscreenBasis, 'foreground-monitor');
});
test('windows app/quiet/normal states do not imply fullscreen; overrides and GPU still apply', () => {
  for (const state of [5, 6, 7]) {
    const p = assessPresence(windowsSample(state));
    assert.equal(p.fullscreen, false); assert.equal(p.gpu, 'free');
  }
  assert.equal(assessPresence(windowsSample(7), { state: 'busy' }).gpu, 'avoid');
  assert.equal(assessPresence(windowsSample(2), { state: 'available' }).gpu, 'free');
  assert.equal(assessPresence({ ...windowsSample(2), gpuUtil: 90 }, null, Date.now(), [90]).gpu, 'avoid');
  assert.equal(normalizeWindowsProbe(null).fullscreen, null);
  assert.equal(normalizeWindowsProbe({ ok: false, notificationState: 3 }).shellState, null);
});
test('windows evidence survives sanitization but spoofed arbitrary fields do not', () => {
  const raw = windowsSample(2, { foreground: 'editor\u0007', foregroundPid: -3 });
  const p = sanitizePresence({ ...assessPresence(raw), secret: 'private', foregroundPid: -3 });
  assert.equal(p.foreground, 'editor '); assert.equal(p.foregroundPid, null);
  assert.equal(p.shellState, 'busy'); assert.equal(p.secret, undefined);
  assert.equal(sanitizePresence({ shellState: 'invented', fullscreenBasis: 'invented' }).shellState, null);
});

test('a live compute job for a peer means gpu=avoid, same tier as a manual busy mark; overrides still win', async () => {
  const { normalizeWindowsProbe, formatPresence } = await import('../lib/presence.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-jobs-pres-'));
  try {
    const job = { id: '2b8e6f14-9c3d-4a7e-b5f2-0d1c6a9e4b83', name: 'colabfold demo-complex-b', runtime: 'claude-code', source: 'b29c1927-9f56-4f94-845f-4b53a2fa231b', sourceName: 'laptop', sourceAgent: 'claude:a45dd0c3', agentId: 'claude:bec29ebf', since: 1, claims: ['gpu'] };
    const idle = { userIdleSec: 9999, fullscreen: false, gpuUtil: 0, jobs: [job], wsl: true };
    const p = assessPresence(idle);
    assert.equal(p.gpu, 'avoid'); assert.equal(p.user, 'away', 'a remote job does not make the human busy');
    assert.equal(p.compute, true); assert.equal(p.wsl, true); assert.equal(p.jobs.length, 1); assert.equal(p.jobs[0].name, job.name);
    assert.equal(p.reasons[0], 'compute job: colabfold demo-complex-b [gpu] for laptop');
    assert.match(p.guidance, /do not start/);
    const none = assessPresence({ ...idle, jobs: [] });
    assert.equal(none.gpu, 'free'); assert.equal(none.compute, false); assert.deepEqual(none.jobs, []);
    assert.equal(assessPresence({ userIdleSec: 1, jobs: [job] }).wsl, null);
    setOverride('busy', { reason: 'rendering', dir });
    const busy = assessPresence(idle, readOverride(dir));
    assert.match(busy.reasons[0], /marked busy/); assert.match(busy.reasons[1], /compute job/); assert.equal(busy.user, 'busy');
    setOverride('available', { dir });
    assert.equal(assessPresence(idle, readOverride(dir)).gpu, 'free', 'manual available wins over a claim');
    assert.equal(assessPresence({ ...idle, gpuUtil: 90 }, readOverride(dir), Date.now(), [90]).gpu, 'avoid');
    // sanitizer round trip: what a peer sees
    const s = sanitizePresence(p);
    assert.equal(s.compute, true); assert.equal(s.wsl, true); assert.deepEqual(s.jobs, p.jobs); assert.match(s.reasons[0], /compute job/);
    const junk = sanitizePresence({ at: 1, user: 'away', gpu: 'avoid', compute: 'yes', wsl: 'true', jobs: [{ id: 'bogus' }, { ...job, claims: 'gpu', name: 'n\u0000' }] });
    assert.equal(junk.compute, false); assert.equal(junk.wsl, null); assert.equal(junk.jobs.length, 1); assert.deepEqual(junk.jobs[0].claims, []); assert.equal(junk.jobs[0].name, 'n ');
    assert.match(formatPresence(s), /compute=true \(colabfold demo-complex-b \[gpu\] for laptop\), wsl vm running/);
    assert.match(formatPresence(sanitizePresence(none)), /compute=false/);
    // windows probe plumbs the vm flag; anything but a boolean is unknown
    assert.equal(normalizeWindowsProbe({ ok: true, idleMs: 5, notificationState: 5, wsl: true }).wsl, true);
    assert.equal(normalizeWindowsProbe({ ok: true, idleMs: 5, notificationState: 5, wsl: 'yes' }).wsl, null);
    assert.equal(normalizeWindowsProbe({ ok: false }).wsl, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an unclaimed live launch is published as unclaimed and never moves gpu, user or compute', async () => {
  const { formatPresence } = await import('../lib/presence.mjs');
  const launch = { id: '1ae14fad-773f-445d-9eaa-7e20d25476e3', name: 'colabfold-demo-complex-c', runtime: 'claude-code', source: 'b29c1927-9f56-4f94-845f-4b53a2fa231b', sourceName: 'laptop', sourceAgent: 'claude:a45dd0c3', agentId: 'claude:d7337c2e', since: 1, claims: [] };
  const claimed = { ...launch, id: '2b8e6f14-9c3d-4a7e-b5f2-0d1c6a9e4b83', name: 'render', claims: ['gpu'] };
  const idle = assessPresence({ userIdleSec: 9999, fullscreen: false, gpuUtil: 0, jobs: [launch] });
  assert.equal(idle.gpu, 'free', 'no claim, no promise about load: an idle gpu stays free'); assert.equal(idle.user, 'away');
  assert.equal(idle.compute, false); assert.deepEqual(idle.jobs, []); assert.deepEqual(idle.unclaimed.map((j) => j.name), ['colabfold-demo-complex-c']);
  assert.ok(!idle.reasons.some((r) => /compute|colabfold/.test(r)));
  // the observed winbox case: a loaded gpu is avoided by the sustained-load rule, still with no fabricated job
  const loaded = assessPresence({ userIdleSec: 9999, fullscreen: false, gpuUtil: 100, jobs: [launch] }, null, Date.now(), [100]);
  assert.equal(loaded.gpu, 'avoid'); assert.equal(loaded.compute, false); assert.equal(loaded.unclaimed.length, 1);
  const both = assessPresence({ userIdleSec: 9999, gpuUtil: 0, jobs: [launch, claimed] });
  assert.deepEqual(both.jobs.map((j) => j.name), ['render']); assert.deepEqual(both.unclaimed.map((j) => j.name), ['colabfold-demo-complex-c']); assert.equal(both.compute, true);
  const s = sanitizePresence(idle);
  assert.deepEqual(s.unclaimed, idle.unclaimed); assert.deepEqual(sanitizePresence({ unclaimed: 'x' }).unclaimed, []);
  assert.match(formatPresence(s), /compute=false; unclaimed launches \(no compute claim\): colabfold-demo-complex-c for laptop/);
  assert.doesNotMatch(formatPresence(sanitizePresence(assessPresence({ userIdleSec: 9999, gpuUtil: 0, jobs: [] }))), /unclaimed/);
});

test('presence still links and assesses against a launch-jobs module cached from before unclaimed existed', async () => {
  // a long-lived mcp server imports presence lazily: it can pair a fresh presence.mjs with an old cached launch-jobs.mjs.
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-mixed-'));
  try {
    const real = new URL('../lib/', import.meta.url);
    for (const f of fs.readdirSync(real)) fs.copyFileSync(new URL(f, real), path.join(lib, f));
    fs.writeFileSync(path.join(lib, 'launch-jobs.mjs'), `export { listLaunchJobs, sanitizeJobs, describeJob, sanitizeClaims, staleLaunch, TERMINAL, MAX_JOBS } from ${JSON.stringify(new URL('launch-jobs.mjs', real).href)};\n`);
    const old = await import(pathToFileURL(path.join(lib, 'presence.mjs')).href);
    const job = { id: '2b8e6f14-9c3d-4a7e-b5f2-0d1c6a9e4b83', name: 'render', runtime: 'claude-code', source: 'local', since: 1, claims: ['gpu'] };
    const p = old.assessPresence({ userIdleSec: 9999, gpuUtil: 0, jobs: [job] });
    assert.equal(p.compute, true); assert.equal(p.gpu, 'avoid'); assert.deepEqual(p.unclaimed, []);
  } finally { fs.rmSync(lib, { recursive: true, force: true }); }
});

test('tracker derives jobs from the launch receipts on its tick, and a one-shot localPresence re-derives them', async () => {
  const { localPresence } = await import('../lib/presence.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-trk-jobs-'));
  try {
    const launches = path.join(dir, 'launches'); fs.mkdirSync(launches);
    const id = '7d2e9c4a-5b1f-4e8a-9c3d-2f6a8b0e4d17';
    const write = (over) => fs.writeFileSync(path.join(launches, id + '.json'), JSON.stringify({ source: 'local/claude:me', request: { id, runtime: 'claude-code', cwd: dir, prompt: 'p', name: 'render', claims: ['gpu'] }, state: 'running', nativeState: 'working', workerPid: process.pid, createdAt: 1, updatedAt: Date.now(), ...over }));
    write({});
    const t = presenceTracker({ sampler: { sample: async () => ({ userIdleSec: 9999, gpuUtil: 0 }), close() {} }, dir });
    const p = await t.update();
    assert.equal(p.gpu, 'avoid'); assert.equal(p.compute, true); assert.equal(p.jobs[0].id, id); assert.equal(p.jobs[0].sourceName, 'local');
    assert.equal(readSnapshot(dir).raw.jobs[0].name, 'render');
    assert.equal(t.current().compute, true);
    write({ state: 'stopped', nativeState: 'done' });
    assert.equal(t.current().compute, true, 'current() rides the tick, not the disk');
    assert.equal((await t.update()).compute, false);
    assert.equal((await t.update()).gpu, 'free');
    write({});
    const one = await localPresence({ dir, homeSampler: { sample: async () => ({ status: 'disabled' }), close() {} } });
    assert.equal(one.compute, true, 'cli/mcp read re-derives jobs from disk against the daemon snapshot');
    write({ request: { id, runtime: 'claude-code', cwd: dir, prompt: 'p', name: 'render' } });
    const unclaimed = await t.update();
    assert.equal(unclaimed.compute, false); assert.equal(unclaimed.gpu, 'free'); assert.equal(unclaimed.unclaimed[0].id, id, 'a spawn without claims is visible but not compute');
    const broken = presenceTracker({ sampler: { sample: async () => ({ userIdleSec: 9999, gpuUtil: 0 }), close() {} }, dir, jobs: () => { throw Error('boom'); } });
    assert.equal((await broken.update()).compute, false, 'a jobs failure never breaks presence');
    t.close(); broken.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
