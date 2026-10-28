// cross-process mutex for tests that must not overlap even though node --test runs files in parallel processes,
// e.g. the windows tests that spawn and kill powershell process trees (their snapshots see each other's processes).
// usage inside a test: t.after(await acquire('process-trees'));
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
export async function acquire(name, { timeoutMs = 300000 } = {}) {
  const dir = path.join(os.tmpdir(), `agentbus-test-lock-${name}`), owner = path.join(dir, 'owner');
  const end = Date.now() + timeoutMs;
  for (;;) {
    try { fs.mkdirSync(dir); fs.writeFileSync(owner, String(process.pid)); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // a holder that died leaves the dir behind: reclaim it. a dir without an owner file yet is a holder mid-acquire,
      // stale only if old.
      let pid = null; try { pid = Number(fs.readFileSync(owner, 'utf8')); } catch {}
      let age = 0; try { age = Date.now() - fs.statSync(dir).mtimeMs; } catch { continue; }
      if ((pid && !alive(pid)) || (!pid && age > 30000)) { fs.rmSync(dir, { recursive: true, force: true }); continue; }
      if (Date.now() > end) throw Error(`test lock ${name} held by pid ${pid} for too long`);
      await sleep(250);
    }
  }
  return () => fs.rmSync(dir, { recursive: true, force: true });
}
// hold the lock for the whole test including its cleanup. t.after hooks run in registration order, so a release
// registered first would run before the test's own cleanup (which kills its process trees). instead every later
// t.after is collected and run, in order, inside one hook that releases the lock last.
export async function serialize(t, name, opts) {
  const release = await acquire(name, opts), hooks = [], after = t.after.bind(t);
  after(async () => { try { for (const h of hooks) await h(); } finally { release(); } });
  t.after = (fn) => { hooks.push(fn); };
}
