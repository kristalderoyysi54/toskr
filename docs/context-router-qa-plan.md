# Context Router 分阶段 QA 计划

> Phase 00 预留表｜适用阶段：01、02、02A、03–16
> 本文定义场景编号、证据字段和停止线；它不是“已通过”报告。

## 1. 执行顺序与停止线

唯一顺序为：

`00 → 01 → 02 → 02A → 03 → 04 → 05 → 06 → 07 → 08 → 09 → 10 → 11 → 12 → 13 → 14 → 15 →（可选）16`

依赖以任务包 `00_README_AND_SEQUENCE.md` 为准。01、02、02A 任一 P0、数据 hash 不一致、
回滚失败或用户剪贴板污染，立即停止后续阶段。05 前不得新增第二套载荷拼装；08 前不得
自动外发；09 前不得新增 AI 能力；11 前不得自动重试。

## 2. 场景与证据契约

### 2.1 状态词

| 状态 | 定义 |
|---|---|
| `PASS` | 预期、实际和证据三者一致；所有必需 artifact 可复核 |
| `FAIL` | 可执行但实际不满足预期；必须关联缺陷，不能降级为 partial |
| `PARTIAL` | 只验证了明确列出的部分层级；必须写出未验证断言 |
| `BLOCKED` | 环境/权限使步骤无法执行；记录阻塞点、已完成步骤和解除条件 |
| `RUNTIME-REQUIRED` | 静态/自动证据不能证明真实 macOS 跨应用行为，等待原生手测 |

禁止用 `CODE-CONFIRMED` 或旧工作簿记录替代本阶段运行结果。一个场景包含多个关键断言时，
任何安全断言失败，整个场景为 `FAIL`。

### 2.2 每次 run 必填字段

```yaml
run_id: CTX-RUN-YYYYMMDD-HHMMSS
stage: "01"
commit_sha: 40-char SHA
baseline_sha: e000aa31413a8fc2b022e9ed9a5ac0505fdcee18
branch: main
worktree_fingerprint: "git status --short + relevant diff sha256"
started_at: ISO-8601 with timezone
finished_at: ISO-8601 with timezone
operator: string
reviewer: string | null
environment:
  macos: string
  architecture: arm64 | x86_64
  app_version: string
  bundle_path: absolute path
  binary_sha256: string
  frontend_asset_key: string
  permissions: { accessibility: string, input_monitoring: string, screen_recording: string }
data_isolation:
  data_dir: absolute temporary/test path
  original_data_touched: false
  pre_hash: string | null
  post_hash: string | null
commands: []
artifacts: []
```

### 2.3 每个 scenario 必填字段

```yaml
scenario_id: CTX-01-001
requirement_source: "01_send_contract_and_target_snapshot.md#必须新增或更新的测试-1"
capability: target
priority: P0 | P1 | P2
layer: ts-unit | rust-unit | integration | native-manual | accessibility | migration
preconditions: []
fixture:
  id: string
  classification: synthetic | public | local-nonsensitive
steps: []
expected: []
observed: []
status: PASS | FAIL | PARTIAL | BLOCKED | RUNTIME-REQUIRED
reason_code: string | null
runtime_required: true | false
evidence:
  test_output: path-or-log-anchor | null
  screenshot_or_video: path | null
  diagnostic_excerpt: path-and-line-anchor | null
  state_snapshot: path | null
  before_after_hashes: {} | null
privacy_review:
  raw_body_in_logs: false
  secret_in_logs: false
  redaction_map_persisted: false
regressions: []
defect_id: string | null
notes: string
```

证据文件不得包含真实公司正文、凭据、Token、API key、完整 Prompt 或可逆脱敏映射。
截图若不可避免地含个人/公司信息，先离线脱敏并保留原件仅在用户明确授权的受控位置。

## 3. 通用测试隔离

