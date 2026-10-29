import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Bonjour } from 'bonjour-service';
import { execFileSync } from 'node:child_process';
import { initLan, loadLan, remoteId, parseRemoteId, privateIPv4, localLanRequest, peerRequest, ownerOnly, resolveMdnsInterface } from '../lib/lan.mjs';
import { startLan, discoveryPeer } from '../lib/lan-daemon.mjs';
import { presenceTracker } from '../lib/presence.mjs';
import { registerStorage } from '../lib/storage.mjs';

const aid = () => `codex:${crypto.randomUUID()}`;
const agent = (name) => ({ id: aid(), kind: 'codex', clientType: 'codex', model: 'test-model', modelSource: 'configured', name, status: 'idle', cwd: '/private/project', last: 'private transcript', socket: '/private/socket' });
async function pair(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-lan-'));
  const key = crypto.randomBytes(32), a = agent('worker'), b = agent('worker'), receivedA = [], receivedB = [];
  const config = (name) => ({ role: 'host', hostId: crypto.randomUUID(), name, key, dir: path.join(root, name, 'lan'), port: 0, bind: options.mdns ? '0.0.0.0' : '127.0.0.1' });
  const ca = config('a'), cb = config('b');
  if (options.sms) { ca.smsPrimary = ca.hostId; cb.smsPrimary = ca.hostId; }
  let liveB = [b];
  const common = { mdns: false, tailnet: false, allowLoopback: true, pollMs: 60000, log: () => {} };
  const A = await startLan({ ...common, ...options, presence: options.presenceFor?.('a') ?? null, config: ca, listLocal: () => [a], deliverLocal: async (...args) => { receivedA.push(args); return { ok: true, delivery: 'accepted' }; } });
  const B = await startLan({ ...common, ...options, presence: options.presenceFor?.('b') ?? null, config: cb, listLocal: () => liveB, deliverLocal: async (...args) => { receivedB.push(args); return { ok: true, delivery: 'queued', recovery_file: '/secret/file' }; } });
  const service = (cfg, daemon) => ({ txt: { v: '1', id: cfg.hostId }, name: 'untrusted-name', port: daemon.port, addresses: ['127.0.0.1'] });
  t.after(async () => { await Promise.all([A.close(), B.close()]); fs.rmSync(root, { recursive: true, force: true }); });
  A.discover(service(cb, B)); B.discover(service(ca, A));
  await Promise.all([A.refresh(), B.refresh()]);
  return { root, A, B, ca, cb, a, b, receivedA, receivedB, service, stopAgent: () => { liveB = []; }, local: (name, frame) => localLanRequest(frame, { busDir: path.join(root, name) }) };
}

