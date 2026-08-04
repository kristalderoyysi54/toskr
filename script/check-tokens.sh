#!/bin/bash
# 设计令牌回归检查：抓已知应消灭的模式，防止迁移完成后悄悄复发。
# 迁移期 STRICT=0（默认）只打印计数供人工核对；全部清零后以 STRICT=1 接入流程。
# 白名单：行内带 `token-exception` 注释的命中会被跳过。
set -uo pipefail
cd "$(dirname "$0")/.."
STRICT="${STRICT:-0}"
fail=0

check() {
  local desc="$1" pattern="$2"
  local hits n
  hits=$(grep -rnE "$pattern" src --include="*.tsx" --include="*.ts" 2>/dev/null | grep -v "token-exception" || true)
  n=$(printf '%s' "$hits" | grep -c . || true)
  if [ "$n" -gt 0 ]; then
    echo "✗ $desc: $n 处"
    printf '%s\n' "$hits" | head -3 | sed 's/^/    /'
    fail=1
  else
    echo "✓ $desc: 0"
  fi
}

check "裸 rounded（应为 rounded-sm 起步）"        '(className=|cn\(|")[^"]*\brounded[" ]'
check "rounded-\[14px\]（=rounded-xl 的重复）"    'rounded-\[14px\]'
check "任意像素字号 text-[Npx]（应走 5 档字阶）"   'text-\[[0-9.]+px\]'
check "手写 <button（应为 Button/IconButton）"    '<button\b'
check "硬编码选中蓝（应为 primary token）"        'border-blue-500|ring-blue-500'
check "裸红色系（应为 destructive token）"        'bg-red-500|text-red-[456]00'
check "shadcn 运行时 CSS 导入（已内联，禁复活）"   '@import "shadcn/tailwind.css"'

if [ "$fail" -eq 0 ]; then
  echo "—— token 护栏全部通过 ——"
fi
[ "$STRICT" = "1" ] && exit "$fail"
exit 0
