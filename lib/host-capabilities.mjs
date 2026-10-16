import os from 'node:os';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const execute = (command, args) => { try { return execFileSync(command, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
export function hostCapabilities({ system = os, run = execute } = {}) {
  const platform = system.platform(), cpus = system.cpus();
  const result = {
    os: { type: platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : platform, release: system.release(), version: platform === 'darwin' ? run('/usr/bin/sw_vers', ['-productVersion']) || null : system.release() },
    cpu: { architecture: system.arch(), model: cpus[0]?.model?.trim() || null, logicalCores: cpus.length, availableCores: system.availableParallelism?.() || cpus.length },
    memoryBytes: system.totalmem(), gpus: [], gpuDetection: 'unavailable',
  };
  if (platform === 'darwin') {
    try {
      const displays = JSON.parse(run('/usr/sbin/system_profiler', ['SPDisplaysDataType', '-json']));
      result.gpus = (displays.SPDisplaysDataType || []).map((g) => ({ name: g.sppci_model || g._name, vendor: g.spdisplays_vendor || null, cores: Number(g.sppci_cores) || null, memory: g.spdisplays_vram || g.spdisplays_vram_shared || null, unifiedMemory: g.spdisplays_vendor === 'sppci_vendor_Apple', metal: g.spdisplays_mtlgpufamilysupport || g.spdisplays_metal || null }));
      result.gpuDetection = 'system_profiler';
    } catch { /* missing system profiler is unknown, not no GPU */ }
  } else if (platform === 'linux' || platform === 'win32') {
    const nvidia = run('nvidia-smi', ['--query-gpu=name,memory.total,compute_cap,driver_version', '--format=csv,noheader,nounits']);
    if (nvidia) {
      result.gpus = nvidia.split('\n').map((line) => { const [name, memory, compute, driver] = line.split(',').map((s) => s.trim()); return { name, vendor: 'nvidia', memoryMiB: Number(memory) || null, cudaComputeCapability: /^[0-9]+\.[0-9]+$/.test(compute) ? compute : null, driverVersion: driver || null }; });
      result.gpuDetection = 'nvidia-smi';
    } else if (platform === 'linux') {
      const pci = run('lspci', ['-mm']);
      if (pci) {
        result.gpus = pci.split('\n').filter((s) => /"(?:VGA compatible controller|3D controller|Display controller)"/.test(s)).map((line) => { const fields = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]); return { name: fields[2] || 'unknown', vendor: fields[1] || null }; });
        result.gpuDetection = 'lspci';
      }
    }
  }
  return result;
}

// Claude's registry often omits its model. A transcript model is explicitly
// labeled last_response, never presented as proof of the current configuration.
const models = new Map();
export function claudeModel(record, home = os.homedir()) {
  if (record.configuredModel || record.model) return { model: record.configuredModel || record.model, modelSource: 'configured' };
  if (!record.cwd || !/^[0-9a-f-]{36}$/.test(record.sessionId || '')) return { model: null, modelSource: 'unknown' };
  const file = `${home}/.claude/projects/${record.cwd.replace(/[^a-zA-Z0-9]/g, '-')}/${record.sessionId}.jsonl`;
  let fd;
  try {
    const stat = fs.statSync(file), key = `${stat.mtimeMs}:${stat.size}`;
    if (models.get(file)?.key === key) return models.get(file).value;
    fd = fs.openSync(file, 'r'); const size = Math.min(stat.size, 256 * 1024), buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, stat.size - size);
    const lines = buf.toString('utf8').split('\n'); if (stat.size > size) lines.shift();
    let value = { model: null, modelSource: 'unknown' };
    for (let i = lines.length - 1; i >= 0; i--) {
      let item; try { item = JSON.parse(lines[i]); } catch { continue; }
      const model = item.type === 'assistant' && item.message?.model;
      if (typeof model === 'string' && model && model !== '<synthetic>') { value = { model, modelSource: 'last_response' }; break; }
    }
    if (models.size > 256) models.clear();
    models.set(file, { key, value }); return value;
  } catch { return { model: null, modelSource: 'unknown' }; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

const txt = (value, bytes = 160) => {
  let text = value === null || value === undefined || value === '' ? 'unknown' : String(value);
  text = text.replace(/[\x00-\x1f\x7f]/g, ' ');
  while (Buffer.byteLength(text) > bytes) text = text.slice(0, -1);
  return text;
};
export function hostAdvertisement(config, caps, sessionCount) {
  return { v: '1', id: config.hostId, sms_primary: config.smsPrimary || 'none', sms_role: config.smsPrimary === config.hostId ? 'primary' : config.smsPrimary ? 'follower' : 'disabled', name: txt(config.name, 63), os: txt(caps.os.type, 24), os_version: txt(caps.os.version, 48), arch: txt(caps.cpu.architecture, 24), cpu: txt(caps.cpu.model, 80), cores: String(caps.cpu.logicalCores), ram_gib: String(Math.round(caps.memoryBytes / 1024 ** 3 * 10) / 10), gpu: txt(caps.gpus.map((g) => g.name).join('; '), 128), gpu_compute: txt(caps.gpus.map((g) => g.metal || (g.cudaComputeCapability ? `cuda-sm-${g.cudaComputeCapability}` : 'unknown')).join('; '), 80), gpu_memory: txt(caps.gpus.map((g) => g.unifiedMemory ? 'unified' : g.memoryMiB ? `${g.memoryMiB}MiB` : g.memory || 'unknown').join('; '), 64), gpu_probe: caps.gpuDetection };
}
export function sessionAdvertisement(hostId, agent) {
  return { v: '1', host: hostId, id: agent.id, type: txt(agent.clientType || agent.kind, 32), name: txt(agent.name, 96), state: txt(agent.status, 32), model: txt(agent.model, 96), model_source: txt(agent.modelSource, 32) };
}

export function sanitizeCapabilities(value) {
  if (!value || typeof value !== 'object') return null;
  const number = (v) => Number.isFinite(v) && v >= 0 ? v : null;
  return {
    os: { type: txt(value.os?.type, 24), release: txt(value.os?.release, 48), version: txt(value.os?.version, 48) },
    cpu: { architecture: txt(value.cpu?.architecture, 24), model: txt(value.cpu?.model, 80), logicalCores: number(value.cpu?.logicalCores), availableCores: number(value.cpu?.availableCores) },
    memoryBytes: number(value.memoryBytes), gpuDetection: txt(value.gpuDetection, 32),
    gpus: (Array.isArray(value.gpus) ? value.gpus : []).slice(0, 16).filter((g) => g && typeof g === 'object').map((g) => ({ name: txt(g.name, 80), vendor: txt(g.vendor, 48), cores: number(g.cores), memoryMiB: number(g.memoryMiB), memory: txt(g.memory, 32), unifiedMemory: g.unifiedMemory === true, metal: txt(g.metal, 48), cudaComputeCapability: txt(g.cudaComputeCapability, 24), driverVersion: txt(g.driverVersion, 32) })),
  };
}
