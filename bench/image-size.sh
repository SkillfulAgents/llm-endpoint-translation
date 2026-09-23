#!/usr/bin/env bash
# Image size delta from installing a release tarball into the agent container image.
# Usage: bench/image-size.sh [tarball-url] [image]
set -euo pipefail

TARBALL="${1:-https://github.com/SkillfulAgents/llm-endpoint-translation/releases/download/v0.1.0/llm-endpoint-translation-0.1.0.tgz}"
IMAGE="${2:-ghcr.io/skillfulagents/superagent-agent-container-base:0.5.30}"
TAG="llm-endpoint-translation-size-probe"

docker build -q -t "$TAG" - >/dev/null <<EOF
FROM $IMAGE
USER root
RUN mkdir -p /opt/probe && cd /opt/probe && npm init -y >/dev/null && npm install --omit=dev --no-audit --no-fund "$TARBALL"
EOF

base=$(docker image inspect -f '{{.Size}}' "$IMAGE")
probe=$(docker image inspect -f '{{.Size}}' "$TAG")
installed=$(docker run --rm --entrypoint du "$TAG" -sb /opt/probe/node_modules | cut -f1)
deps=$(docker run --rm --entrypoint ls "$TAG" /opt/probe/node_modules | tr '\n' ' ')
docker rmi -f "$TAG" >/dev/null

echo "base image:      $base bytes"
echo "with library:    $probe bytes"
echo "image delta:     $((probe - base)) bytes"
echo "node_modules:    $installed bytes ($deps)"
