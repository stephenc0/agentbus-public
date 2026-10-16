import fs from 'node:fs';
import { atomicWriteFileSync } from './atomic-file.mjs';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const clean = (v) => typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 100) : '';
// Authenticated identity history only. Never supplies addresses, agents, routes,
// fresh presence, or credentials. Missing hosts remain unknown until forgotten.
export function createKnownHosts(file, { selfId, maxHosts = 256 } = {}) {
  const hosts = new Map(); let complete = true, storageHealthy = true;
  try {
    const text = fs.readFileSync(file, 'utf8');
    if (text.length > 256 * 1024) throw Error('host registry too large');
    const value = JSON.parse(text);
    if (value.schemaVersion !== 1 || !Array.isArray(value.hosts) || value.hosts.length > maxHosts || typeof value.complete !== 'boolean') throw Error('invalid host registry');
    complete = value.complete;
    for (const h of value.hosts) {
      if (!uuid.test(h?.hostId || '') || h.hostId === selfId || !Number.isFinite(h.lastAuthenticatedAt) || h.lastAuthenticatedAt < 0) throw Error('invalid known host');
      hosts.set(h.hostId, { hostId: h.hostId, name: clean(h.name), lastAuthenticatedAt: h.lastAuthenticatedAt });
    }
  } catch (e) { if (e.code !== 'ENOENT') complete = false; }
  const save = () => {
    try { atomicWriteFileSync(file, JSON.stringify({ schemaVersion: 1, complete, hosts: [...hosts.values()] })); storageHealthy = true; return true; }
    catch { storageHealthy = false; return false; }
  };
  return {
    get complete() { return complete && storageHealthy; },
    snapshot() { return [...hosts.values()].map(h => ({ ...h })); },
    observe(h) {
      if (!uuid.test(h?.hostId || '') || h.hostId === selfId || !Number.isFinite(h.checkedAt) || h.checkedAt < 0) return false;
      const old = hosts.get(h.hostId), name = clean(h.name);
      if (!old && hosts.size >= maxHosts) { complete = false; return save(); }
      // Persist once a minute, not on every status poll; identity is never aged out.
      if (old && old.name === name && h.checkedAt - old.lastAuthenticatedAt < 60000 && storageHealthy) return true;
      hosts.set(h.hostId, { hostId: h.hostId, name, lastAuthenticatedAt: h.checkedAt }); return save();
    },
    forget(hostId) { if (!uuid.test(hostId || '') || hostId === selfId) throw Error('invalid host id'); hosts.delete(hostId); if (!save()) throw Error('could not persist explicit host removal'); },
  };
}
