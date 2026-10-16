import { replaceFileSync } from '../lib/atomic-file.mjs';
// Explicit, paid-runtime smoke test. Never runs as part of the normal test suite.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSession, createLauncher, defaultBus } from '../lib/session-launch.mjs';
import { listAgents, listReachableAgents, sendMessage } from '../lib/core.mjs';
import { localLanRequest, UUID } from '../lib/lan.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const terminal = (state) => ['stopped', 'failed'].includes(state);
function writeReport(file, report) {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(report, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  replaceFileSync(tmp, file);
}
export function smokeEvidencePath(evidenceDir, requestedCwd, nativeCwd, basename) {
  const destination = /^[a-z]:[\\/]/i.test(requestedCwd) || requestedCwd.startsWith('\\\\') ? path.win32 : path.posix;
  const relative = destination.relative(requestedCwd, nativeCwd || requestedCwd);
  if (destination.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + destination.sep)) return null;
  const root = fs.realpathSync(evidenceDir);
  const candidate = path.join(root, ...relative.split(destination.sep).filter(Boolean), basename);
  try {
    const actual = fs.realpathSync(candidate), localRelative = path.relative(root, actual);
    return !path.isAbsolute(localRelative) && localRelative !== '..' && !localRelative.startsWith('..' + path.sep) ? actual : null;
  } catch { return null; }
}
function dependencies(options) {
  const busDir = options.busDir || defaultBus();
  const launcher = createLauncher({ busDir, listLocal: listAgents });
  const remote = options.host && options.host !== 'local';
  return {
    launch: (request) => spawnSession(request, { busDir, listLocal: listAgents }),
    status: (id) => remote ? localLanRequest({ op: 'spawn-status', id, host: options.host, from: options.from }, { busDir, timeout: 10000 }) : launcher.status(id),
    stop: (id) => remote ? localLanRequest({ op: 'spawn-stop', id, host: options.host, from: options.from }, { busDir, timeout: 10000 }) : launcher.stop(id),
    send: sendMessage,
    agents: listReachableAgents,
    sleep,
  };
}

