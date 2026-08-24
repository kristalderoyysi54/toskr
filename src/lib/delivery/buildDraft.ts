import {
  applyPromptTemplate,
  buildSendText,
  imageCaption,
  wrapAsCodeBlock,
} from "@/lib/format";
import {
  noteContentBlocks,
  textBlockRanges,
  textFromContentBlocks,
} from "@/lib/noteContentBlocks";
import type { DeliverySegment } from "@/lib/tauri";
import { noteImages, type Note, type Task } from "@/store/notesStore";

import type {
  DeliveryDraft,
  DeliveryDraftBuildState,
  DeliveryDraftInput,
  DeliveryDraftWarning,
} from "./types";
import { applyAliasEntities } from "./aliasEntities";
import { EMPTY_PRIVACY_DECISION } from "./firewall";

export function buildTaskMarkdown(task: Task): string {
  const sections = [task.text];
  if (task.note) sections.push(`备注：${task.note}`);
  if (task.checklist?.length) {
    sections.push(
      task.checklist
        .map((item) => `- [${item.done ? "x" : " "}] ${item.text}`)
        .join("\n")
    );
  }
  return sections.join("\n\n");
}

function noteText(note: Note): string | null {
  if (note.kind !== "image") return note.text;
  return imageCaption(note) || null;
}

function orderedNotes(ids: readonly string[], notes: readonly Note[]): Note[] {
  const picked = new Set(ids);
  return notes.filter((note) => picked.has(note.id));
}

function uniqueImages(notes: readonly Note[]): string[] {
  return [...new Set(notes.flatMap((note) => noteImages(note)))];
}

/** 多卡发送与只读来源预览共享同一正文、附件组装规则。 */
export function buildNoteSourceContent(notes: readonly Note[]) {
  const textNotes = notes
    .map((note) => ({ note, text: noteText(note) }))
    .filter((entry): entry is { note: Note; text: string } => entry.text !== null);
  return {
    rawText: textNotes.length
      ? buildSendText(textNotes.map((entry) => entry.text))
      : "",
    imageFiles: uniqueImages(notes),
    singleCodeLanguage:
      textNotes.length === 1 ? textNotes[0].note.codeLang : undefined,
  };
}

function addWarning(
  warnings: DeliveryDraftWarning[],
  warning: DeliveryDraftWarning
) {
  if (!warnings.includes(warning)) warnings.push(warning);
}

/**
 * 单卡图文交错的发送顺序投影。文字段一律取自与 finalText 逐字节一致的
 * 投影切片，保证发出的内容都经过同一次隐私扫描；块序无法与附件清单严格
 * 对齐（重复图片、投影不一致、图不在清单）时返回 null，退回整段+附件顺序。
 */
export function buildDeliverySegments(
  note: Note,
  finalText: string,
  imageFiles: readonly string[]
): DeliverySegment[] | null {
  const blocks = noteContentBlocks(note);
  if (!blocks.some((block) => block.type === "image")) return null;
  if (textFromContentBlocks(blocks) !== finalText) return null;
  const ranges = textBlockRanges(blocks);
  const segments: DeliverySegment[] = [];
  const usedFiles = new Set<string>();
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
    const block = blocks[blockIndex];
    if (block.type === "image") {
      if (usedFiles.has(block.file)) return null;
      usedFiles.add(block.file);
      const fileIndex = imageFiles.indexOf(block.file);
      if (fileIndex < 0) return null;
      segments.push({ kind: "image", fileIndex });
      continue;
    }
    const range = ranges.find((entry) => entry.blockIndex === blockIndex);
    if (!range) return null;
    const piece = finalText.slice(range.start, range.end);
    if (piece.trim()) segments.push({ kind: "text", text: piece });
  }
  if (usedFiles.size !== imageFiles.length) return null;
  return segments;
}

/**
 * 所有发送入口共享的纯构建器。时间、id、revision 均由调用方注入，确保相同
 * input/state 始终得到字节一致的 Draft。
 */
