import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createKnownHosts } from '../lib/known-hosts.mjs';
import { summarizeNetworkPresence } from '../lib/presence.mjs';

test('authenticated host identity persists across discovery loss/restart, and retires only explicitly', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-known-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'hosts.json'), selfId = crypto.randomUUID(), hostId = crypto.randomUUID();
  const registry = createKnownHosts(file, { selfId });
  assert.equal(registry.observe({ hostId: 'fake', checkedAt: 1 }), false);
  registry.observe({ hostId, name: 'windows', checkedAt: 1, address: '127.0.0.1', agents: [{ id: 'secret' }] });
  const recovered = createKnownHosts(file, { selfId });
  assert.deepEqual(recovered.snapshot(), [{ hostId, name: 'windows', lastAuthenticatedAt: 1 }]);
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
