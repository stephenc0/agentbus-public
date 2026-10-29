# rented gpu peer on runpod

> for pods that any peer starts and stops through agentbus (a provisioner host with caps and idle shutdown), see
> [cloud.md](cloud.md). this page covers the image, the pod bootstrap, and the standalone `pod.mjs` wrapper.

a runpod pod (h100 or a100, 80 gb, secure cloud) joins the agentbus group as an **ephemeral wan peer**. it adds to the free
hosts and replaces none of them. it advertises its gpu memory and its hourly price, so a submitter can read the choice off
`host_status`:

```
gpubox hardware: 16303MiB cuda (NVIDIA GeForce RTX 5070 Ti, sm 12.0), $0/h owned
studio hardware: 16384MiB unified metal (Apple M6), $0/h owned
runpod-h100 hardware: 81559MiB cuda (NVIDIA H100 80GB HBM3, sm 9.0), $3.99/h runpod secure cloud on-demand
```

a job that fits in 16 gb goes to a free box. a job that needs about 80 gb goes to the pod, for example esmfold2 on a
complex of 1000 or more tokens with several diffusion samples. the pod bills from creation until `down`. there is no
auto-terminate in this version.

how it works:
- the pod runs `tailscaled --tun=userspace-networking`, because runpod has no `/dev/net/tun`.
- agentbus joins with `lan join --userspace-tailscale --ephemeral`. it binds `127.0.0.1:47800`, because tailscaled forwards
  inbound tailnet tcp there. it dials out through tailscaled's socks5 proxy and advertises its `tailscale ip -4`. see
  [README: userspace tailscale](../README.md#userspace-tailscale-containers-without-devnettun).
- the network volume holds the hugging face cache, so the ~27 gb `biohub/ESMFold2` weights download once. it also holds
  the task storage.

## one-time setup, by hand

none of this can be scripted from here: each step needs an account, a payment method or an admin console.

1. **runpod account and api key.** add credits, then create an api key with read/write access (runpod console, settings,
   api keys). keep it as `RUNPOD_API_KEY` on the host that runs `pod.mjs`, never in the repo.
2. **network volume.** create it under storage, then network volumes, in a **secure cloud** data center that has h100 or
   a100 80 gb stock. a pod can mount a volume only in its own data center. 150 gb fits the weights (~27 gb), the
   torch/esm caches and task results. note the volume id and its data center id, e.g. `US-KS-2`.
3. **tailscale tag and key.** in the tailscale admin console:
   - access controls: add a tag owner, `"tagOwners": { "tag:agentbus-gpu": ["autogroup:admin"] }`. if the policy is not
     allow-all, also allow `tag:agentbus-gpu` and the agentbus hosts to reach each other on tcp 47800 in **both**
     directions. the owner dials the pod back.
   - **with the provisioner ([cloud.md](cloud.md)):** create an oauth client under trust credentials with scopes
     `auth_keys` and `policy_file`, tag `tag:agentbus-gpu`. the provisioner mints a single-use ephemeral key per pod.
     no long-lived auth key exists.
   - **standalone `pod.mjs` only:** generate an auth key that is **reusable**, **ephemeral**, **pre-approved** and tagged
     `tag:agentbus-gpu`. it lasts at most 90 days. ephemeral means a terminated pod's node removes itself from the tailnet.
4. **claude token.** run `claude setup-token` on any machine logged in to the claude account. it prints a long-lived
   oauth token for `CLAUDE_CODE_OAUTH_TOKEN`. `ANTHROPIC_API_KEY` also works and is billed per token instead.
5. **runpod secrets.** under secrets, store `ts_authkey`, `claude_oauth_token` and optionally `hf_token` (only if the
   `biohub/ESMFold2` repo is gated for your account). then a template can reference `{{ RUNPOD_SECRET_ts_authkey }}`
   rather than taking the value through the api. this step is optional: `pod.mjs` can instead pass the values from your
   local env at create time.
6. **image.** first push the agentbus commit you want pods to run. then build from that commit with **no build
   context**: the dockerfile goes on stdin. the baked agentbus copy is cloned over https inside the build (the upstream
   repo, or your fork via `--build-arg AGENTBUS_REPO=https://...`), so nothing from your local checkout enters the image. push it to a registry runpod can pull.
   a public ghcr image is fine because it holds no secrets. for a private registry, add registry credentials in runpod.
   ```sh
   docker buildx build --platform linux/amd64 --build-arg AGENTBUS_REF=<commit, 40 hex> \
     -t ghcr.io/<you>/agentbus-runpod:0.6.0 --push - < scripts/runpod/Dockerfile
   ```
   the build refuses a missing or floating ref, and a non-https `AGENTBUS_REPO` (pods hold no git credential). use the same
   commit as the provisioner's `agentbusRef`, so the baked fallback and the volume copy match.
   **the image is the base layer only.** rebuild it when cuda, a folding stack, claude code or tailscale changes, never
   for an agentbus update. agentbus runs from the network volume at the release the provisioner pins (see below).

   | path | what | pinned to |
   |---|---|---|
   | `/opt/esm` | esmfold2 (biohub `esm`, python api via `esm-python` or `/opt/esm/bin/python`) | `esm==3.4.1.post1`, torch 2.11.0 (cuda 13.0), cuequivariance 0.13.0 |
   | `/opt/colabfold` | localcolabfold via pixi (`colabfold_batch`, `colabfold_search` on PATH) | localcolabfold `e2e8c4a8` (pixi), ColabFold **v1.6.3**, jax 0.10.1 cuda12, openmm 8.2 |
   | `/opt/boltz` | boltz-2 (`boltz predict` on PATH) | `boltz[cuda]==2.2.1`, torch 2.8.0+cu128 (cuda 12.8), cuequivariance 0.6.1 |
   | `/opt/agentbus` | the baked agentbus copy: bootstrap and fallback only | the commit the image was built from |

   - **isolated envs.** the three stacks conflict: esm wants cuda 13 torch, boltz wants cuda 12 kernels, colabfold wants
     jax and tensorflow. each has its own env, so a tool's update never breaks another.
   - **smoke tests.** each env's build step imports the stack, asserts the gpu backend is a cuda build (no gpu at build
     time) and runs the cli's `--help`.
   - **pins hold.** torch and cuequivariance are pinned through pip constraints files, and the smoke steps assert the
     final versions, so any drift fails the build. the first build showed why: with only torch preinstalled, boltz's
     unpinned cuequivariance (0.11.1 and later need torch>=2.11) moved boltz to torch 2.15+cu132. boltz now uses the
     set that was current at its 2.2.1 release.
   - **host driver floor = 13.0.** each env's wheels bring their own cuda userspace, so the driver must support the
     highest cuda among them:

     | env | cuda its wheels need |
     |---|---|
     | esm | 13.0 (torch 2.11.0+cu130, driver 580+) |
     | boltz | 12.8 (torch 2.8.0+cu128) |
     | colabfold | 12.x (jax 0.10.1 cuda12 wheels, driver 525+) |

     so offers use `minCuda: "13.0"`. if a pin moves to a newer cuda, raise the floor to match.
   - **no weights in the image.** colabfold params go to `/workspace/cache/colabfold` (its wrapper sets
     `XDG_CACHE_HOME`), with the jax compile cache in `/workspace/cache/jax`. boltz uses `/workspace/cache/boltz`
     (`BOLTZ_CACHE`), esm uses `/workspace/hf` (`HF_HOME`), and torch uses `/workspace/cache/torch`. each downloads
     once, on its first job.
   - **colabfold like a local install.** `colabfold_batch` takes the same flags as a `~/localcolabfold` install
     (`--templates --amber --use-gpu-relax`, `alphafold2_ptm` and `alphafold2_multimer_v3`), so a job written for a
     local gpu host runs with only the host changed. wsl-only variables are not set: `TF_FORCE_GPU_ALLOW_GROWTH` and
     `XLA_PYTHON_CLIENT_ALLOCATOR` are wsl2 workarounds per the localcolabfold readme, and colabfold sets
     `TF_FORCE_UNIFIED_MEMORY` and `XLA_PYTHON_CLIENT_MEM_FRACTION` itself on every platform.
   - **size: 28.2 gb**, measured on the pinned build (agentbus 0.6.0). the smoke steps assert esm torch
     2.11.0+cu130 (cuda 13.0), boltz torch 2.8.0+cu128 (cuda 12.8) with cuequivariance 0.6.1, and colabfold jax 0.10.1,
     and pip check is clean in both venvs. the pull dominates cold start.
   - **cold start: 15 minutes, provisional and unmeasured.** the estimate is a 28.2 gb pull at a few hundred mb/s, plus
     layer extraction, plus boot (agentbus fetch and npm ci on the first pod per ref, then tailscale, join and doctor).
     replace it with the first measured cold start (it appears in `cloud_status` progress). later pods on a machine that
     already has the image are much faster.
   - no secrets are in it.
