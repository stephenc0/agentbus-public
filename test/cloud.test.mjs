import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { decodeJoinToken, localLanRequest } from '../lib/lan.mjs';
import { startLan } from '../lib/lan-daemon.mjs';
import { registerStorage } from '../lib/storage.mjs';
import { uploadFile, downloadFile } from '../lib/blob.mjs';
import { validateCloudConfig, readCloudSecrets, writeCloudSecrets, sanitizeCloud, formatOffer } from '../lib/cloud.mjs';
import { formatHostStatuses } from '../lib/presence.mjs';

const agent = (name) => ({ id: `claude:${crypto.randomUUID()}`, kind: 'claude', clientType: 'claude-code', model: 'm', modelSource: 'configured', name, status: 'idle' });
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
const until = async (what, fn, ms = 20000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 100)); } };

// provisioner (studio), requester (laptop) and a fake runpod whose createPod boots a third daemon from the pod env.
async function world(t, { idleMinutes = 10, relay = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-cloud-')), key = crypto.randomBytes(32);
  const common = { mdns: false, allowLoopback: true, pollMs: 200, log: () => {}, deliverLocal: async () => ({ ok: true, delivery: 'accepted' }) };
  const mk = (name, extra) => { const dir = path.join(root, name, 'lan'); fs.mkdirSync(dir, { recursive: true }); return { hostId: crypto.randomUUID(), name, key, dir, port: 0, bind: '127.0.0.1', peers: [], ...extra }; };
  const pods = new Map(), created = [], minted = [], revoked = [];
  const tailscale = { async mintAuthKey(o) { const k = { key: `tskey-auth-pod${minted.length + 1}-SECRET`, id: `kid${minted.length + 1}`, opts: o }; minted.push(k); return k; }, async revokeKey(id) { revoked.push(id); } };
  let failCreate = false;
  const api = {
    async gpuType() { return { id: 'NVIDIA H100 80GB HBM3', memory: 80, price: { secure: 2.5, community: 1.9 } }; },
    async createPod(body) {
      created.push(body);
      if (failCreate) throw Error('runpod create pod: http 400 no capacity');
      const { key: hex, peers } = decodeJoinToken(body.env.AGENTBUS_JOIN_TOKEN);
      const cfg = mk(body.name, { role: 'host', key: Buffer.from(hex, 'hex'), ephemeral: true, gpu_cost_per_hour: Number(body.env.AGENTBUS_GPU_COST_PER_HOUR), billing: body.env.AGENTBUS_BILLING });
      fs.writeFileSync(path.join(cfg.dir, 'config.json'), JSON.stringify({ role: 'host', hostId: cfg.hostId, name: cfg.name, port: 0, bind: '127.0.0.1', ephemeral: true, gpu_cost_per_hour: cfg.gpu_cost_per_hour, billing: cfg.billing, peers }));
      const share = path.join(root, 'volume', cfg.hostId); fs.mkdirSync(share, { recursive: true });
      registerStorage({ name: 'pod tasks', localPath: share, uri: 'smb://pod/agentbus-tasks', ownerHostId: cfg.hostId, create: true }, path.dirname(cfg.dir));
      const daemon = await startLan({ ...common, cloud: false, config: cfg, listLocal: () => [podAgent] });
      const id = `pod-${created.length}`;
      pods.set(id, { pod: { id, name: body.name, status: 'RUNNING', cost: 2.5, createdAt: new Date().toISOString() }, daemon, cfg, share });
      return { ...pods.get(id).pod, status: 'PROVISIONING' };
    },
    async getPod(id) { return pods.get(id)?.pod || null; },
    async terminatePod(id) { const p = pods.get(id); if (p) { await p.daemon.close(); pods.delete(id); } return { gone: true, status: p ? 204 : 404 }; },
  };
  const podAgent = agent('pod-worker'), macAgent = agent('mac-worker'), remoteAgent = agent('laptop-worker');
  const cloudConfig = validateCloudConfig({ idleMinutes, maxHours: 4, agentbusRef: 'a'.repeat(40), offers: [{ name: 'runpod-h100', image: 'reg/agentbus-runpod:1', volumeId: 'vol1', coldStartMinutes: 1, minCuda: '13.0', ratePerHour: 1.9 }] }); // a stale community price in config
  const ca = mk('studio', { port: await freePort() });
  const A = await startLan({ ...common, config: ca, listLocal: () => [macAgent], cloud: { api, cloudConfig, secrets: () => ({ RUNPOD_API_KEY: 'rp', TS_OAUTH_CLIENT_ID: 'cid', TS_OAUTH_CLIENT_SECRET: 'csecret' }), tailscale, overlay: () => ['127.0.0.1'], sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 100))), readyTimeoutMs: 20000 } });
  // relay: requester peers only with gpubox, gpubox with studio; requester must be introduced to the provisioner
  let D = null, cd = null;
  if (relay) {
    cd = mk('gpubox', { port: await freePort() });
    fs.writeFileSync(path.join(cd.dir, 'config.json'), JSON.stringify({ hostId: cd.hostId, name: 'gpubox', port: cd.port, bind: '127.0.0.1', peers: [{ hostId: ca.hostId, address: '127.0.0.1', port: ca.port, name: 'studio' }] }));
    D = await startLan({ ...common, cloud: false, config: cd, listLocal: () => [agent('gpubox-worker')] });
  }
  const cc = mk('laptop');
  const first = relay ? { hostId: cd.hostId, port: cd.port, name: 'gpubox' } : { hostId: ca.hostId, port: ca.port, name: 'studio' };
  fs.writeFileSync(path.join(cc.dir, 'config.json'), JSON.stringify({ hostId: cc.hostId, name: 'laptop', port: 0, bind: '127.0.0.1', peers: [{ ...first, address: '127.0.0.1' }] }));
  const C = await startLan({ ...common, cloud: false, config: cc, listLocal: () => [remoteAgent] });
  t.after(async () => { for (const p of pods.values()) await p.daemon.close(); await Promise.all([A.close(), C.close(), D?.close()]); fs.rmSync(root, { recursive: true, force: true }); });
  const requester = (frame) => localLanRequest(frame, { busDir: path.join(root, 'laptop'), timeout: 35000 });
  await until('requester and mac to authenticate each other', () => { const p = C.peers.get(ca.hostId); return p && !p.error && p.reachBack; });
  return { root, A, C, D, ca, cc, cd, api, pods, created, minted, revoked, failCreate: (v) => { failCreate = v; }, cloudConfig, requester, remoteAgent };
}

