#!/bin/bash
# 原生版正式发布（接替旧版）：同一份 native/ 源码，以正式身份（Toskr / com.toskr.app）打包，
# 同时产出两套更新物料——旧版更新器认的 Toskr.app.tar.gz(.sig) + latest.json，与原生版自己的更新清单。
# 旧版用户点「更新」后装上的就是这个包：数据静默接续、钥匙串不弹框（包内是旧版原样的密钥辅助程序）。
#
# 用法: ./script/release-native.sh 1.0.0 ["更新说明"]
#   Release 页面的说明取 docs/releases/v<版本>.md（没有这份文件才用第二个参数）；第二个参数同时写进旧版更新器的 latest.json
#   DRY_RUN=1     只打包 + 门禁 + 生成物料到 native/build-release，不要求工作区干净、不建 Release（样机 / 自检用）
#   SKIP_TESTS=1  跳过 go test（仅 DRY_RUN 下允许）
# 正式运行建的是 **草稿** Release：实机走完「旧版点更新 → 原生版」后再手动发布（末尾会打印命令）。
# 迭代期的预发布不走这里：native/ 下 `go tool mygo build -upload`（tagPrefix=native-v，不占 latest）。
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:?用法: ./script/release-native.sh <version> [notes]}"
NOTES_FILE="docs/releases/v$VERSION.md"   # 有这份文件就用它作 Release 说明；旧版更新气泡里只放一句（$2）
NOTES="${2:-Toskr v$VERSION}"
DRY="${DRY_RUN:-0}"
REPO="kristalderoyysi54/toskr"
LEGACY_KEY="$HOME/.tauri/toskr-updater.key"          # 旧版更新私钥：公钥已烧进存量旧版
NATIVE_KEY="$HOME/.toskr-native-keys/mygo-update.key" # 原生版更新私钥
HELPER_SRC=src-tauri/keychain-helper/artifacts/toskr-keychain-helper
HELPER_RES=native/resources/darwin/com.toskr.keychain-helper.bin
OUT=native/build-release
APP="$OUT/darwin-arm64/Toskr.app"

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "版本号须为 x.y.z"; exit 1; }
[[ -f "$LEGACY_KEY" && -f "$NATIVE_KEY" ]] || { echo "缺少更新私钥（$LEGACY_KEY / $NATIVE_KEY）"; exit 1; }
# 旧版更新包的签名走 tauri CLI（node_modules 里）：缺了会在打包几分钟后才失败，开头就拦下
[[ -x node_modules/.bin/tauri ]] || { echo "缺少 tauri CLI（node_modules/.bin/tauri），先运行 pnpm install --frozen-lockfile"; exit 1; }
[[ "$REPO" == "$(python3 -I -c 'import json;print(json.load(open("native/mygo.json"))["updates"]["github"])')" ]] || { echo "REPO 与 native/mygo.json updates.github 不一致"; exit 1; }
if [[ "$DRY" != 1 ]]; then
  [[ -z "$(git status --porcelain --untracked-files=all)" ]] || { echo "存在未提交改动，请先提交再发版"; exit 1; }
  [[ "${SKIP_TESTS:-0}" != 1 ]] || { echo "正式发布不能跳过测试"; exit 1; }
fi
TESTED_COMMIT=$(git rev-parse HEAD)

# 门禁 1：包里的旧版密钥辅助程序必须就是旧版的原样产物（钥匙串授权绑在它的指纹上）
cmp -s "$HELPER_SRC" "$HELPER_RES" || { echo "$HELPER_RES 与旧版辅助程序产物不一致"; exit 1; }
python3 script/keychain-helper.py check >/dev/null || { echo "旧版辅助程序产物校验失败"; exit 1; }
WANT_ARM=$(python3 -I -c 'import json;print(json.load(open("src-tauri/keychain-helper/manifest.json"))["cdhash"]["arm64"])')
WANT_X86=$(python3 -I -c 'import json;print(json.load(open("src-tauri/keychain-helper/manifest.json"))["cdhash"]["x86_64"])')
grep -q "cdhash: \"$WANT_ARM\", cdhashX86: \"$WANT_X86\"" native/identity.go || { echo "native/identity.go 锁定的辅助程序指纹与清单不一致"; exit 1; }

# 门禁 2：测试
if [[ "${SKIP_TESTS:-0}" != 1 ]]; then
  (cd native && go vet . && go test -count=1 ./...)
fi

