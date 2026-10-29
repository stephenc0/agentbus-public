import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { localLanRequest, initLan, loadLan, encodeJoinToken } from '../lib/lan.mjs';
import { startLan } from '../lib/lan-daemon.mjs';
import { createKnownHosts, shareKnownHosts, sanitizeSharedKnownHosts, SHARED_KNOWN_HOSTS_FEATURE } from '../lib/known-hosts.mjs';
import { summarizeNetworkPresence, formatHostStatuses } from '../lib/presence.mjs';
import { inviteText, join } from '../lib/wan.mjs';

const agent = (name) => ({ id: `claude:${crypto.randomUUID()}`, kind: 'claude', clientType: 'claude-code', model: 'm', modelSource: 'configured', name, status: 'idle' });
const sample = (user) => ({ current: () => ({ at: Date.now(), user, gpu: 'free', reasons: [], jobs: [], unclaimed: [] }), update: async () => {}, close() {} });
const usage = { current: () => ({ providers: { claude: { status: 'ok', observedAt: Date.now(), windows: [] } } }), update: async () => {} };

// a host A and a second machine B whose role is set (or not) only in B's own config
async function pair(t, { bRole } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-client-')), key = crypto.randomBytes(32);
  const mk = (name, extra) => { const dir = path.join(root, name, 'lan'); fs.mkdirSync(dir, { recursive: true }); return { hostId: crypto.randomUUID(), name, key, dir, port: 0, bind: '127.0.0.1', ...extra }; };
  const common = { mdns: false, allowLoopback: true, pollMs: 60000, log: () => {}, cloud: false, deliverLocal: async () => ({ ok: true, delivery: 'accepted' }) };
  const ca = mk('owner', { role: 'host' }), cb = mk('laptop', bRole ? { role: bRole } : {});
  const aAgent = agent('owner-worker'), bAgent = agent('laptop-worker');
  const A = await startLan({ ...common, config: ca, presence: sample('away'), usage, listLocal: () => [aAgent] });
  // the laptop's daemon is handed samplers anyway: as a client it must ignore them
  const B = await startLan({ ...common, config: cb, presence: sample('present'), usage, listLocal: () => [bAgent] });
  t.after(async () => { await Promise.all([A.close(), B.close()]); fs.rmSync(root, { recursive: true, force: true }); });
  const service = (cfg, d) => ({ txt: { v: '1', id: cfg.hostId }, port: d.port, addresses: ['127.0.0.1'] });
  A.discover(service(cb, B)); B.discover(service(ca, A));
  await Promise.all([A.refresh(), B.refresh()]); await Promise.all([A.refresh(), B.refresh()]);
  return { root, A, B, ca, cb, aAgent, bAgent, local: (name, frame) => localLanRequest(frame, { busDir: path.join(root, name) }) };
}

for (const [label, bRole] of [['by default (no role set)', undefined], ['with role "client"', 'client']]) {
  test(`a machine is a client ${label}: no presence or usage shared, no launches accepted, no presence coverage gap`, async (t) => {
    const p = await pair(t, { bRole });
    const status = await p.local('owner', { op: 'status' });
    const peer = status.peers.find((x) => x.hostId === p.cb.hostId);
    assert.equal(peer.role, 'client');
    assert.equal(peer.presence, null, 'no presence from a client');
    assert.equal(peer.usage, null, 'no account usage from a client');
    assert.equal(peer.launching.enabled, false); assert.equal(peer.launching.role, 'client');
    assert.equal(peer.agentCount, 1, 'its sessions stay reachable for replies');
    const own = await p.local('laptop', { op: 'status' });
    assert.equal(own.role, 'client'); assert.equal(own.presence, null); assert.equal(own.usage, null);
    const viaOwner = await p.local('owner', { op: 'spawn', host: 'laptop', from: p.aAgent.id, runtime: 'claude-code', cwd: '/x', prompt: 'x', id: crypto.randomUUID() });
    assert.match(viaOwner.error, /is a client: it accepts no session launches/);
    // the client never enters presence coverage, live or after it leaves
    assert.equal(status.knownHosts.find((h) => h.hostId === p.cb.hostId).role, undefined);
    const hosts = status.knownHosts.filter((h) => h.role === 'host');
    const summary = summarizeNetworkPresence({ local: { hostId: p.ca.hostId, presence: { at: Date.now(), user: 'away' } }, peers: [], knownHosts: hosts });
    assert.equal(summary.sources.length, 1); assert.equal(summary.hostCoverage, 'complete');
    const text = formatHostStatuses({ local: { name: 'owner', presence: null, usage: null, capabilities: null }, peers: [{ hostId: p.cb.hostId, name: 'laptop', role: 'client', presence: null }], lan: 'ok' });
    assert.match(text, /^laptop \[lan:[0-9a-f-]+\]: client \(submits work; shares no presence or usage, accepts no launches\)$/m);
  });
}

