// 在页面内执行：解除只读遮罩、关欢迎页、切 Platinum，注入与 native/compare_platinum_test.go 相同的数据。
(() => {
  window.dataOperationStore.setState({ locked: false, phase: "idle", message: "" });
  const ns = window.notesStore;
  ns.getState().transitionOnboarding({ type: "skip" });
  ns.getState().setSettings({ colorScheme: "platinum", welcomeTourSeen: true });
  if (ns.getState().sections.length < 2) ns.getState().addSection("提示词库");
  const at = Date.now() - 61000;
  const texts = [
    ["把这段接口说明发给 Claude：分页参数 page_size 默认 20，最大 200；超过返回 400。", false],
    ["会议纪要：周五前完成 mygo 原生版对比报告，附内存与启动耗时。", false],
    ["SELECT id, title FROM notes WHERE section = 'inbox' ORDER BY created_at DESC LIMIT 50;", false],
    ["记得复核截图遮罩回收后的 Networking 进程占用", true],
  ];
  ns.setState({ notes: texts.map(([text, done], i) => ({ id: "n" + (i + 1), text, sectionId: "inbox", done, createdAt: at, updatedAt: at, sourceApp: "Safari" })) });
  window.targetStore.setState({ status: "ready", snapshot: { token: "t", pid: 42, bundleId: "com.todesktop.230313mzl4w4u92", appName: "Cursor", launchedAtMs: 1, ready: true, reason: null, windowId: 1, capturedAt: Date.now() } });
  window.uiStore.getState().setOpen(true);
  const css = document.createElement("style"); // 浏览器扩展的悬浮图标不进截图
  css.textContent = "[id^=immersive-translate],#immersive-translate-popup{display:none!important}";
  document.head.appendChild(css);
  return { theme: document.documentElement.dataset.theme, open: window.uiStore.getState().open };
})()
