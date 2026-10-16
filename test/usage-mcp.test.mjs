import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('MCP first-call guidance and host_status expose cached quotas without auth probes', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-usage-mcp-'));
  const now = Date.now();
  const p = { observedAt: now, checkedAt: now, nextCheckAt: now + 300_000, source: 'claude-oauth-usage', windows: [{ id: 'five_hour', usedPercent: 37, windowMinutes: 300, resetsAt: now + 300_000 }] };
  fs.writeFileSync(path.join(dir, 'usage.json'), JSON.stringify({ providers: { claude: p, codex: { ...p, source: 'codex-app-server' } } }));
  fs.writeFileSync(path.join(dir, 'presence.json'), JSON.stringify({ at: now, raw: { userIdleSec: 1, gpuUtil: 0 } }));
  const client = new Client({ name: 'usage-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['server.mjs'], env: { ...process.env, AGENTBUS_DIR: dir } });
  t.after(async () => { await client.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await client.connect(transport);
  assert.match(client.getInstructions(), /host_status first/);
  const tools = await client.listTools();
  assert.match(tools.tools.find(t => t.name === 'host_status').description, /FIRST CALL/);
  const r = await client.callTool({ name: 'host_status', arguments: { json: true } });
  const value = JSON.parse(r.content[0].text);
  assert.equal(value.local.usage.providers.claude.windows[0].usedPercent, 37);
  assert.equal(value.local.usage.providers.codex.windows[0].remainingPercent, 63);
  assert.equal(value.local.presence.user, 'present');
  assert.equal(value.local.usage.scope, 'account');
});
