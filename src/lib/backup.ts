import {
  STORE_VERSION,
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
  settings: Settings;
};

/** 完整备份允许的设置；数据目录指针和 AI key 永不出现在容器中。 */
export function backupSafeSettings(settings: Settings): Omit<Settings, "aiApiKey" | "dataDir"> {
  const { aiApiKey: _secret, dataDir: _pointer, ...safe } = settings;
  return safe;
}

export function buildBackupPayload({
  sections,
  notes,
  taskSections,
  tasks,
  settings,
}: BackupSource) {
  return {
    storeVersion: STORE_VERSION,
    state: {
      sections,
      notes,
      taskSections,
      tasks,
      settings: backupSafeSettings(settings),
    },
  };
}

export function buildMediaIntegrityPayload(source: BackupSource & { undoStack: UndoEntry[] }) {
  return {
    state: {
      notes: source.notes,
      tasks: source.tasks,
    },
    undoStack: source.undoStack,
  };
}