export function buildDeliveryDraft(
  input: DeliveryDraftInput,
  state: DeliveryDraftBuildState
): DeliveryDraft {
  const warnings: DeliveryDraftWarning[] = [];
  const requestedIds = new Set(input.sourceItemIds);
  let sourceItemIds: string[] = [];
  let rawText = "";
  let imageFiles: string[] = [];
  let singleCodeLanguage: string | undefined;
  let isSecretSource = false;
  let appliedTextOverride: string | null = null;
  let sourceNotes: Note[] = [];

  if (input.sourceKind === "task") {
    const selected = state.tasks.find((task) => requestedIds.has(task.id));
    if (selected) {
      sourceItemIds = [selected.id];
      rawText = buildTaskMarkdown(selected);
    }
  } else {
    const selected = orderedNotes(input.sourceItemIds, state.notes);
    sourceNotes = selected;
    sourceItemIds = selected.map((note) => note.id);
    isSecretSource = selected.some((note) => note.kind === "secret");
    if (input.sourceTextOverride !== undefined && selected.length === 1) {
      // 片段发送：正文取选中片段，图片不随行；模板/别名等后续环节照常
      rawText = input.sourceTextOverride;
      appliedTextOverride = input.sourceTextOverride;
    } else {
      const content = buildNoteSourceContent(selected);
      rawText = content.rawText;
      imageFiles = content.imageFiles;
      singleCodeLanguage = content.singleCodeLanguage;
    }
  }

  if (sourceItemIds.length !== requestedIds.size) {
    addWarning(warnings, "source-missing");
  }

  const format = input.format ?? state.profileResolution.profile.defaultFormat;
  const formattedText = rawText && format === "code"
    ? wrapAsCodeBlock(rawText, singleCodeLanguage)
    : rawText;
  // 秘文正文是字节精确的密文信封：套 Prompt 模板会破坏语义、别名字面替换可能改掉
  // 与词典原文同形的码位子串导致永久不可解，故秘文来源一律跳过这两步，原样发送。
  const assembledBase =
    input.promptTemplate && !isSecretSource
      ? applyPromptTemplate(input.promptTemplate, formattedText)
      : formattedText;
  // 词典化名先于隐私正则扫描（扫描发生在 dispatch 阶段），被化名的实体不会再触发正则命中
  const aliasResult =
    state.aliasEntitiesEnabled && assembledBase && !isSecretSource
      ? applyAliasEntities(assembledBase, state.aliasEntities)
      : { text: assembledBase, redactionMap: {}, replacedCount: 0 };
  const finalText = aliasResult.text;

  if (!finalText && imageFiles.length === 0) {
    addWarning(warnings, "empty-payload");
  }

  // 图文交错顺序：finalText === rawText 证明模板/代码块/别名都未改动字节，
  // 交错文字段与已扫描正文才能逐字节对应。
  const segments =
    sourceNotes.length === 1 &&
    appliedTextOverride === null &&
    finalText === rawText
      ? buildDeliverySegments(sourceNotes[0], finalText, imageFiles)
      : null;

  const profile = state.profileResolution.profile;
  const promptSnippetGroupId = input.promptSnippetId
    ? state.promptSnippets.find((snippet) => snippet.id === input.promptSnippetId)
        ?.groupId ?? null
    : null;
  return {
    id: input.id,
    revision: input.revision,
    createdAtMs: input.createdAtMs,
    sourceKind: input.sourceKind,
    sourceItemIds,
    selectionItemIds: [...state.checkedItemIds],
    rawText,
    sourceTextOverride: appliedTextOverride,
    assembledText: finalText,
    finalText,
    originalImageFiles: [...imageFiles],
    imageFiles,
    segments,
    imageFirewall: imageFiles.map((file) => ({
      originalFile: file,
      sendFile: file,
      status: state.firewallEnabled ? "idle" : "disabled",
      pixelHash: null,
      redactedPixelHash: null,
      width: null,
      height: null,
      scanRevision: 0,
      findings: [],
      redactedFindingIds: [],
      keptFindingIds: [],
      manualRegions: [],
      rawConfirmation: null,
      failureMessage: null,
    })),
    format,
    promptSnippetId: input.promptSnippetId ?? null,
    transformRecipeId: null,
    promptSnippetGroupId,
    promptTemplate: input.promptTemplate ?? null,
    targetSnapshot: state.targetSnapshot ? { ...state.targetSnapshot } : null,
    targetProfileId: state.profileResolution.profileId,
    promptGroupId: state.profileResolution.promptGroup.id,
    profileSource: state.profileResolution.source,
    profileDefaultFormat: profile.defaultFormat,
    profileKeepPanel: profile.keepPanel,
    privacyPolicy: profile.privacyPolicy,
    firewallEnabled: state.firewallEnabled,
    firewallDisabledWarnCategories: [...state.firewallDisabledWarnCategories],
    firewallStatus: state.firewallEnabled ? "idle" : "disabled",
    findings: [],
    redactionMap: aliasResult.redactionMap,
    aliasReplacedCount: aliasResult.replacedCount,
    scanRevision: 0,
    privacyDecision: { ...EMPTY_PRIVACY_DECISION },
    enterPolicy: profile.enterPolicy,
    enterDecisionConfirmed: profile.enterPolicy !== "confirm",
    pressEnter: profile.enterPolicy === "allow",
    keepPanel: state.panelPinned || profile.keepPanel,
    warnings,
    dataGeneration: state.dataGeneration,
  };
}
