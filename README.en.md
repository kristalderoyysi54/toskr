<div align="center">

<img src="src-tauri/icons/icon.png" alt="Toskr" width="128" height="128" />

# Toskr

**A macOS desktop companion for AI workflows**

Capture as you select, then send it all back to the conversation in one keystroke.

[简体中文](README.md) · English

<img src="https://img.shields.io/badge/macOS-13%2B-000000?logo=apple&logoColor=white" alt="macOS 13+" />
<img src="https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white" alt="Tauri 2" />
<img src="https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black" alt="React 18" />
<img src="https://img.shields.io/badge/Rust-stable-DEA584?logo=rust&logoColor=white" alt="Rust" />

</div>

While hopping between ChatGPT / Claude / Cursor / IM apps, capture the text you want to keep, park the prompts you want to try, and send them back to the conversation in one go. All data stays on your Mac — no telemetry.

> Note: the app UI is currently Chinese-only.

<p align="center">
  <img src="docs/assets/readme/toskr-showcase.webp" alt="Toskr clipboard, notes, and tasks" width="100%" />
</p>

<p align="center"><sub>Clipboard capture · note organization and batch send · task reminders</sub></p>

## Features

- **Double-tap ⇧ to capture** — select text in any app and it lands in the queue; deduplicated silently, undoable from the toast
- **⌘⏎ to send back** — refocuses the target window and pastes; aborts safely if the target isn't ready, never misfires
- **Merge & send** — multi-select cards with ⌘ / Shift and they're merged into a single message, in order
- **Outbound privacy firewall** — local sensitive-data scan before sending; reversible aliases go out, and replies you capture are automatically restored
- **Three pages** — clipboard history · note queue · tasks with due reminders; double-tap ⇧ to summon and dismiss
- **Docks anywhere** — magnetically follows the target window, or snaps to any screen edge (top/bottom become a horizontal card strip)
- **Opt-in extras** — IM message watcher, encrypted-Chinese "secret notes", subscription billing, AI assistant — all off by default, one switch away

## Install

Download the `.dmg` from [Releases](https://github.com/kristalderoyysi54/toskr/releases) and drag it into `Applications`. On first launch use **right-click → Open** (self-signed app), then grant **Accessibility** permission as guided (used for the ⇧⇧ gesture, reading selections, and paste-on-send).

Auto-update is built in; you can also check manually in Settings → About.

## Shortcuts

| Keys | Action |
| --- | --- |
| Double-tap ⇧ | With selection → capture; without → toggle the panel |
| ⌘⏎ / ⌘1-9 | Send checked cards / quick-send the Nth card |
| ⌘F · Esc | Search · dismiss layer by layer |
| Hold ⌥ | Full shortcut cheat sheet |

## Credits & License

Inspired by [shadcn](https://github.com/shadcn)'s Copper. [Apache License 2.0](LICENSE)
