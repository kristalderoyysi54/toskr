#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-run}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_BUNDLE="$ROOT_DIR/src-tauri/target/release/bundle/macos/Toskr.app"
PROCESS_NAME="toskr"
BUNDLE_ID="com.toskr.app"

pkill -x "$PROCESS_NAME" >/dev/null 2>&1 || true

cd "$ROOT_DIR"
pnpm build:app

open_app() {
  /usr/bin/open -n "$APP_BUNDLE"
}

wait_for_pid() {
  local app_pid=""
  for _ in {1..50}; do
    app_pid="$(pgrep -x "$PROCESS_NAME" | head -n 1 || true)"
    if [[ -n "$app_pid" ]]; then
      echo "$app_pid"
      return 0
    fi
    sleep 0.1
  done
  return 1
}

case "$MODE" in
  run)
    open_app
    ;;
  --debug|debug)
    open_app
    app_pid="$(wait_for_pid)"
    lldb -p "$app_pid"
    ;;
  --logs|logs)
    open_app
    wait_for_pid >/dev/null
    /usr/bin/log stream --info --style compact --predicate "process == \"$PROCESS_NAME\""
    ;;
  --telemetry|telemetry)
    open_app
    wait_for_pid >/dev/null
    /usr/bin/log stream --info --style compact --predicate "subsystem == \"$BUNDLE_ID\""
    ;;
  --verify|verify)
    open_app
    app_pid="$(wait_for_pid)"
    codesign --verify --deep --strict "$APP_BUNDLE"
    echo "PASS: $APP_BUNDLE is running as PID $app_pid"
    ;;
  *)
    echo "usage: $0 [run|--debug|--logs|--telemetry|--verify]" >&2
    exit 2
    ;;
esac
