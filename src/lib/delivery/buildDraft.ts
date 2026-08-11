import {
  applyPromptTemplate,
  buildSendText,
  imageCaption,
  wrapAsCodeBlock,
} from "@/lib/format";
import { noteImages, type Note, type Task } from "@/store/notesStore";

import type {
  DeliveryDraft,
  DeliveryDraftBuildState,
  DeliveryDraftInput,
  DeliveryDraftWarning,
} from "./types";
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

function addWarning(
  warnings: DeliveryDraftWarning[],
  warning: DeliveryDraftWarning
) {
  if (!warnings.includes(warning)) warnings.push(warning);
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

  if (input.sourceKind === "task") {
    const selected = state.tasks.find((task) => requestedIds.has(task.id));
    if (selected) {
      sourceItemIds = [selected.id];
      rawText = buildTaskMarkdown(selected);
    }
  } else {
    const selected = orderedNotes(input.sourceItemIds, state.notes);
    sourceItemIds = selected.map((note) => note.id);
    const textNotes = selected
      .map((note) => ({ note, text: noteText(note) }))
      .filter((entry): entry is { note: Note; text: string } => entry.text !== null);
    rawText = textNotes.length
      ? buildSendText(textNotes.map((entry) => entry.text))
      : "";
    imageFiles = uniqueImages(selected);
    if (textNotes.length === 1) singleCodeLanguage = textNotes[0].note.codeLang;
  }

  if (sourceItemIds.length !== requestedIds.size) {
    addWarning(warnings, "source-missing");
  }

  const format = input.format ?? state.profileResolution.profile.defaultFormat;
  const formattedText = rawText && format === "code"
    ? wrapAsCodeBlock(rawText, singleCodeLanguage)
    : rawText;
  const finalText = input.promptTemplate
    ? applyPromptTemplate(input.promptTemplate, formattedText)
    : formattedText;

  if (!finalText && imageFiles.length === 0) {
    addWarning(warnings, "empty-payload");
  }

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
    assembledText: finalText,
    finalText,
    imageFiles,
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
    redactionMap: {},
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
