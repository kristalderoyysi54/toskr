import { useEffect } from "react";

/** 放在实际窗口内容的 Suspense 内，模块提交后才上报原生展示。 */
export function FrontendReady({ onReady }: { onReady: () => void }) {
  useEffect(() => {
    // 隐藏 WebView 可能暂停 rAF；原生正在等此通知才能 show，不能互相等待。
    onReady();
  }, [onReady]);
  return null;
}