test('cloud config, secrets and inventory are validated; secrets never leave the provisioner', (t) => {
  assert.throws(() => validateCloudConfig({ offers: [] }), /1-8 offers/);
  assert.throws(() => validateCloudConfig({ offers: [{ name: 'x' }] }), /image or templateId/);
  assert.throws(() => validateCloudConfig({ offers: [{ name: 'x', image: 'i' }] }), /volumeId/);
  assert.throws(() => validateCloudConfig({ maxHours: -1, offers: [{ name: 'x', image: 'i', volumeId: 'v' }] }), /maxHours/);
  assert.throws(() => validateCloudConfig({ offers: [{ name: 'x', image: 'i', volumeId: 'v', minCuda: '13.0', cuda: ['13.0'] }] }), /exclusive/);
  assert.throws(() => validateCloudConfig({ offers: [{ name: 'x', image: 'i', volumeId: 'v', minCuda: 'thirteen' }] }), /major\.minor/);
  for (const ref of ['main', 'deploy/studio', 'abc123', 'v']) assert.throws(() => validateCloudConfig({ agentbusRef: ref, offers: [{ name: 'x', image: 'i', volumeId: 'v' }] }), /agentbusRef/, ref);
  assert.equal(validateCloudConfig({ agentbusRef: 'v0.6.1', offers: [{ name: 'x', image: 'i', volumeId: 'v' }] }).agentbusRef, 'v0.6.1');
  assert.throws(() => validateCloudConfig({ agentbusRepo: 'git@github.com:x/y.git', offers: [{ name: 'x', image: 'i', volumeId: 'v' }] }), /https/);
  const c = validateCloudConfig({ offers: [{ name: 'runpod-h100', image: 'i', volumeId: 'v' }] });
  assert.equal(c.idleMinutes, 15); assert.equal(c.maxHours, 8); assert.equal(c.offers[0].cloud, 'SECURE');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-cs-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(writeCloudSecrets(dir, { RUNPOD_API_KEY: 'rp1', TS_AUTHKEY: 'ts1', NOT_A_SECRET: 'x' }).sort(), ['RUNPOD_API_KEY', 'TS_AUTHKEY']);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'cloud', 'secrets.json')).mode & 0o777, 0o600);
  assert.deepEqual(readCloudSecrets(dir, {}), { RUNPOD_API_KEY: 'rp1', TS_AUTHKEY: 'ts1' });
  assert.equal(readCloudSecrets(dir, { RUNPOD_API_KEY: 'env' }).RUNPOD_API_KEY, 'env', 'env wins');
  if (process.platform !== 'win32') { fs.chmodSync(path.join(dir, 'cloud', 'secrets.json'), 0o644); assert.throws(() => readCloudSecrets(dir, {}), /owner/); }
  const s = sanitizeCloud({ provisionerHostId: crypto.randomUUID(), offers: [{ name: 'runpod-h100', state: 'evil', gpu: 'H100', ratePerHour: 2.5, RUNPOD_API_KEY: 'leak', pod: { hostId: crypto.randomUUID(), address: '8.8.8.8', port: 1 } }] });
  assert.equal(s.offers[0].state, 'dormant'); assert.equal(s.offers[0].pod.address, null, 'only tailscale/loopback pod addresses pass');
  assert(!JSON.stringify(s).includes('leak'));
  assert.match(formatOffer({ ...s.offers[0], gpuMemoryMiB: 81559, coldStartMinutes: 9, maxHours: 8 }, 'studio'), /^runpod-h100: offer on studio, dormant, 81559MiB cuda \(H100\), \$2\.5\/h, cold start ~9 min/);
});

