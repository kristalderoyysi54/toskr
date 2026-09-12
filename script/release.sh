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
[[ -z "$(git status --porcelain --untracked-files=all)" ]] \
  || { echo "存在未提交改动，请先提交功能代码再发版"; exit 1; }

# 在改版本和产生发布副作用前验证固定提交。任意门禁失败立即退出。
TESTED_COMMIT=$(git rev-parse HEAD)
pnpm typecheck
pnpm lint
pnpm test
(cd src-tauri && cargo test)
STRICT=1 pnpm check:tokens
[[ "$(git rev-parse HEAD)" == "$TESTED_COMMIT" && -z "$(git status --porcelain --untracked-files=all)" ]] \
  || { echo "验证期间源码发生变化，请重新发版"; exit 1; }

# 1. 写入版本号
python3 - "$VERSION" <<'EOF'
import json, sys
p = 'src-tauri/tauri.conf.json'
d = json.load(open(p))
d['version'] = sys.argv[1]
open(p, 'w').write(json.dumps(d, ensure_ascii=False, indent=2) + '\n')
EOF
echo "→ 版本号已写入 $VERSION"
VERSION_DIFF=$(git diff --binary | shasum -a 256)

# 2. 签名打包（updater 签名走环境变量；app 签名走 conf 里的证书）
# touch 强制重编译：generate_context! 在编译期读 tauri.conf.json 嵌入版本号，
# 但 cargo 不追踪该依赖——不 touch 会打出「自报旧版本」的包，更新循环提示
touch src-tauri/src/lib.rs
export TAURI_SIGNING_PRIVATE_KEY="$KEY"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
PATH=/usr/bin:$PATH pnpm tauri build
python3 script/keychain-helper.py check --app "$BUNDLE/Toskr.app"
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
[[ "$(git rev-parse HEAD)" == "$TESTED_COMMIT" && "$(git diff --binary | shasum -a 256)" == "$VERSION_DIFF" ]] \
  && git diff --cached --quiet \
  && [[ -z "$(git ls-files --others --exclude-standard)" ]] \
  || { echo "构建期间源码发生变化，拒绝发布"; exit 1; }
python3 - "$TESTED_COMMIT" "$VERSION" "$DMG" "$BUNDLE" <<'EOF'
import hashlib, json, pathlib, sys
commit, version, dmg, bundle = sys.argv[1:]
paths = [pathlib.Path(dmg)] + [pathlib.Path(bundle) / name for name in
    ('Toskr.app.tar.gz', 'Toskr.app.tar.gz.sig', 'latest.json')]
def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()
evidence = {'testedCommit': commit, 'version': version, 'sha256': {
    p.name: sha256(p) for p in paths}}
(pathlib.Path(bundle) / 'release-evidence.json').write_text(json.dumps(evidence, indent=2) + '\n')
EOF
git add "$CONF" && git commit -m "release: v$VERSION" && git push
gh release create "v$VERSION" --repo "$REPO" --title "Toskr v$VERSION" --notes "$NOTES" \
  "$DMG" "$BUNDLE/Toskr.app.tar.gz" "$BUNDLE/Toskr.app.tar.gz.sig" "$BUNDLE/latest.json" "$BUNDLE/release-evidence.json"

echo "✅ v$VERSION 已发布：https://github.com/$REPO/releases/tag/v$VERSION"
echo "   新用户下载 DMG，打开后把 Toskr 拖入 Applications 即可安装。"
echo "   旧版本用户将在启动 8 秒后收到更新提醒，或在设置 → 关于中手动更新。"
