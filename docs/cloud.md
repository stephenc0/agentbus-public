# on-demand cloud gpu pods

one always-on group host, the **provisioner** (`studio` in these examples), offers rented gpu pods such as a runpod h100 80 gb. any
authenticated peer starts one through agentbus, uses it like any other host, and lets it stop. requesters install
nothing, hold no secrets and run no scripts. how the pod itself boots is in [runpod.md](runpod.md).

```
runpod-h100: offer on studio, dormant, 81559MiB cuda (NVIDIA H100 80GB HBM3), $3.99/h, cold start ~9 min, cloud_up needs max_hours or max_usd (owner cap 8h)
runpod-h100: offer on studio, live, 81559MiB cuda (NVIDIA H100 80GB HBM3), $3.99/h, live as peer runpod-h100 (started by laptop), hard stop in 171 min, idle 4 min (stops at 15)
```

these lines appear in `host_status` and `cloud_status` on every host, including while the offer is dormant. a live pod also
shows up as a normal peer under the offer name, with its own hardware and cost line.

## for the requester: the calls, in order

1. **`host_status`.** a job that fits 16 gb goes to a free host (`$0/h owned`). one that needs ~80 gb uses the offer.
2. **`cloud_up`** with `offer: "runpod-h100"` and `max_hours: 3` (or `max_usd: 10`). the cap is required, and it is a
   hard stop the provisioner enforces. if the pod is already live you share it, and the first requester's caps stay.
3. **`cloud_status`** until the offer is `live` and `from this host: authenticated, reach back ok`. a cold start takes
   several minutes. `cloud_up` with `wait_minutes: 20` waits for you instead.
4. **inputs, direct to the pod:** `node bin/agentbus.mjs blob put --host runpod-h100 --task new <files>`. it prints `task`
   and `ownerPath`.
5. **`spawn_session`** with `host: runpod-h100`, `runtime: claude-code`, `cwd: <ownerPath>`, `claims: ["gpu"]` and the job
   contract from [remote-jobs.md](remote-jobs.md). **the gpu claim is what keeps the pod alive.** an unclaimed session
   counts as idle.
6. **results, direct from the pod:**
   `node bin/agentbus.mjs blob get --host runpod-h100 --task <task> --wait-for SUMMARY.md --timeout 24h --all --out ./results/<task>`.
7. **`stop_spawned_session`**, then optionally **`cloud_down`** `offer: "runpod-h100"`. otherwise the idle rule stops it.

if the session started before agentbus was updated, the `cloud_*` tools aren't loaded yet. the cli does the same:
`node bin/agentbus.mjs cloud status`, `cloud up runpod-h100 --max-hours 3 --wait 20` and `cloud down runpod-h100`.

## lifetime, enforced on the provisioner

- **hard cap.** a pod is terminated at `max_hours`. with `max_usd` it stops when elapsed time times the billed rate
  reaches the amount. the owner's `maxHours` and `maxUsd` bound every request.
