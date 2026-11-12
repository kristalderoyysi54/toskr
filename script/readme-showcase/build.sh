#!/bin/bash
# 生成 README 的两张介绍图（三屏介绍图 + 三步流程图，各有 深 / 浅 × 中 / 英 四个版本）和官网的分享封面。
#   1. native/readme_shots_test.go 把三屏原生界面渲染成带透明度的 3x 素材（panels/，不入库）
#   2. showcase.html 按地址参数（view / theme / lang）把素材摆上舞台，无界面 Chrome 按 2x 截图
#   3. cwebp 压成 webp（分享封面用 jpg：各平台的链接预览不一定认 webp）
# 用法: ./script/readme-showcase/build.sh        （PANELS=0 跳过第 1 步，只重新合成）
#   NATIVE_DIR=<另一份 native 目录>  工作区有没写完的改动时，从干净的 git worktree 渲染素材
set -euo pipefail
cd "$(dirname "$0")"
HERE=$PWD
DOCS=../../docs/assets/readme
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[[ -x "$CHROME" ]] || { echo "需要 Google Chrome"; exit 1; }
command -v cwebp >/dev/null || { echo "需要 cwebp（brew install webp）"; exit 1; }
mkdir -p panels out
if [[ "${PANELS:-1}" == 1 ]]; then
  (cd "${NATIVE_DIR:-../../native}" && TOSKR_SHOT_DIR="$HERE/panels" go test -count=1 -run TestReadmeShowcase .)
fi
PROFILE=$(mktemp -d)
shot() { # shot <输出名> <宽> <高> <地址参数>
  "$CHROME" --headless=new --disable-gpu --user-data-dir="$PROFILE" --hide-scrollbars --allow-file-access-from-files \
    --window-size="$2,$3" --force-device-scale-factor=2 --virtual-time-budget=4000 \
    --screenshot="$HERE/out/$1.png" "file://$HERE/showcase.html?$4" >/dev/null 2>&1
  [[ -s "out/$1.png" ]] || { echo "截图失败：$1"; exit 1; }
}
for view in showcase flow; do
  for theme in dark light; do
    for lang in zh en; do
      name="toskr-$view"; [[ "$lang" == en ]] && name="$name-en"; [[ "$theme" == light ]] && name="$name-light"
      shot "$name" 1600 1000 "view=$view&theme=$theme&lang=$lang"
      cwebp -quiet -q 86 -m 6 "out/$name.png" -o "$DOCS/$name.webp"
      echo "→ $name.webp  $(($(stat -f %z "$DOCS/$name.webp") / 1024)) KB"
    done
  done
done
shot og 1200 630 "view=og&theme=dark&lang=zh"
sips -s format jpeg -s formatOptions 88 -z 630 1200 out/og.png --out ../../site/og.jpg >/dev/null
echo "→ site/og.jpg  $(($(stat -f %z ../../site/og.jpg) / 1024)) KB"
