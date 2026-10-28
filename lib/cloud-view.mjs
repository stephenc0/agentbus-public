// what peers see of cloud offers: sanitizing and formatting only. deliberately dependency-free (no lan.mjs, no runpod
// client): presence.mjs imports this lazily inside long-lived mcp servers, where a newer named import from a module the
// server cached before an upgrade would fail to link and take host_status down.
export const STATES = ['dormant', 'starting', 'live', 'stopping'];
const NAME = /^[a-zA-Z0-9_.-]{1,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const overlayIPv4 = (a) => { const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a || ''); if (!m || m.slice(1).some((x) => Number(x) > 255)) return false; return Number(m[1]) === 100 && Number(m[2]) >= 64 && Number(m[2]) <= 127; };
const clean = (v, n = 160) => typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, n) : null;
const num = (v) => Number.isFinite(v) && v >= 0 ? v : null;
export function sanitizeCloud(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.offers)) return null;
  const pv = value.provisioner;
  return { provisionerHostId: UUID.test(value.provisionerHostId || '') ? value.provisionerHostId : null, provisioner: pv && UUID.test(pv.hostId || '') && (overlayIPv4(pv.address) || /^127\./.test(pv.address || '')) && Number.isInteger(pv.port) && pv.port > 0 && pv.port < 65536 ? { hostId: pv.hostId, name: clean(pv.name, 63), address: pv.address, port: pv.port } : null, idleMinutes: num(value.idleMinutes), offers: value.offers.slice(0, 8).filter((o) => o && NAME.test(o.name || '')).map((o) => ({
    name: o.name, state: STATES.includes(o.state) ? o.state : 'dormant', gpu: clean(o.gpu, 80), count: num(o.count), gpuMemoryMiB: num(o.gpuMemoryMiB), memorySource: clean(o.memorySource, 24),
    ratePerHour: num(o.ratePerHour), billing: clean(o.billing, 48), coldStartMinutes: num(o.coldStartMinutes), maxHours: num(o.maxHours),
    pod: o.pod && UUID.test(o.pod.hostId || '') ? { hostId: o.pod.hostId, address: overlayIPv4(o.pod.address) || /^127\./.test(o.pod.address || '') ? o.pod.address : null, port: Number.isInteger(o.pod.port) && o.pod.port > 0 && o.pod.port < 65536 ? o.pod.port : null } : null,
    startedBy: o.startedBy && UUID.test(o.startedBy.hostId || '') ? { hostId: o.startedBy.hostId, hostName: clean(o.startedBy.hostName, 63), agentId: clean(o.startedBy.agentId, 96) } : null,
    users: (Array.isArray(o.users) ? o.users : []).slice(0, 16).filter((u) => UUID.test(u?.hostId || '')).map((u) => ({ hostId: u.hostId, hostName: clean(u.hostName, 63) })),
    startedAt: num(o.startedAt), liveAt: num(o.liveAt), capUntil: num(o.capUntil), capUsd: num(o.capUsd), idleSince: num(o.idleSince), progress: (Array.isArray(o.progress) ? o.progress : []).slice(-12).map((s) => clean(s, 200)).filter(Boolean),
    lastError: clean(o.lastError, 300), keptTasks: (Array.isArray(o.keptTasks) ? o.keptTasks : []).filter((t) => UUID.test(t)).slice(0, 64),
    last: o.last ? { reason: clean(o.last.reason, 120), stoppedAt: num(o.last.stoppedAt), hours: num(o.last.hours), estimateUsd: num(o.last.estimateUsd), startedBy: clean(o.last.startedBy, 63), stoppedBy: clean(o.last.stoppedBy, 63) } : null,
  })) };
}
export function sanitizeBlobActivity(b) {
  if (!b || typeof b !== 'object') return null;
  return { inFlight: Number.isInteger(b.inFlight) && b.inFlight >= 0 ? b.inFlight : null, lastTransferAt: num(b.lastTransferAt), tasks: (Array.isArray(b.tasks) ? b.tasks : []).slice(0, 256).filter((t) => UUID.test(t?.task || '')).map((t) => ({ task: t.task, ownerHostId: UUID.test(t.ownerHostId || '') ? t.ownerHostId : null, summary: t.summary === true, unfetched: t.unfetched === true, pendingFiles: Number.isInteger(t.pendingFiles) ? t.pendingFiles : 0, updatedAt: num(t.updatedAt) })) };
}
const mins = (ms) => Math.max(0, Math.round(ms / 60000));
export function formatOffer(o, host, now = Date.now()) {
  const mem = o.gpuMemoryMiB ? `${o.gpuMemoryMiB}MiB${o.memorySource === 'catalog' ? '~' : ''} cuda` : 'gpu memory unknown';
  const parts = [`${o.name}: offer on ${host}, ${o.state}`, `${mem} (${o.count > 1 ? `${o.count}x ` : ''}${o.gpu})`, o.ratePerHour === null ? 'cost unknown' : `$${o.ratePerHour}/h`];
  if (o.state === 'dormant') parts.push(`cold start ~${o.coldStartMinutes ?? '?'} min`, `cloud_up needs max_hours or max_usd (owner cap ${o.maxHours ?? '?'}h)`);
  if (o.state === 'starting') parts.push(`starting for ${mins(now - (o.startedAt || now))} min (started by ${o.startedBy?.hostName || 'unknown'})${o.progress.length ? `: ${o.progress.at(-1)}` : ''}`);
  if (o.state === 'live') parts.push(...[`live as peer ${o.name} (started by ${o.startedBy?.hostName || 'unknown'})`, o.capUntil ? `hard stop in ${mins(o.capUntil - now)} min` : null, o.idleSince ? `idle ${mins(now - o.idleSince)} min (stops at ${o.idleMinutes ?? 15})` : 'busy'].filter(Boolean));
  if (o.state === 'stopping') parts.push('terminating');
  if (o.lastError) parts.push(`last error: ${o.lastError}`);
  if (o.keptTasks?.length) parts.push(`unfetched results kept on the volume: ${o.keptTasks.length} task(s)`);
  return parts.join(', ');
}
