import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tailscaleClient, addTagOwner, parseHujson, allowsAll, tailnetPolicy, POD_TAG } from '../lib/tailscale-api.mjs';

const DEFAULT_POLICY = `// Example/default ACLs for unrestricted connections.
{
	// Declare static groups of users.
	"groups": {"group:example": ["alice@example.com", "bob@example.com"]},

	// Define access control lists for users, groups, autogroups, tags,
	"acls": [
		// Allow all connections.
		{"action": "accept", "src": ["*"], "dst": ["*:*"]},
	],

	"ssh": [
		{"action": "check", "src": ["autogroup:member"], "dst": ["autogroup:self"], "users": ["autogroup:nonroot", "root"]},
	],
}
`;

function fakeTailscale({ policy = DEFAULT_POLICY, etag = '"e0b2816b418"' } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url); calls.push({ method: init.method, path: u.pathname + u.search, headers: init.headers, body: init.body });
    const res = (status, body, headers = {}) => ({ status, ok: status < 300, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: async () => typeof body === 'string' ? body : JSON.stringify(body), json: async () => body });
    if (u.pathname === '/api/v2/oauth/token') return res(200, { access_token: 'tskey-api-ACCESS', token_type: 'Bearer', expires_in: 3600 });
    if (u.pathname === '/api/v2/tailnet/-/keys' && init.method === 'POST') return res(200, { id: 'kid1', key: 'tskey-auth-MINTED-secret', expires: '2026-10-28T20:00:00Z' });
    if (u.pathname.startsWith('/api/v2/tailnet/-/keys/') && init.method === 'DELETE') return res(200, {});
    if (u.pathname === '/api/v2/tailnet/-/acl' && init.method === 'GET') return res(200, policy, { etag });
    if (u.pathname === '/api/v2/tailnet/-/acl/validate') return res(200, '');
    if (u.pathname === '/api/v2/tailnet/-/acl/preview') return res(200, { matches: [{ users: ['*'], ports: ['*:*'] }] });
    if (u.pathname === '/api/v2/tailnet/-/acl' && init.method === 'POST') return init.headers['If-Match'] === etag ? res(200, init.body, { etag: '"next"' }) : res(412, { message: 'If-Match hash mismatch' });
    return res(404, { message: 'nope' });
  };
  return { calls, client: tailscaleClient({ clientId: 'cid', clientSecret: 'csecret', fetchImpl, base: 'https://api.example/api/v2' }) };
}

test('oauth token exchange and single-use key minting follow the api spec; secrets stay out of errors', async () => {
  const { calls, client } = fakeTailscale();
  const k = await client.mintAuthKey({ expirySeconds: 1500, description: 'agentbus runpod-h100' });
  assert.equal(k.key, 'tskey-auth-MINTED-secret');
  const [tok, mint] = calls;
  assert.equal(tok.path, '/api/v2/oauth/token'); assert.equal(tok.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(tok.body)), { client_id: 'cid', client_secret: 'csecret', grant_type: 'client_credentials' });
  assert.equal(mint.headers.Authorization, 'Bearer tskey-api-ACCESS');
  assert.deepEqual(JSON.parse(mint.body), { keyType: 'auth', description: 'agentbus runpod-h100', capabilities: { devices: { create: { reusable: false, ephemeral: true, preauthorized: true, tags: [POD_TAG] } } }, expirySeconds: 1500 });
  await client.mintAuthKey();
  assert.equal(calls.filter((c) => c.path === '/api/v2/oauth/token').length, 1, 'the access token is cached for its lifetime');
  const bad = tailscaleClient({ clientId: 'cid', clientSecret: 'csecret', base: 'https://x', fetchImpl: async () => ({ status: 401, ok: false, text: async () => JSON.stringify({ message: 'invalid client' }) }) });
  await assert.rejects(bad.mintAuthKey(), (e) => /oauth token: http 401 invalid client/.test(e.message) && !e.message.includes('csecret'));
  assert.throws(() => tailscaleClient({}), /oauth client id and secret/);
});

