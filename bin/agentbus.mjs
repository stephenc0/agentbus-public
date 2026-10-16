#!/usr/bin/env node
// human/script cli:  agentbus list [--json] | agentbus send <to> <message...> [--from <id>] | agentbus inbox <thread> [--peek] | agentbus whoami
import { listReachableAgents, sendMessage, selfIdentity, drainInbox, resolveTarget, formatAgents } from "../lib/core.mjs";

const args = process.argv.slice(2);
const cmd = args.shift();
const flag = (name) => { const i = args.indexOf(name); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
const has = (name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };

switch (cmd) {
  case "session-smoke": {
    const { runSessionSmokeCli } = await import("./session-smoke.mjs");
    await runSessionSmokeCli(args);
    break;
  }
  case "build-info": {
    const { buildInfo, sourceManifest } = await import("../lib/build-info.mjs");
    console.log(JSON.stringify(has('--manifest') ? sourceManifest() : buildInfo, null, 2));
    break;
  }
  case "home-presence": {
    const { homePresenceMain } = await import("./home-presence.mjs");
    await homePresenceMain(args);
    break;
  }
  case "sessions": {
    const { runSessions } = await import("./sessions.mjs");
    await runSessions(args);
    break;
  }
  case "storage": {
    const { runStorage } = await import("./storage.mjs");
    await runStorage(args);
    break;
  }
  case "blob": {
    const { runBlob } = await import("./blob.mjs");
    try { await runBlob(args); } catch (e) { console.error(e.message); process.exit(e.message.startsWith('usage:') ? 2 : 1); }
    break;
  }
  case "lan": {
    const { runLan } = await import("./lan.mjs");
    await runLan(args);
    break;
  }
  case "install-codex-bridge": {
    const { installBridge } = await import("../lib/codex-install.mjs");
    console.log(JSON.stringify(await installBridge(flag("--binary")), null, 2));
    break;
  }
  case "uninstall-codex-bridge": {
    const { uninstallBridge } = await import("../lib/codex-install.mjs");
    console.log(JSON.stringify(uninstallBridge(), null, 2));
    break;
  }
  case "bridge-status": {
    const { bridgeStatus } = await import("../lib/codex-install.mjs");
    console.log(JSON.stringify(await bridgeStatus(flag("--thread")), null, 2));
    break;
  }
  case "launch-codex": {
    const { launchDesktop } = await import("../lib/codex-launch.mjs");
    console.log(JSON.stringify(await launchDesktop({ atLogin: has("--at-login") }), null, 2));
    break;
  }
  case "list": case "ls": case undefined: {
    const json = has("--json");
    const agents = await listReachableAgents();
    if (json) console.log(JSON.stringify(agents, null, 2)); else console.log(formatAgents(agents, selfIdentity()));
    break;
  }
  case "send": {
    const from = flag("--from");
    const to = args.shift();
    const message = args.join(" ");
    if (!to || !message) { console.error("usage: agentbus send <to> <message...> [--from <id>]"); process.exit(2); }
    console.log(JSON.stringify(await sendMessage({ to, message, from }), null, 2));
    break;
  }
  case "inbox": {
    const peek = has("--peek");
    let id = args.shift();
    if (!id) { console.error("usage: agentbus inbox <codex-thread-id|name> [--peek]"); process.exit(2); }
    if (!/^[0-9a-f-]{36}$/.test(id)) { const r = resolveTarget(id); if (!r.ok) { console.error(r.error); process.exit(1); } id = r.agent.threadId; }
    const msgs = drainInbox(id, { peek });
    console.log(msgs.length ? msgs.map((m) => `[${m.at}] from ${m.from_name} (${m.from}):\n${m.content}`).join("\n\n") : "inbox empty");
    break;
  }
  case "presence": case "host-status": {
    const json = has("--json");
    const { hostStatuses, formatHostStatuses } = await import("../lib/presence.mjs");
    const s = await hostStatuses();
    console.log(json ? JSON.stringify(s, null, 2) : formatHostStatuses(s));
    break;
  }
  case "busy": case "available": case "auto": {
    const { setOverride, parseDuration } = await import("../lib/presence.mjs");
    const dur = flag("--for");
    const o = setOverride(cmd, { reason: args.join(" "), forMs: dur ? parseDuration(dur) : undefined });
    console.log(o ? `marked ${o.state}${o.reason ? `: ${o.reason}` : ""}${o.until ? ` until ${new Date(o.until).toLocaleString()}` : ""}` : "presence back to automatic");
    break;
  }
  case "whoami":
    console.log(JSON.stringify(selfIdentity(), null, 2));
    break;
  default:
    console.error("usage: agentbus [list [--json] | send <to> <msg...> [--from id] | inbox <thread> [--peek] | whoami | presence [--json] | busy [reason] [--for 2h] | available [--for 2h] | auto | install-codex-bridge [--binary path] | uninstall-codex-bridge | bridge-status [--thread id] | launch-codex | lan <init|serve|status> | storage <add|list|remove>]");
    process.exit(2);
}