# 1. 临时把 mygo.json 换成正式身份（结束时无论成败都还原；版本号不入库，以本次参数为准）
cp native/mygo.json "$TMPDIR/mygo.json.$$"
trap 'cp "$TMPDIR/mygo.json.$$" native/mygo.json; rm -f "$TMPDIR/mygo.json.$$"' EXIT
python3 -I - "$VERSION" <<'PY'
import json, sys
p = "native/mygo.json"
d = json.load(open(p))
d["name"], d["identifier"], d["version"] = "Toskr", "com.toskr.app", sys.argv[1]
d["updates"]["tagPrefix"] = "v"   # 与旧版同一条发布线：latest 即最新
d["macos"]["infoPlist"] = {k: (v.replace("Toskr Native", "Toskr") if isinstance(v, str) else v) for k, v in d["macos"]["infoPlist"].items()}
open(p, "w").write(json.dumps(d, ensure_ascii=False, indent=2) + "\n")
PY

# 2. 打包（.app + dmg + 原生更新包与清单）：Apple Silicon 与 Intel 各一份。
#    旧版只发过 Apple Silicon，所以旧版更新物料（latest.json）只需要 arm64；Intel 包给新装用户，之后走原生更新。
rm -rf "$OUT/darwin-arm64" "$OUT/darwin-amd64"
(cd native && go tool mygo build -platform darwin/arm64,darwin/amd64 -o build-release)
[[ -d "$APP" && -d "$OUT/darwin-amd64/Toskr.app" ]] || { echo "缺少 $APP 或 Intel 包"; exit 1; }

# 门禁 3：包身份、签名、辅助程序指纹（两种架构逐个过）
for APP in "$OUT/darwin-amd64/Toskr.app" "$OUT/darwin-arm64/Toskr.app"; do
ARCH=$([[ "$APP" == *amd64* ]] && echo x86_64 || echo arm64)
plist() { /usr/libexec/PlistBuddy -c "Print :$1" "$APP/Contents/Info.plist"; }
[[ "$(plist CFBundleIdentifier)" == com.toskr.app && "$(plist CFBundleShortVersionString)" == "$VERSION" ]] || { echo "包标识或版本不对"; exit 1; }
EXE="$APP/Contents/MacOS/$(plist CFBundleExecutable)"
[[ -x "$EXE" ]] || { echo "CFBundleExecutable 指向的文件不存在"; exit 1; }
codesign --verify --deep --strict "$APP" || { echo "codesign 校验失败"; exit 1; }
SIGINFO=$(codesign -d --verbose=4 "$APP" 2>&1)   # 先收进变量：grep -q 提前退出会让管道前段收到 SIGPIPE，pipefail 下误判失败
grep -q 'flags=0x10000(runtime)' <<<"$SIGINFO" || { echo "主程序缺 hardened runtime（旧版辅助程序会拒绝）"; exit 1; }
grep -q '^Authority=Toskr Dev Signing$' <<<"$SIGINFO" || { echo "签名证书不是 Toskr Dev Signing（授权会全部失效）"; exit 1; }
cdhash() { codesign -d --verbose=4 -a "$1" "$APP/Contents/Resources/com.toskr.keychain-helper.bin" 2>&1 | sed -n 's/^CDHash=//p'; }
[[ "$(cdhash arm64)" == "$WANT_ARM" && "$(cdhash x86_64)" == "$WANT_X86" ]] \
  || { echo "包内旧版辅助程序的指纹变了（$(cdhash arm64)）：存量用户会被要求重新授权钥匙串，拒绝发布"; exit 1; }
HELPINFO=$(codesign -d --verbose=4 "$APP/Contents/Resources/com.toskr.keychain-helper.bin" 2>&1)
grep -q '^Identifier=com.toskr.keychain-helper$' <<<"$HELPINFO" || { echo "辅助程序标识不对"; exit 1; }
[[ "$(lipo -archs "$EXE")" == "$ARCH" ]] || { echo "$EXE 的架构不是 $ARCH"; exit 1; }
echo "→ 包校验通过（${ARCH}）：com.toskr.app v${VERSION}，辅助程序指纹 $WANT_ARM / $WANT_X86"
done

