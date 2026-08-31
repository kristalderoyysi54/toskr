import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

import App from "./App";
import HudView from "./HudView";
import ImagePreviewView from "./ImagePreviewView";
import { installExternalLinkInterceptor } from "./lib/externalLinks";
import { LocateHighlightView } from "./LocateHighlightView";
import SettingsView from "./SettingsView";
import SourceOverlayView from "./SourceOverlayView";
import TextPreviewView from "./TextPreviewView";
import "./index.css";

// 所有窗口共用入口：链接点击一律不许 WebView 就地导航（详情窗曾被外部网页替换）
installExternalLinkInterceptor();

// 跟随系统深浅色（shadcn 的 .dark class 策略；set_theme 后 webview 的
// prefers-color-scheme 也会变，故同一监听可覆盖手动主题）
// 临时诊断：纯浏览器打开时垫一个最小 Tauri 桩，让 UI 可渲染（invoke 全部拒绝）
if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
  const requestedLabel = new URLSearchParams(location.search).get("view");
  const diagnosticLabel = [
    "main",
    "hud",
    "settings",
    "imgpreview",
    "textpreview",
    "sourceoverlay",
    "locatehl",
  ].includes(requestedLabel ?? "")
    ? requestedLabel!
    : "main";
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: diagnosticLabel },
      currentWebview: {
        label: diagnosticLabel,
        windowLabel: diagnosticLabel,
      },
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
  void import("./store/targetStore").then((m) => {
    (window as unknown as Record<string, unknown>).targetStore = m.useTargetStore;
  });
  void import("./store/dataOperationStore").then((m) => {
    (window as unknown as Record<string, unknown>).dataOperationStore =
      m.useDataOperationStore;
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
  ) : label.startsWith("textpreview") ? (
    // 多详情窗（📌 并存）：textpreview 与动态创建的 textpreview-N 同一视图
    <TextPreviewView />
  ) : label === "sourceoverlay" ? (
    <SourceOverlayView />
  ) : label === "locatehl" ? (
    <LocateHighlightView />
  ) : (
    <App />
  );

// 渲染自证 + 前端异常上诊断日志（空白窗排查，2026-08-27）：
// 空白窗若无「挂载」指纹 = webview 没起来；有挂载但有 JS 错误 = 渲染崩了
if (label.startsWith("textpreview") || label === "main") {
  void import("./lib/tauri").then(({ api }) => {
    void api.diagNote(`webview 挂载 label=${label}`).catch(() => {});
    window.addEventListener("error", (e) => {
      void api
        .diagNote(`webview JS 错误 label=${label}: ${String(e.message).slice(0, 160)}`)
        .catch(() => {});
    });
    window.addEventListener("unhandledrejection", (e) => {
      void api
        .diagNote(
          `webview 未处理拒绝 label=${label}: ${String(e.reason).slice(0, 160)}`
        )
        .catch(() => {});
    });
  });
}

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
  if (label === "main") {
    // 首帧渲染完成再报到：首启自动展示等这个信号，不弹未渲染的空壳面板
    requestAnimationFrame(() => {
      void import("@tauri-apps/api/event").then(({ emit }) => {
        void emit("toskr://frontend-ready").catch(() => {});
      });
    });
  }
}
