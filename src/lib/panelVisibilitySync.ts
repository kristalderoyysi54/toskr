export const PANEL_SHOWN_EVENT = "toskr://panel-shown";

/** 先监听显示通知，再补读首启可见态；过期查询不能撤销用户的关闭操作。 */
export function syncPanelVisibility({
  listenShown,
  isVisible,
  showContent,
  subscribeOpenChanges,
}: {
  listenShown: (shown: () => void) => Promise<() => void>;
  isVisible: () => Promise<boolean>;
  showContent: () => void;
  subscribeOpenChanges: (changed: () => void) => () => void;
}) {
  let alive = true;
  let revision = 0;
  let unlisten: (() => void) | undefined;
  const unsubscribe = subscribeOpenChanges(() => { revision += 1; });
  void listenShown(() => {
    if (!alive) return;
    revision += 1;
    showContent();
  }).then(async (stop) => {
    if (!alive) { stop(); return; }
    unlisten = stop;
    if (revision !== 0) return;
    const visible = await isVisible();
    if (alive && revision === 0 && visible) showContent();
  }).catch(() => {
    // 浏览器预览不具备原生窗口 API。
  });
  return () => {
    alive = false;
    unsubscribe();
    unlisten?.();
  };
}
