import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

import App from "./App";
import HudView from "./HudView";
import ImagePreviewView from "./ImagePreviewView";
import SettingsView from "./SettingsView";
import "./index.css";

// 跟随系统深浅色（shadcn 的 .dark class 策略；set_theme 后 webview 的
// prefers-color-scheme 也会变，故同一监听可覆盖手动主题）
const media = window.matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () =>
  document.documentElement.classList.toggle("dark", media.matches);
applyTheme();
media.addEventListener("change", applyTheme);

// 同一前端按窗口 label 分流：main → 面板；hud → 提示气泡；settings → 设置窗口
const label = getCurrentWebviewWindow().label;
const view =
  label === "hud" ? (
    <HudView />
  ) : label === "settings" ? (
    <SettingsView />
  ) : label === "imgpreview" ? (
    <ImagePreviewView />
  ) : (
    <App />
  );

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{view}</React.StrictMode>
);
