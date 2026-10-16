import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { replaceFileSync, atomicWriteFileSync, createRetryingWriter } from '../lib/atomic-file.mjs';

test('windows rename retries transient sharing errors without removing the previous receipt', () => {
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    let calls = 0, clock = 0;
    replaceFileSync('source', 'destination', { platform: 'win32', now: () => clock, sleep: (ms) => { clock += ms; }, rename: () => { if (++calls < 4) throw Object.assign(Error('sharing'), { code }); } });
    assert.equal(calls, 4); assert.equal(clock, 30);
  }
});
test('persistent and non-sharing errors are bounded, with previous value intact and temporary cleaned', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-atomic-'));
  try {
    const file = path.join(dir, 'receipt.json'); fs.writeFileSync(file, 'old');
    let clock = 0, calls = 0;
    assert.throws(() => atomicWriteFileSync(file, 'new', {}, { platform: 'win32', timeoutMs: 20, now: () => clock, sleep: (ms) => { clock += ms; }, rename: () => { calls++; throw Object.assign(Error('locked'), { code: 'EPERM' }); } }), /locked/);
    assert.equal(clock, 20); assert.equal(calls, 3); assert.equal(fs.readFileSync(file, 'utf8'), 'old'); assert.deepEqual(fs.readdirSync(dir), ['receipt.json']);
    for (const [platform, code] of [['win32', 'ENOSPC'], ['darwin', 'EPERM']]) {
      let calls = 0;
      assert.throws(() => replaceFileSync('a', 'b', { platform, rename: () => { calls++; throw Object.assign(Error('fatal'), { code }); } }), /fatal/);
      assert.equal(calls, 1);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('runtime receipt persistence survives errors and coalesces to the latest terminal state', async () => {
  let failing = true, saved, errors = 0;
  const writer = createRetryingWriter((value) => { if (failing) throw Error('locked'); saved = value; }, { retryMs: 5, onError: () => errors++ });
  writer.update({ state: 'running' }); writer.update({ state: 'stopped' });
  assert.equal(writer.pending, true); assert.equal(saved, undefined);
  failing = false;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(saved, { state: 'stopped' }); assert.equal(writer.pending, false); assert.equal(errors, 1);
});
