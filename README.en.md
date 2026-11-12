<div align="center">

<img src="src-tauri/icons/icon.png" alt="Toskr" width="128" height="128" />

# Toskr

**An AI message relay**

Collect text and images from different apps, organize and review privacy, then paste them into your current AI input.

[Website](https://toskr.kaibin.me/) · [Download the latest release](https://github.com/kristalderoyysi54/toskr/releases/latest) · [简体中文](README.md) · English

<img src="https://img.shields.io/badge/macOS-13%2B-000000?logo=apple&logoColor=white" alt="macOS 13+" />
<img src="https://img.shields.io/badge/Apple%20Silicon-Intel-555555" alt="Apple Silicon · Intel" />

</div>

> **Text and images from source apps** → **Collect, organize, and review privacy in Toskr** → **Your current AI input**

> The app UI is available in English and Simplified Chinese. It follows your macOS language by default; switch it in Settings → Appearance → Language.

Customize auto-submit per target app — `⌘ Enter` pastes and delivers in one step.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/readme/toskr-flow-en-light.webp" />
    <img src="docs/assets/readme/toskr-flow-en.webp" alt="Content from source apps is ordered and privacy-checked in Toskr, then delivered at once to AI apps such as ChatGPT, Claude and DeepSeek" width="100%" />
  </picture>
</p>

## Three steps

1. **Collect** Select text and double-tap `⇧ Shift`. Copied text and images also appear in Clipboard History.
2. **Prepare** Select one or more cards, change their order, and group them for this delivery. Review sensitive text or images when needed.
3. **Paste** Focus the destination input, open Toskr, and press `⌘ Enter`. Toskr returns to that app and pastes the content; for apps with auto-submit enabled, it presses Enter for you as well.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/readme/toskr-showcase-en-light.webp" />
    <img src="docs/assets/readme/toskr-showcase-en.webp" alt="Toskr clipboard history, multi-card sending from notes, and the Today timeline" width="100%" />
  </picture>
</p>

<p align="center"><sub>Clipboard history · card-based preparation · task reminders</sub></p>

## Core capabilities

- **Collect across apps** Capture selected text from any app and retrieve copied text and images from Clipboard History
- **Prepare several items together** Select text and image cards and group them, in their current order, into one delivery
- **Review sensitive text before pasting** Locally detect supported emails, IP addresses, phone numbers, secrets, and other sensitive text, then replace it when needed
- **Mask sensitive text in images** Use local OCR to find supported regions and mask them on a generated sending copy while keeping the original unchanged
- **Compare before sending** Original on the left, what will be sent on the right, aligned line by line with replacements marked; restore or keep each one in the same window
- **Encrypted local storage** Notes, images, and message records are written with AES-256-GCM. The key stays in the macOS login keychain, so other apps cannot read or tamper with those files

## Useful extras

- **Clipboard History** Keeps copied items for 30 days by default and can be paused at any time
- **Region screenshots** `⌃ ⌥ A` to capture and annotate, with scrolling capture, pin-to-screen, and text recognition; on-device Chinese–English translation on macOS 15 and later
- **Notes and tasks** Parks prompts, references, and follow-ups, with due reminders while Toskr is running; optional two-way sync with Reminders and calendar events on Today
- **Prompt templates** Send selected cards with a template, with suggestions for the current target app
- **Command palette** `⌘ K` to run actions or search cards and tasks
- **Panel docking** Pins to the right or bottom edge, with optional left or right companion mode
- **Opt-in extensions** The message workspace, secret text, subscription reminders, and AI assistant are off by default

## Important boundaries

- Toskr identifies the target app, not a specific conversation, window, or browser tab. Check the current input before pasting.
- Image OCR handles supported sensitive text only. It does not detect faces, QR codes, or every kind of visual private information.
- Core records and privacy processing are local by default, with no account system or telemetry. Optional AI, remote images, link summaries, exchange rates, and update checks may use the network.
- Clipboard capture and task reminders work only while Toskr is running.
- Encrypted storage stops other apps from reading or tampering with data files offline. It does not stop memory-level inspection on an unlocked machine. A full exported backup is plaintext, used to move data between machines, and the only recovery path if the keychain key is lost — keep it safe and export regularly.

## Install

Requires **macOS 13 or later**, on Apple Silicon or Intel.

1. Download the `.dmg` from the [latest release](https://github.com/kristalderoyysi54/toskr/releases/latest) and drag it into `Applications`.
2. On first launch, use **right-click → Open** to open the self-signed app.
3. Follow the guide in System Settings → Privacy & Security and grant both permissions.
   - **Accessibility** reads selected text, returns to the target app, and performs the paste
   - **Input Monitoring** detects the global double-tap `⇧ Shift` gesture

Auto-update is built in. You can also check manually in Settings → About.

## Shortcuts

| Keys | Action |
| --- | --- |
| Double-tap `⇧ Shift` | With selected text, collect it in Toskr; without a selection, toggle the panel |
| `⌘ Enter` / `⌘ 1-9` | Paste selected cards / quickly paste the Nth card |
| `⌘ F` · `Esc` | Search · dismiss layer by layer |
| `⌘ K` | Command palette |
| `⌃ ⌥ A` | Region screenshot |
| Hold `⌥ Option` | Open the full shortcut reference |

## Credits & License

Inspired by [shadcn](https://github.com/shadcn)'s Copper. [Apache License 2.0](LICENSE)
