<div align="center">

<img src="src-tauri/icons/icon.png" alt="Toskr" width="128" height="128" />

# Toskr

**面向 AI 工作流的 macOS 菜单栏效率工具**

全局划词摘录 · Prompt 暂存 · 闪念待办 · 剪贴板历史 · AI 智能任务 · 一键流转回对话

<img src="https://img.shields.io/badge/macOS-13%2B-000000?logo=apple&logoColor=white" alt="macOS 13+" />
<img src="https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white" alt="Tauri 2" />
<img src="https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black" alt="React 18" />
<img src="https://img.shields.io/badge/Rust-stable-DEA584?logo=rust&logoColor=white" alt="Rust" />

</div>

在 ChatGPT / Claude / Cursor / 微信 / 浏览器之间穿梭时，随手捕获想留下的文字、暂存想试的 Prompt，攒够了一键发回对话。Toskr 把草稿纸、待办清单与剪贴板历史合而为一——面板内三个平级页签：**笔记**（捕获与 Prompt 队列）、**任务**（闪念与待办）、**剪贴板**（自动收集的历史流水）。常驻菜单栏，双击 Shift 即来即走；面板可四缘停靠——上下缘化身 Paste 式全宽卡片横栏。数据完全本地。

<!-- TODO: 补一张应用截图或演示 GIF -->

## ✨ 功能

面板内三个页签（⌃Tab / ⌘← ⌘→ 切换）：**笔记 · 任务 · 剪贴板**。

- **全局捕获**：任意应用选中文字，双击 ⇧ 静默入库；气泡可撤销、重复自动去重、隐身模式
- **安全发送演练**：首次启动用假邮箱依次体验权限、真实捕获、目标确认、Context Firewall 与 Preflight；演练只粘贴不回车，可暂停/稍后处理，也可从「设置 → 关于」重跑
- **随叫随走的面板**：光标屏右缘滑出、可钉住；终端 / 编辑器前台时自动磁吸伴随；可录制专属显示 / 隐藏快捷键
- **笔记**：分组管理、⌘F 搜索、全量撤销；链接卡自动抓取网页标题、图片卡原尺寸预览与离线 OCR、重命名、常用 ★ 发送后保留
- **任务**：💡 闪念速记、一键转待办；三态 + 优先级、自定义分组、检查列表与备注、到期提醒（快捷档可自定义，粘性气泡 + 红区兜底）
- **剪贴板**：自动收集历史流水；卡片模板三档可选（标准 / 浓缩 / 通栏）、卡面悬浮一键复制；固定 ★ 置顶不清理、托盘一键暂停、保留时长滑杆、机密 / 瞬时 / 应用忽略规则
- **AI 智能**（可选）：配置 OpenAI 兼容提供商（DeepSeek / OpenAI / Kimi / 通义 / 自定义）后——✨ 自然语言建任务、拆解子任务、笔记转任务、起标题；发送预检中还可显式生成总结、行动项、优化 Prompt 或结构化需求，审阅并应用后会重新经过 Context Firewall
- **边栏四缘**：面板可停靠屏幕右 / 左 / 上 / 下缘；上下缘为 Paste 式方形卡片横栏（分组胶囊过滤、滚轮横滑）
- **发回对话**：⌘⏎ 焦点精确归还后自动粘贴（未就绪即中止）；发送方案按适用应用选择提示词组、输出格式、粘贴后动作与面板保留行为，支持绑定当前目标的临时覆盖；Context Firewall 在出站前本地扫描并按方案要求脱敏或确认；完整 pasteboard 快照按 changeCount 所有权安全恢复；最近发送仅记录本地元数据，失败记录可用当前来源与新目标重新准备预检
- **结果回收**：捕获 AI 回答后可手动关联到 30 分钟内同一目标应用的成功发送；结果仍是普通可编辑笔记，活动账本只保存关联 ID，绝不自动认领或复制正文
- **结果核验**：关联结果可自动执行 JSON、必要段落、占位符与完整性检查；AI 对照必须显式点击，且只接收经本地 Firewall 脱敏的当前来源与结果。报告默认仅存当前会话，来源变化后立即失效，也可由用户保存为普通笔记或把问题送入预检
- **本地成效**：设置 → 成效与隐私按活动元数据展示成功率、阻止/失败原因、脱敏、重试与流程耗时；可选结果质量、人工基线和问题计时。无基线不估算，关闭/清除不影响发送或业务正文，全程无遥测
- **数据**：完全本地、无遥测；目录切换先预检并可回滚，完整备份包含任务分组与被引用媒体；AI API Key 只存 macOS 钥匙串，不进入数据文件或备份；iCloud / Dropbox 仅作为外部存储位置，检测冲突但不承诺自动合并或无冲突多机同步

## ⌨️ 快捷键

