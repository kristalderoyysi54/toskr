import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/store/persistStorage", () => ({
  tauriStateStorage: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(),
  emitTo: vi.fn(),
  listen: vi.fn(async () => () => {}),
}));
vi.mock("@/lib/tip", () => ({ tip: vi.fn(), undoableTip: vi.fn(), setPendingUndo: vi.fn() }));
vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tauri")>();
  return { ...actual, api: { ...actual.api, showPanel: vi.fn(), copyText: vi.fn(async () => undefined) } };
});

import {
  abandonAdvancedLesson,
  finishAdvancedLesson,
  prepareLessonSamples,
  startAdvancedLesson,
} from "@/lib/lessonActions";
import { advanceLessonAfterCapture, advanceLessonAfterDelivery } from "@/lib/lessonProgress";
import { LESSON_SAMPLE_BUNDLE, PRIVACY_LESSON_ALIAS } from "@/lib/lessons";
import { useLessonStore } from "@/store/lessonStore";
import { defaultSettings, useNotesStore } from "@/store/notesStore";

const tutorialNotes = () =>
  useNotesStore.getState().notes.filter((note) => note.sourceBundle === LESSON_SAMPLE_BUNDLE);

beforeEach(() => {
  useLessonStore.setState({ session: null });
  useNotesStore.setState({
    notes: [],
    checkedIds: [],
    settings: { ...defaultSettings(), aliasEntitiesEnabled: false, aliasAutoRestoreOnCapture: false },
  });
  useNotesStore.getState().addNote("用户自己的卡片");
});

describe("进阶课示例的放入与清理", () => {
  it("合并课放入两张带标记的示例卡，完成后只清理示例、保留用户卡片", () => {
    startAdvancedLesson("merge");
    prepareLessonSamples();
    const samples = tutorialNotes();
    expect(samples).toHaveLength(2);
    expect(useLessonStore.getState().session?.progress.step).toBe(1);

    advanceLessonAfterDelivery(samples.map((note) => note.id));
    expect(useLessonStore.getState().session?.progress.step).toBe(3);
    expect(useNotesStore.getState().settings.onboarding.mergeTutorialCompletedAtMs).not.toBeNull();

    finishAdvancedLesson();
    expect(tutorialNotes()).toHaveLength(0);
    expect(useNotesStore.getState().notes.map((note) => note.text)).toEqual(["用户自己的卡片"]);
    expect(useLessonStore.getState().session).toBeNull();
  });

  it("还原课临时打开化名开关；删除化名时连同开关一起还原", () => {
    startAdvancedLesson("privacy");
    prepareLessonSamples();
    let settings = useNotesStore.getState().settings;
    expect(settings.aliasEntitiesEnabled).toBe(true);
    expect(settings.aliasAutoRestoreOnCapture).toBe(true);
    expect(settings.aliasEntities.map((item) => item.originalText)).toEqual([PRIVACY_LESSON_ALIAS]);

    const [sample] = tutorialNotes();
    advanceLessonAfterDelivery([sample.id]);
    advanceLessonAfterCapture("reply-card", 1);
    expect(useLessonStore.getState().session?.progress.step).toBe(3);
    expect(useNotesStore.getState().settings.onboarding.recoveryTutorialCompletedAtMs).not.toBeNull();

    finishAdvancedLesson(false);
    settings = useNotesStore.getState().settings;
    expect(settings.aliasEntities).toEqual([]);
    expect(settings.aliasEntitiesEnabled).toBe(false);
    expect(settings.aliasAutoRestoreOnCapture).toBe(false);
    expect(tutorialNotes()).toHaveLength(0);
  });

  it("用户原本就有同名化名时，课程结束不删除它", () => {
    useNotesStore.getState().setSettings({
      aliasEntities: [{ id: "mine", category: "USER", originalText: PRIVACY_LESSON_ALIAS, placeholder: "[USER_07]", createdAtMs: 1, updatedAtMs: 1 }],
    });
    startAdvancedLesson("privacy");
    prepareLessonSamples();
    expect(useLessonStore.getState().session?.progress.aliasId).toBe("mine");
    abandonAdvancedLesson();
    expect(useNotesStore.getState().settings.aliasEntities.map((item) => item.id)).toEqual(["mine"]);
  });

  it("重新开始课程先清掉上一轮残留，示例卡始终只有一组", () => {
    startAdvancedLesson("merge");
    prepareLessonSamples();
    startAdvancedLesson("merge");
    prepareLessonSamples();
    expect(tutorialNotes()).toHaveLength(2);
  });
});
