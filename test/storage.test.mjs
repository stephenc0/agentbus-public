import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { MARKER, registerStorage, readStorage, removeStorage, boundedProbe, sanitizeStorage, storageAdvertisement, storageTracker, storageUri } from '../lib/storage.mjs';

test('same volume has a stable identity on two hosts; missing mounts and wrong volumes fail closed', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-storage-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const volume = path.join(root, 'volume'); fs.mkdirSync(volume);
  const owner = crypto.randomUUID();
  const entry = registerStorage({ name: 'tasks', localPath: volume, uri: 'smb://pc/agentbus-tasks', ownerHostId: owner, create: true }, path.join(root, 'owner'));
  const mounted = registerStorage({ name: 'tasks', localPath: volume, uri: entry.uri, ownerHostId: owner, id: entry.id }, path.join(root, 'client'));
  assert.equal(mounted.id, entry.id);
  const state = await boundedProbe(mounted); assert.equal(state.status, 'available'); assert(state.totalBytes > 0); assert(state.freeBytes >= 0);
  const marker = fs.readFileSync(path.join(volume, MARKER));
  fs.unlinkSync(path.join(volume, MARKER));
  assert.equal((await boundedProbe(mounted)).status, 'unavailable');
  fs.writeFileSync(path.join(volume, MARKER), JSON.stringify({ version: 1, id: crypto.randomUUID(), ownerHostId: owner }));
  assert.equal((await boundedProbe(mounted)).status, 'unavailable');
  assert.throws(() => registerStorage({ ...mounted }, path.join(root, 'client')), /mismatch/);
  fs.writeFileSync(path.join(volume, MARKER), marker);
  removeStorage(entry.id, path.join(root, 'owner')); assert.deepEqual(readStorage(path.join(root, 'owner')), []);
  assert(fs.existsSync(path.join(volume, MARKER))); // unregister is never data deletion
});

test('credentials are rejected, stale availability expires and mdns omits paths and urls', () => {
  for (const uri of ['smb://user:secret@pc/share', 'smb://user@pc/share', 'https://pc/share', 'smb://pc/share?password=x']) assert.throws(() => storageUri(uri));
  const state = { id: crypto.randomUUID(), ownerHostId: crypto.randomUUID(), name: 'tasks', uri: 'smb://pc/share', localPath: 'C:\\tasks', access: 'rw', status: 'available', checkedAt: Date.now(), freeBytes: 123, totalBytes: 999 };
  assert.equal(sanitizeStorage([state])[0].status, 'available');
  assert.equal(sanitizeStorage([state], Date.now() + 31000)[0].status, 'unavailable');
  assert.deepEqual(sanitizeStorage([{ ...state, uri: 'smb://u:p@pc/share' }]), []);
  const txt = storageAdvertisement(crypto.randomUUID(), state);
  assert.equal(txt.uri, undefined); assert.equal(txt.localPath, undefined); assert.equal(txt.name, undefined);
});

test('registry removal and corruption withdraw availability', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-reg-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tracker = storageTracker({ dir: root }); await tracker.update(); assert.deepEqual(tracker.current(), []);
  fs.writeFileSync(path.join(root, 'storage.json'), 'invalid'); await tracker.update(); assert.deepEqual(tracker.current(), []);
});
