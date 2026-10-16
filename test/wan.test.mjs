import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { initLan, loadLan, overlayIPv4, validatePeers, encodeJoinToken, decodeJoinToken, peerRequest } from '../lib/lan.mjs';
import { startLan } from '../lib/lan-daemon.mjs';
import { registerStorage } from '../lib/storage.mjs';
import { uploadFile, downloadFile, blobStat, blobPurge, validName, hashFile } from '../lib/blob.mjs';
import { leakCheck, buildInvite, join } from '../lib/wan.mjs';

const tmp = (t, prefix = 'ab-wan-') => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const agent = (name) => ({ id: `codex:${crypto.randomUUID()}`, kind: 'codex', clientType: 'codex', model: 'm', modelSource: 'configured', name, status: 'idle' });

// Two daemons on loopback. B knows A only as a static peer from its config file; A knows nothing about B.
async function wanPair(t, { storage = true } = {}) {
  const root = tmp(t), key = crypto.randomBytes(32);
  const mk = (name) => { const dir = path.join(root, name, 'lan'); fs.mkdirSync(dir, { recursive: true }); return { hostId: crypto.randomUUID(), name, key, dir, port: 0, bind: '127.0.0.1', peers: [] }; };
  const ca = mk('a'), cb = mk('b');
  const common = { mdns: false, allowLoopback: true, pollMs: 60000, log: () => {}, deliverLocal: async () => ({ ok: true, delivery: 'accepted' }) };
  const A = await startLan({ ...common, config: ca, listLocal: () => [agent('owner-worker')] });
  fs.writeFileSync(path.join(cb.dir, 'config.json'), JSON.stringify({ hostId: cb.hostId, name: 'b', port: 0, bind: '127.0.0.1', peers: [{ hostId: ca.hostId, address: '127.0.0.1', port: A.port, name: 'a' }] }));
  const B = await startLan({ ...common, config: cb, listLocal: () => [agent('remote-client')] });
  t.after(async () => { await Promise.all([A.close(), B.close()]); });
  let storageEntry;
  if (storage) {
    const share = path.join(root, 'share'); fs.mkdirSync(share);
    storageEntry = registerStorage({ name: 'tasks', localPath: share, uri: 'smb://owner/tasks', ownerHostId: ca.hostId, create: true }, path.join(root, 'a'));
  }
  const peerA = { hostId: ca.hostId, address: '127.0.0.1', port: A.port, name: 'a' };
  return { root, A, B, ca, cb, peerA, storageEntry };
}

