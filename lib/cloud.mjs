// on-demand cloud gpu peers, provisioned by one always-on group host (the "provisioner").
//
// the provisioner holds the provider key and the tailscale auth key in owner-only files under ~/.agentbus/cloud and
// advertises its configured offers in authenticated inventory (never in mdns, never with secrets). any authenticated peer
// may ask it, over the existing tls-psk link, to start (`cloud up`) or stop (`cloud down`) an offer. a started pod joins
// the group as an ephemeral userspace-tailscale peer under the offer's name; every group host learns its tailscale
// address from the provisioner's inventory and dials it directly, so the requester's blob and spawn traffic goes straight
// to the pod.
//
// lifetime is enforced here, not by the requester: a hard cap (hours, and usd at the billed rate) set at `cloud up`, and
// an idle rule (no claimed job, no blob transfer, no finished results waiting to be fetched, for idleMinutes). before a
// pod is terminated, every task folder on it whose results were fetched (or that has none) is purged from the network
// volume; folders with unfetched results are kept and reported.
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from './atomic-file.mjs';
import { ownerOnly, restrictToOwner, encodeJoinToken, detectOverlayIPv4, overlayIPv4, UUID } from './lan.mjs';
import { runpodClient, createBody, listRate, billingLabel, usage, checkPod, DEFAULT_GPU } from './runpod.mjs';
import { blobPurge } from './blob.mjs';
import { tailscaleClient, POD_TAG } from './tailscale-api.mjs';

const NAME = /^[a-zA-Z0-9_.-]{1,63}$/;
// TS_OAUTH_CLIENT_ID/SECRET: a tailscale oauth client (scopes auth_keys + policy_file, tag tag:agentbus-gpu) that mints a
// single-use key per pod. TS_AUTHKEY (a long-lived reusable key) is the legacy fallback, used only without the client.
const SECRET_KEYS = ['RUNPOD_API_KEY', 'TS_OAUTH_CLIENT_ID', 'TS_OAUTH_CLIENT_SECRET', 'TS_AUTHKEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'HF_TOKEN'];
// the pod's own backstop fires this long after the provisioner's hard cap, if the provisioner could not stop it
export const POD_BACKSTOP_GRACE_MS = 10 * 60000;
const clean = (v, n = 160) => typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, n) : null;
const num = (v) => Number.isFinite(v) && v >= 0 ? v : null;
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
export const cloudDir = (busDir) => path.join(busDir, 'cloud');

