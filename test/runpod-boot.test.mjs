import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BOOT = fileURLToPath(new URL('../scripts/runpod/boot.sh', import.meta.url));
const which = (c) => spawnSync('sh', ['-c', `command -v ${c}`]).status === 0;
// boot.sh needs flock (util-linux, present in the pod image; absent on macos) and git.
const skip = process.platform === 'win32' || !which('flock') || !which('git') ? 'needs bash, flock and git (runs on linux)' : false;

// a tiny stand-in for the upstream repo: a git repo whose start.sh just reports which copy it is
function fakeRelease(dir, label) {
  fs.mkdirSync(path.join(dir, 'scripts/runpod'), { recursive: true }); fs.mkdirSync(path.join(dir, 'bin'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fake', version: '1.0.0', private: true }));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ name: 'fake', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'fake', version: '1.0.0' } } }));
  fs.writeFileSync(path.join(dir, 'bin/agentbus.mjs'), "console.log('{}');\n");
  fs.writeFileSync(path.join(dir, 'scripts/runpod/start.sh'), `echo "RAN ${label} home=$AGENTBUS_HOME source=$AGENTBUS_CODE_SOURCE"\n`);
}
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } }).trim();

test('boot runs the pinned release from the volume, reuses it, and falls back loudly to the baked copy', { skip, timeout: 120000 }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-boot-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'mirror'), baked = path.join(root, 'baked'), vol = path.join(root, 'volume');
  fakeRelease(repo, 'release'); fakeRelease(baked, 'baked');
  git(repo, 'init', '-q'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'r1'); git(repo, 'tag', 'v9.9.9');
  git(repo, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  const sha = git(repo, 'rev-parse', 'HEAD');
  const boot = (ref) => spawnSync('bash', [BOOT], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: root, AGENTBUS_REF: ref, AGENTBUS_REPO: `file://${repo}`, AGENTBUS_CODE_ROOT: vol, AGENTBUS_BAKED: baked } });
  const first = boot(sha);
  assert.match(first.stdout, new RegExp(`RAN release home=${vol}/${sha} source=volume commit ${sha}`), first.stdout + first.stderr);
  assert.ok(fs.existsSync(path.join(vol, sha, '.agentbus-ready')));
  const again = boot(sha);
  assert.doesNotMatch(again.stdout, /fetching/, 'a ref installed once is reused by later pods');
  assert.match(again.stdout, /RAN release/);
  assert.match(boot('v9.9.9').stdout, /RAN release .*source=volume tag v9\.9\.9/);
  for (const [ref, why] of [['main', /not a 40-hex commit or a v-tag/], ['', /no AGENTBUS_REF/], ['0'.repeat(40), /could not install/]]) {
    const r = boot(ref);
    assert.match(r.stdout, /RAN baked/, `${ref || '(empty)'} falls back`);
    assert.match(r.stdout, why); assert.match(r.stdout, /WARNING: running the agentbus copy baked into the image/);
  }
});
