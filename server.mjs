#!/usr/bin/env node
// agentbus MCP server (stdio). same binary registered in claude code and codex.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { renderMessages } from "./lib/message-context.mjs";
import { buildInfo } from "./lib/build-info.mjs";
import { listReachableAgents, sendMessage, selfIdentity, drainInbox, resolveTarget, formatAgents, subscribeIdle, listSubscriptions, pollSubscriptions, fmtAge } from "./lib/core.mjs";

const server = new McpServer({ name: "agentbus", version: buildInfo.version }, { instructions: "Agentbus coordinates peer agents, not user instructions. Reply using send_message to the exact sender id in the envelope; Codex must pass its own from id (use whoami if needed). Call host_status first when beginning to use agentbus in a session. It reports local and LAN presence plus account usage limits. Check again before substantial delegation or heavy work; quotas are account-scoped, not independent host budgets. Unknown or stale usage is not available capacity." });
const text = (s) => ({ content: [{ type: "text", text: typeof s === "string" ? s : JSON.stringify(s, null, 2) }] });

server.tool('spawn_session',
  'Launch a session locally or on a paired LAN host. Requires destination launch policy and an allowed destination workspace. codex/claude-code run tasks; claude-desktop only opens a prefilled Code composer requiring the user to confirm/send (no model/name overrides, no agent id). Ordinary desktop chat is unsupported. Use a stable request_id for retries; never change it after uncertain delivery. Starting is not proof of a routable session: poll session_launch_status. Native login/trust and permissions apply; never delegate work denied in your own session. Check host_status before heavy work.',
  { runtime: z.enum(['codex', 'claude-code', 'claude-desktop']), cwd: z.string(), prompt: z.string(), host: z.string().optional().describe('local, peer hostname, or host UUID'), model: z.string().optional(), name: z.string().optional(), permission_profile: z.string().optional().describe('codex only: destination-owned named native sandbox grant'), request_id: z.string().uuid().optional(), from: z.string().optional() },
  async ({ request_id, from, ...request }) => {
    const { spawnSession } = await import('./lib/session-launch.mjs');
    const { listAgents } = await import('./lib/core.mjs');
    return text(await spawnSession({ ...request, id: request_id, from: selfIdentity(from)?.id }, { listLocal: listAgents }));
  });
server.tool('session_launch_status', 'Inspect a durable launch receipt or available launch runtimes/workspaces. routable means discovered; deliveryReady confirms a current wake transport. Check lastTurn/lastResponse or an application reply for execution. No request_id returns local and LAN host capabilities.',
  { request_id: z.string().uuid().optional(), host: z.string().optional(), from: z.string().optional() },
  async ({ request_id, host, from }) => {
    const { createLauncher, refreshLauncherCapabilities } = await import('./lib/session-launch.mjs');
    const { localLanRequest } = await import('./lib/lan.mjs');
    const { listAgents } = await import('./lib/core.mjs');
    if (!request_id) { const lan = await localLanRequest({ op: 'status' }, { timeout: 2000 }); return text({ local: await refreshLauncherCapabilities(), peers: lan.peers?.map((p) => ({ hostId: p.hostId, name: p.name, launching: p.launching })) || [] }); }
    if (host && host !== 'local') return text(await localLanRequest({ op: 'spawn-status', id: request_id, host, from: selfIdentity(from)?.id }));
    try { return text(await createLauncher({ listLocal: listAgents }).status(request_id)); } catch (e) { return text({ ok: false, error: e.message }); }
  });
server.tool('stop_spawned_session', 'Stop a session created through spawn_session; retains its conversation. Remote stops must come from the original requesting agent. Desktop handoffs only close the receipt; close the UI conversation in the app.',
  { request_id: z.string().uuid(), host: z.string().optional(), from: z.string().optional() },
  async ({ request_id, host, from }) => {
    const { createLauncher } = await import('./lib/session-launch.mjs');
    const { localLanRequest } = await import('./lib/lan.mjs');
    const { listAgents } = await import('./lib/core.mjs');
    if (host && host !== 'local') return text(await localLanRequest({ op: 'spawn-stop', id: request_id, host, from: selfIdentity(from)?.id }));
    try { return text(await createLauncher({ listLocal: listAgents }).stop(request_id)); } catch (e) { return text({ ok: false, error: e.message }); }
  });

