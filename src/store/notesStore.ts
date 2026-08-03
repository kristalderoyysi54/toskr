import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { detectCode } from "@/lib/code";
import { detectLink } from "@/lib/link";
import { mergeTexts } from "@/lib/format";
import { tauriStateStorage } from "./persistStorage";

export type NoteKind = "text" | "image" | "link";

export interface Note {
  id: string;
  /** 内容类型（缺省视为 text，兼容旧数据）。 */
  kind?: NoteKind;
  /** 检测到的代码语言（普通文本为 undefined）。 */
  codeLang?: string;
  /** 链接卡片的 URL（kind=link）。 */
  url?: string;
  /** 链接卡片抓取的网页标题（未抓到/未完成时缺省，展示回退 URL）。 */
  linkTitle?: string;
  /** 链接卡片的站点图标 URL。 */
  linkIcon?: string;
  /** 图片附件文件名（kind=image 的主图）。 */
  imageFile?: string;
  /** 附加图片（合并后的组合卡片可同时带多张图）。 */
  attachments?: string[];
  imageW?: number;
  imageH?: number;
  text: string;
  sectionId: string;
  done: boolean;
  /** 常用内容：发送后不标记完成，长期复用（右键「设为常用」）。 */
  keep?: boolean;
  createdAt: number;
  /** 捕获来源应用名（如 "Safari"）。 */
  sourceApp?: string;
  /** 来源应用 bundle id（图标经内存缓存按需获取，不落盘）。 */
  sourceBundle?: string;
}

export interface Section {
  id: string;
  name: string;
  collapsed?: boolean;
  /** 分组色标（"#rrggbb"；未设为无色）。 */
  color?: string;
  /** 组内卡片发送后不标记完成（Prompt 库等长期复用分组）。 */
  keepAfterSend?: boolean;
}

/** 分组可选色板（对齐 Paste 的色点风格）。 */
export const SECTION_COLORS = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#14b8a6",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#94a3b8",
];

export interface OnboardingState {
  captured: boolean;
  sent: boolean;
  done: boolean;
}

export type ThemePref = "system" | "light" | "dark";

export interface PromptSnippet {
  id: string;
  label: string;
  text: string;
}

export const DEFAULT_PROMPT_SNIPPETS: PromptSnippet[] = [
  {
    id: "review",
    label: "代码审查",
    text: "请帮我 review 以下代码，指出问题与改进建议：\n\n{内容}",
  },
  { id: "translate", label: "翻译成中文", text: "请把以下内容翻译成中文：\n\n{内容}" },
  { id: "summarize", label: "总结要点", text: "请总结以下内容的要点：\n\n{内容}" },
  { id: "explain", label: "解释内容", text: "请解释以下内容：\n\n{内容}" },
  {
    id: "optimize-prompt",
    label: "优化提示词",
    text: "请你不要执行接下来的任务。你现在的身份是世界顶级的提示工程专家，请仔细阅读我提供的提示词：\n\n{内容}\n\n并从清晰度、专业度、结构化、模型适应性四个维度进行批判性优化。请仅输出优化后的提示词内容，并用 ``` 包裹起来。",
  },
];

export type VibrancyMaterial =
  | "hud"
  | "popover"
  | "sidebar"
  | "under-window"
  | "fullscreen";