test('a peer starts a pod through the provisioner, reaches it directly, and idle shutdown waits for fetched results then purges them', { timeout: 90000 }, async (t) => {
  const w = await world(t, { relay: true });
  // the requester was configured with gpubox only; gpubox introduced the provisioner, and the requester saved it
  await until('introduced provisioner saved as a static peer', () => JSON.parse(fs.readFileSync(path.join(w.cc.dir, 'config.json'), 'utf8')).peers.some((p) => p.hostId === w.ca.hostId && p.name === 'studio'));
  const offerOf = async () => (await w.requester({ op: 'cloud', action: 'status' })).provisioners?.[0]?.offers?.[0];
  // dormant offer visible to the requester, with its price
  const dormant = await until('offer listed', offerOf);
  assert.equal(dormant.state, 'dormant'); assert.equal(dormant.name, 'runpod-h100');
  assert.equal((await until('catalog price', async () => { const o = await offerOf(); return o?.ratePerHour === 2.5 && o; })).ratePerHour, 2.5, 'dormant offers show the current secure price, refreshed at startup');
  // cost acknowledgement required, and only live agents may provision
  assert.match((await w.requester({ op: 'cloud', action: 'up', offer: 'runpod-h100', from: w.remoteAgent.id })).error, /max_hours or max_usd/);
  assert.match((await w.requester({ op: 'cloud', action: 'up', offer: 'runpod-h100', maxHours: 1, from: `claude:${crypto.randomUUID()}` })).error, /live local agent/);
  const up = await w.requester({ op: 'cloud', action: 'up', offer: 'runpod-h100', maxUsd: 5, from: w.remoteAgent.id });
  assert.equal(up.ok, true, up.error); assert.equal(up.started, true); assert.equal(up.provisioner, 'studio');
  assert.equal(w.created.length, 1);
  const env = w.created[0].env;
  assert.equal(env.AGENTBUS_REF, 'a'.repeat(40), 'pods are pinned to the provisioner\'s agentbus release');
  assert.equal(env.AGENTBUS_NAME, 'runpod-h100'); assert.equal(env.AGENTBUS_GPU_COST_PER_HOUR, '2.5', 'the live secure catalog price, not the configured one');
  assert.deepEqual(w.created[0].gpu, { id: 'NVIDIA H100 80GB HBM3', count: 1, minCudaVersion: '13.0' }, 'a cuda floor, never an exact pin'); assert.equal(env.TS_AUTHKEY, 'tskey-auth-pod1-SECRET', 'a fresh minted key per pod');
  assert.deepEqual(w.minted[0].opts.tags, ['tag:agentbus-gpu']); assert.ok(w.minted[0].opts.expirySeconds >= 900 && w.minted[0].opts.expirySeconds <= 3600, 'short expiry');
  const stopAt = Number(env.AGENTBUS_HARD_STOP_AT) * 1000;
  assert.ok(stopAt > Date.now() + 2 * 3.6e6 && stopAt < Date.now() + 2 * 3.6e6 + 11 * 60000, 'pod backstop = hard cap + 10 min grace');
  assert.deepEqual(decodeJoinToken(env.AGENTBUS_JOIN_TOKEN).peers.map((p) => p.hostId), [w.ca.hostId], 'pods dial the provisioner');
  const live = await until('pod live', async () => { const o = await offerOf(); return o?.state === 'live' && o.fromHere?.authenticated && o.fromHere.reachBack && o; }, 30000);
  assert.equal(live.startedBy.hostName, 'laptop'); assert.equal(live.startedBy.agentId, w.remoteAgent.id);
  assert.ok(live.capUntil - Date.now() <= 2 * 3.6e6 + 1000, '$5 at $2.5/h caps the pod at 2 h');
  assert.ok(live.progress.some((l) => /blob roundtrip/.test(l)), 'lan doctor checks ran before live');
  assert.ok(live.progress.some((l) => /agentbus build: \w{8} on both/.test(l)), 'the pod build is compared with the provisioner build');
  assert.ok(live.progress.some((l) => /minted a single-use ephemeral tailscale key/.test(l)));
  const persisted = fs.readFileSync(path.join(w.root, 'studio', 'cloud', 'state.json'), 'utf8');
  assert.ok(!persisted.includes('SECRET') && !JSON.stringify(live).includes('SECRET'), 'the minted key is never persisted or published');
  // a second request shares the live pod, no second create
  const again = await w.requester({ op: 'cloud', action: 'up', offer: 'runpod-h100', maxHours: 1, from: w.remoteAgent.id });
  assert.equal(again.joined, true); assert.equal(w.created.length, 1);
  // host_status text shows the offer
  const status = await localLanRequest({ op: 'status' }, { busDir: path.join(w.root, 'laptop') });
  const text = formatHostStatuses({ local: { name: 'laptop', presence: null, usage: null, capabilities: null }, peers: status.peers.filter((p) => !p.error).map((p) => ({ ...p, presence: null, usage: null })), lan: 'ok' });
  assert.match(text, /^runpod-h100: offer on studio, live, \d+MiB~? cuda \(NVIDIA H100 80GB HBM3\), \$2\.5\/h, live as peer runpod-h100 \(started by laptop\), hard stop in \d+ min/m);
  assert.match(text, /^runpod-h100 hardware: .*\$2\.5\/h runpod secure cloud on-demand$/m, 'the live pod is also a normal peer with its own cost');
  // requester talks to the pod directly: upload inputs, the job writes results
  const podPeer = w.C.peers.get(live.pod.hostId);
  const src = path.join(w.root, 'input.fasta'); fs.writeFileSync(src, '>p\nMKV\n');
  const task = crypto.randomUUID();
  await uploadFile(w.cc, podPeer, { task, name: 'input.fasta', file: src });
  const pod = [...w.pods.values()][0];
  const outDir = path.join(pod.share, 'tasks', task, 'out'); fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'model.pdb'), 'ATOM'); fs.writeFileSync(path.join(outDir, 'SUMMARY.md'), 'status: succeeded\n');
  const ownerMeta = JSON.parse(fs.readFileSync(path.join(pod.share, 'tasks', task, '.agentbus-task.json'), 'utf8'));
  assert.equal(ownerMeta.ownerHostId, w.cc.hostId, 'the pod records who uploaded the task');
  await until('provisioner to see unfetched results', () => w.A.peers.get(live.pod.hostId)?.blob?.tasks?.some((x) => x.task === task && x.unfetched));
  // idle rule now short: unfetched results keep the pod alive, and a plain cloud_down refuses
  w.cloudConfig.idleMinutes = 0.02;
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal((await offerOf()).state, 'live', 'not stopped while results are unfetched');
  assert.match((await w.requester({ op: 'cloud', action: 'down', offer: 'runpod-h100', from: w.remoteAgent.id })).error, /nobody fetched/);
  // requester fetches out/ directly from the pod; then the pod goes idle, its task folder is purged, and it is terminated
  for (const name of ['model.pdb', 'SUMMARY.md']) await downloadFile(w.cc, podPeer, { task, area: 'out', name, dest: path.join(w.root, 'results', name) });
  const stopped = await until('idle shutdown', async () => { const o = await offerOf(); return o?.state === 'dormant' && o.last && o; }, 30000);
  assert.match(stopped.last.reason, /idle/); assert.equal(stopped.last.startedBy, 'laptop');
  assert.equal(fs.existsSync(path.join(pod.share, 'tasks', task)), false, 'fetched task folder purged from the volume before terminate');
  assert.equal(w.pods.size, 0, 'pod terminated at the provider');
  assert.deepEqual(stopped.keptTasks, []);
  await until('requester to drop the dead pod', () => !w.C.peers.get(live.pod.hostId) || w.C.peers.get(live.pod.hostId).error);
  const known = await localLanRequest({ op: 'status' }, { busDir: path.join(w.root, 'studio') });
  assert.equal(known.knownHosts.some((h) => h.hostId === live.pod.hostId), false, 'an ephemeral pod never enters host history');
});

