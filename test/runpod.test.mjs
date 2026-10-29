import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createBody, listRate, usage, billingLabel, parseArgs, runpodClient, main, DEFAULT_GPU } from '../scripts/runpod/pod.mjs';

test('create body: v2 shape, network volume mount, env without empties, required fields enforced', () => {
  const b = createBody({ name: 'runpod-h100', image: 'reg/agentbus-runpod:1', volumeId: 'vol1', cuda: ['13.0'], env: { A: 'x', TS_AUTHKEY: undefined, EMPTY: '' } });
  assert.deepEqual(b, { name: 'runpod-h100', image: 'reg/agentbus-runpod:1', gpu: { id: DEFAULT_GPU, count: 1, allowedCudaVersions: ['13.0'] }, cloud: 'SECURE', disk: 60, mounts: { network: [{ volumeId: 'vol1', path: '/workspace' }] }, env: { A: 'x' } });
  assert.equal(createBody({ name: 'p', templateId: 't', volumeId: 'v', dataCenterId: 'US-KS-2' }).dataCenterIds[0], 'US-KS-2');
  assert.throws(() => createBody({ name: 'bad name!', image: 'i', volumeId: 'v' }), /--name/);
  assert.throws(() => createBody({ name: 'p', volumeId: 'v' }), /--image/);
  assert.throws(() => createBody({ name: 'p', image: 'i' }), /--volume/);
  // a cuda floor, not an exact list: stock on 13.2 hosts must still place with "13.0"
  assert.deepEqual(createBody({ name: 'p', image: 'i', volumeId: 'v', minCuda: '13.0' }).gpu, { id: DEFAULT_GPU, count: 1, minCudaVersion: '13.0' });
  assert.throws(() => createBody({ name: 'p', image: 'i', volumeId: 'v', minCuda: '13.0', cuda: ['13.0'] }), /not both/);
  assert.throws(() => createBody({ name: 'p', image: 'i', volumeId: 'v', minCuda: '13' }), /major\.minor/);
  assert.equal('allowedCudaVersions' in createBody({ name: 'p', image: 'i', volumeId: 'v', cuda: [] }).gpu, false, 'an empty list sends no constraint');
});

test('rate: list price times count, unknown stays null; usage counts from creation', () => {
  const h100 = { id: DEFAULT_GPU, price: { secure: 2.69, community: 1.99 } };
  assert.equal(listRate(h100), 2.69); assert.equal(listRate(h100, { cloud: 'COMMUNITY', count: 2 }), 3.98);
  assert.equal(listRate(null), null); assert.equal(listRate({ price: {} }), null);
  assert.equal(billingLabel('SECURE'), 'runpod secure cloud on-demand');
  const created = '2026-10-28T10:00:00.000Z', now = Date.parse('2026-10-28T11:30:00.000Z');
  assert.deepEqual(usage({ createdAt: created, cost: 2.99 }, { now }), { hours: 1.5, ratePerHour: 2.99, estimateUsd: 4.49 });
  assert.deepEqual(usage({ createdAt: created }, { now, rate: 2 }), { hours: 1.5, ratePerHour: 2, estimateUsd: 3 });
  assert.deepEqual(usage({ createdAt: created }, { now }), { hours: 1.5, ratePerHour: null, estimateUsd: null });
  assert.deepEqual(parseArgs(['n', '--gpu', 'X', '--cuda', '13.0', '--cuda', '12.9', '--no-roundtrip']), { _: ['n'], gpu: 'X', cuda: ['13.0', '12.9'], 'no-roundtrip': true });
  assert.throws(() => parseArgs(['--gpu']), /needs a value/);
});

function fakeApi(t) {
  const calls = [], pods = new Map();
  const fetchImpl = async (url, init) => {
    const u = new URL(url), method = init.method;
    calls.push({ method, path: u.pathname, auth: init.headers.Authorization, body: init.body ? JSON.parse(init.body) : null });
    const reply = (status, json) => ({ status, ok: status >= 200 && status < 300, text: async () => (json === undefined ? '' : JSON.stringify(json)) });
    const m = /^\/v2\/pods\/([^/]+)$/.exec(u.pathname);
    if (method === 'DELETE' && m) { if (!pods.has(m[1])) return reply(404, { detail: 'pod not found' }); pods.delete(m[1]); return reply(204); }
    if (method === 'GET' && m) return pods.has(m[1]) ? reply(200, pods.get(m[1])) : reply(404, { detail: 'pod not found' });
    if (method === 'GET' && u.pathname === '/v2/pods') return reply(200, { pods: [...pods.values()], pagination: {} });
    return reply(400, { detail: 'unexpected' });
  };
  return { calls, pods, api: runpodClient({ key: 'rp_test', fetchImpl, base: 'https://api.example' }) };
}

