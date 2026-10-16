import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Locks} from '../locks.mjs';
const a='codex:11111111-1111-1111-1111-111111111111';
const b='claude:22222222-2222-2222-2222-222222222222';
const number='+15555550100';
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'claw-locks-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let time=Date.now();let live=[{id:a},{id:b}];const audit=[];
  const opts={now:()=>time,listAgents:()=>live,audit:e=>audit.push(e)};
  const file=path.join(dir,'locks.json');const locks=new Locks(file,opts);
  return {locks,audit,reload:()=>new Locks(file,opts),advance:n=>time+=n,live:v=>live=v};
}
test('exclusive lease blocks rival and anonymous sends; holder may send and renew',t=>{
  const f=fixture(t);const first=f.locks.acquire(number,{holder:a});
  assert.equal(first.releaseOnReply,false);
  assert.equal(Date.parse(first.expiresAt)-Date.parse(first.acquiredAt),900000);
  assert.equal(f.locks.check(number,a).holder,a);
  for(const holder of [b,undefined])assert.throws(()=>f.locks.check(number,holder),e=>e.status===409);
  assert.throws(()=>f.locks.acquire(number,{holder:b}),e=>e.status===409);
  f.advance(1000);const renewed=f.locks.acquire(number,{holder:a});
  assert.notEqual(renewed.leaseId,first.leaseId);
  assert.ok(Date.parse(renewed.expiresAt)>Date.parse(first.expiresAt));
  assert.equal(f.reload().active(number).holder,a);
});
test('expiry or missing session frees lease; dead agents cannot acquire',t=>{
  const f=fixture(t);f.locks.acquire(number,{holder:a,ttlSeconds:1});
  f.advance(1001);assert.equal(f.locks.acquire(number,{holder:b}).holder,b);
  f.live([{id:a}]);assert.equal(f.locks.active(number),null);
  assert.throws(()=>f.locks.acquire(number,{holder:b}),e=>e.status===409);
  assert.equal(f.audit.filter(e=>e.action==='reap').length,2);
});
test('owner release and forced unlock require explicit actor and reason',t=>{
  const f=fixture(t);f.locks.acquire(number,{holder:a});
  assert.throws(()=>f.locks.release(number,{holder:b}),e=>e.status===403);
  assert.throws(()=>f.locks.release(number,{holder:b,force:true}));
  assert.equal(f.locks.release(number,{holder:b,force:true,reason:'human directed takeover'}).released,true);
  assert.equal(f.audit.at(-1).action,'force unlock');
  assert.equal(f.locks.release(number,{holder:a}).released,false);
});
test('reply completion cannot release a renewed or replacement lease',t=>{
  const f=fixture(t);const first=f.locks.acquire(number,{holder:a,releaseOnReply:true});
  const second=f.locks.acquire(number,{holder:a,releaseOnReply:true});
  assert.equal(f.locks.releaseAfterReply(number,first.leaseId),false);
  assert.equal(f.locks.active(number).leaseId,second.leaseId);
  assert.equal(f.locks.releaseAfterReply(number,second.leaseId),true);
  const manual=f.locks.acquire(number,{holder:b});
  assert.equal(f.locks.releaseAfterReply(number,manual.leaseId),false);
});
test('invalid ttl/holder rejected and liveness failure never reaps',t=>{
  const f=fixture(t);
  for(const ttlSeconds of [0,3601,1.5])assert.throws(()=>f.locks.acquire(number,{holder:a,ttlSeconds}));
  assert.throws(()=>f.locks.acquire(number,{holder:'any-idle'}));
  f.locks.acquire(number,{holder:a});
  f.locks.listAgents=()=>{throw Error('discovery offline')};
  assert.throws(()=>f.locks.active(number));
  assert.equal(f.reload().active(number).holder,a);
});
test('remote leases survive partitions and require current generation for mutation',t=>{
  const f=fixture(t), remote='lan:33333333-3333-3333-3333-333333333333/'+a;
  f.live([{id:a},{id:b},{id:remote}]);
  const first=f.locks.acquire(number,{holder:remote,ttlSeconds:60});
  f.live([{id:a},{id:b}]);
  assert.equal(f.locks.active(number).holder,remote);
  assert.throws(()=>f.locks.acquire(number,{holder:a}),e=>e.status===409);
  assert.throws(()=>f.locks.check(number,remote),e=>e.status===409);
  assert.equal(f.locks.check(number,remote,first.leaseId).holder,remote);
  assert.throws(()=>f.locks.acquire(number,{holder:remote,leaseId:first.leaseId}),e=>e.status===409);
  f.live([{id:a},{id:remote}]);
  const next=f.locks.acquire(number,{holder:remote,leaseId:first.leaseId});
  assert.throws(()=>f.locks.release(number,{holder:remote,leaseId:first.leaseId}),e=>e.status===409);
  assert.throws(()=>f.locks.check(number,remote,first.leaseId),e=>e.status===409);
  assert.equal(f.locks.release(number,{holder:remote,leaseId:next.leaseId}).released,true);
  const final=f.locks.acquire(number,{holder:remote,ttlSeconds:1});
  f.live([{id:a}]);f.advance(1001);
  assert.equal(f.locks.active(number),null);
  assert.equal(f.locks.acquire(number,{holder:a}).holder,a);
});
