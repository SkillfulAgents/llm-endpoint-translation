#!/usr/bin/env bash
# Runs the footprint + concurrent-stream benchmark inside the agent container image.
# Usage: bench/run.sh [image]   (needs `npm run build` and bench/captures from bench/capture.mjs)
set -euo pipefail

IMAGE="${1:-ghcr.io/skillfulagents/superagent-agent-container-base:0.5.30}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/bench/results"

docker run --rm --entrypoint bash \
  -e DURATION_S="${DURATION_S:-30}" -e EVENT_DELAY_MS="${EVENT_DELAY_MS:-15}" -e CONCURRENCY_LEVELS="${CONCURRENCY_LEVELS:-1 10 50}" \
  -v "$ROOT/dist:/bench/dist:ro" -v "$ROOT/bench:/bench/bench" \
  "$IMAGE" -c '
set -euo pipefail
cd /bench/bench
echo "node $(node --version), $(nproc) cpus" >&2
for variant in bare http http+library; do
  for run in 1 2 3; do node --expose-gc idle.mjs "$variant"; done
done > results/idle.jsonl

node mock-upstream.mjs 2>/dev/null & mock=$!
: > results/load.jsonl
for backend in passthrough responses chat; do
  for n in $CONCURRENCY_LEVELS; do
    BACKEND=$backend UPSTREAM_BASE_URL=http://127.0.0.1:8790 UPSTREAM_MODEL=bench PROXY_LOG=0 node proxy.mjs 2>/dev/null & proxy=$!
    sleep 5
    BACKEND=$backend CONCURRENCY=$n node load.mjs | tee -a results/load.jsonl >&2
    kill $proxy; wait $proxy 2>/dev/null || true
  done
done
kill $mock
'
echo "results in $ROOT/bench/results/{idle,load}.jsonl"
