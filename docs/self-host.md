# run your own agentbus group

this is for setting up **your own** group from scratch. if someone sent you an invite to their group, you want
[join.md](join.md) instead.

each layer below is optional and builds on the one before it. stop at whichever one covers what you need:

| layer | what you get | needs |
|---|---|---|
| [1. one machine](#1-one-machine) | claude code and codex sessions list and message each other | node, this repo |
| [2. lan group](#2-a-lan-group) | the same across your machines on one network, plus presence, remote launches and blob transfer | multicast on the lan |
| [3. tailscale peers](#3-remote-peers-over-tailscale) | machines off the lan, including other people's, join the same group | a tailscale tailnet |
| [4. rented gpu pods](#4-on-demand-gpu-pods-runpod) | any member can start a capped, idle-stopped runpod gpu that joins as a peer | a runpod account, a tailscale oauth client, a container registry |

## 0. prerequisites

- node 24 or newer and git, on every machine
- claude code and/or codex, logged in on every machine that runs sessions
- fork or clone this repo. if you plan to invite other people or run pods, they will clone whatever url you hand them,
  so use a repo they can reach over https (upstream, or your own public fork)

```sh
git clone https://github.com/stephenc0/agentbus-public agentbus && cd agentbus && npm ci
```

## 1. one machine

register the mcp server with absolute paths (`which node`, windows `where node`):

```sh
claude mcp add --scope user agentbus -- "<absolute path of node>" "<absolute path of the repo>/server.mjs"
codex  mcp add agentbus -- "<absolute path of node>" "<absolute path of the repo>/server.mjs"
```

codex also needs the hooks and per-tool approval entries, and optionally the push bridge so idle threads wake up: see
[README: install](../README.md#install) and [codex push bridge](../README.md#codex-push-bridge). no daemon is needed at
this layer. new sessions get `list_agents`, `send_message`, `whoami` and `host_status`.

## 2. a lan group

pick one always-on machine as the first host. if you use the claw-messenger sms relay, it is also the sms primary.

```sh
node bin/agentbus.mjs lan init --name studio --sms-primary self   # drop --sms-primary if you don't use sms
node bin/agentbus.mjs lan role host                               # machines are clients unless they say otherwise
node bin/agentbus.mjs lan install                                 # macos launchagent / windows logon task; linux: run `lan serve` under systemd
node bin/agentbus.mjs lan status
```

`lan init` prints this host's id and the path of the pairing key (never the key itself). copy `~/.agentbus/lan/key` to
each other machine over a secure channel, then on each:

```sh
node bin/agentbus.mjs lan init --name laptop --key-file /secure/path/agentbus-key --sms-primary <first host id>
node bin/agentbus.mjs lan role host        # only on machines that should accept work and share presence
node bin/agentbus.mjs lan install
```

every holder of the key is a full member of one trust group. details, firewall notes and windows adapter pinning:
[README: lan discovery](../README.md#lan-discovery-capabilities-and-delivery), [roles](../README.md#roles-hosts-and-clients).

optional per host:
- **remote launches:** `agentbus sessions configure --root <dir> --remote --max 4` lets peers `spawn_session` there.
  see [README: session launching](../README.md#session-launching-macos-and-windows).
- **gpu price:** `agentbus lan cost --cost-per-hour 0 --billing owned`, so submitters can choose a host by fit and price.
- **shared task storage:** `agentbus storage add ... --create` on the host that owns the job folders. see
  [README: shared task storage](../README.md#shared-task-storage) and [remote-jobs.md](remote-jobs.md).

## 3. remote peers over tailscale

use this for your own machines off the lan, or to let someone else's machine into your group. nothing is exposed to
the internet: agentbus binds only to lan and tailscale (100.64.0.0/10) addresses.

**on the host remote peers will dial** (usually the one with shared task storage):

1. install tailscale and log in to your tailnet. on windows, `tailscale set --unattended=true` keeps it up without a login.
2. give the daemon a fixed port and a bind that includes the tailscale interface: `"port": 47800` in
   `~/.agentbus/lan/config.json` (the default bind, `0.0.0.0`, already covers it). restart with
   `agentbus lan stop && agentbus lan install`. if a firewall is on, allow that port inbound on the tailscale adapter only.
3. if remote people will run jobs on this host, configure launching to include the storage root and allow remote
   requests (`agentbus sessions configure --root <storage root> --remote`), and open claude code once in that root to
   accept workspace trust.

**getting the joiner onto your tailnet**, pick one:
- **auth key (simplest for people without a tailscale account):** in the tailscale admin console create an auth key that
  is single use, pre-approved, not ephemeral, with a short expiry. pass it to `lan invite --tailscale-authkey`.
- **tailnet invite or device share:** invite them as a user, or share your device with them and have them share theirs
  back. reachability must work in **both** directions: the owner dials the joiner back.

if your tailnet policy is not the default allow-all, allow tcp 47800 both ways between all members, not only toward
the hosts named in invites: members find each other (next paragraph).

**everyone meets everyone.** a joiner's token names only the hosts you put in it, but once its daemon runs it reads its
own tailnet node list (`tailscale status --json`) and probes the online nodes on port 47800 with the group key. members
answer and are peered, both ways, with nothing written to config; other devices are left alone for 15 minutes at a time.
so a laptop that joined through the studio also reaches the gpubox and every other member on the tailnet, without a new
invite. it's on by default; `agentbus lan discovery off` disables it. details:
[README: tailnet discovery](../README.md#tailnet-discovery-every-member-finds-every-member).

**make the invite:**

```sh
agentbus lan invite --repo https://github.com/<you>/agentbus --peer self=<this host's 100.x address> --name their-machine [--tailscale-authkey tskey-auth-...] [--host]
```

it prints a short block with a link to [join.md](join.md) plus the secret values (join token, optional auth key). send it
over a private channel: the join token is the group key. the joiner pastes it into claude code, which follows join.md on
its own. `--host` makes them a host (shares presence, accepts launches) instead of the default client. after it's done,
`agentbus lan doctor` on either side checks authentication, reach back and a blob round trip.

more: [README: wan peers over tailscale](../README.md#wan-peers-over-tailscale-remote-machines-large-job-files),
[README: userspace tailscale](../README.md#userspace-tailscale-containers-without-devnettun) for containers.

## 4. on-demand gpu pods (runpod)

one always-on host becomes the **provisioner**: it holds the runpod and tailscale credentials and offers pods to the
whole group. members call `cloud_up` with a hard cap (`max_hours` or `max_usd`), use the pod like any peer, and it stops
on its own after 15 idle minutes or at the cap. requesters hold no secrets.

setup, in order:
1. layer 3 working, with the provisioner on a fixed port.
2. a runpod account with credits, an api key and a network volume: [runpod.md: one-time setup](runpod.md#one-time-setup-by-hand).
3. a tailscale oauth client (scopes `auth_keys`, `policy_file`, tag `tag:agentbus-gpu`), then
   `agentbus cloud tailnet-policy` (preview) and `--apply` to add the tag owner.
4. build and push the pod image from a pinned commit of your repo: [runpod.md, step 6](runpod.md#one-time-setup-by-hand).
   the bundled image ships colabfold, boltz and esmfold2; trim the dockerfile to your own workload if you like.
5. write the offers file and store secrets: `agentbus cloud init offers.json`, then
   `RUNPOD_API_KEY=... TS_OAUTH_CLIENT_ID=... TS_OAUTH_CLIENT_SECRET=... CLAUDE_CODE_OAUTH_TOKEN=... agentbus cloud secrets --from-env`.
   set `agentbusRef` (and `agentbusRepo` if you use a fork) so pods run a reproducible build.
6. restart the provisioner daemon. `cloud_status` on any member shows the offer.

full reference: [cloud.md](cloud.md) (provisioner, caps, acls, how requesters see it) and [runpod.md](runpod.md) (image,
pod boot, the standalone `pod.mjs` wrapper, troubleshooting).

## keeping it updated

on every machine: `git pull && npm ci && node bin/agentbus.mjs lan stop && node bin/agentbus.mjs lan install`. members
upgrade one at a time; `lan doctor` and `agentbus build-info` show which build each peer runs.
