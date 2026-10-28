// Provider readers for account usage windows. Each returns { source, windows[] } or throws an
// Error with .code in unauthenticated|unavailable|rate_limited|unsupported|invalid_response|timeout
// (plus optional .retryAfterMs). Never returns tokens, emails, account or org ids, or raw bodies.
// Quotas are account scoped: the same numbers apply on every host signed into that account.
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, execFile } from 'node:child_process';
import { buildInfo } from './build-info.mjs';
import { atomicWriteFileSync } from './atomic-file.mjs';
import { terminateChild } from './native-runtime.mjs';
import { launchPolicy, findRuntime, defaultBus } from './session-launch.mjs';

export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const CLAUDE_OAUTH_BETA = 'oauth-2025-04-20';
export const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';
const fail = (code, message, extra = {}) => Object.assign(Error(message), { code, ...extra });
const pct = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const epochMs = (v) => { if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? (v < 1e11 ? v * 1000 : v) : null; if (typeof v === 'string') { const t = Date.parse(v); return Number.isFinite(t) ? t : null; } return null; };
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'model';
const addWindow = (windows, w) => { if (w.usedPercent === null && w.resetsAt === null) return; if (!windows.some((x) => x.id === w.id)) windows.push(w); };

// --- claude -----------------------------------------------------------------
// Credential resolution mirrors claude code: CLAUDE_CODE_OAUTH_TOKEN, else the oauth record
// (macos keychain, otherwise <CLAUDE_CONFIG_DIR|~/.claude>/.credentials.json).
// Desktop app sessions authenticate through the app and never refresh that record, so a host
// that only runs those leaves it expired. An expired record is refreshed here the way claude
// code does it: under claude code's own refresh locks, compare-and-swap on the refresh token.
export const CLAUDE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
// claude code's public oauth client id (a public pkce client shipped in every install, no secret): gitleaks:allow
export const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'; // gitleaks:allow
const REFRESH_LOCK_STALE_MS = 60_000, REFRESH_LOCK_TOUCH_MS = 5000, REFRESH_EARLY_MS = 60_000;
const claudeConfigDir = (env, home) => (env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')).normalize('NFC');
// claude code suffixes the keychain service with a config dir hash only when CLAUDE_CONFIG_DIR is set.
export function claudeKeychainService(env = process.env, home = os.homedir()) {
  if (!env.CLAUDE_CONFIG_DIR) return CLAUDE_KEYCHAIN_SERVICE;
  return `${CLAUDE_KEYCHAIN_SERVICE}-${crypto.createHash('sha256').update(claudeConfigDir(env, home)).digest('hex').slice(0, 8)}`;
}
const keychainAccount = (env) => { let u; try { u = env.USER || os.userInfo().username; } catch { u = ''; } return /^[a-zA-Z0-9._-]+$/.test(u) ? u : 'claude-code-user'; };
async function readKeychainCredentials(service = CLAUDE_KEYCHAIN_SERVICE) {
  return new Promise((resolve) => execFile('/usr/bin/security', ['find-generic-password', '-s', service, '-w'], { encoding: 'utf8', timeout: 4000, maxBuffer: 1024 * 1024 }, (e, out) => resolve(e ? null : out.trim())));
}
// Same command claude code issues; stdin keeps the token out of argv.
async function writeKeychainCredentials(service, json, { account }) {
  const line = `add-generic-password -U -a "${account}" -s "${service}" -X "${Buffer.from(json, 'utf8').toString('hex')}"\n`;
  return new Promise((resolve, reject) => {
    const child = execFile('/usr/bin/security', ['-i'], { encoding: 'utf8', timeout: 4000 }, (e) => (e ? reject(fail('unavailable', 'keychain rejected the refreshed claude credentials')) : resolve()));
    child.stdin.end(line);
  });
}
async function loadClaudeCredentials({ home = os.homedir(), env = process.env, platform = process.platform, keychain = readKeychainCredentials, keychainWrite = writeKeychainCredentials } = {}) {
  if (typeof env.CLAUDE_CODE_OAUTH_TOKEN === 'string' && env.CLAUDE_CODE_OAUTH_TOKEN.trim()) return { token: env.CLAUDE_CODE_OAUTH_TOKEN.trim(), origin: 'env', expiresAt: null };
  const configDir = claudeConfigDir(env, home), service = claudeKeychainService(env, home), file = path.join(configDir, '.credentials.json');
  const candidates = [];
  if (platform === 'darwin') candidates.push({ origin: 'keychain', read: () => keychain(service), write: (json) => keychainWrite(service, json, { account: keychainAccount(env) }) });
  candidates.push({ origin: 'file', read: () => fs.readFileSync(file, 'utf8'), write: (json) => atomicWriteFileSync(file, json, { mode: 0o600, fsync: true }) });
  for (const c of candidates) {
    let raw; try { raw = await c.read(); } catch { continue; }
    if (!raw) continue;
    let doc; try { doc = JSON.parse(raw); } catch { continue; }
    const record = doc?.claudeAiOauth;
    if (typeof record?.accessToken !== 'string' || !record.accessToken) continue;
    const expiresAt = Number.isFinite(record.expiresAt) ? record.expiresAt : null;
    return { token: record.accessToken, origin: c.origin, expiresAt, doc, record, store: c, configDir };
  }
  throw fail('unauthenticated', 'no claude oauth credentials on this host');
}
export async function resolveClaudeCredentials({ now = Date.now(), ...options } = {}) {
  const { token, origin, expiresAt } = await loadClaudeCredentials(options);
  if (expiresAt !== null && expiresAt <= now) throw fail('unauthenticated', 'claude oauth token expired', { expired: true });
  return { token, origin, expiresAt };
}

// claude code holds two proper-lockfile style mkdir locks while it refreshes: <config>/.oauth_refresh.lock
// and the legacy <realpath(config)>.lock. Holding both excludes every claude code version.
// Stale after 60s without a touch, like claude code's; a live holder is never stolen from.
function mkdirLock(dir, now) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fs.mkdirSync(dir); return true; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let st; try { st = fs.statSync(dir); } catch { continue; }
      if (now() - st.mtimeMs <= REFRESH_LOCK_STALE_MS) return false;
      try { fs.rmdirSync(dir); } catch { return false; }
    }
  }
  return false;
}
function acquireRefreshLocks(configDir, now = Date.now) {
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const primary = path.join(configDir, '.oauth_refresh.lock');
  let legacy; try { legacy = `${fs.realpathSync(configDir)}.lock`; } catch { legacy = `${configDir}.lock`; }
  if (!mkdirLock(primary, now)) return null;
  const held = [primary];
  try { if (!mkdirLock(legacy, now)) { fs.rmdirSync(primary); return null; } held.push(legacy); }
  catch (e) { if (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'EROFS') { /* claude code also tolerates an unusable legacy lock */ } else { fs.rmdirSync(primary); throw e; } }
  const touch = setInterval(() => { const t = new Date(); for (const d of held) { try { fs.utimesSync(d, t, t); } catch {} } }, REFRESH_LOCK_TOUCH_MS);
  touch.unref?.();
  return () => { clearInterval(touch); for (const d of held.reverse()) { try { fs.rmdirSync(d); } catch {} } };
}

