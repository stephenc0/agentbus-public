import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {atomicJson,phone} from './core.mjs';
import {parseRemoteId} from '../lib/lan.mjs';
export function agentId(value) {
  if(typeof value!=='string' || (!/^(claude|codex):[a-f0-9-]{36}$/.test(value) && !parseRemoteId(value))) throw new Error('holder must be an explicit local or host-qualified claude/codex session id');
  return value;
}
export class LockError extends Error {
  constructor(status,message,lock) {super(message);this.status=status;this.lock=lock;}
}
export class Locks {
  constructor(file,{listAgents,now=()=>Date.now(),audit=()=>{}}) {
    this.file=file;this.listAgents=listAgents;this.now=now;this.audit=audit;
    this.entries=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};
  }
  save(){atomicJson(this.file,this.entries);}
  reap() {
    const time=this.now();
    // Discovery failure is not evidence that a holder died: fail closed.
    const live=new Set(this.listAgents().map(a=>a.id));
    let changed=false;
    for(const [number,lock] of Object.entries(this.entries)) {
      // A missing LAN peer can be a partition, not a dead agent. Keep its lease
      // until expiry/release; never transfer ownership due to discovery loss.
      if(Date.parse(lock.expiresAt)<=time || (!parseRemoteId(lock.holder) && !live.has(lock.holder))) {
        delete this.entries[number];changed=true;
        this.audit({action:'reap',number,lock,reason:Date.parse(lock.expiresAt)<=time?'expired':'holder gone'});
      }
    }
    if(changed)this.save();
    return live;
  }
  all(){this.reap();return structuredClone(this.entries);}
  active(number){this.reap();return this.entries[phone(number)]?structuredClone(this.entries[phone(number)]):null;}
  check(number,holder,leaseId) {
    const lock=this.active(number);
    if(lock && lock.holder!==holder)throw new LockError(409,'locked',lock);
    if(lock && parseRemoteId(holder) && lock.leaseId!==leaseId)throw new LockError(409,'current leaseId required for remote holder',lock);
    return lock;
  }
  acquire(number,{holder,ttlSeconds=900,reason='',releaseOnReply=false,leaseId}) {
    number=phone(number);agentId(holder);
    if(!Number.isInteger(ttlSeconds)||ttlSeconds<1||ttlSeconds>3600)throw new Error('ttlSeconds must be an integer from 1 to 3600');
    if(typeof releaseOnReply!=='boolean')throw new Error('releaseOnReply must be boolean');
    if(typeof reason!=='string'||reason.length>1000)throw new Error('reason must be a string up to 1000 characters');
    const live=this.reap();
    if(!live.has(holder))throw new LockError(409,'holder is not a live agent',null);
    const old=this.entries[number];
    if(old && old.holder!==holder)throw new LockError(409,'locked',structuredClone(old));
    if(old && parseRemoteId(holder) && old.leaseId!==leaseId)throw new LockError(409,'current leaseId required to renew remote lease',structuredClone(old));
    const time=this.now();
    const lock={holder,acquiredAt:old?.acquiredAt??new Date(time).toISOString(),expiresAt:new Date(time+ttlSeconds*1000).toISOString(),reason,releaseOnReply,leaseId:randomUUID()};
    this.entries[number]=lock;this.save();this.audit({action:old?'renew':'acquire',number,lock});
    return structuredClone(lock);
  }
  release(number,{holder,force=false,reason='',leaseId}) {
    number=phone(number);agentId(holder);
    if(typeof force!=='boolean')throw new Error('force must be boolean');
    if(force && (typeof reason!=='string'||!reason.trim()||reason.length>1000))throw new Error('force unlock requires a nonempty reason up to 1000 characters');
    this.reap();const lock=this.entries[number];
    if(!lock)return {ok:true,released:false};
    if(lock.holder!==holder && !force)throw new LockError(403,'not holder',structuredClone(lock));
    if(!force && parseRemoteId(holder) && lock.leaseId!==leaseId)throw new LockError(409,'current leaseId required to release remote lease',structuredClone(lock));
    delete this.entries[number];this.save();this.audit({action:force?'force unlock':'release',number,holder,reason,lock});
    return {ok:true,released:true};
  }
  releaseAfterReply(number,leaseId) {
    // An asynchronous push must not release a renewed/replaced lease.
    const lock=this.entries[number];
    if(!lock || lock.leaseId!==leaseId || !lock.releaseOnReply)return false;
    delete this.entries[number];this.save();this.audit({action:'reply release',number,lock});return true;
  }
}
