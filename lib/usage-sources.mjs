// Provider readers for account usage windows. Each returns { source, windows[] } or throws an
// Error with .code in unauthenticated|unavailable|rate_limited|unsupported|invalid_response|timeout
// (plus optional .retryAfterMs). Never returns tokens, emails, account or org ids, or raw bodies.
// Quotas are account scoped: the same numbers apply on every host signed into that account.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, execFile } from 'node:child_process';
import { buildInfo } from './build-info.mjs';
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
// (macos keychain, otherwise <CLAUDE_CONFIG_DIR|~/.claude>/.credentials.json). No refresh here:
// claude code refreshes its own token on its next turn; an expired token is reported, not renewed.
async function readKeychainCredentials() {
  return new Promise((resolve) => execFile('/usr/bin/security', ['find-generic-password', '-s', CLAUDE_KEYCHAIN_SERVICE, '-w'], { encoding: 'utf8', timeout: 4000, maxBuffer: 1024 * 1024 }, (e, out) => resolve(e ? null : out.trim())));
}
export async function resolveClaudeCredentials({ home = os.homedir(), env = process.env, platform = process.platform, keychain = readKeychainCredentials, now = Date.now() } = {}) {
  if (typeof env.CLAUDE_CODE_OAUTH_TOKEN === 'string' && env.CLAUDE_CODE_OAUTH_TOKEN.trim()) return { token: env.CLAUDE_CODE_OAUTH_TOKEN.trim(), origin: 'env', expiresAt: null };
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const candidates = [];
  if (platform === 'darwin') candidates.push({ origin: 'keychain', read: () => keychain() });
  candidates.push({ origin: 'file', read: () => fs.readFileSync(path.join(configDir, '.credentials.json'), 'utf8') });
  for (const c of candidates) {
    let raw; try { raw = await c.read(); } catch { continue; }
    if (!raw) continue;
    let record; try { record = JSON.parse(raw)?.claudeAiOauth; } catch { continue; }
    if (typeof record?.accessToken !== 'string' || !record.accessToken) continue;
    const expiresAt = Number.isFinite(record.expiresAt) ? record.expiresAt : null;
    if (expiresAt !== null && expiresAt <= now) throw fail('unauthenticated', 'claude oauth token expired; claude code refreshes it on its next turn');
    return { token: record.accessToken, origin: c.origin, expiresAt };
  }
  throw fail('unauthenticated', 'no claude oauth credentials on this host');
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
export async function readClaudeUsage({ fetch = globalThis.fetch, timeoutMs = 5000, url = CLAUDE_USAGE_URL, ...credentialOptions } = {}) {
  const { token } = await resolveClaudeCredentials(credentialOptions);
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
