import { atomicWriteFileSync } from './atomic-file.mjs';
// agentbus core: discovery + delivery for claude code and codex sessions on this machine.
// claude delivery = per-session unix inbox socket. codex delivery = owner-process
// bridge, with a durable file inbox drained by trusted hooks as fallback.
import fs from "node:fs";
import { readLockSnapshot, refreshLockSnapshot, lockState, defaultLockCache } from "./codex-locks.mjs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { pushToCodex, bridgeThreads } from "./codex-push.mjs";
import { nativeQueueReadiness, pushNativeQueue } from "./codex-native-queue.mjs";
import { claudeModel, formatHardware } from "./host-capabilities.mjs";
import { relayToClaude, writeClaudeInbox, claudeDeliveryReadiness } from "./claude-relay.mjs";

export const HOME = os.homedir();
export const BUS_DIR = process.env.AGENTBUS_DIR || path.join(HOME, ".agentbus");
export const INBOX_DIR = path.join(BUS_DIR, "inbox");
export const CODEX_SESSIONS_DIR = path.join(BUS_DIR, "codex-sessions");
export const WATCH_DIR = path.join(BUS_DIR, "watch");
export const CLAUDE_SESSIONS_DIR = path.join(HOME, ".claude", "sessions");
export const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, ".codex");
export const CODEX_LOCKS_DIR = path.join(CODEX_HOME, "thread-writer-locks");
export const CODEX_STATE_DB = path.join(CODEX_HOME, "state_5.sqlite");
if (process.platform === "win32") void refreshLockSnapshot(CODEX_LOCKS_DIR, { cacheFile: defaultLockCache() }).catch(() => {});

for (const d of [INBOX_DIR, CODEX_SESSIONS_DIR, WATCH_DIR]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });

const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
};
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
export const shortId = (id) => String(id).replace(/-/g, "").slice(0, 8);
export const nowIso = () => new Date().toISOString();

// ---------- discovery ----------

export function listClaudeSessions() {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(CLAUDE_SESSIONS_DIR).filter((f) => /^\d+\.json$/.test(f)); } catch { return out; }
  for (const f of files) {
    const r = readJson(path.join(CLAUDE_SESSIONS_DIR, f));
    if (!r || !r.pid || !pidAlive(r.pid)) continue;
    // Windows named pipes are not filesystem entries: existsSync can return EBUSY
    // while the inbox is live. PID liveness is the discovery check on Windows.
    if (!r.messagingSocketPath || (process.platform !== "win32" && !fs.existsSync(r.messagingSocketPath))) continue;
    out.push({
      kind: "claude",
      id: `claude:${r.sessionId}`,
      name: r.name || `claude-${r.pid}`,
      pid: r.pid,
      sessionId: r.sessionId,
      cwd: r.cwd,
      status: r.status || "unknown",
      statusAt: r.statusUpdatedAt || r.updatedAt || 0,
      socket: r.messagingSocketPath,
      updatedAt: r.statusUpdatedAt || r.updatedAt || 0,
      version: r.version,
      clientType: r.entrypoint === "cli" ? "claude-code" : r.entrypoint === "desktop" ? "claude-desktop" : "claude-unknown",
      ...claudeModel(r),
      ...claudeDeliveryReadiness(BUS_DIR, { socket: r.messagingSocketPath }),
    });
  }
  return out;
}

// codex liveness uses native writer locks/validated file owners or a fresh owning bridge.
// hooks add cwd/model after a thread has run; untouched threads may have neither.
function lockHeld(lockPath) {
  if (process.platform === "win32") return false;
  // node has no flock; one-shot python probe. ~30ms.
  const py = spawnSync("/usr/bin/env", ["python3", "-I", "-c",
    "import fcntl,os,sys\nfd=os.open(sys.argv[1],os.O_RDONLY)\ntry:\n fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB); fcntl.flock(fd,fcntl.LOCK_UN); print('free')\nexcept BlockingIOError: print('held')",
    lockPath], { encoding: "utf8", timeout: 3000 });
  return (py.stdout || "").trim() === "held";
}

