import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { sanitizeClaims, liveJob, liveLaunch, staleLaunch, listLaunchJobs, listLiveLaunches, splitLaunches, sanitizeJobs, describeJob, splitSource, JOB_FRESH_MS, STALE_AFTER_MS, MAX_JOBS } from '../lib/launch-jobs.mjs';

const HOST = 'b29c1927-9f56-4f94-845f-4b53a2fa231b';
const receipt = (over = {}) => ({ source: `${HOST}/claude:a45dd0c3-2cb9-48da-9cae-a66a35be6fff`, request: { id: crypto.randomUUID(), runtime: 'claude-code', cwd: 'G:\\tasks\\x', prompt: 'p', name: 'colabfold demo-complex-a', claims: ['gpu'] }, state: 'running', nativeState: 'working', workerPid: 12345, agentId: 'claude:bec29ebf-4fd0-467d-9786-eb4b3e1c5d4a', createdAt: 1000, updatedAt: Date.now(), ...over });
const dead = () => false, live = () => true;

test('claims are short lowercase tokens; strict mode rejects, lenient mode drops', () => {
  assert.deepEqual(sanitizeClaims(['gpu', 'gpu', 'cpu']), ['gpu', 'cpu']);
  assert.deepEqual(sanitizeClaims(['GPU', 'ok', 5, 'a b']), ['ok']);
  assert.deepEqual(sanitizeClaims(undefined), []);
  assert.deepEqual(sanitizeClaims('gpu'), []);
  assert.throws(() => sanitizeClaims('gpu', { strict: true }), /array/);
  assert.throws(() => sanitizeClaims(['GPU'], { strict: true }), /lowercase/);
  assert.throws(() => sanitizeClaims(Array(9).fill('a'), { strict: true }), /at most/);
  assert.deepEqual(splitSource(`${HOST}/codex:abc`), { host: HOST, agent: 'codex:abc' });
  assert.deepEqual(splitSource('local/claude:abc'), { host: 'local', agent: 'claude:abc' });
  assert.deepEqual(splitSource('local'), { host: 'local', agent: null });
});

test('a claude-code launch is a live job only while its native job is working and its receipt is fresh (or worker alive)', () => {
  const now = Date.now();
  const job = liveJob(receipt(), { now, alive: dead });
  assert.equal(job.name, 'colabfold demo-complex-a'); assert.equal(job.source, HOST); assert.equal(job.sourceAgent, 'claude:a45dd0c3-2cb9-48da-9cae-a66a35be6fff');
  assert.deepEqual(job.claims, ['gpu']); assert.equal(job.since, 1000); assert.equal(job.runtime, 'claude-code');
  assert.equal(liveJob(receipt({ request: { ...receipt().request, claims: undefined } }), { now, alive: live }), null, 'no claim, no job');
  for (const nativeState of ['done', 'blocked', 'stopped', 'failed', 'removed', 'unknown', undefined]) assert.equal(liveJob(receipt({ nativeState }), { now, alive: live }), null, `nativeState ${nativeState}`);
  for (const state of ['stopped', 'failed', 'uncertain', 'awaiting_registration', 'crashing', 'stopping']) assert.equal(liveJob(receipt({ state }), { now, alive: live }), null, `state ${state}`);
  // dead supervisor: the frozen receipt stops vouching for the job after the fresh window
  assert.ok(liveJob(receipt({ updatedAt: now - JOB_FRESH_MS + 1000 }), { now, alive: dead }));
  assert.equal(liveJob(receipt({ updatedAt: now - JOB_FRESH_MS - 1000 }), { now, alive: dead }), null);
  assert.ok(liveJob(receipt({ updatedAt: now - 3600000 }), { now, alive: live }), 'alive worker with an old receipt still counts');
  assert.equal(liveJob({ corrupt: true, file: 'x' }), null);
  assert.equal(liveJob(null), null);
});

// shaped like winbox's colabfold-demo-complex-c receipt (2026-10-27): spawned by a peer with no `claims` key,
// session parked on a background shell (registry status `shell`), native inventory still `working`.
const shellWait = (over = {}) => receipt({ nativeSeen: true, nativeJobId: 'd7337c2e', agentId: 'claude:d7337c2e-d0eb-48fd-9bea-27e2842aee16', note: 'native job live; transport readiness is reported separately', ...over });

