import { api } from "@/lib/tauri";
import { useUIStore } from "@/store/uiStore";

const WINDOW_MS = 60_000;

/** 动画来源标签：CSS 动画名，或 WAAPI 目标元素的首个 class（代码标识符，不含正文）。 */
function animationKind(animation: Animation): string {
  const effect = animation.effect as KeyframeEffect | null;
  const timing = effect?.getTiming();
  const loop = `it=${timing?.iterations ?? "?"}`;
  if ("animationName" in animation) return `css:${String((animation as CSSAnimation).animationName)}:${loop}`;
  const target = effect?.target;
  const classes = target instanceof Element ? [...target.classList].slice(0, 2).join(".") : "";
  return `waapi:${target?.tagName.toLowerCase() ?? "?"}.${classes}:${loop}`;
}

/**
 * 主窗渲染活动诊断：面板不可见或已贴边滑出时仍有 rAF 回调或运行中的动画，
 * 说明有东西在后台持续驱动渲染（2026-11-05 实测长时运行实例 WebContent 常驻 5% CPU）。
 * 每 60s 结算一次，只在「面板不可见/已滑出且有活动」时上报。返回停止函数。
 */
export function startRenderActivityProbe(): () => void {
  const original = window.requestAnimationFrame.bind(window);
  let raf = 0;
  window.requestAnimationFrame = (callback: FrameRequestCallback) => {
    raf += 1;
    return original(callback);
  };
  const timer = window.setInterval(() => {
    const count = raf;
    raf = 0;
    const { open, edgeHidden } = useUIStore.getState();
    if (open && !edgeHidden) return;
    const running = document.getAnimations().filter((a) => a.playState === "running");
    if (count === 0 && running.length === 0) return;
    const kinds = [...new Set(running.map(animationKind))].slice(0, 4);
    void api.reportRenderActivity(count, running.length, open, edgeHidden, kinds).catch(() => {});
  }, WINDOW_MS);
  return () => {
    window.clearInterval(timer);
    window.requestAnimationFrame = original;
  };
}
