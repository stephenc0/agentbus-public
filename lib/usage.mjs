// Account quotas, not per-host budgets. Persist only normalized observations.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteFileSync } from './atomic-file.mjs';

export const USAGE_REFRESH_MS = 5 * 60_000;
export const USAGE_MAX_AGE_MS = 10 * 60_000;
const providers = ['claude', 'codex'];
const errors = new Set(['unauthenticated', 'unavailable', 'rate_limited', 'unsupported', 'invalid_response', 'timeout']);
const sources = new Set(['claude-oauth-usage', 'codex-app-server']);
const num = v => Number.isFinite(v) && v >= 0 ? v : null;
const timestamp = v => num(v) !== null && v <= 8.64e15 ? v : null;
const id = v => typeof v === 'string' && /^[a-zA-Z0-9_.:/-]{1,100}$/.test(v) ? v : null;
const bus = () => process.env.AGENTBUS_DIR || path.join(os.homedir(), '.agentbus');

export function sanitizeUsage(value, now = Date.now()) {
  const result = { scope: 'account', guidance: 'quotas belong to provider accounts, not hosts; do not add host percentages or assume separate budgets', providers: {} };
  for (const provider of providers) {
    const p = value?.providers?.[provider];
    const observedAt = num(p?.observedAt), checkedAt = num(p?.checkedAt);
    const ageMs = observedAt !== null && observedAt <= now ? now - observedAt : null;
    const error = errors.has(p?.error) ? p.error : null;
    const windows = (Array.isArray(p?.windows) ? p.windows : []).slice(0, 32).filter(w => w && id(w.id)).map(w => {
      const usedPercent = num(w.usedPercent), resetsAt = timestamp(w.resetsAt);
      const expired = resetsAt !== null && resetsAt <= now;
      return { id: id(w.id), label: typeof w.label === 'string' ? w.label.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 80) : null, severity: ['normal', 'critical'].includes(w.severity) ? w.severity : null, active: typeof w.active === 'boolean' ? w.active : null, usedPercent, remainingPercent: usedPercent === null ? null : Math.max(0, 100 - usedPercent), windowMinutes: num(w.windowMinutes), resetsAt, expired };
    });
    const stale = ageMs === null || ageMs > USAGE_MAX_AGE_MS || error !== null || windows.some(w => w.expired);
    result.providers[provider] = {
      status: windows.length ? stale ? 'stale' : 'ok' : error || 'unknown',
      source: sources.has(p?.source) ? p.source : null,
      checkedAt: checkedAt !== null && checkedAt <= now ? checkedAt : null,
      observedAt: ageMs === null ? null : observedAt, ageMs, maxAgeMs: USAGE_MAX_AGE_MS,
      nextCheckAt: num(p?.nextCheckAt), error, windows,
    };
  }
  return result;
}

export function readUsage({ dir = bus(), now = Date.now() } = {}) {
  try { return sanitizeUsage(JSON.parse(fs.readFileSync(path.join(dir, 'usage.json'), 'utf8')), now); }
  catch { return sanitizeUsage(null, now); }
}
const defaultReaders = Object.fromEntries(providers.map(provider => [provider, async options => {
  const source = await import('./usage-sources.mjs');
  return source[provider === 'claude' ? 'readClaudeUsage' : 'readCodexUsage'](options);
}]));

export function createUsageTracker({ dir = bus(), readers = defaultReaders, now = Date.now } = {}) {
  let pending;
  const current = () => readUsage({ dir, now: now() });
  async function refresh() {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, 'usage.json'), lock = path.join(dir, 'usage.lock');
    let fd;
    try { fd = fs.openSync(lock, 'wx', 0o600); }
    catch (e) {
      if (e.code !== 'EEXIST') return current();
      // A crashed refresh must not permanently disable observations. Never steal
      // a live process's lock, nor one still being initialized.
      try {
        const owner = JSON.parse(fs.readFileSync(lock, 'utf8'));
        if (Number.isInteger(owner.pid) && owner.pid > 0 && now() - owner.at > 120_000) {
          try { process.kill(owner.pid, 0); }
          catch (err) { if (err.code === 'ESRCH') fs.rmSync(lock, { force: true }); }
        }
      } catch {}
      return current();
    }
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: now() }));
      let saved; try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { saved = {}; }
      const output = current();
      for (const provider of providers) output.providers[provider].failures = num(saved?.providers?.[provider]?.failures) || 0;
      let changed = false;
      await Promise.all(providers.map(async provider => {
        const old = output.providers[provider];
        // Limit implausible clock jumps; an ordinary retry-after remains binding.
        if (old.nextCheckAt > now() && old.nextCheckAt - now() <= 24 * 60 * 60_000) return;
        changed = true;
        try {
          const fresh = await readers[provider]({ dir });
          const at = now();
          const normalized = sanitizeUsage({ providers: { [provider]: { ...fresh, checkedAt: at, observedAt: at } } }, at).providers[provider];
          if (!normalized.windows.length || normalized.windows.every(w => w.usedPercent === null)) throw Object.assign(Error('invalid usage'), { code: 'invalid_response' });
          output.providers[provider] = { ...normalized, nextCheckAt: at + USAGE_REFRESH_MS, failures: 0 };
        } catch (error) {
          const failures = Math.min(8, (num(saved?.providers?.[provider]?.failures) || 0) + 1);
          const code = errors.has(error?.code) ? error.code : 'unavailable';
          const backoff = Math.max(Math.min(USAGE_REFRESH_MS * 2 ** (failures - 1), 60 * 60_000), Math.min(num(error?.retryAfterMs) || 0, 24 * 60 * 60_000));
          // Retain old evidence with its original timestamp, never relabel it fresh.
          output.providers[provider] = { ...old, checkedAt: now(), nextCheckAt: now() + backoff, error: code, failures };
        }
      }));
      if (changed) atomicWriteFileSync(file, JSON.stringify(output), { mode: 0o600 });
      return current();
    } finally { fs.closeSync(fd); fs.rmSync(lock, { force: true }); }
  }
  return { current, update() { return pending ||= refresh().finally(() => { pending = null; }); } };
}
const trackers = new Map();
export async function localUsage({ dir = bus() } = {}) {
  if (!trackers.has(dir)) trackers.set(dir, createUsageTracker({ dir }));
  try { return await trackers.get(dir).update(); } catch { return readUsage({ dir }); }
}
export function formatUsage(value, now = Date.now()) {
  const usage = sanitizeUsage(value, now);
  return providers.map(provider => {
    const p = usage.providers[provider];
    const windows = p.windows.map(w => {
      const duration = w.windowMinutes === 300 ? '5h' : w.windowMinutes === 10080 ? 'weekly' : w.windowMinutes === null ? '' : `${w.windowMinutes}m`;
      return `${w.label || w.id}${duration ? ` (${duration})` : ''}: ${w.usedPercent === null ? 'unknown' : `${w.usedPercent}% used, ${w.remainingPercent}% left`}${w.resetsAt ? `, resets ${new Date(w.resetsAt).toISOString()}` : ''}${w.expired ? ' [reset passed; refresh needed]' : ''}${w.severity === 'critical' ? ' [critical]' : ''}`;
    }).join('; ');
    return `${provider}: ${p.status}${p.ageMs === null ? '' : `, sampled ${Math.floor(p.ageMs / 1000)}s ago`}${p.error ? ` (${p.error})` : ''}${windows ? `; ${windows}` : ''}`;
  }).join('\n');
}
