#!/bin/sh
# 编译并签名 Toskr Native 内置密钥辅助程序，产物进 resources/darwin（mygo build 原样打进 Contents/Resources）。
#
# 只在审查过辅助程序本身的改动后运行：产物的 CDHash 一变，用户就要对钥匙串重新授权一次，
# 且 keychain_helper.go 里锁定的 CDHash 必须同步更新。普通打包不要运行它。
set -eu
cd "$(dirname "$0")"
OUT=../resources/darwin/com.toskr.native.keychain-helper
IDENTITY="Toskr Dev Signing"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
# 编译参数同 script/keychain-helper.py（SecKeychainSetUserInteractionAllowed 已弃用但仍是禁止授权 UI 的唯一开关）
mkdir -p "$(dirname "$OUT")"
xcrun clang -fobjc-arc -Os -Wall -Wextra -Werror -Wno-deprecated-declarations -mmacosx-version-min=13.0 \
	-arch arm64 -arch x86_64 -framework Foundation -framework Security -lbsm main.m -o "$TMP/helper"
cp "$TMP/helper" "$OUT"
chmod 755 "$OUT"
# 与 mygo 重签嵌套代码的参数一致（--options runtime，无 entitlements），重签后 CodeDirectory 不变
codesign --force --sign "$IDENTITY" --identifier com.toskr.native.keychain-helper --options runtime --timestamp=none "$OUT"
codesign -d --verbose=4 "$OUT" 2>&1 | grep -E '^(Identifier|CDHash)='
shasum -a 256 main.m config.h "$OUT"
