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
`%USERPROFILE%\agentbus`). if it already exists, run `git pull` instead. then run `npm ci` inside it.

## 4. join the group

```sh
node bin/agentbus.mjs lan join '<AGENTBUS_JOIN_TOKEN>' --name '<AGENTBUS_NAME>' --port <AGENTBUS_PORT or 47800>
```

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

## 8. finish

report the doctor output to the human. tell them to restart claude code so the agentbus tools load.
after the restart, read [remote-jobs.md](remote-jobs.md) and summarize in a few lines how to submit a
job: upload inputs, start a session on the owner, fetch results.

## later

- update: `git pull && npm ci`, then `node bin/agentbus.mjs lan stop` and `node bin/agentbus.mjs lan install` to restart the daemon on the new code
- leave the group: `node bin/agentbus.mjs lan stop`, then delete `~/.agentbus/lan`, and run `tailscale logout`
