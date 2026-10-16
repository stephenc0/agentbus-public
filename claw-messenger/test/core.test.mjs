import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store,payload,phone,service} from '../core.mjs';
test('strict recipient, service and payload validation',()=>{
  assert.equal(phone('+1 (555) 555-0100'),'+15555550100');
  assert.throws(()=>phone('5555550100'));
  assert.throws(()=>service('email'));
  assert.throws(()=>payload({to:'+15555550100',text:'a'},'iMessage'));
  assert.throws(()=>payload({to:'+15555550100',chatId:'x',text:'a',requestId:'a'},'iMessage'));
  assert.throws(()=>payload({to:'+15555550100',mediaUrl:'file:///etc/passwd',requestId:'a'},'iMessage'));
  assert.deepEqual(payload({to:'+15555550100',text:'hello',requestId:'a'},'iMessage'),{type:'send',service:'iMessage',parts:[{type:'text',value:'hello'}],to:'+15555550100'});
});
test('durable inbox deduplicates messages but retains every delivery state',()=>{
  const s=new Store(':memory:');
  assert.equal(s.append({type:'message',messageId:'a',text:'hello'}).seq,1);
  assert.equal(s.append({type:'message',messageId:'a',text:'hello'}),null);
  s.append({type:'status',messageId:'a',status:'sent'});
  s.append({type:'status',messageId:'a',status:'delivered'});
  assert.equal(s.inbox(1).events.length,2);
  assert.equal(s.inbox().events[0].event.text,'hello');
  assert.throws(()=>s.inbox(-1));s.close();
});
test('idempotent sends never repeat uncertain or in flight delivery',()=>{
  const s=new Store(':memory:'); const p={to:'+15555550100',text:'hello'};
  assert.equal(s.reserve('a',p).cached,false);
  assert.equal(s.reserve('a',p).result.uncertain,true);
  assert.throws(()=>s.reserve('a',{...p,text:'changed'}));
  s.finish('a',{ok:true,messageId:'m'});
  assert.deepEqual(s.reserve('a',p).result,{ok:true,messageId:'m'});s.close();
});
