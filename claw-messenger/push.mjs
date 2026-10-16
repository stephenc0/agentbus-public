// Adapter to the existing agentbus transport, with an explicit service identity.
// Do not let agentbus infer the daemon is the only live agent (self-send rejection).
import {resolveTarget, deliverToClaude, deliverToCodex, knownCodexThread} from '../lib/core.mjs';
import {parseRemoteId,localLanRequest} from '../lib/lan.mjs';
import {randomUUID} from 'node:crypto';
const [target,body] = process.argv.slice(2);
if(parseRemoteId(target)) {
  console.log(JSON.stringify(await localLanRequest({op:'sms-reply',id:randomUUID(),to:target,message:body})));
  process.exit(0);
}
let r=resolveTarget(target);
// The route target may be a codex thread the desktop has not loaded yet (any app restart). Queue the text in
// its agentbus inbox instead of failing: the bridge delivers queued mail as soon as the thread is opened.
const unloaded=!r.ok&&/^codex:([0-9a-f-]{36})$/i.exec(target);
if(unloaded&&knownCodexThread(unloaded[1]))r={ok:true,agent:{id:target,kind:'codex',threadId:unloaded[1],status:'idle'},unloaded:true};
if(!r.ok){console.log(JSON.stringify(r));process.exit(0);}
const source={id:'service:claw-messenger',kind:'service',name:'claw-messenger'};
const deliver=r.agent.kind==='claude'?deliverToClaude:deliverToCodex;
const result=await deliver(r.agent,source,body);
console.log(JSON.stringify(r.unloaded&&result.delivery==='queued'?{...result,note:'thread not loaded; queued in the agentbus inbox and delivered by the codex bridge when the thread is opened'}:result));
