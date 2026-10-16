import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { processAlive } from '../lib/native-runtime.mjs';

for (const phase of ['startup', 'running']) test(`spontaneous codex exit during ${phase} finalizes once after descendant verification`, { timeout: 10000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'ab-exit-'));
  const cwd = path.join(dir, 'work'), bus = path.join(dir, 'bus'), launches = path.join(bus, 'launches');
  fs.mkdirSync(cwd); fs.mkdirSync(launches, { recursive: true });
  const id = crypto.randomUUID(), receipt = path.join(launches, id + '.json');
  fs.writeFileSync(receipt, JSON.stringify({ state: 'starting', createdAt: Date.now(), binary: process.execPath, request: { id, runtime: 'codex', cwd, prompt: 'test' } }));
  fs.writeFileSync(path.join(bus, 'launch-config.json'), JSON.stringify({ enabled: true, roots: [cwd] }));
  fs.writeFileSync(path.join(cwd, 'app-server'), `
const fs=require('node:fs'), {spawn}=require('node:child_process');
const descendant=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
fs.writeFileSync('descendant.pid',String(descendant.pid)); descendant.unref();
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line), result=r=>send({id:m.id,result:r});
 if(m.method==='initialize') { if(${JSON.stringify(phase)}==='startup') process.exit(7); result({userAgent:'fake'}); }
 else if(m.method==='thread/start') result({thread:{id:'thread-1',turns:[]},model:'test',approvalPolicy:'never',sandbox:{type:'workspaceWrite',networkAccess:false,writableRoots:[]}});
 else if(m.method==='thread/loaded/list') result({data:['thread-1'],nextCursor:null});
 else if(m.method==='turn/start') { result({turn:{id:'turn-1'}}); setTimeout(()=>process.exit(0),100); }
});
`);
  const worker = spawn(process.execPath, [fileURLToPath(new URL('../bin/session-worker.mjs', import.meta.url)), receipt], { env: { ...process.env, AGENTBUS_DIR: bus }, stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = ''; worker.stderr.on('data', b => { errors += b; });
  t.after(() => {
    if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL');
    try { process.kill(Number(fs.readFileSync(path.join(cwd, 'descendant.pid'), 'utf8')), 'SIGKILL'); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const [exitCode] = await once(worker, 'exit');
  const record = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  const descendant = Number(fs.readFileSync(path.join(cwd, 'descendant.pid'), 'utf8'));
  if (process.platform === 'win32') {
    assert.equal(record.state, 'uncertain');
    assert.match(record.error, /descendant termination cannot be verified/);
    assert.equal(exitCode, 1);
  } else {
    assert.equal(record.state, phase === 'startup' ? 'failed' : 'stopped', JSON.stringify(record) + errors);
    assert.equal(processAlive(descendant), false, 'terminal success/failure never leaves an owned descendant alive');
    assert.equal(exitCode, phase === 'startup' ? 1 : 0);
    assert.match(record.note, /cleanup verified/);
  }
});

test('claude supervisor clears native inventory monitor after verified stop and exits', { skip: process.platform === 'win32', timeout: 12000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join('/tmp', 'ab-claude-exit-'));
  const launches = path.join(dir, 'launches'); fs.mkdirSync(launches);
  const runtime = path.join(dir, 'fake-claude'), marker = path.join(dir, 'native-stopped');
  fs.writeFileSync(runtime, `#!${process.execPath}
const fs=require('node:fs');
const stopped=${JSON.stringify(marker)}, sid='abc12345-0000-4000-8000-000000000000';
if(process.argv.includes('--bg')) console.log('backgrounded · abc12345 · fake');
else if(process.argv.includes('stop')) { fs.writeFileSync(stopped,''); console.log('stopped abc12345'); }
else if(process.argv.includes('agents')) console.log(JSON.stringify([{kind:'background',sessionId:sid,cwd:${JSON.stringify(dir)},state:fs.existsSync(stopped)?'stopped':'working',...(!fs.existsSync(stopped)?{pid:process.ppid}:{})}]));
`, { mode: 0o700 });
  const id = crypto.randomUUID(), receipt = path.join(launches, id + '.json');
  fs.writeFileSync(receipt, JSON.stringify({ state: 'starting', createdAt: Date.now(), binary: runtime, request: { id, runtime: 'claude-code', cwd: dir, prompt: 'test' } }));
  const worker = spawn(process.execPath, [fileURLToPath(new URL('../bin/session-worker.mjs', import.meta.url)), receipt], { env: { ...process.env, AGENTBUS_DIR: dir }, stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = ''; worker.stderr.on('data', (b) => { errors += b; });
  t.after(() => { if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); });
  for (let n = 0; n < 100 && !JSON.parse(fs.readFileSync(receipt, 'utf8')).nativeSeen; n++) await new Promise(r => setTimeout(r, 30));
  assert.equal(JSON.parse(fs.readFileSync(receipt, 'utf8')).nativeSeen, true, errors);
  fs.writeFileSync(receipt + '.stop', '');
  for (let n = 0; n < 150 && worker.exitCode === null; n++) await new Promise(r => setTimeout(r, 30));
  assert.equal(worker.exitCode, 0, 'supervisor must release every monitor after native stop: ' + errors);
  assert.equal(JSON.parse(fs.readFileSync(receipt, 'utf8')).state, 'stopped');
  assert(fs.existsSync(marker));
});
