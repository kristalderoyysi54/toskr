<div align="center">

<img src="src-tauri/icons/icon.png" alt="Toskr" width="128" height="128" />

# Toskr

**面向 AI 工作流的 macOS 菜单栏效率工具**

划词即收，攒够一键发回对话。

简体中文 · [English](README.en.md)

<img src="https://img.shields.io/badge/macOS-13%2B-000000?logo=apple&logoColor=white" alt="macOS 13+" />
<img src="https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white" alt="Tauri 2" />
<img src="https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black" alt="React 18" />
<img src="https://img.shields.io/badge/Rust-stable-DEA584?logo=rust&logoColor=white" alt="Rust" />

</div>

在 ChatGPT / Claude / Cursor / 微信之间穿梭时，随手捕获想留下的文字，暂存想试的 Prompt，攒够了一键发回对话。数据完全本地，无遥测。

<!-- TODO: 应用截图 / 演示 GIF -->

## 特性

- **双击 ⇧ 全局捕获** —— 任意应用选中文字即收，静默去重、气泡可撤销
- **⌘⏎ 一键发回** —— 自动切回目标窗口粘贴；目标未就绪安全中止，绝不误发
- **多选合并发送** —— ⌘ / Shift 多选卡片，按顺序合并成一条消息发出
- **出站隐私防线** —— 发送前本地敏感扫描；可逆化名替换发出、捕获回复自动还原
- **三个页面** —— 剪贴板历史 · 笔记队列 · 任务提醒，双击 ⇧ 即来即走
- **随处停靠** —— 磁吸伴随目标窗口，或吸附屏幕四缘（上下缘为横向卡片栏）
- **按需扩展** —— 消息监听（IM 群消息工作台）、秘文（中文密文通信）、订阅账单、AI 助手，默认关闭一键开启

## 安装

从 [Releases](https://github.com/kristalderoyysi54/toskr/releases) 下载 `.dmg`，拖入 `Applications`。首次打开需**右键 →「打开」**（自签名应用）；随后按引导授予**辅助功能**权限（用于双击 ⇧ 检测、划词读取与发送粘贴）。

应用内置自动更新，也可在 设置 → 关于 手动检查。

## 快捷键

| 按键 | 作用 |
| --- | --- |
| 双击 ⇧ | 选中文字 → 捕获；无选中 → 呼出 / 收起面板 |
| ⌘⏎ / ⌘1-9 | 发送勾选 / 快发第 N 张卡 |
| ⌘F · Esc | 搜索 · 逐层退出 |
| 长按 ⌥ | 完整快捷键速查层 |


## 致谢与许可

灵感来自 [shadcn](https://github.com/shadcn) 的 Copper。[Apache License 2.0](LICENSE)
