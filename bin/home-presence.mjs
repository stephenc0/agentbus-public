#!/usr/bin/env node
import fs from 'node:fs';
import { readHomePresenceConfig, setHomePresenceConfig, createHomePresenceSampler } from '../lib/home-presence.mjs';

export async function homePresenceMain(args = process.argv.slice(2)) {
  const [command = 'status', file] = args;
  if (command === 'configure') {
    if (!file) throw Error('usage: agentbus home-presence configure <config.json> (enabled, sensors: [accessory UUIDs], optional cli/pollMs/maxAgeMs/timeoutMs)');
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    console.log(JSON.stringify(setHomePresenceConfig(config), null, 2));
  } else if (command === 'disable') {
    console.log(JSON.stringify(setHomePresenceConfig({ enabled: false }), null, 2));
  } else if (command === 'status') {
    const sampler = createHomePresenceSampler();
    try { console.log(JSON.stringify({ config: readHomePresenceConfig(), home: await sampler.sample({ force: true }) }, null, 2)); } finally { sampler.close(); }
  } else throw Error('usage: agentbus home-presence [status|configure <config.json>|disable]');
}
