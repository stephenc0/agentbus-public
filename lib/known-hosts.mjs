import fs from 'node:fs';
import { atomicWriteFileSync } from './atomic-file.mjs';
import { overlayIPv4, privateIPv4 } from './lan.mjs';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const clean = (v) => typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 100) : '';
// Authenticated identity history only. Never supplies addresses, agents, routes,
// fresh presence, or credentials. Missing hosts remain unknown until forgotten.
// `link` is the coarse kind of the address a host last authenticated over: 'wan' for an overlay
// (tailscale 100.64/10) address, 'lan' for a private one, absent otherwise (hostnames, unknown).
export const LINKS = ['lan', 'wan'];
export const linkKind = (address) => overlayIPv4(address) ? 'wan' : privateIPv4(address, true) ? 'lan' : undefined;
const withLink = (entry, link, role) => ({ ...entry, ...(LINKS.includes(link) ? { link } : {}), ...(role === 'host' ? { role: 'host' } : {}) });
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
      hosts.set(h.hostId, withLink({ hostId: h.hostId, name: clean(h.name), lastAuthenticatedAt: h.lastAuthenticatedAt }, h.link, h.role));
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
      const old = hosts.get(h.hostId), name = clean(h.name), link = linkKind(h.address);
      if (!old && hosts.size >= maxHosts) { complete = false; return save(); }
      // Persist once a minute, not on every status poll; identity is never aged out.
      const role = h.role === 'host' ? 'host' : undefined;
      if (old && old.name === name && old.link === link && old.role === role && h.checkedAt - old.lastAuthenticatedAt < 60000 && storageHealthy) return true;
      hosts.set(h.hostId, withLink({ hostId: h.hostId, name, lastAuthenticatedAt: h.checkedAt }, link, role)); return save();
    },
    forget(hostId) { if (!uuid.test(hostId || '') || hostId === selfId) throw Error('invalid host id'); hosts.delete(hostId); if (!save()) throw Error('could not persist explicit host removal'); },
  };
}
// A peer's own registry as shared over authenticated inventory: identity, last-authenticated time and the coarse
// link kind only (never an address), so a host that peers with only one daemon (a wan joiner on the storage owner)
// still shows recent contact and how that peer reaches it.
// Never merged into our registry or presence coverage; it is the peer's claim, attributed to that peer.
export const SHARED_KNOWN_HOSTS_FEATURE = 'shared-known-hosts-v1';
export const shareKnownHosts = (snapshot) => snapshot.map(({ hostId, name, lastAuthenticatedAt, link, role }) => withLink({ hostId, name, lastAuthenticatedAt }, link, role));
export function sanitizeSharedKnownHosts(response, { max = 256 } = {}) {
  // an old build neither sends the field nor advertises the feature: unknown, not an empty registry.
  if (!response?.build?.features?.includes?.(SHARED_KNOWN_HOSTS_FEATURE) || !Array.isArray(response.knownHosts)) return null;
  return response.knownHosts.filter((h) => uuid.test(h?.hostId || '') && Number.isFinite(h.lastAuthenticatedAt) && h.lastAuthenticatedAt >= 0)
    .slice(0, max).map((h) => withLink({ hostId: h.hostId, name: clean(h.name), lastAuthenticatedAt: h.lastAuthenticatedAt }, h.link, h.role));
}
