import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { localLanRequest, loadLan, initLan, updateLanConfig, validateTailnet, DEFAULT_WAN_PORT } from '../lib/lan.mjs';
import { startLan } from '../lib/lan-daemon.mjs';
import { tailnetCandidates, createTailnetDiscovery, DISCOVERY_DEFAULTS } from '../lib/tailnet-discovery.mjs';

// a `tailscale status --json` (ipnstate.Status) as a node sees its tailnet: the fields discovery reads, nothing owner-specific
const SUFFIX = 'example-tailnet.ts.net';
const node = (ip, extra = {}) => ({ ID: crypto.randomUUID().slice(0, 8), HostName: 'laptop', DNSName: `laptop.${SUFFIX}.`, OS: 'linux', UserID: 1, TailscaleIPs: [ip, 'fd7a:115c:a1e0::1'], Online: true, ...extra });
const fakeStatus = (peers, extra = {}) => ({ BackendState: 'Running', TailscaleIPs: ['100.64.0.1', 'fd7a:115c:a1e0::2'], Self: { HostName: 'studio', DNSName: `studio.${SUFFIX}.`, TailscaleIPs: ['100.64.0.1'], Online: true }, MagicDNSSuffix: SUFFIX, Peer: Object.fromEntries(peers.map((p, i) => [`nodekey:${i}`, p])), User: { 1: { ID: 1, LoginName: 'owner@example.com' } }, ...extra });

test('candidates: online nodes of this tailnet only; offline, shared, self and ipv6-only nodes are skipped', () => {
  const status = fakeStatus([
    node('100.64.0.2'), // our own online machine
    node('100.64.0.3', { Online: false }), // ours, asleep
    node('100.64.0.4', { ShareeNode: true, DNSName: 'other.another-tailnet.ts.net.' }), // a sharee's node (we shared a device with them)
    node('100.64.0.5', { DNSName: 'shared-in.another-tailnet.ts.net.' }), // shared to us from another tailnet
    node('100.64.0.1'), // a stale entry for ourselves
    node('100.64.0.6', { TailscaleIPs: ['fd7a:115c:a1e0::9'] }), // ipv6 only
    node('100.64.0.2'), // duplicate address
    node('100.64.0.7', { Tags: ['tag:agentbus-gpu'], DNSName: `gpubox.${SUFFIX}.` }), // a tagged node of ours (a pod)
    node('10.0.0.8'), // not an overlay address
  ]);
  assert.deepEqual(tailnetCandidates(status), ['100.64.0.2', '100.64.0.7']);
  assert.deepEqual(tailnetCandidates(status, { includeShared: true }), ['100.64.0.2', '100.64.0.4', '100.64.0.5', '100.64.0.7']);
  assert.deepEqual(tailnetCandidates(status, { selfAddresses: ['100.64.0.7'] }), ['100.64.0.2'], 'an advertised address of ours is never probed');
  assert.deepEqual(tailnetCandidates(fakeStatus([node('100.64.0.2')], { MagicDNSSuffix: '' })), ['100.64.0.2'], 'no suffix known: ShareeNode alone decides');
  assert.deepEqual(tailnetCandidates(fakeStatus([node('100.64.0.2')], { MagicDNSSuffix: `${SUFFIX}.` })), ['100.64.0.2'], 'a suffix with a trailing dot');
  assert.deepEqual(tailnetCandidates(fakeStatus([node('100.64.0.2')], { BackendState: 'NeedsLogin' })), [], 'not running: nothing to probe');
  assert.deepEqual(tailnetCandidates({ BackendState: 'Running' }), []);
  assert.deepEqual(tailnetCandidates(null), []);
  assert.deepEqual(tailnetCandidates(fakeStatus([node('127.0.0.1')])), []);
  assert.deepEqual(tailnetCandidates(fakeStatus([node('127.0.0.1')]), { allowLoopback: true }), ['127.0.0.1']);
});

