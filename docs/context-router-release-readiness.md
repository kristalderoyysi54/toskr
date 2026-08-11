# Context Router 发布准备度

> Phase 15 本地候选｜2026-08-11（Asia/Shanghai）
> 本文是当前工作树的证据清单，不是 release，也不替代真实 macOS 运行回归。

## 已通过门禁

- `CODE-CONFIRMED`：演练使用普通 Note 与唯一 DeliveryDraft/Firewall/Preflight/Native 投递管线；Draft、store 和执行器均强制只粘贴、不按回车。
- `AUTO-PASS`：onboarding 暂停/恢复、权限五态、旧用户 v13→v14、受控来源/目标门禁、Firewall 必须处理、Preflight accessible state、发送回执与完成状态。
- `AUTO-PASS`：Target Lens、Preflight/Firewall、最近投递、Result Return、结果核验、成效设置及演练共 37 个定向 UI/语义测试。
- `AUTO-PASS`：参考性能——1 MiB Firewall 364.26ms（预算 750ms）、500 条活动聚合 3ms、50,000 条历史下 Lens+Preflight 36ms；环境为 macOS 15.6.1 arm64、Node 22.18.0、pnpm 10.12.1、rustc 1.87.0。
- 全量 typecheck、Vitest、lint、design token、Rust、clippy、生产构建、签名/DMG、启动 PID 与产物 SHA 以本阶段最终门禁记录为准。

## RUNTIME-REQUIRED

- 全新数据目录的真实 TCC 拒绝、稍后授权、输入监控重置和授权后事件流恢复。
- TextEdit、Safari/Chrome、Claude/ChatGPT、Codex/Cursor、Terminal 的真实焦点、粘贴、剪贴板恢复和 no-enter 行为。
- VoiceOver 完整朗读/焦点顺序，以及浅色、暗色、Reduce Motion、最窄竖窗、上/下横栏、Pin、伴随、四缘边栏、全屏 Space 与多屏。
- 发布进程静置后的 wakeups；无权限的自动工具结果不能冒充 Activity Monitor/powermetrics 证据。

## 已知限制

- 60 秒激活只是一台机器上的内部布尔信号，不显示、不上传，也不是完成质量或绩效指标。
- 本地扫描可能误报或漏报；超过输入预算、扫描失败或未处理 finding 均 fail-closed。
- 演练使用明显假邮箱，但仍会向用户主动确认的真实目标执行一次粘贴；因此默认保留面板并永久关闭自动回车。
- 自动化可验证 DOM 语义与状态机，不能证明辅助技术或第三方 App 的真实运行行为。

## 数据迁移

- Zustand schema v13→v14；Native 最大版本同步为 14。
- 旧 `captured/sent/done` 原样保留；旧 `done=true` 迁为已完成且不自动重跑，未完成状态从权限步骤开始。
- 新增字段兼容缺失与未知字段；步骤、版本、布尔值、Note ID 和非负时间由前后端共同校验。
- 演练 Draft、finalText、finding、脱敏映射和 `safeRehearsal` 不进入业务持久化或备份。

## 隐私边界

- 受控示例只含公开说明与假邮箱；真实 Firewall 在本机扫描并要求处理。
- 活动与成效仍只保存白名单元数据，不保存正文、Prompt、API key、target token、finding 原值或 redaction map。
- 诊断仅允许状态、计数与耗时；测试和文档不得把 synthetic 原值扩散到日志之外。

## 回滚策略

- 代码回滚：撤回演练编排与 v14 读写，但发布前必须先保留 v14 读取兼容；直接降级到只识别 v13 的二进制会拒绝新数据，不能作为用户回滚方案。
- 数据回滚：使用完整备份/数据目录事务的既有 inspect→prepare→rehydrate→finalize/rollback 流程，禁止手改业务 JSON。
- 运行止损：用户可暂停或选择稍后，普通捕获和投递继续走原链路；目标、来源、扫描或回执不确定时继续 fail-closed。
- 本阶段未改版本号；允许本地检查点提交，但未推送、未发布。