test('overlay addresses, static peer validation and join tokens', () => {
  assert.equal(overlayIPv4('100.64.0.1'), true); assert.equal(overlayIPv4('100.127.255.254'), true);
  assert.equal(overlayIPv4('100.63.0.1'), false); assert.equal(overlayIPv4('100.128.0.1'), false); assert.equal(overlayIPv4('8.8.8.8'), false);
  const id = crypto.randomUUID();
  assert.deepEqual(validatePeers([{ hostId: id, address: '100.80.1.2', port: 47800, name: 'win' }]), [{ hostId: id, address: '100.80.1.2', port: 47800, name: 'win' }]);
  assert.doesNotThrow(() => validatePeers([{ hostId: id, address: 'winbox.tail1234.ts.net', port: 47800 }]));
  assert.throws(() => validatePeers([{ hostId: id, address: '8.8.8.8', port: 47800 }]), /private\/overlay/);
  assert.throws(() => validatePeers([{ hostId: id, address: '100.80.1.2', port: 0 }]), /port/);
  assert.throws(() => validatePeers([{ hostId: id, address: '100.80.1.2', port: 1 }, { hostId: id, address: '100.80.1.3', port: 1 }]), /unique/);
  assert.throws(() => validatePeers([{ hostId: id, address: '100.80.1.2', port: 1 }], id), /other than this host/);
  const key = crypto.randomBytes(32).toString('hex');
  const token = encodeJoinToken({ key, peers: [{ hostId: id, address: '100.80.1.2', port: 47800, name: 'win' }] });
  assert.match(token, /^agentbus-join-v1:[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeJoinToken(` ${token}\n`), { key, peers: [{ hostId: id, address: '100.80.1.2', port: 47800, name: 'win' }] });
  assert.throws(() => decodeJoinToken('agentbus-join-v1:!!!'), /malformed|key/);
  assert.throws(() => decodeJoinToken(encodeJoinToken({ key, peers: [] })), /no peers/);
});

test('lan init binds overlay addresses, rejects public ones, and needs a fixed port for static peers', (t) => {
  const root = tmp(t), peer = { hostId: crypto.randomUUID(), address: '100.80.1.2', port: 47800 };
  assert.throws(() => initLan({ busDir: path.join(root, 'x'), name: 'remote', bind: '8.8.8.8' }), /bind must be/);
  assert.throws(() => initLan({ busDir: path.join(root, 'y'), name: 'remote', bind: '100.70.0.2', peers: [peer] }), /fixed --port/);
  initLan({ busDir: path.join(root, 'z'), name: 'remote', bind: '100.70.0.2', port: 47800, peers: [peer], mdns: false });
  const config = loadLan(path.join(root, 'z'));
  assert.equal(config.bind, '100.70.0.2'); assert.equal(config.mdns, false); assert.deepEqual(config.peers, [peer]);
});

test('static peer is dialed without mdns, the owner learns the dialer and reports reach back', async (t) => {
  const { A, B, ca, cb } = await wanPair(t, { storage: false });
  await B.refresh();
  const seenByB = B.peers.get(ca.hostId);
  assert.ok(seenByB?.static && !seenByB.error && seenByB.agents.length === 1, 'B authenticated its static peer');
  assert.equal(seenByB.reachBack, false, 'A cannot know B yet');
  const learned = A.peers.get(cb.hostId);
  assert.ok(learned?.learned, 'A learned B from the authenticated inventory request');
  assert.equal(learned.address, '127.0.0.1');
  await A.refresh();
  assert.ok(!A.peers.get(cb.hostId).error && A.peers.get(cb.hostId).agents.length === 1, 'A dialed B back');
  await B.refresh();
  assert.equal(B.peers.get(ca.hostId).reachBack, true);
  // removing the static entry from config drops it on the next poll, no restart needed
  fs.writeFileSync(path.join(cb.dir, 'config.json'), JSON.stringify({ hostId: cb.hostId, name: 'b', port: 0, bind: '127.0.0.1' }));
  await B.refresh();
  assert.equal(B.peers.has(ca.hostId), false);
});

test('a wrong group key cannot inventory, learn or use blobs', async (t) => {
  const { A, cb, peerA } = await wanPair(t);
  const intruder = { ...cb, hostId: crypto.randomUUID(), key: crypto.randomBytes(32) };
  const r = await peerRequest(intruder, peerA, { op: 'agents', listen: { port: 1 } }, 3000);
  assert.equal(r.ok, false);
  assert.equal(A.peers.has(intruder.hostId), false);
  await assert.rejects(blobStat(intruder, peerA, { task: crypto.randomUUID() }));
});

test('blob upload/download round trip with sha256, idempotent re-put and conflict refusal', async (t) => {
  const { cb, peerA, storageEntry } = await wanPair(t);
  const dir = tmp(t), src = path.join(dir, 'input.bin'), task = crypto.randomUUID();
  fs.writeFileSync(src, crypto.randomBytes(3 * 1024 * 1024 + 17));
  let progressCalls = 0;
  const up = await uploadFile(cb, peerA, { task, area: 'in', name: 'data/input.bin', file: src, onProgress: () => progressCalls++ });
  assert.equal(up.sha256, await hashFile(src)); assert.ok(progressCalls > 1);
  const st = await blobStat(cb, peerA, { task });
  assert.equal(st.path, path.join(storageEntry.localPath, 'tasks', task));
  assert.deepEqual(st.in.map((f) => [f.name, f.complete, f.size]), [['data/input.bin', true, 3 * 1024 * 1024 + 17]]);
  assert.equal(fs.existsSync(path.join(st.path, 'in', 'data', 'input.bin.part')), false);
  // results written by a local worker on the owner are fetchable
  fs.mkdirSync(path.join(st.path, 'out'), { recursive: true });
  fs.writeFileSync(path.join(st.path, 'out', 'result.txt'), 'done');
  fs.writeFileSync(path.join(st.path, 'out', 'half.tmp'), 'not listed');
  const listed = await blobStat(cb, peerA, { task });
  assert.deepEqual(listed.out.map((f) => f.name), ['result.txt']);
  const down = await downloadFile(cb, peerA, { task, area: 'out', name: 'result.txt', dest: path.join(dir, 'r', 'result.txt') });
  assert.equal(fs.readFileSync(down.dest, 'utf8'), 'done');
  const again = await uploadFile(cb, peerA, { task, area: 'in', name: 'data/input.bin', file: src });
  assert.equal(again.skipped, true);
  const other = path.join(dir, 'other.bin'); fs.writeFileSync(other, 'different');
  await assert.rejects(uploadFile(cb, peerA, { task, area: 'in', name: 'data/input.bin', file: other }), /already exists/);
  const replaced = await uploadFile(cb, peerA, { task, area: 'in', name: 'data/input.bin', file: other, overwrite: true });
  assert.equal(replaced.size, 9);
  assert.deepEqual(await blobPurge(cb, peerA, { task }), { ok: true });
  assert.equal(fs.existsSync(st.path), false);
});

test('interrupted upload resumes from the owner byte count; a corrupt partial is detected and redone', async (t) => {
  const { cb, peerA, storageEntry } = await wanPair(t);
  const dir = tmp(t), src = path.join(dir, 'big.bin'), task = crypto.randomUUID(), bytes = crypto.randomBytes(2 * 1024 * 1024);
  fs.writeFileSync(src, bytes);
  const inDir = path.join(storageEntry.localPath, 'tasks', task, 'in'); fs.mkdirSync(inDir, { recursive: true });
  // what an upload cut off halfway leaves behind on the owner
  fs.writeFileSync(path.join(inDir, 'big.bin.part'), bytes.subarray(0, 1024 * 1024));
  fs.writeFileSync(path.join(inDir, 'big.bin.part.json'), JSON.stringify({ size: bytes.length }));
  const st = await blobStat(cb, peerA, { task });
  assert.deepEqual(st.in, [{ name: 'big.bin', complete: false, have: 1024 * 1024, size: bytes.length }]);
  let firstOffset;
  const up = await uploadFile(cb, peerA, { task, name: 'big.bin', file: src, onProgress: (done) => { firstOffset ??= done; } });
  assert.equal(firstOffset, 1024 * 1024, 'resumed instead of restarting');
  assert.equal(up.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.ok(fs.readFileSync(path.join(inDir, 'big.bin')).equals(bytes));
  // corrupt partial: same length prefix, wrong bytes. the hash check catches it and the retry starts over.
  const task2 = crypto.randomUUID(), in2 = path.join(storageEntry.localPath, 'tasks', task2, 'in'); fs.mkdirSync(in2, { recursive: true });
  fs.writeFileSync(path.join(in2, 'big.bin.part'), crypto.randomBytes(1024 * 1024));
  fs.writeFileSync(path.join(in2, 'big.bin.part.json'), JSON.stringify({ size: bytes.length }));
  const retries = [];
  const fixed = await uploadFile(cb, peerA, { task: task2, name: 'big.bin', file: src, onRetry: (e) => retries.push(e.message) });
  assert.equal(fixed.sha256, up.sha256);
  assert.ok(retries.some((m) => /different bytes/.test(m)), `retry reason recorded: ${retries}`);
  assert.ok(fs.readFileSync(path.join(in2, 'big.bin')).equals(bytes));
});

test('downloads resume from a local partial and verify the owner hash', async (t) => {
  const { cb, peerA, storageEntry } = await wanPair(t);
  const dir = tmp(t), task = crypto.randomUUID(), bytes = crypto.randomBytes(1536 * 1024);
  const out = path.join(storageEntry.localPath, 'tasks', task, 'out'); fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'model.pt'), bytes);
  const dest = path.join(dir, 'model.pt');
  fs.writeFileSync(dest + '.part', bytes.subarray(0, 1000));
  let first;
  await downloadFile(cb, peerA, { task, name: 'model.pt', dest, onProgress: (d) => { first ??= d; } });
  assert.ok(first > 1000 && first <= bytes.length);
  assert.ok(fs.readFileSync(dest).equals(bytes)); assert.equal(fs.existsSync(dest + '.part'), false);
});

