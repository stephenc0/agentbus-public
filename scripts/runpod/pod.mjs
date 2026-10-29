#!/usr/bin/env node
// runpod gpu peer lifecycle: up | status | down | list. run on a host that is in the agentbus group (it must be one of
// the join token's peers, so the pod dials it and its daemon authenticates the pod).
//
//   RUNPOD_API_KEY=... TS_AUTHKEY=... CLAUDE_CODE_OAUTH_TOKEN=... node scripts/runpod/pod.mjs up --name runpod-h100 --image <registry>/agentbus-runpod:<tag> --volume <network volume id>
//   node scripts/runpod/pod.mjs status runpod-h100
//   node scripts/runpod/pod.mjs down runpod-h100
//
// uses runpod rest api v2 (https://api.runpod.io/v2; v1 is deprecated and retires 2026-11-15). no auto-terminate in v1
// of this script: a pod bills until `down`. secrets come from env and go only into the pod's env, never to disk here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const lib = (name) => import(new URL(`../../lib/${name}`, import.meta.url).href);
import { API, DEFAULT_GPU, runpodClient, billingLabel, listRate, createBody, usage, fmtUsage, checkPod as checkPodWith } from '../../lib/runpod.mjs';
export { API, DEFAULT_GPU, runpodClient, billingLabel, listRate, createBody, usage, fmtUsage };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stateDir = () => path.join(process.env.AGENTBUS_DIR || path.join(os.homedir(), '.agentbus'), 'runpod');
const checkPod = async (peer, opts) => checkPodWith((await lib('lan.mjs')).loadLan(), peer, opts);

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const k = a.slice(2), v = argv[i + 1];
    if (['no-roundtrip', 'json', 'force'].includes(k)) { out[k] = true; continue; }
    if (v === undefined || v.startsWith('--')) throw Error(`--${k} needs a value`);
    if (k === 'peer' || k === 'cuda') (out[k] ||= []).push(v); else out[k] = v;
    i++;
  }
  return out;
}

// ---------- local records (pod id, host id, rate; no secrets) ----------
function saveRecord(r) { fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(stateDir(), `${r.podId}.json`), JSON.stringify(r, null, 2), { mode: 0o600 }); }
function records() { try { return fs.readdirSync(stateDir()).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(stateDir(), f), 'utf8'))); } catch { return []; } }
function findRecord(ref) {
  const hits = records().filter((r) => r.podId === ref || r.name === ref || r.hostId === ref);
  if (hits.length > 1) throw Error(`${ref} matches ${hits.length} pods; use the pod id (${hits.map((h) => h.podId).join(', ')})`);
  return hits[0] || null;
}
const dropRecord = (r) => fs.rmSync(path.join(stateDir(), `${r.podId}.json`), { force: true });

// ---------- agentbus side ----------
async function daemonStatus() {
  const { localLanRequest } = await lib('lan.mjs');
  const s = await localLanRequest({ op: 'status' }, { timeout: 3000 });
  if (!s.ok) throw Error(`local agentbus daemon is not answering (${s.error}); start it with agentbus lan install`);
  return s;
}
const fresh = (p) => p && !p.error && Date.now() - (p.checkedAt || 0) < 30000;
async function joinToken(peerSpecs) {
  if (process.env.AGENTBUS_JOIN_TOKEN) return process.env.AGENTBUS_JOIN_TOKEN;
  const { buildInvite } = await lib('wan.mjs');
  // the pod must dial this host: it is in the token by default. add others with --peer name=100.x.y.z:port
  const { token } = await buildInvite({ peerSpecs: peerSpecs?.length ? peerSpecs : ['self'], repo: '<repo>', name: 'runpod' });
  return token;
}

