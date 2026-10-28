# agentbus gpu peer for runpod (h100 / rtx pro 6000 / a100). build with NO context (the dockerfile on stdin), from the
# published mirror commit:
#   docker buildx build --platform linux/amd64 --build-arg AGENTBUS_REF=<public mirror commit> \
#     -t <registry>/agentbus-runpod:<tag> --push - < scripts/runpod/Dockerfile
#
# this image is the BASE LAYER only: cuda runtime, node, claude code, tailscale, and three isolated folding stacks
# (esmfold2, colabfold, boltz) whose dependencies conflict. agentbus itself runs from the network volume at the release the
# provisioner pins (scripts/runpod/boot.sh); the copy baked here is the bootstrap and the fallback. rebuild only when a
# base-layer piece changes. no secret is baked in; no model weights either: every cache points at /workspace (the volume).
#
# all three stacks bring their own cuda libraries in their wheels/conda env. they need a host driver for cuda 12 (colabfold
# jax cuda12, boltz torch cu128) and cuda 13 (esm torch 2.11 cu13): driver >= 580. offers use minCuda 13.0.
ARG CUDA_IMAGE=nvidia/cuda:12.9.1-runtime-ubuntu24.04
FROM ${CUDA_IMAGE}

ARG DEBIAN_FRONTEND=noninteractive
ARG NODE_MAJOR=24
# esmfold2 (biohub esm). esm 3.4.1.post1 has extras fused/fold-cp/cueq12/cueq13, no [gpu]; on linux x86_64 its base install
# pulls torch 2.11 (cuda 13 wheels) and cuequivariance-ops-torch-cu13.
ARG ESM_SPEC="esm==3.4.1.post1"
# colabfold: localcolabfold's pixi install (YoshitakaMo/localcolabfold main, "use jax 0.10.1"), the same route as winbox's
# ~/localcolabfold. its pyproject tracks ColabFold main unpinned; we pin ColabFold to the v1.6.3 tag (winbox runs 1.6.3).
ARG LOCALCOLABFOLD_REV=e2e8c4a834a3d50ebaede3bb42786707fdc8f6ec
ARG COLABFOLD_REV=84c27d9cc500489fd9b97545d2325b9d00f251d5
ARG PIXI_VERSION=v0.83.0
# boltz-2: upstream pins neither torch (torch>=2.2) nor cuequivariance (>=0.5.0). cuequivariance-ops-torch-cu12 0.11.1+ needs
# torch>=2.11, so an unconstrained install drags torch to the newest release (2.15+cu132 in the first build). pin the set that
# was current when boltz 2.2.1 shipped (2025-09-08): torch 2.8.0 cu128 and cuequivariance 0.6.1, through a constraints file
# so no later resolver step can move them, and assert the result.
ARG BOLTZ_SPEC="boltz[cuda]==2.2.1"
ARG BOLTZ_TORCH_VERSION=2.8.0+cu128
ARG BOLTZ_CUEQ_VERSION=0.6.1
ARG BOLTZ_TORCH_INDEX=https://download.pytorch.org/whl/cu128
# esm 3.4.1.post1 requires torch>=2.11,<2.12; pin the exact build and assert it (PyPI's 2.11.0 is cuda 13.0).
ARG ESM_TORCH_VERSION=2.11.0
ARG ESM_CUEQ_VERSION=0.13.0

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg git jq tini iproute2 procps util-linux \
      python3.12 python3.12-venv python3-pip build-essential \
    && rm -rf /var/lib/apt/lists/*

# node 24 (nodesource)
RUN curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
    && apt-get install -y --no-install-recommends nodejs && rm -rf /var/lib/apt/lists/* && node -v

# tailscale (tailscaled runs in userspace-networking mode at start: runpod has no /dev/net/tun)
RUN curl -fsSL https://tailscale.com/install.sh | sh && tailscale version

# claude code cli (native installer, into /root/.local/bin)
RUN curl -fsSL https://claude.ai/install.sh | bash && /root/.local/bin/claude --version
ENV PATH=/root/.local/bin:${PATH}

# large wheels (cudnn ~700 MB) stall on slow or proxied links: retry with a long read timeout. set here, just before the
# python layers, so changing it never invalidates the apt/node/tailscale/claude layers above.
ENV PIP_DEFAULT_TIMEOUT=120 PIP_RETRIES=10 PIP_DISABLE_PIP_VERSION_CHECK=1

# ---- esmfold2: /opt/esm (python api: /opt/esm/bin/python, or the esm-python wrapper) ----
RUN python3.12 -m venv /opt/esm && /opt/esm/bin/pip install --no-cache-dir --upgrade pip \
    && printf '%s\n' "torch==${ESM_TORCH_VERSION}" "cuequivariance==${ESM_CUEQ_VERSION}" "cuequivariance-torch==${ESM_CUEQ_VERSION}" "cuequivariance-ops-cu13==${ESM_CUEQ_VERSION}" "cuequivariance-ops-torch-cu13==${ESM_CUEQ_VERSION}" > /opt/esm/constraints.txt \
    && /opt/esm/bin/pip install --no-cache-dir -c /opt/esm/constraints.txt "${ESM_SPEC}" "huggingface_hub[hf_transfer]" \
    && /opt/esm/bin/pip check \
    && /opt/esm/bin/python -c "import torch, esm; from esm.models.esmfold2 import EsmFold2Model; v = torch.__version__.split('+')[0]; assert v == '${ESM_TORCH_VERSION}', f'esm torch drifted to {torch.__version__}'; assert torch.version.cuda == '13.0', f'esm torch is cuda {torch.version.cuda}, expected 13.0'; print('esm smoke ok: torch', torch.__version__, 'cuda', torch.version.cuda)"

# ---- colabfold: /opt/colabfold (localcolabfold via pixi; colabfold_batch on PATH via a wrapper) ----
RUN curl -fsSL https://pixi.sh/install.sh | PIXI_VERSION=${PIXI_VERSION} PIXI_HOME=/opt/pixi PIXI_NO_PATH_UPDATE=1 bash \
    && git clone https://github.com/YoshitakaMo/localcolabfold.git /opt/colabfold/localcolabfold \
    && cd /opt/colabfold/localcolabfold && git checkout --detach ${LOCALCOLABFOLD_REV} \
    && sed -i -E "s#^colabfold = \{ git = \"git\+https://github.com/sokrypton/ColabFold\"#colabfold = { git = \"git+https://github.com/sokrypton/ColabFold\", rev = \"${COLABFOLD_REV}\"#" pyproject.toml \
    && grep -q "rev = \"${COLABFOLD_REV}\"" pyproject.toml \
    && PIXI_NO_TELEMETRY=1 /opt/pixi/bin/pixi install && PIXI_NO_TELEMETRY=1 /opt/pixi/bin/pixi run setup \
    && rm -rf /root/.cache/rattler /root/.cache/uv
RUN printf '%s\n' '#!/bin/sh' \
      '# colabfold from /opt/colabfold. params and the jax compile cache live on the volume (appdirs -> $XDG_CACHE_HOME/colabfold).' \
      '# no wsl workarounds here: colabfold itself sets TF_FORCE_UNIFIED_MEMORY/XLA_PYTHON_CLIENT_MEM_FRACTION on every platform.' \
      'export XDG_CACHE_HOME="${COLABFOLD_CACHE_HOME:-/workspace/cache}"' \
      'export JAX_COMPILATION_CACHE_DIR="${JAX_COMPILATION_CACHE_DIR:-/workspace/cache/jax}"' \
      'tool=$(basename "$0")' \
      'exec /opt/colabfold/localcolabfold/.pixi/envs/default/bin/$tool "$@"' > /usr/local/bin/colabfold-wrapper \
    && chmod 0755 /usr/local/bin/colabfold-wrapper \
    && for t in colabfold_batch colabfold_search colabfold_split_msas; do ln -sf colabfold-wrapper /usr/local/bin/$t; done \
    && colabfold_batch --help >/dev/null \
    && /opt/colabfold/localcolabfold/.pixi/envs/default/bin/python -c "import importlib.util as u, colabfold, jax, openmm; assert u.find_spec('jax_cuda12_plugin'), 'jax cuda12 plugin missing'; print('colabfold smoke ok: jax', jax.__version__)"

# ---- boltz-2: /opt/boltz (boltz on PATH via a wrapper; weights in $BOLTZ_CACHE on the volume) ----
RUN python3.12 -m venv /opt/boltz && /opt/boltz/bin/pip install --no-cache-dir --upgrade pip \
    && printf '%s\n' "torch==${BOLTZ_TORCH_VERSION}" "cuequivariance==${BOLTZ_CUEQ_VERSION}" "cuequivariance-torch==${BOLTZ_CUEQ_VERSION}" "cuequivariance-ops-cu12==${BOLTZ_CUEQ_VERSION}" "cuequivariance-ops-torch-cu12==${BOLTZ_CUEQ_VERSION}" > /opt/boltz/constraints.txt \
    && /opt/boltz/bin/pip install --no-cache-dir -c /opt/boltz/constraints.txt --extra-index-url ${BOLTZ_TORCH_INDEX} "${BOLTZ_SPEC}" \
    && /opt/boltz/bin/pip check \
    && printf '%s\n' '#!/bin/sh' 'export BOLTZ_CACHE="${BOLTZ_CACHE:-/workspace/cache/boltz}"' 'exec /opt/boltz/bin/boltz "$@"' > /usr/local/bin/boltz && chmod 0755 /usr/local/bin/boltz \
    && boltz predict --help >/dev/null \
    && /opt/boltz/bin/python -c "import torch, boltz, cuequivariance_torch; from importlib.metadata import version as v; assert torch.__version__ == '${BOLTZ_TORCH_VERSION}', f'boltz torch drifted to {torch.__version__}'; assert torch.version.cuda == '12.8', f'boltz torch is cuda {torch.version.cuda}'; assert v('cuequivariance-ops-torch-cu12') == '${BOLTZ_CUEQ_VERSION}', 'cuequivariance drifted'; print('boltz smoke ok: torch', torch.__version__, 'cuda', torch.version.cuda, 'cuequivariance', v('cuequivariance-torch'))"
# no inference smoke for boltz at build time: its first predict downloads the ccd/mols archive and the boltz-2 checkpoints
# (several gb) into BOLTZ_CACHE, which belongs on the volume, not in the image. the first real job does that once.
RUN printf '%s\n' '#!/bin/sh' 'exec /opt/esm/bin/python "$@"' > /usr/local/bin/esm-python && chmod 0755 /usr/local/bin/esm-python

# agentbus: the baked bootstrap/fallback copy, cloned from the PUBLIC mirror at a pinned ref. nothing is copied from the
# build context, so a private checkout can never end up in the image (build with `-` as context, see docs/runpod.md).
# the running copy normally comes from the volume at the provisioner's AGENTBUS_REF (boot.sh).
ARG AGENTBUS_REPO=https://github.com/stephenc0/agentbus-public.git
ARG AGENTBUS_REF
RUN set -e; \
    case "$AGENTBUS_REPO" in https://*/agentbus-public|https://*/agentbus-public.git) ;; \
      *) echo "refusing: AGENTBUS_REPO must be the public agentbus mirror (…/agentbus-public), got $AGENTBUS_REPO" >&2; exit 1;; esac; \
    echo "$AGENTBUS_REF" | grep -Eq '^([0-9a-f]{40}|v[0-9][0-9A-Za-z._-]{0,40})$' \
      || { echo "refusing: pass --build-arg AGENTBUS_REF=<40-hex public mirror commit or v-tag>" >&2; exit 1; }; \
    case "$AGENTBUS_REF" in v*) fetchref="refs/tags/$AGENTBUS_REF";; *) fetchref="$AGENTBUS_REF";; esac; \
    mkdir -p /opt/agentbus && cd /opt/agentbus && git init -q && git remote add origin "$AGENTBUS_REPO" \
    && git fetch -q --depth 1 origin "$fetchref" && git checkout -q --detach FETCH_HEAD \
    && { [ "${#AGENTBUS_REF}" != 40 ] || [ "$(git rev-parse HEAD)" = "$AGENTBUS_REF" ]; } \
    && npm ci --omit=dev --no-audit --no-fund && node bin/agentbus.mjs build-info >/dev/null \
    && echo "baked agentbus $(git rev-parse --short HEAD) from $AGENTBUS_REPO"

# every cache on the network volume, never in the image
ENV HF_HOME=/workspace/hf \
    HF_HUB_ENABLE_HF_TRANSFER=1 \
    TORCH_HOME=/workspace/cache/torch \
    BOLTZ_CACHE=/workspace/cache/boltz \
    COLABFOLD_CACHE_HOME=/workspace/cache \
    AGENTBUS_TASK_ROOT=/workspace/agentbus-tasks

WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bash", "/opt/agentbus/scripts/runpod/boot.sh"]
