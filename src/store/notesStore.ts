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
  /** 常用内容：发送后不标记完成，长期复用（右键「设为常用」；剪贴板卡=固定不清理）。 */
  keep?: boolean;
  /** 自定义标题（右键「重命名」；卡片通栏显示，便于识别长内容）。 */
  title?: string;
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

// ===== 任务（闪念/待办，任务页专用；与笔记独立的数据域）=====

export type TaskStatus = "todo" | "doing" | "done";
export type TaskPriority = "none" | "low" | "mid" | "high";

/** 任务的检查列表项（子任务，Apple 提醒事项风格）。 */
export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

export interface Task {
  id: string;
  text: string;
  status: TaskStatus;
  priority: TaskPriority;
  /** 到期时间（epoch ms）；null = 未设置。 */
  dueAt: number | null;
  createdAt: number;
  /** 该 dueAt 是否已推送过到期提醒；重设 dueAt 时清空，允许对新时间重新提醒。 */
  remindedAt: number | null;
  /** 备注（展开详情里编辑；缺省无）。 */
  note?: string;
  /** 检查列表（子任务；缺省无）。 */
  checklist?: ChecklistItem[];
  /** 类型：缺省普通待办；"spark" = 闪念灵感（单独分区、⚡ 一键转待办）。 */
  kind?: "spark";
  /** 所属任务分组（缺省归收集箱）。 */
  sectionId?: string;
}

/** 任务默认分组（收集箱）。 */
export const TASK_INBOX_ID = "task-inbox";

/** 任务分组（轻量：无色标等笔记分组特有属性）。 */
export interface TaskSection {
  id: string;
  name: string;
  collapsed?: boolean;
}

const defaultTaskSections = (): TaskSection[] => [
  { id: TASK_INBOX_ID, name: "收集箱" },
];

/** 分组可选色板（对齐 Paste 的色点风格）。 */
// 用户可选的分组调色板（数据，非样式 token）：用户直接挑选的颜色值，刻意独立于 design-token 体系
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

/** 到期快捷档配置：相对分钟 / 今天定点 / 明天定点 / 下个周几定点。 */
export type DuePresetCfg =
  | { id: string; kind: "relative"; minutes: number }
  | { id: string; kind: "today" | "tomorrow"; hour: number; minute: number }
  | { id: string; kind: "weekday"; weekday: number; hour: number; minute: number };