# 3. 旧版更新器的物料：顶层目录名随意（更新器解包时跳过第一级），装到原 Toskr.app 的位置
LEGACY="$OUT/legacy"; rm -rf "$LEGACY"; mkdir -p "$LEGACY"
COPYFILE_DISABLE=1 tar -czf "$LEGACY/Toskr.app.tar.gz" -C "$OUT/darwin-arm64" Toskr.app
# 失败时把签名工具的输出打出来（曾因 -s 与丢弃输出静默退出，看不出原因）
if ! SIGN_OUT=$(TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" pnpm -s tauri signer sign -f "$LEGACY_KEY" -p "" "$LEGACY/Toskr.app.tar.gz" 2>&1); then
  echo "✗ 旧版更新签名失败："; echo "$SIGN_OUT"; exit 1
fi
[[ -s "$LEGACY/Toskr.app.tar.gz.sig" ]] || { echo "✗ 旧版更新签名失败：没有生成 .sig"; echo "$SIGN_OUT"; exit 1; }
python3 -I - "$VERSION" "$NOTES" "$(cat "$LEGACY/Toskr.app.tar.gz.sig")" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$REPO" <<'PY' > "$LEGACY/latest.json"
import json, sys
v, notes, sig, date, repo = sys.argv[1:6]
print(json.dumps({"version": v, "notes": notes, "pub_date": date, "platforms": {"darwin-aarch64": {
    "signature": sig, "url": f"https://github.com/{repo}/releases/download/v{v}/Toskr.app.tar.gz"}}}, ensure_ascii=False, indent=2))
PY

# 门禁 4：照旧版更新器的装法解一遍（跳过第一级目录、落到名为 Toskr.app 的目录），装出来的包仍然有效
SIM=$(mktemp -d); mkdir "$SIM/Toskr.app"
tar -xzf "$LEGACY/Toskr.app.tar.gz" -C "$SIM/Toskr.app" --strip-components 1
codesign --verify --deep --strict "$SIM/Toskr.app" || { echo "按旧版更新器解包后签名失效"; exit 1; }
[[ -x "$SIM/Toskr.app/Contents/MacOS/$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$SIM/Toskr.app/Contents/Info.plist")" ]] || { echo "解包后找不到可执行文件"; exit 1; }
echo "→ 旧版更新物料已生成并通过解包校验"

# 4. 原生版自己的更新物料
NATIVE_TGZ=$(find "$OUT/darwin-arm64" -maxdepth 1 -name "toskr-$VERSION-darwin-arm64.tar.gz" -print -quit)
NATIVE_DMG=$(find "$OUT/darwin-arm64" -maxdepth 1 -name "toskr-$VERSION-arm64.dmg" -print -quit)
MANIFEST="$OUT/darwin-arm64/update-darwin-arm64.json"
[[ -f "$NATIVE_TGZ" && -f "$NATIVE_DMG" && -f "$MANIFEST" ]] || { echo "缺少原生更新包 / DMG / 清单"; exit 1; }
grep -q "releases/download/v$VERSION/" "$MANIFEST" || { echo "原生更新清单的下载地址不是 v${VERSION}"; exit 1; }
hdiutil verify "$NATIVE_DMG" >/dev/null
python3 -I - "$TESTED_COMMIT" "$VERSION" "$LEGACY/release-evidence.json" "$NATIVE_DMG" "$NATIVE_TGZ" "$MANIFEST" "$LEGACY/Toskr.app.tar.gz" "$LEGACY/Toskr.app.tar.gz.sig" "$LEGACY/latest.json" <<'PY'
import hashlib, json, pathlib, sys
commit, version, out, *paths = sys.argv[1:]
sha = lambda p: hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
pathlib.Path(out).write_text(json.dumps({"testedCommit": commit, "version": version, "flavor": "native",
    "sha256": {pathlib.Path(p).name: sha(p) for p in paths}}, indent=2) + "\n")
PY
X86_TGZ="$OUT/darwin-amd64/toskr-$VERSION-darwin-amd64.tar.gz"; X86_DMG="$OUT/darwin-amd64/toskr-$VERSION-amd64.dmg"; X86_MANIFEST="$OUT/darwin-amd64/update-darwin-amd64.json"
[[ -f "$X86_TGZ" && -f "$X86_DMG" && -f "$X86_MANIFEST" ]] || { echo "缺少 Intel 的更新包 / DMG / 清单"; exit 1; }
grep -q "releases/download/v$VERSION/" "$X86_MANIFEST" || { echo "Intel 更新清单的下载地址不是 v${VERSION}"; exit 1; }
hdiutil verify "$X86_DMG" >/dev/null
FILES=("$X86_DMG" "$X86_TGZ" "$X86_MANIFEST" "$NATIVE_DMG" "$NATIVE_TGZ" "$MANIFEST" "$LEGACY/Toskr.app.tar.gz" "$LEGACY/Toskr.app.tar.gz.sig" "$LEGACY/latest.json" "$LEGACY/release-evidence.json")

if [[ "$DRY" == 1 ]]; then
  echo "✅ 试运行完成（未建 Release）。物料："; printf '   %s\n' "${FILES[@]}"
  exit 0
fi
[[ "$(git rev-parse HEAD)" == "$TESTED_COMMIT" ]] || { echo "打包期间提交发生变化，拒绝发布"; exit 1; }
NOTE_ARGS=(--notes "$NOTES"); [[ -f "$NOTES_FILE" ]] && NOTE_ARGS=(--notes-file "$NOTES_FILE")
gh release create "v$VERSION" --repo "$REPO" --draft --target "$TESTED_COMMIT" --title "Toskr v$VERSION" "${NOTE_ARGS[@]}" "${FILES[@]}"
echo "✅ 草稿 Release v${VERSION} 已建。实机验证「旧版点更新 → 打开即原生版、数据都在、无授权框」后发布："
echo "   gh release edit v$VERSION --repo $REPO --draft=false --latest"
echo "   此后每个正式版都必须带 latest.json（照顾还没升级的旧版用户）。"
