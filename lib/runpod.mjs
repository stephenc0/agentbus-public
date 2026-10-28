// runpod rest api v2 client and the pure helpers shared by scripts/runpod/pod.mjs and the daemon's cloud provisioner.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { peerRequest, listenInfo } from './lan.mjs';
import { uploadFile, downloadFile, blobPurge } from './blob.mjs';
import { buildInfo } from './build-info.mjs';

export const API = process.env.RUNPOD_API_BASE || 'https://api.runpod.io';
export const DEFAULT_GPU = 'NVIDIA H100 80GB HBM3';
const NAME = /^[a-zA-Z0-9_.-]{1,63}$/;

// ---------- runpod api ----------
export function runpodClient({ key = process.env.RUNPOD_API_KEY, fetchImpl = globalThis.fetch, base = API } = {}) {
  if (!key) throw Error('RUNPOD_API_KEY is not set (runpod console > settings > api keys)');
  async function call(method, url, body) {
    const res = await fetchImpl(`${base}${url}`, { method, headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
    return { status: res.status, ok: res.ok, json, text };
  }
  const fail = (what, r) => Error(`runpod ${what}: http ${r.status}${r.json?.detail || r.json?.error || r.json?.message ? ` ${r.json.detail || r.json.error || r.json.message}` : ''}`);
  return {
    async createPod(body) { const r = await call('POST', '/v2/pods', body); if (r.status !== 201 && r.status !== 200) throw fail('create pod', r); return r.json; },
    async getPod(id) { const r = await call('GET', `/v2/pods/${encodeURIComponent(id)}`); if (r.status === 404) return null; if (!r.ok) throw fail('get pod', r); return r.json; },
    async listPods() { const r = await call('GET', '/v2/pods'); if (!r.ok) throw fail('list pods', r); return r.json?.pods || []; },
    // 204 deleted; 404 already gone. both leave no pod billing.
    async terminatePod(id) { const r = await call('DELETE', `/v2/pods/${encodeURIComponent(id)}`); if (r.status === 204 || r.status === 200 || r.status === 404) return { gone: true, status: r.status }; throw fail('terminate pod', r); },
    async gpuType(id) { const r = await call('GET', `/v2/catalog/gpus/${encodeURIComponent(id)}`); return r.ok ? r.json : null; },
    async networkVolumes() { const r = await call('GET', '/v2/network-volumes'); if (!r.ok) throw fail('list network volumes', r); return r.json?.networkVolumes || []; },
  };
}

// ---------- pure helpers (tested) ----------
export const billingLabel = (cloud = 'SECURE') => `runpod ${String(cloud).toLowerCase()} cloud on-demand`;
// list price per gpu-hour times gpu count. the pod's own `cost` (what is actually billed) replaces it once known.
export function listRate(gpuType, { cloud = 'SECURE', count = 1 } = {}) {
  const p = gpuType?.price?.[cloud === 'COMMUNITY' ? 'community' : 'secure'];
  return Number.isFinite(p) && p >= 0 ? Math.round(p * count * 1000) / 1000 : null;
}
export function createBody({ name, image, templateId, gpu = DEFAULT_GPU, count = 1, cloud = 'SECURE', volumeId, mountPath = '/workspace', dataCenterId, disk = 60, cuda, minCuda, env }) {
  if (!NAME.test(name || '')) throw Error('--name must be 1-63 letters, digits, dots, underscores or dashes (it becomes the agentbus and tailscale name)');
  if (!image && !templateId) throw Error('pass --image <registry>/agentbus-runpod:<tag> or --template <runpod template id>');
  if (!volumeId) throw Error('pass --volume <network volume id>: weights and task results live on it');
  // minCudaVersion is a floor ("13.0" accepts 13.0, 13.2, ...). allowedCudaVersions is an exact-match list: it must name
  // every acceptable host version, or placement finds no stock. runpod rejects both together (400).
  if (minCuda !== undefined && !/^\d+\.\d+$/.test(minCuda)) throw Error('min cuda must be major.minor, e.g. 13.0');
  if (minCuda && cuda?.length) throw Error('use a cuda floor (minCuda) or an exact list (cuda), not both');
  return {
    name, ...(image ? { image } : {}), ...(templateId ? { templateId } : {}),
    gpu: { id: gpu, count, ...(minCuda ? { minCudaVersion: minCuda } : cuda?.length ? { allowedCudaVersions: cuda } : {}) },
    cloud, disk, ...(dataCenterId ? { dataCenterIds: [dataCenterId] } : {}),
    mounts: { network: [{ volumeId, path: mountPath }] },
    // a template's env is merged per key; only values set here override it
    env: Object.fromEntries(Object.entries(env || {}).filter(([, v]) => v !== undefined && v !== '')),
  };
}
// billable time is counted from creation (provisioning bills) to now or to termination.
export function usage(pod, { now = Date.now(), rate } = {}) {
  const from = Date.parse(pod?.createdAt || pod?.startedAt || '');
  const hours = Number.isFinite(from) ? Math.max(0, now - from) / 3.6e6 : null;
  const perHour = Number.isFinite(rate) ? rate : Number.isFinite(pod?.cost) ? pod.cost : null;
  return { hours: hours === null ? null : Math.round(hours * 1000) / 1000, ratePerHour: perHour, estimateUsd: hours !== null && perHour !== null ? Math.round(hours * perHour * 100) / 100 : null };
}
export const fmtUsage = (u) => `${u.hours ?? '?'} h at ${u.ratePerHour === null ? 'unknown rate' : `$${u.ratePerHour}/h`} = ${u.estimateUsd === null ? 'unknown' : `~$${u.estimateUsd}`} (estimate; runpod billing is authoritative)`;

// the checks `lan doctor` makes, from the dialing side: authenticated inventory, reach back, rw storage, a blob round trip.
const clean = (v) => typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 120) : '';
export async function checkPod(config, peer, { roundtrip = true } = {}) {
  const r = await peerRequest(config, peer, { op: 'agents', listen: listenInfo(config, config.port, peer.address) }, 8000);
  const lines = [], ok = (label, pass, detail) => { lines.push(`${pass ? 'ok  ' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`); return pass; };
  let pass = ok('authenticated', r.ok && r.hostId === peer.hostId, r.ok ? `${r.name}, ${r.agents?.length ?? 0} agents` : r.error);
  pass = ok('reach back', r.reachBack === true, r.reachBack ? 'pod dials this host' : 'pod has not authenticated this host yet') && pass;
  const owned = (r.storage || []).filter((s) => s.ownerHostId === peer.hostId && s.access === 'rw' && s.status === 'available');
  const pod = r.build?.sourceHash ? String(r.build.sourceHash).slice(0, 8) : null, here = buildInfo.sourceHash.slice(0, 8);
  lines.push(pod === here ? `ok   agentbus build: ${here} on both (${clean(r.codeSource) || 'source unknown'})` : `WARN agentbus build mismatch: pod ${pod || 'unknown'} (${clean(r.codeSource) || 'source unknown'}) vs provisioner ${here}`);
  pass = ok('task storage', owned.length === 1, owned.map((s) => `${s.localPath} ${s.freeBytes ? `${(s.freeBytes / 1024 ** 3).toFixed(0)} GiB free` : ''}`).join('; ') || 'none advertised yet') && pass;
  if (roundtrip && owned.length === 1) {
    const task = crypto.randomUUID(), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-pod-'));
    try {
      const src = path.join(tmp, 'probe.bin'); fs.writeFileSync(src, crypto.randomBytes(4 * 1024 * 1024));
      const t0 = Date.now();
      const up = await uploadFile(config, peer, { task, area: 'in', name: 'probe.bin', file: src, retries: 1 });
      const down = await downloadFile(config, peer, { task, area: 'in', name: 'probe.bin', dest: path.join(tmp, 'back.bin'), retries: 1 });
      pass = ok('blob roundtrip', up.sha256 === down.sha256, `4 MiB in ${((Date.now() - t0) / 1000).toFixed(1)}s`) && pass;
    } catch (e) { pass = ok('blob roundtrip', false, e.message) && pass; }
    finally { await blobPurge(config, peer, { task }).catch(() => {}); fs.rmSync(tmp, { recursive: true, force: true }); }
  }
  return { pass, lines, response: r };
}
