import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
export const SERVICES = ['iMessage', 'RCS', 'SMS'];
export function phone(value) {
  const p = String(value ?? '').replace(/[\s().-]/g, '');
  if (!/^\+[1-9]\d{9,14}$/.test(p)) throw new Error('phone must be E.164 with country code');
  return p;
}
export function service(value) {
  if (!SERVICES.includes(value)) throw new Error('service must be iMessage, RCS, or SMS');
  return value;
}
export function payload(input, preferred) {
  if ([input.to, input.chatId, input.toGroup].filter(v => v !== undefined).length !== 1)
    throw new Error('provide exactly one of to, chatId, or toGroup');
  const out = { type: 'send', service: service(input.service ?? preferred), parts: [] };
  if (input.to !== undefined) out.to = phone(input.to);
  if (input.chatId !== undefined) {
    if (typeof input.chatId !== 'string' || !input.chatId.trim() || input.chatId.length > 256) throw new Error('invalid chatId');
    out.chatId = input.chatId;
  }
  if (input.toGroup !== undefined) {
    if (!Array.isArray(input.toGroup)) throw new Error('toGroup must be an array');
    out.to = [...new Set(input.toGroup.map(phone))];
    if (out.to.length < 2 || out.to.length > 32) throw new Error('group requires 2 to 32 distinct numbers');
  }
  if (input.text !== undefined) {
    if (typeof input.text !== 'string' || input.text.length > 20000) throw new Error('invalid text (max 20000 chars)');
    if (input.text) out.parts.push({type: 'text', value: input.text});
  }
  if (input.mediaUrl !== undefined) {
    const u = new URL(input.mediaUrl);
    if (u.protocol !== 'https:') throw new Error('mediaUrl must use https');
    out.parts.push({type: 'media', url: u.href});
  }
  if (!out.parts.length) throw new Error('text or mediaUrl required');
  if (typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(input.requestId)) throw new Error('requestId required (stable idempotency key)');
  return out;
}
export function atomicJson(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}
export class Store {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, dedupe TEXT UNIQUE, received_at TEXT NOT NULL, event TEXT NOT NULL, forwarding TEXT);
      CREATE TABLE IF NOT EXISTS sends(request_id TEXT PRIMARY KEY, payload TEXT NOT NULL, state TEXT NOT NULL, result TEXT);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  }
  append(event) {
    // Only message deliveries have stable ids; status updates sharing an id are distinct.
    const dedupe = event.type === 'message' && event.messageId ? 'message:' + event.messageId : null;
    const at = new Date().toISOString();
    const r = this.db.prepare('INSERT OR IGNORE INTO events(dedupe,received_at,event) VALUES(?,?,?)').run(dedupe, at, JSON.stringify(event));
    return r.changes ? {seq: Number(r.lastInsertRowid), receivedAt: at, event} : null;
  }
  inbox(since = 0, limit = 100) {
    if (!Number.isSafeInteger(since) || since < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('invalid cursor or limit (1..500)');
    const rows = this.db.prepare('SELECT seq,received_at,event,forwarding FROM events WHERE seq>? ORDER BY seq LIMIT ?').all(since, limit);
    const events = rows.map(r => ({seq:r.seq,receivedAt:r.received_at,event:JSON.parse(r.event),forwarding:r.forwarding ? JSON.parse(r.forwarding) : null}));
    return {events, nextSeq:events.at(-1)?.seq ?? since};
  }
  get(key) { const r = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key); return r ? JSON.parse(r.value) : null; }
  set(key, value) { this.db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key,JSON.stringify(value)); }
  cached(id, body) {
    const text = JSON.stringify(body);
    const old = this.db.prepare('SELECT * FROM sends WHERE request_id=?').get(id);
    if (old) {
      if (old.payload !== text) throw new Error('requestId already used with different payload');
      return {cached:true, result:old.result ? JSON.parse(old.result) : {ok:false,uncertain:true,error:'send already attempted; inspect inbox/delivery status before retrying'}};
    }
    return {cached:false};
  }
  reserve(id, body) {
    const old=this.cached(id,body);if(old.cached)return old;
    this.db.prepare('INSERT INTO sends(request_id,payload,state) VALUES(?,?,?)').run(id,JSON.stringify(body),'pending');
    return {cached:false};
  }
  finish(id, result) { this.db.prepare('UPDATE sends SET state=?,result=? WHERE request_id=?').run(result.uncertain ? 'uncertain' : 'complete',JSON.stringify(result),id); }
  forwarding(seq, result) { this.db.prepare('UPDATE events SET forwarding=? WHERE seq=?').run(JSON.stringify(result),seq); }
  close() {this.db.close();}
}
