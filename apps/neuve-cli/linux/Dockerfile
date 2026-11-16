# syntax=docker/dockerfile:1
# The Linux build of Neuve for the cloud replay machines (10.129): the CLI, Neuve Graph and the
# parser's glibc binding, installed by scripts/install-linux.ts into /opt/neuve with a manifest of
# what was installed and the commits it came from. The semantic workers are left out: the replays
# run with --leads bm25. The image holds no sign-in; see README.md beside this file.
#
# Build from the workspace root with the Graph submodule checked out (the build context carries no
# Git metadata, so the commits are passed in):
#
#   docker build -f apps/neuve-cli/linux/Dockerfile -t neuve-linux \
#     --build-arg NEUVE_COMMIT="$(git rev-parse HEAD)" \
#     --build-arg NEUVE_DIRTY="$(test -z "$(git status --porcelain --untracked-files=no)" && echo false || echo true)" \
#     --build-arg NEUVE_GRAPH_REVISION="$(git -C apps/neuve-graph rev-parse HEAD)" .

# Bun 1.4.4, the version the workspace's @types/bun follows, and Go as apps/neuve-graph/mise.toml
# pins it. Both build stages are Debian bookworm; the runtime is trixie, whose glibc is newer and
# backward compatible, so the cgo-linked Graph engine and Bun's binaries built on bookworm run there.
FROM oven/bun:1.4.4-debian@sha256:93d5032fe06d163427822dc1598f420363759bb18155c9cc90eb1be05a64a19e AS bun

FROM golang:1.27-bookworm@sha256:972b4110ba0f47539a975c31e52c64765e1ff19f2d74469ae4a595c6676e80a5 AS build
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /workspace
COPY . .
# A build behind a TLS-inspecting proxy passes its certificate authority as the optional build secret
# build-ca (docker build --secret id=build-ca,src=<bundle>); the downloads below then trust it. It
# never reaches the image.
RUN --mount=type=secret,id=build-ca,required=false \
    if [ -s /run/secrets/build-ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build-ca; fi; \
    bun install --frozen-lockfile
# What `bun run build:graph` runs; tree-sitter's grammars need cgo.
RUN --mount=type=secret,id=build-ca,required=false \
    if [ -s /run/secrets/build-ca ]; then export SSL_CERT_FILE=/run/secrets/build-ca; fi; \
    CGO_ENABLED=1 go -C apps/neuve-graph build -o entire-graph ./cmd/entire-graph
ARG NEUVE_COMMIT
ARG NEUVE_DIRTY
ARG NEUVE_GRAPH_REVISION
RUN bun ./apps/neuve-cli/scripts/install-linux.ts --prefix /opt/neuve \
      --commit "$NEUVE_COMMIT" --dirty "$NEUVE_DIRTY" --graph-revision "$NEUVE_GRAPH_REVISION"
# The oldest git Neuve's reads support, read from the one place that sets it (git-objects.ts's
# MINIMUM_GIT) for the runtime's check below. A changed line fails the build rather than guess.
RUN sed -nE 's/^const MINIMUM_GIT: readonly \[number, number\] = \[([0-9]+), ([0-9]+)\];$/\1.\2/p' \
      packages/harness/src/git-objects.ts > /opt/git-minimum \
  && grep -qxE '[0-9]+\.[0-9]+' /opt/git-minimum

# The runtime stays root: Modal runs functions as root and mounts its volumes for root, and the
# refresher writes the sign-in there. A machine that runs as another user needs the volume's
# sign-in folder owned by that user.
# Trixie for its git (2.47): Precompute reads attributes from a revision with --attr-source, which
# needs git 2.42 or newer, and bookworm's is 2.39.
FROM debian:trixie-slim@sha256:62bd423aeee912639ca8ee681c2b762cb3e25137e0a92b20be455898a9f034ad
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /opt/git-minimum /tmp/git-minimum
# Refuse an image whose git is older than Neuve's minimum.
RUN need="$(cat /tmp/git-minimum)" \
  && have="$(git --version | sed -nE 's/^git version ([0-9]+\.[0-9]+).*/\1/p')" \
  && [ -n "$have" ] \
  && [ "$(printf '%s\n%s\n' "$need" "$have" | sort -V | head -1)" = "$need" ] \
  || { echo "git $(git --version) is older than Neuve's minimum $(cat /tmp/git-minimum)" >&2; exit 1; }
COPY --from=build /opt/neuve /opt/neuve
ENV PATH=/opt/neuve/bin:$PATH
RUN neuve auth --help > /dev/null && /opt/neuve/lib/neuve/entire-graph version