test('pairing config protects secrets and uses a stable host id', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-key-'));
  try {
    const first = initLan({ busDir: path.join(root, 'a'), name: 'alpha' });
    const second = initLan({ busDir: path.join(root, 'b'), name: 'beta', keyFile: first.keyFile });
    assert.notEqual(first.hostId, second.hostId);
    assert.deepEqual(loadLan(path.join(root, 'a')).key, loadLan(path.join(root, 'b')).key);
    if (process.platform === 'win32') {
      assert(ownerOnly(first.keyFile));
      execFileSync('icacls', [second.keyFile, '/grant', '*S-1-1-0:R']); // Everyone
      assert.throws(() => loadLan(path.join(root, 'b')), /owner-only/);
    } else assert.equal(fs.statSync(first.keyFile).mode & 0o777, 0o600);
    assert(!JSON.stringify(first).includes(loadLan(path.join(root, 'a')).key.toString('hex')));
    assert.throws(() => initLan({ busDir: path.join(root, 'a') }), /already initialized/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('mdns interface resolves adapter names past virtual switches and link-local addresses', () => {
  const ifs = { 'vEthernet (Default Switch)': [{ family: 'IPv4', address: '172.20.112.1', internal: false }], Ethernet: [{ family: 'IPv6', address: 'fe80::1', internal: false }, { family: 'IPv4', address: '169.254.9.9', internal: false }, { family: 'IPv4', address: '192.168.1.10', internal: false }] };
  assert.equal(resolveMdnsInterface('Ethernet', ifs), '192.168.1.10');
  assert.equal(resolveMdnsInterface('192.168.1.5', ifs), '192.168.1.5');
  assert.equal(resolveMdnsInterface('8.8.8.8', ifs), undefined);
  assert.equal(resolveMdnsInterface('Missing', ifs), undefined);
  assert.equal(resolveMdnsInterface(undefined, ifs), undefined);
});

test('discovery rejects wrong protocol, own host, public addresses and malformed identities', () => {
  const self = crypto.randomUUID(), other = crypto.randomUUID();
  const s = { txt: { v: '1', id: other }, addresses: ['192.168.1.20'], port: 5555 };
  assert.equal(discoveryPeer(s, self).address, '192.168.1.20');
  assert.equal(discoveryPeer(s, other), null);
  assert.equal(discoveryPeer({ ...s, txt: { ...s.txt, v: '2' } }, self), null);
  assert.equal(discoveryPeer({ ...s, addresses: ['8.8.8.8', '127.0.0.1'] }, self), null);
  assert.equal(discoveryPeer({ ...s, txt: { v: '1', id: '../escape' } }, self), null);
  assert.equal(discoveryPeer({ ...s, name: `agentbus-${other}` }, self).name, null, 'the unauthenticated mdns service name is never a display name');
  assert.equal(privateIPv4('172.32.0.1'), false);
  assert(parseRemoteId(remoteId(other, aid())));
  assert.equal(parseRemoteId('lan:host/../../anything'), null);
});

test('authenticated discovery and bidirectional delivery preserve reply addressing and delivery state', async (t) => {
  const p = await pair(t);
  const inventory = await p.local('a', { op: 'list' });
  assert.equal(inventory.agents.length, 1);
  assert.equal(inventory.agents[0].name, 'worker@b');
  assert.equal(inventory.agents[0].cwd, undefined);
  assert.equal(inventory.agents[0].last, undefined);
  assert.equal(inventory.agents[0].socket, undefined);
  assert.equal(inventory.agents[0].model, 'test-model');
  assert.equal(inventory.agents[0].clientType, 'codex');
  const status = await p.local('a', { op: 'status' });
  assert(status.capabilities.cpu.logicalCores > 0);
  assert(status.peers[0].capabilities.os.type);
  const result = await p.local('a', { op: 'send', id: crypto.randomUUID(), to: inventory.agents[0].id, from: p.a.id, message: 'coordinate with me' });
  assert.equal(result.delivery, 'queued');
  assert.equal(result.recovery_file, undefined);
  assert.equal(p.receivedB.length, 1);
  const from = p.receivedB[0][1];
  assert.equal(from.id, remoteId(p.ca.hostId, p.a.id));
  assert.equal(from.socket, undefined);
  const reply = await p.local('b', { op: 'send', id: crypto.randomUUID(), to: from.id, from: p.b.id, message: 'agreed' });
  assert.equal(reply.delivery, 'accepted');
  assert.equal(p.receivedA[0][2], 'agreed');
});

test('LAN spawn qualifies sender and returned session, advertises launch support, and rejects unknown actors', async (t) => {
  const launches = [], id = crypto.randomUUID(), spawned = aid();
  const p = await pair(t, { launcher: {
    capabilities: () => ({ enabled: true, remote: true, runtimes: { codex: true } }),
    launch: (request, source) => { launches.push({ request, source }); return { ok: true, requestId: request.id, agentId: spawned, state: 'starting', routable: false }; },
    status: (requestId) => ({ ok: true, requestId, agentId: spawned, state: 'running', routable: true }),
  } });
  const status = await p.local('a', { op: 'status' });
  assert.equal(status.peers[0].launching.runtimes.codex, true);
  const request = { op: 'spawn', id, host: 'b', from: p.a.id, runtime: 'codex', cwd: '/destination', prompt: 'test' };
  const result = await p.local('a', request);
  assert.equal(result.agentId, remoteId(p.cb.hostId, spawned));
  assert.equal(launches[0].source, p.ca.hostId + '/' + p.a.id);
  assert.equal((await p.local('a', { ...request, from: aid() })).ok, false);
  assert.equal((await peerRequest(p.ca, { hostId: p.cb.hostId, address: '127.0.0.1', port: p.B.port }, { ...request, from: aid() })).ok, false);
  const receipt = await p.local('a', { op: 'spawn-status', id, host: p.cb.hostId, from: p.a.id });
  assert.equal(receipt.routable, true);
});

test('authenticated storage inventory maps paths to hosts and withdraws lost volumes', async (t) => {
  const p = await pair(t);
  const volume = path.join(p.root, 'tasks'); fs.mkdirSync(volume);
  const entry = registerStorage({ name: 'tasks', localPath: volume, uri: 'smb://b/tasks', ownerHostId: p.cb.hostId, create: true }, path.join(p.root, 'b'));
  await p.B.refresh(); await p.A.refresh();
  const inventory = await p.local('a', { op: 'list' });
  assert.equal(inventory.agents[0].hostStorage[0].id, entry.id);
  assert.equal(inventory.agents[0].hostStorage[0].localPath, volume);
  assert.equal(inventory.agents[0].hostStorage[0].status, 'available');
  const local = await p.local('a', { op: 'status' }); assert.deepEqual(local.storage, []);
  fs.renameSync(volume, volume + '-disconnected');
  await p.B.refresh(); await p.A.refresh();
  assert.equal((await p.local('a', { op: 'list' })).agents[0].hostStorage[0].status, 'unavailable');
});

test('peers carry sanitized host presence over the authenticated channel', async (t) => {
  const raw = { a: { userIdleSec: 3, fullscreen: false, gpuUtil: 2 }, b: { userIdleSec: 0, fullscreen: true, fullscreenApp: 'Game\u0007.exe', shellState: 'busy', fullscreenBasis: 'foreground-monitor', foreground: 'Game', foregroundPid: 123, foregroundCoversMonitor: true, probeObservedAt: Date.now(), gpuUtil: 95, wsl: true } };
  const job = { id: '2b8e6f14-9c3d-4a7e-b5f2-0d1c6a9e4b83', name: 'colabfold\u0007 demo', runtime: 'claude-code', source: 'b29c1927-9f56-4f94-845f-4b53a2fa231b', sourceName: 'laptop', since: 1, claims: ['gpu', 'NOPE'] };
  const p = await pair(t, { presenceFor: (name) => presenceTracker({ sampler: { sample: async () => raw[name], close() {} }, dir: fs.mkdtempSync(path.join(os.tmpdir(), `ab-pres-${name}-`)), jobs: () => name === 'b' ? [job] : [] }) });
  await Promise.all([p.A.refresh(), p.B.refresh()]); // second round: each side now has a sample to serve
  const status = await p.local('a', { op: 'status' });
  assert.equal(status.presence.gpu, 'shared');
  assert.equal(status.presence.compute, false); assert.deepEqual(status.presence.jobs, []);
  assert.equal(status.peers[0].presence.compute, true); assert.equal(status.peers[0].presence.wsl, true);
  assert.deepEqual(status.peers[0].presence.jobs, [{ id: job.id, name: 'colabfold  demo', runtime: 'claude-code', source: job.source, sourceName: 'laptop', sourceAgent: null, agentId: null, since: 1, claims: ['gpu'] }]);
  assert.match(status.peers[0].presence.reasons.join(';'), /compute job: colabfold  demo \[gpu\] for laptop/);
  assert.equal(status.peers[0].presence.gpu, 'avoid');
  assert.equal(status.peers[0].presence.user, 'busy');
  assert.equal(status.peers[0].presence.fullscreenApp, 'Game .exe');
  assert.equal(status.peers[0].presence.shellState, 'busy');
  assert.equal(status.peers[0].presence.foregroundCoversMonitor, true);
  assert.equal(status.peers[0].presence.foregroundPid, 123);
  assert.equal(status.peers[0].presence.fullscreenBasis, 'foreground-monitor');
  assert.equal(status.peers[0].presence.raw, undefined);
  const inventory = await p.local('a', { op: 'list' });
  assert.equal(inventory.agents[0].hostPresence.gpu, 'avoid');
  // the peer leaves (sleep, walked off the lan): status stops reporting its last sample as current presence
  const sampledAt = status.peers[0].presence.at;
  await p.B.close();
  await p.A.refresh();
  const after = await p.local('a', { op: 'status' });
  assert.ok(after.peers[0].error, 'peer is unreachable');
  assert.equal(after.peers[0].presence, null, 'no stale presence replayed');
  assert.equal(after.peers[0].lastPresenceAt, sampledAt, 'only the time of the last sample remains');
});

test('wrong pairing keys fail before listing or sending', async (t) => {
  const p = await pair(t), bad = { ...p.ca, key: crypto.randomBytes(32) };
  const result = await peerRequest(bad, { address: '127.0.0.1', port: p.B.port, hostId: p.cb.hostId }, { op: 'agents' }, 1000);
  assert.equal(result.ok, false);
  assert.equal(result.delivery, 'unavailable');
  assert.equal(p.receivedB.length, 0);
});

test('duplicate send is delivered once and id reuse with changed content is rejected', async (t) => {
  const p = await pair(t);
  const frame = { op: 'send', id: crypto.randomUUID(), to: remoteId(p.cb.hostId, p.b.id), from: p.a.id, message: 'one time' };
  const results = await Promise.all([p.local('a', frame), p.local('a', frame)]);
  assert(results.every((r) => r.ok)); assert.equal(p.receivedB.length, 1);
  assert.equal((await p.local('a', frame)).ok, true); assert.equal(p.receivedB.length, 1);
  assert.equal((await p.local('a', { ...frame, message: 'different' })).ok, false);
  assert.equal(p.receivedB.length, 1);
});

test('peer loss clears inventory and stale agent ids are not delivered', async (t) => {
  const p = await pair(t);
  p.stopAgent();
  const missing = await p.local('a', { op: 'send', id: crypto.randomUUID(), to: remoteId(p.cb.hostId, p.b.id), from: p.a.id, message: 'late' });
  assert.equal(missing.delivery, 'unavailable'); assert.equal(p.receivedB.length, 0);
  p.A.forget(p.service(p.cb, p.B));
  assert.equal((await p.local('a', { op: 'list' })).agents.length, 0);
  assert.equal((await p.local('a', { op: 'send', id: crypto.randomUUID(), to: remoteId(p.cb.hostId, p.b.id), from: p.a.id, message: 'offline' })).delivery, 'unavailable');
});

test('network API cannot relay to a third host or accept forged socket paths', async (t) => {
  const p = await pair(t);
  const peer = { address: '127.0.0.1', port: p.B.port, hostId: p.cb.hostId };
  const result = await peerRequest(p.ca, peer, { op: 'send', id: crypto.randomUUID(), to: remoteId(p.ca.hostId, p.a.id), from: { id: p.a.id, socket: '/tmp/evil' }, message: 'relay' });
  assert.equal(result.ok, false); assert.equal(p.receivedB.length, 0);
  const forged = await p.local('a', { op: 'send', id: crypto.randomUUID(), to: remoteId(p.cb.hostId, p.b.id), from: aid(), message: 'forged' });
  assert.equal(forged.ok, false);
});

test('real multicast discovery authenticates two isolated test daemons', { skip: !process.env.AGENTBUS_TEST_MDNS, timeout: 15000 }, async (t) => {
  const p = await pair(t, { mdns: true, pollMs: 500 });
  const volume = path.join(p.root, 'mdns-tasks'); fs.mkdirSync(volume);
  const entry = registerStorage({ name: 'tasks', localPath: volume, uri: 'smb://b/tasks', ownerHostId: p.cb.hostId, create: true }, path.join(p.root, 'b'));
  // Discard synthetic discovery. Only actual Bonjour announcements can repopulate.
  p.A.peers.clear(); p.B.peers.clear();
  const browserOwner = new Bonjour({}, () => {});
  const seen = [];
  const browse = browserOwner.find({ type: 'agentbus-agent', protocol: 'tcp' }, (s) => { if (s.txt.host === p.cb.hostId) seen.push(s); });
  const stores = [];
  const storageBrowse = browserOwner.find({ type: 'agentbus-store', protocol: 'tcp' }, (s) => { if (s.txt.host === p.cb.hostId) stores.push(s); });
  t.after(() => { browse.stop(); storageBrowse.stop(); browserOwner.destroy(); });
  const until = Date.now() + 10000;
  let inventory;
  do { await new Promise((r) => setTimeout(r, 250)); inventory = await p.local('a', { op: 'list' }); } while ((!inventory.agents.length || !seen.length || !stores.length) && Date.now() < until);
  assert.equal(inventory.agents[0]?.id, remoteId(p.cb.hostId, p.b.id));
  assert.equal(seen[0]?.txt.type, 'codex');
  assert.equal(seen[0]?.txt.model, 'test-model');
  assert.equal(seen[0]?.txt.model_source, 'configured');
  assert.equal(stores[0]?.txt.id, entry.id);
  assert.equal(stores[0]?.txt.state, 'available');
  assert.equal(stores[0]?.txt.localPath, undefined);
  assert.equal(stores[0]?.txt.uri, undefined);
});

test('sms uses the pinned primary, qualifies ownership and fails closed on primary loss', async (t) => {
  const calls = [];
  const p = await pair(t, { sms: true, smsCall: async (...args) => { calls.push(args); return { status: 200, body: { ok: true } }; } });
  const lockPath = '/locks/%2B15555550100';
  const result = await p.local('b', { op: 'sms', method: 'PUT', path: lockPath, agent: p.b.id, body: { holder: 'forged', ttlSeconds: 60 } });
  assert.equal(result.response.status, 200);
  assert.equal(calls[0][2].holder, remoteId(p.cb.hostId, p.b.id));
  const denied = await p.local('b', { op: 'sms', method: 'DELETE', path: lockPath, agent: p.b.id, body: { force: true } });
  assert.equal(denied.ok, false); assert.equal(calls.length, 1);
  const route = await p.local('b', { op: 'sms', method: 'PUT', path: '/routes/%2B15555550100', agent: p.b.id, body: { target: p.b.id } });
  assert.equal(route.ok, false); assert.equal(calls.length, 1);
  // Primary alone may forward inbound phone replies to a remote agent.
  const forwarded = await p.local('a', { op: 'sms-reply', id: crypto.randomUUID(), to: remoteId(p.cb.hostId, p.b.id), message: 'synthetic test reply' });
  assert.equal(forwarded.ok, true); assert.equal(p.receivedB[0][1].id, 'service:claw-messenger');
  const follower = await p.local('b', { op: 'sms-reply', id: crypto.randomUUID(), to: remoteId(p.ca.hostId, p.a.id), message: 'must fail' });
  assert.equal(follower.ok, false);
  p.B.forget(p.service(p.ca, p.A));
  const offline = await p.local('b', { op: 'sms', method: 'PUT', path: lockPath, agent: p.b.id, body: {} });
  assert.equal(offline.ok, false); assert.match(offline.error, /no automatic failover/); assert.equal(calls.length, 1);
});

test('sms gateway and primary lock table share ownership, expiry and fencing across hosts', async (t) => {
  const { Locks } = await import('../claw-messenger/locks.mjs');
  const { remoteLockAgents } = await import('../lib/lan.mjs');
  let locks;
  const call = async (method, route, body) => {
    try {
      const number = '+15555550100';
      if (method === 'PUT') return { status: 200, body: { ok: true, lock: locks.acquire(number, body) } };
      if (method === 'DELETE') return { status: 200, body: locks.release(number, body) };
      return { status: 200, body: { locks: locks.all() } };
    } catch (e) { return { status: e.status || 400, body: { error: e.message } }; }
  };
  const p = await pair(t, { sms: true, smsCall: call });
  locks = new Locks(path.join(p.root, 'locks.json'), { listAgents: () => [p.a, ...remoteLockAgents(path.join(p.root, 'a'))] });
  const frame = { op: 'sms', method: 'PUT', path: '/locks/%2B15555550100', agent: p.b.id, body: { ttlSeconds: 60 } };
  const first = await p.local('b', frame);
  assert.equal(first.response.status, 200);
  const token = first.response.body.lock.leaseId;
  assert.throws(() => locks.acquire('+15555550100', { holder: p.a.id }), (e) => e.status === 409);
  assert.equal((await p.local('b', frame)).response.status, 409);
  const renewed = await p.local('b', { ...frame, body: { leaseId: token } });
  assert.equal(renewed.response.status, 200);
  assert.equal((await p.local('b', { ...frame, method: 'DELETE', body: { leaseId: token } })).response.status, 409);
  const released = await p.local('b', { ...frame, method: 'DELETE', body: { leaseId: renewed.response.body.lock.leaseId } });
  assert.equal(released.response.body.released, true);
});

test('authenticated host history survives discovery loss without creating routes and requires explicit retirement', async (t) => {
  const p = await pair(t);
  const initial = await p.local('a', { op: 'status' });
  assert.equal(initial.knownHosts[0].hostId, p.cb.hostId); assert.equal(initial.knownHostCoverageComplete, true);
  assert.equal((await p.local('a', { op: 'forget-host', hostId: p.cb.hostId })).ok, false, 'live host cannot be retired');
  p.A.forget(p.service(p.cb, p.B));
  const absent = await p.local('a', { op: 'status' });
  assert.equal(absent.peers.length, 0); assert.equal(absent.knownHosts.length, 1);
  assert.equal((await p.local('a', { op: 'list' })).agents.length, 0);
  const unauthenticated = { txt: { v: '1', id: crypto.randomUUID() }, addresses: ['127.0.0.1'], port: 1 };
  p.A.discover(unauthenticated);
  assert.equal((await p.local('a', { op: 'status' })).knownHosts.length, 1, 'discovery alone cannot create history');
  assert.equal((await p.local('a', { op: 'forget-host', hostId: p.cb.hostId })).ok, true);
  assert.equal((await p.local('a', { op: 'status' })).knownHosts.length, 0);
});

test('a peer rediscovered after its daemon restarts keeps its authenticated name, never its id or mdns service name', async (t) => {
  const p = await pair(t);
  const named = async () => (await p.local('a', { op: 'status' })).peers.map((x) => [x.hostId, x.name]);
  assert.deepEqual(await named(), [[p.cb.hostId, 'b']]);
  // b's daemon comes back on a new port and re-announces itself as `agentbus-<hostId>`; nothing has authenticated it yet
  p.A.discover({ ...p.service(p.cb, p.B), name: `agentbus-${p.cb.hostId}`, port: p.B.port + 1 });
  const status = await p.local('a', { op: 'status' });
  assert.equal(status.peers[0].port, p.B.port + 1, 'the new address is taken');
  assert.equal(status.peers[0].name, 'b', 'name survives re-discovery (this was the phantom `agentbus-<uuid>` host on the dashboard)');
  // a host never authenticated before has no name to keep: a short id placeholder, not the mdns string
  const stranger = crypto.randomUUID();
  p.A.discover({ txt: { v: '1', id: stranger }, name: `agentbus-${stranger}`, port: 5555, addresses: ['127.0.0.1'] });
  assert.equal((await p.local('a', { op: 'status' })).peers.find((x) => x.hostId === stranger).name, stranger.slice(0, 8));
});

test('peers share their known hosts (identity, last-authenticated time, link kind and role only) over authenticated inventory', async (t) => {
  const p = await pair(t);
  await Promise.all([p.A.refresh(), p.B.refresh()]); // second round: each side has now authenticated the other
  const status = await p.local('a', { op: 'status' });
  assert(status.build.features.includes('shared-known-hosts-v1'));
  const shared = status.peers[0].knownHosts;
  assert.equal(shared.length, 1);
  assert.deepEqual(Object.keys(shared[0]).sort(), ['hostId', 'lastAuthenticatedAt', 'link', 'name', 'role']);
  assert.equal(shared[0].role, 'host', 'the role a host declared travels with it');
  assert.equal(shared[0].link, 'lan', 'loopback test pair classifies as lan; no address crosses');
  assert.equal(status.knownHosts[0].link, 'lan');
  assert.equal(shared[0].hostId, p.ca.hostId); assert.equal(shared[0].name, 'a');
  assert.equal(status.knownHosts.length, 1, 'a peer\'s registry is never merged into ours');
});

test('account usage crosses authenticated inventory sanitized and without delaying presence', async t => {
  const now = Date.now();
  const usage = { current: () => ({ secret: 'token', providers: { claude: { source: 'claude-oauth-usage', observedAt: now, checkedAt: now, windows: [{ id: 'five_hour', usedPercent: 25, windowMinutes: 300, resetsAt: now + 60_000 }], token: 'secret' } } }), update: () => new Promise(() => {}) };
  const p = await pair(t, { usage });
  const status = await p.local('a', { op: 'status' });
  assert.equal(status.usage.providers.claude.windows[0].remainingPercent, 75);
  assert.equal(status.peers[0].usage.providers.claude.windows[0].usedPercent, 25);
  assert.equal(status.peers[0].usage.providers.codex.status, 'unknown');
  assert.equal(status.usage.secret, undefined);
  assert.equal(status.peers[0].usage.providers.claude.token, undefined);
});
