<div align="center">

<img src="src-tauri/icons/icon.png" alt="Toskr" width="128" height="128" />

# Toskr

**面向 AI 工作流的 macOS 菜单栏效率工具**

全局划词摘录 · Prompt 暂存 · 一键流转回对话

<img src="https://img.shields.io/badge/macOS-13%2B-000000?logo=apple&logoColor=white" alt="macOS 13+" />
<img src="https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white" alt="Tauri 2" />
<img src="https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black" alt="React 18" />
<img src="https://img.shields.io/badge/Rust-stable-DEA584?logo=rust&logoColor=white" alt="Rust" />

</div>

在 ChatGPT / Claude / Cursor / 微信 / 浏览器之间穿梭时，随手捕获想留下的文字、暂存想试的 Prompt，攒够了一键发回对话。Toskr 把待办清单、剪贴板与草稿纸中有用的部分合而为一：常驻菜单栏，双击 Shift 即来即走，完全本地运行。

<!-- TODO: 补一张应用截图或演示 GIF -->

## ✨ 功能

### 全局捕获

- 任意应用中选中文字，**双击 ⇧** 静默入库，右上角闪现「已捕获 ✓」气泡（点击穿透、不抢焦点）；触发键可改为 ⌃/⌥，双击间隔可调
- 连续捕获堆叠显示「已捕获 ×N」；**重复内容自动去重**并提示「已存在」
- 气泡**悬停出现「撤销」**，误捕获立即反悔
- 卡片自动标注来源应用名与图标
- **隐身模式**：投屏 / 会议时一键关闭所有气泡（托盘或设置中切换）

### 呼之即来的面板

- 未选中文字时**双击 ⇧**，光标所在屏右缘滑出毛玻璃侧边栏：置顶、失焦自动隐藏（Pin 可常驻）、全屏 App 的 Space 上同样可见
- **伴随停靠**：前台是 iTerm / Terminal / Warp / Cursor / VS Code 等终端或编辑器（可自定义）时，面板磁吸到其窗口右缘、等高、实时跟随移动缩放；设置里一键「把当前应用加入伴随列表」
- **⌘F 实时搜索**（命中高亮 + 计数）、全键盘操作、宽度拖拽 320–520pt 并记忆

### 队列管理

- 分组折叠 / 重命名 / 排序，跨组拖拽（悬停折叠组自动展开）
- 批量勾选：复制为列表（⌘C）、合并、标记完成、删除；**已完成沉底折叠**，顶栏一键清理
- **全量撤销安全网**：删除 / 合并 / 清理 / 导入均可 toast 一键撤销
- 双击卡片内联编辑；底部草稿框 Enter 提交、Shift+Enter 换行（中文输入法安全）

### 一键发回对话

- 勾选后 **⌘⏎**：收起面板 → 焦点精确归还目标应用（**到达确认，未就绪即中止并提示，绝不误粘贴**）→ 自动 ⌘V →（可选自动回车，默认关闭）→ 卡片自动标完成
- **剪贴板无损**：发送后 1.5 秒自动还原你原来的剪贴板内容
- 发送按钮悬停可预览将要粘贴的完整文本

### 数据与隐私

- **完全本地**：JSON 持久化，无账号、无网络请求、无遥测
- 设置内导出备份 / 导入合并（按 id 去重，不覆盖现有数据）
- 首次使用内置「三步上手」引导

## ⌨️ 快捷键

| 按键 | 作用 |
| --- | --- |
| 双击 ⇧ | 有选中文字 → 捕获入库；无 → 呼出 / 收起面板 |
| ⌘F | 面板内搜索 |
| ↑ / ↓ | 移动焦点 |
| Space | 勾选（焦点在拖拽把手上时为拾起 / 放下） |
| Enter | 编辑当前卡片 |
| ⌘A / ⌘⌫ | 全选 / 删除 |
| ⌘C | 勾选内容复制为列表 |
| ⌘⏎ | 发送勾选内容到目标应用 |
| Esc | 逐层退出：编辑 → 搜索 → 选择 → 收起面板 |

## 📦 安装

从 [Releases](https://github.com/kristalderoyysi54/toskr/releases) 下载 `Toskr.app.tar.gz`，解压后把 `Toskr.app` 拖入「应用程序」。首次打开需**右键 →「打开」**绕过 Gatekeeper（自签名应用）。

**自动更新**：应用启动后会静默检查 GitHub Releases，发现新版在右上角气泡提醒；也可在 设置 → 关于 中手动「检查更新」，一键下载安装并自动重启（更新包经 minisign 签名校验）。

### 从源码构建

**环境要求**：macOS 13+ · Node.js 20+ 与 pnpm · Rust 稳定版工具链 · Xcode Command Line Tools

```bash
git clone https://github.com/kristalderoyysi54/toskr.git
cd toskr
pnpm install
pnpm tauri dev    # 开发运行
pnpm build:app    # 打包 → src-tauri/target/release/bundle/macos/Toskr.app
```

**关于签名**：`tauri.conf.json` 默认指定自签名证书 `Toskr Dev Signing`，好处是签名跨编译稳定，重新构建后无需重新授予辅助功能权限。首次构建前二选一：

- 创建同名证书：钥匙串访问 → 证书助理 → 创建证书（名称 `Toskr Dev Signing`，证书类型「代码签名」），创建后在证书的信任设置中启用
- 或删去 `bundle.macOS.signingIdentity` 配置退回 ad-hoc 签名（代价：每次重新编译都要在系统设置里重新授权辅助功能）

## 🔐 权限说明

Toskr 依赖 macOS **辅助功能**权限（个别系统版本还需**输入监控**，应用内横幅会提示），用途：

- 监听全局键盘 —— 检测「双击 ⇧」手势
- 读取选中文本与窗口位置 —— 划词捕获、伴随停靠
- 合成按键 —— 发送时自动执行 ⌘V

首次启动按引导操作：系统设置 → 隐私与安全性 → **辅助功能** → 勾选 Toskr，授权后即时生效、无需重启。所有处理均在本地完成，Toskr 不发起任何网络请求。

## 🛠 技术栈与实现

Tauri v2（Rust）· React 18 · TypeScript · Tailwind CSS v4 · shadcn/ui · Zustand · motion · dnd-kit

几个有意思的实现点：

- **双击检测**：CGEventTap 挂主线程 CFRunLoop + 参数化纯状态机（单测覆盖），规避 rdev 多年未修复的段错误
- **划词读取**：AX API 直读优先（零副作用），剪贴板技法兜底（备份 → ⌘C → 轮询 → 还原）
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

**发版**：`./script/release.sh 0.3.0 "更新说明"` —— 自动完成版本号写入、签名打包、生成 `latest.json`、创建 GitHub Release 并上传更新包（需 `gh` CLI 登录与 `~/.tauri/toskr-updater.key` updater 私钥）。

> 中国大陆网络：`src-tauri/.cargo/config.toml` 已配置 rsproxy.cn crates 镜像，如需全局生效可复制到 `~/.cargo/config.toml`。

## 🙏 致谢

灵感与原型来自 [shadcn](https://github.com/shadcn) 的 Copper，在其基础上重写并大幅增强。

## 📄 许可证

[MIT](LICENSE)
