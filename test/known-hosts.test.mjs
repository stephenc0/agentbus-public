import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createKnownHosts, shareKnownHosts, sanitizeSharedKnownHosts, linkKind, SHARED_KNOWN_HOSTS_FEATURE } from '../lib/known-hosts.mjs';
import { buildInfo } from '../lib/build-info.mjs';
import { summarizeNetworkPresence } from '../lib/presence.mjs';

test('authenticated host identity persists across discovery loss/restart, and retires only explicitly', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-known-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'hosts.json'), selfId = crypto.randomUUID(), hostId = crypto.randomUUID();
  const registry = createKnownHosts(file, { selfId });
  assert.equal(registry.observe({ hostId: 'fake', checkedAt: 1 }), false);
  registry.observe({ hostId, name: 'windows', checkedAt: 1, address: '127.0.0.1', agents: [{ id: 'secret' }] });
  const recovered = createKnownHosts(file, { selfId });
  assert.deepEqual(recovered.snapshot(), [{ hostId, name: 'windows', lastAuthenticatedAt: 1, link: 'lan' }], 'link kind persists, the address does not');
  const local = { hostId: selfId, presence: { at: 1000000, user: 'away' } };
  const result = summarizeNetworkPresence({ local, knownHosts: recovered.snapshot() }, { now: 1000000 });
  assert.equal(result.anyHostActive, null); assert.equal(result.hostCoverage, 'partial'); assert.equal(result.sources[1].host_activity.state, 'unknown');
  recovered.forget(hostId);
  assert.equal(createKnownHosts(file, { selfId }).snapshot().length, 0);
  assert.equal(summarizeNetworkPresence({ local, knownHosts: recovered.snapshot() }, { now: 1000000 }).anyHostActive, false);
});

test('registry bounds/corruption never silently restore complete presence coverage', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-known-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'hosts.json'), registry = createKnownHosts(file, { maxHosts: 1 });
  registry.observe({ hostId: crypto.randomUUID(), checkedAt: 1 }); registry.observe({ hostId: crypto.randomUUID(), checkedAt: 2 });
  assert.equal(registry.complete, false); assert.equal(registry.snapshot().length, 1);
  assert.equal(createKnownHosts(file, { maxHosts: 1 }).complete, false);
  fs.writeFileSync(file, '{broken');
  assert.equal(createKnownHosts(file).complete, false);
  const result = summarizeNetworkPresence({ local: { presence: { at: 10, user: 'away' } }, coverageKnown: false }, { now: 10 });
  assert.equal(result.anyHostActive, null); assert.equal(result.hostCoverage, 'partial');
});

test('shared known hosts carry identity, timestamp and lan|wan link only; old builds read as unknown, not empty', () => {
  const id = crypto.randomUUID(), build = { features: [SHARED_KNOWN_HOSTS_FEATURE] };
  assert(buildInfo.features.includes(SHARED_KNOWN_HOSTS_FEATURE));
  assert.deepEqual(shareKnownHosts([{ hostId: id, name: 'n', lastAuthenticatedAt: 5, address: '10.0.0.1' }]), [{ hostId: id, name: 'n', lastAuthenticatedAt: 5 }]);
  assert.equal(sanitizeSharedKnownHosts({ knownHosts: [] }), null, 'no feature flag: old build');
  assert.equal(sanitizeSharedKnownHosts({ build: { features: ['wan-peers-v1'] }, knownHosts: [{ hostId: id, lastAuthenticatedAt: 1 }] }), null);
  assert.equal(sanitizeSharedKnownHosts({ build }), null);
  const got = sanitizeSharedKnownHosts({ build, knownHosts: [{ hostId: id, name: 'x\u001b', lastAuthenticatedAt: 7, address: '1.2.3.4', agents: [1], presence: {} }, { hostId: 'bad', lastAuthenticatedAt: 1 }, { hostId: crypto.randomUUID(), lastAuthenticatedAt: -1 }, null] });
  assert.deepEqual(got, [{ hostId: id, name: 'x ', lastAuthenticatedAt: 7 }]);
  const linked = sanitizeSharedKnownHosts({ build, knownHosts: [{ hostId: id, lastAuthenticatedAt: 7, link: 'wan' }, { hostId: id, lastAuthenticatedAt: 7, link: 'lan' }, ...['tailscale', 'WAN', 1, null, { k: 1 }].map((link) => ({ hostId: id, lastAuthenticatedAt: 7, link }))] });
  assert.deepEqual(linked.map((h) => h.link), ['wan', 'lan', undefined, undefined, undefined, undefined, undefined]);
  assert.ok(linked.slice(2).every((h) => !('link' in h)), 'anything but lan|wan drops the field');
  assert.deepEqual(shareKnownHosts([{ hostId: id, name: 'n', lastAuthenticatedAt: 5, link: 'wan', address: '100.101.2.3' }]), [{ hostId: id, name: 'n', lastAuthenticatedAt: 5, link: 'wan' }]);
  assert.equal(sanitizeSharedKnownHosts({ build, knownHosts: Array.from({ length: 300 }, () => ({ hostId: crypto.randomUUID(), lastAuthenticatedAt: 1 })) }).length, 256);
});

test('known hosts record the coarse link kind of the last authenticated address; a lan<->wan move re-saves at once', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-known-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'hosts.json'), hostId = crypto.randomUUID();
  assert.equal(linkKind('100.101.2.3'), 'wan'); assert.equal(linkKind('192.168.1.20'), 'lan'); assert.equal(linkKind('10.0.0.4'), 'lan');
  assert.equal(linkKind('winbox.local'), undefined); assert.equal(linkKind('8.8.8.8'), undefined); assert.equal(linkKind('fd7a:115c::1'), undefined); assert.equal(linkKind(undefined), undefined);
  const r = createKnownHosts(file);
  const onDisk = () => JSON.parse(fs.readFileSync(file, 'utf8')).hosts[0];
  r.observe({ hostId, name: 'laptop', checkedAt: 1000, address: '192.168.1.20' });
  assert.equal(onDisk().link, 'lan'); assert.equal(onDisk().address, undefined);
  r.observe({ hostId, name: 'laptop', checkedAt: 2000, address: '192.168.1.20' });
  assert.equal(onDisk().lastAuthenticatedAt, 1000, 'same link inside the minute: debounced');
  r.observe({ hostId, name: 'laptop', checkedAt: 3000, address: '100.101.2.3' });
  assert.deepEqual(onDisk(), { hostId, name: 'laptop', lastAuthenticatedAt: 3000, link: 'wan' }, 'link change persists immediately');
  r.observe({ hostId, name: 'laptop', checkedAt: 4000, address: 'laptop.tail1234.ts.net' });
  assert.equal('link' in onDisk(), false, 'unclassifiable address: no link rather than a stale one');
  assert.equal('link' in r.snapshot()[0], false);
  // an older registry without link (and junk link values) still loads; schemaVersion stays 1
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, complete: true, hosts: [{ hostId, name: 'old', lastAuthenticatedAt: 5 }, { hostId: crypto.randomUUID(), name: 'junk', lastAuthenticatedAt: 6, link: 'carrier pigeon' }] }));
  const old = createKnownHosts(file);
  assert.equal(old.complete, true); assert.deepEqual(old.snapshot().map((h) => 'link' in h), [false, false]);
});
