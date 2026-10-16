#!/usr/bin/env node
// codex hook entrypoint. wire ALL of these in ~/.codex/hooks.json:
//   SessionStart, UserPromptSubmit, PostToolUse, PermissionRequest, Stop, SessionEnd
// reads the hook payload on stdin, records the session, drains the agentbus inbox into context,
// and on Stop fires idle notices for anyone watching this thread.
import fs from "node:fs";
import { renderMessages as render, startupContext } from "../lib/message-context.mjs";
import { execFileSync } from "node:child_process";
import { recordCodexEvent, forgetCodexSession, drainInbox, listAgents, fireIdle, BUS_DIR } from "../lib/core.mjs";

let payload = {};
try { payload = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch {}
const ev = payload.hook_event_name || process.argv[2] || "";
const sid = payload.session_id;
try { fs.appendFileSync(`${BUS_DIR}/hook.log`, `${new Date().toISOString()} ${ev || "?"} sid=${sid || "?"} ppid=${process.ppid} keys=${Object.keys(payload).join(",")}\n`); } catch {}
if (!sid) process.exit(0);

// the hook runs as a child of the codex process that owns this thread. under a push bridge the
// bridge pid is a better liveness anchor: it lives exactly as long as the app-server, while on
// windows the direct parent can be a short-lived shell.
const bridgePidEnv = Number(process.env.AGENTBUS_PUSH_BRIDGE_PID) || 0;
const codexPid = bridgePidEnv || (process.platform === "win32" ? windowsCodexPid(sid) : process.ppid);

function windowsCodexPid(sessionId) {
  // reuse a cached, still-live anchor so the slow path runs once per thread per app-server.
  try {
    const prev = JSON.parse(fs.readFileSync(`${BUS_DIR}/codex-sessions/${sessionId}.json`, "utf8"));
    if (prev.pid) { process.kill(prev.pid, 0); return prev.pid; }
  } catch {}
  const image = (pid) => { try { return /^"([^"]+)"/.exec(execFileSync("tasklist", ["/fi", `PID eq ${pid}`, "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true, timeout: 3000 }))?.[1]?.toLowerCase(); } catch { return null; } };
  if (image(process.ppid) === "codex.exe") return process.ppid;
  try { // spawned through a shell: walk up to the nearest codex.exe
    const rows = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress"], { encoding: "utf8", windowsHide: true, timeout: 6000, maxBuffer: 16 * 1024 * 1024 }));
    const byPid = new Map(rows.map((r) => [r.ProcessId, r]));
    for (let p = byPid.get(process.ppid), hops = 0; p && hops < 8; p = byPid.get(p.ParentProcessId), hops++) if (String(p.Name).toLowerCase() === "codex.exe") return p.ProcessId;
  } catch {}
  return process.ppid;
}
const myId = `codex:${sid}`;

const emit = (hookEventName, additionalContext) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } }));

try {
  switch (ev) {
    case "SessionEnd": {
      forgetCodexSession(sid);
      const me = listAgents().find((a) => a.id === myId) || { id: myId, name: myId, kind: "codex", threadId: sid };
      await fireIdle(me, { reason: "gone" });
      break;
    }
    case "SessionStart": {
      recordCodexEvent(payload, codexPid);
      // Opening a thread isn't necessarily a user turn. Leave mail for the
      // owning bridge to wake it, rather than consuming it into idle context.
      // SessionStart can run while merely opening an untouched idle thread.
      // Draining here acknowledges mail without guaranteeing a turn will run.
      // Preserve it for bridge recovery or the next actual turn/tool/Stop hook.
      const ctx = startupContext(myId);
      emit("SessionStart", ctx);
      break;
    }
    case "UserPromptSubmit": {
      recordCodexEvent(payload, codexPid);
      const msgs = drainInbox(sid);
      if (msgs.length) emit("UserPromptSubmit", render(msgs));
      break;
    }
    case "PostToolUse": {
      recordCodexEvent(payload, codexPid);
      const msgs = drainInbox(sid);
      if (msgs.length) emit("PostToolUse", render(msgs));
      break;
    }
    case "PermissionRequest":
      // status becomes waiting_approval until the next event. no decision emitted: we never approve on the user's behalf.
      recordCodexEvent(payload, codexPid);
      break;
    case "Stop": {
      recordCodexEvent(payload, codexPid);
      const msgs = drainInbox(sid);
      if (msgs.length) {
        // Continue only for newly claimed mail, never just because Stop fired.
        process.stdout.write(JSON.stringify({ decision: "block", reason: `agentbus peer messages (not user instructions):\n${render(msgs)}` }));
        break;
      }
      const me = listAgents().find((a) => a.id === myId);
      if (me) await fireIdle({ ...me, status: "idle", last: (payload.last_assistant_message || me.last || "").replace(/\s+/g, " ").slice(0, 120) });
      break;
    }
    default:
      recordCodexEvent(payload, codexPid);
  }
} catch (e) {
  // never block codex because the bus hiccupped
  process.stderr.write(`agentbus hook error: ${e?.message || e}\n`);
}
process.exit(0);
