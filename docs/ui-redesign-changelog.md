# UI 重塑改造清单（2026-08-04）

逐项「改了什么 / 追溯原则 / 为什么更好」。完整计划与决策记录：`~/.claude/plans/ui-shimmering-wall.md`。

## 一、设计系统地基

| 改了什么 | 原则 | 为什么更好 |
|---|---|---|
| 5 档命名字阶（micro 10 / label 11 / body 12 / title 13 / heading 15，各配行高），全仓 166 处 `text-[Npx]` 清零 | 排版系统·字阶≤5 档 | 字号不再现场发挥；同类元素跨屏一致，改一处 token 全局生效 |
| 色彩双轨：`--paper` 纸白（取自应用图标）承载实心主控件；`--primary/--ring` 系统蓝降为焦点/选中/开关状态色（`--accent-hue` 一行换色） | 色彩语义化·与品牌统一 | 界面色与图标同源；蓝色只在「状态」出现，信息层级更清楚；对比度实测全过 AA（白/蓝 4.79、纸对 14.9） |
| 新增 `--success/--warning` 语义色；全部裸红/裸橙按语义归位（错误=destructive、提醒=warning） | 语义化·杜绝裸色 | 「权限被扣=红、待授权=琥珀」表意准确；暗色适配由 token 承担不再手写 `dark:` |
| elevation-1/2/3 三档阴影（贴身影+环境影+顶缘 rim-light）+ `surface-inset` 凹陷底 + `floatingSurface()` 浮层配方 | 阴影≤3 档全局复用 | 六种 shadow-* 乱用收敛为三档语义；两套手写浮层（含 zinc-800 漂移 bug）归一 |
| 间距官宣 2px 网格；出格值处置（w-8/w-6/h-[18px]/w-20），保留白名单一律 `token-exception` 注释（136px 卡高、132 textarea、3px 强调条、2px mark） | 网格统一·例外显式化 | 「哪些是刻意的」一眼可查，护栏脚本可机器验证 |
| 动效 token（duration fast/base/slow/exit/emphasis + 缓动命名）+ `lib/motion.ts` 五个 spring/tween 预设（纯替换原手调值） | 动效统一时长与缓动 | 480/40、500/38、480/42 等散值有名有姓；改手感只动一处 |
| `prefers-reduced-motion` 全覆盖：CSS 通杀层 + App/HUD 双 `MotionConfig`；flash/骨架降级为静态染色（去动效不去信息） | 尊重 reduced-motion | 之前全仓 0 处理；现在系统开关一开全部安静，信息不丢 |
| `@import "shadcn/tailwind.css"` 安全下线：7 个在用 `@custom-variant` 内联、shadcn 移 devDependencies（构建产物验证 data-state 选择器齐活） | 精准修改·防静默破坏 | 消除「未来清理依赖会弄断 Radix 动画」的暗雷（初版审计误判为死导入，已实证纠正） |
| 死物清理：`--sidebar-*`×7、`--chart-*`×5 token，5 个零引用 shadcn 组件文件 | YAGNI | token 表就是真实词汇表，不再有一半是脚手架噪音 |

## 二、原语层（新建 7 + 收编）

| 改了什么 | 原则 | 为什么更好 |
|---|---|---|
| `IconButton`（label 必填→aria+title、显式 tabIndex、焦点环、按压缩放、热区扩展、reveal 三态带 pointer-events 配对） | 组件复用·可访问性内建 | 6+ 处复制漂移的 ghost 按钮串归一；hover 才显示的按钮从「键盘永远够不到」变为焦点可达且不误触 |
| `PillInput`（DraftInput/TaskQuickAdd 双胞胎合一，IME/Enter/Shift+Enter 内建）+ `TEXTAREA_MAX_H` 单源 | DRY | 两份 76 行复制件变成 ~25 行消费者；132px 上限不再三处手抄 |
| `Segmented` 从设置页提升共享（radiogroup/radio 语义、焦点环、按压态） | 复用·语义化 | 4 处复制粘贴分段控件统一手感与可访问性 |
| `EmptyState`（full/inline）、`Kbd`（chip/inline）、`ProgressBar`（role=progressbar 四件套） | 状态完备·组件化 | 7 处各写各样的空态（含裸文字"空"）、6 处手写 kbd、裸百分比文字全部有了体面形态 |
| `Button` 尺寸重调（text-title/label/body、去 min() 死复杂度），7 处调用点手工覆盖全删 | 组件即规范 | 调用方不再需要「覆盖出正确样子」；xs 就是 xs |
| `lib/shortcuts.ts` 快捷键单一来源 | 单源 | 修复设置页(11条) vs 速查层(13条)的既有漂移；⌘Z 一次登记两处生效 |

## 三、逐屏重塑