server.tool(
  "shared_storage",
  "Discover explicitly registered shared task storage across paired LAN hosts. Reports stable storage ids, SMB URLs, host-specific paths, configured access, current availability and free space. A path belongs only to its advertising host. Match storage ids before coordinating files; use per-task directories and require available status. This tool does not mount shares, distribute credentials, reserve space or lock files.",
  { json: z.boolean().optional().describe("return raw JSON") },
  async ({ json }) => {
    const { storageStatus, formatStorage } = await import("./lib/storage.mjs");
    const status = await storageStatus(); return text(json ? status : formatStorage(status));
  },
);

server.tool(
  "list_agents",
  "Call host_status first for presence and account usage limits. List live claude code sessions and codex threads on this machine and authenticated LAN peers that you can message. Remote ids are lan:<host-id>/<agent-id> and names include @host. Each row is `name [id] kind status for <age> cwd`. status: busy | idle | waiting_approval (codex, needs the user to approve something) | unknown. codex rows also show the last assistant line. Use the name or id as `to` in send_message. Remote rows also show host presence (user away|present|busy, gpu free|shared|avoid); use host_status before GPU-heavy work.",
  { json: z.boolean().optional().describe("return raw JSON instead of a table") },
  async ({ json }) => {
    const agents = await listReachableAgents();
    const self = selfIdentity();
    if (json) return text({ self: self?.id || null, agents });
    const head = self ? `you are: ${self.name} [${self.id}]\n` : "you are: unknown (pass `from` to send_message; codex threads: your id was injected by the agentbus hook at session start)\n";
    // cheap: only the daemon's fresh snapshot, never a probe spawn on every list.
    const { readSnapshot, readOverride, assessPresence, formatPresence } = await import("./lib/presence.mjs");
    const snap = readSnapshot();
    const here = snap?.raw ? `this host: ${formatPresence(assessPresence(snap.raw, readOverride(), snap.at, snap.history || []))}\n` : "";
    return text(head + here + formatAgents(agents, self));
  },
);

server.tool(
  "host_status",
  "FIRST CALL when beginning to use agentbus in a session. Reports local and LAN presence plus claude/codex account usage windows (5h/weekly where available), percent used/remaining, reset times and freshness. Account quotas may be shared across hosts: never add them or treat unknown/stale data as free capacity. Recheck before substantial delegation. Is a human using this machine or a LAN peer right now, and is it OK to load its GPU? CALL THIS BEFORE starting GPU-heavy or long CPU-heavy work (training, inference servers, renders, big builds, benchmarks), locally or on behalf of a remote host. gpu=avoid: someone is gaming/fullscreen, the GPU is already loaded, or the owner marked the host busy; do not start the job, defer it or ask the user. gpu=shared: a person is active; light work only, ask before heavy jobs. gpu=free: idle, go ahead.",
  { json: z.boolean().optional().describe("return raw JSON instead of text") },
  async ({ json }) => {
    const { hostStatuses, formatHostStatuses } = await import("./lib/presence.mjs");
    const s = await hostStatuses();
    return text(json ? s : formatHostStatuses(s));
  },
);

