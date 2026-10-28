#!/usr/bin/env bash
# image entrypoint: run the agentbus release the provisioner pinned, from the network volume, so agentbus updates need no
# image rebuild. the image's own copy (/opt/agentbus) is only the bootstrap and the fallback.
#
#   AGENTBUS_REF   exact public-mirror commit (40 hex) or release tag (v1.2.3). never a branch: a pod must be reproducible.
#   AGENTBUS_REPO  default https://github.com/stephenc0/agentbus-public.git (public: pods hold no github credential)
#
# each ref is fetched and npm-installed once into /workspace/agentbus/<ref> (under a lock, so pods sharing the volume don't
# race), then reused by later pods. any failure falls back to the baked copy and says so loudly.
set -uo pipefail
log() { printf '[agentbus-boot %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
BAKED="${AGENTBUS_BAKED:-/opt/agentbus}"
REPO="${AGENTBUS_REPO:-https://github.com/stephenc0/agentbus-public.git}"
REF="${AGENTBUS_REF:-}"
ROOT="${AGENTBUS_CODE_ROOT:-/workspace/agentbus}"
fallback() {
  log "WARNING: $1"
  log "WARNING: running the agentbus copy baked into the image ($(cd "$BAKED" && git rev-parse --short HEAD 2>/dev/null || echo unknown build)), not the pinned release"
  export AGENTBUS_HOME="$BAKED" AGENTBUS_CODE_SOURCE="baked (${1:0:80})"
  exec bash "$BAKED/scripts/runpod/start.sh"
}
if [[ "$REF" =~ ^[0-9a-f]{40}$ ]]; then kind=commit; fetchref="$REF"
elif [[ "$REF" =~ ^v[0-9][0-9A-Za-z._-]{0,40}$ ]]; then kind=tag; fetchref="refs/tags/$REF"
elif [ -z "$REF" ]; then fallback "no AGENTBUS_REF from the provisioner"
else fallback "AGENTBUS_REF '$REF' is not a 40-hex commit or a v-tag (branches are refused)"
fi
DIR="$ROOT/$REF"
mkdir -p "$ROOT" || fallback "cannot create $ROOT"
(
  flock -w 600 9 || { log "timed out waiting for another pod's install of $REF"; exit 1; }
  if [ -f "$DIR/.agentbus-ready" ]; then exit 0; fi
  log "fetching agentbus $kind $REF from $REPO"
  rm -rf "$DIR.tmp" && mkdir -p "$DIR.tmp" && cd "$DIR.tmp" || exit 1
  git init -q && git remote add origin "$REPO" \
    && git -c protocol.version=2 fetch -q --depth 1 origin "$fetchref" && git checkout -q --detach FETCH_HEAD || { log "git fetch of $REF failed"; exit 1; }
  if [ "$kind" = commit ] && [ "$(git rev-parse HEAD)" != "$REF" ]; then log "fetched commit does not match $REF"; exit 1; fi
  npm ci --omit=dev --no-audit --no-fund --loglevel=error || { log "npm ci failed"; exit 1; }
  node bin/agentbus.mjs build-info >/dev/null || { log "fetched agentbus does not run"; exit 1; }
  touch .agentbus-ready && cd / && rm -rf "$DIR" && mv "$DIR.tmp" "$DIR"
) 9>"$ROOT/.install.lock" || fallback "could not install agentbus $REF on the volume"
[ -f "$DIR/scripts/runpod/start.sh" ] || fallback "$DIR has no scripts/runpod/start.sh"
log "running agentbus $kind $REF from $DIR"
export AGENTBUS_HOME="$DIR" AGENTBUS_CODE_SOURCE="volume $kind $REF"
exec bash "$DIR/scripts/runpod/start.sh"