7. **template (optional).** a runpod pod template with that image, a 60 gb container disk, no exposed ports, and these
   env vars:

   | var | value |
   |---|---|
   | `TS_AUTHKEY` | `{{ RUNPOD_SECRET_ts_authkey }}` |
   | `CLAUDE_CODE_OAUTH_TOKEN` | `{{ RUNPOD_SECRET_claude_oauth_token }}` |
   | `HF_TOKEN` | `{{ RUNPOD_SECRET_hf_token }}` (if gated) |

   `pod.mjs` adds `AGENTBUS_NAME`, `AGENTBUS_JOIN_TOKEN`, `AGENTBUS_GPU_COST_PER_HOUR` and `AGENTBUS_BILLING` per pod.
   a template's env is merged per key, so values set at create time win.
8. **a dial target with a fixed port.** the pod dials the hosts in its join token. the host running `pod.mjs up` must be
   one of them and needs a fixed port (e.g. `"port": 47800` in its lan config; the default `"port": 0` is os-assigned,
   so set one and restart the daemon first). `--peer name=100.x.y.z:port` adds more hosts.

## start, check, stop

on a group host with `RUNPOD_API_KEY` set, plus `TS_AUTHKEY` and `CLAUDE_CODE_OAUTH_TOKEN` unless the template has them:

