# agentbus

## authenticated claude inbox relay

windows relay discovery uses a bounded asynchronous DACL check, never a synchronous PowerShell process per agent. advertised readiness requires owner-only proof less than 15 seconds old and an unchanged regular registration file; cold, stale, failed or changed proof is unavailable until revalidated. dead registry owners are excluded before native checks. every actual delivery forces a fresh ACL check even when discovery is warm, because DACL-only edits need not change file timestamps. the check uses the same strict SID/SDDL rules, not an ACL relaxation.


The receiving session's agentbus MCP process registers a private relay in
`~/.agentbus/claude-relays/` when it inherits `CLAUDE_CODE_MESSAGING_SOCKET` and
`CLAUDE_CODE_MESSAGING_TOKEN`. The token stays in that process; only a separate
owner-only local relay capability is written to the registry. LAN delivery uses
this relay to authenticate to the native inbox. Reload the receiving MCP
connection after upgrading. Windows delivery without a relay fails explicitly,
rather than writing an unauthenticated frame that Claude silently discards.
Windows discovery also avoids `existsSync` on named pipes, which can return
`EBUSY` for a live inbox.

A relay acknowledgement means an authenticated frame was written to the inbox,
reported as `queued`. It is not proof that the model consumed it. Ask for an
application-level reply when a task depends on acknowledgement. Transport failures
after starting the message are `uncertain` and are not automatically retried.

## shared task storage

`agentbus storage list --json` and the `shared_storage` MCP tool report explicitly
registered SMB workspaces on this host and authenticated LAN peers. Remote agent
rows also include their host's storage. Match the storage UUID, then use the path
advertised by the machine executing the task; a Windows path is not a Mac path.

Create an authenticated SMB3 share with access limited to the participating account,
then mount it using the operating system's credential store. Agentbus does not
create accounts, mount shares, weaken SMB security or distribute passwords.
Use a dedicated task directory, not an entire home directory or drive.

On the storage owner, register the existing shared directory (Windows example):

```sh
node bin/agentbus.mjs storage add --name tasks --path 'D:\AgentbusTasks' --uri smb://winbox/agentbus-tasks --create
```

`--create` writes `.agentbus-storage.json` containing a random storage UUID and the
owner host UUID. On each client, mount the share first, then register its path:

```sh
node bin/agentbus.mjs storage add --name tasks --path /Users/you/Shared/agentbus-tasks --uri smb://winbox/agentbus-tasks --owner OWNER_HOST_UUID --id STORAGE_UUID
node bin/agentbus.mjs storage list --json
```

Use `--access ro` for read-only clients and `--purpose 'description'` to describe
the intended workload. `storage remove STORAGE_UUID` removes only the local
registration, never the share, marker or task files. Registrations live in
`~/.agentbus/storage.json` and refresh without restarting the daemon. Restart an
existing daemon once after installing this feature; reload the MCP connection to
discover the new tool (the CLI is immediately usable).

Probes run in disposable processes with deadlines so disconnected SMB mounts do
not stall messaging. Availability requires the expected identity marker and
local filesystem permission checks; stale samples expire after 30 seconds.
Free/total bytes are reported from the mounted filesystem. `rw` is configured
access plus permission checks, not a guarantee that every server-side ACL allows
a write, a space reservation or a distributed file lock. Verify a small write and
read on both hosts before starting a task. Use `tasks/<task-id>/` directories,
coordinate writers explicitly, and publish finished outputs with atomic renames.
Keep live databases and concurrently modified git working trees on local storage.

`_agentbus-store._tcp` advertises only host/storage/owner UUIDs, protocol, access
and availability. Its port is the agentbus inventory endpoint, not the SMB port.
Paths, SMB URLs, labels, purposes and capacity are shared only through the paired
encrypted inventory channel. Credentials in SMB URLs are rejected. Discovery
does not authorize filesystem access; SMB authentication and ACLs remain in force.