export const DEFAULT_DUE_PRESETS: DuePresetCfg[] = [
  { id: "rel-30m", kind: "relative", minutes: 30 },
  { id: "rel-1h", kind: "relative", minutes: 60 },
  { id: "rel-3h", kind: "relative", minutes: 180 },
  { id: "rel-6h", kind: "relative", minutes: 360 },
  { id: "today-20", kind: "today", hour: 20, minute: 0 },
  { id: "tomorrow-9", kind: "tomorrow", hour: 9, minute: 0 },
  { id: "next-mon-9", kind: "weekday", weekday: 1, hour: 9, minute: 0 },
];

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
  /** 剪贴板历史保留时长（天；null = 永久）。超龄的非固定卡自动清理。 */
  clipRetentionDays: number | null;
  /** 暂停剪贴板收集到该时刻（epoch ms；null = 未暂停）。 */
  clipPauseUntil: number | null;
  /** 剪贴板规则：忽略机密内容（密码管理器 ConcealedType 标记）。 */
  clipIgnoreConcealed: boolean;
  /** 剪贴板规则：忽略瞬时内容（AutoGenerated/Transient 标记）。 */
  clipIgnoreTransient: boolean;
  /** 剪贴板规则：忽略应用列表（独立于捕获排除）。 */
  clipExcludedApps: string[];
  /** 发送到对话后自动按回车（默认关闭，防误发）。 */
  autoEnter: boolean;
  /** 面板失焦自动隐藏。 */
  hideOnBlur: boolean;
  /** 全局触发键：双击哪个修饰键。 */
  hotkeyModifier: "shift" | "control" | "option";
  /** 两次轻击「抬起→抬起」最大间隔（ms）。 */
  hotkeyGapMs: number;
  /** 双击触发仅捕获（面板开关交给专用快捷键；默认智能：无选中时开关面板）。 */
  doubleTapCaptureOnly: boolean;
  /** 面板显示/隐藏专用快捷键（global-shortcut 格式如 "Cmd+Shift+KeyV"，null=未设置）。
   *  与双击触发独立：只开关面板不捕获，钉住时也可收起。 */
  panelToggleHotkey: string | null;
  /** 隐身模式：捕获照常入库但不弹 HUD（会议投屏用）。 */
  stealth: boolean;
  /** 捕获成功音效（隐身模式下强制静音）。 */
  soundEnabled: boolean;
  /** 伴随停靠：面板磁吸到目标应用窗口右缘并跟随。 */
  companionEnabled: boolean;
  /** 伴随应用 bundle id 列表。 */
  companionApps: string[];
  /** 伴随停靠时面板与目标窗口的间隙（pt，0=紧贴）。 */
  companionGap: number;
  /** 独立模式下手动拖动后的位置（null=默认屏幕右缘）。 */
  panelFreeX: number | null;
  panelFreeY: number | null;
  /** 靠右边栏模式：贴屏幕右缘全高（保留停靠间距），与伴随磁吸互斥。 */
  rightSidebar: boolean;
  /** 到期快捷档（可增删改）：相对分钟 / 今天 / 明天 / 下个周几。 */
  duePresets: DuePresetCfg[];
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
  | "rename"
  | "to-task"
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
  { id: "keep", label: "设为常用 / 固定" },
  { id: "rename", label: "重命名" },
  { id: "to-task", label: "转为任务" },
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
  clipRetentionDays: null,
  clipPauseUntil: null,
  clipIgnoreConcealed: true,
  clipIgnoreTransient: true,
  clipExcludedApps: [...DEFAULT_EXCLUDED_APPS],
  autoEnter: false,
  hideOnBlur: true,
  hotkeyModifier: "shift",
  hotkeyGapMs: 400,
  doubleTapCaptureOnly: false,
  panelToggleHotkey: null,
  stealth: false,
  soundEnabled: true,
  companionEnabled: true,
  companionApps: [...DEFAULT_COMPANION_APPS],
  companionGap: 8,
  panelFreeX: null,
  panelFreeY: null,
  rightSidebar: false,
  duePresets: DEFAULT_DUE_PRESETS.map((p) => ({ ...p })),
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
  tasks: Task[];
  taskSections: TaskSection[];
}

export type AddNoteResult = "added" | "duplicate" | "empty";

interface NotesState {
  sections: Section[];
  notes: Note[];
  /** 任务（任务页；与笔记同一持久化 bag、同一条撤销栈）。 */
  tasks: Task[];
  /** 任务分组（收集箱恒存）。 */
  taskSections: TaskSection[];
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
  /** 清空剪贴板历史（固定 ★ 卡保留；可撤销）。返回删除数与待清理图片。 */
  clearClipHistory: () => { removed: number; orphanImages: string[] };
  /** 按保留时长清理超龄剪贴板卡（固定卡豁免；静默，不占撤销栈）。返回待清理图片。 */
  pruneClipHistory: () => string[];
  updateNoteText: (id: string, text: string) => void;
  /** 回填链接卡片抓取到的网页标题/图标。 */
  setLinkMeta: (id: string, meta: { title?: string; icon?: string }) => void;
  /** 重命名卡片（空串 = 清除标题）。 */
  updateNoteTitle: (id: string, title: string) => void;
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