// windows codex stores some paths in \\?\ extended form.
export const plainPath = (p) => typeof p === "string" ? p.replace(/^\\\\\?\\(?!UNC\\)/, "") : p;
export function projectFor(cwd, explicit, roots) {
  if (explicit) return explicit;
  const win = /^[a-zA-Z]:[\\/]|^\\\\/.test(cwd);
  const norm = (p) => { p = plainPath(p || ""); return win ? p.replaceAll("/", "\\").toLowerCase() : p; };
  const c = norm(cwd), sep = win ? "\\" : "/";
  for (const [name, root] of roots) {
    const r = norm(root).replace(/[\\/]+$/, "");
    if (r && (c === r || c.startsWith(r + sep))) return name;
  }
  return null;
}
const sqlite = (() => { // node >= 22.5. silence the one-time experimental warning on older 22.x.
  const emit = process.emitWarning; process.emitWarning = () => {};
  try { return process.getBuiltinModule?.("node:sqlite") || null; } catch { return null; } finally { process.emitWarning = emit; }
})();
function codexThreadMetaNode(ids) {
  const db = new sqlite.DatabaseSync(CODEX_STATE_DB, { readOnly: true });
  try {
    const rows = db.prepare(`select t.id,t.name,t.title,t.cwd,t.updated_at,t.recency_at,t.preview,t.model,t.originator,t.rollout_path,p.name as project from threads t left join projects p on p.id=t.project_id where t.id in (${ids.map(() => "?").join(",")})`).all(...ids);
    const roots = db.prepare("select p.name,pr.path from project_roots pr join projects p on p.id=pr.project_id order by length(pr.path) desc").all().map((r) => [r.name, r.path]);
    return Object.fromEntries(rows.map((r) => [r.id, { name: r.name, title: r.title, cwd: plainPath(r.cwd), updated_at: r.updated_at, recency_at: r.recency_at, preview: r.preview, model: r.model, originator: r.originator, rollout_path: r.rollout_path, project: projectFor(r.cwd || "", r.project, roots) }]));
  } finally { db.close(); }
}

// A thread that exists in codex's state db but is not loaded by any process right now (e.g. after an app
// restart). Mail for it is queued in the agentbus inbox; the owning bridge delivers it when the thread opens.
export function knownCodexThread(threadId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId || '')) return false;
  try { return Boolean(codexThreadMeta([threadId])[threadId]); } catch { return false; }
}
function codexThreadMeta(ids) {
  // read-only sqlite. node:sqlite when present, else python. returns {id: {name,cwd,updated_at,preview}}
  if (!ids.length || !fs.existsSync(CODEX_STATE_DB)) return {};
  if (sqlite) { try { return codexThreadMetaNode(ids); } catch { /* schema drift or lock: try python */ } }
  if (process.platform === "win32") return {};
  const q = `import sqlite3,json,sys
ids=json.loads(sys.argv[2])
db=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True)
qs=",".join("?"*len(ids))
rows=db.execute(f"select t.id,t.name,t.title,t.cwd,t.updated_at,t.recency_at,t.preview,t.model,t.originator,t.rollout_path,p.name from threads t left join projects p on p.id=t.project_id where t.id in ({qs})",ids).fetchall()
roots=[(r[0],r[1]) for r in db.execute("select p.name,pr.path from project_roots pr join projects p on p.id=pr.project_id order by length(pr.path) desc")]
def proj(cwd,explicit):
    if explicit: return explicit
    for name,root in roots:
        if cwd==root or cwd.startswith(root.rstrip("/")+"/"): return name
    return None
print(json.dumps({r[0]:dict(name=r[1],title=r[2],cwd=r[3],updated_at=r[4],recency_at=r[5],preview=r[6],model=r[7],originator=r[8],rollout_path=r[9],project=proj(r[3] or "",r[10])) for r in rows}))`;
  const py = spawnSync("/usr/bin/env", ["python3", "-I", "-c", q, CODEX_STATE_DB, JSON.stringify(ids)], { encoding: "utf8", timeout: 5000 });
  try { return JSON.parse(py.stdout); } catch { return {}; }
}