test('blob names and tasks cannot escape the task area; non owners refuse', async (t) => {
  const { cb, ca, peerA, B } = await wanPair(t);
  for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'x.part', 'x.tmp', 'C:\\x', '.hidden', 'a//b', '..', 'ok/' + 'z'.repeat(200)]) assert.equal(validName(bad), false, bad);
  assert.equal(validName('data/run 1/out.bin'), true);
  const task = crypto.randomUUID();
  const r = await blobPurge(cb, peerA, { task, area: 'in', name: '../../escape' });
  assert.equal(r.ok, false); assert.match(r.error, /invalid name/);
  assert.match((await blobStat(cb, peerA, { task: '../../x' })).error, /uuid/);
  assert.match((await blobStat(cb, peerA, { task, hash: { area: 'etc', name: 'x' } })).error, /area/);
  const peerB = { hostId: cb.hostId, address: '127.0.0.1', port: B.port, name: 'b' };
  assert.match((await blobStat(ca, peerB, { task })).error, /owns no single rw storage/);
});

test('leak check blocks phone numbers, emails and local secrets but not addresses or ports', () => {
  const secrets = ['+15555550142'];
  assert.deepEqual(leakCheck('peers: win (100.101.102.103:47800), port 47800, node 24+', { secrets }), []);
  for (const bad of ['+1 (555) 555-0142', '555.555.0142', 'call 5555550142', 'x@example.com']) assert.notDeepEqual(leakCheck(bad, { secrets }), [], bad);
  assert.deepEqual(leakCheck('token abc+1 (555) 555-0142xyz', { secrets: [], allow: ['abc+1 (555) 555-0142xyz'] }), []);
  // host ids with long digit runs are not phone numbers
  assert.deepEqual(leakCheck('[{"hostId":"21366412-3812-4366-8123-456789012345"}] 12345678-1234-4123-8123-123456789012', { secrets }), []);
});

