import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assessPresence, sanitizePresence, setOverride, readOverride, parseDuration, presenceTracker, readSnapshot, createPresenceSampler, AWAY_AFTER_SEC } from '../lib/presence.mjs';

test('fullscreen means busy and avoid, whatever the gpu reads', () => {
  const p = assessPresence({ userIdleSec: 0, fullscreen: true, fullscreenApp: 'WardogsClient-Win64-Shipping', gpuUtil: 10 });
  assert.equal(p.user, 'busy');
  assert.equal(p.gpu, 'avoid');
  assert.match(p.reasons[0], /fullscreen app WardogsClient/);
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
test('windows D3D, foreground coverage and presentation stay protected at zero utilization', () => {
  const d3d = assessPresence(windowsSample(3));
  assert.equal(d3d.gpu, 'avoid'); assert.equal(d3d.fullscreen, true);
  assert.equal(d3d.fullscreenApp, null); assert.equal(d3d.fullscreenBasis, 'shell-d3d');
  assert.match(d3d.reasons[0], /process unidentified/);
  for (const state of [2, 5, 7]) {
    const p = assessPresence(windowsSample(state, { foregroundCoversMonitor: true, foreground: 'game' }));
    assert.equal(p.gpu, 'avoid'); assert.equal(p.fullscreenApp, 'game');
    assert.equal(p.fullscreenBasis, 'foreground-monitor');
  }
  const presentation = assessPresence(windowsSample(4));
  assert.equal(presentation.gpu, 'avoid'); assert.equal(presentation.user, 'busy');
  assert.equal(presentation.fullscreen, false); assert.equal(presentation.fullscreenApp, null);
  assert.match(presentation.reasons[0], /presentation mode/);
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