test('config: the switches validate and default to discovery on, port 47800, own tailnet only', () => {
  validateTailnet({}); validateTailnet({ tailnetDiscovery: false, tailnetPort: 1234, tailnetIncludeShared: true });
  assert.throws(() => validateTailnet({ tailnetDiscovery: 'no' }), /tailnetDiscovery/);
  assert.throws(() => validateTailnet({ tailnetPort: 0 }), /tailnetPort/);
  assert.throws(() => validateTailnet({ tailnetPort: '47800' }), /tailnetPort/);
  assert.throws(() => validateTailnet({ tailnetIncludeShared: 1 }), /tailnetIncludeShared/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-tn-'));
  try {
    initLan({ busDir: root, name: 'studio' });
    const config = loadLan(root);
    assert.equal(config.tailnetDiscovery, undefined); assert.equal(DEFAULT_WAN_PORT, 47800);
    assert.throws(() => updateLanConfig(root, (c) => ({ ...c, tailnetPort: 70000 })), /tailnetPort/);
    assert.equal(updateLanConfig(root, (c) => ({ ...c, tailnetDiscovery: false })).tailnetDiscovery, false);
    assert.equal(loadLan(root).tailnetDiscovery, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// the controller against a scripted tailnet: which addresses are probed, when, and what is remembered
function controller({ config = {}, hosts = {}, peers = new Set(), status, log = [], ...overrides } = {}) {
  let clock = 1_000_000;
  const probes = [], inFlight = { now: 0, max: 0 };
  const probe = async (address, port) => {
    probes.push(`${address}:${port}`); inFlight.now++; inFlight.max = Math.max(inFlight.max, inFlight.now);
    await new Promise((r) => setTimeout(r, 5)); inFlight.now--;
    const h = hosts[address];
    if (!h) return { ok: false, delivery: 'unavailable', error: 'connect ECONNREFUSED' };
    if (h === 'wrong-key') return { ok: false, delivery: 'unavailable', error: 'lan connection closed' };
    if (h === 'older-build') return { ok: false, error: 'wrong recipient host' };
    return { ok: true, hostId: h.hostId, name: h.name, agents: [] };
  };
  const added = [];
  const d = createTailnetDiscovery({ config: { hostId: crypto.randomUUID(), ...config }, probe, status, now: () => clock, log: (s) => log.push(s),
    hasPeer: (id) => peers.has(id), peerAt: () => false, add: (m) => { added.push(m); peers.add(m.hostId); }, ...overrides });
  return { d, probes, added, peers, inFlight, log, tick: (ms) => { clock += ms; } };
}

test('a scan probes each candidate once, keeps members, forgets the rest for the negative ttl, and names no non-member', async () => {
  const member = { hostId: crypto.randomUUID(), name: 'laptop' }, already = { hostId: crypto.randomUUID(), name: 'gpubox' };
  const hosts = { '100.64.0.2': member, '100.64.0.3': undefined, '100.64.0.4': 'wrong-key', '100.64.0.5': 'older-build', '100.64.0.6': already };
  const status = () => fakeStatus(Object.keys(hosts).map((ip) => node(ip)));
  const c = controller({ hosts, status, peers: new Set([already.hostId]), concurrency: 2 });
  let snap = await c.d.scan();
  assert.deepEqual(c.probes.sort(), ['100.64.0.2:47800', '100.64.0.3:47800', '100.64.0.4:47800', '100.64.0.5:47800', '100.64.0.6:47800']);
  assert.deepEqual(c.added, [{ hostId: member.hostId, address: '100.64.0.2', port: 47800, name: 'laptop' }]);
  assert.equal(c.inFlight.max, 2, 'bounded concurrency');
  assert.equal(snap.found, 1); assert.equal(snap.legacy, 1); assert.equal(snap.negatives, 3); assert.equal(snap.candidates, 5); assert.equal(snap.probed, 5); assert.equal(snap.cli, 'ok');
  assert(c.log.every((l) => !/100\.64\.0\.[346]/.test(l)), `non-members never appear in the log: ${c.log.join(' | ')}`);
  assert(c.log.some((l) => l.includes('100.64.0.5') && /older build/.test(l)), 'a member on a build before discovery is named, so it gets upgraded');
  assert(!JSON.stringify(snap).includes('100.64.0.'), 'status carries counts only');
  // within the scan interval nothing happens; forced, only the member that left the table would be redialed
  c.probes.length = 0;
  await c.d.scan(); assert.deepEqual(c.probes, []);
  await c.d.scan({ force: true }); assert.deepEqual(c.probes, [], 'members are peers now, the rest is cached');
  c.tick(DISCOVERY_DEFAULTS.scanEveryMs);
  await c.d.scan(); assert.deepEqual(c.probes, []);
  // a member dropped from the peer table (silent for the learned-peer grace period) is probed again on the next scan
  c.peers.delete(member.hostId); c.tick(DISCOVERY_DEFAULTS.scanEveryMs);
  await c.d.scan(); assert.deepEqual(c.probes, ['100.64.0.2:47800']);
  assert.equal(c.added.length, 2);
  // after the negative ttl the others get one more try
  c.probes.length = 0; c.tick(DISCOVERY_DEFAULTS.negativeTtlMs);
  snap = await c.d.scan();
  assert.deepEqual(c.probes.sort(), ['100.64.0.3:47800', '100.64.0.4:47800', '100.64.0.5:47800']);
  assert.equal(snap.scans, 5);
});

test('the port, the shared-node opt-in and the off switch come from config; a missing cli is reported once', async () => {
  const member = { hostId: crypto.randomUUID(), name: 'laptop' };
  const status = () => fakeStatus([node('100.64.0.2'), node('100.64.0.5', { DNSName: 'shared-in.another-tailnet.ts.net.' })]);
  const c = controller({ config: { tailnetPort: 50000, tailnetIncludeShared: true }, hosts: { '100.64.0.2': member, '100.64.0.5': member }, status });
  await c.d.scan();
  assert.deepEqual(c.probes.sort(), ['100.64.0.2:50000', '100.64.0.5:50000']);
  assert.equal(c.added.length, 1, 'the same member over two addresses is one peer');
  const off = controller({ config: { tailnetDiscovery: false }, status: () => { throw Error('must not be read'); } });
  const snap = await off.d.scan();
  assert.equal(snap.enabled, false); assert.equal(snap.nextScanAt, null); assert.deepEqual(off.probes, []);
  const noCli = controller({ status: () => null, scanEveryMs: 0 });
  await noCli.d.scan(); await noCli.d.scan();
  assert.equal(noCli.d.snapshot().cli, 'unavailable');
  assert.equal(noCli.log.filter((l) => /tailscale status unavailable/.test(l)).length, 1, 'logged once, not every minute');
  const stopped = controller({ status: () => fakeStatus([node('100.64.0.2')], { BackendState: 'Stopped' }) });
  await stopped.d.scan();
  assert.equal(stopped.d.snapshot().cli, 'tailscale stopped'); assert.deepEqual(stopped.probes, []);
  // a probe that throws is a negative, never a crash
  const throwing = controller({ status: () => fakeStatus([node('100.64.0.2')]), probe: async () => { throw Error('boom'); } });
  assert.equal((await throwing.d.scan()).negatives, 1);
});

// real daemons on loopback: the probe is the ordinary psk inventory request, so a member authenticates, is learned
// on both sides and is dialed back, while another group's daemon and a non-agentbus listener are left alone
const agent = (name) => ({ id: `claude:${crypto.randomUUID()}`, kind: 'claude', clientType: 'claude-code', model: 'm', modelSource: 'configured', name, status: 'idle' });
async function daemons(t, { key = crypto.randomBytes(32), tailnetFor = () => false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-tnd-')), logs = {};
  const mk = (name, extra = {}) => { const dir = path.join(root, name, 'lan'); fs.mkdirSync(dir, { recursive: true }); logs[name] = []; return { hostId: crypto.randomUUID(), name, key, dir, port: 0, bind: '127.0.0.1', ...extra }; };
  const common = (name) => ({ mdns: false, cloud: false, allowLoopback: true, pollMs: 60000, log: (s) => logs[name].push(s), deliverLocal: async () => ({ ok: true, delivery: 'accepted' }) });
  const started = [];
  const start = async (name, extra = {}, options = {}) => { const config = mk(name, extra), worker = agent(`${name}-worker`); const d = await startLan({ ...common(name), config, listLocal: () => [worker], tailnet: tailnetFor(name, config), ...options }); started.push(d); return { d, config, worker }; };
  t.after(async () => { await Promise.all(started.map((d) => d.close())); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, start, logs, local: (name, frame) => localLanRequest(frame, { busDir: path.join(root, name) }) };
}

test('a member found on the tailnet is peered without any config, learned back by the member, and reachable for messages', async (t) => {
  const h = await daemons(t, { tailnetFor: (name) => name === 'studio' ? { status: () => fakeStatus([node('127.0.0.1')]), scanEveryMs: 0 } : false });
  const laptop = await start(h, 'laptop');
  const studio = await start(h, 'studio', { tailnetPort: laptop.d.port });
  // the daemon re-reads config.json every poll for static peers: discovery must leave it untouched
  const configFile = path.join(studio.config.dir, 'config.json'), before = JSON.stringify({ hostId: studio.config.hostId, name: 'studio', port: 0, bind: '127.0.0.1', tailnetPort: laptop.d.port });
  fs.writeFileSync(configFile, before);
  await studio.d.refresh(); // fires the scan detached
  await studio.d.discovery.scan(); // joins it
  let peer = studio.d.peers.get(laptop.config.hostId);
  assert(peer, 'the laptop is in the peer table'); assert.equal(peer.discovered, true); assert.equal(peer.learned, true); assert.equal(peer.static, undefined);
  assert.equal(peer.name, 'laptop'); assert.equal(peer.checkedAt, 0, 'inventoried on the next poll, not by the scan');
  await studio.d.refresh(); await studio.d.discovery.scan();
  peer = studio.d.peers.get(laptop.config.hostId);
  assert.equal(peer.error, undefined); assert(peer.checkedAt > 0);
  assert.equal(fs.readFileSync(configFile, 'utf8'), before, 'a discovered member is never written to config');
  const status = await h.local('studio', { op: 'status' });
  assert.equal(status.tailnet.enabled, true); assert.equal(status.tailnet.found, 1); assert.equal(status.tailnet.port, laptop.d.port);
  assert.equal(status.peers.find((p) => p.hostId === laptop.config.hostId)?.discovered, true);
  assert(h.logs.studio.some((l) => /tailnet discovery: member laptop at 127\.0\.0\.1:\d+/.test(l)));
  // the laptop learned the studio from the probe and dials back on its own poll, like any dial-back
  await laptop.d.refresh();
  const back = laptop.d.peers.get(studio.config.hostId);
  assert(back?.learned, 'learned from the probe'); assert.equal(back.error, undefined);
  assert.equal((await h.local('laptop', { op: 'list' })).agents[0].name, 'studio-worker@studio');
  const remoteLaptopWorker = (await h.local('studio', { op: 'list' })).agents[0];
  assert.equal(remoteLaptopWorker.name, 'laptop-worker@laptop');
  const sent = await h.local('studio', { op: 'send', id: crypto.randomUUID(), to: remoteLaptopWorker.id, from: studio.worker.id, message: 'hi' });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  // the laptop's own discovery is off here (tailnet: false): status says so instead of pretending
  assert.deepEqual((await h.local('laptop', { op: 'status' })).tailnet, { enabled: false });
});

test('another group\'s daemon, a non-agentbus listener and a closed port are cached negatives, never peers, never named', async (t) => {
  const plain = net.createServer((s) => s.end('nope\n')); plain.listen(0, '127.0.0.1'); await new Promise((r) => plain.once('listening', r)); t.after(() => plain.close());
  const other = await daemons(t, { key: crypto.randomBytes(32) });
  const stranger = await start(other, 'stranger');
  const closed = net.createServer(); closed.listen(0, '127.0.0.1'); await new Promise((r) => closed.once('listening', r)); const closedPort = closed.address().port; await new Promise((r) => closed.close(r));
  for (const [label, port] of [['wrong key', stranger.d.port], ['not agentbus', plain.address().port], ['nothing listening', closedPort]]) {
    const h = await daemons(t, { tailnetFor: () => ({ status: () => fakeStatus([node('127.0.0.1')]), scanEveryMs: 0, probeTimeoutMs: 2000 }) });
    const studio = await start(h, 'studio', { tailnetPort: port });
    await studio.d.refresh(); await studio.d.discovery.scan();
    assert.equal(studio.d.peers.size, 0, label);
    const snap = (await h.local('studio', { op: 'status' })).tailnet;
    assert.equal(snap.negatives, 1, label); assert.equal(snap.found, 0, label);
    assert(h.logs.studio.every((l) => !l.includes('127.0.0.1')), `${label}: ${h.logs.studio.join(' | ')}`);
    await studio.d.refresh(); await studio.d.discovery.scan();
    const again = (await h.local('studio', { op: 'status' })).tailnet;
    assert.equal(again.scans, 2, label); assert.equal(again.probed, 0, `${label}: not probed again within the ttl`);
  }
  assert.equal(stranger.d.peers.size, 0, 'the other group learned nothing from a failed handshake');
});

test('the peer poll never waits on a scan: a node that swallows the port stalls only the probe, and an in-flight scan is joined', async (t) => {
  // a listener that accepts and never answers: what a firewall that drops tcp 47800 looks like, minus the syn retries
  const held = new Set(), blackhole = net.createServer((s) => held.add(s)); blackhole.listen(0, '127.0.0.1'); await new Promise((r) => blackhole.once('listening', r));
  t.after(() => { for (const s of held) s.destroy(); blackhole.close(); });
  const h = await daemons(t, { tailnetFor: (name) => name === 'studio' ? { status: () => fakeStatus([node('127.0.0.1')]), scanEveryMs: 0, probeTimeoutMs: 20000 } : false });
  const laptop = await start(h, 'laptop');
  const studio = await start(h, 'studio', { tailnetPort: blackhole.address().port });
  studio.d.discover({ txt: { v: '1', id: laptop.config.hostId }, port: laptop.d.port, addresses: ['127.0.0.1'] });
  const t0 = Date.now(); await studio.d.refresh(); const took = Date.now() - t0;
  assert(took < 2000, `refresh took ${took}ms while a probe hangs`);
  const peer = studio.d.peers.get(laptop.config.hostId);
  assert.equal(peer.error, undefined); assert(peer.checkedAt > 0, 'the existing peer was inventoried in that poll');
  assert.equal(held.size, 1, 'exactly one probe in flight');
  await studio.d.refresh();
  assert.equal(held.size, 1, 'the second poll joined the running scan instead of starting another');
  assert.equal((await h.local('studio', { op: 'status' })).tailnet.scans, 1);
  // a hanging `tailscale status` (async) stalls the poll just as little
  let release; const slow = await daemons(t, { tailnetFor: () => ({ status: () => new Promise((r) => { release = () => r(fakeStatus([])); }), scanEveryMs: 0 }) });
  const s2 = await start(slow, 'studio');
  const t1 = Date.now(); await s2.d.refresh(); assert(Date.now() - t1 < 2000);
  release(); await s2.d.discovery.scan();
  assert.equal((await slow.local('studio', { op: 'status' })).tailnet.scans, 1);
});

async function start(h, name, extra, options) { return h.start(name, extra, options); }
