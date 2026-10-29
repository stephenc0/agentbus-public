import test from 'node:test';
import assert from 'node:assert/strict';
import { tailscaleCandidates, locateTailscale, createTailscaleRunner, tailscaleStatus, TAILSCALE_APP_CLI } from '../lib/tailscale-cli.mjs';
import { tailscaleIPv4 } from '../lib/lan.mjs';

test('the locator knows each platform: PATH first, then the app bundle, program files, or the linux package paths', () => {
  const mac = tailscaleCandidates({ platform: 'darwin', env: { PATH: '/opt/homebrew/bin:/usr/bin' } });
  assert.deepEqual(mac.slice(0, 2), ['/opt/homebrew/bin/tailscale', '/usr/bin/tailscale']);
  assert(mac.includes(TAILSCALE_APP_CLI), 'the macos app bundle cli, which is never on PATH');
  assert.equal(new Set(mac).size, mac.length, 'no duplicates when PATH already names a fixed spot');
  const win = tailscaleCandidates({ platform: 'win32', env: { PATH: 'C:\\Windows\\System32;C:\\tools', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' } });
  assert.deepEqual(win, ['C:\\Windows\\System32\\tailscale.exe', 'C:\\tools\\tailscale.exe', 'C:\\Program Files\\Tailscale\\tailscale.exe', 'C:\\Program Files (x86)\\Tailscale\\tailscale.exe']);
  const linux = tailscaleCandidates({ platform: 'linux', env: { PATH: '' } });
  assert.deepEqual(linux, ['/usr/bin/tailscale', '/usr/local/bin/tailscale', '/usr/sbin/tailscale']);
  assert.deepEqual(tailscaleCandidates({ platform: 'linux', env: {} }), linux, 'no PATH at all (a service manager environment)');
});

test('locate keeps only candidates that exist, in order, and swallows a throwing exists()', () => {
  const exists = (p) => p === TAILSCALE_APP_CLI || p === '/usr/local/bin/tailscale';
  assert.deepEqual(locateTailscale({ platform: 'darwin', env: { PATH: '/usr/local/bin' }, exists }), ['/usr/local/bin/tailscale', TAILSCALE_APP_CLI]);
  assert.deepEqual(locateTailscale({ platform: 'win32', env: { ProgramFiles: 'C:\\Program Files' }, exists: (p) => /Program Files/.test(p) }), ['C:\\Program Files\\Tailscale\\tailscale.exe']);
  assert.deepEqual(locateTailscale({ platform: 'linux', env: {}, exists: () => { throw Error('eacces'); } }), []);
});

test('the runner tries every located binary until one answers, remembers it, and yields nothing when none does', () => {
  const calls = [];
  const exec = (bin, args) => { calls.push(bin); if (bin === '/usr/local/bin/tailscale') throw Error('failed to connect to local tailscaled'); return `${bin} ${args.join(' ')}\n`; };
  const run = createTailscaleRunner({ exec, locate: () => ['/usr/local/bin/tailscale', TAILSCALE_APP_CLI] });
  assert.equal(run(['ip', '-4']), `${TAILSCALE_APP_CLI} ip -4\n`);
  assert.equal(run.binary(), TAILSCALE_APP_CLI);
  run(['status', '--json']);
  assert.deepEqual(calls, ['/usr/local/bin/tailscale', TAILSCALE_APP_CLI, TAILSCALE_APP_CLI], 'the one that answered is tried first next time');
  const none = createTailscaleRunner({ exec, locate: () => [] });
  assert.equal(none(['ip', '-4']), '');
  assert.equal(none.binary(), null);
  const broken = createTailscaleRunner({ exec: () => { throw Error('enoent'); }, locate: () => ['/usr/bin/tailscale'] });
  assert.equal(broken(['status', '--json']), '');
});

test('status parses the json the cli prints and is null for no cli, no json or a non-object', () => {
  assert.deepEqual(tailscaleStatus(() => '{"BackendState":"Running","Peer":{}}'), { BackendState: 'Running', Peer: {} });
  assert.equal(tailscaleStatus(() => ''), null);
  assert.equal(tailscaleStatus(() => 'Tailscale is stopped.'), null);
  assert.equal(tailscaleStatus(() => '[1]'), null);
  // the historical ip helper rides on the same runner
  assert.deepEqual(tailscaleIPv4(() => '100.101.2.3\nfd7a:115c::1\n'), ['100.101.2.3']);
});