test('a claimed claude-code launch whose session waits on a background shell stays a live job', () => {
  // `claude agents --json` reports {state: working, status: busy} for the whole shell wait; the worker records
  // nativeState=working, which is all liveJob reads. the registry's `shell` status never reaches the receipt.
  const now = Date.now();
  const job = liveJob(shellWait({ request: { ...receipt().request, name: 'colabfold-demo-complex-c' } }), { now, alive: live });
  assert.equal(job?.name, 'colabfold-demo-complex-c'); assert.deepEqual(job.claims, ['gpu']);
  assert.ok(liveJob(shellWait({ updatedAt: now - 3600000 }), { now, alive: live }), 'an hours long shell keeps the claim while the supervisor lives');
  assert.equal(liveJob(shellWait({ nativeState: 'done' }), { now, alive: live }), null, 'the turn ended after the shell: claim drops');
});

test('a live launch without claims is an unclaimed launch, never a job', () => {
  const now = Date.now();
  const r = shellWait({ request: { ...receipt().request, name: 'colabfold-demo-complex-c', claims: undefined } });
  assert.equal(liveJob(r, { now, alive: live }), null, 'claim semantics stay strict');
  const l = liveLaunch(r, { now, alive: live });
  assert.equal(l.name, 'colabfold-demo-complex-c'); assert.deepEqual(l.claims, []); assert.equal(l.source, HOST); assert.equal(l.agentId, 'claude:d7337c2e-d0eb-48fd-9bea-27e2842aee16');
  assert.ok(liveLaunch(receipt(), { now, alive: live }).claims.length, 'claimed launches are live launches too');
  // same liveness rules as a job: nothing about load or the gpu is inferred
  for (const nativeState of ['done', 'blocked', 'stopped', 'unknown', undefined]) assert.equal(liveLaunch({ ...r, nativeState }, { now, alive: live }), null, `nativeState ${nativeState}`);
  for (const state of ['stopped', 'failed', 'awaiting_user', 'awaiting_registration', 'crashing']) assert.equal(liveLaunch({ ...r, state }, { now, alive: live }), null, `state ${state}`);
  assert.equal(liveLaunch({ ...r, updatedAt: now - JOB_FRESH_MS - 1 }, { now, alive: dead }), null, 'frozen receipt, dead supervisor');
  assert.equal(liveLaunch(receipt({ request: { ...receipt().request, runtime: 'claude-desktop', claims: undefined } }), { now, alive: live }), null, 'desktop handoffs have no job to watch');
});

test('a codex launch is a live job while its supervisor is alive and a turn is in progress', () => {
  const codex = (over) => receipt({ request: { ...receipt().request, runtime: 'codex' }, nativeState: undefined, lastTurn: 'inProgress', ...over });
  assert.ok(liveJob(codex(), { alive: live }));
  assert.equal(liveJob(codex(), { alive: dead }), null, 'dead worker: no claim even with a fresh receipt');
  assert.equal(liveJob(codex({ lastTurn: 'completed' }), { alive: live }), null);
  assert.equal(liveJob(codex({ lastTurn: undefined }), { alive: live }), null);
  assert.equal(liveJob(receipt({ request: { ...receipt().request, runtime: 'claude-desktop' } }), { alive: live }), null);
});

test('stale receipts: dead worker plus exited/blocked native job (or gone codex runtime) past the window', () => {
  const now = Date.now(), old = now - STALE_AFTER_MS - 1;
  assert.match(staleLaunch(receipt({ nativeState: 'blocked', updatedAt: old }), { now, alive: dead }), /blocked for 2h/);
  assert.match(staleLaunch(receipt({ nativeState: 'done', updatedAt: old }), { now, alive: dead }), /done/);
  assert.equal(staleLaunch(receipt({ nativeState: 'working', updatedAt: old }), { now, alive: dead }), null, 'a working native job with a dead supervisor is not stale: reconcile via inventory');
  assert.equal(staleLaunch(receipt({ nativeState: 'blocked', updatedAt: now - 60000 }), { now, alive: dead }), null, 'inside the window');
  assert.equal(staleLaunch(receipt({ nativeState: 'blocked', updatedAt: old }), { now, alive: live }), null, 'alive worker is never stale');
  assert.equal(staleLaunch(receipt({ nativeState: 'blocked', updatedAt: old }), { now, alive: dead, agent: { id: 'claude:x' } }), null, 'a discovered session is never stale');
  assert.equal(staleLaunch(receipt({ state: 'stopped', updatedAt: old }), { now, alive: dead }), null);
  const codex = receipt({ request: { ...receipt().request, runtime: 'codex' }, nativeState: undefined, runtimePid: 3260, updatedAt: old });
  assert.match(staleLaunch(codex, { now, alive: dead }), /codex runtime gone/);
  assert.equal(staleLaunch(codex, { now, alive: (pid) => pid === 3260 }), null, 'surviving runtime leader retains the slot');
  assert.match(staleLaunch(receipt({ state: 'starting', workerPid: undefined, nativeState: undefined, updatedAt: undefined, createdAt: old }), { now, alive: dead }), /starting for/);
});