// turn state from the rollout jsonl tail: task_started with no later task_complete/turn_aborted => busy.
export function rolloutStatus(rolloutPath) {
  const out = { status: "unknown", statusAt: 0, last: "" };
  if (!rolloutPath) return out;
  let fd;
  try {
    fd = fs.openSync(rolloutPath, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf8").split("\n");
    if (size > len) lines.shift();
    let open = null, lastTs = 0, lastMsg = "";
    for (const line of lines) {
      if (!line) continue;
      let d; try { d = JSON.parse(line); } catch { continue; }
      const ts = Date.parse(d.timestamp || "") || lastTs;
      lastTs = ts;
      const p = d.payload || {};
      if (d.type === "event_msg") {
        if (p.type === "task_started") open = ts;
        else if (p.type === "task_complete" || p.type === "turn_aborted") { open = null; out.statusAt = ts; }
      } else if (d.type === "response_item" && p.type === "message" && p.role === "assistant") {
        const t = (p.content || []).map((c) => c.text || "").join(" ").trim();
        if (t) lastMsg = t;
      }
    }
    out.status = open ? "busy" : "idle";
    if (open) out.statusAt = open;
    else if (!out.statusAt) out.statusAt = lastTs; // no task_complete in the tail window: last record is the best bound
    out.last = lastMsg.replace(/\s+/g, " ").slice(0, 120);
    out.lastEventAt = lastTs;
  } catch { /* unreadable rollout: leave unknown */ }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return out;
}

export function listCodexSessions() {
  const live = new Map();
  // 1. lock files held open by a codex process
  let locks = [];
  try { locks = fs.readdirSync(CODEX_LOCKS_DIR).filter((f) => /^[0-9a-f-]{36}\.lock$/.test(f)); } catch {}
  if (process.platform === "win32") {
    const snapshot = readLockSnapshot(CODEX_LOCKS_DIR, { cacheFile: defaultLockCache() });
    for (const id of snapshot.threads?.keys() || []) {
      const state = lockState(snapshot, id);
      if (state.state !== "held") continue;
      const owner = state.owners.length === 1 ? state.owners[0] : null;
      live.set(id, { id, via: "windows-owner", pid: owner?.pid, ownerType: owner?.owner, ownerBinary: owner?.path });
    }
  } else for (const f of locks) {
    const id = f.slice(0, -5);
    if (lockHeld(path.join(CODEX_LOCKS_DIR, f))) live.set(id, { id, via: "lock" });
  }
  // 1b. threads a live push bridge reports loaded in its app-server
  const bridged = bridgeThreads(BUS_DIR);
  for (const [id, b] of bridged) if (!live.has(id)) live.set(id, { id, via: "bridge" });
  // 2. hook-recorded sessions (gives pid, cwd, model) — only trusted if pid alive
  let recs = [];
  try { recs = fs.readdirSync(CODEX_SESSIONS_DIR).filter((f) => f.endsWith(".json")); } catch {}
  for (const f of recs) {
    const r = readJson(path.join(CODEX_SESSIONS_DIR, f));
    if (!r?.session_id) continue;
    if (r.pid && !pidAlive(r.pid)) { try { fs.unlinkSync(path.join(CODEX_SESSIONS_DIR, f)); } catch {} continue; }
    const cur = live.get(r.session_id) || { id: r.session_id, via: "hook" };
    Object.assign(cur, { pid: r.pid, cwd: r.cwd, model: r.model, lastEvent: r.last_event, lastEventAt: r.last_event_at });
    live.set(r.session_id, cur);
  }
  const meta = codexThreadMeta([...live.keys()]);
  return [...live.values()].map((t) => {
    const b = bridged.get(t.id);
    const m = { ...b, ...(meta[t.id] || {}) };
    const cwd = plainPath(t.cwd || m.cwd || "");
    // db `name` is the user/ui-assigned title; `title` is often just the first prompt, so only use it when short
    const derived = `${path.basename(cwd) || "codex"}-${shortId(t.id).slice(0, 2)}${shortId(t.id).slice(-2)}`;
    const title = (m.title || "").trim();
    const name = (m.name || "").trim() || (title && title.length <= 48 && !/\n/.test(title) ? title : derived);
    // status: rollout tail is the base truth; a hook event newer than the rollout's last record overrides it.
    const rs = rolloutStatus(m.rollout_path);
    let status = rs.status, statusAt = rs.statusAt;
    const hookAt = Date.parse(t.lastEventAt || "") || 0;
    if (hookAt && hookAt >= (rs.lastEventAt || 0) - 1500) {
      if (t.lastEvent === "PermissionRequest") { status = "waiting_approval"; statusAt = hookAt; }
      else if (t.lastEvent === "UserPromptSubmit" || t.lastEvent === "PostToolUse") { status = "busy"; statusAt = hookAt; }
      else if (t.lastEvent === "Stop") { status = "idle"; statusAt = hookAt; }
    }
    // a bridge sees turn/started and turn/completed directly; trust it over the rollout tail.
    if (b && status !== "waiting_approval") {
      const s = b.activeTurn ? "busy" : "idle";
      if (s !== status) { status = s; statusAt = Math.max(statusAt || 0, rs.lastEventAt || 0); }
    }
    return {
      kind: "codex", id: `codex:${t.id}`, threadId: t.id, name, cwd, project: m.project || null, pid: t.pid, status, statusAt, last: rs.last,
      model: t.model || m.model, modelSource: t.model || m.model ? "configured" : "unknown", clientType: "codex", updatedAt: (m.recency_at || m.updated_at || 0) * 1000, via: t.via, ownerType: t.ownerType, ownerBinary: t.ownerBinary,
      pendingInbox: inboxCount(t.id),
      deliveryReady: !!b, wakeCapability: b ? (b.activeTurn ? "turn/steer" : "turn/start") : "hook-only",
      unavailableReason: b ? null : "no fresh owning bridge; queued messages need a trusted hook or check_inbox",
      deliveryCheckedAt: b?.at || null,
      ...(!b ? nativeQueueReadiness(BUS_DIR, CODEX_HOME, t.id, m.rollout_path, t.ownerBinary) : {}),
    };
  });
}

export function listAgents() {
  return [...listClaudeSessions(), ...listCodexSessions()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

// Local discovery stays synchronous for hooks and claw-messenger lock ownership.
export async function listReachableAgents() {
  const { remoteAgents } = await import("./lan.mjs");
  return [...listAgents(), ...(await remoteAgents())];
}

// ---------- identity of the caller ----------

export function selfIdentity(hint) {
  // explicit hint wins: "codex:<id>", "claude:<id>", a thread id, or a name
  if (hint) {
    const r = resolveTarget(hint, listAgents());
    if (r.ok) return r.agent;
  }
  if (process.env.CLAUDE_CODE_MESSAGING_SOCKET) {
    const me = listClaudeSessions().find((s) => s.socket === process.env.CLAUDE_CODE_MESSAGING_SOCKET);
    if (me) return me;
    return { kind: "claude", id: `claude:${process.env.CLAUDE_CODE_SESSION_ID || "?"}`, name: `claude-${process.env.CLAUDE_PID || "?"}`, socket: process.env.CLAUDE_CODE_MESSAGING_SOCKET };
  }
  if (process.env.AGENTBUS_SELF) {
    const r = resolveTarget(process.env.AGENTBUS_SELF, listAgents());
    if (r.ok) return r.agent;
  }
  // codex gives its mcp children nothing identifying. if exactly one codex thread is live, it's us.
  const cx = listCodexSessions();
  if (cx.length === 1) return cx[0];
  return null;
}

// ---------- targeting ----------

export function resolveTarget(to, agents = listAgents()) {
  const q = String(to || "").trim();
  if (!q) return { ok: false, error: "empty target" };
  const norm = (s) => String(s || "").toLowerCase();
  const tests = [
    (a) => a.id === q || (a.id.startsWith("lan:") && a.id.endsWith("/" + q)),
    (a) => a.name === q,
    (a) => norm(a.name) === norm(q),
    (a) => a.sessionId === q || a.threadId === q,
    (a) => String(a.pid) === q,
    (a) => (a.sessionId || a.threadId || "").startsWith(q.replace(/^(claude|codex):/, "")),
    (a) => shortId(a.sessionId || a.threadId || "").startsWith(q.replace(/^(claude|codex):/, "").replace(/-/g, "")),
    (a) => norm(a.name).includes(norm(q)) || (a.project && norm(a.project) === norm(q)),
    (a) => norm(a.cwd).endsWith(norm(q)) || norm(a.cwd).includes(norm(q)),
  ];
  for (const t of tests) {
    const hits = agents.filter(t);
    if (hits.length === 1) return { ok: true, agent: hits[0] };
    if (hits.length > 1) return { ok: false, error: `ambiguous target '${q}': ${hits.map((h) => `${h.name} (${h.id})`).join(", ")}` };
  }
  return { ok: false, error: `no live agent matches '${q}'` };
}

// ---------- delivery ----------

function wrap(from, body) {
  // mirror the native claude frame (from / from-name / from-mode) so the receiver's parser is happy.
  // mode is only knowable for a claude sender; codex has no equivalent, so it goes out as "unknown".
  const mode = from.kind === "claude" ? (process.env.CLAUDE_CODE_MESSAGING_SOCKET === from.socket ? (process.env.AGENTBUS_MODE || "default") : "unknown") : "unknown";
  const attr = (v) => String(v).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const attrs = `from="${attr(from.id)}" from-name="${attr(from.name)}" from-kind="${attr(from.kind)}" from-mode="${mode}" via="agentbus"`;
  return `<cross-session-message ${attrs}>\n${body}\n</cross-session-message>`;
}

export async function deliverToClaude(target, from, body) {
  const content = wrap(from, body);
  const frame = {
    msgV: 1,
    msg_id: crypto.randomUUID(),
    type: "user",
    message: { role: "user", content },
    priority: "next",
    from: from.socket ? `uds:${from.socket}` : `agentbus:${from.id}`,
  };
  let result = await relayToClaude(BUS_DIR, target, content, frame.from);
  if (result.status === 'unavailable') {
    const ownToken = target.socket === process.env.CLAUDE_CODE_MESSAGING_SOCKET ? process.env.CLAUDE_CODE_MESSAGING_TOKEN : null;
    if (process.platform === 'win32' && !ownToken) return { ok: false, delivery: 'unavailable', error: 'receiving claude session must reload agentbus MCP to start its authenticated relay' };
    result = await writeClaudeInbox(target.socket, ownToken, frame);
  }
  return { ok: result.status === 'accepted', delivery: result.delivery || result.status, msg_id: frame.msg_id, ...(result.note ? { note: result.note } : {}), ...(result.error ? { error: result.error } : {}) };
}

export async function deliverToCodex(target, from, body) {
  const dir = path.join(INBOX_DIR, target.threadId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const msg = { msg_id: crypto.randomUUID(), at: nowIso(), from: from.id, from_name: from.name, content: wrap(from, body) };
  const file = path.join(dir, `${Date.now()}-${msg.msg_id}.json`);
  // Keep the message outside hook-visible .json files until push is resolved.
  // A crash/ambiguous acknowledgement leaves a recoverable .push/.uncertain file.
  fs.writeFileSync(file + ".push", JSON.stringify(msg), { mode: 0o600, flag: "wx" });
  let push = await pushToCodex(BUS_DIR, target.threadId, msg);
  // A definite bridge rejection/unavailability permits another transport. An
  // uncertain bridge write never does: the owner may already be executing it.
  if (push.status === 'unavailable' || push.status === 'rejected') {
    const queued = await pushNativeQueue(BUS_DIR, CODEX_HOME, target.threadId, msg, target.ownerBinary);
    if (queued.status !== 'unavailable') push = queued;
    else if (queued.error !== 'native queue transport is not configured') push = { ...push, error: queued.error };
  }
  if (push.status === "accepted") {
    fs.unlinkSync(file + ".push");
    return { ok: true, msg_id: msg.msg_id, ...push, delivery: push.method === 'thread/queue/add' ? 'queued' : 'accepted', note: push.method === 'thread/queue/add' ? 'persisted in the native owner queue; execution acknowledgement is pending' : `accepted by codex via ${push.method}` };
  }
  if (push.status === "uncertain") {
    fs.renameSync(file + ".push", file + ".uncertain");
    return { ok: false, msg_id: msg.msg_id, delivery: "uncertain", error: push.error, note: "codex may have accepted this message; retained for inspection, not automatically retried", recovery_file: file + ".uncertain" };
  }
  fs.renameSync(file + ".push", file);
  const note = target.status === "busy"
    ? "queued; codex reads it after its next tool call (PostToolUse hook)"
    : "queued; no accepting codex bridge available; delivery requires a trusted prompt/stop hook or check_inbox";
  return { ok: true, msg_id: msg.msg_id, delivery: "queued", note, ...(push.error ? { push_error: push.error } : {}) };
}

export async function sendMessage({ to, message, from: fromHint }) {
  const { parseRemoteId, sendRemote } = await import("./lan.mjs");
  if (parseRemoteId(to)) return sendRemote(to, selfIdentity(fromHint), message);
  const agents = await listReachableAgents();
  const r = resolveTarget(to, agents);
  if (!r.ok) return r;
  const from = selfIdentity(fromHint) || { kind: "unknown", id: "unknown", name: "unknown" };
  if (from.id === r.agent.id) return { ok: false, error: "refusing to message yourself" };
  if (r.agent.remote) return sendRemote(r.agent.id, from, message);
  if (r.agent.kind === "claude") return { ...(await deliverToClaude(r.agent, from, message)), to: r.agent.id, to_name: r.agent.name, from: from.id };
  return { ...(await deliverToCodex(r.agent, from, message)), to: r.agent.id, to_name: r.agent.name, from: from.id };
}

// ---------- codex inbox ----------

export function inboxCount(threadId) {
  try { return fs.readdirSync(path.join(INBOX_DIR, threadId)).filter((f) => f.endsWith(".json")).length; } catch { return 0; }
}

export function drainInbox(threadId, { peek = false } = {}) {
  const dir = path.join(INBOX_DIR, threadId);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort(); } catch { return []; }
  const msgs = [];
  for (const f of files) {
    const original = path.join(dir, f);
    const claimed = original + ".claimed-" + crypto.randomUUID();
    if (!peek) { try { fs.renameSync(original, claimed); } catch { continue; } }
    const m = readJson(peek ? original : claimed);
    if (m) msgs.push(m);
    if (!peek) { try { fs.unlinkSync(claimed); } catch {} }
  }
  return msgs;
}

// ---------- codex session records (written by hooks) ----------

export function recordCodexEvent(payload, pid) {
  if (!payload?.session_id) return;
  const p = path.join(CODEX_SESSIONS_DIR, `${payload.session_id}.json`);
  const prev = readJson(p) || {};
  const rec = { ...prev, session_id: payload.session_id, cwd: payload.cwd || prev.cwd, model: payload.model || prev.model,
    pid: pid || prev.pid, last_event: payload.hook_event_name, last_event_at: nowIso() };
  atomicWriteFileSync(p, JSON.stringify(rec));
}
export function forgetCodexSession(sessionId) {
  try { fs.unlinkSync(path.join(CODEX_SESSIONS_DIR, `${sessionId}.json`)); } catch {}
}

export const fmtAge = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`; };

export function formatAgents(agents, self) {
  if (!agents.length) return "no live agents found.";
  return agents.map((a) => {
    const me = self && a.id === self.id ? "  <- you" : "";
    const extra = a.remote ? `host=${a.hostName}  remote` : a.kind === "codex" ? `${a.project ? `project=${a.project}  ` : ""}pending_inbox=${a.pendingInbox}` : `pid=${a.pid}`;
    const age = a.statusAt ? ` for ${fmtAge(Date.now() - a.statusAt)}` : "";
    const last = a.kind === "codex" && a.last ? `\n    last: ${a.last}` : "";
    return `${a.name}  [${a.id}]  ${a.kind}  ${a.status}${age}${a.cwd ? `  cwd=${a.cwd}` : ""}  ${extra}${a.model ? `  model=${a.model} (${a.modelSource || "unknown"})` : ""}${a.clientType ? `  client=${a.clientType}` : ""}${me}${last}${a.remote && a.hostCapabilities ? `\n    host: ${a.hostCapabilities.os.type} ${a.hostCapabilities.cpu.architecture}, ${a.hostCapabilities.cpu.model}, ${a.hostCapabilities.cpu.logicalCores} cores, ${Math.round(a.hostCapabilities.memoryBytes / 1024 ** 3)} GiB ram, gpu=${formatHardware(a.hostCapabilities)}` : ""}${a.remote && a.hostStorage?.length ? `\n    storage: ${a.hostStorage.map((s) => `${s.name} [${s.id}] ${s.status} ${s.access} path=${s.localPath}`).join("; ")}` : ""}${a.remote && a.hostPresence ? `\n    presence: ${a.hostPresence.user}, gpu=${a.hostPresence.gpu}${a.hostPresence.reasons?.length ? ` [${a.hostPresence.reasons.join("; ")}]` : ""}` : ""}`;
  }).join("\n");
}

// ---------- idle subscriptions ----------
// ~/.agentbus/watch/<target-key>/<sub-id>.json  { subscriber:{id,name,kind,socket?,threadId?}, target:{id,name,kind}, message?, createdAt }
// fired by: codex Stop hook (push, for codex targets) and the subscriber's own mcp server poller (pull, any target).
const WATCH_TTL_MS = 12 * 3600 * 1000;
const keyOf = (agent) => agent.id.replace(/[^a-z0-9:-]/gi, "_");

export function subscribeIdle(target, subscriber, { message } = {}) {
  const dir = path.join(WATCH_DIR, keyOf(target));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const sub = { sub_id: crypto.randomUUID(), subscriber: { id: subscriber.id, name: subscriber.name, kind: subscriber.kind, socket: subscriber.socket, threadId: subscriber.threadId },
    target: { id: target.id, name: target.name, kind: target.kind }, message: message || null, createdAt: Date.now() };
  const f = path.join(dir, `${sub.sub_id}.json`);
  atomicWriteFileSync(f, JSON.stringify(sub));
  return sub;
}

export function listSubscriptions(targetId) {
  const dirs = targetId ? [keyOf({ id: targetId })] : (() => { try { return fs.readdirSync(WATCH_DIR); } catch { return []; } })();
  const subs = [];
  for (const d of dirs) {
    let files = []; try { files = fs.readdirSync(path.join(WATCH_DIR, d)).filter((f) => f.endsWith(".json")); } catch { continue; }
    for (const f of files) {
      const p = path.join(WATCH_DIR, d, f);
      const sub = readJson(p); if (!sub) { try { fs.unlinkSync(p); } catch {} continue; }
      if (Date.now() - sub.createdAt > WATCH_TTL_MS) { try { fs.unlinkSync(p); } catch {} continue; }
      subs.push({ ...sub, _path: p });
    }
  }
  return subs;
}

async function deliverRaw(agent, from, body) {
  if (agent.kind === "claude") {
    const live = listClaudeSessions().find((a) => a.id === agent.id);
    if (!live) return { ok: false, error: "subscriber session gone" };
    return deliverToClaude(live, from, body);
  }
  if (agent.kind === "codex" && agent.threadId) return deliverToCodex({ id: agent.id, threadId: agent.threadId, status: "idle" }, from, body);
  return { ok: false, error: "unroutable subscriber" };
}

// fire every subscription on `target` (an agent object, idle now). returns count fired.
export async function fireIdle(target, { reason = "idle" } = {}) {
  const subs = listSubscriptions(target.id);
  let n = 0;
  for (const sub of subs) {
    try { fs.unlinkSync(sub._path); } catch { continue; }
    const bus = { kind: "agentbus", id: "agentbus", name: "agentbus" };
    const when = new Date().toISOString();
    const last = target.last ? `\nlast assistant line: ${target.last}` : "";
    const notice = `[agentbus ${reason} notice] ${target.name} (${target.id}) is now ${reason} as of ${when}.${last}`;
    await deliverRaw(sub.subscriber, bus, notice);
    if (sub.message) {
      const from = { kind: sub.subscriber.kind, id: sub.subscriber.id, name: sub.subscriber.name, socket: sub.subscriber.socket };
      // deferred message: deliver to the (now idle) target from the original sender
      if (target.kind === "claude") { const live = listClaudeSessions().find((a) => a.id === target.id); if (live) await deliverToClaude(live, from, sub.message); }
      else await deliverToCodex(target, from, sub.message);
    }
    n++;
  }
  return n;
}

// poller used by the mcp server: checks all subscriptions against live status. cheap enough at 3s.
export async function pollSubscriptions() {
  const subs = listSubscriptions();
  if (!subs.length) return 0;
  const agents = listAgents();
  let fired = 0;
  const seen = new Set();
  for (const sub of subs) {
    if (seen.has(sub.target.id)) continue;
    const live = agents.find((a) => a.id === sub.target.id);
    if (!live) { seen.add(sub.target.id); fired += await fireIdle({ ...sub.target, last: "" }, { reason: "gone" }); continue; }
    if (live.status === "idle" && Date.now() - (live.statusAt || 0) > 1500) { seen.add(sub.target.id); fired += await fireIdle(live); }
  }
  return fired;
}
