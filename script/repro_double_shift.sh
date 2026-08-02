#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_BUNDLE="$ROOT_DIR/src-tauri/target/release/bundle/macos/Toskr.app"
PROCESS_NAME="toskr"
probe_file="$(mktemp -t toskr-hotkey-probe)"
probe_name="$(basename "$probe_file")"

if [[ ! -d "$APP_BUNDLE" ]]; then
  echo "FAIL: app bundle not found: $APP_BUNDLE" >&2
  exit 2
fi

cleanup() {
  pkill -x "$PROCESS_NAME" >/dev/null 2>&1 || true
  osascript \
    -e 'tell application "TextEdit"' \
    -e "if exists document \"$probe_name\" then close document \"$probe_name\" saving no" \
    -e 'end tell' >/dev/null 2>&1 || true
  rm -f "$probe_file"
}
trap cleanup EXIT

pkill -x "$PROCESS_NAME" >/dev/null 2>&1 || true
/usr/bin/open -n "$APP_BUNDLE"

app_pid=""
for _ in {1..40}; do
  app_pid="$(pgrep -x "$PROCESS_NAME" | head -n 1 || true)"
  [[ -n "$app_pid" ]] && break
  sleep 0.1
done

if [[ -z "$app_pid" ]]; then
  echo "FAIL: $PROCESS_NAME did not start" >&2
  exit 1
fi

sleep 1

# 用一个空白 TextEdit 文档作为确定性前台：无选区、⌘C 不改变剪贴板，
# 因此反馈环稳定覆盖“捕获为空 → 显示面板”。
/usr/bin/open -a TextEdit "$probe_file"
sleep 0.5

read_state() {
  osascript \
    -e 'tell application "System Events"' \
    -e "set targetProcess to first application process whose unix id is $app_pid" \
    -e 'tell targetProcess to get {frontmost, count of windows}' \
    -e 'end tell'
}

before="$(read_state)"

osascript \
  -e 'tell application "System Events"' \
  -e 'key down shift' \
  -e 'delay 0.04' \
  -e 'key up shift' \
  -e 'delay 0.12' \
  -e 'key down shift' \
  -e 'delay 0.04' \
  -e 'key up shift' \
  -e 'end tell'

sleep 1.2
after="$(read_state)"

echo "before: $before"
echo "after:  $after"

if [[ "$after" == *,\ 1 ]]; then
  echo "PASS: double Shift showed the Toskr panel"
  exit 0
fi

echo "FAIL: double Shift did not show the Toskr panel" >&2
exit 1