test('a machine that declares itself a host locally shares presence and usage and is remembered as a host', async (t) => {
  const p = await pair(t, { bRole: 'host' });
  const status = await p.local('owner', { op: 'status' });
  const peer = status.peers.find((x) => x.hostId === p.cb.hostId);
  assert.equal(peer.role, 'host');
  assert.equal(peer.presence.user, 'present'); assert.ok(peer.usage);
  assert.equal(status.knownHosts.find((h) => h.hostId === p.cb.hostId).role, 'host');
});

test('role persists in host history and travels with shared known hosts; anything else is dropped', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-kh-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'hosts.json'), id = crypto.randomUUID();
  const r = createKnownHosts(file);
  r.observe({ hostId: id, name: 'winbox', checkedAt: 1000, address: '192.168.1.20', role: 'host' });
  assert.deepEqual(createKnownHosts(file).snapshot(), [{ hostId: id, name: 'winbox', lastAuthenticatedAt: 1000, link: 'lan', role: 'host' }]);
  r.observe({ hostId: id, name: 'winbox', checkedAt: 1500, address: '192.168.1.20', role: 'client' });
  assert.equal('role' in createKnownHosts(file).snapshot()[0], false, 'a host that turns client re-saves at once');
  const build = { features: [SHARED_KNOWN_HOSTS_FEATURE] };
  const shared = sanitizeSharedKnownHosts({ build, knownHosts: shareKnownHosts([{ hostId: id, name: 'winbox', lastAuthenticatedAt: 5, role: 'host' }, { hostId: id, name: 'x', lastAuthenticatedAt: 5, role: 'admin' }]) });
  assert.deepEqual(shared.map((h) => h.role), ['host', undefined]);
});

test('lan join joins as a client unless --host (or AGENTBUS_ROLE=host from a host invite); the role is validated', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-cj-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.match(inviteText({ token: 'agentbus-join-v1:x', peers: [], repo: 'r', name: 'gpu-box', host: true }), /^AGENTBUS_ROLE=host$/m);
  assert.doesNotMatch(inviteText({ token: 'agentbus-join-v1:x', peers: [], repo: 'r', name: 'laptop' }), /AGENTBUS_ROLE/);
  initLan({ busDir: path.join(root, 'owner'), name: 'owner', port: 47800 });
  const oc = loadLan(path.join(root, 'owner'));
  const token = encodeJoinToken({ key: oc.key.toString('hex'), peers: [{ hostId: oc.hostId, name: 'owner', address: '100.90.0.4', port: 47800 }] });
  await join({ busDir: path.join(root, 'laptop'), token, name: 'laptop', bind: '100.70.0.9' });
  assert.equal(loadLan(path.join(root, 'laptop')).role, undefined, 'client by default');
  await join({ busDir: path.join(root, 'gpu'), token, name: 'gpu-box', bind: '100.70.0.10', role: 'host' });
  assert.equal(loadLan(path.join(root, 'gpu')).role, 'host');
  const cfg = path.join(root, 'laptop', 'lan', 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfg, 'utf8')), role: 'observer' }));
  assert.throws(() => loadLan(path.join(root, 'laptop')), /role must be "host" or "client"/);
});