```sh
node scripts/runpod/pod.mjs up --name runpod-h100 --image ghcr.io/<you>/agentbus-runpod:0.6.0 \
  --volume <volume id> --data-center <volume's data center> --gpu "NVIDIA H100 80GB HBM3" --min-cuda 13.0
node scripts/runpod/pod.mjs status runpod-h100
node scripts/runpod/pod.mjs down runpod-h100
node scripts/runpod/pod.mjs list
```

**`up`** does this:
1. reads the gpu's list price from runpod's catalog. `--cost` overrides it. a price it cannot find stays unknown.
2. builds a join token naming this host. `AGENTBUS_JOIN_TOKEN` in the env takes precedence.
3. creates the pod through runpod rest api v2. v1 is deprecated and retires 2026-11-15.
4. waits for `RUNNING`, then for the pod to authenticate to this host's daemon.
5. runs the `lan doctor` checks from this side: authenticated, reach back, rw task storage, and a 4 MiB blob round trip.
6. prints the agentbus name, host id, gpu, advertised cost and elapsed cost.

the first start on a machine pulls a ~10 gb image, so `--wait` defaults to 25 minutes. other gpu ids are
`"NVIDIA A100 80GB PCIe"` and `"NVIDIA A100-SXM4-80GB"`. community cloud is `--cloud community`.

**`down`** does this:
1. refuses while the pod runs a claimed compute job (`--force` overrides).
2. terminates the pod (`DELETE /v2/pods/{id}`) and confirms it is gone (404 or `TERMINATED`).
3. retires the host from this daemon's live table and history with `lan forget-host`.
4. prints billed hours and the estimated cost.

other group hosts never store an ephemeral host in their history, and drop it from their peer table a minute after it
goes silent. a second `down` on a gone pod succeeds. the network volume is detached, not deleted, so weights and task
folders survive.

cost estimates use elapsed time since creation times the advertised or billed rate. runpod's billing page is
authoritative.

**`--min-cuda 13.0`** matters. it is a floor, sent as runpod's `minCudaVersion`, so hosts on 13.2 also qualify. `--cuda` is an exact list, which finds no stock unless it names every acceptable host version. `esm` 3.4.1 on linux x86_64 pulls torch 2.11 cuda 13 wheels and `cuequivariance-ops-torch-cu13`
whatever the image's cuda runtime is, so the host driver must support cuda 13 (driver 580 or newer). the floor restricts placement to such machines. if you pin an older stack, rebuild with `--build-arg ESM_SPEC=...` and drop the flag.

## submitting a job to it

the same as any owner, see [remote-jobs.md](remote-jobs.md):
1. `blob put --host runpod-h100 --task new ...`
2. `spawn_session` with `host: runpod-h100`, `runtime: claude-code`, `cwd: <ownerPath>` and `claims: ['gpu']`
3. `blob get ... --wait-for SUMMARY.md`
4. `down`

the pod's task storage is `/workspace/agentbus-tasks/<pod host id>/tasks/<task>`. every pod is a new host identity, and
the storage marker binds a folder to its owner host. earlier pods' results stay on the volume under their own host id.

the three tools are ready on PATH: `colabfold_batch`, `boltz predict`, and `esm-python` for esmfold2's python api.
the first job that uses each one downloads its weights to the volume, and later pods reuse them. if two jobs start at once
on a fresh volume, both may download, so start one first.

**msa source.** both colabfold and boltz can query the public colabfold mmseqs2 server (`api.colabfold.com`):
`colabfold_batch`'s default msa mode does, and so does boltz's `--use_msa_server`. that sends the query sequences to a
third party. decide whether that is acceptable for your data. the other options, chosen per job and not by
agentbus:
- **precomputed a3m.** upload `.a3m` files to `in/`: colabfold_batch accepts a3m input, and boltz takes `msa: <path>`.
  existing colabfold msas can be reused this way.
