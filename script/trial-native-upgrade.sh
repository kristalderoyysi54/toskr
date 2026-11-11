#!/bin/bash
# 在「另一个 macOS 用户账户」里演练「旧版 → 原生 1.0」的升级，不碰主账户的数据、钥匙串和 /Applications。
# 钥匙串条目与辅助功能 / 输入监控授权都是按用户账户隔离的，所以用一个新账户就是一套干净环境。
#
# 步骤（prepare 在主账户跑，其余在测试账户里跑）：
#   主账户：  DRY_RUN=1 ./script/release-native.sh 1.0.0 && ./script/trial-native-upgrade.sh prepare
#   测试账户：/Users/Shared/toskr-trial/trial.sh install     # 把旧版 0.22.4 装到 ~/Applications 并打开
#             → 在旧版里授权辅助功能与输入监控、捕获几条内容、建个任务、（可选）开机启动，然后退出旧版
#             /Users/Shared/toskr-trial/trial.sh upgrade     # 按旧版更新器的装法原位换成原生包并打开
#             /Users/Shared/toskr-trial/trial.sh check       # 读诊断日志，逐项给出结论
#             /Users/Shared/toskr-trial/trial.sh clean       # 删掉演练装的应用与数据（钥匙串条目需在「钥匙串访问」里手动删）
# upgrade 做的事与旧版更新器一致：解包时跳过第一级目录、整体替换原 .app、再启动（tauri-plugin-updater install_inner）。
set -euo pipefail
KIT=/Users/Shared/toskr-trial
APP="$HOME/Applications/Toskr.app"
OLD_DATA="$HOME/Library/Application Support/com.toskr.app"
NEW_LOG="$OLD_DATA/v1/toskr-diag.log"

case "${1:-}" in
prepare)
  cd "$(dirname "$0")/.."
  SRC=native/build-release/legacy/Toskr.app.tar.gz
  [[ -f "$SRC" ]] || { echo "先跑 DRY_RUN=1 ./script/release-native.sh 1.0.0"; exit 1; }
  mkdir -p "$KIT"
  cp "$SRC" "$KIT/Toskr.app.tar.gz"
  cp "$0" "$KIT/trial.sh"; chmod 755 "$KIT/trial.sh"
  DMG=$(ls "$KIT"/Toskr_0.22.4_*.dmg 2>/dev/null | head -1 || true)
  if [[ -z "$DMG" ]]; then
    gh release download v0.22.4 --repo kristalderoyysi54/toskr --pattern '*.dmg' --dir "$KIT"
  fi
  id -un > "$KIT/.owner"; chmod 1777 "$KIT"   # 记下主账户名（其余子命令拒绝在主账户里运行）；测试账户要能往这里写校验值
  chmod -R a+rX "$KIT"
  echo "→ 演练包已放到 ${KIT}；切到测试账户后运行 $KIT/trial.sh install"
  ;;
install)
  [[ "$(id -un)" != "$(cat "$KIT/.owner" 2>/dev/null)" ]] || { echo "请在测试账户里运行，不要在主账户"; exit 1; }
  DMG=$(ls "$KIT"/Toskr_0.22.4_*.dmg | head -1)
  MNT=$(mktemp -d)
  hdiutil attach "$DMG" -nobrowse -readonly -mountpoint "$MNT" >/dev/null
  mkdir -p "$HOME/Applications"
  [[ ! -e "$APP" ]] || { hdiutil detach "$MNT" >/dev/null; echo "$APP 已存在，先运行 clean"; exit 1; }
  ditto "$MNT/Toskr.app" "$APP"
  hdiutil detach "$MNT" >/dev/null
  xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
  open "$APP"
  echo "→ 旧版 0.22.4 已装到 $APP 并打开。授权两项权限、放几条数据后退出旧版，再运行 upgrade"
  ;;
