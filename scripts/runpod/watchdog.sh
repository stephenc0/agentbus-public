#!/usr/bin/env bash
# pod-side backstop for the provisioner's hard cap: at AGENTBUS_HARD_STOP_AT (unix seconds, the cap plus a grace) the pod
# terminates itself, even when the provisioner is unreachable. it uses only what runpod injects into every pod:
# RUNPOD_POD_ID and RUNPOD_API_KEY (documented as a "pod-scoped api key"; what it may call is not documented, so this
# tries delete, then stop, and reports loudly if runpod refuses both). no account key is ever placed in the pod.
set -uo pipefail
log() { printf '[agentbus-watchdog %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
DEADLINE="${AGENTBUS_HARD_STOP_AT:-}"
[[ "$DEADLINE" =~ ^[0-9]+$ ]] || { log "no AGENTBUS_HARD_STOP_AT; backstop off"; exit 0; }
POLL="${AGENTBUS_WATCHDOG_POLL:-30}"
API="${RUNPOD_API_BASE:-https://api.runpod.io}"
log "hard stop at $(date -u -d "@$DEADLINE" +%FT%TZ 2>/dev/null || echo "$DEADLINE")"
while [ "$(date +%s)" -lt "$DEADLINE" ]; do sleep "$POLL"; done
log "hard stop deadline reached; the provisioner has not stopped this pod. terminating it from inside"
if [ -z "${RUNPOD_POD_ID:-}" ] || [ -z "${RUNPOD_API_KEY:-}" ]; then log "FAILED: RUNPOD_POD_ID or RUNPOD_API_KEY is not injected; the pod keeps billing until stopped by hand"; exit 1; fi
try() { # method path [body] -> 0 on 2xx
  local code extra=()
  [ -n "${3:-}" ] && extra=(-H 'Content-Type: application/json' -d "$3")
  code=$(curl -sS -o /dev/null -w '%{http_code}' -X "$1" "$API$2" -H "Authorization: Bearer $RUNPOD_API_KEY" ${extra[@]+"${extra[@]}"} --max-time 30) || code=000
  log "$1 $2 -> http $code"; [[ "$code" =~ ^2 ]]
}
for _ in 1 2 3; do
  if command -v runpodctl >/dev/null 2>&1 && runpodctl pod delete "$RUNPOD_POD_ID" >/dev/null 2>&1; then log "runpodctl pod delete ok"; exit 0; fi
  try DELETE "/v2/pods/$RUNPOD_POD_ID" && exit 0
  try POST "/v2/pods/$RUNPOD_POD_ID/action" '{"action":"stop"}' && { log "stopped (compute released; volume and container disk remain until terminated)"; exit 0; }
  sleep 20
done
log "FAILED: runpod refused delete and stop with the pod-scoped key. the pod keeps billing until the provisioner or a human stops it"
exit 1
