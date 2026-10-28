// agentbus cloud: on-demand gpu pods from the group's provisioner (see docs/cloud.md).
import fs from 'node:fs';
import path from 'node:path';
import { localLanRequest } from '../lib/lan.mjs';
import { formatOffer, sanitizeCloud, cloudDir, validateCloudConfig, writeCloudSecrets } from '../lib/cloud.mjs';
import { selfIdentity } from '../lib/core.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function formatCloudStatus(r) {
  if (!r?.ok) return `cloud: ${r?.error || 'no answer from the local agentbus daemon'}`;
  if (!r.provisioners?.length) return 'no provisioner in this group is authenticated from here (cloud offers unavailable)';
  const lines = [];
  for (const p of r.provisioners) for (const o of sanitizeCloud(p)?.offers || []) {
    const raw = p.offers.find((x) => x.name === o.name);
    lines.push(formatOffer({ ...o, idleMinutes: p.idleMinutes }, p.name));
    if (raw?.fromHere) lines.push(`  from this host: ${raw.fromHere.authenticated ? 'authenticated' : 'not authenticated yet'}, reach back ${raw.fromHere.reachBack ? 'ok' : 'not yet'}`);
    if (o.state === 'starting' || o.lastError) for (const l of o.progress.slice(-4)) lines.push(`  ${l}`);
    if (o.last) lines.push(`  last run: ${o.last.reason}, ${o.last.hours ?? '?'} h, ~$${o.last.estimateUsd ?? '?'} (started by ${o.last.startedBy || '?'}, stopped by ${o.last.stoppedBy || '?'})`);
  }
  return lines.join('\n');
}
// shared by the cli and the mcp tools
export async function cloudCall({ action, offer, host, maxHours, maxUsd, force, purgeAll, from, waitMinutes = 0, timeout = 35000 }) {
  const frame = { op: 'cloud', action, ...(offer ? { offer } : {}), ...(host ? { host } : {}), ...(maxHours !== undefined ? { maxHours } : {}), ...(maxUsd !== undefined ? { maxUsd } : {}), ...(force ? { force: true } : {}), ...(purgeAll ? { purgeAll: true } : {}), ...(from ? { from } : {}) };
  const first = await localLanRequest(frame, { timeout });
  if (first.error === 'unknown operation') return { ok: false, error: 'the local agentbus daemon predates cloud support: update this checkout (git pull && npm ci), then restart the daemon (agentbus lan stop, agentbus lan install). see docs/join.md "later"' };
  if (!first.ok || action !== 'up' || !waitMinutes) return first;
  const end = Date.now() + Math.min(waitMinutes, 30) * 60000;
  for (;;) {
    const s = await localLanRequest({ op: 'cloud', action: 'status' }, { timeout });
    const o = s.provisioners?.flatMap((p) => p.offers).find((x) => x.name === (offer || first.offer?.name));
    if (o && (o.state === 'live' && o.fromHere?.authenticated || o.state === 'dormant')) return { ...first, offer: o, waited: true, ...(o.state === 'dormant' ? { ok: false, error: o.lastError || 'the pod stopped while starting' } : {}) };
    if (Date.now() > end) return { ...first, offer: o, waited: true, note: 'still starting; poll cloud_status' };
    await sleep(10000);
  }
}

