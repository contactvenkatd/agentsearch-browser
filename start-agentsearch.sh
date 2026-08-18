#!/bin/bash

set -euo pipefail

readonly BRIDGE_DIR="$HOME/chromium-fork/agent-bridge"
readonly BRIDGE_URL="http://127.0.0.1:9333/health"
readonly BRIDGE_LOG="/tmp/agentsearch-bridge.log"
readonly AGENTSEARCH_APP="$HOME/chromium-fork/src/out/Vanilla/AgentSearch.app/Contents/MacOS/AgentSearch"

bridge_is_healthy() {
  curl --fail --silent --max-time 1 "$BRIDGE_URL" >/dev/null 2>&1
}

if bridge_is_healthy; then
  echo "AgentSearch bridge is already running on port 9333."
else
  if lsof -nP -iTCP:9333 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Error: port 9333 is in use, but the AgentSearch bridge health check failed." >&2
    exit 1
  fi

  echo "Starting AgentSearch bridge (log: $BRIDGE_LOG)..."
  (
    cd "$BRIDGE_DIR"
    npm start >>"$BRIDGE_LOG" 2>&1
  ) &

  for _ in {1..20}; do
    if bridge_is_healthy; then
      break
    fi
    sleep 0.5
  done

  if ! bridge_is_healthy; then
    echo "Error: AgentSearch bridge did not start; see $BRIDGE_LOG." >&2
    exit 1
  fi
fi

if [[ ! -x "$AGENTSEARCH_APP" ]]; then
  echo "Error: AgentSearch executable not found at $AGENTSEARCH_APP." >&2
  exit 1
fi

profile_dir="$(mktemp -d /tmp/agentsearch-session.XXXXXX)"
echo "Launching AgentSearch with profile $profile_dir..."
"$AGENTSEARCH_APP" \
  --remote-debugging-port=9222 \
  --user-data-dir="$profile_dir"