export interface Settings {
  /** 主题：跟随系统 / 浅色 / 深色。 */
  theme: ThemePref;
  /** 内容膜层不透明度（0.25–1）：影响面板底色，毛玻璃关闭时最直观。 */
  panelOpacity: number;
  /** 窗口整体不透明度（0.3–1）：连毛玻璃层一起变透，真正能看穿下层窗口。 */
  windowOpacity: number;
  /** 毛玻璃（系统 vibrancy）开关。 */
  vibrancy: boolean;
  /** 毛玻璃材质。 */
  vibrancyMaterial: VibrancyMaterial;
  /** 卡片顶部彩色通栏（关闭则用中性灰）。 */
  cardTint: boolean;
  /** 卡片底色不透明度（0.3–1）：调低可透出毛玻璃背景。 */
  cardOpacity: number;
  /** 卡片密度：舒适（瓷砖）/ 紧凑（单行列表）。 */
  cardDensity: "comfortable" | "compact";
  /** 卡片右键菜单项显隐与顺序（合并置顶、删除垫底不参与自定义）。 */
  contextMenu: { id: ContextMenuItemId; on: boolean }[];
  /** 启动时自动检查更新。 */
  autoCheckUpdate: boolean;
  /** 发现新版本自动下载安装（重启后生效，不打断当前使用）。 */
  autoInstallUpdate: boolean;
  /** 剪贴板历史自动收集（默认关闭）。 */
  clipHistory: boolean;
  /** 剪贴板历史保留条数上限（常用卡不计入裁剪）。 */
  clipHistoryLimit: number;
  /** 发送到对话后自动按回车（默认关闭，防误发）。 */
  autoEnter: boolean;
  /** 面板失焦自动隐藏。 */
  hideOnBlur: boolean;
  /** 全局触发键：双击哪个修饰键。 */
  hotkeyModifier: "shift" | "control" | "option";
  /** 两次轻击「抬起→抬起」最大间隔（ms）。 */
  hotkeyGapMs: number;
  /** 面板显示/隐藏专用快捷键（global-shortcut 格式如 "Cmd+Shift+KeyV"，null=未设置）。
   *  与双击触发独立：只开关面板不捕获，钉住时也可收起。 */
  panelToggleHotkey: string | null;
  /** 隐身模式：捕获照常入库但不弹 HUD（会议投屏用）。 */
  stealth: boolean;
  /** 伴随停靠：面板磁吸到目标应用窗口右缘并跟随。 */
  companionEnabled: boolean;
  /** 伴随应用 bundle id 列表。 */
  companionApps: string[];
  /** 伴随停靠时面板与目标窗口的间隙（pt，0=紧贴）。 */
  companionGap: number;
  /** 独立模式下手动拖动后的位置（null=默认屏幕右缘）。 */
  panelFreeX: number | null;
  panelFreeY: number | null;
  /** 捕获排除列表：这些应用内双击只开关面板、绝不捕获（密码管理器等）。 */
  excludedApps: string[];
  /** Prompt 前缀模板：发送时可选拼在内容前（Prompt 组装台）。 */
  promptSnippets: PromptSnippet[];
  /** 数据文件夹展示值（真实来源在 Rust，这里仅用于设置界面回显）。 */
  dataDir: string;
  /** 面板逻辑宽度（pt）。 */
  panelWidth: number;
  /** 面板顶缘相对基准的偏移（pt，上下拖拽产生）。 */
  panelTopOffset: number;
  /** 面板高度覆盖（pt；null = 自动同目标窗口/近全高）。 */
  panelHeight: number | null;
  onboarding: OnboardingState;
}

export const INBOX_ID = "inbox";
/** 剪贴板历史专用分组（自动创建，插在收件箱之后）。 */
export const CLIPBOARD_ID = "clipboard";

/** 卡片右键菜单可自定义项（顺序即默认顺序；具体卡片类型不适用的项自动隐藏）。 */
export type ContextMenuItemId =
  | "preview"
  | "textops"
  | "send"
  | "copy"
  | "copy-list"
  | "edit"
  | "ocr"
  | "done"
  | "keep"
  | "move";

export const CONTEXT_MENU_REGISTRY: { id: ContextMenuItemId; label: string }[] = [
  { id: "preview", label: "预览 / 打开链接" },
  { id: "textops", label: "文本处理" },
  { id: "send", label: "发送到对话" },
  { id: "copy", label: "复制内容" },
  { id: "copy-list", label: "复制为列表" },
  { id: "edit", label: "编辑" },
  { id: "ocr", label: "识别文字 (OCR)" },
  { id: "done", label: "标记完成" },
  { id: "keep", label: "设为常用" },
  { id: "move", label: "移动到分组" },
];

