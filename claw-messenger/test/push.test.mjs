import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const push = fileURLToPath(new URL('../push.mjs', import.meta.url));

function fixture(t, threadIds) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-push-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, 'codex'), bus = path.join(root, 'bus');
  fs.mkdirSync(codexHome); fs.mkdirSync(bus);
  const db = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'));
  db.exec(`create table projects (id text primary key, name text);
    create table project_roots (project_id text, path text);
    create table threads (id text primary key, name text, title text, cwd text, updated_at integer, recency_at integer, preview text, model text, originator text, rollout_path text, project_id text);`);
  const insert = db.prepare('insert into threads (id, name, cwd, updated_at) values (?, ?, ?, ?)');
  for (const id of threadIds) insert.run(id, 'sms operator', '/tmp', Date.now());
  db.close();
  const run = (target) => JSON.parse(execFileSync(process.execPath, [push, target, 'claw messenger inbound test body'], { env: { ...process.env, AGENTBUS_DIR: bus, CODEX_HOME: codexHome }, encoding: 'utf8' }));
  return { bus, run };
}

test('a text routed to a known but unloaded codex thread is queued for the bridge, not dropped', (t) => {
  const thread = crypto.randomUUID();
  const { bus, run } = fixture(t, [thread]);
  const result = run(`codex:${thread}`);
  assert.equal(result.ok, true);
  assert.equal(result.delivery, 'queued');
  assert.match(result.note, /delivered by the codex bridge when the thread is opened/);
  const queued = fs.readdirSync(path.join(bus, 'inbox', thread)).filter((f) => f.endsWith('.json'));
  assert.equal(queued.length, 1, 'one hook/bridge-visible inbox file');
  const msg = JSON.parse(fs.readFileSync(path.join(bus, 'inbox', thread, queued[0]), 'utf8'));
  assert.equal(msg.from, 'service:claw-messenger');
  assert.match(msg.content, /claw messenger inbound test body/);
});

test('a text routed to an unknown codex thread still fails and stays in the claw inbox', (t) => {
  const { bus, run } = fixture(t, []);
  const missing = crypto.randomUUID();
  const result = run(`codex:${missing}`);
  assert.equal(result.ok, false);
  assert.match(result.error, /no live agent/);
  assert.equal(fs.existsSync(path.join(bus, 'inbox', missing)), false);
  assert.equal(run('codex:not-a-uuid').ok, false);
});
