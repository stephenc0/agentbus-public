import fs from 'node:fs';
import crypto from 'node:crypto';

const sleeper = new Int32Array(new SharedArrayBuffer(4));
const transient = new Set(['EPERM', 'EACCES', 'EBUSY']);
// Windows readers can briefly deny rename/delete sharing. Never unlink the
// destination: readers must see either the previous complete value or the new one.
export function replaceFileSync(source, destination, { rename = fs.renameSync, platform = process.platform, timeoutMs = 250, now = Date.now, sleep = (ms) => Atomics.wait(sleeper, 0, 0, ms) } = {}) {
  const end = now() + timeoutMs;
  for (;;) {
    try { rename(source, destination); return; }
    catch (error) {
      if (platform !== 'win32' || !transient.has(error.code) || now() >= end) throw error;
      sleep(Math.min(10, Math.max(1, end - now())));
    }
  }
}
export function atomicWriteFileSync(file, data, options = { mode: 0o600 }, retryOptions) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, data, { ...options, flag: 'wx' });
    replaceFileSync(temporary, file, retryOptions);
  } finally { try { fs.rmSync(temporary, { force: true }); } catch { /* preserve original write failure */ } }
}

// A runtime owner must not die merely because a status reader briefly locks its
// receipt. Keep only the latest complete state and keep this timer referenced:
// terminal cleanup cannot silently exit before its terminal receipt is durable.
export function createRetryingWriter(write, { retryMs = 250, maxRetryMs = 5000, onError = () => {} } = {}) {
  let pending, dirty = false, timer, failures = 0;
  const flush = () => {
    timer = undefined;
    if (!dirty) return true;
    try { write(pending); dirty = false; failures = 0; return true; }
    catch (error) {
      onError(error);
      timer = setTimeout(flush, Math.min(maxRetryMs, retryMs * 2 ** Math.min(failures++, 8)));
      return false;
    }
  };
  return {
    update(value) { pending = value; dirty = true; if (!timer) return flush(); return false; },
    get pending() { return dirty; },
  };
}