- **idle.** the provisioner terminates the pod after `idleMinutes` (default 15) with none of these:
  - a live claimed job (the pod's presence `compute` and `jobs`)
  - a blob transfer in flight
  - a task with `out/SUMMARY.md` and out/ files nobody has downloaded at their current size and mtime
- **`cloud_down`.** it refuses while a claimed job runs or results are unfetched. `force` overrides. with `force`, unfetched
  task folders are kept on the volume unless `purge_all` is set.
- **purge before terminate.** every task folder with nothing left to fetch is deleted from the network volume, while weights
  stay. a folder with undownloaded out/ files is kept, whether its job finished or not, and listed as `keptTasks`. the
  volume persists at runpod, and research data there is pre-publication.
- each start records the requester's host and agent (`startedBy`) and everyone who shared it (`users`). the last run's
  reason, hours, estimated cost and who stopped it stay visible in `cloud_status`.
- if the provisioner's daemon restarts, a pod that may still be billing is resumed as live and re-checked against
  runpod.
- **pod-side backstop.** the pod gets its absolute deadline (`AGENTBUS_HARD_STOP_AT`, the hard cap plus 10 minutes).
  [watchdog.sh](../scripts/runpod/watchdog.sh) then deletes the pod from inside, falling back to stop, even when the
  provisioner is unreachable. it uses only what runpod injects into every pod: `RUNPOD_POD_ID` and `RUNPOD_API_KEY`.
  runpod documents that key as "pod-scoped" but not what it may call. **test it once on a throwaway pod** with a
  1-minute cap and the provisioner stopped. if runpod refuses, the log says so and the pod keeps billing until the
  provisioner is back. no account key is ever put in a pod.

## how the traffic flows

- the pod's join token names only the provisioner, so the pod dials it first. the provisioner checks it the way
  `lan doctor` does: authenticated, reach back, rw task storage, a 4 MiB blob round trip. only then does it go live.
- the provisioner's inventory announces a live pod's tailscale address. every group host on this build dials the pod
  directly, so blob and spawn traffic never relays through the provisioner.
- the pod is userspace tailscale and sees every inbound connection as `127.0.0.1`. dialers over tailscale therefore name
  their own tailscale ip, which the pod uses to dial back. that is what makes "reach back" pass and lets the pod accept
  spawns from the requester.
- **the provisioner is a direct peer of every requester.** new invites (`lan invite`) add it to the join token
  automatically, next to the hosts you name.
- **existing members are introduced once.** every host shares the provisioner's tailscale address in its inventory. a
  member that peers only with another host, such as a remote laptop that joined via gpubox, dials the provisioner after
  one poll. once it authenticates, the member saves it as a static peer in its own lan config.
- **after that the provisioner is dialed directly.** the introducing host can be off, rebooting or gaming, and it is in no
  data or control path to the provisioner or the pod. a test covers exactly that.
- **tailnet discovery finds it too.** a member on this build probes its tailnet's online nodes on the agentbus port and
  peers with the provisioner (and live pods) that way as well, with no introducing host in between. see
  [README: tailnet discovery](../README.md#tailnet-discovery-every-member-finds-every-member).
- the requester's daemon and the provisioner must run this build. so must the introducing host, for the one-time
  introduction only. the pod uses the image.

## provisioner setup (owner, once)

on the provisioner:

1. a fixed lan port, because pods and introduced hosts dial it. set `"port": 47800` in `~/.agentbus/lan/config.json`,
   then run `agentbus lan stop && agentbus lan install`.
2. write the offers to a file and load it with `agentbus cloud init offers.json`:
   ```json
   { "idleMinutes": 15, "maxHours": 8, "maxUsd": 40,
     "offers": [
       { "name": "runpod-h100", "gpu": "NVIDIA H100 80GB HBM3", "cloud": "SECURE",
         "image": "ghcr.io/<you>/agentbus-runpod:0.6.0", "volumeId": "<network volume id>",
         "dataCenterId": "US-NE-1", "minCuda": "13.0", "coldStartMinutes": 22, "gpuMemoryMiB": 81559 },
       { "name": "runpod-rtx6000", "gpu": "NVIDIA RTX PRO 6000 Blackwell Server Edition", "cloud": "SECURE",
         "image": "ghcr.io/<you>/agentbus-runpod:0.6.0", "volumeId": "<network volume id>",
         "dataCenterId": "US-NE-1", "minCuda": "13.0", "coldStartMinutes": 22 }
     ] }
   ```
   - **two offers, one volume.** both name the same network volume in its data center. the h100 sxm has 80 gb, sm 9.0, and lists at $3.99/h secure. the rtx pro 6000 has 96 gb and sm 12.0 with native fp8, and lists at $2.49/h secure.
   - **gpu ids.** runpod lists three rtx pro 6000 ids (server, workstation and max-q editions). server edition is the data-center card. check placement with `GET https://api.runpod.io/v2/catalog/gpus?include=AVAILABILITY&product=POD`.
   - **`minCuda` is a floor.** `"13.0"` accepts hosts on 13.0, 13.2 and so on. it is sent as runpod's `minCudaVersion`. `cuda`, an exact-match list sent as `allowedCudaVersions`, must name every acceptable host version. an exact `["13.0"]` found no secure 80 gb stock on 2026-10-28, because those hosts report 13.2. the two fields are exclusive.
   - **price.** it is read from runpod's catalog at provisioner start and at every `cloud_up`, for the offer's cloud. secure and community differ a lot: h100 sxm is $3.99 secure against $2.69 community. a configured `ratePerHour` is only a fallback when the catalog can't be read, and a running pod's billed rate replaces both.
   - **`gpuMemoryMiB`** is optional. without it the catalog size is shown with a `~` until the first pod reports the real number.
3. store the secrets. the file is owner-only, the values are read from env and never printed:
   ```sh
   RUNPOD_API_KEY=... TS_OAUTH_CLIENT_ID=... TS_OAUTH_CLIENT_SECRET=... CLAUDE_CODE_OAUTH_TOKEN=... HF_TOKEN=... agentbus cloud secrets --from-env
   ```
   the tailscale credential is an **oauth client**, not an auth key:
   - **per pod:** on each `cloud_up` the provisioner exchanges it for an access token. it then mints one auth key that
     is single use, ephemeral and pre-approved, tagged `tag:agentbus-gpu`. the key expires within minutes, about twice
     the offer's cold start, between 15 and 60 minutes.
   - **where the key goes:** only into that pod's env. it is never written to state, progress, logs or inventory. a failed
     start revokes it.
   - **legacy:** a configured `TS_AUTHKEY` is used only when no oauth client is set.
   `~/.agentbus/cloud/secrets.json` is mode 0600 and is never sent to peers. it isn't in inventory, status, errors or logs.
4. pin the agentbus release pods run. push the commit you want to the repo pods clone (the upstream repo by default,
   or your fork via `"agentbusRepo": "https://..."`), then set `"agentbusRef": "<that commit, 40 hex>"` (or a release tag
   like `"v1.0.0"`) at the top level of `offers.json` and rerun `agentbus cloud init`. a branch name is refused, so
   every pod is reproducible. without a ref, pods run the copy baked into the image and say so. the pod's build hash
   shows in the provisioner's checks, and a mismatch with the provisioner's own build is printed as a WARN line, never hidden.
5. restart the daemon: `agentbus lan stop && agentbus lan install`. its log says `cloud provisioner: offers runpod-h100`.

## tailscale acl

pods join with the per-pod keys above, tagged `tag:agentbus-gpu`. if your tailnet has no tags yet, the tag is new policy.
this assumes every group device, including a remote laptop joined with an invite's auth key, sits under the owner's tailnet user.

`agentbus cloud tailnet-policy` does the safe part with the same oauth client:
1. reads the policy file as hujson along with its etag.
2. adds `tagOwners: { "tag:agentbus-gpu": ["autogroup:admin"] }` if missing. the edit inserts text only, so comments,
   order and rules survive. the result must equal the original plus exactly that entry, or it refuses.
3. validates the edited file and previews what reaches `<provisioner tailscale ip>:47800`.
4. prints the diff. it writes only with `--apply`, with `If-Match` on the etag it read. if someone edited the policy
   in between, tailscale answers 412 and nothing is written.

it never removes or narrows a rule, and a default allow-all stays allow-all. it never adds grants: for a custom policy
it prints the two below for you to add by hand.

- **if the tailnet policy is the default allow-all,** either the current grant `{"src": ["*"], "dst": ["*"], "ip": ["*"]}` or the legacy acl `{"action": "accept", "src": ["*"], "dst": ["*:*"]}`, then `*` covers tagged devices too.
  only the tag owner has to be added:
  ```json
  "tagOwners": { "tag:agentbus-gpu": ["autogroup:admin"] }
  ```
- **if the policy is customized,** allow both directions on the agentbus port between the tag and the user's devices,
  a remote laptop joined with a tailscale auth key included:
  ```json
  "grants": [
    { "src": ["tag:agentbus-gpu"], "dst": ["autogroup:member"], "ip": ["tcp:47800"] },
    { "src": ["autogroup:member"], "dst": ["tag:agentbus-gpu"], "ip": ["tcp:47800"] }
  ]
  ```
  if a requester's device is ever moved to a separate user or a share, replace `autogroup:member` with explicit device or user
  selectors for each side.

check it once a pod is live: `cloud_status` on the requester must show `reach back ok`.

## updating a requester (no manual steps)

a requester's claude updates its own checkout the normal way ([join.md](join.md), "later"):

```sh
git pull && npm ci && node bin/agentbus.mjs lan stop && node bin/agentbus.mjs lan install
```

the `cloud_*` mcp tools appear in sessions started after that. the cli works at once.