/** 归一化菜单配置：补齐新版本新增项（老配置向前兼容）、剔除未知项。 */
export function normalizeContextMenu(
  cfg: { id: ContextMenuItemId; on: boolean }[] | undefined
): { id: ContextMenuItemId; on: boolean }[] {
  const known = new Set(CONTEXT_MENU_REGISTRY.map((i) => i.id));
  const seen = new Set<string>();
  const out: { id: ContextMenuItemId; on: boolean }[] = [];
  for (const item of cfg ?? []) {
    if (known.has(item.id) && !seen.has(item.id)) {
      out.push({ id: item.id, on: item.on });
      seen.add(item.id);
    }
  }
  for (const { id } of CONTEXT_MENU_REGISTRY) {
    if (!seen.has(id)) out.push({ id, on: true });
  }
  return out;
}
export const PANEL_WIDTH_MIN = 320;
export const PANEL_WIDTH_MAX = 520;

const defaultSections = (): Section[] => [{ id: INBOX_ID, name: "收件箱" }];

export const DEFAULT_COMPANION_APPS = [
  "com.apple.Terminal",
  "com.googlecode.iterm2",
  "dev.warp.Warp-Stable",
  "com.github.wez.wezterm",
  "net.kovidgoyal.kitty",
  "io.alacritty",
  "com.mitchellh.ghostty",
  "com.todesktop.230313mzl4w4u92",
  "com.microsoft.VSCode",
  "com.microsoft.VSCodeInsiders",
  "com.dimillian.codexmonitor",
  "com.codepilot.app",
  "io.appmakes.otty",
  "com.openai.codex",
];

export const DEFAULT_EXCLUDED_APPS = [
  "com.1password.1password",
  "com.agilebits.onepassword7",
  "com.bitwarden.desktop",
  "com.apple.Passwords",
  "com.apple.keychainaccess",
];

export const defaultSettings = (): Settings => ({
  theme: "system",
  panelOpacity: 0.62,
  windowOpacity: 1,
  vibrancy: true,
  vibrancyMaterial: "hud",
  cardTint: true,
  cardOpacity: 1,
  cardDensity: "comfortable",
  contextMenu: CONTEXT_MENU_REGISTRY.map((i) => ({ id: i.id, on: true })),
  autoCheckUpdate: true,
  autoInstallUpdate: false,
  clipHistory: false,
  clipHistoryLimit: 50,
  autoEnter: false,
  hideOnBlur: true,
  hotkeyModifier: "shift",
  hotkeyGapMs: 400,
  panelToggleHotkey: null,
  stealth: false,
  companionEnabled: true,
  companionApps: [...DEFAULT_COMPANION_APPS],
  companionGap: 8,
  panelFreeX: null,
  panelFreeY: null,
  excludedApps: [...DEFAULT_EXCLUDED_APPS],
  promptSnippets: [...DEFAULT_PROMPT_SNIPPETS],
  dataDir: "",
  panelWidth: 380,
  panelTopOffset: 0,
  panelHeight: null,
  onboarding: { captured: false, sent: false, done: false },
});

interface UndoEntry {
  label: string;
  sections: Section[];
  notes: Note[];
}

export type AddNoteResult = "added" | "duplicate" | "empty";

interface NotesState {
  sections: Section[];
  notes: Note[];
  /** 勾选态（临时，不持久化）。 */
  checkedIds: string[];
  settings: Settings;
  /** 撤销栈（内存，不持久化）。 */
  undoStack: UndoEntry[];

  addNote: (
    text: string,
    opts?: {
      sectionId?: string;
      sourceApp?: string;
      sourceBundle?: string;
      kind?: NoteKind;
      imageFile?: string;
      imageW?: number;
      imageH?: number;
    }
  ) => { result: AddNoteResult; id?: string };
  /** 剪贴板历史入库：自动建「剪贴板」分组、超限裁剪；返回待清理的图片文件。 */
  addClipNote: (
    text: string,
    opts?: {
      sourceApp?: string;
      sourceBundle?: string;
      kind?: NoteKind;
      imageFile?: string;
      imageW?: number;
      imageH?: number;
    }
  ) => string[];
  updateNoteText: (id: string, text: string) => void;
  /** 回填链接卡片抓取到的网页标题/图标。 */
  setLinkMeta: (id: string, meta: { title?: string; icon?: string }) => void;
  deleteNotes: (ids: string[], undoLabel?: string) => void;
  setDone: (ids: string[], done: boolean) => void;
  toggleDone: (id: string) => void;
  clearDone: () => number;
  /** 切换卡片「常用」（发送后不标完成）。 */
  toggleNoteKeep: (id: string) => void;
  /** 切换分组「发送后保留」。 */
  toggleSectionKeep: (id: string) => void;

