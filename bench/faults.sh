#!/usr/bin/env bash
# Fault handling through a real Claude Code session, inside the agent container image.
# Mock upstream faults (truncate / drop / in-stream error) always run; with UPSTREAM_API_KEY set,
# also a live cancel mid-stream and a live upstream HTTP error.
# Usage: [UPSTREAM_API_KEY=...] bench/faults.sh <responses|chat> <live-model> [image]
set -euo pipefail

BACKEND="$1"
MODEL="$2"
IMAGE="${3:-ghcr.io/skillfulagents/superagent-agent-container-base:0.5.30}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

docker run --rm --entrypoint bash \
  -e UPSTREAM_API_KEY="${UPSTREAM_API_KEY:-}" -e BACKEND="$BACKEND" -e LIVE_MODEL="$MODEL" \
  -e UPSTREAM_LIVE_URL="${UPSTREAM_BASE_URL:-https://api.openai.com/v1}" \
  -e CHAT_TOKEN_LIMIT_FIELD="${CHAT_TOKEN_LIMIT_FIELD:-}" -e CHAT_OMIT_REASONING_EFFORT="${CHAT_OMIT_REASONING_EFFORT:-}" \
  -e CLAUDE_CODE_MAX_OUTPUT_TOKENS="${CLAUDE_CODE_MAX_OUTPUT_TOKENS:-16000}" -e CLAUDE_CODE_MAX_RETRIES=1 \
  -v "$ROOT/dist:/bench/dist:ro" -v "$ROOT/bench:/bench/bench:ro" \
  "$IMAGE" -c '
cd /bench/bench
mkdir -p /tmp/work
stats() { curl -s http://127.0.0.1:8787/__stats | jq -c "{requests, streams, aborted, upstreamErrors}"; }
claude_run() {
  (cd /tmp/work && ANTHROPIC_BASE_URL=http://127.0.0.1:8787 ANTHROPIC_API_KEY=bench UPSTREAM_API_KEY= timeout 120 \
    claude -p "$1" --output-format stream-json --verbose --include-partial-messages --permission-mode bypassPermissions)
}
result() { jq -c "select(.type==\"result\") | {is_error, result: (.result // \"\")[0:200]}" "$1"; }
deltas() { jq -s "map(select(.type==\"stream_event\" and .event.type==\"content_block_delta\")) | length" "$1" 2>/dev/null || echo 0; }
start_proxy() { node proxy.mjs 2>/tmp/proxy.log & proxy=$!; sleep 1; }
stop_proxy() { kill $proxy 2>/dev/null; wait $proxy 2>/dev/null || true; }

for fault in truncate drop error; do
  MOCK_FAULT=$fault node mock-upstream.mjs 2>/dev/null & mock=$!
  UPSTREAM_BASE_URL=http://127.0.0.1:8790 UPSTREAM_MODEL=mock start_proxy
  claude_run "Say hi." > /tmp/out.jsonl 2>/dev/null || true
  echo "== mock $fault: $(result /tmp/out.jsonl) proxy=$(stats)"
  stop_proxy; kill $mock; wait $mock 2>/dev/null || true
done

[ -z "$UPSTREAM_API_KEY" ] && { echo "== live cases skipped (no UPSTREAM_API_KEY)"; exit 0; }

UPSTREAM_BASE_URL=$UPSTREAM_LIVE_URL UPSTREAM_MODEL=$LIVE_MODEL start_proxy
claude_run "Write a 1500-word essay about the history of maps. No tools." > /tmp/cancel.jsonl 2>/dev/null & cl=$!
for _ in $(seq 60); do
  [ "$(deltas /tmp/cancel.jsonl)" -ge 20 ] && break
  sleep 0.5
done
pkill -f "claude -p" || true; wait $cl 2>/dev/null || true; sleep 2
echo "== live cancel: deltas_before_kill=$(deltas /tmp/cancel.jsonl) proxy=$(stats)"
stop_proxy

UPSTREAM_BASE_URL=$UPSTREAM_LIVE_URL UPSTREAM_MODEL=no-such-model-xyz start_proxy
claude_run "Say hi." > /tmp/out.jsonl 2>/dev/null || true
echo "== live upstream error: $(result /tmp/out.jsonl) proxy=$(stats)"
stop_proxy
'
