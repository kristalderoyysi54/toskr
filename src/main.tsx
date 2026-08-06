import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

import App from "./App";
import HudView from "./HudView";
import ImagePreviewView from "./ImagePreviewView";
import SettingsView from "./SettingsView";
import TextPreviewView from "./TextPreviewView";
import "./index.css";

// 跟随系统深浅色（shadcn 的 .dark class 策略；set_theme 后 webview 的
// prefers-color-scheme 也会变，故同一监听可覆盖手动主题）
// 临时诊断：纯浏览器打开时垫一个最小 Tauri 桩，让 UI 可渲染（invoke 全部拒绝）
if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main", windowLabel: "main" },
    },
    transformCallback: () => 0,
    invoke: () => Promise.reject(new Error("browser-diagnose")),
  };
}

// 临时诊断：DEV 下暴露 store 供浏览器控制台驱动状态
if (import.meta.env.DEV) {
  void import("./store/notesStore").then((m) => {
    (window as unknown as Record<string, unknown>).notesStore = m.useNotesStore;
  });
  void import("./store/uiStore").then((m) => {
    (window as unknown as Record<string, unknown>).uiStore = m.useUIStore;
  });
}

const media = window.matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () =>
  document.documentElement.classList.toggle("dark", media.matches);
applyTheme();
media.addEventListener("change", applyTheme);

// 同一前端按窗口 label 分流：main → 面板；hud → 提示气泡；settings → 设置窗口
// （临时诊断：纯浏览器环境无 Tauri 上下文时回退 main，便于 DOM 排查）
let label = "main";
try {
  label = getCurrentWebviewWindow().label;
} catch {
  /* 浏览器诊断环境 */
}
const view =
  label === "hud" ? (
    <HudView />
  ) : label === "settings" ? (
    <SettingsView />
  ) : label === "imgpreview" ? (
    <ImagePreviewView />
  ) : label === "textpreview" ? (
    <TextPreviewView />
  ) : (
    <App />
  );

// 设计样张（dev-only，编译期死代码消除）：浏览器开 /?styletile=1 查看
if (import.meta.env.DEV && new URLSearchParams(location.search).has("styletile")) {
  void import("./dev/StyleTile").then(({ default: StyleTile }) => {
    ReactDOM.createRoot(document.getElementById("root")!).render(
      <React.StrictMode>
        <StyleTile />
      </React.StrictMode>
    );
  });
} else {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>{view}</React.StrictMode>
  );
}