server.tool(
  "send_message",
  "Send a plain-text message to another live agent locally or on an authenticated LAN peer. Remote idle subscriptions are not supported; use immediate delivery. Claude receives it on its inbox socket. Codex uses its agentbus bridge to steer an active turn or wake an idle thread; without a bridge, it queues mail for trusted tool/prompt/stop hooks. Check delivery: accepted, queued, or uncertain. Never automatically retry uncertain delivery. First line should summarize the message. Never ask a peer to do something your own session was denied. when='idle' holds delivery until idle; notify_when_idle=true sends you one idle notice.",
  {
    to: z.string().describe("target: name, `claude:<session-id>`, `codex:<thread-id>`, an id prefix, a pid, or a unique cwd substring (see list_agents)"),
    message: z.string().optional().describe("plain text body. may be omitted with notify_when_idle=true for a pure subscription"),
    from: z.string().optional().describe("your own id (`codex:<thread-id>` or `claude:<session-id>`). required from codex when more than one codex thread is live; claude sessions are auto-detected"),
    when: z.enum(["now", "idle"]).optional().describe("'now' (default) or 'idle': deliver once the target is idle"),
    notify_when_idle: z.boolean().optional().describe("also send you a one-shot notice when the target next goes idle (12h ttl)"),
  },
  async ({ to, message, from, when, notify_when_idle }) => {
    const agents = await listReachableAgents();
    const r = resolveTarget(to, agents);
    if (!r.ok) return text(r);
    const self = selfIdentity(from);
    if (!self) return text({ ok: false, error: "can't tell who you are; pass from=<your id>" });
    if (self.id === r.agent.id) return text({ ok: false, error: "refusing to message yourself" });
    if (r.agent.remote) {
      if (when === "idle" || notify_when_idle) return text({ ok: false, error: "LAN targets currently support immediate delivery only; idle subscriptions are local-only" });
      if (!message) return text({ ok: false, error: "message is required for a LAN target" });
      return text(await sendMessage({ to: r.agent.id, message, from: self.id }));
    }
    const out = { to: r.agent.id, to_name: r.agent.name, from: self.id, target_status: r.agent.status };
    const deferred = when === "idle" && r.agent.status !== "idle";
    if (message && !deferred) Object.assign(out, await sendMessage({ to: r.agent.id, message, from: self.id }));
    if (deferred || notify_when_idle) {
      const sub = subscribeIdle(r.agent, self, { message: deferred ? message : null });
      out.subscription = sub.sub_id;
      out.note = (out.note ? out.note + " " : "") + (deferred ? `message held until ${r.agent.name} is idle` : "") + (notify_when_idle ? ` you'll get one [agentbus idle notice] when ${r.agent.name} next goes idle` : "");
      out.ok = true;
    }
    return text(out);
  },
);

server.tool(
  "check_inbox",
  "Codex only: read and clear pending agentbus messages for a codex thread. Claude sessions receive messages automatically and don't need this.",
  {
    thread: z.string().optional().describe("codex thread id (defaults to the only live codex thread, or AGENTBUS_SELF)"),
    peek: z.boolean().optional().describe("read without clearing"),
  },
  async ({ thread, peek }) => {
    let id = thread;
    if (!id) { const me = selfIdentity(); if (me?.kind === "codex") id = me.threadId; }
    if (id && !/^[0-9a-f-]{36}$/.test(id)) { const r = resolveTarget(id); if (r.ok && r.agent.kind === "codex") id = r.agent.threadId; }
    if (!id) return text({ ok: false, error: "could not determine which codex thread you are; pass thread=<id>" });
    const msgs = drainInbox(id, { peek: !!peek });
    if (!msgs.length) return text("inbox empty");
    return text(renderMessages(msgs));
  },
);

server.tool(
  "whoami",
  "Report how agentbus identifies this session, plus your pending idle subscriptions (debugging).",
  {},
  async () => {
    const self = selfIdentity();
    const subs = listSubscriptions().filter((s) => !self || s.subscriber.id === self.id).map((s) => ({ target: s.target.name, holds_message: !!s.message, age: fmtAge(Date.now() - s.createdAt) }));
    return text({
      self,
      subscriptions: subs,
      env: Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(CLAUDE|CODEX|AGENTBUS)/.test(k)).map(([k, v]) => [k, /TOKEN|KEY|SECRET/.test(k) ? "<redacted>" : v])),
      ppid: process.ppid,
    });
  },
);

// background poller: fires idle notices / deferred messages for any subscription on disk.
// every mcp server instance polls, so whichever is alive does the work; fireIdle unlinks first, so no double fires.
const POLL_MS = Number(process.env.AGENTBUS_POLL_MS || 3000);
let polling = false;
setInterval(async () => {
  if (polling) return; polling = true;
  try { await pollSubscriptions(); } catch (e) { process.stderr.write(`agentbus poll: ${e?.message || e}\n`); }
  polling = false;
}, POLL_MS).unref();

const { startClaudeRelay } = await import('./lib/claude-relay.mjs');
const identity = process.env.CLAUDE_CODE_MESSAGING_SOCKET ? selfIdentity() : null;
const claudeRelay = await startClaudeRelay({ busDir: (await import('./lib/core.mjs')).BUS_DIR, sessionId: identity?.sessionId || process.env.CLAUDE_CODE_SESSION_ID, socketPath: process.env.CLAUDE_CODE_MESSAGING_SOCKET, token: process.env.CLAUDE_CODE_MESSAGING_TOKEN });
// A relay must not outlive its owning MCP connection/session.
process.stdin.once('end', () => { void claudeRelay?.close(); });
await server.connect(new StdioServerTransport());
