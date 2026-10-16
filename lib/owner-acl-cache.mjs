// Discovery may use only fresh ACL proof; delivery explicitly waits for revalidation.
// Native probes never run synchronously in a daemon request handler.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ownerOnlySddl } from './lan.mjs';

function fingerprint(file) {
  const s = fs.lstatSync(file);
  if (!s.isFile() || s.isSymbolicLink()) throw Error('not a regular registration file');
  return [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(':');
}
export function probeWindowsOwnerAcl(files) {
  if (!files.length) return Promise.resolve(new Map());
  if (files.length > 128) return Promise.reject(Error('too many ACL paths'));
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    const child = execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      fileURLToPath(new URL('./windows-owner-acl.ps1', import.meta.url))],
    { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(error);
      try {
        const r = JSON.parse(stdout);
        if (!/^S-1-[0-9-]+$/.test(r.sid || '') || !Array.isArray(r.results)) throw Error('invalid ACL probe response');
        const values = new Map();
        for (const file of files) {
          const matches = r.results.filter((item) => item.path === file);
          values.set(file, matches.length === 1 && !matches[0].error && ownerOnlySddl(matches[0].sddl, r.sid, r.localAdminSid));
        }
        resolve(values);
      } catch (e) { reject(e); }
    });
    child.stdin.on('error', () => {}); // execFile's callback owns spawn/timeout errors
    child.stdin.end(JSON.stringify(files));
  });
}

export function createOwnerAclCache({ probe = probeWindowsOwnerAcl, stat = fingerprint, now = Date.now, ttlMs = 15000, retryMs = 1000, maxEntries = 128 } = {}) {
  const entries = new Map();
  let pending = null;
  function identity(file) { try { return stat(file); } catch { entries.delete(file); return null; } }
  function checked(file) {
    const signature = identity(file), entry = entries.get(file);
    return signature && entry?.signature === signature && now() >= entry.at && now() - entry.at < ttlMs ? entry : null;
  }
  function refresh(files, { force = false } = {}) {
    // Concurrent callers share the in-flight proof; any additional files are
    // picked up afterwards. Never launch one PowerShell child per session.
    if (pending) return pending.then(() => refresh(files));
    const batch = [...new Set(files)].slice(0, maxEntries).filter((file) => {
      const entry = checked(file);
      return force || !entry || now() - entry.at >= (entry.ok ? ttlMs / 2 : retryMs);
    });
    if (!batch.length) return Promise.resolve();
    const before = new Map(batch.map((file) => [file, identity(file)]));
    pending = (async () => {
      let result;
      try { result = await probe(batch.filter((file) => before.get(file))); } catch { result = new Map(); }
      for (const file of batch) {
        const signature = identity(file);
        entries.set(file, { signature, at: now(), ok: !!signature && before.get(file) === signature && result.get(file) === true });
      }
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    })().finally(() => { pending = null; });
    return pending;
  }
  function snapshot(files) {
    void refresh(files).catch(() => {});
    return new Set(files.filter((file) => checked(file)?.ok));
  }
  async function verify(files) {
    // An earlier discovery query may have read the DACL before this send.
    // Wait it out, then begin a new proof rather than adopt its cached result.
    if (pending) await pending;
    await refresh(files, { force: true });
    return new Set(files.filter((file) => checked(file)?.ok));
  }
  return { snapshot, verify, checkedAt: (file) => checked(file)?.at ?? null };
}