1. TypeScript/Rust 自动化使用 synthetic fixture；不得请求真实 AI 或真实公司 API。
2. pasteboard 自动化使用命名 pasteboard、fake adapter 或纯函数快照；不得改用户通用剪贴板。
3. 原生手测开始前记录剪贴板/data-dir 前置 hash，结束后验证恢复；失败也要执行收尾核验。
4. AI 场景使用本地 stub provider；只有阶段 09 的明确原生手测可在用户授权后使用测试 key。
5. 数据迁移、备份和媒体测试只在临时目录运行，路径穿越 fixture 不能逃出临时根。
6. 每个阶段固定执行完整门禁与生产构建；UI/原生行为另保留独立 `native-manual` 证据。

## 4. 阶段场景预留

### 阶段 01｜结构化目标快照与发送结果

| 场景 ID | 优先级/层 | 场景与关键预期 |
|---|---|---|
| CTX-01-001 | P0 / Rust | 无 target token 返回 `blocked/target_token_missing`，paste 与 Enter 调用均为 0；快照本身不存在使用 `target_missing` |
| CTX-01-002 | P0 / Rust | PID 相同但 bundle/process generation 不匹配，返回稳定 blocked code |
| CTX-01-003 | P0 / Rust | 目标进程退出，返回 `target_exited`，无副作用 |
| CTX-01-004 | P0 / Rust | 粘贴前焦点漂移，不写 pasteboard、不粘贴 |
| CTX-01-005 | P0 / Rust | 已粘贴后、Enter 前焦点漂移，抑制 Enter 并返回非 sent 结果 |
| CTX-01-006 | P0 / TS | 只有 `status=sent` 才更新 done、checked、onboarding；blocked/failed 均保留 |
| CTX-01-007 | P1 / Integration | 笔记、任务、单条、批量、快捷键都调用同一强类型原生契约 |
| CTX-01-008 | P1 / Regression | 正常目标下文本、图片、keepPanel、可选 Enter 行为保持 |
| CTX-01-009 | P1 / Integration | HUD 文案、目标名与结构化结果一致，不声称未发生的剪贴板动作 |
| CTX-01-R01 | P0 / Native | App A→Toskr→切 App B；验证不会粘贴到 B，也不会错误 Enter |

### 阶段 02｜完整剪贴板事务

| 场景 ID | 优先级/层 | 场景与关键预期 |
|---|---|---|
| CTX-02-001 | P0 / Rust | text、HTML、RTF、PNG、file URL、多 item 快照逐类型往返 |
| CTX-02-002 | P0 / Rust | 发送期间 changeCount 被用户更新，旧快照不得恢复 |
| CTX-02-003 | P0 / Rust | Toskr 连续写多图，只认可最后一次 owned changeCount |
| CTX-02-004 | P0 / Rust | restore 失败后不二次写 pasteboard，结果明确 failed |
| CTX-02-005 | P0 / Rust | 捕获回退覆盖超时、无选区、目标延迟复制，不采用历史无关内容 |
| CTX-02-006 | P1 / Architecture | 发送与捕获调用同一 pasteboard transaction 实现，无平行快照逻辑 |
| CTX-02-007 | P0 / Privacy | diag/activity 中不存在任何原始 pasteboard item |
| CTX-02-R01 | P0 / Native | 富文本、网页 HTML、图片、Finder 文件和多 item 发送后仍可原样粘贴 |
| CTX-02-R02 | P0 / Native | 发送后立即复制新文本/图片；1.5s 后仍是用户新内容 |

### 阶段 02A｜数据目录、完整备份与媒体完整性