test('tagOwners edit is insertion only: comments and every rule survive, an existing owner is left alone', () => {
  const r = addTagOwner(DEFAULT_POLICY);
  assert.equal(r.changed, true);
  const before = parseHujson(DEFAULT_POLICY), after = parseHujson(r.text);
  assert.deepEqual(after.tagOwners, { [POD_TAG]: ['autogroup:admin'] });
  delete after.tagOwners; assert.deepEqual(after, before, 'nothing else changed');
  assert.ok(r.text.includes('// Allow all connections.'), 'comments kept');
  assert.ok(allowsAll(parseHujson(r.text)), 'allow-all stays allow-all');
  // existing tagOwners with other tags: entry added inside, others untouched
  const custom = `{\n  // mine\n  "tagOwners": { "tag:server": ["group:ops"], },\n  "grants": [{ "src": ["group:ops"], "dst": ["tag:server"], "ip": ["*"] }],\n}`;
  const c = addTagOwner(custom);
  assert.deepEqual(parseHujson(c.text).tagOwners, { [POD_TAG]: ['autogroup:admin'], 'tag:server': ['group:ops'] });
  assert.deepEqual(parseHujson(c.text).grants, parseHujson(custom).grants);
  assert.equal(allowsAll(parseHujson(custom)), false);
  // already present (even with different owners): no change, never narrowed
  const has = `{"tagOwners": {"${POD_TAG}": ["group:ops"]}, "acls": []}`;
  assert.deepEqual(addTagOwner(has), { changed: false, text: has, reason: `${POD_TAG} already has owners: ["group:ops"]` });
  // strings that look like keys or comments do not confuse the scanner
  const tricky = `{"groups": {"group:x": ["a//b@example.com", "\\"tagOwners\\""]}, "acls": [{"action":"accept","src":["*"],"dst":["*:*"]}]}`;
  assert.deepEqual(parseHujson(addTagOwner(tricky).text).groups, parseHujson(tricky).groups);
  assert.deepEqual(parseHujson(addTagOwner('{}').text), { tagOwners: { [POD_TAG]: ['autogroup:admin'] } });
});

// tailscale's current default is the grants form. the bare grant is verbatim from
// https://tailscale.com/docs/reference/examples/grants ("Allow all"); the commented file mirrors the stock default layout.
const GRANTS_DEFAULT = `// Example/default ACLs for unrestricted connections.
{
	// Declare static groups of users. Use autogroups for all users or users with a specific role.
	// "groups": {
	//   "group:example": ["alice@example.com", "bob@example.com"],
	// },

	// Define the tags which can be applied to devices and by which users.
	"tagOwners": {"tag:agentbus-gpu": ["autogroup:admin"]},

	// Define grants that govern access for users, groups, autogroups, tags,
	// Tailscale IP addresses, and subnet ranges.
	"grants": [
		// Allow all connections.
		// Comment this section out if you want to define specific restrictions.
		{"src": ["*"], "dst": ["*"], "ip": ["*"]},

		// Allow users in "group:example" to access "tag:example", but only from
		// devices that are running macOS and have enabled Tailscale client auto-updating.
		// {"src": ["group:example"], "dst": ["tag:example"], "ip": ["*"], "srcPosture":["posture:autoUpdateMac"]},
	],

	// Define postures that will be applied to all rules without any specific
	// srcPosture definition.
	// "defaultSrcPosture": [
	//      "posture:anyMac",
	// ],

	// Define device posture rules requiring devices to meet
	// certain criteria to access parts of your system.
	// "postures": {
	//      // Require devices running macOS, a stable Tailscale
	//      // version and auto update enabled for Tailscale.
	// 	"posture:autoUpdateMac": [
	// 	    "node:os == 'macos'",
	// 	    "node:tsReleaseTrack == 'stable'",
	// 	    "node:tsAutoUpdate",
	// 	],
	// },
}
`;
test('allow-all is recognised in both default forms (grants and legacy acls) and nothing narrower passes', async () => {
  assert.equal(allowsAll(parseHujson(GRANTS_DEFAULT)), true, 'current grants default');
  assert.equal(allowsAll({ grants: [{ src: ['*'], dst: ['*'], ip: ['*'] }] }), true, 'verbatim docs example');
  assert.equal(allowsAll({ grants: [{ ip: ['*'], dst: ['*'], src: ['*'] }] }), true, 'key order is irrelevant');
  assert.equal(allowsAll(parseHujson(DEFAULT_POLICY)), true, 'legacy acls default');
  for (const narrow of [{ grants: [{ src: ['*'], dst: ['tag:server'], ip: ['*'] }] }, { grants: [{ src: ['*'], dst: ['*'], ip: ['tcp:443'] }] }, { grants: [{ src: ['autogroup:member'], dst: ['*'], ip: ['*'] }] },
    { grants: [{ src: ['*'], dst: ['*'], ip: ['*'], srcPosture: ['posture:latest'] }] }, { grants: [{ src: ['*'], dst: ['*'], app: { 'example.com/cap': [{}] } }] }, { acls: [{ action: 'accept', src: ['*'], dst: ['*:443'] }] }, {}])
    assert.equal(allowsAll(narrow), false, JSON.stringify(narrow));
  // the reported run: grants default with the tag already owned -> allow-all, no grant advice, no change
  const lines = [];
  const r = await tailnetPolicy({ client: fakeTailscale({ policy: GRANTS_DEFAULT }).client, log: (s) => lines.push(s) });
  assert.deepEqual(r, { ok: true, changed: false, allowAll: true });
  assert.ok(lines[0].startsWith('policy: allow-all'));
  assert.ok(!lines.some((l) => /add grants by hand/.test(l)), 'no manual grant advice for an allow-all policy');
});

