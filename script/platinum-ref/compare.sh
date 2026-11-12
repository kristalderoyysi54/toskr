#!/bin/bash
# 原生版 Platinum 与原版逐像素对照：script/platinum-ref/compare.sh [--capture]
# --capture 先重抓原版参照（需要 ego-browser）。并排图（原版 / 原生 / 差异）与 summary.txt 在 native/testdata/platinum/out。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
[ "${1:-}" = "--capture" ] && "$ROOT/script/platinum-ref/capture.sh"
OUT="$ROOT/native/testdata/platinum/out"
mkdir -p "$OUT"
(cd "$ROOT/native" && TOSKR_COMPARE_DIR="$OUT" go test -count=1 -run 'TestComparePlatinum' .)
cat "$OUT/summary.txt"
