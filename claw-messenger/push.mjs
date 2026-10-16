// Adapter to the existing agentbus transport, with an explicit service identity.
// Do not let agentbus infer the daemon is the only live agent (self-send rejection).
import {resolveTarget, deliverToClaude, deliverToCodex} from '../lib/core.mjs';
import {parseRemoteId,localLanRequest} from '../lib/lan.mjs';
import {randomUUID} from 'node:crypto';
const [target,body] = process.argv.slice(2);
if(parseRemoteId(target)) {
  console.log(JSON.stringify(await localLanRequest({op:'sms-reply',id:randomUUID(),to:target,message:body})));
  process.exit(0);
}
const r=resolveTarget(target);
if(!r.ok){console.log(JSON.stringify(r));process.exit(0);}
const source={id:'service:claw-messenger',kind:'service',name:'claw-messenger'};
const deliver=r.agent.kind==='claude'?deliverToClaude:deliverToCodex;
console.log(JSON.stringify(await deliver(r.agent,source,body)));