| 场景 ID | 优先级/层 | 场景与关键预期 |
|---|---|---|
| CTX-02A-001 | P0 / Migration | 目标不存在、空、普通非空、有效 Toskr、损坏 JSON、只读、同路径均有确定结果 |
| CTX-02A-002 | P0 / Migration | 源/目标都有效时 load、cancel、显式 replace 三路互不混淆 |
| CTX-02A-003 | P0 / Migration | replace 前恢复快照失败，目标 0 修改 |
| CTX-02A-004 | P0 / Rust | copy、verify、pointer commit、rehydrate 各阶段故障注入都回滚 |
| CTX-02A-005 | P0 / TS | 防抖写 flush 失败时不切换目录 |
| CTX-02A-006 | P0 / Integration | 切换完成后 store 从新目录真实 rehydrate，不沿用旧内存 |
| CTX-02A-007 | P0 / Migration | store migrate 失败回到原目录和原内存状态 |
| CTX-02A-008 | P0 / Integration | revision/hash/mtime 冲突阻止陈旧状态覆盖 |
| CTX-02A-009 | P0 / Rust | manifest schema、hash、路径穿越、超限、重复路径、损坏归档 fail-closed |
| CTX-02A-010 | P0 / Roundtrip | notes/tasks/sections/taskSections/settings/媒体完整往返，数量与 hash 一致 |
| CTX-02A-011 | P0 / Privacy | 备份不含 AI key、secret 和明确禁止字段 |
| CTX-02A-012 | P0 / Media | 同图多引用、undo 待引用、重启后 GC 均不产生空引用 |
| CTX-02A-013 | P1 / Media | 缺失/孤立媒体只报告，不静默删除 |
| CTX-02A-014 | P0 / Concurrency | 数据事务期间捕获/编辑不会写进错误目录 |
| CTX-02A-015 | P1 / Integration | Settings 与 main webview 收到相同活动目录变化 |
| CTX-02A-016 | P1 / Docs | `docs/manual-qa.md` 覆盖切换、恢复、冲突与媒体撤销矩阵 |
| CTX-02A-017 | P0 / Crash recovery | journal、forward displace、rollback capture/recovery copy 任一崩溃点均可幂等恢复；未知外部版本绝不删除 |
| CTX-02A-018 | P0 / OCC | 目录或备份预检 A→确认前替换 B 时，执行按冻结 revision 拒绝且不使用 A 的报告描述 B |
| CTX-02A-019 | P0 / Startup | 自定义目录离线、指针损坏或默认数据损坏进入 recovery-only；普通写关闭但有效目标恢复入口可用 |
| CTX-02A-020 | P0 / WebView | Native pending operation 跨 main WebView reload 续接；最终 hydration、运行时设置和启动 GC 对齐同一目录 |
| CTX-02A-021 | P0 / Media OCC | 墓碑绑定文件 generation；同名外部替换、重复排期、批次中途冲突均保留外部版本并回放本批隔离项 |
| CTX-02A-022 | P0 / Media crash | GC journal 在 rename 前落盘；journal/rename/unlink 三个崩溃点重启后均恢复或完成，墓碑不丢失 |
| CTX-02A-023 | P0 / Conflict recovery | 恢复副本只包含与内存内容身份一致的媒体；同名像素替换必须拒绝，不能生成混合归档 |
| CTX-02A-024 | P1 / Runtime settings | rehydrate 的 Native 设置全部完成后才 finalize；失败回滚并等待旧设置恢复后再解锁 |
| CTX-02A-R01 | P0 / Native | 临时目录完整迁移→重启→逐项核对→恢复原目录，前后 hash 一致 |

### 阶段 03｜Target Lens UI

| 场景 ID | 优先级/层 | 场景与关键预期 |
|---|---|---|
| CTX-03-001 | P0 / Integration | Lens 内容与原生 snapshot token/generation 一致 |
| CTX-03-002 | P1 / TS | 高频目标事件不无限渲染、不重复请求应用图标 |
| CTX-03-003 | P1 / TS | unknown/refreshing/ready/blocked 四态稳定且可访问 |
| CTX-03-004 | P0 / TS | 所有可点击发送入口在 blocked 时禁用 |
| CTX-03-005 | P0 / Integration | 快捷键绕过按钮仍被前端状态与原生验证双重阻止 |
| CTX-03-006 | P1 / Native | Pin 后切到 App B，Lens 显示 B |
| CTX-03-007 | P1 / Native | 关闭磁吸仍正确识别目标 |
| CTX-03-008 | P1 / Native | 磁吸 App A、实际发送目标 B 时显示 B 而不是 A |
| CTX-03-R01 | P1 / Accessibility | VoiceOver 读出目标、应用名、状态、Enter 策略；窄面板不溢出 |

