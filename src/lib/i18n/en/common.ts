import type { EnValue } from "./index";

/** 跨区域复用的通用文案。 */
export const common = {
  "取消": "Cancel",
  "确定": "OK",
  "关闭": "Close",
  "删除": "Delete",
  "保存": "Save",
  "撤销": "Undo",
  "复制": "Copy",
  "编辑": "Edit",
  "重命名": "Rename",
  "设置": "Settings",
  "跟随系统": "System",
  "没有可撤销的操作": "Nothing to undo",
  "语言": "Language",
  "跟随系统时，中文系统显示中文，其余显示英文": "When following the system, Chinese systems show Chinese; all others show English",
  "收集箱": "Inbox",
  "未命名分组": "Untitled Group",
  "终端（安全）": "Terminal (Safe)",
  "新笔记": "New note",
  "{n} 条": { one: "{n} item", other: "{n} items" },
} satisfies Record<string, EnValue>;
