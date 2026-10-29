import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { initLan, loadLan, encodeJoinToken, socksConnect, tailscaleIPv4, parseSocks5, validateUserspace, localLanRequest } from '../lib/lan.mjs';
import { startLan } from '../lib/lan-daemon.mjs';
import { registerStorage } from '../lib/storage.mjs';
import { uploadFile, downloadFile } from '../lib/blob.mjs';
import { join } from '../lib/wan.mjs';

const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-us-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const agent = (name) => ({ id: `codex:${crypto.randomUUID()}`, kind: 'codex', clientType: 'codex', model: 'm', modelSource: 'configured', name, status: 'idle' });

// stands in for tailscaled --socks5-server: a no-auth socks5 CONNECT that routes fake tailnet addresses to loopback ports.
async function fakeTailscaled(t, routes) {
  const seen = [], open = new Set();
  const server = net.createServer((c) => {
    let buf = Buffer.alloc(0), stage = 0;
    open.add(c); c.on('close', () => open.delete(c));
    c.on('error', () => {});
    c.on('data', function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 0 && buf.length >= 3) { buf = buf.subarray(2 + buf[1]); stage = 1; c.write(Buffer.from([5, 0])); }
      if (stage === 1 && buf.length >= 10 && buf[3] === 1) {
        const host = [...buf.subarray(4, 8)].join('.'), port = buf.readUInt16BE(8), rest = buf.subarray(10);
        c.removeListener('data', onData); seen.push(`${host}:${port}`);
        const target = routes()[`${host}:${port}`];
        if (!target) { c.end(Buffer.from([5, 4, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
        const up = net.connect(target, '127.0.0.1'); open.add(up); up.on('close', () => open.delete(up));
        up.once('connect', () => { c.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0])); if (rest.length) up.write(rest); c.pipe(up).pipe(c); });
        up.on('error', () => c.destroy()); c.on('close', () => up.destroy());
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  // piped blob sockets idle for minutes; tear them down instead of waiting
  t.after(() => new Promise((r) => { for (const s of open) s.destroy(); server.close(r); }));
  return { proxy: `127.0.0.1:${server.address().port}`, seen };
}

test('socks5 client: connects through the proxy, reports refusals, validates the proxy address', async (t) => {
  const echo = net.createServer((c) => c.pipe(c)); await new Promise((r) => echo.listen(0, '127.0.0.1', r)); t.after(() => echo.close());
  const { proxy, seen } = await fakeTailscaled(t, () => ({ [`100.100.0.9:7000`]: echo.address().port }));
  const s = await socksConnect(proxy, '100.100.0.9', 7000);
  const back = await new Promise((r) => { s.once('data', (d) => r(d.toString())); s.write('ping'); });
  s.destroy();
  assert.equal(back, 'ping'); assert.deepEqual(seen, ['100.100.0.9:7000']);
  await assert.rejects(socksConnect(proxy, '100.100.0.10', 7000), /socks5 connect .* failed/);
  await assert.rejects(socksConnect('127.0.0.1:1', '100.100.0.9', 7000), /socks5 proxy/);
  assert.throws(() => parseSocks5('10.0.0.1:1055'), /loopback/);
  assert.throws(() => parseSocks5('127.0.0.1'), /loopback/);
  assert.deepEqual(parseSocks5('127.0.0.1:1055'), { host: '127.0.0.1', port: 1055 });
});

test('tailscale ip -4 parsing keeps only overlay addresses; userspace config needs loopback bind, socks5 and an overlay address', () => {
  assert.deepEqual(tailscaleIPv4(() => '100.101.2.3\n'), ['100.101.2.3']);
  assert.deepEqual(tailscaleIPv4(() => ''), []);
  assert.deepEqual(tailscaleIPv4(() => '192.168.1.4\nfd7a:115c::1\n'), []);
  const ok = { userspaceTailscale: true, bind: '127.0.0.1', socks5: '127.0.0.1:1055', advertiseAddress: '100.101.2.3' };
  validateUserspace(ok);
  validateUserspace({ bind: '0.0.0.0' }); // existing hosts: nothing required
  assert.throws(() => validateUserspace({ ...ok, bind: '0.0.0.0' }), /loopback bind/);
  assert.throws(() => validateUserspace({ ...ok, socks5: undefined }), /socks5/);
  assert.throws(() => validateUserspace({ ...ok, advertiseAddress: '8.8.8.8' }), /advertiseAddress/);
  assert.throws(() => validateUserspace({ ...ok, ephemeral: 'yes' }), /ephemeral/);
});

test('a userspace-tailscale pod joins over socks5, the owner dials it back at its advertised tailscale ip, and blobs flow', async (t) => {
  const root = tmp(t), key = crypto.randomBytes(32);
  const mk = (name, extra) => { const dir = path.join(root, name, 'lan'); fs.mkdirSync(dir, { recursive: true }); return { hostId: crypto.randomUUID(), name, key, dir, port: 0, bind: '127.0.0.1', peers: [], ...extra }; };
  const common = { mdns: false, tailnet: false, allowLoopback: true, pollMs: 60000, log: () => {}, deliverLocal: async () => ({ ok: true, delivery: 'accepted' }) };
  let A, B;
  // one fake tailnet: owner at 100.100.0.1, pod at 100.101.0.2; both reach each other only through their proxies
  const net1 = await fakeTailscaled(t, () => ({ [`100.100.0.1:${A.port}`]: A.port, [`100.101.0.2:${B.port}`]: B.port }));
  const ca = mk('owner', { socks5: net1.proxy });
  A = await startLan({ ...common, config: ca, listLocal: () => [agent('owner-worker')] });
  const cb = mk('pod', { userspaceTailscale: true, socks5: net1.proxy, advertiseAddress: '100.101.0.2', ephemeral: true, gpu_cost_per_hour: 2.89, billing: 'runpod secure cloud on-demand' });
  // the pod's daemon reads static peers from its config file every poll
  B = await startLan({ ...common, config: cb, listLocal: () => [agent('pod-worker')] });
  fs.writeFileSync(path.join(cb.dir, 'config.json'), JSON.stringify({ hostId: cb.hostId, name: 'pod', port: B.port, bind: '127.0.0.1', userspaceTailscale: true, socks5: net1.proxy, advertiseAddress: '100.101.0.2', ephemeral: true, gpu_cost_per_hour: 2.89, billing: 'runpod secure cloud on-demand', peers: [{ hostId: ca.hostId, address: '100.100.0.1', port: A.port, name: 'owner' }] }));
  t.after(async () => { await Promise.all([A.close(), B.close()]); });
  await B.refresh();
  assert.ok(!B.peers.get(ca.hostId).error, 'pod authenticated the owner through socks5');
  assert.ok(net1.seen.includes(`100.100.0.1:${A.port}`), 'the pod never dialed the owner directly');
  const learned = A.peers.get(cb.hostId);
  assert.equal(learned.address, '100.101.0.2', 'owner learned the advertised tailscale ip, not the loopback tcp source');
  assert.equal(learned.port, B.port);
  await A.refresh();
  const pod = A.peers.get(cb.hostId);
  assert.ok(!pod.error && pod.agents.length === 1, 'owner dialed the pod back');
  assert.equal(pod.ephemeral, true);
  assert.equal(pod.capabilities.gpu_cost_per_hour, 2.89); assert.equal(pod.capabilities.billing, 'runpod secure cloud on-demand');
  await B.refresh();
  assert.equal(B.peers.get(ca.hostId).reachBack, true, 'lan doctor reach back passes');
  // ephemeral: never written to the owner's host history, so a terminated pod is not expected by presence
  const status = await localLanRequest({ op: 'status' }, { busDir: path.join(root, 'owner') });
  assert.equal(status.knownHosts.some((h) => h.hostId === cb.hostId), false);
  // pod owns task storage on its volume; the owner pulls results through socks5
  const share = path.join(root, 'volume', 'agentbus-tasks', cb.hostId); fs.mkdirSync(share, { recursive: true });
  registerStorage({ name: 'pod tasks', localPath: share, uri: 'smb://pod/agentbus-tasks', ownerHostId: cb.hostId, create: true }, path.join(root, 'pod'));
  const src = path.join(root, 'in.bin'); fs.writeFileSync(src, crypto.randomBytes(256 * 1024));
  const task = crypto.randomUUID(), podPeer = { hostId: cb.hostId, address: '100.101.0.2', port: B.port, name: 'pod' };
  const up = await uploadFile(ca, podPeer, { task, name: 'in.bin', file: src });
  const down = await downloadFile(ca, podPeer, { task, area: 'in', name: 'in.bin', dest: path.join(root, 'back.bin') });
  assert.equal(up.sha256, down.sha256);
  // pod terminated: forget-host on the owner drops it from the live table too, not only from history
  await B.close();
  await A.refresh();
  assert.ok(A.peers.get(cb.hostId).error);
  const forgot = await localLanRequest({ op: 'forget-host', hostId: cb.hostId }, { busDir: path.join(root, 'owner') });
  assert.equal(forgot.ok, true);
  assert.equal(A.peers.has(cb.hostId), false);
});

test('lan join --userspace-tailscale writes a loopback bind, socks5, advertised tailscale ip and cost; the default join is unchanged', async (t) => {
  const root = tmp(t), owner = path.join(root, 'owner');
  initLan({ busDir: owner, name: 'gpubox', port: 47800 });
  const oc = loadLan(owner);
  const token = encodeJoinToken({ key: oc.key.toString('hex'), peers: [{ hostId: oc.hostId, name: 'gpubox', address: '100.90.0.4', port: 47800 }] });
  const pod = path.join(root, 'pod');
  await assert.rejects(join({ busDir: pod, token, name: 'runpod-h100', userspace: { tailscaleIp: () => [] } }), /tailscale ip -4/);
  await assert.rejects(join({ busDir: pod, token, name: 'runpod-h100', bind: '100.70.0.9', userspace: { tailscaleIp: () => ['100.101.0.2'] } }), /exclusive/);
  const r = await join({ busDir: pod, token, name: 'runpod-h100', userspace: { tailscaleIp: () => ['100.101.0.2'], ephemeral: true }, cost: { gpu_cost_per_hour: 2.89, billing: 'runpod secure cloud on-demand' } });
  assert.equal(r.bind, '127.0.0.1');
  assert.ok(!JSON.stringify(r).includes(oc.key.toString('hex')), 'join output never carries the key');
  const pc = loadLan(pod);
  assert.equal(pc.bind, '127.0.0.1'); assert.equal(pc.port, 47800); assert.equal(pc.mdns, false);
  assert.equal(pc.userspaceTailscale, true); assert.equal(pc.socks5, '127.0.0.1:1055'); assert.equal(pc.advertiseAddress, '100.101.0.2'); assert.equal(pc.ephemeral, true);
  assert.equal(pc.gpu_cost_per_hour, 2.89); assert.equal(pc.billing, 'runpod secure cloud on-demand');
  // rerun on a restarted pod with a new tailscale ip: same identity, address followed
  const again = await join({ busDir: pod, token, userspace: { tailscaleIp: () => ['100.101.0.7'] } });
  assert.equal(again.hostId, pc.hostId); assert.equal(loadLan(pod).advertiseAddress, '100.101.0.7');
  await assert.rejects(join({ busDir: path.join(root, 'bad'), token, userspace: { tailscaleIp: () => ['100.101.0.2'] }, cost: { gpu_cost_per_hour: -1 } }), /gpu_cost_per_hour/);
  // a normal join is untouched by any of this
  const plain = path.join(root, 'plain');
  await join({ busDir: plain, token, name: 'laptop', bind: '100.70.0.9' });
  const lc = loadLan(plain);
  assert.equal(lc.bind, '100.70.0.9');
  for (const k of ['userspaceTailscale', 'socks5', 'advertiseAddress', 'ephemeral', 'gpu_cost_per_hour', 'billing']) assert.equal(lc[k], undefined, k);
});