### 阶段 04｜Target Profile 与 Prompt 分组

| 场景 ID | 优先级/层 | 场景与关键预期 |
|---|---|---|
| CTX-04-001 | P0 / Migration | v7→新版本后 snippet 数量、文本、ID 和顺序不丢失 |
| CTX-04-002 | P0 / Migration | 旧 autoEnter=true 不迁移为无提示自动 Enter |
| CTX-04-003 | P1 / TS | 临时覆盖 > bundle 精确匹配 > 用户默认 > 安全默认的优先级确定 |
| CTX-04-004 | P1 / TS | 删除 Profile/group/snippet 后引用修复且无孤儿 |
| CTX-04-005 | P1 / TS | 重复 bundle 有确定性 winner 与 UI 警告 |
| CTX-04-006 | P1 / TS | 目标变化不静默覆盖本次用户选择 |
| CTX-04-007 | P1 / Integration | Settings/main 多 webview 通过既有 settingsSync 同步 |
| CTX-04-R01 | P1 / Native | Codex/Claude/浏览器/终端/未知应用命中正确 Profile，终端默认不 Enter |

### 阶段 05｜DeliveryDraft 单一投递管线

| 场景 ID | 优先级/层 | 场景与关键预期 |
|---|---|---|
| CTX-05-001 | P0 / Integration | 所有入口最终只调用 `executeDeliveryDraft` |
| CTX-05-002 | P0 / Architecture | 搜索与测试证明仓库不存在第二套 finalText 拼装 |
| CTX-05-003 | P0 / TS | tooltip/preflight 的 finalText 与原生命令接收字节完全一致 |
| CTX-05-004 | P1 / TS | 图片顺序稳定、去重确定、不可读图片显式失败 |
| CTX-05-005 | P1 / TS | Profile/format/Prompt/enterPolicy 都可从 Draft 检查 |
| CTX-05-006 | P0 / Integration | 失败恢复面板、选择和 Draft，不标完成 |
| CTX-05-007 | P1 / Regression | 旧快捷键、右键和预览发送保持可用 |
| CTX-05-008 | P0 / TS | source 或 target revision stale 时执行次数为 0 |
| CTX-05-R01 | P1 / Native | 各入口发送同一 fixture，目标收到载荷逐字节一致 |

### 阶段 06｜Preflight Composer

| 场景 ID | 优先级/层 | 场景与关键预期 |
|---|---|---|
| CTX-06-001 | P1 / TS | smart/always/off 三策略准确进入或跳过预检 |
| CTX-06-002 | P1 / TS | finalText 编辑、reset、revision 单调且可预测 |
| CTX-06-003 | P0 / TS | 目标变化使 Draft stale，确认按钮不可执行 |
| CTX-06-004 | P0 / TS | 重复 Cmd+Enter 只产生一个 requestId |
| CTX-06-005 | P1 / TS | Esc 关闭预检但保留 Note 选择 |
| CTX-06-006 | P1 / TS | 成功后清会话 Draft |
| CTX-06-007 | P1 / TS | 失败后 Draft 可编辑并重新准备 |
| CTX-06-008 | P1 / Accessibility | VoiceOver 读出目标、Enter、warning、按钮状态；焦点闭环 |
| CTX-06-R01 | P1 / Native | 文本+多图+Prompt 复杂投递完整显示并只发送确认版本 |

### 阶段 07｜Context Firewall 文本引擎