async function postRefresh(record, { fetch, timeoutMs }) {
  const body = { grant_type: 'refresh_token', refresh_token: record.refreshToken, client_id: typeof record.clientId === 'string' && record.clientId ? record.clientId : CLAUDE_OAUTH_CLIENT_ID };
  if (Array.isArray(record.scopes) && record.scopes.length) body.scope = record.scopes.join(' ');
  let response;
  try { response = await fetch(CLAUDE_TOKEN_URL, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': `agentbus/${buildInfo.version}` }, body: JSON.stringify(body) }); }
  catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw fail('timeout', `claude oauth refresh exceeded ${timeoutMs}ms`);
    throw fail('unavailable', 'claude oauth refresh request failed');
  }
  const status = response.status;
  if (status === 400 || status === 401 || status === 403) throw fail('unauthenticated', `claude oauth refresh token rejected (http ${status}); sign in again with claude /login`, { rejected: true });
  if (status === 429) throw fail('rate_limited', 'claude oauth refresh is rate limited', { retryAfterMs: retryAfterMs(response.headers) ?? 60_000 });
  if (status < 200 || status >= 300) throw fail('unavailable', `claude oauth refresh returned http ${status}`);
  let data; try { data = await response.json(); } catch { throw fail('invalid_response', 'claude oauth refresh response was not json'); }
  if (typeof data?.access_token !== 'string' || !data.access_token || !(Number(data.expires_in) > 0)) throw fail('invalid_response', 'claude oauth refresh response carried no access token');
  return data;
}
export async function refreshClaudeCredentials({ fetch = globalThis.fetch, timeoutMs = 10_000, now = Date.now, ...options } = {}) {
  const seen = await loadClaudeCredentials(options);
  if (seen.origin === 'env') throw fail('unauthenticated', 'CLAUDE_CODE_OAUTH_TOKEN cannot be refreshed');
  const release = acquireRefreshLocks(seen.configDir, now);
  if (!release) throw fail('unauthenticated', 'claude oauth token expired; another process is refreshing it');
  try {
    const locked = await loadClaudeCredentials(options);
    const live = (c) => c.expiresAt === null || c.expiresAt > now() + REFRESH_EARLY_MS;
    // Someone refreshed between our read and the lock: theirs is current.
    if (locked.token !== seen.token && live(locked)) return { token: locked.token, origin: locked.origin, expiresAt: locked.expiresAt, refreshed: false };
    if (typeof locked.record.refreshToken !== 'string' || !locked.record.refreshToken) throw fail('unauthenticated', 'claude oauth record has no refresh token; sign in again with claude /login');
    const posted = locked.record.refreshToken;
    const data = await postRefresh(locked.record, { fetch, timeoutMs });
    const at = now();
    const next = { ...locked.record, accessToken: data.access_token, refreshToken: typeof data.refresh_token === 'string' && data.refresh_token ? data.refresh_token : posted, expiresAt: at + Number(data.expires_in) * 1000 };
    if (Number(data.refresh_token_expires_in) > 0) next.refreshTokenExpiresAt = at + Number(data.refresh_token_expires_in) * 1000;
    if (typeof data.scope === 'string' && data.scope.trim()) next.scopes = data.scope.trim().split(/\s+/);
    // Compare-and-swap: write only over the refresh token we spent, keeping every other field.
    const current = await loadClaudeCredentials(options).catch(() => null);
    if (current && current.origin === locked.origin && (current.record.refreshToken === posted || current.record.refreshToken === '')) {
      // The server already rotated the refresh token: losing this write strands claude code on a dead one.
      const json = JSON.stringify({ ...current.doc, claudeAiOauth: { ...current.record, ...next } });
      for (let attempt = 0; ; attempt++) {
        try { await locked.store.write(json); break; }
        catch (e) { if (attempt >= 2) throw fail('unavailable', `refreshed claude credentials could not be saved (${locked.origin})`); await new Promise((r) => setTimeout(r, 100 * (attempt + 1))); }
      }
    }
    return { token: next.accessToken, origin: locked.origin, expiresAt: next.expiresAt, refreshed: true };
  } finally { release(); }
}
function retryAfterMs(headers) {
  const v = headers?.get?.('retry-after'); if (!v) return undefined;
  if (/^\d+$/.test(v.trim())) return Number(v) * 1000;
  const t = Date.parse(v); return Number.isFinite(t) ? Math.max(0, t - Date.now()) : undefined;
}
// Modern limits[] rows are authoritative (they carry model-scoped weekly buckets); legacy
// five_hour/seven_day objects only fill windows the modern rows did not describe.
export function normalizeClaudeUsage(body) {
  if (!body || typeof body !== 'object') throw fail('invalid_response', 'claude usage response is not an object');
  const windows = [];
  const legacyIds = { session: 'five_hour', weekly_all: 'seven_day' };
  for (const row of Array.isArray(body.limits) ? body.limits : []) {
    if (!row || typeof row !== 'object') continue;
    const model = row.scope?.model, surface = row.scope?.surface;
    const scoped = row.kind === 'weekly_scoped' || !!model || !!surface;
    const base = row.kind === 'session' || row.group === 'session' ? 'five_hour' : 'seven_day';
    const id = !scoped ? (legacyIds[row.kind] || base) : `${base}:${slug(model?.id || model?.display_name || surface?.display_name || surface?.id || row.kind)}`;
    const label = scoped ? `${base === 'five_hour' ? '5h' : 'weekly'} ${model?.display_name || surface?.display_name || 'scoped'}`.slice(0, 80) : undefined;
    addWindow(windows, { id, usedPercent: pct(row.percent), windowMinutes: base === 'five_hour' ? 300 : 10080, resetsAt: epochMs(row.resets_at), ...(label ? { label } : {}), severity: row.severity === 'critical' ? 'critical' : row.severity === 'normal' ? 'normal' : null, active: typeof row.is_active === 'boolean' ? row.is_active : null });
  }
  const legacy = [['five_hour', 'five_hour', 300], ['seven_day', 'seven_day', 10080], ['seven_day_opus', 'seven_day:opus', 10080], ['seven_day_sonnet', 'seven_day:sonnet', 10080], ['seven_day_oauth_apps', 'seven_day:oauth_apps', 10080], ['seven_day_cowork', 'seven_day:cowork', 10080]];
  for (const [key, id, windowMinutes] of legacy) {
    const b = body[key]; if (!b || typeof b !== 'object') continue;
    addWindow(windows, { id, usedPercent: pct(b.utilization), windowMinutes, resetsAt: epochMs(b.resets_at), severity: null, active: null });
  }
  if (!windows.length || windows.every((w) => w.usedPercent === null)) throw fail('invalid_response', 'claude usage response carried no usage windows');
  return { source: 'claude-oauth-usage', windows };
}
export async function readClaudeUsage({ fetch = globalThis.fetch, timeoutMs = 5000, url = CLAUDE_USAGE_URL, refresh = true, ...credentialOptions } = {}) {
  let token;
  try { ({ token } = await resolveClaudeCredentials(credentialOptions)); }
  catch (e) { if (!e.expired || !refresh) throw e; const { now: _, ...rest } = credentialOptions; ({ token } = await refreshClaudeCredentials({ ...rest, fetch })); }
  let response;
  try {
    response = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': CLAUDE_OAUTH_BETA, 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': `agentbus/${buildInfo.version}` } });
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw fail('timeout', `claude usage request exceeded ${timeoutMs}ms`);
    throw fail('unavailable', 'claude usage request failed');
  }
  const status = response.status;
  if (status === 401 || status === 403) throw fail('unauthenticated', `claude usage endpoint rejected the oauth token (http ${status})`);
  if (status === 429) throw fail('rate_limited', 'claude usage endpoint is rate limiting this account', { retryAfterMs: retryAfterMs(response.headers) ?? 60_000 });
  if (status < 200 || status >= 300) throw fail('unavailable', `claude usage endpoint returned http ${status}`);
  let body; try { body = await response.json(); } catch { throw fail('invalid_response', 'claude usage response was not json'); }
  return normalizeClaudeUsage(body);
}

