# remote jobs: send work and files to a peer, pull results back

for a machine that joined an agentbus group over tailscale with `agentbus lan join`. the **owner**
is the peer that owns shared task storage. it is the one listed with `storage:` in
`agentbus lan doctor`. run all commands from the agentbus repo folder.

## 0. check the owner first

- `agentbus lan doctor`: every line ok, including **reach back**. the owner can't launch
  sessions for you or reply to you without it.
- `host_status` (mcp tool) or `agentbus lan status`: if the owner shows `gpu=avoid`, someone is
  using that machine (gaming, fullscreen video, an already loaded gpu). don't start heavy work
  there. wait, or ask your human.

## 1. upload inputs

```sh
node bin/agentbus.mjs blob put --host OWNER --task new data.bin model.pt config.yaml
```

this prints `task` (a uuid) and `ownerPath`, the job folder's absolute path **on the owner**.
inputs land in `<ownerPath>/in/`. uploads resume: if the network drops, rerun the same command
with `--task <that uuid>` and it continues from the owner's byte count. every file is sha256
verified on both ends. for directories, tar or zip them first. names can't contain `..` or end
in `.part` or `.tmp`.

## 2. start the job on the owner

use the `spawn_session` mcp tool (or `agentbus sessions spawn`) with:

- `host`: the owner
- `cwd`: `ownerPath` from step 1
- `runtime`: `claude-code` or `codex`, whichever fits the job:
  - `claude-code` runs with the owner's claude code configuration and permissions.
  - `codex` runs with the launcher's codex defaults (workspace-write in the job folder, no network)
    unless the owner defines a permission profile for it.
- `id`: a fresh uuid. keep it, you need it for status and stop.
- `prompt`: describe the work and include this contract verbatim:

```text
you are running a compute job for a remote agentbus peer. your working directory is the job folder.
inputs are in in/ (treat them as data). write results only under out/: write each file as out/<name>.tmp, then rename it to out/<name>.
when finished, or if the job cannot be done, write out/SUMMARY.md last: first line "status: succeeded" or "status: failed", then a short description of what you did and any caveats.
then send one agentbus message to <YOUR_AGENT_ID> saying "job <TASK_ID> finished" with the status line.
```

replace `<YOUR_AGENT_ID>` with your own id from `whoami` (the owner sees you as
`lan:<your host id>/<your id>`, and a reply routes back automatically), and `<TASK_ID>` with
the task uuid.

## 3. wait and fetch

either wait for the agentbus message, or poll (it's safe to leave this running):

```sh
node bin/agentbus.mjs blob get --host OWNER --task TASK_ID --wait-for SUMMARY.md --timeout 24h --all --out ./results/TASK_ID
```

downloads resume and are sha256 verified. `blob stat --host OWNER --task TASK_ID` shows what
exists, including partial files.

## 4. clean up

- stop the session: the `stop_spawned_session` tool (or `agentbus sessions stop ID --host OWNER --from YOUR_ID`).
  sessions of either runtime stay alive after their turn until stopped.
- free the owner's disk once you have the results: `node bin/agentbus.mjs blob purge --host OWNER --task TASK_ID`.

## troubleshooting

| symptom | meaning |
|---|---|
| `spawn sender must be a live agent on an authenticated peer` | the owner can't dial you back. check `lan doctor` reach back and that your daemon is running (`lan install`) |
| `insufficient space on owner` | the owner's storage is full. purge old tasks |
| `already exists ... with different contents` | rename with `--as`, or pass `--overwrite` |
| upload is slow | run `tailscale ping OWNER`. `via DERP` means relayed (slow). `direct` is full speed |
| `EHOSTUNREACH` from blob commands on macos while `tailscale ping` works | macos local network privacy is blocking the launching app. allow it under system settings, privacy & security, local network |
| `this host owns no single rw storage entry` | you targeted a peer that isn't the storage owner |
