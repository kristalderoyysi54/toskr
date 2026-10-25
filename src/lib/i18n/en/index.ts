import { common } from "./common";
import { settings } from "./settings";
import { settingsComponents } from "./settingsComponents";
import { app } from "./app";
import { panel } from "./panel";
import { store } from "./store";
import { detail } from "./detail";
import { delivery } from "./delivery";
import { results } from "./results";
import { tasks } from "./tasks";
import { messages } from "./messages";

/** 英文值：普通字符串，或按 vars.n 选择的单复数形式。 */
export type EnValue = string | { one: string; other: string };

/**
 * 按界面区域拆分的英文字典，各区域文件互不依赖；同一中文 key 在多个区域
 * 出现时译文必须一致（i18n.test.ts 校验）。
 */
export const EN_PARTS = { common, settings, settingsComponents, app, panel, store, detail, delivery, results, tasks, messages } as const;

export const en = { ...common, ...settings, ...settingsComponents, ...app, ...panel, ...store, ...detail, ...delivery, ...results, ...tasks, ...messages };
