# design-sync 笔记（toskr）

- toskr 是 Tauri 应用而非组件库：设计系统面 = `src/components/ui/`（14 文件）+ `src/index.css` 的 token 体系。业务组件（NoteCard/TaskRow 等）耦合 Tauri/zustand，**不纳入**同步。
- 无 dist 组件出口 → 转换器走 synth-entry 模式（从 `srcDir: src/components/ui` 内容扫描 PascalCase 导出）。
- **CSS 来源必须是应用编译产物**：`src/index.css` 是 Tailwind v4 入口（`@theme`/`@custom-variant`/`@utility` 全在 CSS 里，无 tailwind.config），工具类是构建期 JIT 生成。`buildCmd` 会跑 `pnpm build` 并把 `dist/assets/index-*.css` + Geist woff2 落到稳定路径 `.design-sync/.cache/appcss/app.css`，同时 sed 把 `url(/assets/…)` 改写成相对路径，转换器才能收集字体。
- 编译 CSS 只含**应用源码里出现过的**工具类 → 作者化预览的布局胶水（flex/gap/padding）优先用内联 style，或确认该类在 app.css 里存在，否则预览会静默无样式。
- 渲染检查复用本机 Chromium：`DS_CHROMIUM_PATH=/Applications/Chromium.app/Contents/MacOS/Chromium`（playwright 包安装于 .ds-sync，跳过浏览器下载）。
- `cn`（src/lib/utils.ts）带自定义 extendTailwindMerge：把 text-micro/label/body/title/heading 注册进 font-size 组；通过 extraEntries 暴露到 window.Toskr。
- `floatingSurface`（floating-surface.ts）是返回 className 的纯函数、非组件 → 走 extraEntries 并入 bundle，不做预览卡。
- Radix 状态动画依赖 index.css 的 7 个 `@custom-variant`（data-open/data-closed 等）——已随编译 CSS 携带；`tw-animate-css` 同样已编译进 app.css。
- Tooltip 预览必须包 `TooltipProvider`（DS 自带导出，应用里以 delayDuration={400} 包全树）；其余组件无 Provider 需求。glowing-effect 用 motion 的命令式 animate()，自足。
- 暗色模式为 class 策略（`.dark`），预览卡默认亮色。
- next-themes 是未使用的依赖，与同步无关。
- **字体裁定**：Geist Variable（品牌主字体）随包发货；"Hiragino Sans GB"/"PingFang SC"/"JetBrains Mono" 是回退栈里的系统字体，应用自身也不打包 → `runtimeFontPrefixes` 声明为宿主提供（打包替代品会让设计渲染偏离应用真实观感）。macOS 观看者渲染与应用完全一致，非 mac 平台优雅降级到系统 sans/mono。
- `guidelinesGlob: []`：默认 glob 会把 `docs/`（应用 QA 文档）误当设计指南上传，必须保持为空。
- 打包入口是 `.design-sync/entry.ts`（策展表面，cfg.entry 指向它）；**新增 ui 组件要同步改 entry.ts + componentSrcMap 两处**，否则新组件不进 bundle。
- 37 个导出中 13 个文件级家族卡作者化（floating-surface 是纯函数无卡）；Radix 家族子件（Trigger/Content/Item 等）设计上走占位卡 + .prompt.md 指向家族组合；视觉上有独立意义的子件（PopoverHeader/Title/Description、ContextMenuLabel/Shortcut/Group/RadioGroup）作者化时顺带复用家族组合写卡。

## 预览作者化经验（wave1 折叠）
- **Button 未 forwardRef（源码隐患，2026-08 发现）**：React 18 下 plain function 组件吞 ref → `PopoverTrigger/TooltipTrigger asChild` 包 `Button` 时 Radix 锚点测量失败、浮层定位飞到视口外（实测 y=-400）。预览一律改用原生 `<button>` 或已 forwardRef 的 `IconButton` 做 asChild 触发器。生产代码 `SelectionBar.tsx` 的 `TooltipTrigger asChild + Button` 按同根因也有隐患。**建议源码给 Button 补 forwardRef（参照 IconButton）**——修复后可回归 asChild 写法。
- GlowingEffect 静息态光弧整体淡出（--glow-opacity→0）：预览须向 `document.body`（监听挂 body 非 window）派发多次 pointermove（容器边缘坐标、避开 0.7 中心死区），配 `movementDuration={0.2}` 加速，方能截到 follow 态光弧。
- PillInput multiline 的 autoResizeTextarea 只在真实 onChange 触发，静态预览无法演示自动长高——用单行放得下的文字展示 spark 壳即可，勿堆字数（会被裁切误读为缺陷）。
- ScrollArea 横向滚动：`<ScrollBar orientation="horizontal" />` 作为 children 兄弟节点放置即可（Radix Scrollbar 内联 absolute 定位到 Root），内容用 `width:max-content` 撑宽。
- IconButton `tone="danger"` 仅 hover 变红，静态卡与 default 同观感（组件本身实现，非缺陷）。
- ContextMenu 打开态用「挂载后向 Trigger 热区派发 contextmenu MouseEvent」呈现（Radix ContextMenu 无受控 open）。

## Known render warns
- `[RENDER_THIN] ContextMenuGroup`、`[RENDER_THIN] ContextMenuRadioGroup`：合法——纯逻辑容器（Primitive 包装），无独立视觉，占位卡即正确呈现；子件视觉真相在 ContextMenu 家族卡。

## Re-sync risks（下次同步的看点）
- **编译 CSS 是 JIT 子集**：styles.css 词汇 = 应用源码当刻用过的类。应用重构删掉某类会静默使预览/conventions 词表失真——re-sync 后应对 conventions.md 的枚举词汇重跑核验（grep _ds_bundle.css）。
- **新增组件双处维护**：`.design-sync/entry.ts` 加 export + config `componentSrcMap` 加名字，缺一则新组件不进 bundle/无卡。
- **dtsPropsFor 全手写（37 份）**：源码 API 变更（加 prop、改枚举值）不会自动反映到契约——re-sync 时 diff `src/components/ui/` 与 dtsPropsFor，手动同步。
- **buildCmd 的假设**：`dist/assets/index-*.css` 唯一（依赖 vite emptyOutDir 默认清空）；`sed -i ''` 是 macOS/BSD 语法，Linux 机器需改 GNU 形式。
- **渲染检查环境机器相关**：playwright 包装在 `.ds-sync/`（gitignored，重装即回）+ `DS_CHROMIUM_PATH=/Applications/Chromium.app/Contents/MacOS/Chromium`；无 ms-playwright 浏览器缓存。
- **Button forwardRef 待修**：源码修复后，`previews/Popover.tsx` 的原生 button 触发器可回归 `asChild + Button` 写法，conventions.md 的「已知陷阱」段也应删除。
- **预览技巧与组件内部实现耦合**：GlowingEffect 卡依赖「pointermove 监听挂在 document.body + movementDuration 可调」；ContextMenu 卡依赖「无受控 open、contextmenu 事件可程序化派发」。相关组件重构后这些卡可能变空——看截图即知。
- **只验证了静态可达态**：hover/focus/拖拽态未进卡（静态渲染极限）；隐身/暗色模式未单独出卡（暗色靠 `.dark` 类，设计代理可自行包）。
- `guidelinesGlob` 必须保持 `[]`：docs/ 是应用 QA 文档，非设计指南。