test('the hard cap terminates a busy pod; cloud_down with force stops it and keeps unfetched results on the volume', { timeout: 90000 }, async (t) => {
  const w = await world(t);
  const offerOf = async () => (await w.requester({ op: 'cloud', action: 'status' })).provisioners?.[0]?.offers?.[0];
  await until('offer', offerOf);
  assert.equal((await w.requester({ op: 'cloud', action: 'up', offer: 'runpod-h100', maxHours: 0.003, from: w.remoteAgent.id })).ok, true); // ~11 s
  const live = await until('live', async () => { const o = await offerOf(); return o?.state === 'live' && o; }, 30000);
  const pod = [...w.pods.values()][0], task = crypto.randomUUID();
  const outDir = path.join(pod.share, 'tasks', task, 'out'); fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, 'SUMMARY.md'), 'status: succeeded\n');
  const stopped = await until('cap shutdown', async () => { const o = await offerOf(); return o?.state === 'dormant' && o.last && o; }, 40000);
  assert.match(stopped.last.reason, /hard time cap/);
  assert.deepEqual(stopped.keptTasks, [task], 'unfetched results are kept, not destroyed');
  assert.ok(fs.existsSync(path.join(pod.share, 'tasks', task, 'out', 'SUMMARY.md')));
  assert.equal(w.pods.size, 0);
  // start again and force it down
  assert.equal((await w.requester({ op: 'cloud', action: 'up', offer: 'runpod-h100', maxHours: 1, from: w.remoteAgent.id })).ok, true);
  await until('live again', async () => (await offerOf())?.state === 'live', 30000);
  const down = await w.requester({ op: 'cloud', action: 'down', offer: 'runpod-h100', force: true, from: w.remoteAgent.id });
  assert.equal(down.ok, true, down.error);
  const after = await until('forced down', async () => { const o = await offerOf(); return o?.state === 'dormant' && o; }, 30000);
  assert.match(after.last.reason, /stopped by laptop/); assert.equal(after.last.stoppedBy, 'laptop');
  assert.equal(w.pods.size, 0); assert.equal(w.created.length, 2);
});