// ----- owner config -----
export const AGENTBUS_REF = /^(?:[0-9a-f]{40}|v[0-9][0-9A-Za-z._-]{0,40})$/;
// null is how an absent optional field comes back from a config this function wrote (cloud init stores its own output),
// so it means the same as undefined everywhere, at the top level and in each offer
const dropNulls = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null));
export function validateCloudConfig(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw Error('cloud config must be an object');
  c = { ...dropNulls(c), ...(Array.isArray(c.offers) ? { offers: c.offers.map((o) => o && typeof o === 'object' ? dropNulls(o) : o) } : {}) };
  if (c.provider !== undefined && c.provider !== 'runpod') throw Error('only provider "runpod" is supported');
  for (const k of ['idleMinutes', 'maxHours', 'maxUsd']) if (c[k] !== undefined && !(Number.isFinite(c[k]) && c[k] > 0)) throw Error(`${k} must be a positive number`);
  if (!Array.isArray(c.offers) || !c.offers.length || c.offers.length > 8) throw Error('offers must list 1-8 offers');
  const names = new Set();
  const offers = c.offers.map((o) => {
    if (!NAME.test(o?.name || '') || names.has(o.name)) throw Error('each offer needs a unique name (letters, digits, . _ -), used as the pod\'s agentbus name');
    names.add(o.name);
    if (!o.image && !o.templateId) throw Error(`offer ${o.name}: image or templateId required`);
    if (!o.volumeId) throw Error(`offer ${o.name}: volumeId required (weights and task storage)`);
    for (const k of ['count', 'disk', 'coldStartMinutes', 'gpuMemoryMiB']) if (o[k] !== undefined && !(Number.isFinite(o[k]) && o[k] > 0)) throw Error(`offer ${o.name}: ${k} must be positive`);
    if (o.cloud !== undefined && !['SECURE', 'COMMUNITY'].includes(o.cloud)) throw Error(`offer ${o.name}: cloud must be SECURE or COMMUNITY`);
    if (o.cuda !== undefined && !(Array.isArray(o.cuda) && o.cuda.every((v) => /^\d+\.\d+$/.test(v)))) throw Error(`offer ${o.name}: cuda must be an exact list like ["13.0", "13.2"] naming every acceptable host version (prefer minCuda)`);
    if (o.minCuda !== undefined && !/^\d+\.\d+$/.test(o.minCuda)) throw Error(`offer ${o.name}: minCuda must be major.minor, e.g. "13.0"`);
    if (o.minCuda && o.cuda?.length) throw Error(`offer ${o.name}: minCuda and cuda are exclusive (runpod rejects both)`);
    return { name: o.name, gpu: o.gpu || DEFAULT_GPU, count: o.count || 1, cloud: o.cloud || 'SECURE', image: o.image, templateId: o.templateId, volumeId: o.volumeId, dataCenterId: o.dataCenterId, cuda: o.cuda, minCuda: o.minCuda, disk: o.disk || 60, coldStartMinutes: o.coldStartMinutes || 15, gpuMemoryMiB: o.gpuMemoryMiB, ratePerHour: num(o.ratePerHour) };
  });
  // the agentbus release pods run, fetched over https at boot: an exact commit or a v-tag, never a branch
  if (c.agentbusRef !== undefined && !AGENTBUS_REF.test(c.agentbusRef)) throw Error('agentbusRef must be a 40-hex commit or a release tag like v0.6.1 (branches float and are refused)');
  if (c.agentbusRepo !== undefined && !/^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._\/-]+$/.test(c.agentbusRepo)) throw Error('agentbusRepo must be an https git url (public; pods hold no git credential)');
  return { provider: 'runpod', idleMinutes: c.idleMinutes || 15, maxHours: c.maxHours || 8, maxUsd: c.maxUsd ?? null, agentbusRef: c.agentbusRef || null, agentbusRepo: c.agentbusRepo || null, offers };
}
export function readCloudConfig(busDir) {
  const file = path.join(cloudDir(busDir), 'config.json');
  if (!fs.existsSync(file)) return null;
  return validateCloudConfig(readJson(file));
}
// secrets: owner-only file, env wins. never logged, never in inventory, status or errors.
export function readCloudSecrets(busDir, env = process.env) {
  const file = path.join(cloudDir(busDir), 'secrets.json');
  let stored = {};
  if (fs.existsSync(file)) {
    if (!ownerOnly(file)) throw Error('cloud secrets file must be readable only by its owner (chmod 600)');
    stored = readJson(file);
  }
  return Object.fromEntries(SECRET_KEYS.map((k) => [k, env[k] || stored[k]]).filter(([, v]) => typeof v === 'string' && v));
}
export function writeCloudSecrets(busDir, values) {
  const dir = cloudDir(busDir), file = path.join(dir, 'secrets.json');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); restrictToOwner(dir);
  let current = {}; try { current = readJson(file); } catch {}
  const next = { ...current, ...Object.fromEntries(Object.entries(values).filter(([k, v]) => SECRET_KEYS.includes(k) && typeof v === 'string' && v)) };
  atomicWriteFileSync(file, JSON.stringify(next, null, 2), { mode: 0o600 }); restrictToOwner(file);
  return Object.keys(next);
}

// ----- what peers see -----
const fresh = (p, now = Date.now()) => !!p && !p.error && now - (p.checkedAt || 0) < 30000;
export { sanitizeCloud, sanitizeBlobActivity, formatOffer, STATES } from './cloud-view.mjs';
import { STATES } from './cloud-view.mjs';

