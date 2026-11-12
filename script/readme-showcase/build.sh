#!/bin/bash
# 生成 README 的介绍图 docs/assets/readme/toskr-showcase.webp。
#   1. native/readme_shots_test.go 把三屏原生界面渲染成带透明度的 3x 素材（panels/，不入库）
#   2. showcase.html 把素材摆上舞台，无界面 Chrome 按 2x 截成 3200×2000
#   3. cwebp 压成 webp
# 用法: ./script/readme-showcase/build.sh        （PANELS=0 跳过第 1 步，只重新合成）
#   NATIVE_DIR=<另一份 native 目录>  工作区有没写完的改动时，从干净的 git worktree 渲染素材
set -euo pipefail
cd "$(dirname "$0")"
HERE=$PWD
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[[ -x "$CHROME" ]] || { echo "需要 Google Chrome"; exit 1; }
command -v cwebp >/dev/null || { echo "需要 cwebp（brew install webp）"; exit 1; }
mkdir -p panels out
if [[ "${PANELS:-1}" == 1 ]]; then
  (cd "${NATIVE_DIR:-../../native}" && TOSKR_SHOT_DIR="$HERE/panels" go test -count=1 -run TestReadmeShowcase .)
fi
PROFILE=$(mktemp -d)
"$CHROME" --headless=new --disable-gpu --user-data-dir="$PROFILE" --hide-scrollbars --allow-file-access-from-files \
  --window-size=1600,1000 --force-device-scale-factor=2 --virtual-time-budget=4000 \
  --screenshot="$HERE/out/showcase.png" "file://$HERE/showcase.html" >/dev/null 2>&1
[[ -s out/showcase.png ]] || { echo "截图失败"; exit 1; }
cwebp -quiet -q 88 -m 6 out/showcase.png -o ../../docs/assets/readme/toskr-showcase.webp
echo "→ docs/assets/readme/toskr-showcase.webp（$(sips -g pixelWidth -g pixelHeight ../../docs/assets/readme/toskr-showcase.webp | awk '/pixel/{printf "%s ", $2}')）"
