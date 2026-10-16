import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHomePresenceSampler, normalizeHomeAccessory, normalizeDetection, sanitizeHomePresence, setHomePresenceConfig, readHomePresenceConfig } from '../lib/home-presence.mjs';
const id = '26BEBD21-C4AF-5CBA-ADF6-E97319A7719D';
const other = 'F51BB8BC-A7B3-5730-BF37-460BDF3561EF';
const now = 1791927900000;
const detail = (overrides = {}) => ({ id, reachable: true, name: 'Bedroom', services: [{ characteristics: ['occupancy_detected', 'motion_detected'].map((name) => ({ name, value: name === 'occupancy_detected' ? 'true' : 'false', read: { succeeded: true, observed_at: new Date(now).toISOString() }, ...overrides })) }] });
const home = (d, at = now) => sanitizeHomePresence({ status: 'ok', checked_at: at, sensors: [normalizeHomeAccessory(d, id, { now: at })] }, at);
const temp = (t) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-home-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };

test('normalizes only explicit boolean sensor values and separates motion from occupancy', () => {
  for (const value of [true, 1, '1', 'true']) assert.equal(normalizeDetection(value), true);
  for (const value of [false, 0, '0', 'false']) assert.equal(normalizeDetection(value), false);
  for (const value of [null, undefined, '', 'nil', '--', 'occupied', 2]) assert.equal(normalizeDetection(value), null);
  const p = home(detail());
  assert.equal(p.occupancy, 'occupied'); assert.equal(p.motion, 'not_detected');
  assert.equal(p.scope, 'home_occupancy_not_identity'); assert.equal(p.observed_at, now);
});

test('requires per-characteristic successful live read evidence, not cached values or transport success', () => {
  for (const read of [undefined, { observed_at: now }, { observed_at: now, succeeded: false }, { observed_at: now + 1, succeeded: true }, { observed_at: now - 120001, succeeded: true }]) {
    assert.equal(home(detail({ read })).occupancy, 'unknown');
  }
  assert.equal(home({ ...detail(), reachable: false }).occupancy, 'unknown');
  assert.equal(home({ ...detail(), id: other }).occupancy, 'unknown');
  assert.equal(home({ ...detail(), services: undefined, state: { occupancy_detected: true }, refreshed: true, read_succeeded: 5 }).occupancy, 'unknown');
});

test('stale snapshots and malicious peer fields cannot keep presence fresh', () => {
  const p = home(detail());
  assert.equal(sanitizeHomePresence({ ...p, checked_at: now + 200000, occupancy: 'occupied' }, now + 120001).occupancy, 'unknown');
  assert.equal(sanitizeHomePresence({ occupancy: 'occupied', observed_at: now, checked_at: now }, now).occupancy, 'unknown');
  const dirty = structuredClone(p); dirty.sensors[0].name = 'bed\nroom\x1b'; dirty.secret = 'private';
  assert.equal(sanitizeHomePresence(dirty, now).sensors[0].name, 'bed room ');
  assert.equal(sanitizeHomePresence(dirty, now).secret, undefined);
});

test('offline or partial sensor set cannot establish an all-clear; positive evidence still wins', () => {
  const good = normalizeHomeAccessory(detail({ value: 'false' }), id, { now });
  const missing = normalizeHomeAccessory(null, other, { now });
  const p = sanitizeHomePresence({ sensors: [good, missing] }, now);
  assert.equal(p.occupancy, 'unknown'); assert.equal(p.status, 'partial');
  const occupied = normalizeHomeAccessory(detail(), id, { now });
  assert.equal(sanitizeHomePresence({ sensors: [occupied, missing] }, now).occupancy, 'occupied');
});

test('opt-in configuration validates ids, bounds resource use, and never probes when disabled', async (t) => {
  const dir = temp(t); let calls = 0;
  const sampler = createHomePresenceSampler({ dir, read: async () => { calls++; return detail(); }, clock: () => now });
  assert.equal((await sampler.sample()).status, 'disabled'); assert.equal(calls, 0);
  assert.throws(() => setHomePresenceConfig({ enabled: true }, { dir }));
  assert.throws(() => setHomePresenceConfig({ enabled: true, sensors: ['--help'] }, { dir }));
  const config = setHomePresenceConfig({ enabled: true, sensors: [id], pollMs: 0, timeoutMs: 999999 }, { dir });
  assert.equal(config.pollMs, 10000); assert.equal(config.timeoutMs, 10000);
  assert.equal((await sampler.sample()).occupancy, 'occupied'); assert.equal(calls, 1);
  setHomePresenceConfig({ enabled: false }, { dir });
  assert.equal((await sampler.sample()).status, 'disabled'); assert.equal(calls, 1);
  fs.writeFileSync(path.join(dir, 'home-presence.json'), '{');
  assert.equal(readHomePresenceConfig(dir).error, 'invalid_config');
  assert.equal((await sampler.sample()).status, 'invalid_config');
});

test('polling deduplicates concurrent requests, expires independently, and recovers after failure', async (t) => {
  const dir = temp(t); let at = now, calls = 0, fail = false;
  setHomePresenceConfig({ enabled: true, sensors: [id], maxAgeMs: 1000 }, { dir });
  const sampler = createHomePresenceSampler({ dir, clock: () => at, read: async () => { calls++; await new Promise((r) => setTimeout(r, 5)); if (fail) throw Error('offline'); return detail(); } });
  const results = await Promise.all([sampler.sample(), sampler.sample()]);
  assert.equal(calls, 1); assert.equal(results[0].occupancy, 'occupied');
  at += 1001; assert.equal((await sampler.sample()).occupancy, 'unknown'); assert.equal(calls, 1);
  fail = true; assert.equal((await sampler.sample({ force: true })).status, 'offline');
  fail = false; at = now; assert.equal((await sampler.sample({ force: true })).occupancy, 'occupied');
});

test('actual cli timeout is bounded and reports offline', { skip: process.platform === 'win32' }, async (t) => {
  const dir = temp(t), cli = path.join(dir, 'slow-cli');
  fs.writeFileSync(cli, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
  setHomePresenceConfig({ enabled: true, sensors: [id], cli, timeoutMs: 100 }, { dir });
  const start = Date.now(), p = await createHomePresenceSampler({ dir }).sample();
  assert.equal(p.status, 'offline'); assert(Date.now() - start < 2500);
});

test('malformed detail is unknown and one positive service survives another failed service', () => {
  assert.equal(home({ ...detail(), services: [{ characteristics: [null, 2, { type: 7 }] }] }).occupancy, 'unknown');
  const d = detail(); d.services.push({ characteristics: [{ name: 'occupancy_detected', value: false, read: { succeeded: false, observed_at: now } }] });
  assert.equal(home(d).occupancy, 'occupied');
});
