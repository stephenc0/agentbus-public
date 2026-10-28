// tailscale api v2 through an oauth client (trust credential): per-pod single-use auth keys, and an additive-only
// policy file edit. field names and headers follow the published openapi spec
// (https://api.tailscale.com/api/v2?outputOpenapiSchema=true): POST /oauth/token (client credentials),
// POST /tailnet/-/keys {keyType:'auth', capabilities.devices.create{reusable,ephemeral,preauthorized,tags}, expirySeconds},
// GET /tailnet/-/acl (Accept: application/hujson, ETag), POST /tailnet/-/acl (If-Match: <ETag>, 412 on mismatch),
// POST /tailnet/-/acl/validate, POST /tailnet/-/acl/preview?type=ipport&previewFor=ip:port.
// secrets (client secret, access token, minted keys) never appear in errors, logs or return values other than mint's.
export const TS_API = 'https://api.tailscale.com/api/v2';
export const POD_TAG = 'tag:agentbus-gpu';

export function tailscaleClient({ clientId, clientSecret, fetchImpl = globalThis.fetch, base = TS_API, now = () => Date.now() }) {
  if (!clientId || !clientSecret) throw Error('tailscale oauth client id and secret are not configured (agentbus cloud secrets --from-env with TS_OAUTH_CLIENT_ID, TS_OAUTH_CLIENT_SECRET)');
  let token = null, tokenUntil = 0;
  const fail = async (what, res) => { let detail = ''; try { const j = JSON.parse(await res.text()); detail = typeof j.message === 'string' ? ` ${j.message.slice(0, 300)}` : ''; } catch {} return Error(`tailscale ${what}: http ${res.status}${detail}`); };
  async function bearer() {
    if (token && now() < tokenUntil) return token;
    const res = await fetchImpl(`${base}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }).toString(), signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw await fail('oauth token', res);
    const j = await res.json();
    if (typeof j.access_token !== 'string') throw Error('tailscale oauth token: no access_token in response');
    token = j.access_token; tokenUntil = now() + Math.max(60, (Number(j.expires_in) || 3600) - 120) * 1000;
    return token;
  }
  const call = async (method, path, { body, type = 'application/json', accept = 'application/json', headers = {} } = {}) => fetchImpl(`${base}${path}`, { method, headers: { Authorization: `Bearer ${await bearer()}`, Accept: accept, ...(body !== undefined ? { 'Content-Type': type } : {}), ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  return {
    // single use, ephemeral, pre-approved, tagged: one device, removed from the tailnet once it goes offline
    async mintAuthKey({ tags = [POD_TAG], expirySeconds = 1800, description = 'agentbus cloud pod' } = {}) {
      const res = await call('POST', '/tailnet/-/keys', { body: { keyType: 'auth', description: description.replace(/[^A-Za-z0-9 -]/g, '-').slice(0, 50), capabilities: { devices: { create: { reusable: false, ephemeral: true, preauthorized: true, tags } } }, expirySeconds } });
      if (!res.ok) throw await fail('create auth key', res);
      const j = await res.json();
      if (typeof j.key !== 'string' || !j.key.startsWith('tskey-')) throw Error('tailscale create auth key: no key in response');
      return { key: j.key, id: j.id, expires: j.expires };
    },
    async revokeKey(id) { if (!id) return; const res = await call('DELETE', `/tailnet/-/keys/${encodeURIComponent(id)}`); if (!res.ok && res.status !== 404) throw await fail('revoke auth key', res); },
    async getPolicy() {
      const res = await call('GET', '/tailnet/-/acl', { accept: 'application/hujson' });
      if (!res.ok) throw await fail('get policy file', res);
      return { text: await res.text(), etag: res.headers.get('etag') };
    },
    async validate(text) { const res = await call('POST', '/tailnet/-/acl/validate', { body: text, type: 'application/hujson' }); const raw = await res.text(); let j = {}; try { j = raw ? JSON.parse(raw) : {}; } catch {} return { ok: res.ok && !j.message, message: j.message || (res.ok ? null : `http ${res.status}`), data: j.data || null }; },
    async preview(text, previewFor) { const res = await call('POST', `/tailnet/-/acl/preview?type=ipport&previewFor=${encodeURIComponent(previewFor)}`, { body: text, type: 'application/hujson' }); if (!res.ok) throw await fail('preview policy', res); return res.json(); },
    async setPolicy(text, etag) {
      if (!etag) throw Error('refusing to set the policy file without the ETag from the read (If-Match)');
      const res = await call('POST', '/tailnet/-/acl', { body: text, type: 'application/hujson', accept: 'application/hujson', headers: { 'If-Match': etag } });
      if (res.status === 412) throw Error('the policy file changed since it was read (If-Match mismatch); nothing was applied. rerun the command');
      if (!res.ok) throw await fail('set policy file', res);
      return { etag: res.headers.get('etag') };
    },
  };
}

// ----- hujson (json with comments and trailing commas): read and an insertion-only edit -----
// scans outside strings and comments; returns { json } with comments/trailing commas removed.
export function hujsonToJson(text) {
  let out = '', i = 0;
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (c === '"') { let j = i + 1; while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1; out += text.slice(i, j + 1); i = j + 1; continue; }
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { const end = text.indexOf('*/', i + 2); if (end < 0) throw Error('unterminated comment in policy file'); i = end + 2; continue; }
    out += c; i++;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}
export const parseHujson = (text) => JSON.parse(hujsonToJson(text));
// positions of the top-level object's opening brace and of a top-level key's value, outside strings/comments
function locate(text, key) {
  let i = 0, depth = 0, top = -1, valueAt = -1;
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i = text.indexOf('*/', i + 2) + 2; continue; }
    if (c === '"') {
      let j = i + 1; while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      if (depth === 1 && JSON.parse(text.slice(i, j + 1)) === key) {
        let k = j + 1; while (/\s/.test(text[k])) k++;
        if (text[k] === ':') { k++; while (k < text.length && (/\s/.test(text[k]) || text.startsWith('//', k) || text.startsWith('/*', k))) { if (text.startsWith('//', k)) { while (text[k] !== '\n') k++; } else if (text.startsWith('/*', k)) k = text.indexOf('*/', k) + 2; else k++; } valueAt = k; }
      }
      i = j + 1; continue;
    }
    if (c === '{' || c === '[') { if (depth === 0 && c === '{' && top < 0) top = i; depth++; }
    else if (c === '}' || c === ']') depth--;
    i++;
  }
  return { top, valueAt };
}
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// add tagOwners[tag] = owners if absent. text-level insertion only, so comments, order and every rule survive; the
// result is re-parsed and must equal the original plus exactly that one entry, or nothing is returned.
export function addTagOwner(text, { tag = POD_TAG, owners = ['autogroup:admin'] } = {}) {
  const before = parseHujson(text);
  if (!before || typeof before !== 'object' || Array.isArray(before)) throw Error('policy file is not an object');
  if (before.tagOwners && typeof before.tagOwners !== 'object') throw Error('policy tagOwners is not an object');
  if (before.tagOwners && Object.prototype.hasOwnProperty.call(before.tagOwners, tag)) return { changed: false, text, reason: `${tag} already has owners: ${JSON.stringify(before.tagOwners[tag])}` };
  const entry = `${JSON.stringify(tag)}: ${JSON.stringify(owners)}`;
  const { top, valueAt } = locate(text, 'tagOwners');
  let next;
  if (before.tagOwners) {
    if (text[valueAt] !== '{') throw Error('could not locate the tagOwners object');
    const empty = Object.keys(before.tagOwners).length === 0;
    next = `${text.slice(0, valueAt + 1)}\n\t\t${entry}${empty ? '' : ','}${text.slice(valueAt + 1)}`;
  } else {
    if (top < 0) throw Error('could not locate the top-level object');
    const empty = Object.keys(before).length === 0;
    next = `${text.slice(0, top + 1)}\n\t// added by agentbus cloud tailnet-policy: who may assign the cloud pod tag\n\t"tagOwners": {\n\t\t${entry},\n\t}${empty ? '' : ','}${text.slice(top + 1)}`;
  }
  const after = parseHujson(next);
  const expected = { ...before, tagOwners: { ...(before.tagOwners || {}), [tag]: owners } };
  const strip = (o) => { const c = structuredClone(o); delete c.tagOwners[tag]; if (!before.tagOwners) delete c.tagOwners; return c; };
  if (!sameJson(strip(after), before) || !sameJson(after.tagOwners[tag], owners) || Object.keys(after).length !== Object.keys(expected).length) throw Error('refusing: the edited policy is not exactly the original plus one tagOwners entry');
  return { changed: true, text: next, reason: `adds tagOwners ${tag}: ${JSON.stringify(owners)}` };
}
// is the access part the untouched allow-all? (acls has an accept * -> *:* rule and no grants)
// does the policy already let everything reach everything? either form tailscale has shipped as the default:
// grants {"src":["*"],"dst":["*"],"ip":["*"]} (current), or acls {"action":"accept","src":["*"],"dst":["*:*"]} (legacy).
// a grant narrowed by posture, via (routing) or app capabilities only is not allow-all.
export function allowsAll(policy) {
  const has = (list, v) => Array.isArray(list) && list.includes(v);
  const grant = Array.isArray(policy?.grants) && policy.grants.some((g) => g && has(g.src, '*') && has(g.dst, '*') && has(g.ip, '*') && !g.srcPosture && !g.via);
  const acl = Array.isArray(policy?.acls) && policy.acls.some((r) => r?.action === 'accept' && (has(r.src, '*') || has(r.users, '*')) && (has(r.dst, '*:*') || has(r.ports, '*:*')));
  return grant || acl;
}
export function lineDiff(a, b) {
  const x = a.split('\n'), y = b.split('\n');
  let s = 0; while (s < x.length && s < y.length && x[s] === y[s]) s++;
  let e = 0; while (e < x.length - s && e < y.length - s && x[x.length - 1 - e] === y[y.length - 1 - e]) e++;
  const ctx = 2, out = [];
  for (let i = Math.max(0, s - ctx); i < s; i++) out.push(`  ${x[i]}`);
  for (let i = s; i < x.length - e; i++) out.push(`- ${x[i]}`);
  for (let i = s; i < y.length - e; i++) out.push(`+ ${y[i]}`);
  for (let i = y.length - e; i < Math.min(y.length, y.length - e + ctx); i++) out.push(`  ${y[i]}`);
  return out.join('\n');
}

// `agentbus cloud tailnet-policy`: read the policy, add tagOwners for the pod tag if missing (insertion only), validate,
// preview what reaches the agentbus port, print the diff, and write only with apply (If-Match on the read's ETag).
// it never touches acls/grants: a default allow-all stays allow-all; a custom policy gets advice, not edits.
export async function tailnetPolicy({ clientId, clientSecret, apply = false, previewFor, log = console.log, client }) {
  const ts = client || tailscaleClient({ clientId, clientSecret });
  const { text, etag } = await ts.getPolicy();
  const policy = parseHujson(text);
  const all = allowsAll(policy);
  log(`policy: ${all ? 'allow-all (an allow-all grant or acl: tagged pods can reach every device; left as is)' : 'custom access rules (not allow-all)'}`);
  const edit = addTagOwner(text);
  log(edit.reason);
  if (!all) log(`note: with a custom policy, tagOwners alone does not let ${POD_TAG} reach the group. add grants by hand (not done here):\n  { "src": ["${POD_TAG}"], "dst": ["autogroup:member"], "ip": ["tcp:47800"] },\n  { "src": ["autogroup:member"], "dst": ["${POD_TAG}"], "ip": ["tcp:47800"] }`);
  if (!edit.changed) return { ok: true, changed: false, allowAll: all };
  const v = await ts.validate(edit.text);
  if (!v.ok) { log(`validate FAILED: ${v.message}`); return { ok: false, changed: false, error: v.message }; }
  log('validate: ok');
  if (previewFor) { try { const p = await ts.preview(edit.text, previewFor); log(`preview ${previewFor}: ${(p.matches || []).length} matching rule(s)${(p.matches || []).map((m) => `\n  ${JSON.stringify(m.users || [])} -> ${JSON.stringify(m.ports || [])}`).join('')}`); } catch (e) { log(`preview: ${e.message}`); } }
  log(`diff:\n${lineDiff(text, edit.text)}`);
  if (!apply) { log('dry run: nothing written. rerun with --apply'); return { ok: true, changed: false, wouldChange: true, allowAll: all }; }
  await ts.setPolicy(edit.text, etag);
  log('applied (If-Match on the ETag read above)');
  return { ok: true, changed: true, allowAll: all };
}
