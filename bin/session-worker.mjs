#!/usr/bin/env node
// Detached owner for one launch. No user input is interpreted by a shell.
import fs from 'node:fs';
import { createRetryingWriter } from '../lib/atomic-file.mjs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import readline from 'node:readline';
import { attachProxy } from '../lib/codex-proxy.mjs';
import { buildInfo } from '../lib/build-info.mjs';
import { readLaunch, writeLaunch, isCorrupt, claudeLaunchArgs, claudeJobId, desktopLaunch, launchEnvironment, launchPolicy } from '../lib/session-launch.mjs';

import { codexThreadParams, verifyNativePermissions } from '../lib/launch-permissions.mjs';
import { claudeJobs, matchClaudeJob, claudeJobExited, stopClaudeJob, terminateChild, claudeJobLogs, classifyClaudeLog } from '../lib/native-runtime.mjs';
import { diagnoseTrustFailure } from '../lib/claude-trust.mjs';

const file = process.argv[2], busDir = path.dirname(path.dirname(file));
let record = readLaunch(file), child, bridge, stopping = false, stopRequested = false, launcherDone = false, checking = false, finalizing = false, finishPromise, nativeMonitor, cleanupRpc = () => {};
if (!record || isCorrupt(record)) { process.stderr.write(`${record ? record.error : 'missing receipt'}; refusing to launch from ${file}\n`); process.exit(2); }
if (fs.existsSync(file + '.stop')) { writeLaunch(file, { ...record, state: 'stopped' }); process.exit(0); }
// Fail closed before spawning if the initial ownership receipt cannot persist.
record = { ...record, workerPid: process.pid, workerVersion: 2, workerBuild: buildInfo, updatedAt: Date.now() };
writeLaunch(file, record);
let persistenceReported = false;
const persistenceFile = file + '.persistence-error';
const receipts = createRetryingWriter((value) => { writeLaunch(file, value); try { fs.rmSync(persistenceFile, { force: true }); } catch {} persistenceReported = false; }, {
  onError: (error) => {
    if (!persistenceReported) {
      process.stderr.write(`receipt persistence delayed (${error.code || 'error'}); owner retained and latest state will retry\n`);
      // A replacement lock need not prevent creating an independent diagnostic.
      // Disk-full failures can also prevent this: retain the live owner anyway.
      try { fs.writeFileSync(persistenceFile, JSON.stringify({ code: error.code || 'error', at: Date.now(), workerPid: process.pid }), { mode: 0o600 }); } catch {}
    }
    persistenceReported = true;
  },
});
const update = (patch) => { record = { ...record, ...patch, updatedAt: Date.now() }; return receipts.update(record); };
const stop = async () => {
  stopRequested = true;
  if (stopping || finalizing) return;
  // Killing --bg before it reports the id can orphan the already-forked job.
  if (record.request.runtime === 'claude-code' && !launcherDone) return;
  stopping = true;
  try {
    if (record.request.runtime === 'claude-code') {
      const result = await stopClaudeJob(record);
      if (!result.ok) throw Error(result.error);
    } else { bridge?.close(); await terminateChild(child); }
    update({ state: 'stopped', error: null, note: 'termination verified; conversation retained', cleanupScope: process.platform === 'win32' && record.request.runtime === 'codex' ? 'captured-process-graph' : 'native-runtime' });
    clearInterval(control); clearInterval(nativeMonitor); bridge?.close(); cleanupRpc(); process.exitCode = 0;
  } catch (e) { update({ state: 'uncertain', error: String(e.message).slice(0, 2000) }); stopping = false; }
};
process.on('SIGTERM', () => { fs.writeFileSync(file + '.stop', ''); void stop(); });
process.on('SIGINT', () => { fs.writeFileSync(file + '.stop', ''); void stop(); });
const control = setInterval(() => { if (fs.existsSync(file + '.stop')) void stop(); }, 1000);
// One owner finalizes a runtime. Pending RPC rejection, child exit and explicit
// failure can otherwise race and overwrite a verified/uncertain result.
const finishRuntime = (state, error) => {
  if (finalizing) return finishPromise;
  finalizing = true;
  finishPromise = (async () => {
    update({ state: 'stopping', ...(error ? { error } : {}), note: 'verifying owned runtime descendant cleanup' });
    bridge?.close(); cleanupRpc();
    try {
      await terminateChild(child);
      update({ state, error: error || null, note: 'owned runtime descendant cleanup verified', cleanupScope: process.platform === 'win32' ? 'captured-process-graph' : 'owned-process-group' });
    } catch (e) { update({ state: 'uncertain', error: String(e.message).slice(0, 2000), note: 'runtime exited; descendant cleanup is unconfirmed; reservation retained' }); }
    clearInterval(control); clearInterval(nativeMonitor); process.exitCode = state === 'failed' || record.state === 'uncertain' ? 1 : 0;
  })();
  return finishPromise;
};
const fail = (e) => {
  if (stopping) return;
  return finishRuntime('failed', String(e.message || e).slice(0, 2000));
};

