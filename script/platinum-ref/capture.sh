#!/bin/bash
# 抓原版（Tauri 前端）Platinum 参照图：script/platinum-ref/capture.sh [输出目录] [只抓的用例名,逗号分隔]
# 默认输出到 native/testdata/platinum。需要 ego-browser；dev 服务没开时自己起、抓完只关自己起的那个。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${1:-$ROOT/native/testdata/platinum}"
ONLY="${2:-}"
VITE_PID=""
if ! curl -s -o /dev/null http://localhost:1420/; then
  (cd "$ROOT" && exec pnpm dev >/dev/null 2>&1) &
  VITE_PID=$!
  for _ in $(seq 1 40); do curl -s -o /dev/null http://localhost:1420/ && break; sleep 0.5; done
fi
cleanup() { if [ -n "$VITE_PID" ]; then pkill -P "$VITE_PID" 2>/dev/null || true; kill "$VITE_PID" 2>/dev/null || true; fi; }
trap cleanup EXIT
{ printf 'const ROOT = %s; const OUT = %s; const ONLY = %s;\n' "\"$ROOT\"" "\"$OUT\"" "\"$ONLY\""; cat "$ROOT/script/platinum-ref/capture.mjs"; } | ego-browser nodejs