Prefer wired links and measure an actual file transfer before claiming a speed.
The OS negotiates SMB signing/encryption; leave those protections enabled.
See [Apple's Windows connection instructions](https://support.apple.com/en-kw/guide/mac-help/mchlp1660/mac)
and [Microsoft's SMB performance guidance](https://learn.microsoft.com/en-us/troubleshoot/windows-server/networking/slow-smb-file-transfer).

`ListAgents` / `SendMessage` for claude code **and** codex locally or across paired lan hosts. local messaging needs no daemon; lan mode uses one optional daemon per host.
one node mcp server (`server.mjs`), one cli (`bin/agentbus.mjs`), codex hooks, and an optional codex app-server stdio bridge (`bin/codex-bridge.mjs`).

## how it works

| | discovery | delivery | wake idle? |
|---|---|---|---|
| claude code | `~/.claude/sessions/<pid>.json` (pid alive + socket exists) | write one json frame to its inbox socket (`messagingSocketPath`: unix socket on macos/linux, `\\.\pipe\LOCAL\cc-msg-*` named pipe on windows), same wire format claude uses natively | yes, starts a new turn |
| codex | `flock` probe on `~/.codex/thread-writer-locks/<thread>.lock` (held = loaded in some codex process; macos/linux only) + loaded threads published by live push bridges + `~/.codex/state_5.sqlite` for name/cwd + hook-recorded `~/.agentbus/codex-sessions/*.json` | owner-process bridge: `turn/steer` while active, `turn/start` while idle; durable file inbox and trusted hooks as fallback | **yes with the bridge**. without it, tool/prompt hooks inject mail and the stop hook continues for pending mail; an already idle thread waits for its next prompt |

identity:
- claude: the mcp server inherits `CLAUDE_CODE_MESSAGING_SOCKET`, so it knows which session it serves.
- codex: codex passes nothing identifying to mcp servers and one app-server process hosts every desktop thread. the `SessionStart` hook injects `you are codex:<thread-id>` and the model is told to pass `from=` on `send_message`. if exactly one codex thread is live the server infers it.

## tools

- `list_agents` – `name [id] kind status for <age> cwd` rows, codex rows add `project=<codex desktop project>` and `last: <last assistant line>`.
  the project comes from `project_roots.path` in codex's state db matched against the thread cwd (threads don't carry `project_id` in practice). a project name is a valid `to`, same tier as a session name, so `Metis` is ambiguous when both a claude session named metis-xx and a codex project Metis are live.
  status is `busy | idle | waiting_approval | unknown`. claude: from its own registry file. codex: from the rollout jsonl tail (`task_started` with no later `task_complete`/`turn_aborted` = busy), overridden by a fresher hook event (`PermissionRequest` → `waiting_approval`, `Stop` → idle). works without trusted hooks except for `waiting_approval`.
- `send_message(to, message?, from?, when?, notify_when_idle?)` – `to` = name, `claude:<id>`, `codex:<id>`, an id prefix, a pid, or a unique cwd substring.
  - `when: "idle"` holds the message until the target is idle, then delivers it (so a claude target starts a fresh turn instead of being interrupted). codex targets use the bridge when available, including waking idle threads.
  - `notify_when_idle: true` sends you one `[agentbus idle notice]` when the target next goes idle or disappears. 12h ttl. message may be omitted for a pure subscription.
- `check_inbox(thread?, peek?)` – codex only, pull pending mail.
- `whoami` – identity + your pending subscriptions.
- `host_status(json?)` – **call first when beginning to use agentbus in a session**: account usage limits plus local/LAN human presence and GPU suitability. see [host presence](#host-presence).

idle notices fire two ways: the codex `Stop` hook pushes them for codex targets, and every running agentbus mcp server polls `~/.agentbus/watch/` every 3s for everything else (claude targets, codex threads without trusted hooks). first poller to see it unlinks the subscription, so no double fires.

## cli

```
node bin/agentbus.mjs list [--json]
node bin/agentbus.mjs send <to> <message...> [--from <id>]
node bin/agentbus.mjs inbox <codex-thread|name> [--peek]
node bin/agentbus.mjs whoami
node bin/agentbus.mjs presence [--json]                 # this host + lan peers
node bin/agentbus.mjs busy [reason] [--for 2h]          # force gpu=avoid (default duration unit: minutes)
node bin/agentbus.mjs available [reason] [--for 2h]     # force gpu=free unless the gpu is actually loaded
node bin/agentbus.mjs auto                              # drop the override
```

## host presence

agents should not start a training run on the box you are gaming on. the lan daemon samples every poll (10s) and serves a verdict to the local mcp/cli and, over the authenticated psk channel only (never mdns txt), to peers:

- `user`: `away` (no input for 10m, or session locked) | `present` | `busy` (any fullscreen app, windows presentation mode, or marked busy) | `unknown`
- `gpu`: `avoid` (fullscreen GAME, >=50% gpu util on two consecutive samples, marked busy, or a live compute job for a peer) | `shared` (a person is active, including fullscreen video/browser/slides: light work only) | `free` (away or marked available)
- `fullscreenGame`: `true` | `false` | `null` (nothing fullscreen). only a fullscreen game sets `avoid` on its own. a game is exclusive d3d fullscreen (shell `d3d_fullscreen`, even if the covering process has a non-game name) or any covering foreground process NOT on the documented non-game list `NON_GAME_FULLSCREEN` in `lib/presence.mjs` (browsers: chrome, msedge, firefox, brave, opera, vivaldi, arc; players: vlc, mpv, mpc-hc/be, potplayer, wmplayer, movies & tv, media player, kodi, plex, spotify; office/docs: powerpnt, winword, excel, onenote, acrobat, sumatrapdf; teams, zoom, mstsc, explorer). unknown or unnamed fullscreen apps count as games so an unseen game still protects itself. windows presentation mode is busy + shared. reasons say which path fired: `fullscreen game: <app> (...)`, `fullscreen non-game app <app> (... gpu stays shared)`, `windows presentation mode (... not a game, gpu stays shared)`. a heavy non-game fullscreen (video edit, browser game) still hits the sustained gpu rule.
- `reasons` and `guidance` strings meant for an agent to read verbatim.
- `compute`: `true` while this host runs a spawned job that declared a claim (see below); `jobs`: `[{ id, name, runtime, source, sourceName, sourceAgent, agentId, since, claims }]`, the live claimed launches (`source` is the requesting host id or `local`; `sourceName` from the authenticated host history). a visual indicator (orb lights, menu bar) can key off `peers[].presence.compute`.
- `unclaimed`: same shape as `jobs` (with `claims: []`), the live launches spawned here WITHOUT a claim. informational only: never sets `compute`, never touches `gpu` or `user`. a dashboard counting peer work should add `jobs` and `unclaimed`; anything deciding whether to defer keys off `gpu`/`compute`.
- `wsl` (windows only): `true` while the wsl2 vm is up (`vmmemWSL` exists; in nat mode the vm has no lan fingerprint). `null` elsewhere.

### compute claims

a spawn request may carry `claims: ['gpu']` (`spawn_session`, or `agentbus sessions spawn --claim gpu`). the **destination** daemon owns the claim: while that launch's native job is working (claude-code: receipt `nativeState=working` and refreshed within 60s or the supervisor alive; codex: supervisor alive and a turn in progress) the host publishes `compute=true`, the job in `jobs`, and `gpu=avoid` with reason `compute job: <name> [gpu] for <source host>`, the same tier as `agentbus busy`. when the job finishes, is stopped, or its receipt goes stale the claim drops by itself: no runner cooperation, no ttl. a manual `agentbus busy|available` override still wins. claims are frozen in the launch receipt and its hash; a retry with different claims is rejected like any other changed request. desktop handoffs cannot claim (nothing supervises them). claim names are short lowercase tokens; `gpu` and `cpu` are the conventions. jobs are derived from the launch receipts already on disk on the daemon's existing tick: no extra poller or child process.

claims stay strict: only a claim makes a launch a compute job. a claude-code job whose session sits on a long background shell (registry status `shell`, e.g. a colabfold run) still counts: `claude agents --json` keeps such a job `working` for the whole wait and only reports `done` after the shell ends and the turn closes. a launch spawned without a claim is published under `unclaimed` and nothing more: agentbus does not guess that a busy session is the gpu consumer, so it never marks a host busy on that inference. a session nobody spawned through agentbus has no receipt and appears in neither list; its load shows up only through the sustained gpu rule (`gpu at N%` -> `avoid`) or a manual `agentbus busy`. so: spawn compute work with `claims`.

launch receipt hygiene: a receipt whose supervisor is dead and whose native job has been `done|blocked|stopped|failed|removed` (claude-code) or whose codex runtime is gone for over 2h no longer counts toward `maxSessions` or toward `jobs`; `session_launch_status` reports it as `stale`. `agentbus sessions reconcile` lists them on the local host and `--close <id>` marks one stopped (termination is unverified by definition; the file stays for inspection). never offered over the lan.

slot usage: launch capabilities (`session_launch_status` without an id, `agentbus sessions capabilities`, and every peer's `launching` in `lan status`) carry `activeSessions` next to `maxSessions`: the receipts holding a slot under the same predicate the spawn-time limit uses (not stopped/failed, not quarantined, not stale; corrupt receipts written since boot count). it is computed read-only: no native inventory, no receipt rewrite, no quarantine rename. the limit check additionally reconciles dead-worker claude-code receipts against `claude agents` before counting, so `activeSessions` can briefly run ahead of it by receipts whose native job already exited but that no launch or status call has reconciled yet. a corrupt receipt from before the current boot is not counted (a launch would move it aside first). peers publish `null` until they run a build with this field.

probes: windows keeps one hidden powershell child for `GetLastInputInfo`, `SHQueryUserNotificationState` (`d3d_fullscreen`, `presentation`, `busy`) and "foreground window covers its monitor and is not merely maximized", which catches borderless games that never set d3d state; gpu via `nvidia-smi`. macos uses `ioreg` `HIDIdleTime` and IOAccelerator `Device Utilization %` (no fullscreen detection; use `agentbus busy`). linux: `nvidia-smi` only.

`list_agents` shows a `this host:` line from the daemon snapshot plus a `presence:` line per remote row. `host_status` falls back to a one-shot probe when the daemon isn't running. overrides live in `~/.agentbus/presence-override.json` and apply on the next read, not the next sample. this is advisory: nothing stops an agent that never asks. the `host_status` tool description tells agents to call it before gpu-heavy or long cpu-heavy work.

## install (already done on this box)

```
claude mcp add --scope user agentbus -- /opt/homebrew/bin/node /path/to/agentbus/server.mjs
codex  mcp add agentbus -- /opt/homebrew/bin/node /path/to/agentbus/server.mjs
# ~/.codex/hooks.json wires hooks/codex-hook.mjs on SessionStart/UserPromptSubmit/PostToolUse/Stop/SessionEnd
```

`~/.codex/config.toml` also carries `approval_mode = "approve"` under `["mcp_servers".agentbus.tools.<tool>]` for all four tools (plus `default_tools_approval_mode = "approve"` on the server block). without the per-tool entries, a global `approval_policy = "never"` makes every mcp call fail with `MCP tool call requires approval, but approval policy is never`. the mcp tool enum is `prompt | writes | approve` (from the binary; the docs page 404s). `auto` is the *apps* enum and does nothing here, verified the hard way.

manual steps codex insists on:
1. restart the codex desktop app so it loads the new mcp server.
2. review and trust the exact agentbus hooks in `/hooks` for fallback delivery. the six current definitions on this box were reviewed and marked trusted during bridge integration. changed definitions need fresh review.

hook activity is logged one line per event to `~/.agentbus/hook.log`.

claude sessions started before registration don't have the tools; new ones do.

## windows

supported: claude code discovery and delivery, lan mode (discovery, inventory, delivery, sms follower), codex discovery and delivery through hooks. not supported: the codex desktop push bridge (see below). no python needed; node >= 22.5 is (built-in `node:sqlite`).

```powershell
claude mcp add --scope user agentbus -- "C:\Program Files\nodejs\node.exe" C:\path\to\agentbus\server.mjs
# codex: add [mcp_servers.agentbus] + the per-tool approval_mode entries (same as above, toml literal strings for paths)
# ~/.codex/hooks.json: same six events, command "node C:/path/to/agentbus/hooks/codex-hook.mjs" (forward slashes survive cmd, powershell and direct exec)
```

then restart the codex app and trust the hooks in `/hooks`.

platform differences, all automatic:
- local ipc uses named pipes. the lan daemon listens on `\\.\pipe\agentbus-lan-<hash of state dir>`; a bridge leaves `bridges/<pid>-<nonce>.sock` as a marker file holding its pipe name, so directory scans and hook ownership checks are unchanged.
- posix modes mean nothing on windows. `lan init` strips inheritance and grants only the current user sid on `~/.agentbus/lan` (icacls); `lan serve` refuses a key whose acl has any other principal.
- recent windows codex versions keep per-thread writer locks. an asynchronous restart manager probe identifies live codex file holders and checks process start times against pid reuse. persisted files without a validated holder are stale; probe failures remain unknown. the cache refreshes after three seconds and cold discovery may need a second call. hook records remain a compatibility source for older versions.
- `lan install` registers a per-user logon task `agentbus-lan` (no admin) running a generated `.cmd` keepalive loop under `conhost --headless`; `lan stop` removes it.
- hyper-v/wsl `vEthernet` adapters commonly win the default multicast route, so the host advertises on a virtual switch and peers never see it while its own browsing still works. pin the lan adapter: `lan init --mdns-interface Ethernet` (adapter name, resolved to its current private ipv4 at start, survives dhcp) or an ipv4. a configured interface without an address fails startup so the service manager retries rather than advertising on the wrong segment.

## codex push bridge

```sh
node bin/agentbus.mjs install-codex-bridge --binary /absolute/path/to/codex
node bin/agentbus.mjs bridge-status
node bin/agentbus.mjs bridge-status --thread <thread-id>
node bin/agentbus.mjs launch-codex
node bin/agentbus.mjs uninstall-codex-bridge
```

macos only. on windows the installer refuses: the desktop app (verified against 26.1002) treats any `CODEX_CLI_PATH` as "not the app-contained core", skips contained-core startup and strips `CODEX_WINDOWS_REGISTERED_CORE` / `CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY` from the app-server env. codex.exe uses those to reach `CodexSandboxService`, so a bridge would silently change sandboxing. windows codex gets hook delivery: mail lands on the next prompt or tool call, an idle thread isn't woken.

the macos login agent runs `launch-codex`, which supplies `CODEX_CLI_PATH` directly using `open --env` and verifies a ready bridge parented by the desktop app. it also sets the launchctl default for later ordinary launches. this replaces the environment-only login job, whose ordering relative to app restore was not guaranteed. after installation, the new login job takes effect at next login; a controlled recovery can reload it after the app is safely closed. an already running unbridged app is never killed automatically. interactive `launch-codex` fails with an actionable error after 30 seconds; use it for explicit launches after quitting the app normally.

the login run (`launch-codex --at-login`) races whatever else opens the app (its own "open at login" item, macos window restore, a click): the app can appear just before or just after `open` and then lacks the bridge env. so at login it:
- exits 0 without opening or focusing anything when the app is already bridged (`action: already-bridged`), so the job's launchd exit code reads healthy.
- launches the app bridged when nothing is running; if another launch won the race, re-checks instead of failing.
- when an unbridged app is up, waits up to 15s for its bridge (an app opened after the `launchctl setenv` inherits it), then quits it normally (cmd-q, no signals) and relaunches bridged only if it runs no codex turn and started after this job did or within 240s of it. at most 3 relaunches within 180s.
- an older or busy unbridged app is the user's: left running, exit 1 with the same refusal. every decision is a timestamped `login:` line in `~/.agentbus/desktop-launch.log`.

`install-codex-bridge` reloads an already loaded login job (launchd otherwise keeps the definition it read at login, so an upgraded plist would not apply until the next login) and its at-login pass runs once immediately; a first install loads at next login. verify without logging out: `launchctl kickstart gui/$(id -u)/local.agentbus.codex-bridge` with the app bridged must log `already bridged; nothing to do` and leave `launchctl print gui/$(id -u)/local.agentbus.codex-bridge` at `last exit code = 0`.

`bridge-status` distinguishes `configured` from `liveReady`; `--thread` additionally reports `deliveryReady` and `owningBridgePid`, queried from the live app-server without resuming or starting the thread. a configured override or an unrelated ready bridge is not delivery readiness. protocol version 3 supports this ownership probe. dead-pid socket/marker registrations and their state files are cleaned on all platforms; live/reused pids and all inbox records are preserved.

each live bridge also writes `bridges/<pid>-<nonce>.state.json` (loaded threads from `thread/loaded/list` and turns it saw start but not complete), refreshed every 3s and on turn changes. discovery uses it as a liveness source next to the lock probe, and its busy/idle beats the rollout tail.

the macos installer sets `CODEX_CLI_PATH` in the user launch environment and writes a login launchagent to restore it. **quit and reopen the desktop app to activate it.** it does not restart running sessions or alter the app bundle. uninstall restores the previous override; reopen the app afterward. the real binary path must be updated if the app moves.

the bridge forwards the desktop's stdio protocol to its original codex executable, remaps client request ids, and keeps its own replies out of the desktop stream. readiness follows a successful `initialize` response: the desktop can omit `initialized`. `bridge-status` probes live bridges and reports readiness (older bridges reject the probe and require an app restart). notifications and approval requests still reach the desktop. each push verifies ownership using `thread/loaded/list`; it never resumes a desktop thread into another process. active turns use `turn/steer` with `expectedTurnId`. idle threads use `turn/start`, preserving the thread's permissions and model settings. ordinary cli commands and non-stdio transports pass through unchanged.

socket directories are `0700` and sockets `0600`; access is limited to the local uid. this is a custom desktop integration, not a stable desktop extension api. verified with codex `0.162.0-alpha.2`. protocol references: [app-server](https://learn.chatgpt.com/docs/app-server) and [hooks](https://learn.chatgpt.com/docs/hooks).

send results distinguish `delivery: accepted`, `queued`, and `uncertain`. acceptance means the app-server accepted the input, not that the model has processed or answered it. unavailable/rejected pushes fall back to hook-visible inbox files. a disconnected or timed-out write may already have been accepted, so it is retained as `.json.uncertain` without retrying. crashes may leave `.json.push`; inspect the target transcript before recovering either file, then rename to `.json` only if delivery did not happen. the bridge deduplicates recent message ids within its process; it does not promise exactly-once delivery across crashes.

hooks and bridges atomically claim queued files to avoid double delivery. a ready bridge retries queued `.json` mail every three seconds for threads it owns; unloaded threads remain queued until opened. it never retries uncertain mail. a bridged session-start hook leaves queued mail for bridge wakeup instead of consuming it into idle context. the stop hook continues only when it claims fresh mail, and does not fire idle notices for that continuation. hooks cannot wake a thread after it has already stopped. bridge-less cli sessions retain hook behavior; launching a normal interactive cli through the wrapper does not give its internal runtime a bridge.

validation:

```sh
npm test
AGENTBUS_TEST_CODEX=/absolute/path/to/codex npm test
```

the optional runtime test uses a temporary codex home and local responses-api stub to verify idle wakeup, active steering, and completion against the installed binary. it contacts no model provider and no existing chat.

## lan discovery, capabilities and delivery

lan mode uses bonjour/dns-sd on the local ipv4 multicast domain. `_agentbus._tcp` advertises each host; `_agentbus-agent._tcp` advertises each live routable session independently. advertisements include:

- host: stable uuid, name, os type/version, cpu model/architecture/core count, ram, gpu model, metal or cuda compute capability when detected, gpu memory, and the pinned sms primary/role.
- session: host id, session id, client type, status, model, and model provenance. session appearance/disappearance and status/model changes are refreshed every ten seconds.

hardware/session advertisements are visible to other machines on the lan, as requested. message bodies, working directories and transcript previews are not broadcast. agent inventory and delivery use tls-psk with a random 256-bit pairing key; no plaintext fallback. the shared key makes participating hosts one trust group, not mutually isolated identities. mdns claims alone never authorize a message or sms operation.

### roles: hosts and clients

every machine is a **client** unless it declares itself a **host**, locally. no other machine decides its role.

- **client** (the default) only submits work: messages, blob transfers, `spawn_session` on hosts, cloud pods. its
  daemon:
  - never starts the presence or usage samplers
  - shares no presence (host activity, home sensors, gpu load, foreground app) and no account usage
  - accepts no session launches
  - doesn't broadcast its sessions' status over mdns
  its sessions stay reachable, so replies work.
- **host** shares presence and usage, accepts launches per its launch policy (`sessions configure`), and counts
  toward presence coverage. set it with `agentbus lan role host` and restart the daemon, or join with
  `lan join --host`. `lan invite --host` makes an invite that says `AGENTBUS_ROLE=host`. cloud pods join as hosts.

every inventory answer carries the role. a peer that doesn't say `host` is a client, including builds older than this
feature, so an old peer's presence and usage are dropped. host history records which machines are hosts. only hosts
count toward presence coverage, so a client leaving never makes `any host active` unknown. `agentbus lan role` prints
this machine's role.

### host cost (pick a host by fit and price)

every host may advertise what an hour of its gpu costs, set by its owner in `~/.agentbus/lan/config.json`:

```json
{ "gpu_cost_per_hour": 0, "billing": "owned" }
{ "gpu_cost_per_hour": 2.89, "billing": "runpod secure cloud on-demand" }
```

or `agentbus lan cost --cost-per-hour 0 --billing owned` (`--clear` removes it). `gpu_cost_per_hour` is usd per hour, a
non-negative number. `billing` is a short label of up to 48 characters. owned hardware says `0` and `owned`. a host without the
field is **unknown**: it is shown as `cost unknown` and never read as free. the running daemon re-reads the price every poll,
so no restart is needed. an invalid value makes `lan serve` refuse to start. the price rides in the mdns txt record
(`gpu_cost`, `billing`), in authenticated inventory (`capabilities.gpu_cost_per_hour`, `capabilities.billing`), in
`lan status`, and as a hardware line per host in `host_status` and `list_agents`:

```
winbox hardware: 16303MiB cuda (NVIDIA GeForce RTX 5070 Ti, sm 12.0), $0/h owned
mac-mini hardware: 16384MiB unified metal (Apple M6), $0/h owned
runpod-h100 hardware: 81559MiB cuda (NVIDIA H100 80GB HBM3, sm 9.0), $3.99/h runpod secure cloud on-demand
```

apple gpus report their unified memory as the machine's ram size (`16384MiB unified`), so it compares directly with a
discrete card's vram. remember that the os and other apps share that pool. a submitter picks the free local box when the job fits, and a rented
80 gb pod ([docs/runpod.md](docs/runpod.md)) when it does not.

cpu information comes from node's os interfaces. mac gpu information comes from `system_profiler`; linux uses `nvidia-smi`, falling back to `lspci`. gpu support describes detected hardware/driver capabilities, not installed python/ml packages or measured throughput. full hardware detail is available in `lan status` and remote agents returned by `list_agents`. unavailable fields are marked unknown.

claude code's registry often omits its configured model. agentbus uses it when present, otherwise reports the latest response model with `model_source=last_response`; that is not proof of the current configuration. codex reports its recorded configured model. client types are `claude-code`, `claude-desktop` when explicitly identified by a compatible registry, `claude-unknown`, or `codex`. standalone claude desktop conversations without a compatible session/socket registry are not discoverable or routable through this adapter.

first host (the always-on sms primary):

```sh
node bin/agentbus.mjs lan init --name mac --sms-primary self
node bin/agentbus.mjs lan install       # macos launchagent / windows logon task, starts now and at login
node bin/agentbus.mjs lan status
```

`lan init` prints the stable host id and pairing-key **path**, never the key. securely copy `~/.agentbus/lan/key` to the other machine, then initialize it with that key and the primary's host id:

```sh
node bin/agentbus.mjs lan init --name workstation --key-file /secure/path/agentbus-key --sms-primary PRIMARY_HOST_UUID
node bin/agentbus.mjs lan serve         # foreground; use lan install on macos/windows
node bin/agentbus.mjs list --json
node bin/agentbus.mjs send 'lan:HOST_UUID/codex:THREAD_UUID' 'message' --from 'codex:LOCAL_THREAD_UUID'
```

`list_agents` and the cli list merge local sessions with authenticated remote inventory. names show `@host`; full `lan:<host-uuid>/<agent-id>` addressing is unambiguous and preserved in reply hints. remote delivery reuses the receiving host's claude socket or codex push bridge/inbox. accepted, queued and uncertain outcomes remain distinct. no automatic retransmission follows a potentially accepted request. receipts survive daemon restarts; a repeated message id returns its stored result, and changed payloads with the same id are rejected.

`lan init` also accepts `--bind PRIVATE_IPV4`, `--port PORT` and `--mdns-interface ADAPTER|IPV4` (defaults to `--bind` when that is set; see windows); default bind is all ipv4 interfaces and the default port is assigned by the os. the firewall must permit multicast udp 5353 and the selected tcp port. use a fixed port if your firewall requires one. vlan isolation, guest wifi and multicast filtering can prevent discovery. ipv6-only networks and routed discovery are not supported in this version. remote idle subscriptions (`when=idle`, `notify_when_idle`) are explicitly rejected; immediate sends and replies work.

`lan stop` unloads and removes the macos launchagent (windows: the logon task) but retains config, key and receipts. on linux run `lan serve` under your service manager. existing mcp processes need a reload/new session to use the extended tool code. the lan daemon itself does not require restarting the codex desktop app.

## wan peers over tailscale (remote machines, large job files)

a machine outside the lan joins the same psk group over tailscale. nothing is exposed to the
internet and no router ports are forwarded: tailscale handles nat traversal, and agentbus binds
only to lan or tailscale (100.64.0.0/10) addresses. a joined peer is a full member of the trust
group, like any lan host, so invite only machines you trust that way. joiners get no sms primary,
so they can't reach claw-messenger.

owner side, once (the host with shared task storage, e.g. the windows box):

1. install tailscale, then `tailscale set --unattended=true` (windows) so it stays up without a
   login. connect the remote user both ways: invite them into your tailnet (simplest), or share
   your machine with them and have them share theirs back. two way reachability is required,
   because the owner dials the joiner back for inventory, replies and launch authorization.
2. the daemon needs a fixed port (`"port": 47800` in `~/.agentbus/lan/config.json`) and a bind
   that includes the tailscale interface (`0.0.0.0`, the default). restart it after changing these.
   on windows, allow that port inbound on the tailscale adapter only:
   `New-NetFirewallRule -DisplayName 'agentbus (tailscale)' -Direction Inbound -Protocol TCP -LocalPort 47800 -InterfaceAlias Tailscale -Action Allow`
3. sessions for remote jobs start in fresh `tasks/<uuid>` folders. claude code inherits workspace trust
   from a parent folder, so open claude code once in the storage root and accept trust. without that,
   background claude launches there fail as untrusted. launching must also allow remote requests and
   include that root (`agentbus sessions configure --root <storage root> --remote`).
4. print the setup message and send it to the remote person through a private channel. it contains
   the group key:
   ```sh
   agentbus lan invite --repo https://github.com/OWNER/agentbus --peer self=100.x.y.z --name their-machine
   ```
   `--peer NAME=ADDRESS[:PORT]` can repeat for other group hosts they can reach. add
   `--tailscale-authkey tskey-auth-...` (single use, pre-approved, not ephemeral, short expiry; or env `TS_AUTHKEY`)
   and the message also joins their machine to your tailnet: no tailscale account, invite or share needed on their side. the command refuses
   to print anything containing a phone number, email address or local secret.

the invite is a short block: a link to [docs/join.md](docs/join.md) (the generic setup steps) plus the
secret values (name, peer, join token, optional tailscale auth key). the joiner pastes it into claude code,
which follows the doc: `lan join`, `lan install`, mcp registration, `lan doctor`. auth keys last at most 90
days, but only until first use. the joined device then lives on its node key (180 days by default), so for a
long-lived peer, open the admin console machines page and choose disable key expiry on the new device. `lan join` binds only to the joiner's tailscale address, disables
multicast, and configures the owner as a static peer. the owner learns the joiner's address from its
first authenticated request and dials back. no manual peer entry is needed on the owner.

moving files: `agentbus blob put|get|stat|purge` streams over the same tls-psk link straight to
the storage owner's `tasks/<uuid>/{in,out}`. it never mirrors the share and doesn't use smb.
uploads and downloads resume and are sha256 verified on both ends. the workflow for jobs is in
[docs/remote-jobs.md](docs/remote-jobs.md).

### on-demand cloud pods

a provisioner host (`~/.agentbus/cloud/`) offers rented gpu pods to the whole group. peers call `cloud_status`,
`cloud_up` (a `max_hours` or `max_usd` hard cap is required) and `cloud_down`, or the `agentbus cloud` cli. the
provisioner holds the provider and tailscale keys and enforces the cap and a 15 minute idle rule. before termination it
purges fetched task folders from the pod's volume. a live pod is an ordinary peer that every host dials directly. see
[docs/cloud.md](docs/cloud.md).

### userspace tailscale (containers without /dev/net/tun)

cloud containers such as runpod pods have no tun device, so `tailscaled --tun=userspace-networking` runs there and the
node has no 100.x interface to bind. `lan join --userspace-tailscale` is the opt-in for that case:

- **bind 127.0.0.1.** tailscaled's netstack redials inbound tailnet tcp for the node's own tailscale ip to `127.0.0.1` on
  the same port. this is `acceptTCP` in `wgengine/netstack/netstack.go`. the kb doesn't document it, so loopback is enough and nothing listens on the pod's other interfaces.
- **dial out through tailscaled's socks5 proxy.** that is `--socks5-server`, default `127.0.0.1:1055`, set with `--socks5`.
  every peer connection, blob transfer and doctor probe uses it. loopback peers stay direct.
- **advertise the tailscale ip.** `tailscale ip -4` is read at join, or passed with `--advertise-address`. it is sent with each
  inventory request, and the owner dials that address back instead of the tcp source. only a 100.64/10 address is accepted.
- **`--ephemeral`** marks a rented host. peers never write it to host history, so a terminated pod does not
  leave presence coverage partial. a silent ephemeral peer is dropped after a minute, other learned peers after ten.

config fields: `"userspaceTailscale": true`, `"socks5"`, `"advertiseAddress"`, `"ephemeral"`. a host without them behaves
exactly as before. `lan doctor` checks `tailscale ip -4` and the socks5 listener instead of a tailscale interface.
`lan forget-host` now also removes a dead learned peer from the live table, not only from history.

other commands: `lan peer list|add|remove` (static peers, picked up without a restart), `lan doctor`
(reachability, authentication, reach back, a 4 MiB blob round trip), `lan init --peer ... --no-mdns`.

## one sms authority across the lan

this mac is pinned as sms primary via its stable host id. every follower config points at that same id. discovery advertises the role, and authenticated inventory confirms it; discovery does not elect or promote another primary. if this mac is unreachable, followers fail closed. this avoids split-brain locks during network partitions. an intentional future promotion would require stopping/fencing the former primary and migrating its durable lock/deduplication state, not just choosing the highest mdns priority.

only the primary runs the claw-messenger relay daemon and holds the relay credential. followers run the same `claw-messenger/mcp.mjs`; their client forwards permitted operations through agentbus to the primary. locks remain in the primary's existing lock table with holder ids like `lan:<host>/<codex-or-claude-id>`. acquisition and send reservation remain atomic in that daemon. remote acquisitions require fresh authenticated session discovery. a lost peer does **not** release its existing lock: expiry or explicit release does. remote renewal, release, send and signals while holding a lock require the current `leaseId`, obtained from the lock result or `claw_messenger_locks`; stale generations are rejected.

sms request ids are namespaced by host and session before reaching the relay's durable deduplication store. phone replies travel through the primary to the remote lock holder. an unavailable remote holder leaves the reply in the primary's durable inbox; uncertain pushes are not automatically repeated. the existing default operator route is untouched and resumes when the lease ends. remote clients cannot pair numbers, change the default route, switch the global service, or force another agent's lock. existing per-message service selection remains available. configured followers refuse to start a second local claw relay daemon.

private state is under `~/.agentbus/lan/`: config, key, private unix socket, delivery receipts, authenticated session snapshot and daemon log. `~/.claw-messenger/` remains the sms authority's existing state directory. after upgrading a running claw daemon, reload it once to activate host-qualified locks. no actual phone messages are sent by the tests.

validation (the optional multicast check announces isolated test services on the local lan):

```sh
npm test
AGENTBUS_TEST_MDNS=1 AGENTBUS_TEST_CODEX=/absolute/path/to/codex npm test
```

references: [bonjour-service](https://github.com/onlxltd/bonjour-service), [node tls pre-shared keys](https://nodejs.org/api/tls.html#pre-shared-keys).

## caveats, read these

- **inbound hold on the claude side.** claude decides whether to deliver or hold a peer message by comparing permission classes. a bypass-permissions receiver holds mail from senders it can't classify (anything from codex) and shows an approval dialog. set `"crossSessionInbound": "accept"` in `~/.claude/settings.json` for unattended use. the socket is `0600` to your uid, that's the only auth then.
- **reply addressing.** a claude receiving a codex message is told by claude code to reply to the `from` attribute with its native `SendMessage`; that fails for non-claude senders. the message body says to use `agentbus send_message` instead, which works.
- **codex liveness is per thread, not per window.** the lock probe says "loaded in some codex process". a thread you closed in the ui but codex kept loaded still lists. `status=unknown` until the hook has seen an event from it.
- **python3 is shelled out** for `flock` (macos/linux, ~30ms each). sqlite reads use node's built-in `node:sqlite` and fall back to python only where it is missing.
- codex `UserPromptSubmit` hooks fire *before* the prompt goes to the model, so mail queued during idle is read together with the user's next prompt.

## state

```
~/.agentbus/
  inbox/<codex-thread-id>/<ts>-<uuid>.json   pending mail for codex threads
  codex-sessions/<thread-id>.json            hook-recorded {pid,cwd,model,last_event}
  bridges/<pid>-<nonce>.sock                private socket for each wrapped app-server (windows: marker naming its pipe)
  bridges/<pid>-<nonce>.state.json          loaded threads + active turns that bridge observed
  bridge-config.json                        real codex executable + previous launcher override
  codex-bridge                              launcher shim using an absolute node path
  presence.json                             latest daemon presence sample + verdict (raw.jobs: live claimed launches at that tick)
  presence-override.json                    manual busy/available override (agentbus busy|available|auto)
```

## not done / ideas

- register codex threads as fake claude peers (`~/.claude/sessions/<pid>.json` + a socket agentbus owns) so claude's native `/list-agents` shows them and native `SendMessage` routes through the bus. nice, but the registry format is undocumented and version-gated.
- when openai ships `agent_message_board` (feature flag exists, "under development"), swap the codex file inbox for it.
- opencode support, if you ever run it.

### session launching (macos and windows)

`spawn_session`, `session_launch_status` and `stop_spawned_session` are MCP tools. reload the MCP connection to see newly added tools. the CLI is available immediately:

```sh
agentbus sessions configure --root /absolute/project/root --root /absolute/shared/tasks --remote --max 4
agentbus sessions capabilities
agentbus sessions spawn --runtime codex --cwd /absolute/project --name worker --id <request-uuid> 'the task'
agentbus sessions spawn --runtime claude-code --host winbox --from codex:<your-thread-id> --cwd 'D:\AgentbusTasks' --id <request-uuid> 'the task'
agentbus sessions spawn --runtime claude-code --host winbox --from codex:<your-thread-id> --cwd 'D:\AgentbusTasks' --claim gpu --id <request-uuid> 'the gpu job'   # winbox publishes compute=true / gpu=avoid while it works
agentbus sessions status <request-uuid> --host winbox --from codex:<your-thread-id>
agentbus sessions stop <request-uuid> --host winbox --from codex:<your-thread-id>
agentbus sessions reconcile [--close <request-uuid>]   # local host owner: list/close stale receipts that hold no slot
```

configuration is local to each destination, stored in `~/.agentbus/launch-config.json`. launching is disabled until configured. `--remote` permits authenticated peers with a live sending session to request launches; omitting it permits local launches only. `--codex` and `--claude` accept absolute native executable paths if discovery fails. on windows use `codex.exe` from the npm platform package, not `codex.cmd` or a powershell shim. the receiving user must already have native runtime credentials. no credentials are transferred by spawn.

- **codex:** creates a thread in an owned stdio app-server with `workspace-write` sandbox and `never` approval policy (requests requiring approval cannot be approved by this worker). the worker remains alive for idle wakeup and active steering through the existing bridge. stop it explicitly when finished. this does not modify the windows desktop app or replace its contained core. status includes the last completed assistant message and turn status. the requested model is optional; otherwise the configured model applies.
- **claude code:** uses native `claude --bg`, the native launcher's reported job ID resolved to its actual session UUID, optional model/name, and the destination's normal trust/permission settings. untrusted workspaces fail with the native diagnostic; accept trust interactively before retrying with a new request UUID. background support requires a CLI exposing `--bg`. inbox messaging still requires the receiving agentbus MCP relay.
- **claude desktop:** opens the Code composer through the [documented deep link](https://support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link), with workspace and task prefilled. **this is a user handoff, not autonomous execution.** the user must confirm the folder and send the prompt. receipts return `awaiting_user`, no agent ID, and `routable: false`. model/name overrides are rejected because this handoff uses app settings. installed Claude Code 2.1.296 rejects a prompt, `--session-id`, and `--name` with `--desktop`; no workaround changes permissions or submits the UI. normal desktop Chat/Cowork sessions are not supported by the Code inbox adapter. a Code-tab session is routable only if it exposes the compatible native registry and authenticated MCP relay; verify with `list_agents` after starting it.

`cwd` is a path on the **destination** host. shared-storage IDs can identify the same volume, but its mac and windows paths differ. allowed roots are canonicalized; sibling-prefix and symlink escapes are rejected. roots limit where sessions start, not every resource they can access: runtime sandbox/permissions remain responsible for tool access. check host presence before assigning heavy work. a writable shared workspace also lets trusted peers supply project instructions/configuration; only allow roots whose contributors you trust.

launch receipts are persisted before process creation. reuse the **same request UUID and unchanged parameters** after a timeout; the destination returns its existing receipt rather than spawning again. `starting`/`awaiting_registration` is not a delivery guarantee: poll for `deliveryReady: true`, then verify task completion; `routable` only means discovered. inspect reported native errors. uncertain launches consume the configured concurrency limit until inspected/stopped. receipts survive daemon restarts; active codex workers are separate processes and are not silently respawned. a stale `launches/launch.lock` after a process crash fails closed; inspect its recorded PID and receipts before removing that lock. every receipt write (the initial intent and each worker update) goes to a temp file, is fsynced and renamed into place, so a crash mid-write cannot leave a half-written or zero-filled file. a receipt that is nevertheless unparseable is reported as state `corrupt` with its path for that id only. if it was last written before the current boot (ntfs zero fill after a hard reset on an older build) no worker can have survived, so the launcher moves it aside itself (`<name>.json.corrupt-<timestamp>`), releases the slot and reports where it went; one written since boot holds its session slot and is left in place: inspect the native runtime for a surviving process, then rename it aside the same way. never automatically use a new UUID to retry an uncertain launch. remote status/stop operations are scoped to the original sending host/session.

#### crash-looping claude-code launches

`claude agents --json` reports a background job as `working` even while its worker crash-loops before
the session registers. it has no pid, and nothing in the inventory shows the crash. once a job has gone
30s without registering, the supervisor samples its live terminal output (`claude logs <id>`) every 15s.
crash lines (signals, exit 137/139, oom, respawn) put the launch in `state: crashing`, with `crash.evidence`,
`crash.lastExitCode`, `crash.respawns`, `nativeLogTail` and an error. status then reports `ok: false`. after
90s without registering and without crash lines, the launch gets `stall` and the log tail instead. a crashing
launch keeps its session slot and is never killed or restarted automatically. stop it to release the slot.
registering later clears both markers. claude's daemon serves those logs only while the job exists, so
afterwards the evidence lives in the launch receipt.

### destination-owned codex permission profiles

codex launches without a profile explicitly use `workspace-write`, approval policy `never`, no additional writable roots, and command network access off. a sender cannot pass arbitrary native config, sandbox overrides, or writable roots. a named profile must already exist in the destination's `launch-config.json`; only local host configuration can create it.

`agentbus sessions configure ... --profiles-file profiles.json` accepts a JSON object keyed by profile name. each profile requires `workspaces` (within the host's launch roots), `allowedSources` (exact `local/codex:THREAD` or authenticated `HOST_UUID/codex:THREAD` identities), and `sandbox` (`workspace-write` or `danger-full-access`). `workspace-write` may additionally declare `writableRoots`, which are canonical existing directories; command networking remains disabled. `danger-full-access` explicitly grants native unrestricted filesystem/network access and cannot misleadingly declare limited write roots. native/managed requirements still apply. there is no wildcard sender grant and no implicit profile selection.

select with `spawn_session(permission_profile="profile-name", from="codex:THREAD", ...)` or `agentbus sessions spawn --runtime codex --cwd /project --permission-profile profile-name --from codex:THREAD --id UUID --prompt-file /path/task.txt`. existing MCP processes need a tool reload for the new optional argument; the CLI uses current files without restarting the desktop. remote hosts must install this version before selecting profiles.

profile contents are frozen in the launch receipt and rechecked before starting the native runtime. changed/revoked grants or changed canonical roots fail closed. native effective permissions are checked before the first model turn and returned by launch status. changing a profile never reconfigures an existing worker. retrying a request UUID with a different profile or profile sender is rejected. scoped network domain profiles are deliberately unsupported here: native configuration merges domain tables with inherited settings, so a table override alone cannot prove an isolated allowlist.

### reliability release 0.5

launch status now separates `routable` (discovered), `deliveryReady` (a fresh
owning bridge or authenticated relay registration), native lifecycle, and actual
turn completion. registration alone does not prove that a task ran. loaded codex
threads publish their cwd/model before their first prompt, and opening a thread
no longer consumes queued mail without executing a turn. unowned threads are
never resumed in an arbitrary process. windows desktop without an owning bridge
reports `native-queue` when the configured fallback verifies support, otherwise `hook-only`; owned background app-server workers can wake idle.

claude supervisors remain alive to reconcile `agents --json --all`. pidless
`done`/`stopped` jobs or confirmed removed jobs release quota; pidless `blocked`
jobs retain it. `done` with a pid is an idle, still-live session. old receipts use
the same reconciliation after registration grace. stop uses the recorded native
job id even if discovery misses it, and reports termination only after native
verification. status includes the effective `cwd`; native claude background jobs may use a worktree below the requested workspace. a stop received during background launch waits for its native job
id. unknown/orphaned ownership remains explicit uncertainty instead of a false
success. inspect the same receipt rather than retrying with a new launch id.

windows state replacements retry transient sharing violations without deleting the
previous complete file. receipt persistence failures keep the native supervisor
alive and retry the latest state; terminal cleanup does not silently exit before
its terminal receipt is written. temporary files are unique per write. access
restriction replaces the complete DACL (including explicit foreign grants), and
validation uses the process SID with Unicode-safe UTF16 parsing rather than
localized account names.

windows cleanup pins native process handles, validates the supervisor relationship
and exact creation time, terminates captured descendants, and rescans for late
forks. it does not parse localized `taskkill` errors or certify from leader absence
alone. this verifies the captured process graph, not job-object containment: a
process that forks and disappears entirely between scans can evade ancestry
reconstruction. an already exited leader or an inaccessible live descendant
remains unconfirmed; no unrelated process is adopted by pid.

runtime probes are asynchronous, deduplicate concurrent requests, refresh after
60 seconds on success or 3 seconds on failure, and invalidate when the executable
changes. inventory returns `null`/`probing` during refresh; explicit
`agentbus sessions capabilities` waits for the bounded probe. launch lock
contention retries for a bounded period with the original request id.

### native codex queue fallback

an optional `~/.agentbus/native-queue-config.json` enables the experimental native
queue API for persisted threads without an owning agentbus bridge:

```json
{"enabled": true, "binary": "/absolute/path/to/the/owning/codex"}
```

use the same native executable as the desktop owner. on windows, discovery's
`ownerBinary` reports the registered executable under the user's local app data;
the globally installed npm runtime may be a different version. a known owner
binary mismatch disables this fallback. the bridge remains the preferred route.

agentbus verifies the executable's native schema, initializes with experimental
API support, and uses only `thread/queue/list` and `thread/queue/add`. helpers are
serialized per host and never resume a thread, create one, or override its model,
permissions, or approval policy. readiness probes run asynchronously in bounded
batches. successful queue acknowledgement returns `delivery: queued`, a native
`queueId`, and the original bus message id; execution still needs a reply or turn
evidence. ambiguous acknowledgement is retained for inspection and never retried
through hooks. explicit rejection falls back to the durable hook inbox.

isolated tests with codex `0.162.0-alpha.17.2` verified that the owning process
drains a foreign client's queue submission while idle and after its active turn.
windows desktop application drain remains separately unverified. untouched
windows desktop threads have no rollout and reject the native queue API: they
are discoverable through validated lock owners but need their first user turn.
agentbus does not access the desktop's private tool pipe or modify its databases.

### layered presence

host idleness remains separate from home occupancy. `host_status`, CLI presence,
and authenticated LAN inventory expose `host_activity` and `home`; neither
motion nor occupancy identifies a particular person. home occupancy never
changes the GPU scheduling verdict or overrides an explicit busy setting.

`host_status` and `agentbus presence --json` also return `networkPresence`:

- `anyHostActive`: `true` if any fresh host is active; `false` only when all known
  hosts have fresh idle observations and LAN inventory is available; otherwise
  `null`. an idle windows host cannot override an active mac.
- `homeOccupancy` / `homeMotion`: independent `occupied` / `detected`,
  `not_detected`, or `unknown` aggregates. a positive fresh sensor observation
  wins; a negative requires usable negative readings from every enabled source.
  hosts with the adapter disabled do not dilute another host's sensor data.
- `sources`: host names/ids, host observation timestamps and freshness, plus home
  observation/check timestamps and status. unavailable or stale hosts remain in
  aggregate coverage even when omitted from the fresh per-host list. authenticated host identities persist
  across discovery loss and daemon restarts in `~/.agentbus/lan/known-hosts.json`.
  they supply no routes or fresh activity. a missing host stays unknown without
  a silent expiry; `agentbus lan forget-host <uuid>` explicitly retires an offline
  host. live authenticated hosts cannot be retired. the registry holds at most
  256 identities; corruption, write failure, or overflow makes coverage partial
  rather than treating missing evidence as absence.
  each entry also keeps `link`: `wan` when the host last authenticated over an overlay
  (tailscale `100.64.0.0/10`) address, `lan` over a private one, absent when the address
  is anything else (a hostname). the address itself is never stored or shared; a move
  between lan and wan is saved at once rather than on the once-a-minute refresh.
  each peer also shares its own registry (`hostId`, `name`, `lastAuthenticatedAt`, and
  `link` when known; nothing else about any remote host) over authenticated inventory when it
  advertises `build.features` `shared-known-hosts-v1`; `lan status` shows it as
  `peers[].knownHosts`. it is that peer's claim, never merged into the local
  registry or coverage. a wan joiner that peers only with the storage owner shows
  its recent contact, and how that owner reaches it, there. older peers send no `link`. `null` means the peer runs an older build.
- `hostCoverage`: `complete` or `partial`; `scope` is always
  `not_person_identity`. neither inactivity nor missing occupancy proves that
  a particular person is away. home observations expire on their own sensor TTL,
  independently of the 30-second host activity freshness window.

optional read-only HomeClaw integration:

```sh
agentbus home-presence configure /absolute/path/home-presence.json
agentbus home-presence status
agentbus home-presence disable
```

configuration contains `enabled: true` and `sensors: ["accessory-uuid", ...]`.
up to eight explicit accessories are read via the installed HomeClaw CLI. optional
`cli`, `pollMs`, `maxAgeMs`, and `timeoutMs` are bounded. the default poll interval
is 30 seconds, observation lifetime 120 seconds, timeout 5 seconds. successful
per-characteristic read timestamps are required. failed, stale, or unreachable
readings become unknown, never evidence of absence. occupancy and motion are
independent fields. no home data enters multicast advertisements and no accessory
state or webhook configuration is changed. reload the LAN daemon after upgrading
code; configuration changes apply on its next poll.

### deployment verification and smoke tests

`agentbus build-info` reports the version and runtime source hash captured when
the process loaded. `--manifest` returns per-file hashes for deployment checks.
authenticated LAN capabilities include each daemon's build and native runtime
probe versions; launch receipts also expose each new worker’s loaded build. a running old daemon cannot claim the new on-disk hash. compare
both hosts before calling an upgrade complete. preserve each host's working tree
and state/config outside the release bundle; stage source, run tests, then
restart only its LAN service. detached workers and desktop bridges continue on
their loaded code until individually stopped or their owning app is restarted.
never kill unrelated workers to deploy. on windows `lan stop` kills the runner
loop and the daemon's own children by (pid, creation time), never `taskkill /t`:
session-worker supervisors name the daemon as parent but are left running (listed
as `spared`), so claimed jobs keep refreshing their receipts across a restart.

normal `npm test` uses isolated fake native runtimes and never invokes a model.
optional native tests remain available through `AGENTBUS_TEST_CODEX`; windows
permission fixtures configure their own disposable native sandbox. production
launches reject unexpected effective permissions, including a runtime that
silently narrows workspace-write to read-only because its windows sandbox is
unconfigured. agentbus does not rewrite the user's sandbox configuration. an explicit
live smoke command performs paid model turns and saves a durable result:

```sh
agentbus session-smoke --runtime codex --host winbox --cwd 'D:\AgentbusTasks\agentbus-smoke' --from codex:YOUR_THREAD_UUID --report /absolute/path/smoke.json
```

use a dedicated existing trusted destination workspace. for remote claude-code,
add `--evidence-dir /local/mount/agentbus-smoke` pointing at that same workspace.
the runner verifies a unique boot acknowledgement, observes idle, sends a second
nonce, verifies execution, and stops only its own launch receipt. reuse the
report to inspect a prior result; uncertain messages are never resent. launch
request ids and parameters remain stable after interrupted runs. a failed or
incomplete cleanup is an explicit test failure, not a silent orphan.


### account usage alongside presence

call `host_status` first when beginning to use agentbus, and recheck before substantial
session delegation or heavy work. `agentbus presence --json` (alias `host-status`)
exposes the same data. each host has `usage.providers.claude` and `.codex` alongside
its `presence`. this is subscription quota utilization, not token totals or API billing.

- windows report `usedPercent`, `remainingPercent`, `windowMinutes`, and `resetsAt`
  (unix **milliseconds**). retain the provider bucket id, including model-specific
  weekly buckets. never assume primary means 5h: use the actual duration.
- provider observations include `status`, `source`, `checkedAt`, `observedAt`,
  `ageMs`, `maxAgeMs`, `nextCheckAt`, and a bounded error code. missing limits remain
  unknown, not zero. stale or reset-expired observations are explicitly marked.
- quotas belong to accounts, **not machines or sessions**. the same account on two
  hosts shares a budget. do not add percentages or infer independent capacity;
  no account identity or credentials are advertised.
- the LAN daemon refreshes asynchronously, at most once per five minutes per
  provider on each host. the first local status read can fetch an uncached sample.
  a shared cache/lock prevents concurrent local callers from stampeding providers.
  failures back off exponentially (up to an hour), respecting retry-after up to a
  day, and preserve last successful evidence with its original timestamp. cached
  observations older than ten minutes are stale; no forced refresh flag bypasses
  provider backoff. cache: `~/.agentbus/usage.json` (normalized fields only).
- only authenticated LAN inventory carries quota data, never mDNS advertisements.
  older peers without this feature show unknown usage. a rolling MCP upgrade
  requires reconnecting clients for new tool descriptions; restart the LAN daemon
  to advertise refreshed account usage. active work sessions need not restart.

codex uses the native [app-server account/rateLimits/read](https://learn.chatgpt.com/docs/app-server)
interface. it does not start an inference turn or redeem reset credits. claude uses
its existing local subscription login to read the usage endpoint used by the installed
usage plugin. provider errors never expose credentials or response bodies.

windows presence distinguishes shell notification state from measured fullscreen:
`QUNS_BUSY` alone is ambiguous, so it limits availability to `shared` (ask before
heavy work), without claiming a fullscreen app. `QUNS_APP` alone is not fullscreen.
exclusive D3D fullscreen, or foreground monitor coverage by a process not on the
non-game list, means `avoid` even at 0% GPU utilization. coverage by a listed
non-game app (browser, video player, office) and explicit presentation mode mean
`busy` + `shared`; presentation is labeled presentation rather than fullscreen. explicit user overrides and
sustained GPU-load checks retain their existing precedence. sanitized presence
includes `shellState`, `fullscreenBasis`, `foregroundCoversMonitor`, `foreground`,
`foregroundPid`, and `probeObservedAt`; text output shows sample age. this is a
classification correction, not proof of what caused any historical notification
state. see [Microsoft's state definitions](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/ne-shellapi-query_user_notification_state).


### compact message context

startup introduces agentbus, the caller id, `list_agents` for the roster and
`host_status` for presence/usage; it does not inject the roster. reply conventions
live in MCP instructions rather than every message. native message envelopes keep
their exact sender ids and compatibility attributes, without repeated reply
footers. hook/inbox output avoids duplicating sender headers already present in
an envelope; older unwrapped records retain a sender header. stored receipts,
status output and delivery certainty are unchanged. reconnect existing MCP
clients to load changed handlers and instructions.
