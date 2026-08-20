/**
 * IM定位高亮框：整窗即一个描边框，由 Rust 摆到目标会话行上、约 2 秒后收窗。
 *
 * 刻意无状态：呼吸动画无限循环、无透明终态，窗口只要可见就一定有高亮——
 * 不依赖任何事件/重播信号（曾用 Tauri 事件与 visibilitychange 驱动一次性
 * 动画重播，隐藏期 WebView 挂起导致间歇性「窗口在、高亮空白」）。
 */
export function LocateHighlightView() {
  return <div className="locate-highlight h-screen w-screen" aria-hidden />;
}
