import test from 'node:test';
import assert from 'node:assert/strict';
import { hostCapabilities, hostAdvertisement, sessionAdvertisement } from '../lib/host-capabilities.mjs';
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