try {
  const request = record.request;
  const env = { ...launchEnvironment(), AGENTBUS_DIR: busDir };
  if (request.runtime === 'claude-desktop') {
    const launch = desktopLaunch(request);
    child = spawn(launch.binary, launch.args, { cwd: request.cwd, env: { ...env, ...launch.env }, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let error = '';
    child.stderr.on('data', (b) => { error = (error + b).slice(-2000); });
    const timer = setTimeout(() => { update({ state: 'uncertain', error: 'desktop handoff timed out; inspect the app before retrying' }); child.kill(); }, 15000);
    child.on('error', (e) => { clearTimeout(timer); fail(e); });
    child.on('exit', (code) => {
      clearTimeout(timer); clearInterval(control);
      if (record.state === 'uncertain' || stopping) return;
      update(code === 0 ? { state: 'awaiting_user', note: 'opened the code composer with the task prefilled. confirm the folder and send it in desktop. no session id is exposed by this handoff; use list_agents after starting.' } : { state: 'failed', error: error || `desktop handoff exited ${code}` });
    });
  } else if (request.runtime === 'claude-code') {
    child = spawn(record.binary, claudeLaunchArgs(request), { cwd: request.cwd, env, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const collect = (b) => { output = (output + b.toString()).slice(-8192); const nativeJobId = claudeJobId(output); if (nativeJobId && !record.nativeJobId) update({ nativeJobId }); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    const timer = setTimeout(async () => {
      update({ state: 'uncertain', error: 'launcher timed out; inspect this same launch id before recovery' });
      // Preserve any known job id; never claim a timed-out launch did not fork.
      try { await terminateChild(child); } catch {}
      launcherDone = true;
      if (stopRequested && record.nativeJobId) void stop();
    }, 45000);
    child.on('error', (e) => { clearTimeout(timer); launcherDone = true; void fail(e); });
    child.on('close', async (code) => {
      clearTimeout(timer); launcherDone = true;
      const nativeJobId = record.nativeJobId || claudeJobId(output);
      if (nativeJobId) update({ nativeJobId });
      if (stopRequested && nativeJobId) { await stop(); return; }
      if (record.state === 'uncertain') return;
      if (code !== 0 && !nativeJobId) {
        clearInterval(control);
        if (!/workspace.*not trusted/i.test(output)) { update({ state: 'uncertain', error: output.trim().slice(-2000) || `launcher exited ${code}; inspect for an unregistered native job` }); return; }
        // claude's trust refusal is authoritative but says nothing about *whose* trust it checked. a daemon started
        // headless (windows boot task in session 0) runs in a profile that never accepted trust or logged in; read the
        // same state claude read and say which case this is, so the caller does not go accept trust in the wrong account.
        let diagnosis = null; try { diagnosis = await Promise.race([diagnoseTrustFailure(request.cwd), new Promise((r) => setTimeout(() => r(null), 10000))]); } catch {}
        update({ state: 'failed', error: `${output.trim().slice(-700)}${diagnosis ? `\n${diagnosis.summary}` : ''}`.slice(-2000), ...(diagnosis ? { trustDiagnosis: diagnosis.kind, launchContext: diagnosis.context, claudeTrust: { configFile: diagnosis.trust.configFile, configExists: diagnosis.trust.configExists, configReadable: diagnosis.trust.configReadable, credentials: diagnosis.trust.credentials, trusted: diagnosis.trust.trusted, trustedRoot: diagnosis.trust.trustedRoot } } : {}) });
        return;
      }
      if (!nativeJobId) { update({ state: 'uncertain', error: 'launcher returned without a recognized native job id' }); clearInterval(control); return; }
      update({ state: 'awaiting_registration', note: 'native background job created; waiting for native inventory' });
      // A job the native inventory calls "working" that never registers a session may be crash-looping.
      // After 30s unregistered, sample its live terminal output every 15s; crash lines mark the launch
      // `crashing` (it keeps its slot until stopped; nothing is killed or restarted automatically).
      const env = (k, d) => Number.isFinite(Number(process.env[k])) && process.env[k] !== '' && process.env[k] !== undefined ? Number(process.env[k]) : d;
      const LOG_AFTER = env('AGENTBUS_UNREGISTERED_LOG_AFTER_MS', 30000), LOG_EVERY = env('AGENTBUS_UNREGISTERED_LOG_EVERY_MS', 15000), STALL_AFTER = env('AGENTBUS_UNREGISTERED_STALL_MS', 90000);
      let awaitingSince = null, lastLogAt = 0;
      const watchUnregistered = async () => {
        const now = Date.now(); awaitingSince ??= now;
        if (now - awaitingSince < LOG_AFTER || (lastLogAt && now - lastLogAt < LOG_EVERY)) return;
        lastLogAt = now;
        const logs = await claudeJobLogs(record.binary, request.cwd, record.nativeJobId);
        if (!logs.ok) return;
        const c = classifyClaudeLog(logs.text), waitedSec = Math.round((now - awaitingSince) / 1000);
        if (c.crashing) update({ crash: { evidence: c.evidence, respawns: c.respawns, lastExitCode: c.lastExitCode, observedAt: now }, nativeLogTail: logs.text,
          error: `native worker is crashing before its session registers (${c.lastExitCode !== null ? `exit ${c.lastExitCode}, ` : ''}${c.respawns} respawn line(s)): ${c.evidence.at(-1) || ''}`.slice(0, 600),
          note: `inspect \`claude logs ${record.nativeJobId}\`; stop this launch to release its slot` });
        else if (now - awaitingSince >= STALL_AFTER) update({ stall: { waitedSec }, nativeLogTail: logs.text, note: `native job has not registered a session for ${waitedSec}s; inspect \`claude logs ${record.nativeJobId}\`` });
      };
      const inspect = async () => {
        if (checking || stopping) return; checking = true;
        try {
          const result = await claudeJobs(record.binary, request.cwd);
          if (stopping) return;
          if (!result.ok) { update({ note: 'native job inventory unavailable; reservation retained' }); return; }
          const job = matchClaudeJob(result.jobs, record);
          if (!job && !record.nativeSeen && Date.now() - record.createdAt < 60000) return;
          if (claudeJobExited(job)) {
            update({ state: 'stopped', nativeState: job?.state || 'removed', note: 'native inventory confirmed job exit', error: null });
            clearInterval(monitor); clearInterval(control); return;
          }
          if (job.pid) { awaitingSince = null; if (record.crash || record.stall) update({ crash: null, stall: null, nativeLogTail: null, error: null }); }
          else if (!job.ambiguous) await watchUnregistered();
          update({ state: job.pid ? 'running' : record.crash ? 'crashing' : 'awaiting_registration', nativeSeen: !job.ambiguous, nativeState: job.state || 'unknown', ...(typeof job.cwd === 'string' ? { nativeCwd: job.cwd } : {}), ...(job.sessionId ? { agentId: 'claude:' + job.sessionId } : {}), note: job.pid ? 'native job live; transport readiness is reported separately' : (record.crash || record.stall) ? record.note : 'native job blocked or awaiting process; reservation retained' });
        } finally { checking = false; }
      };
      const monitor = nativeMonitor = setInterval(() => void inspect(), env('AGENTBUS_NATIVE_POLL_MS', 5000));
      await inspect();
    });
  } else {
    const threadParams = codexThreadParams(request, launchPolicy(busDir));
    child = spawn(record.binary, ['app-server'], { cwd: request.cwd, env, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    if (child.pid) update({ runtimePid: child.pid });
    let stderr = '';
    child.stderr.on('data', (b) => { stderr = (stderr + b.toString()).slice(-2000); });
    const input = new PassThrough(), output = new PassThrough(), pending = new Map(); let seq = 0;
    bridge = attachProxy({ child, input, output, busDir });
    const send = (frame) => input.write(JSON.stringify(frame) + '\n');
    const rpc = (method, params) => new Promise((resolve, reject) => {
      const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(Error(`${method} timed out; inspect this launch before retrying`)); }, 30000);
      pending.set(id, { resolve, reject, timer }); send({ id, method, params });
    });
    const lines = readline.createInterface({ input: output });
    lines.on('line', (line) => {
      if (finalizing || stopping) return;
      let m; try { m = JSON.parse(line); } catch { return; }
      if (m.method && m.id !== undefined) {
        // No human UI is attached. Never approve a permission request or invent an answer.
        send({ id: m.id, error: { code: -32603, message: 'agentbus background worker cannot answer interactive requests; attach/resume in an interactive client' } });
        update({ note: `interactive request unavailable: ${m.method}` }); return;
      }
      const p = pending.get(m.id);
      if (p) { pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); }
      if (m.method === 'turn/started') update({ lastTurn: 'inProgress', error: null });
      if (m.method === 'item/completed' && m.params?.item?.type === 'agentMessage') update({ lastResponse: String(m.params.item.text || '').slice(-16000) });
      if (m.method === 'turn/completed') update({ lastTurn: m.params?.turn?.status, ...(m.params?.turn?.error ? { error: m.params.turn.error.message } : {}) });
    });
    cleanupRpc = () => {
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error('app-server exited')); }
      pending.clear(); lines.close();
    };
    child.on('error', (e) => { void fail(e); });
    child.on('exit', (code) => {
      if (stopping) { cleanupRpc(); return; }
      // Claim finalization before rejecting startup RPCs: their catch must join
      // this cleanup instead of replacing its result with another failure.
      const failed = code !== 0 || record.state !== 'running';
      void finishRuntime(failed ? 'failed' : 'stopped', failed ? stderr || `app-server exited ${code}` : null);
    });
    await rpc('initialize', { clientInfo: { name: 'agentbus_worker', version: buildInfo.version }, capabilities: {} });
    send({ method: 'initialized' });
    const thread = await rpc('thread/start', threadParams);
    const effectivePermissions = verifyNativePermissions(thread, threadParams);
    update({ agentId: `codex:${thread.thread.id}`, model: thread.model, effectivePermissions, state: 'starting' });
    if (request.name) await rpc('thread/name/set', { threadId: thread.thread.id, name: request.name });
    await rpc('turn/start', { threadId: thread.thread.id, input: [{ type: 'text', text: request.prompt }], clientUserMessageId: request.id });
    update({ state: 'running', note: 'owned app-server stays alive for agentbus messages; stop explicitly when done' });
  }
} catch (e) { await fail(e); }
