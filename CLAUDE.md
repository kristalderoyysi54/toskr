# Toskr 项目指南

macOS 菜单栏效率工具：全局划词捕获（双击 ⇧）→ 队列管理 → 一键发回对话。
Tauri v2（Rust）+ React 18 + TS + Tailwind v4 + Zustand。仅打 macOS 包（`targets: ["app"]`）。

## 常用命令

```bash
pnpm tauri dev     # 开发（调试进程权限附着于启动它的终端）
pnpm test          # 前端单测 vitest
pnpm typecheck     # TS 检查
cargo test         # Rust 单测（src-tauri 下执行）
pnpm build:app     # 打包 → src-tauri/target/release/bundle/macos/Toskr.app
```

## 发版流程

```bash
./script/release.sh 0.3.1 "更新说明"
```

脚本自动完成：写版本号进 `tauri.conf.json` → `touch lib.rs` 强制重编译 → 签名打包 → 生成 `latest.json` → git 提交推送 → `gh release create` 上传三件套（`Toskr.app.tar.gz` + `.sig` + `latest.json`）。

**前置条件**：`gh` CLI 已登录；updater 私钥在 `~/.tauri/toskr-updater.key`。

**发版后必须验证**（脚本不做，手动执行）：
1. 二进制自报版本：启动后读诊断日志应见「启动 v<新版本>」——**不能只看 Info.plist**
2. 远端产物一致性：下载 Release 的 tar.gz 与本地 md5 比对；latest.json 里的 signature 与本地 `.sig` 内容一致
3. 旧版本应用启动 8 秒后应弹「发现新版本」气泡；设置 → 关于 能走完下载安装重启

**红线**：
- `~/.tauri/toskr-updater.key` **绝不能丢、绝不能进 Git**——公钥已烧进应用，丢了私钥就永远无法给存量用户推更新
- 版本号唯一来源是 `tauri.conf.json`（package.json 恒为 0.0.0，勿动）

## 开发注意点（踩过的坑）

### 构建与版本
- **`generate_context!` 在编译期嵌入 tauri.conf.json 的版本号，但 cargo 不追踪该依赖**。改版本号后直接 build 会打出「Info.plist 是新版、二进制自报旧版」的包，用户陷入无限更新提示。任何改动 conf 后的手动构建，先 `touch src-tauri/src/lib.rs`
- **项目改名/移动目录后 `src-tauri/target` 缓存指向旧绝对路径**导致构建失败（"failed to read plugin permissions … /旧路径/…"），`cargo clean` 解决
- **Tauri 内嵌前端资源是 brotli 压缩的**：在二进制里 grep 业务字符串会假阴性；要验证前端是否最新，比对资源路径键（明文，如 `index-<hash>.js`）与 dist 文件名

### 签名与权限（TCC）
- 打包用钥匙串里的自签证书 **"Toskr Dev Signing"**（`bundle.macOS.signingIdentity`）。辅助功能授权绑定签名——**同一证书重编译无需重新授权**；换证书/换机器则要重新授权
- Sequoia 上 **Accessory 激活策略是 CGEventTap 创建成功的前提**，必须先于 tap 安装（lib.rs 已按此顺序，勿调整）
- tap 创建成功 ≠ 事件送达：缺「输入监控」权限时事件被 TCC 静默扣留。诊断看 `tap_status` 的 `receiving` 与日志「键盘事件流已到达」

### 部署与验证
- **`open` 不会重启已在运行的应用**。部署必须：`pkill -x toskr` → `open <bundle>` → 核对新 pid + 诊断日志「启动 v… pid=…」指纹
- **后台 shell 里 `open` 拉起的 GUI 实例约 2 分钟会被系统回收**（会话绑定回收，无崩溃报告）。关键场景最后一步启动交给用户手动做
- **诊断先读日志再猜**：`~/Library/Application Support/com.toskr.app/toskr-diag.log`（触发/捕获/发送全链路 + 启动指纹）；设置 → 诊断页同源
- 用户可能切换过自定义数据目录：读数据前先看同目录 `toskr-datadir.txt` 指针，默认目录的 json 可能是陈旧快照
- `~/Documents` 受 TCC 保护，后台 shell 首次访问会挂起等授权——应用日志/诊断只放应用数据目录

### 前端约定
- **所有用户提示走右上角 HUD 气泡**：`tip(kind, text)` / `undoableTip(msg)`（src/lib/tip.ts），kind: ok/info/warn/added/duplicate/undone/sent。**sonner 已移除，不要再引入 toast 类库**；可撤销操作用 `setPendingUndo` 挂接
- WKWebView 点击 button 不给焦点（同 Safari）+ React 复用 DOM 时 `autoFocus` 不重触发——**"临时接管键盘"的交互一律 `window.addEventListener("keydown", h, {capture: true})`**，不赌焦点
- 图片按像素哈希去重：同一张图反复捕获永远「已存在」，表现像"捕获失效"，判因先确认素材是否重复

### Git 卫生
- **提交前先 `git status --short`，禁止盲跑 `git add -A`**——工作区可能混着用户手动改动（图标、设计稿），要单独成提交
- `tasks/`、`.claude/`、`.codex/`、根目录 `toskr-*.png`、`assets/icon-concepts/` 已 gitignore（个人笔记与设计稿不入库），新增同类内容沿用此约定

## 测试点

**自动化（每次改动后必跑）**：`pnpm typecheck` + `pnpm test`（前端）+ `cargo test`（Rust，覆盖双击状态机/矩形计算/去重合并）。

**手动验收**：完整 20 条清单见 `docs/manual-qa.md`。高频回归点：
1. 双击 ⇧：划词捕获入库（HUD 气泡）⇄ 无选中开关面板；改触发键后旧键失效
2. 发送 ⌘⏎：焦点归还目标应用 → 粘贴 → 剪贴板 1.5s 还原；**目标未就绪必须中止且不标完成**
3. 撤销链路：删除/合并/清理/捕获的 HUD 气泡悬停出「撤销」，点击恢复
4. 伴随停靠：终端/编辑器前台时面板磁吸右缘、跟随移动缩放
5. 隐身模式：非 warn 气泡全静默，warn（发送失败）仍可见
6. 全屏 Space 上面板与气泡可见；多屏在光标所在屏弹出
7. 更新链路（发版后）：旧版启动收到提醒 → 设置页下载安装 → 重启后自报新版本号
