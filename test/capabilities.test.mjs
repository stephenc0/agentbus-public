import test from 'node:test';
import assert from 'node:assert/strict';
import { hostCapabilities, hostAdvertisement, sessionAdvertisement, hostCost, validateHostCost, formatHardware, sanitizeCapabilities } from '../lib/host-capabilities.mjs';
import { formatHostStatuses } from '../lib/presence.mjs';
const system = { platform: () => 'darwin', release: () => 'kernel', arch: () => 'arm64', cpus: () => Array(12).fill({ model: 'test cpu' }), availableParallelism: () => 8, totalmem: () => 32 * 1024 ** 3 };
test('mac hardware detection describes cpu, os and metal without exposing monitor identifiers', () => {
  const caps = hostCapabilities({ system, run: (cmd) => cmd.includes('sw_vers') ? 'test-os' : JSON.stringify({ SPDisplaysDataType: [{ sppci_model: 'test gpu', sppci_cores: '16', spdisplays_vendor: 'sppci_vendor_Apple', spdisplays_mtlgpufamilysupport: 'metal3', spdisplays_ndrvs: [{ serial: 'private-monitor' }] }] }) });
  assert.equal(caps.os.type, 'macos'); assert.equal(caps.os.version, 'test-os');
  assert.equal(caps.cpu.logicalCores, 12); assert.equal(caps.cpu.availableCores, 8);
  assert.equal(caps.gpus[0].cores, 16); assert.equal(caps.gpus[0].unifiedMemory, true);
  assert(!JSON.stringify(caps).includes('private-monitor'));
  const txt = hostAdvertisement({ hostId: 'test', name: 'host', smsPrimary: 'test' }, caps, 2);
  assert.equal(txt.sms_role, 'primary'); assert.equal(txt.ram_gib, '32'); assert.equal(txt.gpu_compute, 'metal3');
});
test('linux nvidia detection reports VRAM and compute capability; missing probe stays unknown', () => {
  const linux = { ...system, platform: () => 'linux', arch: () => 'x64' };
  const caps = hostCapabilities({ system: linux, run: () => 'RTX test, 24576, 8.9, 555.1' });
  assert.equal(caps.gpus[0].memoryMiB, 24576); assert.equal(caps.gpus[0].cudaComputeCapability, '8.9');
  const absent = hostCapabilities({ system: linux, run: () => '' });
  assert.equal(absent.gpuDetection, 'unavailable'); assert.deepEqual(absent.gpus, []);
});
test('session TXT records include model provenance and stay within DNS string limits', () => {
  const txt = sessionAdvertisement('host', { id: 'agent', clientType: 'claude-code', name: '😀'.repeat(300), model: 'model'.repeat(200), modelSource: 'last_response', status: 'idle' });
  assert.equal(txt.type, 'claude-code'); assert.equal(txt.model_source, 'last_response');
  for (const [key, value] of Object.entries(txt)) assert(Buffer.byteLength(`${key}=${value}`) <= 255);
});

