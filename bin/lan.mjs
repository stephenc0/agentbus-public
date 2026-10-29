import { initLan, loadLan, localLanRequest, updateLanConfig, validatePeers, UUID } from '../lib/lan.mjs';
import { startLan } from '../lib/lan-daemon.mjs';
import { listAgents, deliverToClaude, deliverToCodex } from '../lib/core.mjs';

export async function runLan(args) {
  const command = args.shift();
  const option = (name) => {
    const i = args.indexOf(name); if (i < 0) return undefined;
    if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error(`${name} requires a value`);
    return args.splice(i, 2)[1];
  };
  const has = (name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
  const many = (name) => { const out = []; for (let v; (v = option(name)) !== undefined;) out.push(v); return out; };
  // usd/hour: a number, never inferred. "" or absent means unknown.
  const costArgs = () => {
    const perHour = option('--cost-per-hour') ?? (process.env.AGENTBUS_GPU_COST_PER_HOUR || undefined), billing = option('--billing') ?? (process.env.AGENTBUS_BILLING || undefined);
    const out = {};
    if (perHour !== undefined) { if (!/^\d+(\.\d+)?$/.test(perHour)) throw Error('--cost-per-hour must be a non-negative number of usd per hour'); out.gpu_cost_per_hour = Number(perHour); }
    if (billing !== undefined) out.billing = billing;
    return Object.keys(out).length ? out : undefined;
  };
  const parsePeer = (spec) => { const m = /^([0-9a-f-]{36})@([^:]+):(\d+)(?:=(.+))?$/i.exec(spec); if (!m) throw Error(`bad --peer ${spec}; expected HOST_UUID@ADDRESS:PORT[=name]`); return { hostId: m[1].toLowerCase(), address: m[2], port: Number(m[3]), ...(m[4] ? { name: m[4] } : {}) }; };
  if (command === 'init') {
    const name = option('--name'), keyFile = option('--key-file'), port = option('--port'), bind = option('--bind'), smsPrimary = option('--sms-primary'), mdnsInterface = option('--mdns-interface'), peers = many('--peer').map(parsePeer), mdns = !has('--no-mdns');
    if (args.length) throw Error(`unknown arguments: ${args.join(' ')}`);
    console.log(JSON.stringify(initLan({ name, keyFile, port: port === undefined ? 0 : Number(port), bind, smsPrimary, mdnsInterface, peers, mdns }), null, 2));
  } else if (command === 'join') {
    const { join } = await import('../lib/wan.mjs');
    const name = option('--name') || process.env.AGENTBUS_NAME || undefined, port = option('--port') || process.env.AGENTBUS_PORT || undefined, bind = option('--bind');
    const asHost = has('--host') || process.env.AGENTBUS_ROLE === 'host', userspace = has('--userspace-tailscale'), socks5 = option('--socks5'), advertiseAddress = option('--advertise-address'), ephemeral = has('--ephemeral'), cost = costArgs();
    const token = args.shift() || process.env.AGENTBUS_JOIN_TOKEN;
    if (!token || args.length) throw Error("usage: agentbus lan join '<agentbus-join-v1:...>' [--name name] [--port 47800] [--bind 100.x.y.z | --userspace-tailscale [--socks5 127.0.0.1:1055] [--advertise-address 100.x.y.z] [--ephemeral]] [--cost-per-hour 2.89 --billing 'label'] [--host]  (or env AGENTBUS_JOIN_TOKEN, AGENTBUS_NAME, AGENTBUS_PORT, AGENTBUS_GPU_COST_PER_HOUR, AGENTBUS_BILLING, AGENTBUS_ROLE=host). without --host this machine joins as a client");
    if (!userspace && (socks5 || advertiseAddress || ephemeral)) throw Error('--socks5, --advertise-address and --ephemeral need --userspace-tailscale');
    const result = await join({ token, name, bind, cost, role: asHost ? 'host' : undefined, ...(userspace ? { userspace: { socks5, advertiseAddress, ephemeral } } : {}), ...(port ? { port: Number(port) } : {}) });
    console.log(JSON.stringify({ ...result, keyFile: undefined, next: 'agentbus lan install, then agentbus lan doctor' }, null, 2));
  } else if (command === 'invite') {
    const { buildInvite } = await import('../lib/wan.mjs');
    const peerSpecs = many('--peer'), name = option('--name'), repo = option('--repo'), port = option('--port'), tokenOnly = has('--token-only'), asHost = has('--host'), tailscaleAuthKey = option('--tailscale-authkey') ?? (process.env.TS_AUTHKEY || undefined);
    if (!repo && !tokenOnly) throw Error('usage: agentbus lan invite --repo URL --peer NAME=100.x.y.z[:PORT] [--peer ...] [--name joiner-name] [--port joiner-port] [--tailscale-authkey tskey-auth-... | env TS_AUTHKEY] [--host] [--token-only]');
    if (args.length) throw Error(`unknown arguments: ${args.join(' ')}`);
    const invite = await buildInvite({ peerSpecs, name, repo: repo || '<repo>', tailscaleAuthKey, host: asHost, ...(port ? { port: Number(port) } : {}) });
    console.log(tokenOnly ? invite.token : invite.text);
  } else if (command === 'peer') {
    const sub = args.shift();
    if (sub === 'list') { console.log(JSON.stringify(loadLan().peers, null, 2)); }
    else if (sub === 'add') {
      const hostId = option('--id'), address = option('--address'), port = Number(option('--port')), name = option('--name');
      if (args.length || !UUID.test(hostId || '')) throw Error('usage: agentbus lan peer add --id HOST_UUID --address 100.x.y.z|hostname --port PORT [--name name]');
      const [peer] = validatePeers([{ hostId, address, port, ...(name ? { name } : {}) }]);
      const next = updateLanConfig(undefined, (c) => ({ ...c, peers: [...(c.peers || []).filter((p) => p.hostId !== hostId), peer] }));
      if (!next.port) console.error('warning: this host listens on an os-assigned port; static peers dialing back need a fixed "port" in lan config (restart the daemon after changing it)');
      console.log(JSON.stringify(next.peers, null, 2));
    } else if (sub === 'remove') {
      const hostId = args.shift(); if (!UUID.test(hostId || '') || args.length) throw Error('usage: agentbus lan peer remove HOST_UUID');
      console.log(JSON.stringify(updateLanConfig(undefined, (c) => ({ ...c, peers: (c.peers || []).filter((p) => p.hostId !== hostId) })).peers || [], null, 2));
    } else throw Error('usage: agentbus lan peer list | add --id HOST_UUID --address ADDR --port PORT [--name n] | remove HOST_UUID');
  } else if (command === 'role') {
    // this machine's own role, decided here and nowhere else. client (the default): submits work only, shares no presence
    // or account usage, accepts no launches. host: shares presence and usage, accepts launches per its launch policy.
    const role = args.shift();
    if (!role && !args.length) { console.log(JSON.stringify({ role: loadLan().role === 'host' ? 'host' : 'client' }, null, 2)); return; }
    if (!['host', 'client'].includes(role) || args.length) throw Error('usage: agentbus lan role [host|client]');
    const next = updateLanConfig(undefined, (c) => { const out = { ...c }; if (role === 'host') out.role = 'host'; else delete out.role; return out; });
    console.log(JSON.stringify({ role: next.role === 'host' ? 'host' : 'client', restart: 'run agentbus lan stop, then agentbus lan install: the daemon reads its role at start' }, null, 2));
  } else if (command === 'cost') {
    // the price this host advertises next to its gpu memory. owned hardware: --cost-per-hour 0 --billing owned. --clear: unknown.
    const clear = has('--clear'), cost = costArgs();
    if (args.length || (!clear && !cost) || (clear && cost)) throw Error("usage: agentbus lan cost --cost-per-hour 0 --billing owned | --cost-per-hour 2.89 --billing 'runpod secure cloud on-demand' | --clear");
    const next = updateLanConfig(undefined, (c) => { const out = { ...c, ...(cost || {}) }; if (clear) { delete out.gpu_cost_per_hour; delete out.billing; } return out; });
    console.log(JSON.stringify({ gpu_cost_per_hour: next.gpu_cost_per_hour ?? null, billing: next.billing ?? null, note: 'the running daemon picks this up on its next poll (about 10s)' }, null, 2));
  } else if (command === 'doctor') {
    const { doctor } = await import('../lib/wan.mjs');
    const ok = await doctor({ roundtrip: !has('--no-roundtrip') });
    process.exitCode = ok ? 0 : 1;
  } else if (command === 'install' || command === 'stop') {
    const { installLan, stopLan } = await import('../lib/lan-install.mjs');
    console.log(JSON.stringify(command === 'install' ? installLan() : stopLan(), null, 2));
  } else if (command === 'forget-host') {
    if (args.length !== 1) throw Error('usage: agentbus lan forget-host <retired-host-uuid>');
    const result = await localLanRequest({ op: 'forget-host', hostId: args[0] }, { timeout: 2000 });
    console.log(JSON.stringify(result, null, 2)); if (!result.ok) process.exitCode = 1;
  } else if (command === 'status') {
    console.log(JSON.stringify(await localLanRequest({ op: 'status' }, { timeout: 2000 }), null, 2));
  } else if (command === 'serve') {
    if (args.length) throw Error(`unknown arguments: ${args.join(' ')}`);
    const config = loadLan();
    const { presenceTracker } = await import('../lib/presence.mjs');
    const { createUsageTracker } = await import('../lib/usage.mjs');
    const daemon = await startLan({ config, mdns: config.mdns !== false, // a client (the default) never starts the presence or usage samplers at all
      usage: config.role === 'host' ? createUsageTracker({ dir: process.env.AGENTBUS_DIR }) : null, presence: config.role === 'host' ? presenceTracker({ dir: process.env.AGENTBUS_DIR }) : null, listLocal: listAgents, deliverLocal: (target, from, message) => target.kind === 'claude' ? deliverToClaude(target, from, message) : deliverToCodex(target, from, message) });
    console.log(JSON.stringify({ hostId: config.hostId, name: config.name, port: daemon.port, service: '_agentbus._tcp.local', socket: daemon.socketPath }));
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; await daemon.close(); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  } else throw Error('usage: agentbus lan init [--name name] [--key-file file] [--port port] [--bind IPv4] [--sms-primary self|host-id] [--mdns-interface adapter|IPv4] [--peer HOST_UUID@ADDR:PORT[=name]] [--no-mdns] | lan join TOKEN [--userspace-tailscale] [--host] | lan role [host|client] | lan cost --cost-per-hour N --billing label|--clear | lan invite --repo URL --peer NAME=ADDR[:PORT] | lan peer list|add|remove | lan doctor | lan serve | lan status | lan forget-host <uuid> | lan install | lan stop');
}