// ---------- commands ----------
async function up(o, api, log) {
  const name = o.name || o._[0];
  const cloud = (o.cloud || 'SECURE').toUpperCase(), count = Number(o.count || 1), gpu = o.gpu || DEFAULT_GPU;
  if (!['SECURE', 'COMMUNITY'].includes(cloud)) throw Error('--cloud must be secure or community');
  for (const k of ['TS_AUTHKEY']) if (!process.env[k] && !o.template) throw Error(`${k} is not set (or put it in the runpod template / runpod secrets and pass --template)`);
  const status = await daemonStatus();
  if (status.peers.some((p) => p.name === name && fresh(p))) throw Error(`a live agentbus host named ${name} already exists; pick another --name`);
  // rate: explicit --cost, else runpod's list price for this gpu. absent stays unknown; never 0 by assumption.
  const rate = o.cost !== undefined ? Number(o.cost) : listRate(await api.gpuType(gpu).catch(() => null), { cloud, count });
  if (o.cost !== undefined && !(Number.isFinite(rate) && rate >= 0)) throw Error('--cost must be usd per hour');
  const body = createBody({ name, image: o.image, templateId: o.template, gpu, count, cloud, volumeId: o.volume || process.env.RUNPOD_NETWORK_VOLUME_ID, dataCenterId: o['data-center'], disk: Number(o.disk || 60), cuda: o.cuda, minCuda: o['min-cuda'],
    env: { AGENTBUS_NAME: name, AGENTBUS_JOIN_TOKEN: await joinToken(o.peer), TS_AUTHKEY: process.env.TS_AUTHKEY, CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      AGENTBUS_GPU_COST_PER_HOUR: rate === null ? undefined : String(rate), AGENTBUS_BILLING: billingLabel(cloud), HF_TOKEN: process.env.HF_TOKEN } });
  log(`creating ${cloud.toLowerCase()} pod ${name}: ${count}x ${gpu}, ${rate === null ? 'rate unknown' : `$${rate}/h list`}, volume ${body.mounts.network[0].volumeId}`);
  const pod = await api.createPod(body);
  const record = { podId: pod.id, name, gpu, count, cloud, createdAt: pod.createdAt || new Date().toISOString(), ratePerHour: Number.isFinite(pod.cost) ? pod.cost : rate, hostId: null };
  saveRecord(record);
  log(`pod ${pod.id} ${pod.status || 'created'}; billing has started. if anything below fails, run: node scripts/runpod/pod.mjs down ${pod.id}`);
  const deadline = Date.now() + (Number(o.wait || 25) * 60000);
  let last = '';
  // 1. runpod: RUNNING (image pull of a ~10 GB image takes minutes on first use of a machine)
  for (;;) {
    const p = await api.getPod(pod.id);
    if (!p) throw Error(`pod ${pod.id} disappeared while starting`);
    if (Number.isFinite(p.cost)) record.ratePerHour = p.cost;
    if (p.status !== last) { log(`runpod status ${p.status}${p.dataCenterId ? ` in ${p.dataCenterId}` : ''}${Number.isFinite(p.cost) ? `, billed $${p.cost}/h` : ''}`); last = p.status; }
    if (p.status === 'RUNNING') break;
    if (['ERROR', 'EXITED', 'TERMINATED'].includes(p.status)) throw Error(`pod ${pod.id} went ${p.status}; check its logs in the runpod console, then down it`);
    if (Date.now() > deadline) throw Error(`pod ${pod.id} not RUNNING after ${o.wait || 25} min; it is still billing: down it or wait and run status`);
    await sleep(10000);
  }
  saveRecord(record);
  // 2. agentbus: the pod's daemon dials this host; ours learns it and dials back through tailscale
  let peer;
  for (;;) {
    const s = await daemonStatus();
    peer = s.peers.find((p) => p.name === name && fresh(p));
    if (peer) break;
    if (Date.now() > deadline) throw Error(`pod is RUNNING but ${name} never authenticated to this host's agentbus daemon. on the pod (runpod web terminal): tail /root/.agentbus/lan/daemon.log and /var/log/tailscaled.log`);
    await sleep(5000);
  }
  record.hostId = peer.hostId; saveRecord(record);
  log(`agentbus host ${name} [${peer.hostId}] authenticated at ${peer.address}:${peer.port}`);
  // 3. doctor, retried while the pod finishes its first poll (reach back, storage probe)
  let check;
  for (let i = 0; i < 6; i++) { check = await checkPod(peer, { roundtrip: !o['no-roundtrip'] }); if (check.pass || Date.now() > deadline) break; await sleep(11000); }
  for (const l of check.lines) log(l);
  const caps = check.response.capabilities || {};
  const gpuLine = (caps.gpus || []).map((g) => `${g.memoryMiB || '?'}MiB ${g.name}`).join(', ') || 'gpu not detected';
  const result = { ok: check.pass, name, hostId: peer.hostId, podId: pod.id, gpu: gpuLine, advertisedCost: caps.gpu_cost_per_hour ?? null, billing: caps.billing ?? null, usage: usage({ createdAt: record.createdAt }, { rate: record.ratePerHour }) };
  log(`${check.pass ? 'ready' : 'up, but doctor checks failed'}: spawn_session host=${name}. stop billing with: node scripts/runpod/pod.mjs down ${name}`);
  return result;
}
async function status(o, api, log) {
  const ref = o._[0];
  const recs = ref ? [findRecord(ref) || { podId: ref }] : records();
  if (!recs.length) { log('no pods recorded on this host'); return []; }
  const s = await daemonStatus().catch(() => null);
  const out = [];
  for (const r of recs) {
    const pod = await api.getPod(r.podId);
    const peer = s?.peers.find((p) => p.hostId === r.hostId || p.name === r.name);
    const rate = peer?.capabilities?.gpu_cost_per_hour ?? (Number.isFinite(pod?.cost) ? pod.cost : r.ratePerHour);
    const u = usage(pod || r, { rate });
    out.push({ name: r.name || pod?.name, podId: r.podId, runpod: pod ? pod.status : 'gone', agentbus: peer ? (fresh(peer) ? 'authenticated' : 'unreachable') : 'not seen', hostId: r.hostId || peer?.hostId || null, usage: u, presence: peer?.presence ? `${peer.presence.user}, gpu=${peer.presence.gpu}${peer.presence.compute ? ', compute job running' : ''}` : null });
    log(`${r.name || pod?.name} [${r.podId}]: runpod ${pod ? pod.status : 'gone'}, agentbus ${out.at(-1).agentbus}; ${fmtUsage(u)}`);
  }
  return out;
}
async function down(o, api, log) {
  const ref = o._[0];
  if (!ref) throw Error('usage: pod.mjs down <name|pod id>');
  const r = findRecord(ref) || { podId: ref };
  const pod = await api.getPod(r.podId);
  const end = Date.now();
  const s = await daemonStatus().catch(() => null);
  const peer = s?.peers.find((p) => (r.hostId && p.hostId === r.hostId) || (r.name && p.name === r.name));
  if (peer?.presence?.compute && !o.force) throw Error(`${r.name || ref} is running a claimed compute job (${(peer.presence.jobs || []).map((j) => j.name || j.id).join(', ')}); fetch its results first or pass --force`);
  const t = await api.terminatePod(r.podId);
  log(`runpod ${t.status === 404 ? 'pod already gone' : 'terminate accepted'} (${r.podId})`);
  // confirm: 404, or TERMINATED. retried a few times since deletion is asynchronous on runpod's side.
  let after = await api.getPod(r.podId);
  for (let i = 0; after && after.status !== 'TERMINATED' && i < 12; i++) { await sleep(5000); after = await api.getPod(r.podId); }
  if (after && after.status !== 'TERMINATED') throw Error(`pod ${r.podId} still reports ${after.status} after terminate; check the runpod console. local record kept`);
  // agentbus: drop it from this daemon's live table and host history once it stops answering (the daemon refuses
  // while the host is still authenticated). other group hosts never store an ephemeral host and drop it after 60s.
  const hostId = r.hostId || peer?.hostId;
  let forgot = null;
  if (hostId && s) {
    const { localLanRequest } = await lib('lan.mjs');
    for (let i = 0; i < 18; i++) { forgot = await localLanRequest({ op: 'forget-host', hostId }, { timeout: 3000 }); if (forgot.ok) break; await sleep(5000); }
    log(forgot?.ok ? `agentbus: ${r.name || hostId} removed from this host's presence` : `agentbus: could not retire ${hostId} yet (${forgot?.error}); it expires on its own within a minute`);
  }
  const u = usage(pod || r, { now: end, rate: peer?.capabilities?.gpu_cost_per_hour ?? (Number.isFinite(pod?.cost) ? pod.cost : r.ratePerHour) });
  log(`billed time ${fmtUsage(u)}`);
  dropRecord(r);
  return { ok: true, podId: r.podId, name: r.name || null, hostId: hostId || null, usage: u, forgotten: forgot?.ok === true };
}
async function list(o, api, log) {
  const pods = await api.listPods();
  const recs = records();
  for (const p of pods) log(`${p.name} [${p.id}] ${p.status} ${p.gpu?.count || ''}x ${p.gpu?.id || p.cpu?.id || ''} $${p.cost ?? '?'}/h${recs.some((r) => r.podId === p.id) ? ' (started here)' : ''}`);
  for (const r of recs.filter((x) => !pods.some((p) => p.id === x.podId))) log(`${r.name} [${r.podId}] not on runpod anymore; stale local record (pod.mjs down ${r.podId} clears it)`);
  return { pods: pods.map((p) => ({ id: p.id, name: p.name, status: p.status, cost: p.cost })), records: recs };
}

export async function main(argv = process.argv.slice(2), { api, log = (s) => process.stderr.write(`${s}\n`) } = {}) {
  const [command, ...rest] = argv;
  const o = parseArgs(rest);
  const commands = { up, status, down, list };
  if (!commands[command]) throw Error('usage: pod.mjs up --name NAME (--image IMAGE | --template ID) --volume VOLUME_ID [--gpu "NVIDIA H100 80GB HBM3"] [--count 1] [--cloud secure] [--data-center ID] [--min-cuda 13.0 | --cuda V --cuda V2 (exact list)] [--disk 60] [--cost USD_PER_H] [--peer name=100.x:port] [--wait 25] [--no-roundtrip] | status [NAME] | down NAME [--force] | list');
  return commands[command](o, api || runpodClient(), log);
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.chdir(root);
  main().then((r) => console.log(JSON.stringify(r, null, 2)), (e) => { console.error(`pod: ${e.message}`); process.exit(1); });
}
