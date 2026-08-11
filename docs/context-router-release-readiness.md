# Context Router 发布准备度

> Phase 15 + 可选 Phase 16 本地候选｜2026-08-11（Asia/Shanghai）
> 本文是当前工作树的证据清单，不是 release，也不替代真实 macOS 运行回归。

## 已通过门禁

- `CODE-CONFIRMED`：演练使用普通 Note 与唯一 DeliveryDraft/Firewall/Preflight/Native 投递管线；Draft、store 和执行器均强制只粘贴、不按回车。
- `AUTO-PASS`：onboarding 暂停/恢复、权限五态、旧用户 v13→v14、受控来源/目标门禁、Firewall 必须处理、Preflight accessible state、发送回执与完成状态。
- `AUTO-PASS`：Target Lens、Preflight/Firewall、最近投递、Result Return、结果核验、成效设置及演练共 37 个定向 UI/语义测试。
- `AUTO-PASS`：参考性能——1 MiB Firewall 364.26ms（预算 750ms）、500 条活动聚合 3ms、50,000 条历史下 Lens+Preflight 36ms；环境为 macOS 15.6.1 arm64、Node 22.18.0、pnpm 10.12.1、rustc 1.87.0。
- `AUTO-PASS`：380×720 浏览器诊断在浅色、暗色与 Reduce Motion 下无水平溢出；演练区左右各 12px，减弱动效时动画/过渡为 0.01ms。
- `AUTO-PASS`：可选图片 Firewall 的坐标/Retina/contain 留白、OCR observation、规则映射、25MP 内存预算、原图 hash、Native 发送前像素复核、临时 token/重启清理、多图隔离、OCR 失败策略、迟到/重开 ABA、无 OCR 原文缓存及活动/诊断隐私均有自动测试。
- `NATIVE-LOCAL-PASS`：3000×1200 Retina synthetic PNG 经真实 macOS Vision 识别假邮箱与假 API key；测试不读通用剪贴板、不打印 OCR 原文。第三方目标接收仍不在此结论内。
- `AUTO-PASS`：`pnpm typecheck`、62 files / 611 Vitest、lint（仅 3 条既有 warning）、严格 token、204 Rust tests + 1 ignored、Clippy 与 diff-check 均通过；本轮 Rust 文件单独 rustfmt PASS。仓库级 fmt 仍受 HEAD 既有格式差异影响。
- `BUILD-CONFIRMED`：最终 `pnpm build:app` 157.4s 完成（2640 modules）；App 签名、DMG CRC 和 404-byte updater signature 有效。最终 PID 5300，诊断第 10815 行与其一致；启动后 `delivery-redactions` 无遗留文件。
- `BUILD-CONFIRMED`：binary SHA-256 `d7b8fab9da3b52484865306995977499b6a05ec75378ead3538b652b67b44f97`；DMG `1916b2cb313f34845a3d981a2a91fd70e575c7d277f7a795d04ac2621f0eac35`；updater archive `8bce164f3579189181189bf9847d0d1e319c49b77ecf3cc267e9ceefdce8b300`；前端资源 `index-ipgi6ASM.js` / `index-DVPbN2oM.css`。

## RUNTIME-REQUIRED

- 全新数据目录的真实 TCC 拒绝、稍后授权、输入监控重置和授权后事件流恢复。
- TextEdit、Safari/Chrome、Claude/ChatGPT、Codex/Cursor、Terminal 的真实焦点、粘贴、剪贴板恢复和 no-enter 行为。
- VoiceOver 完整朗读/焦点顺序，以及签名原生窗口的浅色、暗色、Reduce Motion、最窄竖窗、上/下横栏、Pin、伴随、四缘边栏、全屏 Space 与多屏。
- 发布进程静置后的 wakeups；无权限的自动工具结果不能冒充 Activity Monitor/powermetrics 证据。
- Phase 16：手机号/账号/旋转图片的真实识别边界、签名 WKWebView 区域视觉、原图磁盘 hash、应用强退清理，以及 TextEdit/第三方目标只收到遮挡副本。
- Phase 16：原图/发送图并排在 260–420pt 原生横栏、浅/深色、Reduce Motion、完整键盘和 VoiceOver 下的最终体验。

## 已知限制

- 60 秒激活只是一台机器上的内部布尔信号，不显示、不上传，也不是完成质量或绩效指标。
- 本地扫描可能误报或漏报；超过输入预算、扫描失败或未处理 finding 均 fail-closed。
- 演练使用明显假邮箱，但仍会向用户主动确认的真实目标执行一次粘贴；因此默认保留面板并永久关闭自动回车。
- 自动化可验证 DOM 语义与状态机，不能证明辅助技术或第三方 App 的真实运行行为。
- 图片 OCR 仍可能误报、漏报或不识别旋转/特殊字体；空结果不等于视觉内容绝对安全。单图超过 25MP 会在解码前进入明确失败/人工确认策略，以避免遮挡时的 RGBA 内存峰值。
- 图片高风险 finding 在所有 Profile 下都必须遮挡；只有 OCR 本身失败时，非严格 Profile 才允许用户对当前扫描 revision + 目标 token 做显式原图确认。

## 数据迁移

- Zustand schema v13→v14；Native 最大版本同步为 14。
- 旧 `captured/sent/done` 原样保留；旧 `done=true` 迁为已完成且不自动重跑，未完成状态从权限步骤开始。
- 新增字段兼容缺失与未知字段；步骤、版本、布尔值、Note ID 和非负时间由前后端共同校验。
- 演练 Draft、finalText、finding、脱敏映射和 `safeRehearsal` 不进入业务持久化或备份。
- Phase 16 无 schema 迁移：`originalImageFiles`、OCR/区域、像素 hash、遮挡 token、确认和缓存都只存在 DeliveryDraft/进程会话；Zustand 与 Native validator 仍为 v14。

## 隐私边界

- 受控示例只含公开说明与假邮箱；真实 Firewall 在本机扫描并要求处理。
- 活动与成效仍只保存白名单元数据，不保存正文、Prompt、API key、target token、finding 原值或 redaction map。
- 诊断仅允许状态、计数与耗时；测试和文档不得把 synthetic 原值扩散到日志之外。
- 图片扫描回执在写入 Draft 前丢弃 observation 原文，进程内缓存也只保留几何/置信度与脱敏 finding；activity 只记录类别/遮挡计数，诊断只记录 observation/finding/block/warn/cache/耗时，不含图片路径、区域、bytes 或临时 token。

## 回滚策略

- 代码回滚：撤回演练编排与 v14 读写，但发布前必须先保留 v14 读取兼容；直接降级到只识别 v13 的二进制会拒绝新数据，不能作为用户回滚方案。
- 数据回滚：使用完整备份/数据目录事务的既有 inspect→prepare→rehydrate→finalize/rollback 流程，禁止手改业务 JSON。
- 运行止损：用户可暂停或选择稍后，普通捕获和投递继续走原链路；目标、来源、扫描或回执不确定时继续 fail-closed。
- 图片扩展止损：关闭图片 Firewall 后只恢复既有原图投递；删除代码前先保留 `toskr-redacted:` 的只读拒绝与启动清理一个兼容周期，不能让旧临时 token 被当作普通媒体名。
- 本阶段未改版本号；用户授权的本地检查点 commit `b37a7ea` 位于 Phase 16 修改前，此后未提交、未推送、未发布。
