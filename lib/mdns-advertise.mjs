// the mdns host agentbus advertises is its own, never the machine's.
//
// bonjour-service defaults a published service's host to os.hostname() and answers A queries for that name with
// every non-internal ipv4 it finds, unprobed. on macos kern.hostname flaps between the dhcp name (`mac-mini`) and
// `<LocalHostName>.local`; whenever it is the .local form the daemon is a second responder for the OS's own unique
// mdns name. with one ipv4 the rdata matches mDNSResponder's and nothing happens. the moment a second ipv4 exists
// (wifi joined alongside ethernet, an iphone usb tether, link-local, tailscale) the daemon answers with an address
// mDNSResponder does not own on that link, mDNSResponder calls it a name conflict and renames the machine -2, -3, ...
// and the daemon follows the new name (2026-11-22, mac-mini: one daemon had SRV targets `mac-mini.` and
// `mac-mini-2.local.` at once).
//
// so every service targets `agentbus-<hostId>.local`, a name only this daemon answers for, and its A records carry
// only the addresses a peer should dial: the resolved mdns interface, else each private, non-link-local, non-overlay
// ipv4. peers dial the announcement's source address first (lan-daemon discoveryPeer) and fall back to these, so an
// older build on the other end keeps discovering us; the service name, txt and port are unchanged.
import os from 'node:os';
import { Service } from 'bonjour-service';
import { privateIPv4 } from './lan.mjs';

export const advertisedHost = (hostId) => `agentbus-${hostId}.local`;

export function advertisedAddresses(iface, interfaces = os.networkInterfaces()) {
  if (iface) return [iface];
  const dialable = (a) => a && a.family === 'IPv4' && !a.internal && privateIPv4(a.address) && !a.address.startsWith('169.254.');
  return [...new Set(Object.values(interfaces).flat().filter(dialable).map((a) => a.address))];
}

class OwnedService extends Service {
  constructor(config, addresses, start, stop) {
    if (!config.host) throw Error('an owned service needs an explicit host');
    super(config, start, stop);
    this.advertisedAddresses = [...addresses];
  }
  // same shape as bonjour-service's Service.records() minus its os.networkInterfaces() walk: A records only for the
  // addresses handed in, never AAAA, never the OS hostname.
  records() {
    const records = [this.RecordPTR(this), this.RecordSRV(this), this.RecordTXT(this), this.RecordServicePTR(this)];
    for (const subtype of this.subtypes || []) records.push(this.RecordSubtypePTR(this, subtype));
    for (const ip of this.advertisedAddresses) records.push(this.RecordA(this, ip));
    return records;
  }
}

// a service built but not started: what publishOwned would announce.
export const ownedService = ({ addresses = [], ...config }, start = () => {}, stop = (cb) => cb?.()) => new OwnedService(config, addresses, start, stop);

// bonjour.publish() with an owned host and address list. mirrors Registry.publish without probing (the daemon never
// probed: names are `agentbus-<hostId>` / sha256 slices, unique by construction) and registers in the same registry,
// so unpublishAll/destroy on the Bonjour instance tear it down like any other service.
export function publishOwned(bonjour, { addresses, ...config }) {
  const registry = bonjour.registry;
  const service = new OwnedService(config, addresses, () => {
    if (service.activated) return;
    service.activated = true;
    registry.services.push(service);
    registry.announce(registry.server, service);
  }, (callback = () => {}) => {
    if (!service.activated) return process.nextTick(callback);
    registry.teardown(registry.server, service, callback);
    const index = registry.services.indexOf(service);
    if (index !== -1) registry.services.splice(index, 1);
  });
  service.start();
  return service;
}