test('invite carries a working token and refuses identifying content; join writes an overlay-only config', async (t) => {
  const root = tmp(t), owner = path.join(root, 'owner');
  initLan({ busDir: owner, name: 'winbox', port: 47800, bind: '0.0.0.0' });
  const invite = await buildInvite({ busDir: owner, peerSpecs: ['self=100.90.0.4'], name: 'friend', repo: 'https://github.com/example/agentbus' });
  const token = /^AGENTBUS_JOIN_TOKEN=(\S+)$/m.exec(invite.text)[1];
  assert.equal(token, invite.token);
  assert.match(invite.text, /^AGENTBUS_NAME=friend$/m);
  assert.match(invite.text, /^AGENTBUS_PEER=winbox 100\.90\.0\.4:47800$/m);
  assert.match(invite.text, /https:\/\/github\.com\/example\/agentbus\/blob\/main\/docs\/join\.md/);
  assert.doesNotMatch(invite.text, /AGENTBUS_PORT|TS_AUTHKEY/);
  assert.ok(invite.text.split('\n').length < 15, 'invite stays short');
  const ownerConfig = loadLan(owner);
  assert.deepEqual(decodeJoinToken(token), { key: ownerConfig.key.toString('hex'), peers: [{ hostId: ownerConfig.hostId, name: 'winbox', address: '100.90.0.4', port: 47800 }] });
  await assert.rejects(buildInvite({ busDir: owner, peerSpecs: ['self=100.90.0.4'], repo: 'https://example.com/call-555-555-0142' }), /refusing to print the invite/);
  const withKey = await buildInvite({ busDir: owner, peerSpecs: ['self=100.90.0.4'], name: 'friend', repo: 'https://github.com/example/agentbus', tailscaleAuthKey: 'tskey-auth-k1234567CNTRL-0123456789abcdef' });
  assert.match(withKey.text, /^TS_AUTHKEY=tskey-auth-k1234567CNTRL-0123456789abcdef$/m);
  await assert.rejects(buildInvite({ busDir: owner, peerSpecs: ['self=100.90.0.4'], repo: 'r', tailscaleAuthKey: 'not-a-key' }), /tskey-auth/);
  const remote = path.join(root, 'remote');
  const joined = await join({ busDir: remote, token, name: 'friend', bind: '100.70.0.9' });
  const rc = loadLan(remote);
  assert.equal(joined.hostId, rc.hostId); assert.equal(rc.bind, '100.70.0.9'); assert.equal(rc.port, 47800); assert.equal(rc.mdns, false); assert.equal(rc.smsPrimary, undefined);
  assert.ok(rc.key.equals(ownerConfig.key)); assert.deepEqual(rc.peers.map((p) => p.hostId), [ownerConfig.hostId]);
  assert.equal((await join({ busDir: remote, token })).updated, true);
  const foreign = encodeJoinToken({ key: crypto.randomBytes(32).toString('hex'), peers: [{ hostId: crypto.randomUUID(), address: '100.90.0.4', port: 47800 }] });
  await assert.rejects(join({ busDir: remote, token: foreign }), /different agentbus group/);
});