  // ===== 任务 =====
  addTask: (
    text: string,
    opts?: { kind?: "spark"; sectionId?: string }
  ) => { result: "added" | "empty"; id?: string };
  /** 闪念 ⚡ 转正式待办。 */
  sparkToTask: (id: string) => void;
  moveTasksToSection: (ids: string[], sectionId: string) => void;
  addTaskSection: (name?: string) => void;
  renameTaskSection: (id: string, name: string) => void;
  /** 删除分组：组内任务归收集箱（收集箱不可删）。 */
  deleteTaskSection: (id: string) => void;
  moveTaskSection: (id: string, dir: -1 | 1) => void;
  toggleTaskSectionCollapsed: (id: string) => void;
  updateTaskText: (id: string, text: string) => void;
  /** 状态点点击：todo → doing → done → todo 三态循环。 */
  cycleTaskStatus: (id: string) => void;
  /** 键盘 x/Space：done ↔ 非 done 二态直切（跳过「进行中」）。 */
  toggleTaskDone: (id: string) => void;
  /** 右键菜单直达设置状态。 */
  setTaskStatus: (id: string, status: TaskStatus) => void;
  setTaskPriority: (id: string, priority: TaskPriority) => void;
  /** 优先级色条点击：none → low → mid → high → none 循环。 */
  cycleTaskPriority: (id: string) => void;
  /** 设置/清除到期时间；改动会清空 remindedAt 以便对新时间重新提醒。 */
  setTaskDue: (id: string, dueAt: number | null) => void;
  markTasksReminded: (ids: string[]) => void;
  /** 更新备注（空串视为清除）。 */
  updateTaskNote: (id: string, note: string) => void;
  addChecklistItem: (taskId: string, text: string) => void;
  toggleChecklistItem: (taskId: string, itemId: string) => void;
  updateChecklistItem: (taskId: string, itemId: string, text: string) => void;
  deleteChecklistItem: (taskId: string, itemId: string) => void;
  deleteTasks: (ids: string[], undoLabel?: string) => void;
  clearDoneTasks: () => number;
  /** 笔记转任务：一次快照原子完成「建任务 + 删笔记」；图片/组合卡返回 false。 */
  convertNoteToTask: (noteId: string) => boolean;

  setSettings: (patch: Partial<Settings>) => void;
  markOnboarding: (patch: Partial<OnboardingState>) => void;

  snapshot: (label: string) => void;
  undo: () => string | null;
  /** 导入合并：按 id 去重追加，返回各域新增条数。 */
  importMerge: (data: {
    sections?: Section[];
    notes?: Note[];
    tasks?: Task[];
    taskSections?: TaskSection[];
  }) => { notes: number; tasks: number };
}

const UNDO_DEPTH = 5;

