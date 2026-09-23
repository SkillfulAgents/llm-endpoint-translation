#!/usr/bin/env bash
# Real Claude Code tool loop (Bash -> Read -> answer) through bench/proxy.mjs inside the agent container image.
# Usage: UPSTREAM_API_KEY=... bench/claude-loop.sh <responses|chat> <upstream-model> [image]
# Extra proxy env passes through: UPSTREAM_BASE_URL, CHAT_TOKEN_LIMIT_FIELD, CHAT_OMIT_REASONING_EFFORT.
set -euo pipefail

BACKEND="$1"
MODEL="$2"
IMAGE="${3:-ghcr.io/skillfulagents/superagent-agent-container-base:0.5.30}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
: "${UPSTREAM_API_KEY:?set UPSTREAM_API_KEY}"

docker run --rm --entrypoint bash \
  -e UPSTREAM_API_KEY -e BACKEND="$BACKEND" -e UPSTREAM_MODEL="$MODEL" \
  -e UPSTREAM_BASE_URL="${UPSTREAM_BASE_URL:-https://api.openai.com/v1}" \
  -e CHAT_TOKEN_LIMIT_FIELD="${CHAT_TOKEN_LIMIT_FIELD:-}" -e CHAT_OMIT_REASONING_EFFORT="${CHAT_OMIT_REASONING_EFFORT:-}" \
  -e CLAUDE_CODE_MAX_OUTPUT_TOKENS="${CLAUDE_CODE_MAX_OUTPUT_TOKENS:-16000}" \
  -v "$ROOT/dist:/bench/dist:ro" -v "$ROOT/bench:/bench/bench:ro" \
  "$IMAGE" -c '
node /bench/bench/proxy.mjs 2>/tmp/proxy.log &
sleep 1
mkdir -p /tmp/work && cd /tmp/work
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 ANTHROPIC_API_KEY=bench UPSTREAM_API_KEY= timeout 180 \
  claude -p "Use the Bash tool to run: ls /etc | head -5 > notes.txt. Then use the Read tool to read notes.txt. Then reply with exactly the number of lines in it." \
  --output-format stream-json --verbose --permission-mode bypassPermissions > /tmp/out.jsonl 2>/tmp/claude.err || true
jq -c "select(.type==\"assistant\") | .message.content[] | {type, name}" /tmp/out.jsonl
jq -c "select(.type==\"result\") | {is_error, result, num_turns}" /tmp/out.jsonl
cat /tmp/proxy.log
'
