import {
  STORE_VERSION,
  type Bill,
  type Note,
  type Section,
  type Settings,
  type Task,
  type TaskSection,
  type UndoEntry,
} from "@/store/notesStore";

type BackupSource = {
  sections: Section[];
  notes: Note[];
  taskSections: TaskSection[];
  tasks: Task[];
  bills: Bill[];
  settings: Settings;
};

/** 完整备份允许的设置；数据目录指针和迁移失败时残留的旧 AI key 永不进入容器。 */
export function backupSafeSettings(settings: Settings): Omit<Settings, "dataDir"> {
  const { aiApiKey: _secret, dataDir: _pointer, ...safe } = settings as Settings & {
    aiApiKey?: unknown;
  };
  return safe;
}

export function buildBackupPayload({
  sections,
  notes,
  taskSections,
  tasks,
  bills,
  settings,
}: BackupSource) {
  return {
    storeVersion: STORE_VERSION,
    state: {
      sections,
      notes,
      taskSections,
      tasks,
      bills,
      settings: backupSafeSettings(settings),
    },
  };
}

export function buildMediaIntegrityPayload(
  source: BackupSource & { undoStack: UndoEntry[] },
  editorDraftImages: string[] = []
) {
  return {
    state: {
      notes: source.notes,
      tasks: source.tasks,
      // 账单 favicon（iconFile）纳入引用声明，否则 GC 会当孤儿文件误删
      bills: source.bills,
      editorDrafts: editorDraftImages.length
        ? [{ attachments: [...new Set(editorDraftImages)] }]
        : [],
    },
    undoStack: source.undoStack,
  };
}
