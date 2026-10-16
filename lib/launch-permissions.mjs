import fs from 'node:fs';
import path from 'node:path';

const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
export function canonicalDirectory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw Error('permission root must be an absolute directory');
  const resolved = fs.realpathSync(value);
  if (!fs.statSync(resolved).isDirectory()) throw Error('permission root must be a directory');
  return resolved;
}
export function within(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}
export function normalizeProfiles(profiles = {}, hostRoots) {
  if (!object(profiles)) throw Error('permissionProfiles must be an object');
  const result = {};
  for (const [name, value] of Object.entries(profiles)) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name)) throw Error('invalid permission profile name');
    if (!object(value) || Object.keys(value).some((k) => !['workspaces', 'allowedSources', 'sandbox', 'writableRoots'].includes(k))) throw Error('unsupported permission profile fields');
    if (!['workspace-write', 'danger-full-access'].includes(value.sandbox)) throw Error('unsupported profile sandbox');
    if (!Array.isArray(value.workspaces) || !value.workspaces.length) throw Error('profile requires explicit workspaces');
    if (!Array.isArray(value.allowedSources) || !value.allowedSources.length || value.allowedSources.some((s) => typeof s !== 'string' || !/^(local|[0-9a-f-]{36})\/(codex|claude):[0-9a-f-]{36}$/.test(s))) throw Error('profile requires explicit authenticated allowedSources');
    const workspaces = [...new Set(value.workspaces.map(canonicalDirectory))];
    if (workspaces.some((w) => !hostRoots.some((r) => within(canonicalDirectory(r), w)))) throw Error('profile workspace outside host launch roots');
    if (value.writableRoots !== undefined && !Array.isArray(value.writableRoots)) throw Error('writableRoots must be an array');
    const writableRoots = [...new Set((value.writableRoots || []).map(canonicalDirectory))];
    if (value.sandbox === 'danger-full-access' && writableRoots.length) throw Error('full access cannot claim restricted writable roots');
    if (writableRoots.some((r) => r === path.parse(r).root)) throw Error('filesystem root cannot be a workspace write grant');
    result[name] = { workspaces, allowedSources: [...new Set(value.allowedSources)], sandbox: value.sandbox, writableRoots };
  }
  return result;
}
export function resolvePermissions(request, policy, source = request.permissionSource) {
  if (!request.permission_profile) return { sandbox: 'workspace-write', approvalPolicy: 'never', writableRoots: [], networkAccess: false };
  if (request.runtime !== 'codex') throw Error('permission profiles support codex only');
  const profiles = normalizeProfiles(policy.permissionProfiles, policy.roots);
  if (!Object.hasOwn(profiles, request.permission_profile)) throw Error('unknown destination permission profile');
  const p = profiles[request.permission_profile];
  if (!p.allowedSources.includes(source)) throw Error('permission profile not authorized for this sender');
  if (!p.workspaces.some((w) => within(w, canonicalDirectory(request.cwd)))) throw Error('permission profile does not cover this workspace');
  return { sandbox: p.sandbox, approvalPolicy: 'never', writableRoots: p.writableRoots, networkAccess: p.sandbox === 'danger-full-access' };
}
export function codexThreadParams(request, policy) {
  const permissions = resolvePermissions(request, policy);
  if (request.permissions && JSON.stringify(request.permissions) !== JSON.stringify(permissions)) throw Error('permission profile changed since launch receipt; launch rejected');
  const config = {
    'sandbox_workspace_write.writable_roots': permissions.writableRoots,
    'sandbox_workspace_write.network_access': false,
  };
  return { cwd: request.cwd, ...(request.model ? { model: request.model } : {}), sandbox: permissions.sandbox, approvalPolicy: 'never', config };
}

export function verifyNativePermissions(response, params) {
  const expected = params.sandbox === 'danger-full-access' ? 'dangerFullAccess' : 'workspaceWrite';
  if (response.approvalPolicy !== 'never' || response.sandbox?.type !== expected) throw Error(`native runtime did not accept requested permission profile (requested ${expected}/never, received ${response.sandbox?.type || 'missing'}/${response.approvalPolicy || 'missing'}); no task started${process.platform === 'win32' && response.sandbox?.type === 'readOnly' && expected === 'workspaceWrite' ? '; configure the native Windows sandbox before requesting workspace-write' : ''}`);
  if (expected === 'workspaceWrite' && (response.sandbox.networkAccess !== false || JSON.stringify([...(response.sandbox.writableRoots || [])].sort()) !== JSON.stringify([...params.config['sandbox_workspace_write.writable_roots']].sort()))) throw Error('native runtime returned unexpected writable roots/network; no task started');
  return { approvalPolicy: response.approvalPolicy, sandbox: response.sandbox };
}
