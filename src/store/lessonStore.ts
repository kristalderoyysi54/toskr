import { create } from "zustand";

import type { LessonProgress } from "@/lib/lessons";
import type { Settings } from "@/store/notesStore";

/**
 * 进阶上手课的内存进度（不持久化）。完成时间写进 onboarding；
 * 课程改动过的设置记在这里，放弃或删除示例化名时原样还原。
 */
export interface LessonSession {
  progress: LessonProgress;
  /** 还原课为了演示临时打开的化名开关；null 表示未改动。 */
  previousAliasSettings: Pick<
    Settings,
    "aliasEntitiesEnabled" | "aliasAutoRestoreOnCapture"
  > | null;
  /** 示例化名是课程新建的（用户原本就有同名词条时为 false，结束时不删）。 */
  aliasCreatedByLesson: boolean;
}

interface LessonStoreState {
  session: LessonSession | null;
  setSession: (session: LessonSession | null) => void;
  setProgress: (progress: LessonProgress) => void;
}

export const useLessonStore = create<LessonStoreState>((set) => ({
  session: null,
  setSession: (session) => set({ session }),
  setProgress: (progress) =>
    set((state) => (state.session ? { session: { ...state.session, progress } } : state)),
}));