test('host cost comes only from config: owned hardware says $0/h, absent stays unknown, junk is rejected', () => {
  assert.deepEqual(hostCost({ gpu_cost_per_hour: 0, billing: 'owned' }), { gpu_cost_per_hour: 0, billing: 'owned' });
  assert.deepEqual(hostCost({}), { gpu_cost_per_hour: null, billing: null }, 'never 0 by assumption');
  assert.deepEqual(hostCost({ gpu_cost_per_hour: '2.89', billing: 'x\u0007' }), { gpu_cost_per_hour: null, billing: null });
  assert.deepEqual(hostCost({ gpu_cost_per_hour: -1 }), { gpu_cost_per_hour: null, billing: null });
  assert.throws(() => validateHostCost({ gpu_cost_per_hour: '2.89' }), /gpu_cost_per_hour/);
  assert.throws(() => validateHostCost({ billing: 'a'.repeat(49) }), /billing/);
  assert.deepEqual(validateHostCost({ gpu_cost_per_hour: 2.89, billing: 'runpod secure cloud on-demand' }), { gpu_cost_per_hour: 2.89, billing: 'runpod secure cloud on-demand' });
  const linux = { ...system, platform: () => 'linux', arch: () => 'x64' };
  const pod = { ...hostCapabilities({ system: linux, run: () => 'NVIDIA H100 80GB HBM3, 81559, 9.0, 570.1' }), gpu_cost_per_hour: 2.89, billing: 'runpod secure cloud on-demand' };
  assert.equal(formatHardware(pod), '81559MiB cuda (NVIDIA H100 80GB HBM3, sm 9.0), $2.89/h runpod secure cloud on-demand');
  const owned = { ...hostCapabilities({ system: linux, run: () => 'NVIDIA GeForce RTX 5070 Ti, 16303, 12.0, 580.1' }), gpu_cost_per_hour: 0, billing: 'owned' };
  assert.equal(formatHardware(owned), '16303MiB cuda (NVIDIA GeForce RTX 5070 Ti, sm 12.0), $0/h owned');
  assert.equal(formatHardware(hostCapabilities({ system: linux, run: () => '' })), 'no gpu detected (unavailable), cost unknown');
  // what peers actually receive is sanitized: missing fields become 'unknown' and must not turn an nvidia card into metal
  assert.equal(formatHardware(sanitizeCapabilities(owned)), '16303MiB cuda (NVIDIA GeForce RTX 5070 Ti, sm 12.0), $0/h owned');
  const txt = hostAdvertisement({ hostId: 'h', name: 'runpod-h100' }, sanitizeCapabilities(pod), 0);
  assert.equal(txt.gpu_memory, '81559MiB'); assert.equal(txt.gpu_cost, '$2.89/h'); assert.equal(txt.billing, 'runpod secure cloud on-demand');
  assert.equal(hostAdvertisement({ hostId: 'h', name: 'n' }, sanitizeCapabilities(hostCapabilities({ system: linux, run: () => '' })), 0).gpu_cost, 'unknown');
  const sane = sanitizeCapabilities({ ...pod, gpu_cost_per_hour: 'free', billing: 42 });
  assert.equal(sane.gpu_cost_per_hour, null); assert.equal(sane.billing, null);
  assert.equal(sanitizeCapabilities(pod).gpu_cost_per_hour, 2.89);
});
test('apple unified memory is reported as a comparable size, and host_status prints a hardware line per host', () => {
  const caps = hostCapabilities({ system: { ...system, totalmem: () => 16 * 1024 ** 3 }, run: (cmd) => cmd.includes('sw_vers') ? 'os' : JSON.stringify({ SPDisplaysDataType: [{ sppci_model: 'Apple M6', sppci_cores: '10', spdisplays_vendor: 'sppci_vendor_Apple', spdisplays_mtlgpufamilysupport: 'metal4' }] }) });
  assert.equal(caps.gpus[0].memoryMiB, 16384);
  assert.equal(formatHardware({ ...caps, gpu_cost_per_hour: 0, billing: 'owned' }), '16384MiB unified metal (Apple M6), $0/h owned');
  assert.equal(hostAdvertisement({ hostId: 'h', name: 'mac' }, caps, 0).gpu_memory, '16384MiB unified');
  const text = formatHostStatuses({ local: { name: 'studio', presence: null, usage: null, capabilities: { ...caps, gpu_cost_per_hour: 0, billing: 'owned' } }, peers: [{ hostId: 'p', name: 'runpod-h100', presence: null, usage: null, capabilities: { gpus: [{ name: 'NVIDIA H100 80GB HBM3', memoryMiB: 81559, cudaComputeCapability: '9.0' }], gpu_cost_per_hour: 2.89, billing: 'runpod' } }, { hostId: 'q', name: 'gpubox', presence: null, usage: null, capabilities: { gpus: [{ name: 'RTX', memoryMiB: 16303, cudaComputeCapability: '12.0' }] } }], lan: 'ok' });
  assert.match(text, /^studio hardware: 16384MiB unified metal \(Apple M6\), \$0\/h owned$/m);
  assert.match(text, /^runpod-h100 hardware: 81559MiB cuda \(NVIDIA H100 80GB HBM3, sm 9\.0\), \$2\.89\/h runpod$/m);
  assert.match(text, /^gpubox hardware: 16303MiB cuda \(RTX, sm 12\.0\), cost unknown$/m, 'a missing price is said to be unknown');
});

test('presence still links against a host-capabilities module cached from before cost/hardware existed (stale mcp servers)', async (t) => {
  const { default: fsm } = await import('node:fs'); const { default: osm } = await import('node:os'); const { default: pathm } = await import('node:path');
  const { fileURLToPath, pathToFileURL } = await import('node:url');
  const lib = fileURLToPath(new URL('../lib/', import.meta.url));
  const dir = fsm.mkdtempSync(pathm.join(osm.tmpdir(), 'ab-stale-')); t.after(() => fsm.rmSync(dir, { recursive: true, force: true }));
  for (const f of fsm.readdirSync(lib)) fsm.copyFileSync(pathm.join(lib, f), pathm.join(dir, f));
  // an older host-capabilities.mjs: no hostCost, no formatHardware
  fsm.writeFileSync(pathm.join(dir, 'host-capabilities.mjs'), "export const hostCapabilities = () => ({ os: { type: 'macos' }, cpu: {}, memoryBytes: 0, gpus: [], gpuDetection: 'unavailable' });\nexport const sanitizeCapabilities = (v) => v || null;\nexport const claudeModel = () => ({ model: null, modelSource: 'unknown' });\n");
  const presence = await import(pathToFileURL(pathm.join(dir, 'presence.mjs')).href);
  const text = presence.formatHostStatuses({ local: { name: 'studio', presence: null, usage: null, capabilities: null }, peers: [], lan: 'ok' });
  assert.match(text, /studio hardware: hardware unknown/);
});
