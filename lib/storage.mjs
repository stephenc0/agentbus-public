import { atomicWriteFileSync } from './atomic-file.mjs';
// Explicitly registered task volumes. Discovery never mounts paths or supplies credentials.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { UUID, localLanRequest } from './lan.mjs';

export const MARKER = '.agentbus-storage.json';
const file = (dir) => path.join(dir || process.env.AGENTBUS_DIR || path.join(os.homedir(), '.agentbus'), 'storage.json');
const clean = (s, n = 160) => typeof s === 'string' ? s.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, n) : '';
export function storageUri(value) {
  const u = new URL(value);
  if (u.protocol !== 'smb:' || u.username || u.password || u.search || u.hash || !u.hostname || !/^\/[^/]+\/?$/.test(u.pathname)) throw Error('use smb://host/share without credentials');
  return u.href.replace(/\/$/, '');
}
export function readStorage(dir) {
  try {
    const entries = JSON.parse(fs.readFileSync(file(dir), 'utf8'));
    if (!Array.isArray(entries) || entries.length > 32) throw Error('invalid storage registry');
    return entries.map((e) => {
      if (!UUID.test(e.id || '') || !UUID.test(e.ownerHostId || '') || !path.isAbsolute(e.localPath || '') || !['ro', 'rw'].includes(e.access)) throw Error('invalid storage entry');
      return { id: e.id, ownerHostId: e.ownerHostId, name: clean(e.name, 80), purpose: clean(e.purpose), protocol: 'smb', uri: storageUri(e.uri), localPath: e.localPath, access: e.access };
    });
  } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
function save(entries, dir) {
  const f = file(dir); fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });

  atomicWriteFileSync(f, JSON.stringify(entries, null, 2) + '\n', { mode: 0o600 });
}
export function registerStorage({ name, localPath, uri, ownerHostId, id, access = 'rw', purpose = 'shared task inputs and artifacts', create = false }, dir) {
  uri = storageUri(uri); localPath = path.resolve(localPath);
  if (!name || !UUID.test(ownerHostId || '') || !['ro', 'rw'].includes(access) || (id && !UUID.test(id))) throw Error('name, owner host UUID and ro/rw access required');
  if (!fs.statSync(localPath).isDirectory()) throw Error('storage path must be an existing directory');
  const markerFile = path.join(localPath, MARKER);
  if (create && !fs.existsSync(markerFile)) fs.writeFileSync(markerFile, JSON.stringify({ version: 1, id: id || crypto.randomUUID(), ownerHostId }) + '\n', { flag: 'wx' });
  const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
  if (marker.version !== 1 || !UUID.test(marker.id || '') || marker.ownerHostId !== ownerHostId || (id && marker.id !== id)) throw Error('storage identity marker mismatch');
  const entry = { id: marker.id, ownerHostId, name: clean(name, 80), purpose: clean(purpose), protocol: 'smb', uri, localPath, access };
  const entries = readStorage(dir).filter((e) => e.id !== entry.id);
  if (entries.length >= 32) throw Error('at most 32 storage entries');
  save([...entries, entry], dir); return entry;
}
export function removeStorage(id, dir) { save(readStorage(dir).filter((e) => e.id !== id), dir); }

// Only executed in a disposable child: disconnected network filesystems can block stat/read.
export function probeStorage(entry) {
  const result = { ...entry, checkedAt: Date.now(), status: 'unavailable', freeBytes: null, totalBytes: null };
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(entry.localPath, MARKER), 'utf8'));
    if (marker.version !== 1 || marker.id !== entry.id || marker.ownerHostId !== entry.ownerHostId) throw Error('identity mismatch');
    fs.accessSync(entry.localPath, fs.constants.R_OK | (entry.access === 'rw' ? fs.constants.W_OK : 0));
    const s = fs.statfsSync(entry.localPath);
    return { ...result, status: 'available', freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
  } catch { return result; }
}
export function boundedProbe(entry, { timeout = 2500 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--probe'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let output = '', done = false;
    const finish = (result) => { if (done) return; done = true; clearTimeout(timer); resolve(result || { ...entry, checkedAt: Date.now(), status: 'unavailable', freeBytes: null, totalBytes: null }); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(); }, timeout);
    child.stdout.on('data', (s) => { output += s; if (output.length > 16384) { child.kill('SIGKILL'); finish(); } });
    child.on('error', () => finish()); child.stdin.on('error', () => {});
    child.on('close', () => { try { finish(JSON.parse(output)); } catch { finish(); } });
    child.stdin.end(JSON.stringify(entry));
  });
}
export function sanitizeStorage(values, now = Date.now()) {
  return (Array.isArray(values) ? values : []).slice(0, 32).flatMap((v) => {
    try {
      if (!v || !UUID.test(v.id || '') || !UUID.test(v.ownerHostId || '') || !['ro', 'rw'].includes(v.access)) return [];
      return [{ id: v.id, ownerHostId: v.ownerHostId, name: clean(v.name, 80), purpose: clean(v.purpose), protocol: 'smb', uri: storageUri(v.uri), localPath: clean(v.localPath, 1024), access: v.access,
        status: v.status === 'available' && Number.isFinite(v.checkedAt) && now - v.checkedAt < 30000 && v.checkedAt <= now + 5000 ? 'available' : 'unavailable', checkedAt: Number(v.checkedAt) || 0,
        freeBytes: Number.isFinite(v.freeBytes) && v.freeBytes >= 0 ? v.freeBytes : null, totalBytes: Number.isFinite(v.totalBytes) && v.totalBytes >= 0 ? v.totalBytes : null }];
    } catch { return []; }
  });
}
export function storageTracker({ dir, probe = boundedProbe } = {}) {
  let current = [];
  return {
    current: () => sanitizeStorage(current),
    async update() {
      let entries; try { entries = readStorage(dir); } catch { current = []; return; }
      const results = [];
      for (let i = 0; i < entries.length; i += 4) results.push(...await Promise.all(entries.slice(i, i + 4).map(probe)));
      current = results;
    },
  };
}
export function storageAdvertisement(hostId, entry) {
  return { v: '1', host: hostId, id: entry.id, owner: entry.ownerHostId, protocol: 'smb', access: entry.access, state: entry.status };
}
export async function storageStatus() {
  const status = await localLanRequest({ op: 'status' }, { timeout: 3000 });
  if (!status.ok) return status;
  const hosts = [{ hostId: status.hostId, hostName: status.name, remote: false, storage: sanitizeStorage(status.storage) },
    ...(status.peers || []).filter((p) => !p.error && Date.now() - p.checkedAt < 30000).map((p) => ({ hostId: p.hostId, hostName: p.name, remote: true, storage: sanitizeStorage(p.storage) }))];
  return { ok: true, hosts, guidance: 'use a path only on the host that advertises it; require available status and matching storage id on both hosts. access is configured plus filesystem permission checks, not a reservation or write guarantee. use per-task directories; do not concurrently modify the same files.' };
}
export function formatStorage(status) {
  if (!status.ok) return JSON.stringify(status);
  return status.hosts.flatMap((h) => h.storage.map((s) => `${s.name} [${s.id}] @${h.hostName}: ${s.status} ${s.access} ${s.freeBytes === null ? '?' : (s.freeBytes / 1024 ** 3).toFixed(1)} GiB free\n  ${s.localPath}\n  ${s.uri}`)).join('\n') || 'no shared storage registered';
}
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--probe') {
  let input = ''; for await (const chunk of process.stdin) input += chunk;
  console.log(JSON.stringify(probeStorage(JSON.parse(input))));
}
