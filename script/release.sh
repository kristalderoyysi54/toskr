#!/bin/bash
# 一键发版：改版本号 → 签名打包 → 校验 DMG → 生成 latest.json → GitHub Release 上传。
# 用法: ./script/release.sh 0.3.0 ["更新说明"]
# 依赖: gh CLI 已登录; ~/.tauri/toskr-updater.key 存在（updater 私钥）。
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:?用法: ./script/release.sh <version> [notes]}"
NOTES="${2:-Toskr v$VERSION}"
CONF=src-tauri/tauri.conf.json
KEY="$HOME/.tauri/toskr-updater.key"
REPO="kristalderoyysi54/toskr"
BUNDLE=src-tauri/target/release/bundle/macos
DMG_DIR=src-tauri/target/release/bundle/dmg

[[ -f "$KEY" ]] || { echo "缺少 updater 私钥: $KEY"; exit 1; }
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "版本号须为 x.y.z"; exit 1; }
git diff --quiet && git diff --cached --quiet \
  || { echo "存在未提交的已跟踪改动，请先提交功能代码再发版"; exit 1; }

# 1. 写入版本号
python3 - "$VERSION" <<'EOF'
import json, sys
p = 'src-tauri/tauri.conf.json'
d = json.load(open(p))
d['version'] = sys.argv[1]
open(p, 'w').write(json.dumps(d, ensure_ascii=False, indent=2) + '\n')
EOF
echo "→ 版本号已写入 $VERSION"

# 2. 签名打包（updater 签名走环境变量；app 签名走 conf 里的证书）
# touch 强制重编译：generate_context! 在编译期读 tauri.conf.json 嵌入版本号，
# 但 cargo 不追踪该依赖——不 touch 会打出「自报旧版本」的包，更新循环提示
touch src-tauri/src/lib.rs
export TAURI_SIGNING_PRIVATE_KEY="$KEY"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
PATH=/usr/bin:$PATH pnpm tauri build
[[ -f "$BUNDLE/Toskr.app.tar.gz" && -f "$BUNDLE/Toskr.app.tar.gz.sig" ]] \
  || { echo "缺少 updater 产物（检查 createUpdaterArtifacts）"; exit 1; }
[[ -d "$DMG_DIR" ]] || { echo "缺少 DMG 产物目录"; exit 1; }
DMG=$(find "$DMG_DIR" -maxdepth 1 -type f -name "Toskr_${VERSION}_*.dmg" -print -quit)
[[ -n "$DMG" && -f "$DMG" ]] || { echo "缺少 DMG 安装包"; exit 1; }
hdiutil verify "$DMG" >/dev/null
echo "→ DMG 已校验: $DMG"

# 3. 生成 latest.json（Apple Silicon；如出 Intel 包再补 darwin-x86_64）
SIG=$(cat "$BUNDLE/Toskr.app.tar.gz.sig")
DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
python3 - "$VERSION" "$NOTES" "$SIG" "$DATE" <<EOF > "$BUNDLE/latest.json"
import json, sys
v, notes, sig, date = sys.argv[1:5]
url = f"https://github.com/$REPO/releases/download/v{v}/Toskr.app.tar.gz"
print(json.dumps({
    "version": v, "notes": notes, "pub_date": date,
    "platforms": {"darwin-aarch64": {"signature": sig, "url": url}},
}, ensure_ascii=False, indent=2))
EOF

# 4. 提交版本号变更 + 打 tag + 发 Release
git add "$CONF" && git commit -m "release: v$VERSION" && git push
gh release create "v$VERSION" --repo "$REPO" --title "Toskr v$VERSION" --notes "$NOTES" \
  "$DMG" "$BUNDLE/Toskr.app.tar.gz" "$BUNDLE/Toskr.app.tar.gz.sig" "$BUNDLE/latest.json"

echo "✅ v$VERSION 已发布：https://github.com/$REPO/releases/tag/v$VERSION"
echo "   新用户下载 DMG，打开后把 Toskr 拖入 Applications 即可安装。"
echo "   旧版本用户将在启动 8 秒后收到更新提醒，或在设置 → 关于中手动更新。"