// --- codex ------------------------------------------------------------------
// Native app-server jsonrpc over stdio; codex handles its own auth from CODEX_HOME.
// resetsAt arrives in unix seconds. Every limit id contributes primary/secondary windows.
export function normalizeCodexUsage(result) {
  if (!result || typeof result !== 'object') throw fail('invalid_response', 'codex rateLimits response is not an object');
  const buckets = result.rateLimitsByLimitId && typeof result.rateLimitsByLimitId === 'object' && Object.keys(result.rateLimitsByLimitId).length ? result.rateLimitsByLimitId : { [result.rateLimits?.limitId || 'codex']: result.rateLimits };
  const windows = [];
  for (const [limitId, snap] of Object.entries(buckets)) {
    if (!snap || typeof snap !== 'object') continue;
    const reached = typeof snap.rateLimitReachedType === 'string' && snap.rateLimitReachedType !== null;
    for (const key of ['primary', 'secondary']) {
      const w = snap[key]; if (!w || typeof w !== 'object') continue;
      const usedPercent = pct(w.usedPercent);
      addWindow(windows, { id: `${slug(limitId)}:${key}`, usedPercent, windowMinutes: Number.isFinite(w.windowDurationMins) && w.windowDurationMins > 0 ? w.windowDurationMins : null, resetsAt: epochMs(w.resetsAt), label: `codex ${slug(limitId) === "codex" ? "" : slug(limitId) + " "}${key}`.slice(0, 80), severity: reached || result.ordinaryUsageAllowed === false || usedPercent >= 100 ? 'critical' : 'normal', active: null });
    }
  }
  if (!windows.length || windows.every((w) => w.usedPercent === null)) throw fail('invalid_response', 'codex rateLimits response carried no usage windows');
  return { source: 'codex-app-server', windows };
}
export function resolveCodexBinary({ dir = defaultBus(), binary } = {}) {
  if (binary) return binary;
  try { const configured = launchPolicy(dir).runtimes?.codex; if (configured && fs.existsSync(configured)) return configured; } catch {}
  return findRuntime('codex');
}
function classifyCodexError(e) {
  const m = String(e?.message || '');
  if (/unauth|not logged in|login|401|auth/i.test(m)) return fail('unauthenticated', 'codex app-server reports no usable login');
  if (/429|rate.?limit/i.test(m)) return fail('rate_limited', 'codex usage endpoint is rate limiting this account', { retryAfterMs: 60_000 });
  return fail('unavailable', 'codex app-server could not read rate limits');
}
export async function readCodexUsage({ dir = defaultBus(), binary, codexHome, resolveBinary = resolveCodexBinary, cwd = os.tmpdir(), timeoutMs = 10_000, env = process.env } = {}) {
  binary = resolveBinary({ dir, binary });
  codexHome ||= env.CODEX_HOME || path.join(os.homedir(), '.codex');
  if (!binary) throw fail('unsupported', 'no codex runtime is configured or discoverable on this host');
  let child;
  try { child = spawn(binary, ['app-server'], { cwd, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...env, CODEX_HOME: codexHome } }); }
  catch (e) { throw fail('unavailable', 'codex app-server failed to start'); }
  const pending = new Map(); let seq = 0, closed = false;
  const abort = (error) => { closed = true; for (const p of pending.values()) p.reject(error); pending.clear(); };
  child.on('error', (e) => abort(fail('unavailable', 'codex app-server failed to start')));
  child.on('exit', () => abort(fail('unavailable', 'codex app-server exited before answering')));
  child.stdin.on('error', () => abort(fail('unavailable', 'codex app-server closed its input')));
  child.stderr.resume();
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    let frame; try { frame = JSON.parse(line); } catch { return; }
    const p = pending.get(frame.id); if (!p || frame.method) return;
    pending.delete(frame.id);
    frame.error ? p.reject(Object.assign(Error(frame.error.message || 'rpc error'), { rpc: true })) : p.resolve(frame.result);
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    if (closed) return reject(fail('unavailable', 'codex app-server closed'));
    const id = ++seq; pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  let timer, outcome;
  try {
    outcome = await Promise.race([
      (async () => {
        await rpc('initialize', { clientInfo: { name: 'agentbus_usage', version: buildInfo.version }, capabilities: { experimentalApi: true } });
        child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
        return rpc('account/rateLimits/read', {});
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => { const e = fail('timeout', `codex rate limit read exceeded ${timeoutMs}ms`); abort(e); reject(e); }, timeoutMs); }),
    ]);
  } catch (e) {
    throw e?.code && !e.rpc ? e : classifyCodexError(e);
  } finally {
    clearTimeout(timer); lines.close(); abort(fail('unavailable', 'codex usage read complete'));
    try { await terminateChild(child); } catch (e) { process.stderr.write('codex usage helper cleanup unconfirmed\n'); }
    child.stdin.destroy();
  }
  return normalizeCodexUsage(outcome);
}