| 场景 ID | 优先级/层 | 场景与关键预期 |
|---|---|---|
| CTX-07-001 | P0 / Rust | 每条规则均有正例、近似反例和边界反例 |
| CTX-07-002 | P0 / Integration | Rust range 转 UTF-16 后前端精确高亮 emoji/CJK/组合字符 |
| CTX-07-003 | P1 / Rust | overlap 排序与归并确定，重复运行完全一致 |
| CTX-07-004 | P0 / Privacy | finding 不含完整 block secret，仅不可逆最小提示 |
| CTX-07-005 | P1 / Rust | 空、超限、替代字符输入不 panic，reason 稳定 |
| CTX-07-006 | P0 / Network | command 在网络禁用环境仍全绿，调用计数为 0 |
| CTX-07-007 | P0 / Privacy | diag/activity/test artifact 均无命中原文 |

### 阶段 08｜Firewall 策略与脱敏 UI

| 场景 ID | 优先级/层 | 场景与关键预期 |
|---|---|---|
| CTX-08-001 | P1 / TS | 同值多处使用同一稳定 placeholder |
| CTX-08-002 | P0 / TS | Unicode 替换不破坏正文或 range |
| CTX-08-003 | P1 / TS | overlap 替换确定且不可重复覆盖 |
| CTX-08-004 | P0 / Integration | block finding 不能被按钮、快捷键、裸 command 绕过 |
| CTX-08-005 | P0 / TS | warn 确认只绑定同 draft revision + target generation |
| CTX-08-006 | P0 / Policy | allowRaw 也强制 `pressEnter=false` |
| CTX-08-007 | P0 / Integration | quick send 有 finding 时只进 Preflight，原生发送次数 0 |
| CTX-08-008 | P0 / Privacy | 发送/取消后 redactionMap 立即清理 |
| CTX-08-009 | P0 / Privacy | store、backup、diag、activity 中无原值或映射 |
| CTX-08-R01 | P1 / Native | token/email/account fixture：block、warn、替换、stale 全流程 |

### 阶段 09｜AI 密钥与传输安全

| 场景 ID | 优先级/层 | 场景与关键预期 |
|---|---|---|
| CTX-09-001 | P0 / Migration | legacy JSON key 写 Keychain、回读成功后从 JSON 清除 |
| CTX-09-002 | P0 / Migration | Keychain 写/读失败时保留唯一副本并阻止破坏性写回 |
| CTX-09-003 | P0 / Rust | URL 覆盖 HTTPS、localhost、127.0.0.1、IPv6、userinfo、非法 scheme |
| CTX-09-004 | P0 / Process | curl/子进程 argv 不含 Authorization 或 key |
| CTX-09-005 | P1 / Integration | 多窗口只同步 key configured status，不同步 secret |
| CTX-09-006 | P0 / Privacy | 日志、error object、backup、活动中无 secret |
| CTX-09-007 | P1 / Regression | 未配置/删除/网络/解析失败均保留原输入且提示准确 |
| CTX-09-R01 | P0 / Native | Keychain 设置→现有任务 AI→删除；非 loopback HTTP 被阻止 |

### 阶段 10｜AI 显式转换预览

| 场景 ID | 优先级/层 | 场景与关键预期 |
|---|---|---|
| CTX-10-001 | P0 / TS | 未解决 block finding 时 provider 请求次数 0 |
| CTX-10-002 | P0 / TS | stale revision 的 AI 响应不可应用 |
| CTX-10-003 | P1 / TS | cancel 不写 Draft 或 source Note/Task |
| CTX-10-004 | P0 / TS | apply 后重新扫描并撤销旧确认 |
| CTX-10-005 | P1 / TS | 网络/超时/解析/空结果均保留原文 |
| CTX-10-006 | P1 / TS | 同一 Draft/recipe 并发请求去重 |
| CTX-10-007 | P1 / Accessibility | 调用前明确显示 provider/model/data scope，原文与结果可比较 |
| CTX-10-R01 | P1 / Native | 显式触发→比较→应用→重新扫描→撤销，源内容不被自动覆盖 |

### 阶段 11｜投递活动与恢复