test('listLaunchJobs derives presence jobs from the receipts on disk, names peers from known-hosts, skips junk', () => {
  const bus = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-jobs-'));
  try {
    assert.deepEqual(listLaunchJobs(bus), [], 'no launches dir yet');
    const dir = path.join(bus, 'launches'); fs.mkdirSync(dir); fs.mkdirSync(path.join(bus, 'lan'));
    fs.writeFileSync(path.join(bus, 'lan', 'known-hosts.json'), JSON.stringify({ schemaVersion: 1, complete: true, hosts: [{ hostId: HOST, name: 'laptop', lastAuthenticatedAt: 1 }] }));
    const a = receipt(), b = receipt({ createdAt: 5, source: 'local/claude:me', request: { ...receipt().request, id: crypto.randomUUID(), name: 'local render', claims: ['gpu', 'cpu'] } }), c = receipt({ state: 'stopped' });
    for (const r of [a, b, c]) fs.writeFileSync(path.join(dir, r.request.id + '.json'), JSON.stringify(r));
    fs.writeFileSync(path.join(dir, crypto.randomUUID() + '.json'), '\0\0\0\0');
    fs.writeFileSync(path.join(dir, 'launch.lock'), '{}');
    fs.writeFileSync(path.join(dir, a.request.id + '.json.stop'), '');
    const jobs = listLaunchJobs(bus, { alive: live });
    assert.deepEqual(jobs.map((j) => [j.name, j.sourceName, j.source]), [['local render', 'local', 'local'], ['colabfold demo-complex-a', 'laptop', HOST]]);
    assert.equal(describeJob(jobs[1]), 'colabfold demo-complex-a [gpu] for laptop');
    assert.equal(describeJob({ ...jobs[1], sourceName: null }), `colabfold demo-complex-a [gpu] for ${HOST.slice(0, 8)}`);
    assert.deepEqual(listLaunchJobs(bus, { alive: dead, now: Date.now() + JOB_FRESH_MS + 1 }), [], 'everything stale');
  } finally { fs.rmSync(bus, { recursive: true, force: true }); }
});

test('listLiveLaunches publishes claimed jobs first, then unclaimed launches, each capped; listLaunchJobs stays claim-only', () => {
  const bus = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-live-'));
  try {
    const dir = path.join(bus, 'launches'); fs.mkdirSync(dir);
    const put = (r) => fs.writeFileSync(path.join(dir, r.request.id + '.json'), JSON.stringify(r));
    const mk = (name, createdAt, claims) => receipt({ createdAt, request: { ...receipt().request, id: crypto.randomUUID(), name, claims } });
    put(mk('unclaimed old', 1, undefined)); put(mk('claimed new', 9, ['gpu'])); put(mk('unclaimed new', 5, []));
    put({ ...mk('ended', 2, undefined), state: 'stopped' });
    const all = listLiveLaunches(bus, { alive: live });
    assert.deepEqual(all.map((j) => j.name), ['claimed new', 'unclaimed old', 'unclaimed new']);
    assert.deepEqual(listLaunchJobs(bus, { alive: live }).map((j) => j.name), ['claimed new']);
    assert.deepEqual(splitLaunches(all).unclaimed.map((j) => j.name), ['unclaimed old', 'unclaimed new']);
    for (let i = 0; i < MAX_JOBS + 2; i++) put(mk(`u${i}`, 100 + i, undefined));
    const capped = splitLaunches(listLiveLaunches(bus, { alive: live }));
    assert.equal(capped.jobs.length, 1, 'unclaimed launches never crowd out a claimed job'); assert.equal(capped.unclaimed.length, MAX_JOBS);
    assert.deepEqual(splitLaunches(null), { jobs: [], unclaimed: [] });
  } finally { fs.rmSync(bus, { recursive: true, force: true }); }
});

test('peer jobs are sanitized: bad ids dropped, strings cleaned and capped, claims filtered', () => {
  const id = crypto.randomUUID();
  const jobs = sanitizeJobs([{ id, name: 'x\u0007'.repeat(80), runtime: 'bash', source: 'evil', sourceName: 'm\nac', claims: ['gpu', 'BAD'], since: -5, agentId: 7 }, { id: 'nope', name: 'y' }, 'z', null]);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].name.length, 80); assert.ok(!jobs[0].name.includes('\u0007'));
  assert.equal(jobs[0].runtime, null); assert.equal(jobs[0].source, 'local'); assert.equal(jobs[0].sourceName, 'm ac');
  assert.deepEqual(jobs[0].claims, ['gpu']); assert.equal(jobs[0].since, null); assert.equal(jobs[0].agentId, null);
  assert.deepEqual(sanitizeJobs('nope'), []);
  assert.equal(sanitizeJobs(Array(20).fill({ id })).length, 8);
});