export const useNotesStore = create<NotesState>()(
  persist(
    (set, get) => ({
      sections: defaultSections(),
      notes: [],
      tasks: [],
      taskSections: defaultTaskSections(),
      checkedIds: [],
      settings: defaultSettings(),
      undoStack: [],

      addNote: (text, opts) => {
        const trimmed = text.trim();
        if (!trimmed) return { result: "empty" };
        // 去重（覆盖已完成卡片，避免发送后再捕获同一内容又新建）：
        // - 文本：内容完全相同；图片：附件哈希文件名相同（像素内容哈希命名）
        // - 只在目标域内查重：剪贴板历史与笔记互不冲突——复制过的内容
        //   仍可捕获为笔记（转正意图），捕获过的内容复制时也照常记录历史
        const targetClip = opts?.sectionId === CLIPBOARD_ID;
        const inScope = (n: Note) =>
          (n.sectionId === CLIPBOARD_ID) === targetClip;
        const dup =
          opts?.kind === "image"
            ? opts.imageFile
              ? get().notes.find(
                  (n) => inScope(n) && n.imageFile === opts.imageFile
                )
              : undefined
            : get().notes.find(
                (n) => inScope(n) && n.kind !== "image" && n.text === trimmed
              );
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
        // 数量不设上限：历史规模由「保留时长」滑杆与手动删除历史控制
        const res = get().addNote(text, { ...opts, sectionId: CLIPBOARD_ID });
        // 重复复制＝再次使用：把已有卡提升到历史最新（Paste 行为），
        // 刷新时间与来源。否则重复内容毫无可见反馈，像「没收集到」
        if (res.result === "duplicate" && res.id) {
          const notes = get().notes;
          const idx = notes.findIndex((n) => n.id === res.id);
          if (idx >= 0) {
            const bumped: Note = {
              ...notes[idx],
              createdAt: Date.now(),
              sourceApp: opts?.sourceApp ?? notes[idx].sourceApp,
              sourceBundle: opts?.sourceBundle ?? notes[idx].sourceBundle,
            };
            set({
              notes: [bumped, ...notes.filter((n) => n.id !== res.id)],
            });
          }
        }
        return [];
      },


      clearClipHistory: () => {
        const targets = get().notes.filter(
          (n) => n.sectionId === CLIPBOARD_ID && !n.keep
        );
        if (!targets.length) return { removed: 0, orphanImages: [] };
        get().snapshot(`清空剪贴板历史 ${targets.length} 条`);
        const drop = new Set(targets.map((n) => n.id));
        const survivors = get().notes.filter((n) => !drop.has(n.id));
        const stillUsed = new Set(survivors.flatMap(noteImages));
        set({
          notes: survivors,
          checkedIds: get().checkedIds.filter((id) => !drop.has(id)),
        });
        return {
          removed: targets.length,
          orphanImages: [...new Set(targets.flatMap(noteImages))].filter(
            (f) => !stillUsed.has(f)
          ),
        };
      },

      pruneClipHistory: () => {
        const days = get().settings.clipRetentionDays;
        if (!days) return [];
        const cutoff = Date.now() - days * 86_400_000;
        const evicted = get().notes.filter(
          (n) => n.sectionId === CLIPBOARD_ID && !n.keep && n.createdAt < cutoff
        );
        if (!evicted.length) return [];
        const drop = new Set(evicted.map((n) => n.id));
        const survivors = get().notes.filter((n) => !drop.has(n.id));
        const stillUsed = new Set(survivors.flatMap(noteImages));
        set({
          notes: survivors,
          checkedIds: get().checkedIds.filter((id) => !drop.has(id)),
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

      updateNoteTitle: (id, title) => {
        const trimmed = title.trim();
        set({
          notes: get().notes.map((n) =>
            n.id === id ? { ...n, title: trimmed || undefined } : n
          ),
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
        // 剪贴板域=历史记录，合并不消费原卡：产出一张新组合卡置顶
        if (ordered.every((n) => n.sectionId === CLIPBOARD_ID)) {
          const combo: Note = {
            id: crypto.randomUUID(),
            text: mergedText,
            sectionId: CLIPBOARD_ID,
            done: false,
            createdAt: Date.now(),
            kind: textParts.length ? "text" : "image",
            codeLang: textParts.length ? detectCode(mergedText) : undefined,
            imageFile: images[0],
            imageW: images[0] === first.imageFile ? first.imageW : undefined,
            imageH: images[0] === first.imageFile ? first.imageH : undefined,
            attachments: images.slice(1),
          };
          set({ notes: [combo, ...notes], checkedIds: [combo.id] });
          return;
        }
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

      // ===== 任务 =====

      addTask: (text, opts) => {
        const trimmed = text.trim();
        if (!trimmed) return { result: "empty" };
        // 刻意不去重：同一句待办（如「回复邮件」）重复出现是正常需求
        const task: Task = {
          id: crypto.randomUUID(),
          text: trimmed,
          status: "todo",
          priority: "none",
          dueAt: null,
          createdAt: Date.now(),
          remindedAt: null,
          kind: opts?.kind,
          sectionId:
            opts?.sectionId &&
            get().taskSections.some((s) => s.id === opts.sectionId)
              ? opts.sectionId
              : undefined,
        };
        set({ tasks: [task, ...get().tasks] });
        return { result: "added", id: task.id };
      },

      sparkToTask: (id) => {
        set({
          tasks: get().tasks.map((t) =>
            t.id === id && t.kind === "spark"
              ? { ...t, kind: undefined, status: "todo" }
              : t
          ),
        });
      },

      moveTasksToSection: (ids, sectionId) => {
        if (!get().taskSections.some((s) => s.id === sectionId)) return;
        const picked = new Set(ids);
        set({
          tasks: get().tasks.map((t) =>
            picked.has(t.id)
              ? { ...t, sectionId: sectionId === TASK_INBOX_ID ? undefined : sectionId }
              : t
          ),
        });
      },

      addTaskSection: (name) => {
        const section: TaskSection = {
          id: crypto.randomUUID(),
          name: name?.trim() || `分组 ${get().taskSections.length}`,
        };
        set({ taskSections: [...get().taskSections, section] });
      },

      renameTaskSection: (id, name) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        set({
          taskSections: get().taskSections.map((s) =>
            s.id === id ? { ...s, name: trimmed } : s
          ),
        });
      },

      deleteTaskSection: (id) => {
        if (id === TASK_INBOX_ID) return;
        get().snapshot("删除任务分组");
        set({
          taskSections: get().taskSections.filter((s) => s.id !== id),
          tasks: get().tasks.map((t) =>
            t.sectionId === id ? { ...t, sectionId: undefined } : t
          ),
        });
      },

      moveTaskSection: (id, dir) => {
        const list = [...get().taskSections];
        const from = list.findIndex((s) => s.id === id);
        const to = from + dir;
        if (from < 0 || to < 0 || to >= list.length) return;
        const [moved] = list.splice(from, 1);
        list.splice(to, 0, moved);
        set({ taskSections: list });
      },

      toggleTaskSectionCollapsed: (id) => {
        set({
          taskSections: get().taskSections.map((s) =>
            s.id === id ? { ...s, collapsed: !s.collapsed } : s
          ),
        });
      },

      updateTaskText: (id, text) => {
        const trimmed = text.trim();
        set({
          tasks: get().tasks.map((t) =>
            t.id === id ? { ...t, text: trimmed || t.text } : t
          ),
        });
      },

      cycleTaskStatus: (id) => {
        const next: Record<TaskStatus, TaskStatus> = {
          todo: "doing",
          doing: "done",
          done: "todo",
        };
        set({
          tasks: get().tasks.map((t) =>
            t.id === id ? { ...t, status: next[t.status] } : t
          ),
        });
      },

      toggleTaskDone: (id) => {
        set({
          tasks: get().tasks.map((t) =>
            t.id === id
              ? { ...t, status: t.status === "done" ? "todo" : "done" }
              : t
          ),
        });
      },

      setTaskStatus: (id, status) => {
        set({
          tasks: get().tasks.map((t) => (t.id === id ? { ...t, status } : t)),
        });
      },

      setTaskPriority: (id, priority) => {
        set({
          tasks: get().tasks.map((t) => (t.id === id ? { ...t, priority } : t)),
        });
      },

      cycleTaskPriority: (id) => {
        const next: Record<TaskPriority, TaskPriority> = {
          none: "low",
          low: "mid",
          mid: "high",
          high: "none",
        };
        set({
          tasks: get().tasks.map((t) =>
            t.id === id ? { ...t, priority: next[t.priority] } : t
          ),
        });
      },

      setTaskDue: (id, dueAt) => {
        set({
          tasks: get().tasks.map((t) =>
            t.id === id ? { ...t, dueAt, remindedAt: null } : t
          ),
        });
      },

      markTasksReminded: (ids) => {
        const picked = new Set(ids);
        const at = Date.now();
        set({
          tasks: get().tasks.map((t) =>
            picked.has(t.id) ? { ...t, remindedAt: at } : t
          ),
        });
      },

      updateTaskNote: (id, note) => {
        const trimmed = note.trim();
        set({
          tasks: get().tasks.map((t) =>
            t.id === id ? { ...t, note: trimmed || undefined } : t
          ),
        });
      },

      addChecklistItem: (taskId, text) => {
        const trimmed = text.trim();
        if (!trimmed) return;
        const item: ChecklistItem = {
          id: crypto.randomUUID(),
          text: trimmed,
          done: false,
        };
        set({
          tasks: get().tasks.map((t) =>
            t.id === taskId
              ? { ...t, checklist: [...(t.checklist ?? []), item] }
              : t
          ),
        });
      },

      toggleChecklistItem: (taskId, itemId) => {
        set({
          tasks: get().tasks.map((t) =>
            t.id === taskId
              ? {
                  ...t,
                  checklist: (t.checklist ?? []).map((c) =>
                    c.id === itemId ? { ...c, done: !c.done } : c
                  ),
                }
              : t
          ),
        });
      },

      updateChecklistItem: (taskId, itemId, text) => {
        const trimmed = text.trim();
        set({
          tasks: get().tasks.map((t) =>
            t.id === taskId
              ? {
                  ...t,
                  checklist: trimmed
                    ? (t.checklist ?? []).map((c) =>
                        c.id === itemId ? { ...c, text: trimmed } : c
                      )
                    : // 清空文本 = 删除该项（Apple 提醒事项同款）
                      (t.checklist ?? []).filter((c) => c.id !== itemId),
                }
              : t
          ),
        });
      },

      deleteChecklistItem: (taskId, itemId) => {
        set({
          tasks: get().tasks.map((t) =>
            t.id === taskId
              ? {
                  ...t,
                  checklist: (t.checklist ?? []).filter((c) => c.id !== itemId),
                }
              : t
          ),
        });
      },

      deleteTasks: (ids, undoLabel) => {
        if (!ids.length) return;
        get().snapshot(undoLabel ?? `删除 ${ids.length} 个任务`);
        const drop = new Set(ids);
        set({ tasks: get().tasks.filter((t) => !drop.has(t.id)) });
      },

      clearDoneTasks: () => {
        const done = get().tasks.filter((t) => t.status === "done");
        if (!done.length) return 0;
        get().snapshot(`清理已完成任务 ${done.length} 个`);
        set({ tasks: get().tasks.filter((t) => t.status !== "done") });
        return done.length;
      },

      convertNoteToTask: (noteId) => {
        const note = get().notes.find((n) => n.id === noteId);
        if (!note) return false;
        // 任务没有图片语义：图片卡与图文组合卡不可转
        if (note.kind === "image" || noteImages(note).length > 0) return false;
        // 必须一次快照 + 一次 set 原子完成，复用 addTask+deleteNotes 会产生
        // 两次快照，撤销只能回滚一半（笔记回来了、任务还在）
        get().snapshot("转为任务");
        const task: Task = {
          id: crypto.randomUUID(),
          text: note.text,
          status: "todo",
          priority: "none",
          dueAt: null,
          createdAt: Date.now(),
          remindedAt: null,
        };
        set({
          tasks: [task, ...get().tasks],
          notes: get().notes.filter((n) => n.id !== noteId),
          checkedIds: get().checkedIds.filter((id) => id !== noteId),
        });
        return true;
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
            tasks: structuredClone(get().tasks),
            taskSections: structuredClone(get().taskSections),
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
          tasks: entry.tasks,
          taskSections: entry.taskSections,
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
        const taskSecIds = new Set(state.taskSections.map((s) => s.id));
        const newTaskSections = (data.taskSections ?? []).filter(
          (s) => s && typeof s.id === "string" && !taskSecIds.has(s.id)
        );
        const allTaskSections = [...state.taskSections, ...newTaskSections];
        const allTaskSecIds = new Set(allTaskSections.map((s) => s.id));
        const taskIds = new Set(state.tasks.map((t) => t.id));
        const newTasks = (data.tasks ?? [])
          .filter(
            (t) =>
              t &&
              typeof t.id === "string" &&
              typeof t.text === "string" &&
              !taskIds.has(t.id)
          )
          .map((t) => ({
            ...t,
            // 孤儿分组兜底回收集箱（undefined 即收集箱）
            sectionId:
              t.sectionId && allTaskSecIds.has(t.sectionId) ? t.sectionId : undefined,
          }));
        set({
          sections: allSections,
          notes: [...state.notes, ...newNotes],
          tasks: [...state.tasks, ...newTasks],
          taskSections: allTaskSections,
        });
        return { notes: newNotes.length, tasks: newTasks.length };
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
        tasks: state.tasks,
        taskSections: state.taskSections,
        settings: state.settings,
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<NotesState>;
        const merged = { ...current, ...p };
        if (!merged.sections?.length) merged.sections = defaultSections();
        if (!merged.taskSections?.length) merged.taskSections = defaultTaskSections();
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
 * 发送成功后应标记完成的卡片：排除「常用」卡、「发送后保留」分组内的卡，
 * 以及剪贴板历史（流水记录发送后仍是历史，没有"完成"语义）。
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
    .filter(
      (n) =>
        picked.has(n.id) &&
        !n.keep &&
        !keepSecs.has(n.sectionId) &&
        n.sectionId !== CLIPBOARD_ID
    )
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
