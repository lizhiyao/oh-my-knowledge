#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${PROJECT_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
OBSERVATIONS_DIR="${OBSERVATIONS_DIR:-$(cd "$PROJECT_DIR/.." && pwd)/_raw_files/openclaw_sessions}"
TRACE_DIR="${OPENCLAW_TRACE_DIR:-$OBSERVATIONS_DIR}"
PORT="${PORT:-7766}"
HOST="${HOST:-127.0.0.1}"
SOFT_STANDARD_MODEL="${SOFT_STANDARD_MODEL:-sonnet}"
SKIP_SKILL_EXTRACT="${SKIP_SKILL_EXTRACT:-0}"

cd "$PROJECT_DIR"

stop_existing_studio() {
  if ! command -v lsof >/dev/null 2>&1; then
    return
  fi

  local pids
  pids="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -z "$pids" ]]; then
    return
  fi

  echo "Stopping existing studio process on $HOST:$PORT: $pids"
  kill $pids
  for _ in {1..20}; do
    if [[ -z "$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)" ]]; then
      return
    fi
    sleep 0.2
  done

  echo "Port $PORT is still occupied after stopping old studio process." >&2
  exit 1
}

if [[ ! -d "$TRACE_DIR" ]]; then
  echo "OpenClaw trace folder not found: $TRACE_DIR" >&2
  exit 1
fi

npm run build

node dist/src/cli/index.js observe ingest "$TRACE_DIR" \
  --output-dir "$OBSERVATIONS_DIR"

node dist/src/cli/index.js observe inbox \
  --input-dir "$OBSERVATIONS_DIR" \
  --by-skill

if [[ "$SKIP_SKILL_EXTRACT" != "1" ]]; then
  skill_extract_output="$(
    node dist/src/cli/index.js observe inbox \
      --input-dir "$OBSERVATIONS_DIR" \
      --skill-extract \
      --model "$SOFT_STANDARD_MODEL" 2>&1
  )" || {
    if grep -Eq -- "--skill-extract|skill-extract|Unknown option|unknown option|Unexpected option|unexpected option" <<<"$skill_extract_output"; then
      echo "Current local CLI does not support observe inbox --skill-extract; skipping skill extraction." >&2
    else
      echo "$skill_extract_output" >&2
      exit 1
    fi
  }
  if [[ -n "${skill_extract_output:-}" ]]; then
    echo "$skill_extract_output"
  fi
fi

echo
echo "Open the report:"
echo "http://$HOST:$PORT/observations/inbox"
echo

stop_existing_studio

node dist/src/cli/index.js studio \
  --host "$HOST" \
  --port "$PORT" \
  --observations-dir "$OBSERVATIONS_DIR"
