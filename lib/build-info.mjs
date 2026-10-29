import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const projectRoot = fileURLToPath(new URL('..', import.meta.url));
export function sourceManifest(root = projectRoot) {
  const files = {};
  const visit = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const relative = path.posix.join(dir, entry.name);
      if (entry.isDirectory() && !['node_modules', '.git'].includes(entry.name)) visit(relative);
      else if (entry.isFile() && /\.(mjs|ps1|json)$/.test(entry.name)) files[relative] = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relative))).digest('hex');
    }
  };
  for (const dir of ['bin', 'lib', 'hooks', 'claw-messenger']) visit(dir);
  for (const name of ['server.mjs', 'package.json', 'package-lock.json']) files[name] = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex');
  const ordered = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
  return { schemaVersion: 1, version: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version, sourceHash: crypto.createHash('sha256').update(JSON.stringify(ordered)).digest('hex'), files: ordered };
}
// Captured at module load, so an old daemon cannot claim a newer on-disk release.
const manifest = sourceManifest();
export const buildInfo = Object.freeze({ version: manifest.version, sourceHash: manifest.sourceHash, protocolVersion: 1, loadedAt: Date.now(), features: ['windows-presence-evidence-v1', 'account-usage-v1', 'launch-lifecycle-v2', 'async-runtime-probes', 'permission-profiles', 'layered-presence', 'delivery-readiness', 'untouched-thread-discovery', 'windows-owner-discovery', 'native-queue-v1', 'wan-peers-v1', 'blob-lane-v1', 'shared-known-hosts-v1', 'host-cost-v1', 'userspace-tailscale-v1', 'ephemeral-hosts-v1', 'cloud-provisioner-v1', 'provisioner-introductions-v1', 'blob-activity-v1', 'cloud-oauth-keys-v1', 'pod-hard-stop-v1', 'client-role-v1', 'tailnet-discovery-v1'] });