test('tailnet-policy: dry run validates and previews without writing; --apply writes with If-Match; a changed policy is not overwritten', async () => {
  const lines = [];
  const dry = fakeTailscale();
  const r = await tailnetPolicy({ client: dry.client, previewFor: '100.102.7.114:47800', log: (s) => lines.push(s) });
  assert.equal(r.wouldChange, true); assert.equal(r.allowAll, true);
  assert.equal(dry.calls.some((c) => c.method === 'POST' && c.path === '/api/v2/tailnet/-/acl'), false, 'dry run writes nothing');
  const get = dry.calls.find((c) => c.path === '/api/v2/tailnet/-/acl' && c.method === 'GET');
  assert.equal(get.headers.Accept, 'application/hujson');
  const val = dry.calls.find((c) => c.path === '/api/v2/tailnet/-/acl/validate');
  assert.equal(val.headers['Content-Type'], 'application/hujson');
  assert.ok(dry.calls.some((c) => c.path === '/api/v2/tailnet/-/acl/preview?type=ipport&previewFor=100.102.7.114%3A47800'));
  assert.ok(lines.some((l) => l.startsWith('diff:') && l.includes(`+ \t\t"${POD_TAG}": ["autogroup:admin"],`)));
  const live = fakeTailscale();
  assert.equal((await tailnetPolicy({ client: live.client, apply: true, log: () => {} })).changed, true);
  const set = live.calls.find((c) => c.path === '/api/v2/tailnet/-/acl' && c.method === 'POST');
  assert.equal(set.headers['If-Match'], '"e0b2816b418"'); assert.equal(set.headers['Content-Type'], 'application/hujson');
  const raced = fakeTailscale(); const orig = raced.client.setPolicy;
  raced.client.setPolicy = (text) => orig(text, '"stale"');
  await assert.rejects(tailnetPolicy({ client: raced.client, apply: true, log: () => {} }), /changed since it was read/);
  const done = fakeTailscale({ policy: addTagOwner(DEFAULT_POLICY).text });
  assert.equal((await tailnetPolicy({ client: done.client, apply: true, log: () => {} })).changed, false, 'idempotent');
});

test('pod watchdog terminates its own pod after the deadline with the injected pod-scoped key, falling back to stop', { skip: process.platform === 'win32', timeout: 30000 }, async (t) => {
  const seen = [];
  let deleteStatus = 403;
  const server = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: b }); res.statusCode = req.method === 'DELETE' ? deleteStatus : 200; res.end(); }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const run = () => new Promise((resolve) => {
    const env = { PATH: '/usr/bin:/bin', AGENTBUS_HARD_STOP_AT: String(Math.floor(Date.now() / 1000) + 1), AGENTBUS_WATCHDOG_POLL: '1', RUNPOD_API_BASE: `http://127.0.0.1:${server.address().port}`, RUNPOD_POD_ID: 'pod123', RUNPOD_API_KEY: 'pod-scoped' };
    const p = spawn('bash', [fileURLToPath(new URL('../scripts/runpod/watchdog.sh', import.meta.url))], { env });
    let out = ''; p.stdout.on('data', (d) => (out += d)); p.on('close', (code) => resolve({ code, out }));
  });
  const first = await run();
  assert.equal(first.code, 0, first.out);
  assert.deepEqual(seen.map((s) => `${s.method} ${s.url}`), ['DELETE /v2/pods/pod123', 'POST /v2/pods/pod123/action']);
  assert.equal(seen[1].body, '{"action":"stop"}'); assert.ok(seen.every((s) => s.auth === 'Bearer pod-scoped'));
  seen.length = 0; deleteStatus = 204;
  assert.equal((await run()).code, 0);
  assert.deepEqual(seen.map((s) => s.method), ['DELETE']);
  const none = await new Promise((resolve) => { const p = spawn('bash', [fileURLToPath(new URL('../scripts/runpod/watchdog.sh', import.meta.url))], { env: { PATH: '/usr/bin:/bin' } }); p.on('close', resolve); });
  assert.equal(none, 0, 'no deadline: backstop off');
});
