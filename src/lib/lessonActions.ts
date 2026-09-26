import { sendNotesToChat } from "@/lib/actions";
import {
  ALIAS_PRESET_CATEGORIES,
  allocateAliasPlaceholder,
  type AliasEntity,
} from "@/lib/delivery/aliasEntities";
import {
  LESSON_SAMPLE_APP,
  LESSON_SAMPLE_BUNDLE,
  MERGE_LESSON_SAMPLES,
  PRIVACY_LESSON_ALIAS,
  PRIVACY_LESSON_SAMPLE,
  lessonSamplesReady,
  privacyLessonReply,
  startLesson,
  type LessonId,
} from "@/lib/lessons";
import { api } from "@/lib/tauri";
import { tip } from "@/lib/tip";
import { useLessonStore } from "@/store/lessonStore";
import { useNotesStore } from "@/store/notesStore";
import { useUIStore } from "@/store/uiStore";

function showNotesPanel() {
  const ui = useUIStore.getState();
  ui.setContentSubview("notes");
  ui.setPage("notes");
  ui.setPinned(true);
  ui.setOpen(true);
  void api.showPanel();
}

/** 只按来源标记删示例卡：用户自己的同文卡片不会被误删。 */
function removeLessonSampleNotes(extraIds: string[] = []) {
  const store = useNotesStore.getState();
  const extra = new Set(extraIds);
  const ids = store.notes
    .filter((note) => note.sourceBundle === LESSON_SAMPLE_BUNDLE || extra.has(note.id))
    .map((note) => note.id);
  if (ids.length) store.deleteNotes(ids, "清理教程示例");
  return ids.length;
}

export function startAdvancedLesson(id: LessonId) {
  const onboarding = useNotesStore.getState().settings.onboarding;
  if (onboarding.rehearsalStatus === "active") {
    tip("info", "请先完成或暂停基础课，再开始进阶课");
    showNotesPanel();
    return;
  }
  // 重来时先收拾上一轮残留，保证示例卡片只有这一组
  abandonAdvancedLesson(false);
  useLessonStore.getState().setSession({
    progress: startLesson(id),
    previousAliasSettings: null,
    aliasCreatedByLesson: false,
  });
  showNotesPanel();
}

/** 第 1 步：放入示例（合并课两张卡；还原课一个化名词条 + 一张卡）。 */
export function prepareLessonSamples() {
  const session = useLessonStore.getState().session;
  if (!session || session.progress.step !== 0) return;
  const store = useNotesStore.getState();
  const addSample = (text: string) =>
    store.addNote(text, { sourceApp: LESSON_SAMPLE_APP, sourceBundle: LESSON_SAMPLE_BUNDLE }).id;

  if (session.progress.id === "merge") {
    const ids = MERGE_LESSON_SAMPLES.map(addSample).filter((id): id is string => Boolean(id));
    store.clearChecked();
    useLessonStore.getState().setProgress(lessonSamplesReady(session.progress, ids));
    return;
  }

  const settings = store.settings;
  let alias = settings.aliasEntities.find((item) => item.originalText === PRIVACY_LESSON_ALIAS);
  const created = !alias;
  const patch: Parameters<typeof store.setSettings>[0] = {
    aliasEntitiesEnabled: true,
    aliasAutoRestoreOnCapture: true,
  };
  if (!alias) {
    const code = ALIAS_PRESET_CATEGORIES[0].code;
    const allocated = allocateAliasPlaceholder(code, settings.aliasNextNumberByCategory);
    const now = Date.now();
    alias = {
      id: crypto.randomUUID(),
      category: code,
      originalText: PRIVACY_LESSON_ALIAS,
      placeholder: allocated.placeholder,
      createdAtMs: now,
      updatedAtMs: now,
    } satisfies AliasEntity;
    patch.aliasEntities = [...settings.aliasEntities, alias];
    patch.aliasNextNumberByCategory = allocated.nextCounters;
  }
  store.setSettings(patch);
  const noteId = addSample(PRIVACY_LESSON_SAMPLE);
  useLessonStore.getState().setSession({
    progress: lessonSamplesReady(session.progress, noteId ? [noteId] : [], alias.id),
    previousAliasSettings: {
      aliasEntitiesEnabled: settings.aliasEntitiesEnabled,
      aliasAutoRestoreOnCapture: settings.aliasAutoRestoreOnCapture,
    },
    aliasCreatedByLesson: created,
  });
}

/** 合并课的兜底：帮用户勾选两张示例卡。 */
export function checkLessonSamples() {
  const session = useLessonStore.getState().session;
  if (!session) return;
  useNotesStore.getState().setChecked(session.progress.sampleNoteIds);
}

/** 发送示例卡；是否弹出预检、如何粘贴都走正常发送管线。 */
export function sendLessonSamples() {
  const session = useLessonStore.getState().session;
  if (!session?.progress.sampleNoteIds.length) return;
  void sendNotesToChat(session.progress.sampleNoteIds);
}

export function lessonAliasPlaceholder(): string | null {
  const aliasId = useLessonStore.getState().session?.progress.aliasId;
  return useNotesStore.getState().settings.aliasEntities
    .find((item) => item.id === aliasId)?.placeholder ?? null;
}

export function copyLessonReply() {
  const placeholder = lessonAliasPlaceholder();
  if (!placeholder) {
    tip("warn", "示例化名已被删除，请重新开始这门课");
    return;
  }
  void api.copyText(privacyLessonReply(placeholder)).then(
    () => tip("ok", "模拟回复已复制：粘贴到文档后选中，再双击快捷键收进来"),
    (error) => tip("warn", `复制失败：${error}`)
  );
}

/** 结束课程：清理示例卡；keepAlias=false 时删除课程新建的化名并还原开关。 */
export function finishAdvancedLesson(keepAlias = true) {
  const session = useLessonStore.getState().session;
  if (!session) return;
  const removed = removeLessonSampleNotes(
    session.progress.replyNoteId ? [session.progress.replyNoteId] : []
  );
  if (!keepAlias) restoreAliasSettings(session);
  useLessonStore.getState().setSession(null);
  if (removed) tip("info", `已清理 ${removed} 张教程示例卡片`);
}

/** 中途退出：清理示例并还原课程改动过的设置。notify=false 用于重开前的静默清理。 */
export function abandonAdvancedLesson(notify = true) {
  const session = useLessonStore.getState().session;
  const removed = removeLessonSampleNotes(
    session?.progress.replyNoteId ? [session.progress.replyNoteId] : []
  );
  if (session) restoreAliasSettings(session);
  useLessonStore.getState().setSession(null);
  if (notify) tip("info", removed ? "已退出课程，示例卡片已清理" : "已退出课程");
}

function restoreAliasSettings(session: NonNullable<ReturnType<typeof useLessonStore.getState>["session"]>) {
  const store = useNotesStore.getState();
  const patch: Parameters<typeof store.setSettings>[0] = {};
  if (session.aliasCreatedByLesson && session.progress.aliasId) {
    patch.aliasEntities = store.settings.aliasEntities.filter(
      (item) => item.id !== session.progress.aliasId
    );
  }
  if (session.previousAliasSettings) Object.assign(patch, session.previousAliasSettings);
  if (Object.keys(patch).length) store.setSettings(patch);
}
