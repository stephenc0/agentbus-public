#!/usr/bin/env bash
# runpod pod entrypoint: join the tailnet in userspace mode, join the agentbus group as an ephemeral wan peer,
# offer the network volume as task storage, accept remote claude launches there, then run the lan daemon forever.
#
# env (set on the runpod template or by scripts/runpod/pod.mjs; never commit values):
#   TS_AUTHKEY                  tailscale auth key. from the provisioner: single use, ephemeral, tagged tag:agentbus-gpu,
#                               minted per pod with a short expiry (required)
#   AGENTBUS_HARD_STOP_AT       unix seconds; the pod terminates itself then (provisioner hard cap + grace)  (optional)
#   AGENTBUS_JOIN_TOKEN         agentbus-join-v1:... from `agentbus lan invite --token-only`                       (required)
#   AGENTBUS_NAME               this host's agentbus and tailscale name, e.g. runpod-h100                          (required)
#   CLAUDE_CODE_OAUTH_TOKEN     from `claude setup-token` (or ANTHROPIC_API_KEY)                                    (required for claude-code jobs)
#   AGENTBUS_GPU_COST_PER_HOUR  usd/hour advertised next to gpu memory (pod.mjs fills in runpod's own rate)         (optional; absent = unknown)
#   AGENTBUS_BILLING            short label, e.g. "runpod secure cloud on-demand"                                   (optional)
#   AGENTBUS_PORT               agentbus listen port, default 47800
#   AGENTBUS_TASK_ROOT          task storage root on the network volume, default /workspace/agentbus-tasks
#   AGENTBUS_SOCKS5             tailscaled socks5 listener, default 127.0.0.1:1055
#   AGENTBUS_CLAUDE_ALLOW       "all" (default) pre-allows tools for background claude jobs; "none" leaves claude defaults
set -euo pipefail

log() { printf '[agentbus-pod %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() { log "FATAL: $*"; exit 1; }
need() { [ -n "${!1:-}" ] || die "env $1 is required"; }
need TS_AUTHKEY; need AGENTBUS_JOIN_TOKEN; need AGENTBUS_NAME
[[ "$AGENTBUS_NAME" =~ ^[a-zA-Z0-9_.-]{1,63}$ ]] || die "AGENTBUS_NAME must be 1-63 letters, digits, dots, underscores or dashes"
[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}${ANTHROPIC_API_KEY:-}" ] || log "warning: no CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY; claude-code launches will fail to authenticate"

# boot.sh picks the copy: the pinned release on the volume, or the image's baked fallback
export AGENTBUS_HOME="${AGENTBUS_HOME:-/opt/agentbus}" AGENTBUS_CODE_SOURCE="${AGENTBUS_CODE_SOURCE:-baked (start.sh run directly)}"
AGENTBUS="$AGENTBUS_HOME/bin/agentbus.mjs"
PORT="${AGENTBUS_PORT:-47800}"
TASK_ROOT="${AGENTBUS_TASK_ROOT:-/workspace/agentbus-tasks}"
SOCKS5="${AGENTBUS_SOCKS5:-127.0.0.1:1055}"
export AGENTBUS_DIR="${AGENTBUS_DIR:-/root/.agentbus}"   # container disk: a new pod is a new host identity
ab() { node "$AGENTBUS" "$@"; }

# ---- 1. tailscale, userspace networking (no /dev/net/tun in runpod containers) ----
# state in memory: every pod is a fresh node; with an ephemeral auth key it disappears from the tailnet once offline.
mkdir -p /var/run/tailscale /var/lib/tailscale
if ! tailscale status >/dev/null 2>&1; then
  log "starting tailscaled (userspace, socks5 $SOCKS5)"
  tailscaled --tun=userspace-networking --state=mem: --socket=/var/run/tailscale/tailscaled.sock \
    --socks5-server="$SOCKS5" --outbound-http-proxy-listen="$SOCKS5" >/var/log/tailscaled.log 2>&1 &
  for _ in $(seq 1 50); do [ -S /var/run/tailscale/tailscaled.sock ] && break; sleep 0.2; done
fi
tailscale up --auth-key="$TS_AUTHKEY" --hostname="$AGENTBUS_NAME" --accept-dns=false --accept-routes=false \
  || die "tailscale up failed (expired/used key, or the tag is not allowed for this key)"
TS_IP=""
for _ in $(seq 1 60); do TS_IP="$(tailscale ip -4 2>/dev/null | head -1 || true)"; [ -n "$TS_IP" ] && break; sleep 1; done
[ -n "$TS_IP" ] || die "tailscale has no ipv4 address after 60s"
log "tailscale up as $AGENTBUS_NAME ($TS_IP)"

# ---- 2. agentbus join: loopback bind, socks5 out, advertise the tailscale ip, ephemeral, with cost ----
COST_ARGS=()
[ -n "${AGENTBUS_GPU_COST_PER_HOUR:-}" ] && COST_ARGS+=(--cost-per-hour "$AGENTBUS_GPU_COST_PER_HOUR")
[ -n "${AGENTBUS_BILLING:-}" ] && COST_ARGS+=(--billing "$AGENTBUS_BILLING")
# the token is read from AGENTBUS_JOIN_TOKEN by lan join; it never appears on a command line or in a log
ab lan join --host --userspace-tailscale --ephemeral --advertise-address "$TS_IP" --socks5 "$SOCKS5" --name "$AGENTBUS_NAME" --port "$PORT" "${COST_ARGS[@]}" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(`[agentbus-pod] joined as ${r.name} ${r.hostId} bind ${r.bind}:${r.port}`)})'
HOST_ID="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).hostId)' "$AGENTBUS_DIR/lan/config.json")"