test('an introduced provisioner is saved as a static peer: with the introducing host down, the requester still starts and reaches a pod', { timeout: 90000 }, async (t) => {
  const w = await world(t, { relay: true });
  const cfgFile = path.join(w.cc.dir, 'config.json');
  await until('introduction persisted', () => JSON.parse(fs.readFileSync(cfgFile, 'utf8')).peers.some((p) => p.hostId === w.ca.hostId));
  await w.D.close(); // gpubox off (rebooting, gaming)
  await until('requester dials the provisioner as a static peer', () => { const p = w.C.peers.get(w.ca.hostId); return p?.static && !p.error && p.checkedAt > Date.now() - 2000; });
  const offerOf = async () => (await w.requester({ op: 'cloud', action: 'status' })).provisioners?.[0]?.offers?.[0];
  assert.equal((await w.requester({ op: 'cloud', action: 'up', offer: 'runpod-h100', maxHours: 1, from: w.remoteAgent.id })).ok, true);
  const live = await until('pod live and reached directly', async () => { const o = await offerOf(); return o?.state === 'live' && o.fromHere?.authenticated && o.fromHere.reachBack && o; }, 30000);
  const k = w.C.peers.get(w.cd.hostId);
  assert.ok(!k || k.error, 'gpubox is down, so it is in no path');
  const src = path.join(w.root, 'in.bin'); fs.writeFileSync(src, 'x');
  await uploadFile(w.cc, w.C.peers.get(live.pod.hostId), { task: crypto.randomUUID(), name: 'in.bin', file: src });
  assert.equal((await w.requester({ op: 'cloud', action: 'down', offer: 'runpod-h100', from: w.remoteAgent.id })).ok, true);
  await until('dormant', async () => (await offerOf())?.state === 'dormant', 30000);
});

test('a failed start revokes the unused minted tailscale key and returns the offer to dormant', { timeout: 60000 }, async (t) => {
  const w = await world(t);
  w.failCreate(true);
  const offerOf = async () => (await w.requester({ op: 'cloud', action: 'status' })).provisioners?.[0]?.offers?.[0];
  await until('offer', offerOf);
  assert.equal((await w.requester({ op: 'cloud', action: 'up', offer: 'runpod-h100', maxHours: 1, from: w.remoteAgent.id })).ok, true);
  const o = await until('dormant after failure', async () => { const x = await offerOf(); return x?.state === 'dormant' && x.last && x; });
  assert.match(o.lastError, /no capacity/);
  assert.deepEqual(w.revoked, ['kid1']);
});
