import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOwnerAclCache, probeWindowsOwnerAcl } from '../lib/owner-acl-cache.mjs';
import { restrictToOwner } from '../lib/lan.mjs';

test('ACL discovery is nonblocking and concurrent cold requests batch once', async () => {
  let release, calls = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const cache = createOwnerAclCache({ stat: () => 'stable', probe: async (files) => { calls++; await gate; return new Map(files.map((f) => [f, true])); } });
  assert.equal(cache.snapshot(['one', 'two']).size, 0);
  assert.equal(cache.snapshot(['one', 'two']).size, 0);
  const verified = cache.verify(['one', 'two']);
  // Timers continue while native work is pending.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 1);
  release(); assert.equal((await verified).size, 2);
  assert.equal(cache.snapshot(['one', 'two']).size, 2);
  assert.equal(calls, 2, 'delivery revalidates after the pre-existing discovery proof');
});

test('stale, failed, replaced, removed or changed-during-probe ACL proofs fail closed', async () => {
  let now = 0, signature = 'one', succeeds = true, change = false;
  const cache = createOwnerAclCache({ now: () => now, ttlMs: 100, stat: () => { if (!signature) throw Error('gone'); return signature; },
    probe: async (files) => { if (change) signature = 'raced'; if (!succeeds) throw Error('probe failed'); return new Map(files.map((f) => [f, true])); } });
  assert.equal((await cache.verify(['file'])).size, 1);
  now = 101; succeeds = false;
  assert.equal(cache.snapshot(['file']).size, 0);
  assert.equal((await cache.verify(['file'])).size, 0);
  succeeds = true;
  assert.equal((await cache.verify(['file'])).size, 1);
  signature = 'replacement';
  assert.equal(cache.snapshot(['file']).size, 0);
  await cache.verify(['file']);
  change = true;
  assert.equal((await cache.verify(['file'])).size, 0);
  change = false; await cache.verify(['file']); signature = null;
  assert.equal(cache.snapshot(['file']).size, 0);
});

test('delivery forces fresh ACL validation even while cached discovery proof is fresh', async () => {
  let calls = 0, allowed = true;
  const cache = createOwnerAclCache({ stat: () => 'unchanged', probe: async (files) => { calls++; return new Map(files.map((f) => [f, allowed])); } });
  assert.equal((await cache.verify(['file'])).size, 1);
  assert.equal(cache.snapshot(['file']).size, 1);
  allowed = false;
  assert.equal((await cache.verify(['file'])).size, 0);
  assert.equal(calls, 2);
  assert.equal(cache.snapshot(['file']).size, 0);
});

test('ACL probe selection and retention are bounded', async () => {
  const counts = [];
  const cache = createOwnerAclCache({ maxEntries: 2, stat: () => 'same', probe: async (files) => { counts.push(files.length); return new Map(files.map((f) => [f, true])); } });
  assert.equal((await cache.verify(['a', 'b', 'c'])).size, 2);
  assert.deepEqual(counts, [2]);
  assert.equal((await cache.verify(['c'])).size, 1);
  assert(cache.snapshot(['a', 'b', 'c']).size <= 2);
});

test('native windows async ACL proof preserves strict DACL checks including Unicode paths', { skip: process.platform !== 'win32', timeout: 20000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-async-acl-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  restrictToOwner(root);
  const file = path.join(root, '日本語.txt'); fs.writeFileSync(file, 'synthetic'); restrictToOwner(file);
  const originalModulePath = process.env.PSModulePath;
  process.env.PSModulePath = path.join(root, 'unrelated-pwsh-modules');
  t.after(() => { if (originalModulePath === undefined) delete process.env.PSModulePath; else process.env.PSModulePath = originalModulePath; });
  const result = await probeWindowsOwnerAcl([file, path.join(root, 'absent')]);
  assert.equal(result.get(file), true); assert.equal(result.get(path.join(root, 'absent')), false);
  // A DACL-only mutation may leave ordinary file stat identity unchanged.
  // Delivery still must observe it: it never relies solely on stat fingerprints.
  const { execFileSync } = await import('node:child_process');
  execFileSync(path.join(process.env.SystemRoot, 'System32', 'icacls.exe'), [file, '/grant', '*S-1-5-32-545:R'], { windowsHide: true });
  assert.equal((await probeWindowsOwnerAcl([file])).get(file), false);
});
