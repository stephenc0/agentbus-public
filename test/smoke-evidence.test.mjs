import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { smokeEvidencePath } from '../bin/session-smoke.mjs';

test('smoke evidence follows native background worktrees inside the destination mapping', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const relative = ['.claude', 'worktrees', 'smoke'];
  const cwd = path.join(root, ...relative); fs.mkdirSync(cwd, { recursive: true });
  const file = path.join(cwd, 'nonce.txt'); fs.writeFileSync(file, 'nonce');
  assert.equal(smokeEvidencePath(root, root, cwd, 'nonce.txt'), fs.realpathSync(file));
  assert.equal(smokeEvidencePath(root, 'G:\\Tasks\\repo', 'G:\\Tasks\\repo\\.claude\\worktrees\\smoke', 'nonce.txt'), fs.realpathSync(file));
  assert.equal(smokeEvidencePath(root, 'G:\\Tasks\\repo', 'G:\\Tasks\\other', 'nonce.txt'), null);
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'nonce.txt'), 'wrong');
  fs.symlinkSync(outside, path.join(cwd, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  // The mapped evidence root is cwd; a symlink out of it must not count.
  assert.equal(smokeEvidencePath(cwd, '/repo', '/repo/escape', 'nonce.txt'), null);
});