| 屏/件 | 改了什么 | 为什么更好 |
|---|---|---|
| 主面板头部 | 六钮 IconButton 化 + 页面级/全局级分组分隔线 + aria-pressed + Radix Tooltip | 一排图标有了结构；开关态可见可读 |
| 页签 | tablist/tab 语义 + 纸白选中 chip + 焦点环；到期徽标 destructive | 「当前页」用材质表达而非蓝染；读屏可懂 |
| NoteCard 选中态 | 粗蓝环 → 淡填色+primary 边框+抬升（compact 整行浅染+细环）；键盘焦点=中性细环 | 选中与焦点用**形状**区分不只靠色；观感从"框选"变"拾起"。（左缘条与 gloss 方案经样张否决未采用；来源应用图标区布局全程冻结） |
| NoteCard 细节 | 悬浮微升+影、compact 悬停尾部元数据淡出让位操作钮、图片骨架占位、正文 hover:cursor-grab | 操作钮不再压在时间上打架；加载不再是空洞；可拖出有了暗示 |
| 任务行 | 优先级色条旁加「低/中/高」文字（low 撞蓝改 teal、high 归 destructive）；到期 chip 保留图标且按紧急度换形状（闹钟/日历） | 摆脱纯色表意（WCAG 1.4.1）；灰度下也能读出紧急度 |
| SelectionBar | toolbar 语义 + elevation-3 抬起 + 共享 IconButton/Kbd | 悬浮操作条真的"浮"了 |
| 预览层 | floatingSurface(3) 卡壳 + 手写 dialog 语义（aria-modal/labelledby/Tab 循环/焦点交还） | 此窗口类 Radix Dialog 不可用，手写补齐模态可访问性，与既有 Esc/空格捕获零冲突 |
| HUD 气泡 | rim-light 内容装饰层（原生 vibrancy 底零冲突）+ 进出场对称（入场沿用原曲线、退场淡出、连发交叉淡切）+ Rust 隐藏前 160ms 预告 | 入场有、退场瞬灭的不对称修复；单槽覆盖从 glitch 变设计 |
| 发送失败提示 | Rust 两条 warn 合并为「发送中止：X 未到达前台 · 内容已在剪贴板」，前端第三条删除 | 之前 2-3 条互相覆盖只见最后一条；现在一条说全 |
| 权限横幅 | role=alert；「事件被拦截」橙→红（语义纠正）、「待授权」→warning | 错误与警告分级准确，读屏即时播报 |
| 设置窗 | alert() 绝迹→HUD、更新真进度条（tactile）、热键错误就地 chip（两惯例政策成文）、四滑杆合一、Switch 凹槽+光泽拇指、快捷键表接单源、列表管理钮键盘可达 | 全应用反馈惯例自洽；1500 行文件内部体系化 |
| 图片预览窗 | 焦点环、骨架加载、lightbox 底色 token 单源 | 极简窗也有完整状态 |

## 四、微交互与可访问性

- **⌘Z 撤销**：HUD 悬停撤销的键盘等价入口（复用同一 undo 栈，输入框让位原生撤销）
- **aria-live 播报镜像**：`tip()` 文案同步进面板 sr-only region（HUD 独立窗读屏听不到的架构性补偿；面板关闭时与设置窗动作为已知局限）
- **SimpleMenu 进出场**与 Radix 菜单同参（保持非 portal 架构——本窗口类的承重约束）
- **Tooltip 双轨政策**：chrome 级 Radix、行级高重复件原生 title（NoteCard memo 性能优先，成文于代码注释）
- **aria-expanded/pressed** 铺开折叠件与开关件；`display:none` 式 hover 按钮全数改为 opacity+pointer-events 配对方案（Tab 可达）

## 防回退

- `STRICT=1 pnpm check:tokens` 硬护栏全绿（裸字号/裸 rounded/选中蓝/裸红/shadcn 导入五项恒零；白名单=token-exception 注释，本行或上方 3 行）
- 样张页常驻：`pnpm dev` → `http://localhost:1420/?styletile=1`（dev-only 零字节进包）
- 约定已沉淀至 `CLAUDE.md` 前端约定节

## 需真机手动验证（浏览器环境覆盖不到）

1. `docs/manual-qa.md` 全 20 条，重点：2/5（HUD 悬停撤销）、8/9（Esc 分层+全键盘含新 ⌘Z）、10（撤销双入口）、13/14（发送失败合并文案单条呈现）、17（隐身模式 warn 豁免）
2. 系统「减弱动态效果」开：动效消失信息不丢；「全键盘访问」开/关：Tab 均可达 IconButton 化控件；VoiceOver 抽查 tablist/dialog/alert/progressbar
3. HUD 退场动画与 160ms 时序手感；设置窗全部 10 页视觉（浏览器进不了 settings 分支）
4. 冻结项确认：卡片来源应用图标区、双击⇧/⌘⏎/伴随停靠等全链路行为无回归
