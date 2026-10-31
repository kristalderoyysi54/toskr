#!/bin/sh
# 构建本机翻译辅助程序（Swift，macOS 15+ 系统翻译框架）：源码比产物新才重编，
# 双架构、hardened runtime，用应用同一证书签名后由 tauri.conf.json bundle.macOS.files 放进 Contents/Helpers。
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DIR="$ROOT/src-tauri/translate-helper"
OUT="$DIR/artifacts/toskr-translate-helper"
if [ -f "$OUT" ] && [ "$OUT" -nt "$DIR/main.swift" ] && [ "$OUT" -nt "$0" ]; then
  echo "✓ 本机翻译辅助程序已是最新"
  exit 0
fi
mkdir -p "$DIR/artifacts"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
for arch in arm64 x86_64; do
  /usr/bin/xcrun swiftc -O -target "$arch-apple-macos15.0" "$DIR/main.swift" -o "$TMP/$arch"
done
/usr/bin/lipo -create "$TMP/arm64" "$TMP/x86_64" -output "$TMP/helper"
/usr/bin/codesign --force --options runtime --identifier com.toskr.translate-helper \
  --sign "Toskr Dev Signing" "$TMP/helper"
mv "$TMP/helper" "$OUT"
echo "✓ 已构建本机翻译辅助程序 $OUT"
