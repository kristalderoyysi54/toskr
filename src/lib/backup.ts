import type { Note, Section, Task, TaskSection } from "@/store/notesStore";

type BackupSource = {
  sections: Section[];
  notes: Note[];
  taskSections: TaskSection[];
  tasks: Task[];
};

/** The exported schema mirrors every content domain accepted by importMerge. */
export function buildBackupPayload({
  sections,
  notes,
  taskSections,
  tasks,
}: BackupSource) {
  return { sections, notes, taskSections, tasks };
}