  toggleChecked: (id: string) => void;
  setChecked: (ids: string[]) => void;
  clearChecked: () => void;

  mergeNotes: (ids: string[]) => void;
  moveNotes: (ids: string[], sectionId: string) => void;
  reorderNotes: (activeId: string, overId: string) => void;

  addSection: (name?: string) => void;
  renameSection: (id: string, name: string) => void;
  setSectionColor: (id: string, color?: string) => void;
  deleteSection: (id: string) => void;
  moveSection: (id: string, dir: -1 | 1) => void;
  toggleSectionCollapsed: (id: string) => void;

  setSettings: (patch: Partial<Settings>) => void;
  markOnboarding: (patch: Partial<OnboardingState>) => void;

  snapshot: (label: string) => void;
  undo: () => string | null;
  /** 导入合并：按 id 去重追加，返回新增条数。 */
  importMerge: (data: { sections?: Section[]; notes?: Note[] }) => number;
}

const UNDO_DEPTH = 5;

export const useNotesStore = create<NotesState>()(
  persist(
    (set, get) => ({
      sections: defaultSections(),
      notes: [],
      checkedIds: [],
      settings: defaultSettings(),
      undoStack: [],

      addNote: (text, opts) => {
        const trimmed = text.trim();
        if (!trimmed) return { result: "empty" };
        // 去重（覆盖已完成卡片，避免发送后再捕获同一内容又新建）：
        // - 文本：内容完全相同
        // - 图片：附件哈希文件名相同（Rust 侧按像素内容哈希命名）
        const dup =
          opts?.kind === "image"
            ? opts.imageFile
              ? get().notes.find((n) => n.imageFile === opts.imageFile)
              : undefined
            : get().notes.find((n) => n.kind !== "image" && n.text === trimmed);
        if (dup) return { result: "duplicate", id: dup.id };

        const sections = get().sections;
        const sectionId =
          opts?.sectionId && sections.some((s) => s.id === opts.sectionId)
            ? opts.sectionId
            : (sections[0]?.id ?? INBOX_ID);
        const note: Note = {
          id: crypto.randomUUID(),
          text: trimmed,
          sectionId,
          done: false,
          createdAt: Date.now(),
          sourceApp: opts?.sourceApp,
          sourceBundle: opts?.sourceBundle,
          kind: opts?.kind ?? (detectLink(trimmed) ? "link" : "text"),
          url: opts?.kind === "image" ? undefined : detectLink(trimmed),
          codeLang:
            opts?.kind === "image" || detectLink(trimmed)
              ? undefined
              : detectCode(trimmed),
          imageFile: opts?.imageFile,
          imageW: opts?.imageW,
          imageH: opts?.imageH,
        };
        // 最新的卡片置顶（收件箱语义：新内容在最上面）
        set({ notes: [note, ...get().notes] });
        return { result: "added", id: note.id };
      },

      addClipNote: (text, opts) => {
        // 首次收集自动建组，插在收件箱之后（首位是 addNote 的默认落点，不占用）
        if (!get().sections.some((s) => s.id === CLIPBOARD_ID)) {
          const [first, ...rest] = get().sections;
          const clip: Section = { id: CLIPBOARD_ID, name: "剪贴板" };
          set({ sections: first ? [first, clip, ...rest] : [clip] });
        }
        const { result } = get().addNote(text, { ...opts, sectionId: CLIPBOARD_ID });
        if (result !== "added") return [];
        // 超限裁剪：非常用卡按新→旧保留 limit 条（notes 数组新卡在前）
        const limit = Math.max(1, get().settings.clipHistoryLimit);
        const clipNotes = get().notes.filter(
          (n) => n.sectionId === CLIPBOARD_ID && !n.keep
        );
        const evicted = clipNotes.slice(limit);
        if (!evicted.length) return [];
        const evictedIds = new Set(evicted.map((n) => n.id));
        const survivors = get().notes.filter((n) => !evictedIds.has(n.id));
        // 仅清理不再被任何卡片引用的图片文件
        const stillUsed = new Set(survivors.flatMap(noteImages));
        set({
          notes: survivors,
          checkedIds: get().checkedIds.filter((id) => !evictedIds.has(id)),
        });
        return [...new Set(evicted.flatMap(noteImages))].filter(
          (f) => !stillUsed.has(f)
        );
      },

      updateNoteText: (id, text) => {
        const trimmed = text.trim();
        set({
          notes: get().notes.map((n) => {
            if (n.id !== id) return n;
            const t = trimmed || n.text;
            // 带图卡片不做链接升级（组合卡渲染优先级会把附件藏掉）
            const hasImages = !!n.imageFile || !!n.attachments?.length;
            const url = hasImages ? undefined : detectLink(t);
            if (url) {
              // 编辑为/仍为纯链接：URL 变化时清掉旧简介，等待重抓
              const same = url === n.url;
              return {
                ...n,
                text: t,
                kind: "link" as const,
                url,
                codeLang: undefined,
                linkTitle: same ? n.linkTitle : undefined,
                linkIcon: same ? n.linkIcon : undefined,
              };
            }
            return {
              ...n,
              text: t,
              kind: n.kind === "link" ? ("text" as const) : n.kind,
              url: undefined,
              linkTitle: undefined,
              linkIcon: undefined,
              codeLang: detectCode(t),
            };
          }),
        });
      },

      setLinkMeta: (id, meta) => {
        set({
          notes: get().notes.map((n) =>
            n.id === id && n.kind === "link"
              ? {
                  ...n,
                  linkTitle: meta.title ?? n.linkTitle,
                  linkIcon: meta.icon ?? n.linkIcon,
                }
              : n
          ),
        });
      },

      deleteNotes: (ids, undoLabel) => {
        if (!ids.length) return;
        get().snapshot(undoLabel ?? `删除 ${ids.length} 条`);
        const drop = new Set(ids);
        set({
          notes: get().notes.filter((n) => !drop.has(n.id)),
          checkedIds: get().checkedIds.filter((id) => !drop.has(id)),
        });
      },

      setDone: (ids, done) => {
        const target = new Set(ids);
        set({
          notes: get().notes.map((n) => (target.has(n.id) ? { ...n, done } : n)),
        });
      },

      toggleDone: (id) => {
        set({
          notes: get().notes.map((n) => (n.id === id ? { ...n, done: !n.done } : n)),
        });
      },

      toggleNoteKeep: (id) => {
        set({
          notes: get().notes.map((n) =>
            n.id === id ? { ...n, keep: !n.keep } : n
          ),
        });
      },

      toggleSectionKeep: (id) => {
        set({
          sections: get().sections.map((s) =>
            s.id === id ? { ...s, keepAfterSend: !s.keepAfterSend } : s
          ),
        });
      },

      clearDone: () => {
        const doneNotes = get().notes.filter((n) => n.done);
        if (!doneNotes.length) return 0;
        get().snapshot(`清理已完成 ${doneNotes.length} 条`);
        set({
          notes: get().notes.filter((n) => !n.done),
          checkedIds: get().checkedIds.filter(
            (id) => !doneNotes.some((n) => n.id === id)
          ),
        });
        return doneNotes.length;
      },

      toggleChecked: (id) => {
        const checked = get().checkedIds;
        set({
          checkedIds: checked.includes(id)
            ? checked.filter((c) => c !== id)
            : [...checked, id],
        });
      },

      setChecked: (ids) => set({ checkedIds: ids }),
      clearChecked: () => set({ checkedIds: [] }),

      mergeNotes: (ids) => {
        if (ids.length < 2) return;
        const pick = new Set(ids);
        const notes = get().notes;
        const ordered = notes.filter((n) => pick.has(n.id));
        if (ordered.length < 2) return;
        get().snapshot(`合并 ${ordered.length} 条`);

        // 组合卡片：文字合并成正文，图片全部作为附件挂在同一张卡上
        const textParts = ordered.filter((n) => n.kind !== "image").map((n) => n.text);
        const images = [...new Set(ordered.flatMap(noteImages))];
        const first = ordered[0];
        const mergedText = textParts.length
          ? mergeTexts(textParts)
          : `图片 ${images.length} 张`;
        const merged: Note = {
          ...first,
          text: mergedText,
          kind: textParts.length ? "text" : "image",
          codeLang: textParts.length ? detectCode(mergedText) : undefined,
          url: undefined,
          imageFile: images[0],
          imageW: images[0] === first.imageFile ? first.imageW : undefined,
          imageH: images[0] === first.imageFile ? first.imageH : undefined,
          attachments: images.slice(1),
        };
        const rest = new Set(ordered.slice(1).map((n) => n.id));
        set({
          notes: notes
            .filter((n) => !rest.has(n.id))
            .map((n) => (n.id === first.id ? merged : n)),
          checkedIds: [first.id],
        });
      },

      moveNotes: (ids, sectionId) => {
        if (!get().sections.some((s) => s.id === sectionId)) return;
        const target = new Set(ids);
        set({
          notes: get().notes.map((n) =>
            target.has(n.id) ? { ...n, sectionId } : n
          ),
        });
      },

      reorderNotes: (activeId, overId) => {
        const notes = [...get().notes];
        const from = notes.findIndex((n) => n.id === activeId);
        const to = notes.findIndex((n) => n.id === overId);
        if (from < 0 || to < 0 || from === to) return;
        const [moved] = notes.splice(from, 1);
        notes.splice(to, 0, moved);
        set({ notes });
      },

      addSection: (name) => {
        const sections = get().sections;
        const finalName = name?.trim() || `新分组 ${sections.length}`;
        set({
          sections: [...sections, { id: crypto.randomUUID(), name: finalName }],
        });
      },

      renameSection: (id, name) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        set({
          sections: get().sections.map((s) => (s.id === id ? { ...s, name: trimmed } : s)),
        });
      },

      setSectionColor: (id, color) => {
        set({
          sections: get().sections.map((s) => (s.id === id ? { ...s, color } : s)),
        });
      },

      deleteSection: (id) => {
        if (id === INBOX_ID) return;
        get().snapshot("删除分组");
        set({
          sections: get().sections.filter((s) => s.id !== id),
          notes: get().notes.map((n) => (n.sectionId === id ? { ...n, sectionId: INBOX_ID } : n)),
        });
      },

      moveSection: (id, dir) => {
        const sections = [...get().sections];
        const from = sections.findIndex((s) => s.id === id);
        const to = from + dir;
        if (from < 0 || to < 0 || to >= sections.length) return;
        const [moved] = sections.splice(from, 1);
        sections.splice(to, 0, moved);
        set({ sections });
      },

      toggleSectionCollapsed: (id) => {
        set({
          sections: get().sections.map((s) =>
            s.id === id ? { ...s, collapsed: !s.collapsed } : s
          ),
        });
      },

      setSettings: (patch) => set({ settings: { ...get().settings, ...patch } }),

      markOnboarding: (patch) => {
        const current = get().settings.onboarding;
        const next = { ...current, ...patch };
        if (next.captured && next.sent) next.done = true;
        set({ settings: { ...get().settings, onboarding: next } });
      },

      snapshot: (label) => {
        const stack = [
          ...get().undoStack,
          {
            label,
            sections: structuredClone(get().sections),
            notes: structuredClone(get().notes),
          },
        ];
        while (stack.length > UNDO_DEPTH) stack.shift();
        set({ undoStack: stack });
      },

      undo: () => {
        const stack = [...get().undoStack];
        const entry = stack.pop();
        if (!entry) return null;
        set({
          undoStack: stack,
          sections: entry.sections,
          notes: entry.notes,
          checkedIds: [],
        });
        return entry.label;
      },

      importMerge: (data) => {
        get().snapshot("导入合并");
        const state = get();
        const sectionIds = new Set(state.sections.map((s) => s.id));
        const newSections = (data.sections ?? []).filter(
          (s) => s && typeof s.id === "string" && !sectionIds.has(s.id)
        );
        const allSections = [...state.sections, ...newSections];
        const allSectionIds = new Set(allSections.map((s) => s.id));
        const noteIds = new Set(state.notes.map((n) => n.id));
        const newNotes = (data.notes ?? [])
          .filter(
            (n) =>
              n &&
              typeof n.id === "string" &&
              typeof n.text === "string" &&
              !noteIds.has(n.id)
          )
          .map((n) => ({
            ...n,
            sectionId: allSectionIds.has(n.sectionId) ? n.sectionId : INBOX_ID,
          }));
        set({ sections: allSections, notes: [...state.notes, ...newNotes] });
        return newNotes.length;
      },
    }),
    {
      name: "toskr",
      version: 7,
      storage: createJSONStorage(() => tauriStateStorage),
      migrate: (persisted, version) => {
        // 版本升级时把新增的预置应用并入用户已持久化的列表
        // （仅升级这一次，之后用户的增删照常生效）
        const p = persisted as Partial<NotesState> | undefined;
        if (version < 5 && p?.settings?.companionApps) {
          p.settings.companionApps = [
            ...new Set([...DEFAULT_COMPANION_APPS, ...p.settings.companionApps]),
          ];
        }
        if (version < 6 && p?.settings) {
          p.settings.excludedApps = [
            ...new Set([
              ...DEFAULT_EXCLUDED_APPS,
              ...(p.settings.excludedApps ?? []),
            ]),
          ];
        }
        if (version < 7 && p?.settings?.promptSnippets) {
          // 追加新预置的「优化提示词」母模板（用户已有/已删的其余模板不动）
          const fresh = DEFAULT_PROMPT_SNIPPETS.find(
            (d) => d.id === "optimize-prompt"
          );
          if (
            fresh &&
            !p.settings.promptSnippets.some((sn) => sn.id === fresh.id)
          ) {
            p.settings.promptSnippets = [...p.settings.promptSnippets, fresh];
          }
        }
        return persisted;
      },
      partialize: (state) => ({
        sections: state.sections,
        notes: state.notes,
        settings: state.settings,
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<NotesState>;
        const merged = { ...current, ...p };
        if (!merged.sections?.length) merged.sections = defaultSections();
        // settings 深合并：老版本数据缺新字段时回填默认值
        merged.settings = {
          ...defaultSettings(),
          ...(p.settings ?? {}),
          onboarding: {
            ...defaultSettings().onboarding,
            ...(p.settings?.onboarding ?? {}),
          },
        };
        // 启动后水合完成前若已捕获新卡片，保留它们（避免被持久层覆盖丢失）
        const persistedIds = new Set(merged.notes.map((n) => n.id));
        const early = current.notes.filter((n) => !persistedIds.has(n.id));
        if (early.length) merged.notes = [...merged.notes, ...early];
        return merged;
      },
    }
  )
);

/**
 * 发送成功后应标记完成的卡片：排除「常用」卡与「发送后保留」分组内的卡
 * （这些是长期复用内容，发送后留在原位）。
 */
export function doneIdsAfterSend(
  state: Pick<NotesState, "notes" | "sections">,
  sentIds: string[]
): string[] {
  const keepSecs = new Set(
    state.sections.filter((s) => s.keepAfterSend).map((s) => s.id)
  );
  const picked = new Set(sentIds);
  return state.notes
    .filter((n) => picked.has(n.id) && !n.keep && !keepSecs.has(n.sectionId))
    .map((n) => n.id);
}

/** 卡片携带的全部图片（主图 + 附件，已去重）。 */
export function noteImages(note: Note): string[] {
  const all = [note.imageFile, ...(note.attachments ?? [])].filter(
    (f): f is string => !!f
  );
  return [...new Set(all)];
}

/** 按列表展示顺序返回勾选的笔记。 */
export function orderedCheckedNotes(state: Pick<NotesState, "notes" | "checkedIds">): Note[] {
  const checked = new Set(state.checkedIds);
  return state.notes.filter((n) => checked.has(n.id));
}
