/**
 * 进阶上手课（合并发送 / 智能脱敏与还原）的纯状态机。
 * 进度只在内存里：课程随时可重来；示例卡片带固定来源标记，任何时候都能按标记清理。
 */

export type LessonId = "merge" | "privacy";

/** 示例卡片的来源标记：清理只认这个 bundle，绝不按正文匹配用户内容。 */
export const LESSON_SAMPLE_BUNDLE = "com.toskr.tutorial";
export const LESSON_SAMPLE_APP = "Toskr 教程";

export const MERGE_LESSON_SAMPLES = [
  "报错：点击保存后控制台出现 TypeError: cannot read 'id'",
  "复现：修改标题 → 点保存 → 刷新页面，改动消失",
] as const;

export const PRIVACY_LESSON_ALIAS = "张三";
export const PRIVACY_LESSON_SAMPLE =
  "请把会议纪要发给张三，抄送 demo.user@example.com。";

/** 模拟 AI 回复：带占位符，收进 Toskr 时由本机词典还原。 */
export function privacyLessonReply(placeholder: string): string {
  return `好的，已把会议纪要发给 ${placeholder}。`;
}

export interface LessonProgress {
  id: LessonId;
  /** 0 准备示例 → 1 → 2 → 3 完成 */
  step: 0 | 1 | 2 | 3;
  sampleNoteIds: string[];
  aliasId: string | null;
  /** 还原课收回的回复卡，完成时一并清理。 */
  replyNoteId: string | null;
}

export const LESSON_STEPS: Record<LessonId, readonly [string, string, string]> = {
  merge: ["放入示例卡片", "勾选两张", "一起发送"],
  privacy: ["准备示例", "发送并替换", "收回并还原"],
};

export function startLesson(id: LessonId): LessonProgress {
  return { id, step: 0, sampleNoteIds: [], aliasId: null, replyNoteId: null };
}

export function lessonSamplesReady(
  progress: LessonProgress,
  sampleNoteIds: string[],
  aliasId: string | null = null
): LessonProgress {
  if (progress.step !== 0) return progress;
  return { ...progress, step: 1, sampleNoteIds, aliasId };
}

/** 合并课第 2 步：两张示例卡都被勾选即前进；取消勾选不回退，避免来回跳。 */
export function lessonAfterChecked(
  progress: LessonProgress,
  checkedIds: readonly string[]
): LessonProgress {
  if (progress.id !== "merge" || progress.step !== 1) return progress;
  const checked = new Set(checkedIds);
  return progress.sampleNoteIds.length >= 2 &&
    progress.sampleNoteIds.every((id) => checked.has(id))
    ? { ...progress, step: 2 }
    : progress;
}

/**
 * 发送成功后：合并课要求一次发送包含全部示例卡（≥2 张）；
 * 还原课要求发送了示例卡（此时正文里的名字已被替换为占位符）。
 */
export function lessonAfterDelivery(
  progress: LessonProgress,
  sourceIds: readonly string[]
): LessonProgress {
  const sent = new Set(sourceIds);
  const allSamplesSent =
    progress.sampleNoteIds.length > 0 &&
    progress.sampleNoteIds.every((id) => sent.has(id));
  if (progress.id === "merge" && progress.step >= 1 && progress.step < 3) {
    return allSamplesSent && sourceIds.length >= 2
      ? { ...progress, step: 3 }
      : progress;
  }
  if (progress.id === "privacy" && progress.step === 1) {
    return allSamplesSent ? { ...progress, step: 2 } : progress;
  }
  return progress;
}

/** 还原课第 3 步：捕获时至少还原了一处化名即完成。 */
export function lessonAfterCapture(
  progress: LessonProgress,
  noteId: string | null,
  restoredCount: number | null
): LessonProgress {
  if (progress.id !== "privacy" || progress.step !== 2) return progress;
  if (!noteId || !restoredCount || restoredCount < 1) return progress;
  return { ...progress, step: 3, replyNoteId: noteId };
}