| 按键 | 作用 |
| --- | --- |
| 双击 ⇧ | 选中文字 → 捕获；无选中 → 呼出 / 收起面板 |
| ⌃Tab / ⌘← ⌘→ | 切换页签 |
| Space / Enter | 预览（链接开网页、图片开原图）/ 编辑 |
| ⌘⏎ / ⌘1-9 | 发送勾选 / 快发第 N 张卡 |
| ⌘F · ⌘A · ⌘C · ⌘⌫ | 搜索 · 全选 · 复制列表 · 删除 |
| 长按 ⌥ | 完整快捷键速查层 |
| Esc | 逐层退出 |

## 📦 安装

从 [Releases](https://github.com/kristalderoyysi54/toskr/releases) 下载 `Toskr_<版本>_aarch64.dmg`，打开安装盘，按界面提示把 `Toskr.app` 拖入 `Applications`。首次打开需**右键 →「打开」**绕过 Gatekeeper（自签名应用）。

**自动更新**：应用启动后会静默检查 GitHub Releases，发现新版在右上角气泡提醒；也可在 设置 → 关于 中手动「检查更新」，一键下载安装并自动重启（更新包经 minisign 签名校验）。

### 从源码构建

**环境要求**：macOS 13+ · Node.js 20+ 与 pnpm · Rust 稳定版工具链 · Xcode Command Line Tools

```bash
git clone https://github.com/kristalderoyysi54/toskr.git
cd toskr
pnpm install
pnpm tauri dev    # 开发运行
pnpm build:app    # 打包 → .app + 可拖拽安装的 .dmg
```

**关于签名**：`tauri.conf.json` 默认指定自签名证书 `Toskr Dev Signing`，好处是签名跨编译稳定，重新构建后无需重新授予辅助功能权限。首次构建前二选一：

- 创建同名证书：钥匙串访问 → 证书助理 → 创建证书（名称 `Toskr Dev Signing`，证书类型「代码签名」），创建后在证书的信任设置中启用
- 或删去 `bundle.macOS.signingIdentity` 配置退回 ad-hoc 签名（代价：每次重新编译都要在系统设置里重新授权辅助功能）

## 🔐 权限说明

Toskr 依赖 macOS **辅助功能**权限（个别系统版本还需**输入监控**，应用内横幅会提示），用途：

- 监听全局键盘 —— 检测「双击 ⇧」手势
- 读取选中文本与窗口位置 —— 划词捕获、伴随停靠
- 合成按键 —— 发送时自动执行 ⌘V

首次启动按引导操作：系统设置 → 隐私与安全性 → **辅助功能** → 勾选 Toskr，授权后即时生效、无需重启。数据处理均在本地完成；仅三种情况按需联网：检查更新（GitHub）、抓取链接卡标题、你主动触发的 AI 功能。AI 内容只发往自己配置的提供商；远端地址必须使用 HTTPS，本机 `localhost` / `127.0.0.1` / `::1` 可显式使用 HTTP。

## 🛠 技术栈与实现

Tauri v2（Rust）· React 18 · TypeScript · Tailwind CSS v4 · shadcn/ui · Zustand · motion · dnd-kit

几个有意思的实现点：

- **双击检测**：CGEventTap 挂主线程 CFRunLoop + 参数化纯状态机（单测覆盖），规避 rdev 多年未修复的段错误
- **划词读取**：AX API 直读优先（零副作用）；复制回退使用完整快照，仅接受固定采纳窗内唯一稳定、且前台身份与真实输入未漂移的 changeCount revision，并在迟到恢复宽限窗后按所有权安全恢复
- **伴随停靠**：AX 读取目标窗口 frame + 60ms 跟随循环 + 纯函数矩形计算（多屏 / 缩放均有单测）
- **悬停撤销**：点击穿透的窗口收不到鼠标事件，改用 CGEvent 全局光标轮询命中检测，动态切换穿透状态
- **全屏可见**：NSWindow `collectionBehavior += FullScreenAuxiliary`

## 🧑‍💻 开发

```bash
pnpm tauri dev     # 开发运行（调试进程的权限附着于启动它的终端）
pnpm test          # 前端单测（vitest）
pnpm typecheck     # TypeScript 检查
cargo test         # Rust 单测（src-tauri 目录下执行）
pnpm build:app     # 产出 .app
```

手动验收清单见 [docs/manual-qa.md](docs/manual-qa.md)。

**发版**：`./script/release.sh 0.11.0 "更新说明"` —— 自动完成版本号写入、签名打包、校验 DMG、生成 `latest.json`、创建 GitHub Release，并上传 DMG 与自动更新包（需 `gh` CLI 登录与 `~/.tauri/toskr-updater.key` updater 私钥）。

> 中国大陆网络：`src-tauri/.cargo/config.toml` 已配置 rsproxy.cn crates 镜像，如需全局生效可复制到 `~/.cargo/config.toml`。

## 🙏 致谢

灵感与原型来自 [shadcn](https://github.com/shadcn) 的 Copper，在其基础上重写并大幅增强。

## 📄 许可证

[Apache License 2.0](LICENSE)