| 场景 ID | 优先级/层 | 场景与关键预期 |
|---|---|---|
| CTX-11-001 | P0 / Privacy | activity 文件仅元数据，不含正文、Prompt、secret、映射 |
| CTX-11-002 | P1 / Rust | 单行损坏可隔离，其余记录仍可读 |
| CTX-11-003 | P1 / Rust | 数量/时间轮转和留存生效 |
| CTX-11-004 | P0 / Integration | retry 只打开新 Draft/Preflight，不直接发送 |
| CTX-11-005 | P0 / TS | source 被修改后使用新内容并重新扫描 |
| CTX-11-006 | P1 / TS | source 被删除时安全失败、可行动反馈 |
| CTX-11-007 | P0 / Target | retry 永不复用旧 target token |
| CTX-11-008 | P0 / Data | 清活动不影响 Note、Task、媒体、ResultLink |
| CTX-11-R01 | P1 / Native | HUD 消失后查失败→重新准备→重新选目标→确认发送 |

### 阶段 12｜Result Return

| 场景 ID | 优先级/层 | 场景与关键预期 |
|---|---|---|
| CTX-12-001 | P0 / Migration | 旧 Note 迁移后 ID、正文、顺序、媒体不变 |
| CTX-12-002 | P1 / TS | 单候选建议、多候选选择、无候选三态正确 |
| CTX-12-003 | P1 / TS | 候选 bundle 与时间窗口规则确定 |
| CTX-12-004 | P0 / Policy | 自动关联永不发生，必须用户显式选择 |
| CTX-12-005 | P0 / Privacy | resultCaptured event 不含结果正文 |
| CTX-12-006 | P1 / Data | 源 Note 删除后 link 保留并显示来源缺失 |
| CTX-12-007 | P1 / Data | result Note 删除后活动显示结果不存在 |
| CTX-12-008 | P0 / Privacy | session placeholder 仅在瞬态映射仍存在时可恢复 |
| CTX-12-R01 | P1 / Native | 捕获 AI 回答→显式关联→打开来源→解除关联，正文不丢 |

### 阶段 13｜Result Verification

| 场景 ID | 优先级/层 | 场景与关键预期 |
|---|---|---|
| CTX-13-001 | P1 / TS | JSON、placeholder、必需段落检查准确且给出证据，不宣称正确 |
| CTX-13-002 | P0 / Policy | AI 核验前来源/结果的 block finding 必须处理 |
| CTX-13-003 | P0 / TS | source/result 变化使 report stale，不可应用 |
| CTX-13-004 | P1 / TS | 错误 JSON、超时、取消、空响应不改 result Note |
| CTX-13-005 | P0 / Privacy | verification activity 不含来源或结果正文 |
| CTX-13-006 | P1 / Data | 保存报告生成普通 Note 并保留 ResultLink |
| CTX-13-R01 | P1 / Native | 本地检查→显式 AI 核验→来源变化→stale→保存问题 Note |

### 阶段 14｜Outcome Intelligence

| 场景 ID | 优先级/层 | 场景与关键预期 |
|---|---|---|
| CTX-14-001 | P1 / TS | 中位数、百分比、时间范围、filter 的 golden fixture 准确 |
| CTX-14-002 | P1 / UX | 0/1/小样本不显示误导趋势或百分比 |
| CTX-14-003 | P0 / Policy | 无用户基线时不计算节省时间 |
| CTX-14-004 | P0 / UX | 实测值与估算值标签、公式和时间窗口清楚 |
| CTX-14-005 | P0 / Data | metrics off 后不追加指标事件 |
| CTX-14-006 | P0 / Data | 清指标不删除业务数据或活动原始事件 |
| CTX-14-007 | P0 / Privacy | 聚合器从不读取正文，只读已批准元数据 |
| CTX-14-008 | P1 / Robustness | 损坏活动记录不使 dashboard 崩溃 |
| CTX-14-R01 | P1 / Native | 配基线前后对比；关闭/清除/缩短留存逐项验证 |