test('down terminates, confirms the pod is gone, reports elapsed cost, clears the local record; a repeat down is safe', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-rp-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const prev = process.env.AGENTBUS_DIR; process.env.AGENTBUS_DIR = dir; t.after(() => { if (prev === undefined) delete process.env.AGENTBUS_DIR; else process.env.AGENTBUS_DIR = prev; });
  const { calls, pods, api } = fakeApi(t);
  const createdAt = new Date(Date.now() - 2 * 3.6e6).toISOString();
  pods.set('pod1', { id: 'pod1', name: 'runpod-h100', status: 'RUNNING', cost: 2.99, createdAt });
  fs.mkdirSync(path.join(dir, 'runpod'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'runpod', 'pod1.json'), JSON.stringify({ podId: 'pod1', name: 'runpod-h100', hostId: null, createdAt, ratePerHour: 2.99 }));
  const lines = [];
  const r = await main(['down', 'runpod-h100'], { api, log: (s) => lines.push(s) });
  assert.equal(r.ok, true); assert.equal(r.podId, 'pod1');
  assert.ok(Math.abs(r.usage.hours - 2) < 0.01); assert.equal(r.usage.ratePerHour, 2.99); assert.ok(Math.abs(r.usage.estimateUsd - 5.98) < 0.05);
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.path === '/v2/pods/pod1'));
  assert.ok(calls.every((c) => c.auth === 'Bearer rp_test'));
  assert.equal(fs.existsSync(path.join(dir, 'runpod', 'pod1.json')), false);
  assert.ok(lines.some((l) => /billed time 2(\.\d+)? h at \$2\.99\/h/.test(l)));
  const again = await main(['down', 'pod1'], { api, log: () => {} });
  assert.equal(again.ok, true, 'already gone (404) is a successful down');
  // status of a gone pod says so instead of throwing
  const st = await main(['status', 'pod1'], { api, log: () => {} });
  assert.equal(st[0].runpod, 'gone');
});

test('runpod client: no key is a clear error; api errors surface status and detail, never the key', async () => {
  assert.throws(() => runpodClient({ key: '' }), /RUNPOD_API_KEY/);
  const api = runpodClient({ key: 'rp_secret', base: 'https://x', fetchImpl: async () => ({ status: 400, ok: false, text: async () => JSON.stringify({ detail: 'no capacity' }) }) });
  await assert.rejects(api.createPod({}), (e) => /http 400 no capacity/.test(e.message) && !e.message.includes('rp_secret'));
});

test('pod scripts carry no secrets and start.sh passes shell syntax', () => {
  const dir = new URL('../scripts/runpod/', import.meta.url);
  for (const f of fs.readdirSync(dir)) {
    const text = fs.readFileSync(new URL(f, dir), 'utf8');
    assert.doesNotMatch(text, /tskey-(auth|client)-[A-Za-z0-9]{6,}/, f);
    assert.doesNotMatch(text, /agentbus-join-v1:[A-Za-z0-9_-]{20,}/, f);
    assert.doesNotMatch(text, /sk-ant-[A-Za-z0-9]/, f);
    assert.doesNotMatch(text, /rpa_[A-Za-z0-9]{10,}/, f);
  }
  execFileSync('bash', ['-n', fileURLToPath(new URL('start.sh', dir))]);
  // the image never takes files from the build context (a private checkout must not end up in a public image)
  const dockerfile = fs.readFileSync(new URL('Dockerfile', dir), 'utf8');
  assert.doesNotMatch(dockerfile, /^\s*(COPY|ADD)\s/m, 'no COPY/ADD from the build context');
  assert.match(dockerfile, /ARG AGENTBUS_REF\n/); assert.match(dockerfile, /refusing: AGENTBUS_REPO must be an https url/);
});