test('1 GiB streams through the blob lane with flat memory', { skip: !process.env.AGENTBUS_TEST_LARGE, timeout: 600000 }, async (t) => {
  const { cb, peerA } = await wanPair(t);
  const dir = tmp(t), src = path.join(dir, 'g.bin'), task = crypto.randomUUID();
  const fd = fs.openSync(src, 'w'); const block = crypto.randomBytes(8 * 1024 * 1024);
  for (let i = 0; i < 128; i++) fs.writeSync(fd, block); fs.closeSync(fd);
  global.gc?.(); const before = process.memoryUsage().rss; let peak = before;
  const sample = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 50);
  const t0 = Date.now();
  const up = await uploadFile(cb, peerA, { task, name: 'g.bin', file: src });
  const down = await downloadFile(cb, peerA, { task, area: 'in', name: 'g.bin', dest: path.join(dir, 'back.bin') });
  clearInterval(sample);
  assert.equal(up.sha256, down.sha256);
  const deltaMiB = (peak - before) / 1024 ** 2;
  t.diagnostic(`1 GiB up+down in ${((Date.now() - t0) / 1000).toFixed(1)}s, peak rss delta ${deltaMiB.toFixed(0)} MiB`);
  assert.ok(deltaMiB < 256, `rss grew ${deltaMiB} MiB`);
});

test('an existing group member joining remotely keeps key, host id and mdns; fixes port 0 and a vanished bind', async (t) => {
  const root = tmp(t), owner = path.join(root, 'owner'), member = path.join(root, 'member');
  initLan({ busDir: owner, name: 'winbox', port: 47800 });
  const ownerConfig = loadLan(owner);
  initLan({ busDir: member, name: 'laptop', keyFile: path.join(owner, 'lan', 'key') }); // joined at the owner's place: port 0, default bind
  const cfgFile = path.join(member, 'lan', 'config.json');
  const before = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  fs.writeFileSync(cfgFile, JSON.stringify({ ...before, bind: '192.168.77.77' })); // a home-lan address this machine no longer has
  const { token } = await buildInvite({ busDir: owner, peerSpecs: ['self=100.90.0.4'], name: 'laptop', repo: 'https://github.com/example/agentbus' });
  const r = await join({ busDir: member, token, bind: '100.70.0.9' });
  assert.equal(r.updated, true); assert.equal(r.port, 47800); assert.equal(r.bind, '100.70.0.9');
  assert.ok(r.notes.some((n) => /os-assigned/.test(n)) && r.notes.some((n) => /192\.168\.77\.77/.test(n)));
  const after = loadLan(member);
  assert.equal(after.hostId, before.hostId); assert.ok(after.key.equals(ownerConfig.key)); assert.equal(after.mdns, undefined);
  assert.deepEqual(after.peers.map((p) => p.hostId), [ownerConfig.hostId]);
  // a valid 0.0.0.0 bind and fixed port are left alone
  fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')), bind: '0.0.0.0', port: 5555 }));
  const again = await join({ busDir: member, token });
  assert.equal(again.bind, '0.0.0.0'); assert.equal(again.port, 5555); assert.deepEqual(again.notes, []);
});

test('a learned peer that comes back on a new port is followed', async (t) => {
  const { A, cb, peerA } = await wanPair(t, { storage: false });
  await peerRequest(cb, peerA, { op: 'agents', listen: { port: 40001 } }, 3000);
  assert.equal(A.peers.get(cb.hostId).port, 40001);
  await peerRequest(cb, peerA, { op: 'agents', listen: { port: 40002 } }, 3000);
  assert.equal(A.peers.get(cb.hostId).port, 40002);
  assert.equal(A.peers.get(cb.hostId).learned, true);
});
