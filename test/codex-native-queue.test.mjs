import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNativeQueueTransport } from '../lib/codex-native-queue.mjs';

function fixture(t, mode) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-native-q-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'app-server'), `
const fs=require('node:fs');
if(process.argv.includes('generate-json-schema')){
 const out=process.argv[process.argv.indexOf('--out')+1]; fs.mkdirSync(out+'/v2');
 for(const [name,properties] of Object.entries({ThreadQueueAddParams:{threadId:{},clientUserMessageId:{},input:{}},ThreadQueueAddResponse:{queuedSubmission:{}},ThreadQueueListResponse:{data:{}}})) fs.writeFileSync(out+'/v2/'+name+'.json',JSON.stringify({properties}));
 process.exit(0);
}
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);fs.appendFileSync('rpc.jsonl',line+'\\n');const send=r=>process.stdout.write(JSON.stringify({id:m.id,...r})+'\\n');
 if(m.method==='initialize') send({result:{}});
 if(m.method==='thread/queue/list') send(${JSON.stringify(mode)}==='untouched'?{error:{code:-32600,message:'no rollout found'}}:{result:{data:[],nextCursor:null}});
 if(m.method==='thread/queue/add'){
  if(${JSON.stringify(mode)}==='timeout') return;
  if(${JSON.stringify(mode)}==='reject') return send({error:{code:-32602,message:'queue rejected'}});
  send({result:{queuedSubmission:{id:'queue-1',clientUserMessageId:${JSON.stringify(mode)}==='bad-ack'?'wrong':m.params.clientUserMessageId,input:m.params.input}}});
 }
});
`);
  // Match the production budget: cold Node startup on a loaded Windows runner
  // can exceed 250ms before initialize, unrelated to queue rejection semantics.
  return { cwd, transport: createNativeQueueTransport({ binary: process.execPath, cwd, codexHome: cwd, timeoutMs: 5000 }), frames: () => fs.readFileSync(path.join(cwd, 'rpc.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) };
}
test('native queue preserves message id and only invokes supported queue APIs', async (t) => {
  const f = fixture(t, 'success');
  assert.equal((await f.transport.probe(['thread']))['thread'].ready, true);
  const result = await f.transport.add('thread', { msg_id: 'stable-id', content: 'original content' });
  assert.deepEqual(result, { status: 'accepted', method: 'thread/queue/add', queueId: 'queue-1' });
  const frames = f.frames();
  assert(frames.every((m) => ['initialize', 'initialized', 'thread/queue/list', 'thread/queue/add'].includes(m.method)));
  assert(frames.filter((m) => m.method === 'initialize').every((m) => m.params.capabilities.experimentalApi));
  assert.deepEqual(frames.find((m) => m.method === 'thread/queue/add').params, { threadId: 'thread', clientUserMessageId: 'stable-id', input: [{ type: 'text', text: 'original content' }] });
});
for (const [mode, status] of [['untouched', 'unavailable'], ['reject', 'rejected'], ['timeout', 'uncertain'], ['bad-ack', 'uncertain']]) test(`native queue ${mode} result is ${status} without mutation retry`, async (t) => {
  const f = fixture(t, mode);
  assert.equal((await f.transport.add('thread', { msg_id: 'stable-id', content: 'content' })).status, status);
  assert.equal(f.frames().filter((m) => m.method === 'thread/queue/add').length, mode === 'untouched' ? 0 : 1);
});
test('native queue serializes concurrent app-server transactions', async (t) => {
  const f = fixture(t, 'success');
  await Promise.all([f.transport.add('a', { msg_id: 'a', content: 'a' }), f.transport.add('b', { msg_id: 'b', content: 'b' })]);
  assert.deepEqual(f.frames().filter((m) => m.method !== 'initialized').map((m) => m.method), ['initialize','thread/queue/list','thread/queue/add','initialize','thread/queue/list','thread/queue/add']);
});

for (const mode of ['success', 'timeout', 'reject']) test(`core native fallback ${mode} preserves exactly one durable delivery path`, async (t) => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const f = fixture(t, mode), bus = path.join(f.cwd, 'bus'); fs.mkdirSync(bus);
  fs.writeFileSync(path.join(bus, 'native-queue-config.json'), JSON.stringify({ enabled: true, binary: process.execPath }));
  const source = `import {deliverToCodex} from ${JSON.stringify(new URL('../lib/core.mjs', import.meta.url).href)};
const result=await deliverToCodex({threadId:'thread',id:'codex:thread',status:'idle'},{id:'claude:sender',name:'sender',kind:'claude'},'original content');
console.log(JSON.stringify(result));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { cwd: f.cwd, env: { ...process.env, CODEX_HOME: f.cwd, AGENTBUS_DIR: bus }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = ''; child.stdout.on('data', (b) => { output += b; }); child.stderr.on('data', (b) => { errors += b; });
  const [code] = await once(child, 'exit'); assert.equal(code, 0, errors);
  const result = JSON.parse(output), files = fs.readdirSync(path.join(bus, 'inbox', 'thread'));
  assert.equal(f.frames().filter((r) => r.method === 'thread/queue/add').length, 1);
  if (mode === 'success') { assert.equal(result.delivery, 'queued'); assert.equal(result.queueId, 'queue-1'); assert.deepEqual(files, []); }
  if (mode === 'timeout') { assert.equal(result.delivery, 'uncertain'); assert.equal(files.length, 1); assert(files[0].endsWith('.uncertain')); }
  if (mode === 'reject') { assert.equal(result.delivery, 'queued'); assert.equal(files.length, 1); assert(files[0].endsWith('.json')); }
  assert.equal(f.frames().find((r) => r.method === 'thread/queue/add').params.clientUserMessageId, result.msg_id);
});
