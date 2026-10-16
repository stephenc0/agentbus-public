import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { startClaudeRelay, relayToClaude } from '../lib/claude-relay.mjs';
import { requestBridge } from '../lib/codex-push.mjs';

test('receiving MCP relay authenticates before the message; token never enters registration or replies', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-cr-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessionId = crypto.randomUUID(), token = crypto.randomBytes(32).toString('hex');
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\ab-test-${sessionId}` : path.join(root, 'inbox.sock');
  const frames = [];
  const native = net.createServer((s) => { let input = ''; s.on('error', () => {}); s.on('data', (c) => { input += c; while (input.includes('\n')) { const i = input.indexOf('\n'); frames.push(JSON.parse(input.slice(0, i))); input = input.slice(i + 1); } }); });
  native.listen(socketPath); await once(native, 'listening'); t.after(() => new Promise((r) => native.close(r)));
  const relay = await startClaudeRelay({ busDir: root, sessionId, socketPath, token }); t.after(() => relay.close());
  const registration = fs.readFileSync(relay.registry, 'utf8'); assert(!registration.includes(token));
  const denied = await requestBridge(relay.endpoint, { key: 'wrong', sessionId, content: 'no', from: 'test' }); assert.equal(denied.status, 'rejected'); assert.equal(frames.length, 0);
  const result = await relayToClaude(root, { sessionId, socket: socketPath }, 'shared storage brief', 'agentbus:codex:test');
  assert.equal(result.status, 'accepted'); assert.equal(result.delivery, 'queued'); assert(!JSON.stringify(result).includes(token));
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(frames[0], { type: 'auth', token }); assert.equal(frames[1].message.content, 'shared storage brief');
  // /clear rotates the session id under the same socket; delivery must survive it
  assert.equal((await relayToClaude(root, { sessionId: crypto.randomUUID(), socket: socketPath }, 'rotated session', 'test')).status, 'accepted');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(frames[3].message.content, 'rotated session');
  assert.equal((await relayToClaude(root, { sessionId, socket: socketPath + '-other' }, 'wrong socket', 'test')).status, 'unavailable');
  await relay.close(); assert(!fs.existsSync(relay.registry));
});

test('missing receiving token creates no relay', async () => {
  assert.equal(await startClaudeRelay({ busDir: os.tmpdir(), sessionId: crypto.randomUUID(), socketPath: 'unused' }), null);
});