// ----- the provisioner -----
// deps: config (this host's lan config incl. key), busDir, peers (the daemon's live Map), forget(hostId), log.
export function createProvisioner({ config, busDir, peers, forget = () => {}, log = () => {}, api: injectedApi, cloudConfig = readCloudConfig(busDir), secrets = () => readCloudSecrets(busDir), overlay = detectOverlayIPv4, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(), pollMs = 10000, doctor = checkPod, readyTimeoutMs, tailscale: injectedTailscale } = {}) {
  if (!cloudConfig) return null;
  const stateFile = path.join(cloudDir(busDir), 'state.json');
  const offers = new Map(cloudConfig.offers.map((o) => [o.name, o]));
  const state = new Map();
  let closed = false;
  try { for (const s of readJson(stateFile).offers || []) if (offers.has(s.name)) state.set(s.name, s); } catch {}
  for (const name of offers.keys()) if (!state.has(name)) state.set(name, { name, state: 'dormant', progress: [] });
  // a restart mid-flight: anything that may still bill is resumed as live and re-validated against the provider on the next tick
  for (const s of state.values()) if (s.podId && s.state !== 'dormant') { s.state = 'live'; s.lastBusyAt = now(); s.progress = [...(s.progress || []), 'provisioner restarted; re-validating the pod'].slice(-12); }
  const persistable = (s) => { const { revokeKey, cancel, ...rest } = s; return rest; };
  const save = () => { try { fs.mkdirSync(cloudDir(busDir), { recursive: true, mode: 0o700 }); atomicWriteFileSync(stateFile, JSON.stringify({ offers: [...state.values()].map(persistable) }), { mode: 0o600 }); } catch (e) { log(`cloud state: ${e.message}`); } };
  const note = (s, text) => { s.progress = [...(s.progress || []), `${new Date(now()).toISOString().slice(11, 19)} ${text}`].slice(-12); log(`cloud ${s.name}: ${text}`); save(); };
  let apiCache = injectedApi || null;
  const api = () => apiCache || (apiCache = runpodClient({ key: secrets().RUNPOD_API_KEY }));
  const podPeer = (s) => (s.hostId && peers.get(s.hostId)) || [...peers.values()].find((p) => p.name === s.name && p.ephemeral && fresh(p, now()));
  const ownerCap = (rate) => Math.min(cloudConfig.maxHours, cloudConfig.maxUsd && rate ? cloudConfig.maxUsd / rate : Infinity);

  // the price is the provider's current list price for this offer's cloud (secure vs community differ a lot), read fresh
  // from the catalog at every start and when the provisioner comes up. a configured ratePerHour is only the fallback when
  // the catalog cannot be read; a running pod's billed rate (pod.cost) replaces both.
  async function rateFor(offer, s, { refresh = false } = {}) {
    if (!refresh && Number.isFinite(s.ratePerHour)) return s.ratePerHour;
    try {
      const g = await api().gpuType(offer.gpu);
      if (g?.memory && !offer.gpuMemoryMiB && (!s.gpuMemoryMiB || s.memorySource === 'catalog')) { s.gpuMemoryMiB = g.memory * 1024 * offer.count; s.memorySource = 'catalog'; }
      const r = listRate(g, { cloud: offer.cloud, count: offer.count });
      if (r !== null) { s.ratePerHour = r; s.rateSource = `catalog ${offer.cloud.toLowerCase()}`; s.rateAt = now(); return r; }
    } catch {}
    if (Number.isFinite(s.ratePerHour)) return s.ratePerHour;
    if (Number.isFinite(offer.ratePerHour)) { s.ratePerHour = offer.ratePerHour; s.rateSource = 'config'; return offer.ratePerHour; }
    return null;
  }
  // current prices for dormant offers too, so host_status is right before anyone starts a pod
  let canPrice = !!injectedApi; try { canPrice ||= !!secrets().RUNPOD_API_KEY; } catch {}
  if (canPrice) for (const o of offers.values()) { const s = state.get(o.name); if (s.state === 'dormant') void rateFor(o, s, { refresh: true }).then(save, () => {}); }
  function publicOffer(offer) {
    const s = state.get(offer.name), p = s.state === 'live' ? podPeer(s) : null;
    return { name: offer.name, state: s.state, gpu: offer.gpu, count: offer.count, gpuMemoryMiB: (s.memorySource === 'pod' && s.gpuMemoryMiB) || offer.gpuMemoryMiB || s.gpuMemoryMiB || null, memorySource: s.memorySource === 'pod' && s.gpuMemoryMiB ? 'pod' : offer.gpuMemoryMiB ? 'config' : s.memorySource || null,
      ratePerHour: s.ratePerHour ?? offer.ratePerHour ?? null, billing: billingLabel(offer.cloud), coldStartMinutes: s.coldStartMinutes || offer.coldStartMinutes, maxHours: cloudConfig.maxHours,
      pod: p && fresh(p, now()) ? { hostId: p.hostId, address: p.address, port: p.port } : null, startedBy: s.startedBy || null, users: s.users || [], startedAt: s.startedAt || null, liveAt: s.liveAt || null,
      capUntil: s.capUntil || null, capUsd: s.capUsd || null, idleSince: s.state === 'live' && s.lastBusyAt && now() - s.lastBusyAt > pollMs * 2 ? s.lastBusyAt : null, progress: s.progress || [], lastError: s.lastError || null, keptTasks: s.keptTasks || [], last: s.last || null };
  }
  // the provisioner's own dial address, so hosts that only peer with someone else can be introduced to it
  const selfAddress = () => { if (!config.port) return null; const a = config.advertiseAddress || overlay()[0]; return a ? { hostId: config.hostId, name: config.name, address: a, port: config.port } : null; };
  const snapshot = () => ({ provisionerHostId: config.hostId, provisioner: selfAddress(), idleMinutes: cloudConfig.idleMinutes, offers: [...offers.values()].map(publicOffer) });

  function joinToken() {
    if (!config.port) throw Error('the provisioner needs a fixed lan port (lan config "port": 47800, then restart its daemon): pods dial it');
    const address = config.advertiseAddress || overlay()[0];
    if (!address) throw Error('the provisioner has no tailscale address; pods reach the group over tailscale');
    return encodeJoinToken({ key: config.key.toString('hex'), peers: [{ hostId: config.hostId, name: config.name, address, port: config.port }] });
  }

  async function provision(offer, s) {
    const deadline = now() + (readyTimeoutMs ?? Math.max(30, offer.coldStartMinutes * 3) * 60000);
    const t0 = now();
    try {
      const sec = secrets();
      if (!sec.RUNPOD_API_KEY) throw Error('provisioner secret RUNPOD_API_KEY is not configured (agentbus cloud secrets --from-env)');
      const oauth = sec.TS_OAUTH_CLIENT_ID && sec.TS_OAUTH_CLIENT_SECRET;
      if (!oauth && !sec.TS_AUTHKEY && !offer.templateId) throw Error('no tailscale credential: configure TS_OAUTH_CLIENT_ID and TS_OAUTH_CLIENT_SECRET (agentbus cloud secrets --from-env)');
      // a fresh single-use key per pod, valid only for the cold start. it lives in this local and the pod's env, nowhere else:
      // never in state.json, progress, logs or inventory.
      let authKey = sec.TS_AUTHKEY;
      if (oauth) {
        const ts = injectedTailscale || tailscaleClient({ clientId: sec.TS_OAUTH_CLIENT_ID, clientSecret: sec.TS_OAUTH_CLIENT_SECRET });
        // the key must outlive the whole start window: the container may only run `tailscale up` after a long first image
        // pull, right up to the provisioner's deadline. it is single use either way, so a longer expiry costs little.
        const expirySeconds = Math.round(Math.max(900, (deadline - now()) / 1000 + 600));
        const minted = await ts.mintAuthKey({ tags: [POD_TAG], expirySeconds, description: `agentbus ${offer.name}` });
        authKey = minted.key; s.tsKeyId = minted.id || null;
        s.revokeKey = () => ts.revokeKey(s.tsKeyId);
        note(s, `minted a single-use ephemeral tailscale key (${POD_TAG}, expires in ${Math.round(expirySeconds / 60)} min)`);
      } else if (sec.TS_AUTHKEY) note(s, 'using the configured reusable TS_AUTHKEY (legacy; configure an oauth client to mint single-use keys)');
      const rate = await rateFor(offer, s);
      const body = createBody({ name: offer.name, image: offer.image, templateId: offer.templateId, gpu: offer.gpu, count: offer.count, cloud: offer.cloud, volumeId: offer.volumeId, dataCenterId: offer.dataCenterId, disk: offer.disk, cuda: offer.cuda, minCuda: offer.minCuda,
        env: { AGENTBUS_NAME: offer.name, AGENTBUS_JOIN_TOKEN: joinToken(), TS_AUTHKEY: authKey, AGENTBUS_HARD_STOP_AT: s.capUntil ? String(Math.ceil((s.capUntil + POD_BACKSTOP_GRACE_MS) / 1000)) : undefined, CLAUDE_CODE_OAUTH_TOKEN: sec.CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY: sec.ANTHROPIC_API_KEY, HF_TOKEN: sec.HF_TOKEN, AGENTBUS_GPU_COST_PER_HOUR: rate === null ? undefined : String(rate), AGENTBUS_BILLING: billingLabel(offer.cloud), AGENTBUS_REF: cloudConfig.agentbusRef || undefined, AGENTBUS_REPO: cloudConfig.agentbusRepo || undefined } });
      if (!cloudConfig.agentbusRef) note(s, 'no agentbusRef in cloud config: the pod runs the agentbus copy baked into its image');
      note(s, `creating ${offer.cloud.toLowerCase()} pod: ${offer.count}x ${offer.gpu}${rate === null ? '' : ` at $${rate}/h list`}`);
      const pod = await api().createPod(body);
      s.podId = pod.id; s.startedAt = Date.parse(pod.createdAt || '') || now(); if (Number.isFinite(pod.cost)) s.ratePerHour = pod.cost;
      note(s, `pod ${pod.id} created; billing started`);
      let last = '';
      for (;;) {
        if (s.cancel) throw Error(`cancelled by ${s.cancel}`);
        const p = await api().getPod(s.podId);
        if (!p) throw Error('pod disappeared at the provider while starting');
        if (Number.isFinite(p.cost)) s.ratePerHour = p.cost;
        if (p.status !== last) { note(s, `provider status ${p.status}${p.dataCenterId ? ` in ${p.dataCenterId}` : ''}`); last = p.status; }
        if (p.status === 'RUNNING') break;
        if (['ERROR', 'EXITED', 'TERMINATED'].includes(p.status)) throw Error(`pod went ${p.status} while starting`);
        if (now() > deadline) throw Error('pod did not reach RUNNING in time');
        await sleep(pollMs);
      }
      let peer;
      for (;;) {
        if (s.cancel) throw Error(`cancelled by ${s.cancel}`);
        peer = [...peers.values()].find((p) => p.name === offer.name && fresh(p, now()));
        if (peer) break;
        if (now() > deadline) throw Error('pod is RUNNING but never authenticated to the provisioner (tailscale acl for tag:agentbus-gpu, or the pod\'s start.sh failed: see its runpod logs)');
        await sleep(Math.min(pollMs, 5000));
      }
      s.hostId = peer.hostId; note(s, `authenticated as ${offer.name} [${peer.hostId.slice(0, 8)}] at ${peer.address}:${peer.port}`);
      let check;
      for (let i = 0; i < 6; i++) { check = await doctor(config, peer, { roundtrip: true }); if (check.pass || now() > deadline || s.cancel) break; await sleep(Math.min(pollMs, 11000)); }
      for (const l of check.lines) note(s, l);
      if (!check.pass) throw Error('lan doctor checks from the provisioner failed');
      const caps = check.response?.capabilities;
      const mem = (caps?.gpus || []).reduce((a, g) => a + (g.memoryMiB || 0), 0);
      if (mem) { s.gpuMemoryMiB = mem; s.memorySource = 'pod'; }
      s.coldStartMinutes = Math.max(1, Math.round((now() - t0) / 60000));
      s.state = 'live'; s.liveAt = now(); s.lastBusyAt = now(); delete s.lastError;
      note(s, `live; cold start ${s.coldStartMinutes} min`);
    } catch (e) {
      s.lastError = e.message; note(s, `start failed: ${e.message}`);
      // an unused minted key must not outlive a failed start
      if (s.revokeKey && !s.hostId) { try { await s.revokeKey(); note(s, 'revoked the unused tailscale key'); } catch (r) { note(s, `could not revoke the tailscale key: ${r.message}`); } }
      await teardown(s, { reason: `start failed: ${e.message}`, by: s.cancel || 'provisioner', purge: false });
    }
  }

  async function teardown(s, { reason, by, purge = true, purgeAll = false }) {
    s.state = 'stopping'; save();
    const peer = s.hostId ? peers.get(s.hostId) : null;
    const kept = [];
    if (purge && peer && fresh(peer, now())) {
      for (const t of peer.blob?.tasks || []) {
        // keep anything with out/ files nobody downloaded (finished or not: a crashed job's partial results survive)
        if ((t.unfetched || t.pendingFiles > 0) && !purgeAll) { kept.push(t.task); continue; }
        try { await blobPurge(config, peer, { task: t.task }); } catch (e) { kept.push(t.task); note(s, `purge ${t.task.slice(0, 8)} failed: ${e.message}`); }
      }
      note(s, `purged ${(peer.blob?.tasks || []).length - kept.length} task folder(s) from the volume${kept.length ? `; kept ${kept.length} with unfetched results` : ''}`);
    } else if (purge && peer) note(s, 'pod unreachable; task folders not purged');
    const end = now();
    if (s.podId) {
      try {
        await api().terminatePod(s.podId);
        let after = await api().getPod(s.podId);
        for (let i = 0; after && after.status !== 'TERMINATED' && i < 12; i++) { await sleep(Math.min(pollMs, 5000)); after = await api().getPod(s.podId); }
        if (after && after.status !== 'TERMINATED') throw Error(`still ${after.status}`);
        note(s, `pod ${s.podId} terminated (${reason})`);
      } catch (e) {
        // never forget a pod that may still bill: stay in stopping and retry on the next tick
        s.lastError = `terminate failed: ${e.message}`; note(s, s.lastError); s.retryStop = { reason, by }; return false;
      }
    }
    if (s.hostId) { if (peer && !peer.static) peers.delete(s.hostId); try { forget(s.hostId); } catch {} }
    const u = usage({ createdAt: s.startedAt ? new Date(s.startedAt).toISOString() : null }, { now: end, rate: s.ratePerHour });
    s.last = { reason, stoppedAt: end, hours: u.hours, estimateUsd: u.estimateUsd, startedBy: s.startedBy?.hostName || null, stoppedBy: by };
    const keep = { name: s.name, state: 'dormant', progress: s.progress, ratePerHour: s.ratePerHour, gpuMemoryMiB: s.gpuMemoryMiB, memorySource: s.memorySource, coldStartMinutes: s.coldStartMinutes, last: s.last, keptTasks: kept, ...(s.lastError && reason.startsWith('start failed') ? { lastError: s.lastError } : {}) };
    state.set(s.name, keep); note(keep, `dormant; ${u.hours ?? '?'} h, ~$${u.estimateUsd ?? '?'}`);
    return true;
  }

  // the lifetime rules. called from the daemon's poll loop.
  let ticking = false, lastProviderCheck = 0;
  async function tick() {
    if (ticking || closed) return; ticking = true;
    try {
      for (const s of state.values()) {
        if (s.state === 'stopping' && s.retryStop) { const r = s.retryStop; delete s.retryStop; await teardown(s, { ...r, purge: false }); continue; }
        if (s.state !== 'live') continue;
        const t = now();
        if (s.capUntil && t >= s.capUntil) { await teardown(s, { reason: 'hard time cap reached', by: 'provisioner' }); continue; }
        if (s.capUsd && s.ratePerHour && s.startedAt && (t - s.startedAt) / 3.6e6 * s.ratePerHour >= s.capUsd) { await teardown(s, { reason: 'hard spend cap reached', by: 'provisioner' }); continue; }
        if (t - lastProviderCheck > 60000) {
          lastProviderCheck = t;
          const p = await api().getPod(s.podId).catch(() => undefined);
          if (p === null || ['TERMINATED', 'EXITED', 'ERROR'].includes(p?.status)) { await teardown(s, { reason: `pod ${p ? p.status : 'gone'} at the provider`, by: 'provider', purge: false }); continue; }
          if (Number.isFinite(p?.cost)) s.ratePerHour = p.cost;
        }
        const peer = podPeer(s);
        const busy = fresh(peer, t) && ((peer.presence?.compute === true || (peer.presence?.jobs || []).length > 0) || (peer.blob?.inFlight || 0) > 0 || (peer.blob?.tasks || []).some((x) => x.unfetched));
        if (busy) s.lastBusyAt = t;
        else if (t - (s.lastBusyAt || t) >= cloudConfig.idleMinutes * 60000) await teardown(s, { reason: `idle for ${cloudConfig.idleMinutes} min`, by: 'provisioner' });
      }
    } finally { ticking = false; }
  }

  async function request(req, requester) {
    const action = req.action;
    if (action === 'status') return { ok: true, ...snapshot() };
    const offer = offers.get(req.offer) || (offers.size === 1 && !req.offer ? [...offers.values()][0] : null);
    if (!offer) return { ok: false, error: `unknown offer ${req.offer || ''}; offers: ${[...offers.keys()].join(', ')}` };
    const s = state.get(offer.name);
    const who = { hostId: requester.hostId, hostName: clean(requester.hostName, 63), agentId: clean(requester.agentId, 96) };
    if (action === 'up') {
      if (s.state === 'live' || s.state === 'starting') {
        if (!(s.users || []).some((u) => u.hostId === who.hostId)) s.users = [...(s.users || []), { hostId: who.hostId, hostName: who.hostName }];
        save();
        return { ok: true, joined: true, note: `${offer.name} is already ${s.state} (started by ${s.startedBy?.hostName || 'unknown'}); you share it. its caps stay as set at start`, offer: publicOffer(offer) };
      }
      if (s.state === 'stopping') return { ok: false, error: `${offer.name} is stopping; ask again in a minute`, offer: publicOffer(offer) };
      const maxHours = req.maxHours === undefined ? null : Number(req.maxHours), maxUsd = req.maxUsd === undefined ? null : Number(req.maxUsd);
      if (maxHours === null && maxUsd === null) return { ok: false, error: 'cost acknowledgement required: pass max_hours or max_usd (a hard cap the provisioner enforces)' };
      if ((maxHours !== null && !(maxHours > 0)) || (maxUsd !== null && !(maxUsd > 0))) return { ok: false, error: 'max_hours / max_usd must be positive numbers' };
      const rate = await rateFor(offer, s, { refresh: true });
      if (maxHours === null && rate === null) return { ok: false, error: 'the hourly rate is unknown, so max_usd cannot be turned into a time cap; pass max_hours' };
      const hours = Math.min(maxHours ?? Infinity, maxUsd !== null && rate ? maxUsd / rate : Infinity, ownerCap(rate));
      const t = now();
      Object.assign(s, { state: 'starting', startedBy: who, users: [{ hostId: who.hostId, hostName: who.hostName }], startedAt: t, capUntil: t + hours * 3.6e6, capUsd: maxUsd ?? (cloudConfig.maxUsd || null), progress: [], keptTasks: [], podId: null, hostId: null });
      delete s.cancel; delete s.lastError;
      note(s, `start requested by ${who.hostName || who.hostId.slice(0, 8)} (${who.agentId || 'unknown agent'}); cap ${Math.round(hours * 100) / 100} h${s.capUsd ? ` / $${s.capUsd}` : ''}`);
      void provision(offer, s);
      return { ok: true, started: true, note: `starting ${offer.name}; cold start ~${s.coldStartMinutes || offer.coldStartMinutes} min. poll cloud_status; when it is live, ${offer.name} is a normal peer for blob and spawn_session`, offer: publicOffer(offer) };
    }
    if (action === 'down') {
      if (s.state === 'dormant') return { ok: true, note: `${offer.name} is already dormant`, offer: publicOffer(offer) };
      if (s.state === 'starting') { s.cancel = who.hostName || who.hostId; note(s, `cancel requested by ${s.cancel}`); return { ok: true, note: 'start cancelled; the pod is terminated as soon as the current provider call returns', offer: publicOffer(offer) }; }
      if (s.state === 'stopping') return { ok: true, note: 'already stopping', offer: publicOffer(offer) };
      const peer = podPeer(s);
      if (!req.force && fresh(peer, now()) && (peer.presence?.compute || (peer.presence?.jobs || []).length)) return { ok: false, error: `${offer.name} is running a claimed compute job; fetch its results first or pass force` };
      if (!req.force && fresh(peer, now()) && (peer.blob?.tasks || []).some((x) => x.unfetched)) return { ok: false, error: `${offer.name} has finished results nobody fetched (${peer.blob.tasks.filter((x) => x.unfetched).map((x) => x.task).join(', ')}); blob get them first or pass force (force keeps them on the volume unless purge_all)` };
      note(s, `stop requested by ${who.hostName || who.hostId.slice(0, 8)}${req.force ? ' (force)' : ''}`);
      const done = teardown(s, { reason: `stopped by ${who.hostName || who.hostId.slice(0, 8)}`, by: who.hostName || who.hostId, purgeAll: req.purgeAll === true }).catch((e) => { s.lastError = e.message; s.retryStop = { reason: 'stop retry', by: 'provisioner' }; });
      if (req.wait) await done;
      return { ok: true, note: req.wait ? 'stopped' : 'stopping: purging fetched task folders, then terminating. poll cloud_status', offer: publicOffer(offer) };
    }
    return { ok: false, error: 'cloud action must be status, up or down' };
  }
  return { snapshot, request, tick, offers: () => [...offers.keys()], close() { closed = true; }, _state: state };
}