export async function runCloud(args) {
  const command = args.shift() || 'status';
  const option = (name) => { const i = args.indexOf(name); if (i < 0) return undefined; if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error(`${name} needs a value`); return args.splice(i, 2)[1]; };
  const has = (name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
  const json = has('--json');
  const print = (r, text) => { console.log(json || !text ? JSON.stringify(r, null, 2) : text); if (r?.ok === false) process.exitCode = 1; };
  if (command === 'status') {
    const r = await cloudCall({ action: 'status', host: option('--host') });
    print(r, formatCloudStatus(r));
  } else if (command === 'up' || command === 'down') {
    const offer = args.shift(), host = option('--host'), from = selfIdentity(option('--from'))?.id;
    const maxHours = option('--max-hours'), maxUsd = option('--max-usd'), wait = option('--wait');
    const force = has('--force'), purgeAll = has('--purge-all');
    if (!offer || args.length) throw Error('usage: agentbus cloud up OFFER (--max-hours N | --max-usd N) [--wait MINUTES] [--from id] | down OFFER [--force] [--purge-all] [--from id]');
    const r = await cloudCall({ action: command, offer, host, from, force, purgeAll, ...(maxHours !== undefined ? { maxHours: Number(maxHours) } : {}), ...(maxUsd !== undefined ? { maxUsd: Number(maxUsd) } : {}), waitMinutes: wait ? Number(wait) : 0 });
    print(r, r.ok ? `${r.note || r.offer?.state || 'ok'}${r.offer ? `\n${formatOffer(sanitizeCloud({ offers: [r.offer] }).offers[0], r.provisioner || 'this host')}` : ''}` : `cloud ${command}: ${r.error}`);
  } else if (command === 'init') {
    // provisioner owner: write ~/.agentbus/cloud/config.json from a json file after validating it
    const file = args.shift(); if (!file || args.length) throw Error('usage: agentbus cloud init <offers.json>  (see docs/cloud.md for the format)');
    const config = validateCloudConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
    const dir = cloudDir(process.env.AGENTBUS_DIR || path.join((await import('node:os')).homedir(), '.agentbus'));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ ok: true, offers: config.offers.map((o) => o.name), file: path.join(dir, 'config.json'), next: 'agentbus cloud secrets --from-env, then restart the lan daemon' }, null, 2));
  } else if (command === 'tailnet-policy') {
    const apply = has('--apply'); if (args.length) throw Error('usage: agentbus cloud tailnet-policy [--apply]');
    const { tailnetPolicy } = await import('../lib/tailscale-api.mjs');
    const { readCloudSecrets } = await import('../lib/cloud.mjs');
    const sec = readCloudSecrets(process.env.AGENTBUS_DIR || path.join((await import('node:os')).homedir(), '.agentbus'));
    const { detectOverlayIPv4 } = await import('../lib/lan.mjs');
    const here = detectOverlayIPv4()[0];
    const r = await tailnetPolicy({ clientId: sec.TS_OAUTH_CLIENT_ID, clientSecret: sec.TS_OAUTH_CLIENT_SECRET, apply, previewFor: here ? `${here}:47800` : undefined, log: (s) => console.log(s) });
    if (!r.ok) process.exitCode = 1;
  } else if (command === 'secrets') {
    // values only from env, never argv (shell history, process lists)
    if (!has('--from-env') || args.length) throw Error('usage: [RUNPOD_API_KEY=...] [TS_OAUTH_CLIENT_ID=... TS_OAUTH_CLIENT_SECRET=...] [CLAUDE_CODE_OAUTH_TOKEN=...] [HF_TOKEN=...] agentbus cloud secrets --from-env\n  stores whichever of these are set in the env and merges them into what is already stored, so you can set them one at a time.\n  a provisioner needs RUNPOD_API_KEY, the tailscale oauth client (scopes auth_keys + policy_file, tag tag:agentbus-gpu) and CLAUDE_CODE_OAUTH_TOKEN.\n  TS_AUTHKEY (a reusable key) is a legacy fallback, used only without the oauth client.');
    const keys = writeCloudSecrets(process.env.AGENTBUS_DIR || path.join((await import('node:os')).homedir(), '.agentbus'), process.env);
    console.log(JSON.stringify({ ok: true, stored: keys, note: 'merged into the owner-only file; values are never printed. stored lists every key now present' }, null, 2));
  } else throw Error('usage: agentbus cloud status [--json] | up OFFER (--max-hours N | --max-usd N) [--wait MIN] | down OFFER [--force] [--purge-all] | init <offers.json> | secrets --from-env');
}