### 阶段 15｜Onboarding、无障碍与发布硬化

| 场景 ID | 优先级/层 | 场景与关键预期 |
|---|---|---|
| CTX-15-001 | P1 / TS | onboarding 可暂停、退出、重启后恢复 |
| CTX-15-002 | P0 / Native | 权限拒绝、稍后授权、系统事件流拦截为不同状态和行动 |
| CTX-15-003 | P0 / Policy | 演练中的自动 Enter 始终关闭 |
| CTX-15-004 | P1 / Migration | 已完成 onboarding 的旧用户不被强制重做 |
| CTX-15-005 | P1 / Accessibility | 所有新增控件有 accessible name/state/description |
| CTX-15-006 | P1 / Visual | 最窄支持窗口无横向溢出、系统粗滚动条或遮挡 |
| CTX-15-007 | P1 / Performance | 目标事件、扫描、预检、活动列表的样本环境和耗时可复核 |
| CTX-15-008 | P0 / Release | 所有阶段测试/build/启动指纹通过；未跑项明确 RUNTIME-REQUIRED |
| CTX-15-R01 | P0 / Native | 全新临时数据完成权限→捕获→Lens→Firewall→Preflight→投递演练 |
| CTX-15-R02 | P1 / Accessibility | 全键盘访问、VoiceOver、减弱动效、浅/深色、标准/紧缩密度回归 |

### 阶段 16｜可选图片防火墙

| 场景 ID | 优先级/层 | 场景与关键预期 |
|---|---|---|
| CTX-16-001 | P1 / Geometry | bounding box 在 1x/2x、缩放视图和 Retina 图片映射准确 |
| CTX-16-002 | P1 / OCR | 多行与旋转图片的支持/不支持边界明确 |
| CTX-16-003 | P0 / Media | 脱敏前后原图文件 hash 不变 |
| CTX-16-004 | P0 / Media | 临时副本只在所需生命周期存在，崩溃恢复可清理 |
| CTX-16-005 | P1 / TS | 多图 finding、遮盖和 revision 互不污染 |
| CTX-16-006 | P0 / Policy | OCR 失败为明确 risk/block，不当作通过 |
| CTX-16-007 | P0 / Privacy | activity/diag 不含 OCR 正文或原图副本 |
| CTX-16-R01 | P1 / Native | 邮箱/手机号/token/账号截图：本地识别→预览遮盖→只发送副本 |

## 5. 每阶段完成报告最小内容

1. 运行 ID、commit SHA、worktree fingerprint、构建二进制 hash 和前端 asset key。
2. 本阶段全部场景的 `PASS/FAIL/PARTIAL/BLOCKED/RUNTIME-REQUIRED` 汇总。
3. 每个非 PASS 场景的未验证断言、缺陷/阻塞原因和下一动作。
4. 自动命令原始退出状态；不得用 grep/tail 管道吞掉失败码。
5. 原生手测的目标应用、操作时间线、截图/视频与诊断锚点。
6. 数据/剪贴板 before-after hash 和恢复结论。
7. 隐私检查：日志、activity、backup、错误对象中无正文/secret/映射。
8. 明确声明未提交、未推送、未发版、未修改版本号。

## 6. Readiness 判定

- `READY FOR NEXT STAGE`：本阶段所有 P0 为 PASS；依赖阶段仍为 PASS；无数据恢复差异；
  必需 native-manual 已完成，或任务文件明确允许并已标注的非安全行为为
  `RUNTIME-REQUIRED`。
- `STOP`：任一 P0 FAIL、剪贴板/数据未恢复、目标错误投递、secret 泄露、自动 Enter
  越权、迁移不可逆或证据无法归因到当前二进制。
- `READY FOR RELEASE`：只能由阶段 15 判定；历史 QA、静态检查或单次 build 均不能单独
  得出此结论。阶段 16 是可选扩展，不阻塞核心发布，但启用后必须通过其全部 P0。
