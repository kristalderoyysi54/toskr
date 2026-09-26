#!/bin/bash
# 把刚打好的包覆盖安装到 /Applications，使应用文件夹里始终是最新构建。
# pnpm build:app 与 release.sh 打包成功后自动调用；也可单独执行。
# 环境变量: OPEN_APP=0 只覆盖不启动；INSTALL_APP=0 整步跳过。
set -euo pipefail
cd "$(dirname "$0")/.."

[[ "${INSTALL_APP:-1}" == 0 ]] && { echo "→ INSTALL_APP=0，跳过覆盖 /Applications"; exit 0; }

ROOT=$(pwd -P)
SRC="$ROOT/src-tauri/target/release/bundle/macos/Toskr.app"
DEST=/Applications/Toskr.app
STAGE=/Applications/.Toskr.app.installing
LOG="$HOME/Library/Application Support/com.toskr.app/toskr-diag.log"
VERSION=$(python3 -c 'import json; print(json.load(open("src-tauri/tauri.conf.json"))["version"])')

# 产物不在 src-tauri/target 下（CARGO_TARGET_DIR 残留）或签名不完整时，保留上一版不覆盖
[[ -d "$SRC" && "$(cd "$SRC" && pwd -P)" == "$ROOT/src-tauri/target/"* ]] \
  || { echo "✗ 构建产物不在 src-tauri/target 下，未覆盖 /Applications"; exit 1; }
codesign --verify --deep --strict "$SRC" \
  || { echo "✗ 构建产物签名校验失败，未覆盖 /Applications"; exit 1; }

# 先完整拷到暂存目录并校验，再替换：拷贝中途失败时 /Applications 仍是可用的上一版
rm -rf "$STAGE"
ditto "$SRC" "$STAGE"
codesign --verify --deep --strict "$STAGE"
cmp "$SRC/Contents/MacOS/toskr" "$STAGE/Contents/MacOS/toskr"

pkill -x toskr && sleep 1 || true
rm -rf "$DEST"
mv "$STAGE" "$DEST"
codesign --verify --deep --strict "$DEST"
cmp "$SRC/Contents/MacOS/toskr" "$DEST/Contents/MacOS/toskr"
echo "→ 已覆盖 ${DEST}（v${VERSION}，codesign 通过，二进制与构建产物一致）"

# 纯前端批次版本号不变，只能靠内嵌资源键（明文）确认前端是新的
JS=$(find dist/assets -maxdepth 1 -name 'index-*.js' -exec basename {} \; 2>/dev/null | head -n 1)
if [[ -n "$JS" ]]; then
  if grep -aqF "$JS" "$DEST/Contents/MacOS/toskr"; then
    echo "→ 内嵌前端 ${JS} 与 dist 一致"
  else
    echo "⚠ 二进制内未找到 ${JS}：前端可能是旧的（纯前端改动需先 touch src-tauri/src/lib.rs 再构建）"
  fi
fi

[[ "${OPEN_APP:-1}" == 0 ]] && exit 0

open "$DEST"
for _ in {1..40}; do
  PID=$(pgrep -x toskr | head -n 1 || true)
  [[ -n "$PID" ]] && grep -qF "启动 v$VERSION pid=$PID" "$LOG" 2>/dev/null && break
  sleep 0.25
done
if [[ -n "${PID:-}" ]] && grep -qF "启动 v$VERSION pid=$PID" "$LOG" 2>/dev/null; then
  echo "→ 已启动 pid=${PID}（$(ps -o comm= -p "${PID}")），诊断日志自报 v${VERSION}"
else
  echo "⚠ 未在诊断日志中看到「启动 v${VERSION} pid=${PID:-?}」，请手动从应用程序文件夹打开核对"
fi

# 数据健康检查：每次部署都是真实数据的冷启动水合（2026-09-25 曾因校验失败以默认态覆盖数据）。
# 比对本次与上一次「数据水合完成」的笔记数；水合失败或笔记骤降立即醒目报警。
START_LINE=$(grep -anF "启动 v$VERSION pid=${PID:-none}" "$LOG" 2>/dev/null | tail -n 1 | cut -d: -f1 || true)
[[ -z "$START_LINE" ]] && exit 0
HYDRATION=""
for _ in {1..60}; do
  HYDRATION=$(tail -n "+$START_LINE" "$LOG" | grep -aE "数据水合(完成|失败)" | head -n 1 || true)
  [[ -n "$HYDRATION" ]] && break
  sleep 0.25
done
PREVIOUS=$(head -n "$START_LINE" "$LOG" | grep -a "数据水合完成" | tail -n 1 || true)
notes_of() { sed -nE 's/.*笔记=([0-9]+).*/\1/p' <<<"$1"; }
if [[ -z "$HYDRATION" ]]; then
  echo "⚠ 15 秒内未见「数据水合」日志：请打开面板确认数据是否正常"
elif [[ "$HYDRATION" == *"数据水合失败"* ]]; then
  echo "‼ 数据水合失败：新版本读不了现有数据，已冻结写入（磁盘数据未被改动）。"
  echo "   不要继续使用这一版；修复后重新部署。启动恢复点在数据目录 recovery/pre-launch-*.bak"
  exit 3
else
  NOW=$(notes_of "$HYDRATION")
  BEFORE=$(notes_of "$PREVIOUS")
  echo "→ 数据水合正常：${HYDRATION#* }${BEFORE:+（上次启动 笔记=${BEFORE}）}"
  if [[ -n "$BEFORE" && "$BEFORE" -ge 10 && $((NOW * 2)) -lt "$BEFORE" ]]; then
    echo "‼ 笔记数从 ${BEFORE} 骤降到 ${NOW}：可能发生数据丢失，请立即核对面板。"
    echo "   启动恢复点在数据目录 recovery/pre-launch-*.bak，可用「设置 → 数据 → 导入」合并恢复"
    exit 4
  fi
fi
