import { atomicWriteFileSync } from './atomic-file.mjs';
// Optional, read-only HomeClaw occupancy. A sensor detects activity, not a person's identity.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const defaultDir = () => process.env.AGENTBUS_DIR || path.join(os.homedir(), '.agentbus');
export const homePresenceConfigPath = (dir = defaultDir()) => path.join(dir, 'home-presence.json');
const CLI = '/Applications/HomeClaw.app/Contents/MacOS/homeclaw-cli';
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const clean = (v, n = 100) => typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, n) : null;
const bounded = (v, fallback, min, max) => Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback;
const timestamp = (v) => { const n = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(n) && n >= 0 ? n : null; };
export const normalizeDetection = (v) => v === true || v === 1 || v === '1' || v === 'true' ? true : v === false || v === 0 || v === '0' || v === 'false' ? false : null;

export function validateHomePresenceConfig(config = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw Error('home presence config must be an object');
  const sensors = Array.isArray(config.sensors) ? [...new Set(config.sensors)] : [];
  if (sensors.length > 8 || sensors.some((id) => typeof id !== 'string' || !UUID.test(id))) throw Error('home presence sensors must contain at most 8 accessory UUIDs');
  if (config.enabled === true && !sensors.length) throw Error('enabled home presence requires explicit sensor UUIDs');
  if (config.cli !== undefined && (typeof config.cli !== 'string' || !path.isAbsolute(config.cli) || config.cli.includes('\0'))) throw Error('home presence cli must be an absolute path');
  return { enabled: config.enabled === true, sensors, cli: config.cli || CLI, pollMs: bounded(config.pollMs, 30000, 10000, 300000), maxAgeMs: bounded(config.maxAgeMs, 120000, 1000, 600000), timeoutMs: bounded(config.timeoutMs, 5000, 100, 10000) };
}
export function readHomePresenceConfig(dir) {
  try { return validateHomePresenceConfig(JSON.parse(fs.readFileSync(homePresenceConfigPath(dir), 'utf8'))); }
  catch (e) { return { enabled: false, error: e.code === 'ENOENT' ? null : 'invalid_config' }; }
}
export function setHomePresenceConfig(config, { dir } = {}) {
  const c = validateHomePresenceConfig(config), file = homePresenceConfigPath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(file, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
  return c;
}
const empty = (status = 'disabled') => ({ source: 'homeclaw', scope: 'home_occupancy_not_identity', status, occupancy: 'unknown', motion: 'unknown', checked_at: null, observed_at: null, max_age_ms: 120000, sensors: [] });

function reading(c, now, maxAgeMs) {
  const observed_at = timestamp(c?.read?.observed_at), value = normalizeDetection(c?.value);
  const succeeded = c?.read?.succeeded === true;
  const fresh = observed_at !== null && observed_at <= now && now - observed_at <= maxAgeMs;
  return { value: succeeded && fresh ? value : null, observed_at, succeeded, stale: !fresh };
}
export function normalizeHomeAccessory(accessory, id, { now = Date.now(), maxAgeMs = 120000 } = {}) {
  const reachable = accessory?.reachable === true && typeof accessory?.id === 'string' && accessory.id.toLowerCase() === id.toLowerCase();
  const characteristics = (Array.isArray(accessory?.services) ? accessory.services : []).flatMap((s) => Array.isArray(s?.characteristics) ? s.characteristics : []);
  const signal = (name, type) => {
    const matches = characteristics.filter((c) => c && typeof c === 'object' && (c.name === name || (typeof c.type === 'string' && c.type.toUpperCase() === type)));
    const readings = matches.map((c) => reading(c, now, maxAgeMs));
    // Ambiguous multiple services must not turn a missing/failed read into a negative.
    const known = readings.filter((r) => r.value !== null);
    const value = known.some((r) => r.value === true) ? true : readings.length && known.length === readings.length ? false : null;
    return { value: reachable ? value : null, observed_at: known.length ? Math.min(...known.map((r) => r.observed_at)) : readings[0]?.observed_at ?? null, succeeded: reachable && known.length > 0 };
  };
  return { id, name: clean(accessory?.name), reachable, occupancy: signal('occupancy_detected', '00000071-0000-1000-8000-0026BB765291'), motion: signal('motion_detected', '00000022-0000-1000-8000-0026BB765291') };
}
export function sanitizeHomePresence(home, now = Date.now()) {
  if (!home || typeof home !== 'object') return empty();
  const max_age_ms = bounded(home.max_age_ms, 120000, 1000, 600000);
  const sensors = (Array.isArray(home.sensors) ? home.sensors : []).slice(0, 8).map((s) => {
    const signal = (r) => {
      const observed_at = timestamp(r?.observed_at), succeeded = r?.succeeded === true;
      const fresh = observed_at !== null && observed_at <= now && now - observed_at <= max_age_ms;
      return { value: s?.reachable === true && succeeded && fresh ? normalizeDetection(r?.value) : null, observed_at, succeeded, stale: !fresh };
    };
    return { id: clean(s?.id, 64), name: clean(s?.name), reachable: s?.reachable === true, occupancy: signal(s?.occupancy), motion: signal(s?.motion) };
  });
  const aggregate = (key, positive) => sensors.some((s) => s[key].value === true) ? positive : sensors.length && sensors.every((s) => s[key].value === false) ? 'not_detected' : 'unknown';
  const occupancy = aggregate('occupancy', 'occupied'), motion = aggregate('motion', 'detected');
  const observed = sensors.flatMap((s) => [s.occupancy, s.motion]).filter((r) => r.value !== null).map((r) => r.observed_at);
  let status = ['disabled', 'offline', 'invalid_config'].includes(home.status) ? home.status : !observed.length ? 'unknown' : sensors.every((s) => s.occupancy.value !== null && s.motion.value !== null) ? 'ok' : 'partial';
  // Failed latest poll invalidates old observations; a timestamp alone is never evidence.
  if (['disabled', 'offline', 'invalid_config'].includes(status)) return { ...empty(status), checked_at: timestamp(home.checked_at), max_age_ms };
  return { source: 'homeclaw', scope: 'home_occupancy_not_identity', status, occupancy, motion, checked_at: timestamp(home.checked_at), observed_at: observed.length ? Math.min(...observed) : null, max_age_ms, sensors };
}
function readCli(cli, id, timeout) {
  return new Promise((resolve, reject) => execFile(cli, ['get', id, '--json'], { encoding: 'utf8', timeout, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 1024 * 1024 }, (e, out) => { if (e) reject(e); else { try { resolve(JSON.parse(out)); } catch (error) { reject(error); } } }));
}
export function createHomePresenceSampler({ dir, read = readCli, clock = Date.now } = {}) {
  let last = empty(), next = 0, pending = null, configKey = '';
  return {
    async sample({ force = false } = {}) {
      const config = readHomePresenceConfig(dir), key = JSON.stringify(config);
      if (!config.enabled) return last = empty(config.error || 'disabled');
      if (pending) return pending;
      if (key === configKey && !force && clock() < next) return sanitizeHomePresence(last, clock());
      configKey = key;
      pending = (async () => {
        const results = await Promise.allSettled(config.sensors.map((id) => read(config.cli, id, config.timeoutMs)));
        const now = clock();
        last = sanitizeHomePresence({ status: results.every((r) => r.status === 'rejected') ? 'offline' : 'ok', checked_at: now, max_age_ms: config.maxAgeMs, sensors: results.map((r, i) => normalizeHomeAccessory(r.status === 'fulfilled' ? r.value : null, config.sensors[i], { now, maxAgeMs: config.maxAgeMs })) }, now);
        next = now + config.pollMs;
        return last;
      })();
      try { return await pending; } finally { pending = null; }
    },
    current() { return sanitizeHomePresence(last, clock()); },
    close() {},
  };
}
