import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUsageTracker, sanitizeUsage, formatUsage, USAGE_REFRESH_MS, USAGE_MAX_AGE_MS } from '../lib/usage.mjs';
const sample = at => ({ source: 'claude-oauth-usage', token: 'SECRET', windows: [{ id: 'five_hour', usedPercent: 12, windowMinutes: 300, resetsAt: at + 20_000_000 }] });
function fixture(t, readers) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-usage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let time = 1_800_000_000_000;
  const tracker = createUsageTracker({ dir, readers, now: () => time });
  return { dir, tracker, advance: n => time += n, now: () => time };
}
test('normalizes quota windows, strips secrets and preserves explicit unknowns', () => {
  const now = Date.now();
  const value = sanitizeUsage({ providers: { claude: { ...sample(now), checkedAt: now, observedAt: now, email: 'secret', windows: [...sample(now).windows, { id: 'weekly', usedPercent: null, resetsAt: null }] } } }, now);
  assert.equal(value.providers.claude.status, 'ok');
  assert.equal(value.providers.claude.windows[0].remainingPercent, 88);
  assert.equal(value.providers.claude.windows[1].remainingPercent, null);
  assert.equal(value.providers.codex.status, 'unknown');
  assert(!JSON.stringify(value).includes('SECRET'));
  assert(!JSON.stringify(value).includes('email'));
  assert.match(formatUsage(value, now), /5h.*12% used, 88% left/);
});
test('stale, future and expired observations never imply fresh capacity', () => {
  const now = Date.now();
  for (const observedAt of [now - USAGE_MAX_AGE_MS - 1, now + 1, null]) {
    assert.equal(sanitizeUsage({ providers: { claude: { ...sample(now), observedAt } } }, now).providers.claude.status, 'stale');
  }
  const p = sanitizeUsage({ providers: { claude: { observedAt: now, windows: [{ id: 'five_hour', usedPercent: 99, resetsAt: now - 1 }] } } }, now).providers.claude;
  assert.equal(p.status, 'stale'); assert.equal(p.windows[0].expired, true);
});
test('deduplicates in-process and across trackers, persists only normalized values', async t => {
  let calls = 0, release;
  const wait = new Promise(r => release = r);
  const f = fixture(t, { claude: async () => { calls++; await wait; return sample(f.now()); }, codex: async () => { throw Object.assign(Error('TOKEN SECRET'), { code: 'unauthenticated' }); } });
  const a = f.tracker.update(), b = f.tracker.update();
  const other = createUsageTracker({ dir: f.dir, readers: { claude: () => assert.fail('locked'), codex: () => assert.fail('locked') }, now: f.now });
  await other.update(); release(); await Promise.all([a, b]);
  await f.tracker.update(); assert.equal(calls, 1);
  const saved = fs.readFileSync(path.join(f.dir, 'usage.json'), 'utf8');
  assert(!saved.includes('SECRET'));
  assert.equal(f.tracker.current().providers.codex.status, 'unauthenticated');
  assert.equal(f.tracker.current().providers.claude.windows[0].usedPercent, 12);
});
test('failure retains timestamp and evidence, backs off and recovers', async t => {
  let fail = false, calls = 0;
  const f = fixture(t, { claude: async () => { calls++; if (fail) throw Object.assign(Error('private'), { code: 'rate_limited', retryAfterMs: 900_000 }); return sample(f.now()); }, codex: async () => sample(f.now()) });
  await f.tracker.update(); const observed = f.tracker.current().providers.claude.observedAt;
  fail = true; f.advance(USAGE_REFRESH_MS); await f.tracker.update();
  const p = f.tracker.current().providers.claude;
  assert.equal(p.status, 'stale'); assert.equal(p.observedAt, observed); assert.equal(p.error, 'rate_limited');
  f.advance(USAGE_REFRESH_MS); await f.tracker.update(); assert.equal(calls, 2);
  fail = false; f.advance(600_000); await f.tracker.update(); assert.equal(calls, 3); assert.equal(f.tracker.current().providers.claude.status, 'ok');
});
test('invalid provider data is not reported as zero usage', async t => {
  const f = fixture(t, { claude: async () => ({ windows: [] }), codex: async () => ({ windows: [{ id: 'bad', usedPercent: '0' }] }) });
  await f.tracker.update();
  for (const p of Object.values(f.tracker.current().providers)) { assert.equal(p.status, 'invalid_response'); assert.deepEqual(p.windows, []); }
});
