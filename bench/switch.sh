#!/usr/bin/env bash
# One Claude Code conversation resumed across backends/models, inside the agent container image:
# Responses (model A) → Chat Completions → Responses (model B) → Responses (model B, replaying A's scope) → Responses (model A).
# Checks that tool history survives each hop and that encrypted reasoning only replays under its own scope.
# Usage: UPSTREAM_API_KEY=... bench/switch.sh [responses-model-a] [responses-model-b] [chat-model] [image]
set -euo pipefail

MODEL_A="${1:-gpt-5.4-mini}"
MODEL_B="${2:-gpt-5.4}"
CHAT_MODEL="${3:-gpt-4.1-mini}"
IMAGE="${4:-ghcr.io/skillfulagents/superagent-agent-container-base:0.5.30}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
: "${UPSTREAM_API_KEY:?set UPSTREAM_API_KEY}"

docker run --rm --entrypoint bash \
  -e UPSTREAM_API_KEY -e MODEL_A="$MODEL_A" -e MODEL_B="$MODEL_B" -e CHAT_MODEL="$CHAT_MODEL" \
  -e UPSTREAM_BASE_URL="${UPSTREAM_BASE_URL:-https://api.openai.com/v1}" \
  -e CLAUDE_CODE_MAX_OUTPUT_TOKENS="${CLAUDE_CODE_MAX_OUTPUT_TOKENS:-16000}" -e CLAUDE_CODE_MAX_RETRIES=1 \
  -v "$ROOT/dist:/bench/dist:ro" -v "$ROOT/bench:/bench/bench:ro" \
  "$IMAGE" -c '
mkdir -p /tmp/work && cd /tmp/work
session=""
turn() {
  local label="$1" backend="$2" model="$3" scope="$4" prompt="$5"
  BACKEND=$backend UPSTREAM_MODEL=$model REPLAY_SCOPE=$scope CHAT_OMIT_REASONING_EFFORT=1 \
    node /bench/bench/proxy.mjs 2>/tmp/proxy.log & local proxy=$!
  sleep 1
  ANTHROPIC_BASE_URL=http://127.0.0.1:8787 ANTHROPIC_API_KEY=bench UPSTREAM_API_KEY= timeout 180 \
    claude -p "$prompt" ${session:+--resume "$session"} --output-format stream-json --verbose \
    --permission-mode bypassPermissions > /tmp/out.jsonl 2>/tmp/claude.err || true
  kill $proxy; wait $proxy 2>/dev/null || true
  session=$(jq -r "select(.type==\"result\") | .session_id" /tmp/out.jsonl)
  echo "== $label [$backend $model scope=${scope:-none}]"
  echo "   tools: $(jq -c "[select(.type==\"assistant\") | .message.content[] | select(.type==\"tool_use\") | .name]" /tmp/out.jsonl | jq -sc add)"
  echo "   result: $(jq -c "select(.type==\"result\") | {is_error, result: (.result // \"\")[0:160]}" /tmp/out.jsonl)"
  grep -E "\[proxy\] (claude|upstream)" /tmp/proxy.log | sed "s/^/   /"
}

turn "1 start" responses "$MODEL_A" "openai/$MODEL_A" \
  "Use the Bash tool to run: cat /proc/sys/kernel/random/uuid | cut -c1-8 > token.txt. Then use the Read tool to read token.txt. Reply with only the token."
echo "   token.txt: $(cat token.txt)"
turn "2 switch to chat" chat "$CHAT_MODEL" "" \
  "Without using any tools: what token did you read earlier? Reply with only the token."
turn "3 switch model" responses "$MODEL_B" "openai/$MODEL_B" \
  "Use the Bash tool to run: wc -c < token.txt. Reply with the byte count and the token you read earlier."
turn "4 wrong scope (control)" responses "$MODEL_B" "openai/$MODEL_A" \
  "Without using any tools, reply with only the token you read earlier."
turn "5 back to start" responses "$MODEL_A" "openai/$MODEL_A" \
  "Without using any tools, reply with only the token you read earlier."
'