// Injectable transport makes the runner testable without provider calls.
export async function runSessionSmoke(options, injected) {
  if (!['codex', 'claude-code'].includes(options.runtime)) throw Error('runtime must be codex or claude-code');
  if (!options.cwd || typeof options.cwd !== 'string') throw Error('an existing dedicated destination workspace --cwd is required');
  if (!/^(codex|claude):[0-9a-f-]{36}$/.test(options.from || '')) throw Error('--from must be a live local agent id');
  if (!options.report) throw Error('--report is required for durable recovery');
  const remote = options.host && options.host !== 'local';
  if (options.runtime === 'claude-code' && remote && !options.evidenceDir) throw Error('remote claude smoke requires --evidence-dir pointing to the locally readable destination workspace');
  const timeoutMs = options.timeoutMs ?? 180000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 1800000) throw Error('timeout must be between 1 and 1800 seconds');
  const file = path.resolve(options.report), evidenceDir = options.evidenceDir || (!remote ? options.cwd : null);
  if (evidenceDir && !fs.statSync(evidenceDir).isDirectory()) throw Error('evidence directory must exist');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = file + '.lock', fd = fs.openSync(lock, 'wx', 0o600);
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
  let report;
  try {
    const signature = { host: options.host || 'local', runtime: options.runtime, cwd: options.cwd, from: options.from, evidenceDir, model: options.model || null, permission_profile: options.permission_profile || null };
    if (fs.existsSync(file)) {
      report = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (report.schema !== 'agentbus-session-smoke-v1' || !UUID.test(report.requestId || '') || !UUID.test(report.nonce || '') || JSON.stringify(report.options) !== JSON.stringify(signature) || (options.id && options.id !== report.requestId)) throw Error('existing report does not match these smoke parameters');
      if (report.finishedAt && report.cleanup?.ok !== false) return report;
    } else {
      const id = options.id || crypto.randomUUID();
      if (!UUID.test(id)) throw Error('request id must be a UUID');
      const nonce = crypto.randomUUID();
      report = { schema: 'agentbus-session-smoke-v1', options: signature, requestId: id, nonce, createdAt: Date.now(), phase: 'prepared', events: [] };
      writeReport(file, report);
    }
    const api = injected || dependencies(options);
    const save = (patch = {}) => { Object.assign(report, patch, { updatedAt: Date.now() }); writeReport(file, report); };
    const event = (name, result) => { report.events.push({ at: Date.now(), name, result }); save(); };
    const boot = `agentbus-smoke-${report.nonce}-boot`, idle = `agentbus-smoke-${report.nonce}-idle`;
    const bootFile = `.agentbus-smoke-${report.requestId}-boot.txt`, idleFile = `.agentbus-smoke-${report.requestId}-idle.txt`;
    const instruction = (nonce, basename) => `agentbus disposable smoke test. in the current workspace, write exactly ${JSON.stringify(nonce)} to ${JSON.stringify(basename)}. change no other files. do not send messages or launch jobs. finish your turn with exactly ${nonce}.`;
    const request = { id: report.requestId, host: signature.host, runtime: options.runtime, cwd: options.cwd, from: options.from, name: `agentbus-smoke-${report.requestId.slice(0, 8)}`, prompt: instruction(boot, bootFile), ...(options.model ? { model: options.model } : {}), ...(options.permission_profile ? { permission_profile: options.permission_profile } : {}) };
    const acknowledgement = (status, nonce, basename) => {
      if (options.runtime === 'codex' && status.lastTurn === 'completed' && String(status.lastResponse || '').trim() === nonce) return 'completed_native_turn';
      if (evidenceDir) { try { const evidence = smokeEvidencePath(evidenceDir, options.cwd, status.cwd, basename); if (evidence && fs.readFileSync(evidence, 'utf8').trim() === nonce) return 'workspace_nonce_file'; } catch {} }
      return null;
    };
    const workDeadline = Date.now() + timeoutMs;
    const waitFor = async (label, predicate, budget = timeoutMs) => {
      const end = label === 'cleanup' ? Date.now() + budget : Math.min(workDeadline, Date.now() + budget);
      do {
        const status = await api.status(report.requestId);
        save({ lastStatus: status });
        if (await predicate(status)) return status;
        if (label !== 'cleanup' && terminal(status.state)) throw Error(`${label}: runtime ended (${status.state}): ${status.error || ''}`);
        await api.sleep(Math.min(1000, Math.max(0, end - Date.now())));
      } while (Date.now() < end);
      throw Error(`${label} timed out`);
    };
    const cleanup = async () => {
      if (!report.launchIntent) return;
      try {
        event('stop', await api.stop(report.requestId));
        const final = await waitFor('cleanup', (s) => s.state === 'stopped' && s.workerAlive !== true, Math.min(timeoutMs, 30000));
        save({ cleanup: { ok: true, status: final } });
      } catch (error) { save({ cleanup: { ok: false, error: error.message } }); }
      save({ ok: report.testResult?.ok === true && report.cleanup.ok });
    };
    if (report.finishedAt) {
      // Recovery of a failed stop never launches or sends again. Preserve the
      // original execution result separately from whether cleanup now succeeds.
      if (!report.testResult) save({ testResult: { ok: false, error: report.error || 'original execution result unavailable' } });
      await cleanup();
      save({ phase: report.cleanup?.ok ? 'finished' : 'cleanup_failed', cleanupRetriedAt: Date.now() });
      return report;
    }
    try {
      if (!report.launchIntent) {
        const prior = await api.status(report.requestId);
        if (prior.state || prior.ok || prior.error !== 'unknown launch id') throw Error('request id is already used or absence cannot be established; choose a fresh id');
        save({ launchIntent: true, phase: 'launch_requested' });
      }
      // Same request id and exact payload only: a lost launch acknowledgement is safe to retry.
      const launched = await api.launch(request); event('launch', launched);
      if (!launched.ok) throw Error(`launch failed: ${launched.error || launched.state || 'unknown'}`);
      if (!report.bootCompleted) {
        const bootStatus = await waitFor('boot acknowledgement', (s) => acknowledgement(s, boot, bootFile));
        save({ bootCompleted: true, bootEvidence: acknowledgement(bootStatus, boot, bootFile), phase: 'boot_completed' });
      }
      if (report.messageIntent && !report.messageAcknowledged) throw Error('a previous run recorded message intent without completion; never retry an uncertain idle message');
      if (!report.messageAcknowledged) {
        const idleStatus = await waitFor('idle readiness', async (s) => {
          if (!s.agentId) return false;
          const agent = (await api.agents()).find((a) => a.id === s.agentId);
          return agent?.status === 'idle' && agent.deliveryReady === true;
        });
        save({ phase: 'idle_ready', idleBeforeMessage: idleStatus, targetAgentId: idleStatus.agentId });
        save({ messageIntent: true, phase: 'idle_message_requested' });
        const sent = await api.send({ to: idleStatus.agentId, from: options.from, message: instruction(idle, idleFile) }); event('idle_message', sent);
        if (!sent.ok || !['accepted', 'queued'].includes(sent.delivery)) throw Error(`idle message was ${sent.delivery || 'rejected'}; not retrying`);
        const ack = await waitFor('idle acknowledgement', (s) => acknowledgement(s, idle, idleFile));
        save({ messageAcknowledged: true, idleEvidence: acknowledgement(ack, idle, idleFile), phase: 'idle_message_completed' });
      }
      save({ ok: true, testResult: { ok: true } });
    } catch (error) { save({ ok: false, error: error.message, testResult: { ok: false, error: error.message } }); }
    finally {
      // Never sweep a host or touch another receipt, even when the test fails.
      await cleanup();
      save({ phase: report.cleanup?.ok === false ? 'cleanup_failed' : 'finished', finishedAt: Date.now() });
    }
    return report;
  } finally { fs.closeSync(fd); fs.rmSync(lock, { force: true }); }
}

export async function runSessionSmokeCli(args) {
  const values = {}, names = new Set(['host', 'cwd', 'runtime', 'from', 'id', 'report', 'evidence-dir', 'timeout', 'model', 'permission-profile']);
  while (args.length) { const key = args.shift(); if (!key?.startsWith('--') || !names.has(key.slice(2)) || !args.length || args[0].startsWith('--')) throw Error('usage: agentbus session-smoke --runtime codex|claude-code --cwd <dedicated destination workspace> --from <agent id> --report <json path> [--host <host>] [--evidence-dir <local workspace mount for remote claude>] [--id <uuid>] [--timeout <seconds>] [--model <model>] [--permission-profile <profile>]. this explicitly launches paid model turns and stops only its own receipt.'); values[key.slice(2)] = args.shift(); }
  const report = await runSessionSmoke({ ...values, evidenceDir: values['evidence-dir'], permission_profile: values['permission-profile'], timeoutMs: values.timeout === undefined ? undefined : Number(values.timeout) * 1000 });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
  return report;
}
