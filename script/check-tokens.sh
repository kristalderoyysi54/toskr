#!/bin/bash
# 设计令牌回归检查：抓已知应消灭的模式，防止迁移完成后悄悄复发。
# 硬检查已清零（2026-08-04 重塑收尾），推荐以 STRICT=1 运行接入日常流程。
# 白名单：命中行（或其紧邻注释行）含 `token-exception` 会被跳过。
set -uo pipefail
cd "$(dirname "$0")/.."
STRICT="${STRICT:-0}"
fail=0

check() {
  local desc="$1" pattern="$2"
  local raw hits n
  raw=$(grep -rnE "$pattern" src --include="*.tsx" --include="*.ts" 2>/dev/null | grep -v "token-exception" || true)
  # 白名单第二层：命中行的紧邻上一行带 token-exception 注释也放行（JSX 属性行无法尾注）
  hits=""
  while IFS= read -r hit; do
    [ -z "$hit" ] && continue
    local file="${hit%%:*}" rest="${hit#*:}"
    local line="${rest%%:*}" from
    from=$((line - 3)); [ "$from" -lt 1 ] && from=1
    if sed -n "${from},$((line - 1))p" "$file" 2>/dev/null | grep -q "token-exception"; then
      continue
    fi
    hits+="$hit"$'\n'
  done <<< "$raw"
  n=$(printf '%s' "$hits" | grep -c . || true)
  if [ "$n" -gt 0 ]; then
    echo "✗ $desc: $n 处"
    printf '%s\n' "$hits" | head -3 | sed 's/^/    /'
    fail=1
  else
    echo "✓ $desc: 0"
  fi
}

# —— 硬检查（STRICT=1 时非零即失败；迁移完成后应恒为 0）——
check "裸 rounded（应为 rounded-sm 起步）"        '(className=|cn\(|")[^"]*\brounded[" ]'
check "rounded-\[14px\]（=rounded-xl 的重复）"    'rounded-\[14px\]'
check "任意像素字号 text-[Npx]（应走 5 档字阶）"   'text-\[[0-9.]+px\]'
check "硬编码选中蓝（应为 primary token）"        'border-blue-500|ring-blue-500'
check "裸红色系（应为 destructive token）"        'bg-red-500|text-red-[456]00'
check "shadcn 运行时 CSS 导入（已内联，禁复活）"   '@import "shadcn/tailwind.css"'

# —— 观察指标（不参与 STRICT 判定）：文字型按钮允许手写，仅追踪总量防失控 ——
btns=$(grep -rn '<button\b' src --include="*.tsx" | grep -cv "token-exception" || true)
echo "ℹ 手写 <button 总量（图标钮应走 IconButton；文字钮允许）: $btns"

if [ "$fail" -eq 0 ]; then
  echo "—— token 硬护栏全部通过 ——"
fi
[ "$STRICT" = "1" ] && exit "$fail"
exit 0