upgrade)
  [[ "$(id -un)" != "$(cat "$KIT/.owner" 2>/dev/null)" ]] || { echo "请在测试账户里运行"; exit 1; }
  [[ -d "$APP" && -f "$OLD_DATA/toskr-data.json" ]] || { echo "没找到旧版或旧版数据：先 install 并在旧版里放些内容"; exit 1; }
  ! pgrep -x toskr >/dev/null || { echo "旧版还在运行，先退出"; exit 1; }
  BEFORE=$(shasum -a 256 "$OLD_DATA/toskr-data.json" | cut -d' ' -f1); echo "$BEFORE" > "$KIT/.old-data-$(id -un).sha"
  NEW=$(mktemp -d)/Toskr.app; mkdir "$NEW"
  tar -xzf "$KIT/Toskr.app.tar.gz" -C "$NEW" --strip-components 1
  BAK=$(mktemp -d)/current_app
  mv "$APP" "$BAK" && mv "$NEW" "$APP"
  codesign --verify --deep --strict "$APP"
  open "$APP"
  echo "→ 已原位换成原生包并打开（旧包备份在 ${BAK}）。留意：有没有钥匙串 / 权限弹框、面板里数据在不在。然后运行 check"
  ;;
check)
  ok() { echo "  ✓ $1"; }; bad() { echo "  ✗ $1"; FAIL=1; }
  FAIL=0
  V=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")
  [[ "$V" == 1.* ]] && ok "已是原生版 v$V" || bad "版本是 $V"
  pgrep -f "$APP/Contents/MacOS/" >/dev/null && ok "应用在运行" || bad "应用没在运行"
  [[ -f "$NEW_LOG" ]] || { bad "没有新版诊断日志 $NEW_LOG"; exit 1; }
  grep -a '已接续旧版数据' "$NEW_LOG" | tail -1 | cut -d' ' -f2- | sed 's/^/  · /' || true
  grep -aq '已接续旧版数据' "$NEW_LOG" && ok "旧版数据已静默接续" || bad "没有接续记录（看日志里的「接续旧版数据失败」）"
  grep -a '已接续旧版数据' "$NEW_LOG" | tail -1 | grep -q '核对.*不一致 0\|全部一致' && ok "回读核对无不一致" || echo "  ? 回读核对结果见上一行，请人工确认"
  grep -a '辅助功能授权=' "$NEW_LOG" | tail -1 | grep -q 'true' && ok "辅助功能授权保留" || bad "辅助功能授权没有保留（需要重新授权）"
  grep -aq '键盘事件流已到达\|tap.*receiving' "$NEW_LOG" && ok "输入监控可用（已收到键盘事件）" || echo "  ? 还没看到键盘事件：按几下键后再 check；仍没有则输入监控授权没保留"
  [[ "$(shasum -a 256 "$OLD_DATA/toskr-data.json" | cut -d' ' -f1)" == "$(cat "$KIT/.old-data-$(id -un).sha" 2>/dev/null)" ]] && ok "旧版数据文件未被改动" || bad "旧版数据文件变了"
  [[ ! -f "$HOME/Library/LaunchAgents/Toskr.plist" ]] && ok "没有残留的旧开机启动项（或原本没开）" || echo "  ? 旧开机启动项还在：若旧版里开过开机启动，说明登录项接管没成功"
  echo "  人工确认：升级后第一次打开时没有出现钥匙串授权框；面板里的笔记 / 任务与旧版一致"
  exit $FAIL
  ;;
clean)
  [[ "$(id -un)" != "$(cat "$KIT/.owner" 2>/dev/null)" ]] || { echo "请在测试账户里运行"; exit 1; }
  pkill -f "$APP/Contents/MacOS/" 2>/dev/null || true
  echo "将删除：$APP 与 $OLD_DATA —— 确认请输入 yes"; read -r A; [[ "$A" == yes ]] || exit 1
  mv "$APP" "$(mktemp -d)/" 2>/dev/null || true
  mv "$OLD_DATA" "$(mktemp -d)/" 2>/dev/null || true
  echo "→ 已移走（在临时目录里，重启后系统清理）。钥匙串里的 com.toskr.app.data / com.toskr.app.ai 请在「钥匙串访问」里手动删除"
  ;;
*) sed -n 2,13p "$0"; exit 1 ;;
esac
