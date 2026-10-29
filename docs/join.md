# join an agentbus group over tailscale

these instructions are for **claude code on the joining machine**. the group owner sends a short
invite with these values. they are secrets, so never print, log or commit them:

| value | what it is |
|---|---|
| `AGENTBUS_NAME` | this machine's name in the group |
| `AGENTBUS_PEER` | the host to reach, as `name address:port` (a tailscale 100.x address) |
| `AGENTBUS_JOIN_TOKEN` | `agentbus-join-v1:...`, the group key and peer list. it lets the holder into the group |
| `AGENTBUS_PORT` | optional: the port this machine listens on. defaults to 47800 |
| `TS_AUTHKEY` | `tskey-auth-...`, a single use tailscale key. it joins the owner's tailnet with no account or login. it may be absent if the owner set up tailscale access another way |

**first check whether agentbus is already installed** here (`~/.agentbus/lan/config.json`
exists; windows: `%USERPROFILE%\.agentbus\lan\config.json`). if it is, do step 1 and step 2, then follow
[already installed](#already-installed-eg-joined-at-the-owners-place) instead of steps 3 to 6.

work autonomously. stop and ask the human only for things that need their own hands: an os admin
prompt, a macos "allow vpn configuration" prompt, or a password. never print the values above back.
run every command from the repo folder.

## 1. tailscale

1. if tailscale isn't installed:
   - macos: `brew install --cask tailscale-app`. without homebrew, use the standalone installer at
     https://tailscale.com/download/mac. open the Tailscale app once, and the human allows the vpn
     configuration when macos asks.
   - windows: `winget install --id Tailscale.Tailscale -e --accept-source-agreements --accept-package-agreements`.
     the human approves the admin prompt.
   - linux: `curl -fsSL https://tailscale.com/install.sh | sh`
2. if `TS_AUTHKEY` was provided, join with it. the cli is
   `/Applications/Tailscale.app/Contents/MacOS/Tailscale` on macos when `tailscale` isn't on PATH:
   - macos/linux: `tailscale up --auth-key='<TS_AUTHKEY>'` (linux: with sudo)
   - windows: `tailscale up --auth-key=<TS_AUTHKEY> --unattended=true`

   if `tailscale status` shows this machine already logged in to a **different** tailnet, stop and
   ask before switching: joining replaces that login. the key works only once. if `tailscale up`
   rejects it as used or expired, stop and ask the human for a fresh invite.
3. verify: `tailscale status` lists the peer from `AGENTBUS_PEER`, and `tailscale ping <its address>`
   answers. if not, stop and report exactly what failed. nothing else works until this does.

## 2. node and git

`node -v` must be 24 or newer, and `git --version` must work.
- macos: `brew install node git`, or the nodejs.org lts installer plus `xcode-select --install` for git
- windows: `winget install OpenJS.NodeJS.LTS` and `winget install Git.Git`
- linux: nodesource 24.x, plus your distro's git

open a new shell afterwards so PATH updates.

## 3. get the code

clone https://github.com/stephenc0/agentbus-public into `~/agentbus` (windows:
`%USERPROFILE%\agentbus`). if that folder already exists and its `git remote get-url origin` is this repo,
run `git pull` instead. if it's anything else, clone into `~/agentbus-public` and use that. then run
`npm ci` inside it.

## 4. join the group

```sh
node bin/agentbus.mjs lan join '<AGENTBUS_JOIN_TOKEN>' --name '<AGENTBUS_NAME>' --port <AGENTBUS_PORT or 47800>
```

this machine joins as a **client**: it submits work, and it shares no presence (host activity, home sensors, gpu load or
the foreground app) and no account usage. it accepts no session launches, and it doesn't broadcast its sessions' status
on the lan. its sessions can still message peers and get replies. only if the invite has `AGENTBUS_ROLE=host` (a machine
meant to run jobs for others), add `--host`.

you can also set the environment variables `AGENTBUS_JOIN_TOKEN` and `AGENTBUS_NAME` and run
`node bin/agentbus.mjs lan join`. this writes owner only config under `~/.agentbus/lan`, binds only
to this machine's tailscale address, disables lan multicast, and adds the peer. it doesn't print the key.

## 5. start the daemon, now and at every login

```sh
node bin/agentbus.mjs lan install
```

that covers macos (a launchagent) and windows (a logon task). on linux, run `node bin/agentbus.mjs lan serve`
under systemd or another service manager instead.

## 6. register the agentbus tools in claude code

use absolute paths. find node with `which node` (windows: `where node`):

```sh
claude mcp add --scope user agentbus -- "<absolute path of node>" "<absolute path of the repo>/server.mjs"
```

## 7. verify

```sh
node bin/agentbus.mjs lan doctor
```

every line must say `ok`:
- **tcp/authenticated:** tailscale reaches the peer and the join token is right.
- **reach back:** the peer can dial this machine. it needs a two way tailscale connection, which
  the auth key gives automatically. without it, the peer can't accept job launches from here or route
  replies.
- **blob roundtrip:** a 4 MiB upload and download to the peer's task storage works.

if a line fails, follow its `fix:` hint. if it still fails, report the doctor output to the human.

macos: if commands run from claude code fail with `EHOSTUNREACH` or "no route to host" while
`tailscale ping` works, macos local network privacy is blocking the app that launched them. the human
allows it in system settings, under privacy & security, then local network, by turning on Claude
(or the terminal app). the launchd daemon itself isn't affected.

## 8. finish

report the doctor output to the human. tell them to restart claude code so the agentbus tools load.
after the restart, read [remote-jobs.md](remote-jobs.md) and summarize in a few lines how to submit a
job: upload inputs, start a session on the owner, fetch results.

## already installed (e.g. joined at the owner's place)

the machine already belongs to the group, joined on the owner's lan. now it reaches the group
remotely over tailscale. keep its identity: never delete `~/.agentbus` or run `lan init`.

1. find the checkout the daemon runs:
   - macos: the `ProgramArguments` in `~/Library/LaunchAgents/local.agentbus.lan.plist`
   - windows: `%USERPROFILE%\.agentbus\lan\lan-serve.cmd`
   - or: `claude mcp get agentbus`
2. if that checkout's `git remote get-url origin` is https://github.com/stephenc0/agentbus-public, run
   `git pull && npm ci` there and use it. otherwise clone the public repo into a new folder (step 3
   above) and use that one from now on. don't modify the old checkout.
3. from the checkout you're using:
   ```sh
   node bin/agentbus.mjs lan join '<AGENTBUS_JOIN_TOKEN>'
   ```
   because the key matches, this keeps the host id, key and mdns setting, and adds the tailscale peer.
   it pins an os assigned listen port to 47800 and moves a bind address that no longer exists on this
   machine (an old home lan ip) to the tailscale address. it prints what changed.
4. restart the daemon on this checkout and config: `node bin/agentbus.mjs lan stop`, then
   `node bin/agentbus.mjs lan install`
5. if the checkout path changed, re-point the tools: `claude mcp remove agentbus -s user`, then add it as
   in step 6. if `~/.codex/config.toml` or `~/.codex/hooks.json` mention the old path, update it to the
   new one.
6. continue with step 7 (verify) and step 8.

## later

- update: `git pull && npm ci`, then `node bin/agentbus.mjs lan stop` and `node bin/agentbus.mjs lan install` to restart the daemon on the new code
- leave the group: `node bin/agentbus.mjs lan stop`, then delete `~/.agentbus/lan`, and run `tailscale logout`
