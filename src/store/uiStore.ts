import { create } from "zustand";

export type PanelPage = "notes" | "clipboard" | "tasks";

interface UIState {
  /** 面板内容是否展开（驱动滑入滑出动画；窗口显隐由 Rust 管）。 */
  open: boolean;
  /** 当前页面：笔记 / 任务（会话态，每次呼出从笔记页开始）。 */
  page: PanelPage;
  /** 图钉：钉住后失焦不自动隐藏。 */
  pinned: boolean;
  /** 搜索框是否展开。 */
  searchOpen: boolean;
  /** 搜索关键字。 */
  query: string;
  /** 键盘导航焦点卡片。 */
  focusedId: string | null;
  /** 外部请求进入编辑态的卡片（键盘 Enter 触发）。 */
  editingId: string | null;
  /** 范围选择锚点（Shift 点击以它到目标之间批量选中）。 */
  anchorId: string | null;
  /** 当前可见卡片顺序（键盘导航与范围选择共用）。 */
  navIds: string[];
  /** 全文预览层当前卡片（Space 弹出，Paste 风格）。 */
  previewId: string | null;
  /** 预览层是否处于编辑模式。 */
  previewEditing: boolean;
  /** 新捕获卡片入场高亮。 */
  flashId: string | null;
  /** 各分组「已完成」折叠区展开态（临时）。 */
  doneOpen: Record<string, boolean>;
  /** ⌘ 按住中（前 9 张卡显示 ⌘1-9 快发角标）。 */
  cmdHeld: boolean;
  /** 辅助功能授权状态（应用级常驻轮询写入）。 */
  permissionAx: boolean;
  /** 键盘监听 tap 是否已创建。 */
  permissionInstalled: boolean;
  /** tap 是否真正收到过键盘事件。 */
  permissionReceiving: boolean;
  /** 已创建却持续收不到事件（输入监控权限被扣的特征）。 */
  eventsStuck: boolean;
  /** 屏幕阅读器播报镜像：HUD 是独立无焦点窗口，AT 听不到；
   *  tip() 同步把文案写进面板内的 sr-only live region。 */
  announce: string;

  setOpen: (open: boolean) => void;
  setPage: (page: PanelPage) => void;
  setPinned: (pinned: boolean) => void;
  setSearchOpen: (open: boolean) => void;
  setQuery: (query: string) => void;
  setFocusedId: (id: string | null) => void;
  setAnchorId: (id: string | null) => void;
  setNavIds: (ids: string[]) => void;
  setEditingId: (id: string | null) => void;
  openPreview: (id: string, editing?: boolean) => void;
  closePreview: () => void;
  setPreviewEditing: (editing: boolean) => void;
  setFlashId: (id: string | null) => void;
  setCmdHeld: (held: boolean) => void;
  toggleDoneOpen: (sectionId: string) => void;
  setPermission: (
    ax: boolean,
    installed: boolean,
    receiving: boolean,
    stuck: boolean
  ) => void;
  setAnnounce: (announce: string) => void;
}

export const useUIStore = create<UIState>()((set, get) => ({
  open: false,
  page: "notes",
  pinned: false,
  searchOpen: false,
  query: "",
  focusedId: null,
  anchorId: null,
  navIds: [],
  editingId: null,
  previewId: null,
  previewEditing: false,
  flashId: null,
  doneOpen: {},
  cmdHeld: false,
  permissionAx: true,
  permissionInstalled: true,
  permissionReceiving: true,
  eventsStuck: false,
  announce: "",

  setOpen: (open) => set({ open }),
  // 切页清焦点：避免另一页残留的 focusedId 干扰键盘导航语义
  setPage: (page) => set({ page, focusedId: null }),
  setPinned: (pinned) => set({ pinned }),
  setSearchOpen: (searchOpen) =>
    set(searchOpen ? { searchOpen } : { searchOpen, query: "" }),
  setQuery: (query) => set({ query }),
  setFocusedId: (focusedId) => set({ focusedId }),
  setAnchorId: (anchorId) => set({ anchorId }),
  setNavIds: (navIds) => set({ navIds }),
  setEditingId: (editingId) => set({ editingId }),
  openPreview: (previewId, editing = false) =>
    set({ previewId, previewEditing: editing, focusedId: previewId }),
  closePreview: () => set({ previewId: null, previewEditing: false }),
  setPreviewEditing: (previewEditing) => set({ previewEditing }),
  setFlashId: (flashId) => set({ flashId }),
  setCmdHeld: (cmdHeld) => set({ cmdHeld }),
  toggleDoneOpen: (sectionId) =>
    set({ doneOpen: { ...get().doneOpen, [sectionId]: !get().doneOpen[sectionId] } }),
  setPermission: (permissionAx, permissionInstalled, permissionReceiving, eventsStuck) =>
    set({ permissionAx, permissionInstalled, permissionReceiving, eventsStuck }),
  setAnnounce: (announce) => set({ announce }),
}));
