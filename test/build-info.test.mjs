import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildInfo, sourceManifest } from '../lib/build-info.mjs';

test('deployment manifests identify runtime content independent of installation path', (t) => {
  const roots = [0, 1].map(() => fs.mkdtempSync(path.join(os.tmpdir(), 'ab-build-')));
  t.after(() => roots.forEach((r) => fs.rmSync(r, { recursive: true, force: true })));
  for (const root of roots) {
    for (const dir of ['bin', 'lib', 'hooks', 'claw-messenger']) fs.mkdirSync(path.join(root, dir));
    fs.writeFileSync(path.join(root, 'server.mjs'), '// same runtime\n');
    fs.writeFileSync(path.join(root, 'package.json'), '{"version":"test"}');
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
  }
  assert.equal(sourceManifest(roots[0]).sourceHash, sourceManifest(roots[1]).sourceHash);
  const loaded = buildInfo.sourceHash;
  fs.writeFileSync(path.join(roots[1], 'server.mjs'), '// upgraded runtime\n');
  assert.notEqual(sourceManifest(roots[0]).sourceHash, sourceManifest(roots[1]).sourceHash);
  assert.equal(buildInfo.sourceHash, loaded);
});
