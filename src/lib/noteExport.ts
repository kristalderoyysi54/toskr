import { imageCaption } from "@/lib/format";
import { t } from "@/lib/i18n";
import {
  CLIPBOARD_ID,
  SECRET_ID,
  noteContentBlocks,
  type Note,
  type Section,
} from "@/store/notesStore";
import { sectionName } from "@/lib/i18n/builtinNames";

export interface NotesExportPlan {
  markdown: string;
  mediaFiles: string[];
  noteCount: number;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function formatLocalTime(timestamp: number): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return t("未知");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

function inlineText(value: string): string {
  return value
    .replace(/\s*\r?\n\s*/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/([`*_[\]<>#|])/g, "\\$1")
    .trim();
}

function imageAlt(value: string | undefined, index: number): string {
  return inlineText(value ?? "") || t("图片 {index}", { index });
}

function noteTitle(note: Note, index: number): string {
  return inlineText(note.title?.trim() || note.linkTitle?.trim() || t("笔记 {index}", { index }));
}

/** 笔记正文在产品内是纯文本；用自适应围栏保持原文并阻断远程图片/HTML 激活。 */
function literalTextBlock(text: string, codeLang?: string): string {
  const normalized = text.replace(/\r\n?/g, "\n");
  const longestTicks = Math.max(
    0,
    ...(normalized.match(/`+/g) ?? []).map((ticks) => ticks.length)
  );
  const fence = "`".repeat(Math.max(3, longestTicks + 1));
  const language =
    codeLang && /^[a-z0-9_+.-]{1,32}$/i.test(codeLang) ? codeLang : "text";
  return `${fence}${language}\n${normalized}${normalized.endsWith("\n") ? "" : "\n"}${fence}`;
}

function noteMetadata(note: Note, sectionName: string | undefined): string[] {
  const parts = [t("创建：{time}", { time: formatLocalTime(note.createdAt) })];
  if (note.updatedAt) parts.push(t("更新：{time}", { time: formatLocalTime(note.updatedAt) }));
  if (sectionName) parts.push(t("分组：{name}", { name: inlineText(sectionName) }));
  if (note.tags?.length) {
    parts.push(t("标签：{tags}", { tags: note.tags.map((tag) => `#${inlineText(tag)}`).join(" ") }));
  }
  return parts;
}

/**
 * 构建可读导出快照。富图文只读 contentBlocks；旧卡由该 seam 确定性恢复。
 * 秘文与剪贴历史不属于普通笔记导出，任何混入都整批拒绝，避免旁路泄露。
 */
export function buildNotesExportPlan(input: {
  notes: readonly Note[];
  sections: readonly Section[];
  exportedAtMs?: number;
}): NotesExportPlan {
  const { notes, sections, exportedAtMs = Date.now() } = input;
  if (!notes.length) throw new Error(t("没有可导出的笔记"));
  if (
    notes.some(
      (note) =>
        note.kind === "secret" ||
        note.sectionId === SECRET_ID ||
        note.sectionId === CLIPBOARD_ID
    )
  ) {
    throw new Error(t("秘文与剪贴历史不能作为普通笔记导出"));
  }

  const sectionNames = new Map(sections.map((section) => [section.id, sectionName(section)]));
  const mediaFiles: string[] = [];
  const seenMedia = new Set<string>();
  const chunks = [
    `# ${t("Toskr 笔记导出")}`,
    "",
    `> ${t("导出：{time} · 共 {n} 条", { time: formatLocalTime(exportedAtMs), n: notes.length })}`,
  ];

  notes.forEach((note, noteIndex) => {
    chunks.push("", noteIndex ? "---" : "", "", `## ${noteTitle(note, noteIndex + 1)}`);
    chunks.push("", `> ${noteMetadata(note, sectionNames.get(note.sectionId)).join(" · ")}`);

    const omitImagePlaceholder = note.kind === "image" && imageCaption(note) === "";
    let imageIndex = 0;
    for (const block of noteContentBlocks(note)) {
      if (block.type === "text") {
        if (!omitImagePlaceholder && block.text) {
          chunks.push("", literalTextBlock(block.text, note.codeLang));
        }
        continue;
      }
      imageIndex += 1;
      if (!seenMedia.has(block.file)) {
        seenMedia.add(block.file);
        mediaFiles.push(block.file);
      }
      chunks.push(
        "",
        `![${imageAlt(block.alt, imageIndex)}](media/${encodeURIComponent(block.file)})`
      );
    }
  });

  return {
    markdown: `${chunks.filter((line, index) => line || chunks[index - 1] !== "").join("\n").trim()}\n`,
    mediaFiles,
    noteCount: notes.length,
  };
}

export function notesExportFilename(noteCount: number, timestamp = Date.now()): string {
  const date = new Date(timestamp);
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${t("Toskr-笔记-{day}", { day })}${noteCount > 1 ? t("-{n}条", { n: noteCount }) : ""}.zip`;
}