- **single sequence.** colabfold `--msa-mode single_sequence`, or boltz `msa: empty`. both are less accurate.
- **a local mmseqs2 database on the volume.** colabfold's `setup_databases.sh` needs ~940 gb of disk, and about 128 gb of
  ram to search (more than 1 tb to keep it in memory). at volume pricing that is a standing monthly cost. not built here.

the job contract's `out/SUMMARY.md` names the msa source a run used (see [remote-jobs.md](remote-jobs.md)).

**extra tools** beyond these three go in `/workspace/envs/<tool>`, with weights next to them or in `/workspace/hf`. the
job that first needs one installs it behind a lock, so concurrent jobs don't race, and later pods reuse it:
```sh
flock /workspace/envs/.<tool>.lock sh -c 'test -f /workspace/envs/<tool>/.ready || { <install into /workspace/envs/<tool>> && touch /workspace/envs/<tool>/.ready; }'
```

## what start.sh does on the pod

the image's command is [scripts/runpod/boot.sh](../scripts/runpod/boot.sh):
- it fetches agentbus over https (`AGENTBUS_REPO`, default upstream) at `AGENTBUS_REF` into `/workspace/agentbus/<ref>`. the ref is a 40-hex
  commit or a v-tag, and branches are refused.
- it runs `npm ci --omit=dev` once per ref, under a lock so pods sharing the volume don't race, and later pods reuse it.
- it then runs that copy's start.sh. pods hold no github credential, and follow published releases, the same code
  requesters run.
- if the ref is missing or invalid, or the fetch or install fails, it logs `WARNING: running the agentbus copy baked into
  the image` and runs `/opt/agentbus` instead.
- the pod reports which copy it runs in its inventory. the provisioner's checks print `agentbus build: <hash> on both`, or
  `WARN agentbus build mismatch: pod ... vs provisioner ...`. `lan doctor` prints the same comparison for every peer.

[scripts/runpod/start.sh](../scripts/runpod/start.sh) then does this:
1. starts `tailscaled` in userspace mode with in-memory state and socks5 on `127.0.0.1:1055`, then runs
   `tailscale up --auth-key`.
2. runs `lan join --userspace-tailscale --ephemeral --advertise-address <tailscale ip>` with the cost env. the join token
   is read from env, never from argv.
3. registers `/workspace/agentbus-tasks/<host id>` as this host's rw task storage, and runs
   `sessions configure --root /workspace/agentbus-tasks --remote`.
4. **claude workspace trust:** claude code has no cli flag to accept the trust dialog. the script sets
   `projects["/workspace/agentbus-tasks"].hasTrustDialogAccepted = true` and `hasCompletedOnboarding` in `/root/.claude.json`,
   which is what accepting the dialog writes. tasks below inherit trust from that root. this is the manual route the claude
   code docs give (https://code.claude.com/docs/en/permissions, "what runs before you trust a folder"). no flag or env var
   skips the dialog. if launches still fail as untrusted, run `claude` once interactively in that folder from the runpod
   web terminal.
5. **permissions:** background jobs have nobody to approve tools. as root, `--dangerously-skip-permissions` and
   bypass mode are refused (documented, and the error string is in the cli). the docs mention a "recognized sandbox"
   exemption without saying how it is detected, so the script doesn't rely on it and writes an allow list (`Bash`, `Read`, `Edit`, `Write`, `Glob`, `Grep`,
   `WebFetch`, `WebSearch`, `mcp__agentbus`) to `/root/.claude/settings.json`. set `AGENTBUS_CLAUDE_ALLOW=none` to skip it.
6. registers the agentbus mcp server for claude, so a job can message its submitter.
7. runs `lan serve` in a restart loop under tini. there is no systemd. SIGTERM stops the daemon and logs tailscale out.

logs are in `/root/.agentbus/lan/daemon.log` and `/var/log/tailscaled.log`. use runpod's web terminal to read them.

## troubleshooting

| symptom | meaning |
|---|---|
| `up` waits at RUNNING and never authenticates | the pod can't reach this host. check tailscale acls for `tag:agentbus-gpu` to and from this host on tcp 47800, that this host is in the join token with a fixed port, and `/var/log/tailscaled.log` on the pod |
| `reach back` fails | this host can't dial the pod's tailscale ip. it is usually an acl in one direction only |
| `create pod: http 400` | no capacity for that gpu in that data center, or the volume is in another data center |
| `http 402` | insufficient runpod balance |
| claude jobs fail as untrusted | see the trust note above |
| `cuda error: no kernel image` or driver errors in esm | the host driver lacks cuda 13; pass `--min-cuda 13.0` |
