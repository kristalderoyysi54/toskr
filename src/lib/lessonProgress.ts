import {
  lessonAfterCapture,
  lessonAfterChecked,
  lessonAfterDelivery,
  type LessonProgress,
} from "@/lib/lessons";
import { tip } from "@/lib/tip";
import { useLessonStore } from "@/store/lessonStore";
import { useNotesStore } from "@/store/notesStore";

/**
 * 真实操作（勾选 / 发送 / 捕获）回报给进阶课。只依赖 store，
 * 发送与捕获管线引用它不会形成循环依赖。
 */
function advance(update: (progress: LessonProgress) => LessonProgress) {
  const session = useLessonStore.getState().session;
  if (!session) return;
  const next = update(session.progress);
  if (next === session.progress) return;
  useLessonStore.getState().setProgress(next);
  if (next.step !== 3) return;
  useNotesStore.getState().transitionOnboarding({
    type: next.id === "merge" ? "mergeTutorialCompleted" : "recoveryTutorialCompleted",
  });
  tip("ok", next.id === "merge" ? "合并发送课完成" : "脱敏与还原课完成");
}

export function advanceLessonAfterChecked(checkedIds: readonly string[]) {
  advance((progress) => lessonAfterChecked(progress, checkedIds));
}

export function advanceLessonAfterDelivery(sourceIds: readonly string[]) {
  advance((progress) => lessonAfterDelivery(progress, sourceIds));
}

export function advanceLessonAfterCapture(
  noteId: string | null,
  restoredCount: number | null
) {
  advance((progress) => lessonAfterCapture(progress, noteId, restoredCount));
}
