import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readClaudeUsage, readCodexUsage, normalizeClaudeUsage, normalizeCodexUsage, resolveClaudeCredentials, CLAUDE_OAUTH_BETA } from '../lib/usage-sources.mjs';

const SECRET = 'sk-ant-oat01-SECRETTOKEN', EMAIL = 'someone@example.com', ACCOUNT = '7fa41553-0000-0000-0000-000000000000';
function home(t, { expiresAt = Date.now() + 3600_000, token = SECRET } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-usage-src-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.writeFileSync(path.join(dir, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: 'REFRESH-SECRET', expiresAt, scopes: ['user:profile'], subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' } }));
  return dir;
}
const claudeBody = (now) => ({
  five_hour: { utilization: 21, resets_at: new Date(now + 3_600_000).toISOString() },
  seven_day: { utilization: 54, resets_at: new Date(now + 86_400_000).toISOString() },
  seven_day_opus: null, seven_day_sonnet: null, seven_day_oauth_apps: null,
  limits: [
    { group: 'session', kind: 'session', percent: 21, resets_at: new Date(now + 3_600_000).toISOString(), scope: null, severity: 'normal', is_active: false },
    { group: 'weekly', kind: 'weekly_all', percent: 54, resets_at: new Date(now + 86_400_000).toISOString(), scope: null, severity: 'normal', is_active: false },
    { group: 'weekly', kind: 'weekly_scoped', percent: 100, resets_at: new Date(now + 86_400_000).toISOString(), scope: { model: { display_name: 'Fable', id: null }, surface: null }, severity: 'critical', is_active: true },
  ],
  extra_usage: { is_enabled: true, monthly_limit: 4000, used_credits: 2930, utilization: 73.25 },
  account: { email: EMAIL, uuid: ACCOUNT },
});
const fakeFetch = (status, body, headers = {}) => async (url, init) => { fakeFetch.last = { url, init }; return { status, headers: new Map(Object.entries(headers)), json: async () => body }; };
const rejects = (p, code) => assert.rejects(p, (e) => { assert.equal(e.code, code, e.message); assert(!JSON.stringify(e.message).includes(SECRET)); return true; });

test('claude: modern limits take precedence, legacy fills gaps, secrets and identity never leak', async (t) => {
  const now = Date.now(), h = home(t);
  const result = await readClaudeUsage({ home: h, env: {}, platform: 'win32', fetch: fakeFetch(200, claudeBody(now)) });
  const text = JSON.stringify(result);
  for (const s of [SECRET, 'REFRESH-SECRET', EMAIL, ACCOUNT, 'extra_usage']) assert(!text.includes(s), s);
  assert.equal(result.source, 'claude-oauth-usage');
  assert.deepEqual(result.windows.map((w) => w.id), ['five_hour', 'seven_day', 'seven_day:fable']);
  const scoped = result.windows[2];
  assert.equal(scoped.usedPercent, 100); assert.equal(scoped.severity, 'critical'); assert.equal(scoped.active, true); assert.equal(scoped.windowMinutes, 10080); assert.equal(scoped.label, 'weekly Fable');
  assert.equal(result.windows[0].windowMinutes, 300); assert.equal(result.windows[0].resetsAt, Date.parse(claudeBody(now).five_hour.resets_at));
  const { url, init } = fakeFetch.last;
  assert.equal(url, 'https://api.anthropic.com/api/oauth/usage');
  assert.equal(init.headers.Authorization, `Bearer ${SECRET}`); assert.equal(init.headers['anthropic-beta'], CLAUDE_OAUTH_BETA); assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual');
});
test('claude: legacy-only bodies and nullable buckets still normalize', () => {
  const now = Date.now();
  const r = normalizeClaudeUsage({ five_hour: { utilization: 3, resets_at: new Date(now + 1000).toISOString() }, seven_day: { utilization: 3, resets_at: new Date(now + 1000).toISOString() }, seven_day_opus: { utilization: 9, resets_at: null }, seven_day_sonnet: null });
  assert.deepEqual(r.windows.map((w) => [w.id, w.usedPercent]), [['five_hour', 3], ['seven_day', 3], ['seven_day:opus', 9]]);
  assert.throws(() => normalizeClaudeUsage({ five_hour: null, limits: [] }), (e) => e.code === 'invalid_response');
  assert.throws(() => normalizeClaudeUsage('nope'), (e) => e.code === 'invalid_response');
});
test('claude: credential resolution order and expiry', async (t) => {
  const h = home(t);
  assert.equal((await resolveClaudeCredentials({ home: h, env: { CLAUDE_CODE_OAUTH_TOKEN: ' env-token ' }, platform: 'win32' })).token, 'env-token');
  assert.equal((await resolveClaudeCredentials({ home: h, env: {}, platform: 'win32' })).origin, 'file');
  const kc = await resolveClaudeCredentials({ home: h, env: {}, platform: 'darwin', keychain: async () => JSON.stringify({ claudeAiOauth: { accessToken: 'kc-token', expiresAt: Date.now() + 1000 } }) });
  assert.equal(kc.origin, 'keychain'); assert.equal(kc.token, 'kc-token');
  assert.equal((await resolveClaudeCredentials({ home: h, env: {}, platform: 'darwin', keychain: async () => { throw Error('no keychain'); } })).origin, 'file');
  const alt = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-cfg-')); t.after(() => fs.rmSync(alt, { recursive: true, force: true }));
  fs.writeFileSync(path.join(alt, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'alt-token' } }));
  assert.equal((await resolveClaudeCredentials({ home: '/nonexistent', env: { CLAUDE_CONFIG_DIR: alt }, platform: 'linux' })).token, 'alt-token');
  await rejects(resolveClaudeCredentials({ home: '/nonexistent', env: {}, platform: 'linux' }), 'unauthenticated');
  let fetched = 0;
  await rejects(readClaudeUsage({ home: home(t, { expiresAt: Date.now() - 1 }), env: {}, platform: 'win32', fetch: async () => { fetched++; } }), 'unauthenticated');
  assert.equal(fetched, 0, 'expired tokens are never sent and never refreshed here');
});
test('claude: http and transport failures map to bounded error codes', async (t) => {
  const h = home(t), base = { home: h, env: {}, platform: 'win32' };
  await rejects(readClaudeUsage({ ...base, fetch: fakeFetch(401, { error: 'bad' }) }), 'unauthenticated');
  await rejects(readClaudeUsage({ ...base, fetch: fakeFetch(403, {}) }), 'unauthenticated');
  await assert.rejects(readClaudeUsage({ ...base, fetch: fakeFetch(429, {}, { 'retry-after': '120' }) }), (e) => e.code === 'rate_limited' && e.retryAfterMs === 120_000);
  await assert.rejects(readClaudeUsage({ ...base, fetch: fakeFetch(429, {}) }), (e) => e.code === 'rate_limited' && e.retryAfterMs === 60_000);
  await rejects(readClaudeUsage({ ...base, fetch: fakeFetch(503, {}) }), 'unavailable');
  await rejects(readClaudeUsage({ ...base, fetch: fakeFetch(302, {}) }), 'unavailable');
  await rejects(readClaudeUsage({ ...base, fetch: async () => { throw Object.assign(Error('t'), { name: 'TimeoutError' }); } }), 'timeout');
  await rejects(readClaudeUsage({ ...base, fetch: async () => { throw Object.assign(Error(SECRET), { code: 'ECONNRESET' }); } }), 'unavailable');
  await rejects(readClaudeUsage({ ...base, fetch: async () => ({ status: 200, headers: new Map(), json: async () => { throw Error('x'); } }) }), 'invalid_response');
  await rejects(readClaudeUsage({ ...base, fetch: fakeFetch(200, { five_hour: null, seven_day: null, limits: [] }) }), 'invalid_response');
});

