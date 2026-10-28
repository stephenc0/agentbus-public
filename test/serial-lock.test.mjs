import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { acquire, serialize } from './serial-lock.mjs';

test('test lock: exclusive, reclaims a dead holder, and serialize releases only after the test cleanup ran', async (t) => {
  const name = `selftest-${crypto.randomUUID()}`, dir = path.join(os.tmpdir(), `agentbus-test-lock-${name}`);
  const release = await acquire(name);
  let second = false; const waiting = acquire(name).then((r) => { second = true; return r; });
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(second, false, 'a second holder waits');
  release(); (await waiting)();
  // a holder that died without releasing is reclaimed
  fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'owner'), '999999999');
  (await acquire(name, { timeoutMs: 5000 }))();
  // serialize: the lock is still held while the test's own cleanup hooks run, and released after them
  const order = [];
  await t.test('inner', async (tt) => {
    await serialize(tt, name);
    tt.after(() => order.push(`cleanup sees lock: ${fs.existsSync(dir)}`));
    tt.after(() => order.push('cleanup 2'));
  });
  assert.deepEqual(order, ['cleanup sees lock: true', 'cleanup 2']);
  assert.equal(fs.existsSync(dir), false, 'released after cleanup');
});