# ---- 3. task storage on the network volume ----
# one subfolder per host identity: the storage marker binds a folder to its owner host, and every pod is a new host.
# results of earlier pods stay on the volume under their own host id.
mkdir -p "$TASK_ROOT/$HOST_ID"
ab storage add --name "$AGENTBUS_NAME tasks" --path "$TASK_ROOT/$HOST_ID" --uri "smb://$AGENTBUS_NAME/agentbus-tasks" \
  --purpose "runpod network volume task storage (blob lane only, no smb)" --create >/dev/null
log "task storage $TASK_ROOT/$HOST_ID"

# ---- 4. remote launches, claude trust and permissions ----
ab sessions configure --root "$TASK_ROOT" --remote >/dev/null
# claude code inherits workspace trust from a parent folder. it has no cli flag to accept the trust dialog, so mark the
# root trusted (and onboarding done) in ~/.claude.json the way the interactive dialog would. background launches
# (claude --bg) in tasks/<uuid> below it then start without a prompt.
node - "$TASK_ROOT" <<'EOF'
const fs = require('fs'), os = require('os'), path = require('path');
const file = path.join(os.homedir(), '.claude.json'), root = fs.realpathSync(process.argv[2]);
let c = {}; try { c = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
c.hasCompletedOnboarding = true;
c.projects = c.projects || {};
c.projects[root] = { ...(c.projects[root] || {}), hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true };
fs.writeFileSync(file, JSON.stringify(c, null, 2), { mode: 0o600 });
EOF
if [ "${AGENTBUS_CLAUDE_ALLOW:-all}" = "all" ]; then
  # a disposable compute box: let background jobs run tools without an approval nobody is there to give.
  # (bypassPermissions/--dangerously-skip-permissions is refused as root, so this is an allow list instead.)
  mkdir -p /root/.claude
  node - <<'EOF'
const fs = require('fs'), file = '/root/.claude/settings.json';
let s = {}; try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
s.permissions = { ...(s.permissions || {}), allow: [...new Set([...(s.permissions?.allow || []), 'Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'mcp__agentbus'])] };
fs.writeFileSync(file, JSON.stringify(s, null, 2));
EOF
fi
# agentbus tools for launched sessions, so a job can message its submitter when it finishes
claude mcp get agentbus >/dev/null 2>&1 || claude mcp add --scope user agentbus -- "$(command -v node)" "$AGENTBUS_HOME/server.mjs" >/dev/null 2>&1 \
  || log "warning: could not register the agentbus mcp server for claude"

# ---- 5. weights cache on the volume ----
export HF_HOME="${HF_HOME:-/workspace/hf}"; mkdir -p "$HF_HOME"
log "hf cache $HF_HOME ($(du -sh "$HF_HOME" 2>/dev/null | cut -f1) cached)"
# colabfold params, boltz weights, jax/torch caches: all on the volume, downloaded once by the first job that needs them
mkdir -p "${COLABFOLD_CACHE_HOME:-/workspace/cache}/colabfold" "${BOLTZ_CACHE:-/workspace/cache/boltz}" /workspace/cache/jax /workspace/cache/torch /workspace/envs
log "tool caches under /workspace/cache: $(du -sh /workspace/cache 2>/dev/null | cut -f1)"
log "agentbus code: $AGENTBUS_CODE_SOURCE"

# ---- 6. hard-cap backstop: the pod terminates itself after the provisioner's deadline plus grace ----
if [ -n "${AGENTBUS_HARD_STOP_AT:-}" ]; then
  bash "$AGENTBUS_HOME/scripts/runpod/watchdog.sh" >>/var/log/agentbus-watchdog.log 2>&1 &
  log "hard-stop backstop armed (log /var/log/agentbus-watchdog.log)"
fi

# ---- 7. lan daemon, restarted if it exits; the container lives as long as this loop ----
# no systemd in containers. tini (pid 1) reaps children and forwards SIGTERM; on stop we end the daemon cleanly.
LOG="$AGENTBUS_DIR/lan/daemon.log"
child=0
trap 'log "stopping"; [ "$child" -gt 0 ] && kill -TERM "$child" 2>/dev/null; wait "$child" 2>/dev/null; tailscale logout >/dev/null 2>&1 || true; exit 0' TERM INT
log "lan daemon on 127.0.0.1:$PORT (reachable as $TS_IP:$PORT over tailscale); log $LOG"
while true; do
  node "$AGENTBUS" lan serve >>"$LOG" 2>&1 &
  child=$!
  wait "$child" || true
  log "lan serve exited; restarting in 5s"
  sleep 5
done