const codexResult = () => ({
  ordinaryUsageAllowed: true, accountId: ACCOUNT, rateLimitUpsell: null,
  rateLimits: { limitId: 'codex', primary: { usedPercent: 82, windowDurationMins: 10080, resetsAt: 1792532529 }, secondary: null, credits: { hasCredits: false, unlimited: false, balance: '0' }, planType: 'prolite', spendControlReached: false, rateLimitReachedType: null },
  rateLimitsByLimitId: { codex: { limitId: 'codex', primary: { usedPercent: 82, windowDurationMins: 10080, resetsAt: 1792532529 }, secondary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1792000000 }, planType: 'prolite' } },
  rateLimitResetCredits: { availableCount: 1, credits: [{ id: 'RateLimitResetCredit_secret', title: 'Full reset' }] },
});
test('codex: multi-bucket windows, unix-second conversion, no identity', () => {
  const r = normalizeCodexUsage(codexResult());
  const text = JSON.stringify(r);
  for (const s of [ACCOUNT, 'RateLimitResetCredit', 'prolite']) assert(!text.includes(s), s);
  assert.equal(r.source, 'codex-app-server');
  assert.deepEqual(r.windows.map((w) => [w.id, w.usedPercent, w.windowMinutes, w.resetsAt, w.severity, w.active]), [['codex:primary', 82, 10080, 1792532529000, 'normal', null], ['codex:secondary', 12, 300, 1792000000000, 'normal', null]]);
  const legacy = normalizeCodexUsage({ rateLimits: { primary: { usedPercent: 100, windowDurationMins: null, resetsAt: null }, rateLimitReachedType: 'rate_limit_reached' } });
  assert.deepEqual(legacy.windows, [{ id: 'codex:primary', usedPercent: 100, windowMinutes: null, resetsAt: null, label: 'codex primary', severity: 'critical', active: null }]);
  assert.throws(() => normalizeCodexUsage({ rateLimits: { primary: null } }), (e) => e.code === 'invalid_response');
});
function fakeCodex(t, mode) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-usage-codex-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'app-server'), `
const fs=require('node:fs');const mode=${JSON.stringify(mode)};
fs.writeFileSync('env.json', JSON.stringify({ CODEX_HOME: process.env.CODEX_HOME }));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);fs.appendFileSync('rpc.jsonl',line+'\\n');const send=r=>process.stdout.write(JSON.stringify({id:m.id,...r})+'\\n');
 if(m.method==='initialize') send({result:{}});
 if(m.method==='account/rateLimits/read'){
  if(mode==='hang') return;
  if(mode==='unauth') return send({error:{code:-32000,message:'unauthenticated: not logged in (token ${SECRET})'}});
  if(mode==='boom') return send({error:{code:-32000,message:'backend 500 ${SECRET}'}});
  send({result:${JSON.stringify(codexResult())}});
 }
});
`);
  return { cwd, frames: () => fs.readFileSync(path.join(cwd, 'rpc.jsonl'), 'utf8').trim().split('\n').map(JSON.parse), env: () => JSON.parse(fs.readFileSync(path.join(cwd, 'env.json'), 'utf8')) };
}
test('codex: native app-server read with bounded lifecycle', async (t) => {
  const f = fakeCodex(t, 'ok');
  const r = await readCodexUsage({ binary: process.execPath, cwd: f.cwd, codexHome: f.cwd, timeoutMs: 8000 });
  assert.equal(r.windows[0].id, 'codex:primary'); assert.equal(r.windows[0].usedPercent, 82);
  assert.deepEqual(f.frames().map((m) => m.method), ['initialize', 'initialized', 'account/rateLimits/read']);
  assert.equal(f.env().CODEX_HOME, f.cwd);
});
test('codex: error classification, timeout and missing runtime', async (t) => {
  await rejects(readCodexUsage({ binary: process.execPath, cwd: fakeCodex(t, 'unauth').cwd, timeoutMs: 8000 }), 'unauthenticated');
  await rejects(readCodexUsage({ binary: process.execPath, cwd: fakeCodex(t, 'boom').cwd, timeoutMs: 8000 }), 'unavailable');
  await rejects(readCodexUsage({ binary: process.execPath, cwd: fakeCodex(t, 'hang').cwd, timeoutMs: 1500 }), 'timeout');
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-usage-nobin-')); t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  await rejects(readCodexUsage({ dir: empty, resolveBinary: () => null }), 'unsupported');
  await rejects(readCodexUsage({ binary: path.join(empty, 'missing-codex.exe'), timeoutMs: 3000 }), 'unavailable');
});
