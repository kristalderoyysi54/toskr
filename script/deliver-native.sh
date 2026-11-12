#!/bin/bash
# 每轮改动的交付：打包迭代期 Toskr Native → 校验 → 重启 → 核对新进程确实跑的是本轮新包。
# 输出三行「→ 已构建 / 已校验签名 / 已启动 pid」即验收通过；出现 ✗ 或非零退出须排查。
# 只动迭代期身份（com.toskr.native），不碰 /Applications/Toskr.app（正式版）。
# 并行会话检查不在脚本里：跑之前先看 git status 与他人改动的 mtime（见 CLAUDE.md「改动交付约定」）。
set -euo pipefail
cd "$(dirname "$0")/../native"

ID=$(python3 -c 'import json; print(json.load(open("mygo.json"))["identifier"])')
VERSION=$(python3 -c 'import json; print(json.load(open("mygo.json"))["version"])')
[[ "$ID" == com.toskr.native ]] \
  || { echo "✗ mygo.json 身份是 ${ID}（release-native.sh 中断残留？），先 git checkout -- native/mygo.json"; exit 1; }

APP="$PWD/build/darwin-arm64/Toskr Native.app"
BIN="$APP/Contents/MacOS/Toskr Native"
LOG="$HOME/Library/Application Support/com.toskr.native/toskr-diag.log"
STAMP=$(mktemp)
trap 'rm -f "$STAMP"' EXIT

# 构建失败直接退出（set -e），不会走到重启：正在跑的旧实例保持不动
go tool mygo build
[[ "$BIN" -nt "$STAMP" ]] \
  || { echo "✗ 二进制没有更新（$(stat -f '%Sm' "$BIN")），未重启"; exit 1; }
echo "→ 已构建 v${VERSION}（二进制 $(stat -f '%Sm' "$BIN")）"

codesign --verify --deep --strict "$APP" \
  || { echo "✗ 签名校验失败，未重启"; exit 1; }
echo "→ 已校验签名"

# open 不会重启已在运行的应用：先杀旧进程并等它退出
pkill -x "Toskr Native" || true
for _ in {1..20}; do pgrep -x "Toskr Native" >/dev/null || break; sleep 0.25; done
sleep 1
# 刚退出时 LaunchServices 偶发 -600：稍等重试
for _ in 1 2 3; do open "$APP" && break; sleep 2; done

PID=""
for _ in {1..40}; do
  PID=$(pgrep -x "Toskr Native" | head -n 1 || true)
  [[ -n "$PID" ]] && grep -aqF "启动 v$VERSION pid=$PID" "$LOG" 2>/dev/null && break
  sleep 0.25
done
[[ -n "$PID" ]] || { echo "✗ 没有拉起 Toskr Native，手动打开 ${APP}"; exit 1; }
EXE=$(ps -o comm= -p "$PID")
[[ "$EXE" == "$BIN" ]] \
  || { echo "✗ 运行中的是 ${EXE}，不是本轮构建"; exit 1; }
grep -aqF "启动 v$VERSION pid=$PID" "$LOG" \
  || { echo "✗ 诊断日志没有「启动 v${VERSION} pid=${PID}」"; exit 1; }
echo "→ 已启动 pid=${PID}，诊断日志自报 v${VERSION}"
