// tailnet peer discovery. mdns is link-local and never crosses tailscale, so a wan member used to peer only with the
// hosts in its join token (plus introduced provisioners and live pods): members who joined through one host never
// met the others. here every daemon reads its own node's view of the tailnet (`tailscale status --json`), probes the
// online nodes the tailnet owns on the agentbus port with the ordinary tls-psk inventory request, and keeps the ones
// that authenticate as learned peers, exactly like a dial-back. nothing is written to config: the group key stays the
// only admission test, discovery only produces candidates. a userspace-tailscale pod reads status the same way and
// dials out through its socks5 proxy as it already does for every peer.
//
// politeness: only nodes owned by this tailnet (no shared-in nodes unless "tailnetIncludeShared": true), never
// offline nodes or self, a bounded number of probes at a time, and a node that is not agentbus (or holds another key)
// is left alone for negativeTtlMs before it is tried again. names, users and keys of nodes that may not be members
// are never kept past a scan, logged or written anywhere; only a member that authenticated is ever named.
import net from 'node:net';
import { overlayIPv4, UUID, DEFAULT_WAN_PORT, tailnetDiscoveryEnabled } from './lan.mjs';
import { tailscaleStatusAsync } from './tailscale-cli.mjs';

export const DISCOVERY_DEFAULTS = Object.freeze({
  scanEveryMs: 60000, // read the node list once a minute; the 10s peer poll is untouched
  negativeTtlMs: 15 * 60000, // a non-member (or wrong-key) node gets one connect attempt per quarter hour
  concurrency: 4, // probes in flight at once, same as the peer refresh batch
  probeTimeoutMs: 5000,
  maxCandidates: 256, // per scan; a huge tailnet is sampled in order, never flooded
});
const loopback = (a) => net.isIP(a) === 4 && a.startsWith('127.');
const dnsSuffix = (status) => typeof status?.MagicDNSSuffix === 'string' && status.MagicDNSSuffix.trim() ? `.${status.MagicDNSSuffix.trim().replace(/^\.|\.$/g, '')}.`.toLowerCase() : null;
// the nodes worth a probe, as addresses only: online, not us, carrying a tailscale ipv4, and owned by this tailnet.
// tailscale marks the nodes of users we shared a device with as ShareeNode; a device shared *to* us lives under the
// other tailnet's magicdns suffix. both are skipped unless includeShared. a peer that is offline per tailscale is not
// dialed: the connect would only hang until the timeout.
export function tailnetCandidates(status, { includeShared = false, selfAddresses = [], allowLoopback = false } = {}) {
  if (!status || typeof status !== 'object' || status.BackendState !== 'Running' || !status.Peer || typeof status.Peer !== 'object') return [];
  const self = new Set([...selfAddresses, ...(Array.isArray(status.Self?.TailscaleIPs) ? status.Self.TailscaleIPs : []), ...(Array.isArray(status.TailscaleIPs) ? status.TailscaleIPs : [])].filter((a) => typeof a === 'string'));
  const suffix = dnsSuffix(status), out = [];
  for (const node of Object.values(status.Peer)) {
    if (!node || typeof node !== 'object' || node.Online !== true) continue;
    if (!includeShared && (node.ShareeNode === true || (suffix && typeof node.DNSName === 'string' && node.DNSName && !`${node.DNSName.toLowerCase().replace(/\.$/, '')}.`.endsWith(suffix)))) continue;
    const address = (Array.isArray(node.TailscaleIPs) ? node.TailscaleIPs : []).find((a) => overlayIPv4(a) || (allowLoopback && loopback(a)));
    if (!address || self.has(address) || out.includes(address)) continue;
    out.push(address);
  }
  return out;
}
// `status` may be sync or async; the daemon's is async so a slow tailscaled never holds its event loop.
export function createTailnetDiscovery({ config, probe, hasPeer, peerAt, add, status = tailscaleStatusAsync, selfAddresses = () => [], now = () => Date.now(), log = () => {}, allowLoopback = false, ...overrides }) {
  const opt = { ...DISCOVERY_DEFAULTS, ...overrides };
  const negatives = new Map(); // address -> retry-after: not agentbus on that port, another group's key, or a pre-discovery build
  const resolved = new Map(); // address -> hostId of a member that authenticated here (it may already peer over another route)
  let lastScanAt = 0, scanning = null, closed = false, quiet = false;
  const stats = { scans: 0, candidates: 0, probed: 0, found: 0, legacy: 0, cli: 'unknown' };
  const port = () => config.tailnetPort || DEFAULT_WAN_PORT;
  async function probeOne(address, p) {
    let r; try { r = await probe(address, p, opt.probeTimeoutMs); } catch (e) { r = { ok: false, error: e.message }; }
    if (closed) return;
    if (r?.ok && UUID.test(r.hostId || '') && r.hostId !== config.hostId) {
      resolved.set(address, r.hostId);
      if (hasPeer(r.hostId)) return; // already a peer by mdns, config or dial-back; that route stays
      stats.found++;
      add({ hostId: r.hostId, address, port: p, name: typeof r.name === 'string' ? r.name : '' });
      return;
    }
    // a member on a build before discovery proves the key (the handshake passed) but cannot answer an anonymous
    // probe; it will be found once it upgrades, and it still reaches us if we are in its token. naming it is fine.
    if (r?.error === 'wrong recipient host') { stats.legacy++; log(`tailnet discovery: ${address}:${p} is a group member on an older build; upgrade it so it can be discovered`); }
    negatives.set(address, now() + opt.negativeTtlMs);
  }
  // a scan in flight is joined, never doubled; the daemon fires this detached from its peer poll, so a tailnet full of
  // nodes that drop the port costs the poll nothing. a member found here is inventoried on the next poll.
  function scan({ force = false } = {}) {
    if (scanning) return scanning;
    if (closed || !tailnetDiscoveryEnabled(config) || (!force && now() - lastScanAt < opt.scanEveryMs)) return Promise.resolve(snapshot());
    lastScanAt = now();
    return scanning = run().finally(() => { scanning = null; });
  }
  async function run() {
    const s = await status();
    if (!s) {
      stats.cli = 'unavailable';
      if (!quiet) { log('tailnet discovery: tailscale status unavailable (no cli found, or tailscaled is not running); mdns, static and learned peers only'); quiet = true; }
      return snapshot();
    }
    stats.cli = s.BackendState === 'Running' ? 'ok' : `tailscale ${String(s.BackendState || 'state unknown').toLowerCase().slice(0, 24)}`;
    quiet = false;
    const p = port();
    const candidates = tailnetCandidates(s, { includeShared: config.tailnetIncludeShared === true, selfAddresses: selfAddresses(), allowLoopback }).slice(0, opt.maxCandidates);
    stats.scans++; stats.candidates = candidates.length;
    for (const [a, until] of negatives) if (until <= now()) negatives.delete(a);
    for (const [a, id] of resolved) if (!candidates.includes(a) || !hasPeer(id)) resolved.delete(a);
    const due = candidates.filter((a) => !negatives.has(a) && !resolved.has(a) && !peerAt(a, p));
    stats.probed = due.length;
    for (let i = 0; i < due.length && !closed; i += opt.concurrency) await Promise.all(due.slice(i, i + opt.concurrency).map((a) => probeOne(a, p)));
    return snapshot();
  }
  // counts only: no address or name of anything that did not authenticate leaves this module
  function snapshot() {
    const enabled = tailnetDiscoveryEnabled(config);
    return { enabled, port: port(), includeShared: config.tailnetIncludeShared === true, cli: stats.cli, scans: stats.scans, lastScanAt: lastScanAt || null, nextScanAt: enabled ? (lastScanAt ? lastScanAt + opt.scanEveryMs : now()) : null, candidates: stats.candidates, probed: stats.probed, found: stats.found, legacy: stats.legacy, negatives: negatives.size, negativeTtlMs: opt.negativeTtlMs, scanEveryMs: opt.scanEveryMs };
  }
  return { scan, snapshot, close() { closed = true; } };
}
