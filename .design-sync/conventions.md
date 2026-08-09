# Toskr 设计系统 — 使用约定

Toskr 是 macOS 菜单栏效率工具（纸感亮/暗双主题、克制灰调、2px 间距网格）。本设计系统是**真实应用的编译产物**：组件从 `window.Toskr.*` 取用，样式由根 `styles.css`（应用编译出的 Tailwind v4 CSS + tokens + Geist Variable 字体）提供。

## 包裹与前置
- 无全局 Provider。仅 Tooltip 家族必须外包 `Toskr.TooltipProvider`（应用级惯例 `delayDuration={400}`），否则 Tooltip 抛错。
- 暗色模式 = 给祖先元素加 `.dark` 类（class 策略）；亮色为默认。
- Geist Variable 已随包发货（font-sans 栈首位）；中文/等宽回退为宿主系统字体（PingFang SC / SF Mono），属产品既定行为。

## 样式习语（关键约束）
样式表是应用编译产物，**只包含应用实际用过的 Tailwind 类**——不存在的类静默无样式。因此：
- 组件自身样式内建，直接用组件即可，无需补类。
- 自己写布局时优先用下面的已验证词汇；表外的工具类不保证存在，**拿不准就写内联 style**，不要凭 Tailwind 记忆堆类名。
- 已验证词汇表（节选）：
  - 字阶（仅这 5 档合法）：`text-micro`(10px) `text-label`(11) `text-body`(12) `text-title`(13) `text-heading`(15)
  - 色彩：`bg-background` `text-foreground`；实心主控件用纸白 `bg-paper text-paper-foreground`；蓝 `bg-primary`/`text-primary` 只做焦点、选中、进度，不做大面积底；`bg-muted` `text-muted-foreground` `bg-popover text-popover-foreground` `bg-secondary` `text-destructive` `border-border`
  - 表面配方：浮层 = `bg-surface-raised/95` + 细边 + `elevation-2|3`（或直接调 `Toskr.floatingSurface(2|3)` 取得整串类名）；凹陷底 `surface-inset` + `elevation-1`；光泽 `glass-sheen`/`glass-sheen-flat`
  - 常用布局（已验证存在）：`flex` `inline-flex` `items-center` `justify-center` `gap-1` `gap-1.5` `gap-2` `rounded-md` `rounded-lg` `rounded-full` `border` `w-full` `shrink-0` `font-medium` `tabular-nums`
- 设计纪律：字号只用 5 档字阶；间距走 2px 网格；主按钮不做 gloss 光泽；图标按钮一律用 `IconButton`（内建焦点环/热区/无障碍名）。

## 真相所在
- 样式与 token 全量：读绑定的 `styles.css`（其 @import 闭包含 tokens、@font-face 与全部编译类）。
- 每组件 API 契约：`components/general/<Name>/<Name>.d.ts`（含中文注释的精确 props）；用法参考同目录 `<Name>.prompt.md`。
- 复合家族（ContextMenu / Popover / Tooltip / ScrollArea）的子件如何组合，以家族主卡的 prompt 与预览为准。

## 已知陷阱（务必遵守）
`Button` 当前未包 `React.forwardRef`：**不要**把 `Button` 作为 `TooltipTrigger/PopoverTrigger/ContextMenuTrigger` 等 `asChild` 触发器的子元素（ref 被吞、浮层定位失效）。asChild 触发器请用 `IconButton`（已正确 forwardRef）或原生 `<button>`。

## 惯用构建示例（改写自已验证预览）
```jsx
const { Button, IconButton, Kbd, TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } = window.Toskr;

<TooltipProvider delayDuration={400}>
  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
    <Button variant="secondary">立即备份</Button>
    <Tooltip>
      <TooltipTrigger asChild>
        <IconButton label="复制内容" withTitle={false}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        </IconButton>
      </TooltipTrigger>
      <TooltipContent>复制内容 <Kbd inline>⌘C</Kbd></TooltipContent>
    </Tooltip>
  </div>
</TooltipProvider>
```
