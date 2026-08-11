import {
  AlertTriangle,
  Image as ImageIcon,
  LocateFixed,
  RotateCcw,
  Send,
  ShieldAlert,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef } from "react";

import { ApplicationIcon } from "@/components/ApplicationIcon";
import { AiTransformPanel } from "@/components/AiTransformPanel";
import { SimpleSelect, type SimpleSelectOption } from "@/components/SimpleSelect";
import { Button } from "@/components/ui/button";
import { floatingSurface } from "@/components/ui/floating-surface";
import { IconButton } from "@/components/ui/icon-button";
import { Kbd } from "@/components/ui/kbd";
import {
  inspectDeliveryDraft,
  inspectDeliveryDraftNonTarget,
  type DeliveryDraftStaleReason,
} from "@/lib/delivery/executeDraft";
import {
  evaluateDeliveryDraftFirewall,
  retryOpenDeliveryDraftScan,
  scanOpenDeliveryDraft,
} from "@/lib/delivery/firewallController";
import {
  FIREWALL_CATEGORY_LABEL,
  FIREWALL_SEVERITY_LABEL,
} from "@/lib/delivery/firewall";
import {
  preflightStaleMessage,
  submitPreflightDraft,
  updateOpenPreflightDraft,
} from "@/lib/delivery/preflight";
import { imageListLabel } from "@/lib/format";
import { useNoteThumb } from "@/lib/media";
import { ENTER_POLICY_STATUS_LABEL } from "@/lib/targetLens";
import type { FirewallFinding } from "@/lib/tauri";
import { promptSnippetsForGroup } from "@/lib/targetProfiles";
import { cn } from "@/lib/utils";
import { useDeliveryStore } from "@/store/deliveryStore";
import { noteImages, useNotesStore } from "@/store/notesStore";
import { useTargetStore } from "@/store/targetStore";
import { closeOpenDraftWithTransforms } from "@/lib/aiTransform";

const FORMAT_OPTIONS = [
  { value: "plain", label: "纯文本" },
  { value: "code", label: "代码块" },
] as const satisfies readonly SimpleSelectOption<"plain" | "code">[];

const WARNING_LABEL: Record<string, string> = {
  "source-missing": "部分来源已不存在",
  "empty-payload": "正文和附件均为空",
};

function dialogFocusables(dialog: HTMLElement | null): HTMLElement[] {
  return Array.from(
    dialog?.querySelectorAll<HTMLElement>(
      'summary, button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ) ?? []
  ).filter((element) => element.offsetParent !== null);
}

function AttachmentThumb({ file, index }: { file: string; index: number }) {
  const url = useNoteThumb(file);
  return url ? (
    <img
      src={url}
      alt={`附件图片 ${index + 1}`}
      className="size-12 shrink-0 rounded-md object-cover ring-1 ring-foreground/10"
    />
  ) : (
    <span
      role="img"
      aria-label={`附件图片 ${index + 1} 正在载入`}
      className="flex size-12 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
    >
      <ImageIcon className="size-4" aria-hidden />
    </span>
  );
}

export function PreflightComposer({ horizontal = false }: { horizontal?: boolean }) {
  const open = useDeliveryStore((state) => state.open);
  const draft = useDeliveryStore((state) => state.draft);
  const busy = useDeliveryStore((state) => state.busy);
  const activeSection = useDeliveryStore((state) => state.activeSection);
  const lastError = useDeliveryStore((state) => state.lastError);
  const retryBlocked = useDeliveryStore((state) => state.retryBlocked);
  const safeRetryPending = useDeliveryStore((state) => state.safeRetryPending);
  const transformStatus = useDeliveryStore((state) => state.transform.status);
  const notes = useNotesStore((state) => state.notes);
  const tasks = useNotesStore((state) => state.tasks);
  const settings = useNotesStore((state) => state.settings);
  const checkedIds = useNotesStore((state) => state.checkedIds);
  const targetSnapshot = useTargetStore((state) => state.snapshot);
  const targetStatus = useTargetStore((state) => state.status);
  const targetIcon = useTargetStore((state) => state.icon);
  const profileOverrideNeedsConfirmation = useTargetStore(
    (state) => state.profileOverrideNeedsConfirmation
  );
  const profileOverrideId = useTargetStore((state) => state.profileOverrideId);
  const profileOverrideTargetIdentity = useTargetStore(
    (state) => state.profileOverrideTargetIdentity
  );
  const dialogRef = useRef<HTMLDivElement>(null);
  const finalTextRef = useRef<HTMLTextAreaElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const staleCacheRef = useRef<{
    inputs: readonly unknown[];
    reason: DeliveryDraftStaleReason | null;
    hiddenReason: DeliveryDraftStaleReason | null;
  } | null>(null);

  // 手工正文和回车/保留开关不会改变来源新鲜度；排除这些高频字段，
  // 避免长正文每次按键都重建完整 Draft。submit 时仍执行一次 live 全量检查。
  const freshnessInputs: readonly unknown[] = [
    checkedIds,
    draft?.assembledText,
    draft?.dataGeneration,
    draft?.enterPolicy,
    draft?.format,
    draft?.id,
    draft?.imageFiles,
    draft?.privacyPolicy,
    draft?.profileDefaultFormat,
    draft?.profileKeepPanel,
    draft?.profileSource,
    draft?.promptGroupId,
    draft?.promptSnippetId,
    draft?.promptSnippetGroupId,
    draft?.promptTemplate,
    draft?.rawText,
    draft?.selectionItemIds,
    draft?.sourceItemIds,
    draft?.sourceKind,
    draft?.targetProfileId,
    draft?.targetSnapshot,
    notes,
    profileOverrideId,
    profileOverrideNeedsConfirmation,
    profileOverrideTargetIdentity,
    safeRetryPending,
    settings.defaultTargetProfileId,
    settings.promptGroups,
    settings.promptSnippets,
    settings.targetProfiles,
    targetSnapshot,
    targetStatus,
    tasks,
  ];
  const cachedStale = staleCacheRef.current;
  if (
    !cachedStale ||
    cachedStale.inputs.length !== freshnessInputs.length ||
    freshnessInputs.some((value, index) => cachedStale.inputs[index] !== value)
  ) {
    const reason = draft ? inspectDeliveryDraft(draft) : null;
    staleCacheRef.current = {
      inputs: freshnessInputs,
      reason,
      hiddenReason:
        draft && safeRetryPending && reason === "target"
          ? inspectDeliveryDraftNonTarget(draft)
          : null,
    };
  }
  const staleReason = staleCacheRef.current?.reason ?? null;
  const hiddenStaleReason = staleCacheRef.current?.hiddenReason ?? null;
  const staleMessage = preflightStaleMessage(hiddenStaleReason ?? staleReason);
  const sourceItemIds = draft?.sourceItemIds;
  const sourceKind = draft?.sourceKind;
  const sourceLabels = useMemo(() => {
    if (!sourceItemIds || !sourceKind) return [];
    const noteById = new Map(notes.map((note) => [note.id, note]));
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    return sourceItemIds.map((id, index) => {
      if (sourceKind === "task") {
        const task = taskById.get(id);
        return task?.text.split("\n", 1)[0] || `已删除任务 ${index + 1}`;
      }
      const note = noteById.get(id);
      if (!note) return `已删除卡片 ${index + 1}`;
      if (note.kind === "image") {
        return imageListLabel(note, noteImages(note).length);
      }
      return (note.title || note.text).split("\n", 1)[0] || `空卡片 ${index + 1}`;
    });
  }, [notes, sourceItemIds, sourceKind, tasks]);
  const promptGroupId = draft?.promptGroupId;
  const promptMenu = useMemo(
    () =>
      promptGroupId
        ? promptSnippetsForGroup(settings.promptSnippets, promptGroupId)
        : { prioritized: [], all: [] },
    [promptGroupId, settings.promptSnippets]
  );
  const draftPromptSnippetId = draft?.promptSnippetId;
  const draftPromptTemplate = draft?.promptTemplate;
  const promptOptions = useMemo(() => {
    const seen = new Set<string>();
    const options: SimpleSelectOption[] = [{ value: "none", label: "无模板" }];
    for (const snippet of [...promptMenu.prioritized, ...promptMenu.all]) {
      if (seen.has(snippet.id)) continue;
      seen.add(snippet.id);
      options.push({ value: snippet.id, label: snippet.label });
    }
    if (draftPromptTemplate && !draftPromptSnippetId) {
      options.push({ value: "custom", label: "本次自定义模板" });
    }
    return options;
  }, [draftPromptSnippetId, draftPromptTemplate, promptMenu]);
  const promptValue = draftPromptSnippetId ?? (draftPromptTemplate ? "custom" : "none");
  const targetProfileId = draft?.targetProfileId;
  const profileName = useMemo(
    () =>
      targetProfileId
        ? settings.targetProfiles.find((item) => item.id === targetProfileId)
            ?.name ?? targetProfileId
        : "",
    [settings.targetProfiles, targetProfileId]
  );
  const hasPayload = Boolean(draft && (draft.finalText || draft.imageFiles.length));
  const enterReady = Boolean(
    draft && (draft.enterPolicy !== "confirm" || draft.enterDecisionConfirmed)
  );
  const enterDecisionLabel = draft?.enterPolicy === "confirm" &&
    !draft.enterDecisionConfirmed
    ? "本次尚未确认"
    : draft?.safeRehearsal
      ? "演练安全锁：只粘贴，不按回车"
      : `本次${draft?.pressEnter ? "会按回车" : "不按回车"}`;
  const canRecoverTarget = safeRetryPending &&
    staleReason === "target" &&
    !hiddenStaleReason;
  const firewall = draft ? evaluateDeliveryDraftFirewall(draft) : null;
  const firewallSummary = useMemo(() => {
    const summary = new Map<
      string,
      {
        category: FirewallFinding["category"];
        severity: FirewallFinding["severity"];
        count: number;
      }
    >();
    for (const finding of draft?.findings ?? []) {
      const current = summary.get(finding.category);
      summary.set(finding.category, {
        category: finding.category,
        severity:
          current?.severity === "block" || finding.severity === "block"
            ? "block"
            : finding.severity,
        count: (current?.count ?? 0) + 1,
      });
    }
    return [...summary.values()];
  }, [draft?.findings]);
  const canSubmit = Boolean(
    draft &&
    !busy &&
    !retryBlocked &&
    (!staleMessage || canRecoverTarget) &&
    hasPayload &&
    enterReady &&
    firewall?.canSend
    && transformStatus !== "running"
  );

  useEffect(() => {
    if (open && draft?.firewallStatus === "idle") {
      const timer = window.setTimeout(() => {
        void scanOpenDeliveryDraft();
      }, 160);
      return () => window.clearTimeout(timer);
    }
  }, [draft?.firewallStatus, draft?.id, draft?.revision, open]);

  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    window.setTimeout(() => dialogRef.current?.focus(), 20);
    return () => {
      restoreFocusRef.current?.focus?.();
      restoreFocusRef.current = null;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === "Tab" &&
        dialogRef.current &&
        !dialogRef.current.contains(document.activeElement)
      ) {
        const focusables = dialogFocusables(dialogRef.current);
        if (focusables.length) {
          event.preventDefault();
          event.stopImmediatePropagation();
          (event.shiftKey ? focusables.at(-1) : focusables[0])?.focus();
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!useDeliveryStore.getState().busy) {
          closeOpenDraftWithTransforms();
        }
        return;
      }
      if (event.key === "Enter" && event.metaKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        void submitPreflightDraft();
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [open]);

  if (!open || !draft) return null;

  const close = () => {
    if (!busy) closeOpenDraftWithTransforms();
  };
  const showSummary = horizontal || activeSection === "summary";
  const showContent = horizontal || activeSection === "content";
  const targetName = draft.targetSnapshot?.appName ?? "未识别目标";
  const icon = targetSnapshot?.bundleId === draft.targetSnapshot?.bundleId
    ? targetIcon?.url
    : null;
  const excludedFindingIds = new Set(
    draft.privacyDecision.excludedFindingIds
  );
  const locateFinding = (start: number, end: number) => {
    useDeliveryStore.getState().setActiveSection("content");
    window.setTimeout(() => {
      finalTextRef.current?.focus();
      finalTextRef.current?.setSelectionRange(start, end);
    });
  };
  const privacyPolicyLabel = {
    requireRedaction: "必须逐项处理",
    confirmRaw: "高风险必处理，提示项可确认保留",
    allowRaw: "允许原文，高风险需二次确认",
  }[draft.privacyPolicy];

  return (
    <>
      <div
        className="absolute inset-0 z-50 bg-black/40 backdrop-blur-[2px]"
        aria-hidden="true"
        onClick={close}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="preflight-title"
        aria-describedby="preflight-status"
        tabIndex={-1}
        className={cn(
          "absolute inset-3 z-50 flex min-h-0 flex-col overflow-hidden rounded-xl outline-none",
          floatingSurface(3)
        )}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const focusables = dialogFocusables(dialogRef.current);
          if (!focusables.length) return;
          const first = focusables[0];
          const last = focusables[focusables.length - 1];
          const active = document.activeElement;
          if (active === dialogRef.current || !dialogRef.current?.contains(active)) {
            event.preventDefault();
            (event.shiftKey ? last : first).focus();
          } else if (event.shiftKey && active === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && active === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <header className="flex items-center gap-2 border-b border-border px-3 py-2">
          <div className="min-w-0 flex-1">
            <h2 id="preflight-title" className="text-title font-semibold">
              {draft.safeRehearsal ? "安全投递演练预检" : "投递预检"}
            </h2>
            <p className="truncate text-micro text-muted-foreground">
              {draft.safeRehearsal
                ? "真实目标 · 假数据 · 只粘贴"
                : "确认目标、内容与粘贴后动作"}
            </p>
          </div>
          {!horizontal && (
            <div className="flex rounded-lg bg-muted/70 p-0.5" role="tablist" aria-label="预检分区">
              {(["summary", "content"] as const).map((section) => (
                <Button
                  key={section}
                  type="button"
                  role="tab"
                  size="xs"
                  variant={activeSection === section ? "secondary" : "ghost"}
                  aria-selected={activeSection === section}
                  onClick={() => useDeliveryStore.getState().setActiveSection(section)}
                >
                  {section === "summary" ? "概览" : "内容"}
                </Button>
              ))}
            </div>
          )}
          <IconButton label="关闭投递预检" size="xs" disabled={busy} onClick={close}>
            <X />
          </IconButton>
        </header>

        <div
          className={cn(
            "min-h-0 flex-1 gap-2 p-2",
            horizontal
              ? "grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] overflow-hidden"
              : "flex flex-col overflow-hidden"
          )}
        >
          <section
            aria-label="投递概览"
            className={cn(
              "min-h-0 space-y-2 overflow-y-auto rounded-lg bg-muted/30 p-2",
              !showSummary && "hidden"
            )}
          >
            <div className="flex items-center gap-2">
              <ApplicationIcon src={icon} name={targetName} className="size-8 rounded-lg" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-body font-medium">{targetName}</p>
                <p className="text-micro text-muted-foreground">
                  {staleReason === "target" ? "目标已变化" : "目标可用"}
                </p>
              </div>
              <span className="rounded-md bg-secondary px-1.5 py-0.5 text-micro">
                {profileName}
              </span>
            </div>

            <details className="rounded-lg border border-border/70 p-2">
              <summary className="cursor-pointer text-label font-medium">
                来源 {draft.sourceItemIds.length} 项
              </summary>
              <ol className="mt-1 space-y-1 pl-4 text-label text-muted-foreground">
                {sourceLabels.map((label, index) => (
                  <li key={`${draft.sourceItemIds[index]}-${index}`} className="list-decimal truncate">
                    {label}
                  </li>
                ))}
              </ol>
            </details>

            {draft.imageFiles.length > 0 && (
              <div>
                <p className="mb-1 text-label font-medium">图片 {draft.imageFiles.length} 张</p>
                <div className="flex gap-1.5 overflow-x-auto pb-1">
                  {draft.imageFiles.map((file, index) => (
                    <AttachmentThumb key={`${file}-${index}`} file={file} index={index} />
                  ))}
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-2">
              <label className="space-y-1 text-label">
                <span className="text-muted-foreground">提示词模板</span>
                <SimpleSelect
                  value={promptValue}
                  options={promptOptions}
                  ariaLabel="本次提示词模板"
                  size="micro"
                  disabled={busy}
                  onChange={(value) => {
                    if (value === "custom") return;
                    const snippet = settings.promptSnippets.find((item) => item.id === value);
                    updateOpenPreflightDraft({
                      promptSnippetId: snippet?.id ?? null,
                      promptTemplate: snippet?.text ?? null,
                    });
                  }}
                />
              </label>
              <label className="space-y-1 text-label">
                <span className="text-muted-foreground">输出格式</span>
                <SimpleSelect
                  value={draft.format}
                  options={FORMAT_OPTIONS}
                  ariaLabel="本次输出格式"
                  size="micro"
                  disabled={busy}
                  onChange={(format) => updateOpenPreflightDraft({ format })}
                />
              </label>
            </div>

            {draft.promptTemplate && (
              <pre className="max-h-16 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-background/60 p-2 font-mono text-micro text-muted-foreground">
                {draft.promptTemplate}
              </pre>
            )}

            <div className="space-y-1 rounded-lg border border-border/70 p-2 text-label">
              <p>
                粘贴后动作：{ENTER_POLICY_STATUS_LABEL[draft.enterPolicy]}
                <span className="text-muted-foreground">
                  {` · ${enterDecisionLabel}`}
                </span>
              </p>
              {draft.safeRehearsal ? (
                <p role="status" className="font-medium text-success">
                  演练安全锁：只粘贴，不按回车
                </p>
              ) : draft.enterPolicy === "confirm" && (
                <fieldset className="space-y-1">
                  <legend className="sr-only">选择本次粘贴后的回车动作</legend>
                  {([
                    [false, "本次不按回车"],
                    [true, "本次粘贴后按回车"],
                  ] as const).map(([pressEnter, label]) => (
                    <label key={label} className="flex items-center gap-1.5">
                      <input
                        type="radio"
                        name="preflight-enter-decision"
                        checked={
                          draft.enterDecisionConfirmed &&
                          draft.pressEnter === pressEnter
                        }
                        disabled={busy}
                        onChange={() =>
                          useDeliveryStore.getState().confirmEnter(pressEnter)
                        }
                      />
                      {label}
                    </label>
                  ))}
                </fieldset>
              )}
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={draft.keepPanel}
                  disabled={busy || draft.safeRehearsal}
                  onChange={(event) =>
                    useDeliveryStore.getState().setKeepPanel(event.target.checked)
                  }
                />
                发送后保留面板
              </label>
            </div>

            {draft.warnings.length > 0 && (
              <div role="status" aria-label="投递警告" className="rounded-lg bg-warning/10 p-2 text-label text-warning">
                <p className="mb-1 flex items-center gap-1 font-medium">
                  <AlertTriangle className="size-3" /> 当前警告
                </p>
                <ul className="space-y-0.5">
                  {draft.warnings.map((warning) => (
                    <li key={warning}>· {WARNING_LABEL[warning] ?? warning}</li>
                  ))}
                </ul>
              </div>
            )}

            <section
              aria-label="本地隐私检查"
              className="space-y-2 rounded-lg border border-border/70 p-2"
            >
              <div className="flex items-center gap-1.5">
                <ShieldAlert className="size-3.5 text-warning" aria-hidden />
                <p className="text-label font-medium">Context Firewall</p>
                <span className="ml-auto text-micro text-muted-foreground">
                  {draft.firewallStatus === "disabled"
                    ? "已关闭"
                    : draft.firewallStatus === "scanning"
                      ? "扫描中…"
                      : draft.firewallStatus === "ready"
                        ? `${draft.findings.length} 项`
                        : draft.firewallStatus === "incomplete"
                          ? "检查不完整"
                          : draft.firewallStatus === "failed"
                            ? "检查失败"
                            : "等待检查"}
                </span>
              </div>
              <p className="text-micro text-muted-foreground">
                {privacyPolicyLabel} · 仅检查文本，检测可能存在误报或漏报
              </p>
              {firewallSummary.length > 0 && (
                <div className="flex flex-wrap gap-1" aria-label="敏感项分类汇总">
                  {firewallSummary.map((item) => (
                    <span
                      key={item.category}
                      className={cn(
                        "rounded-sm px-1.5 py-0.5 text-micro",
                        item.severity === "block"
                          ? "bg-destructive/10 text-destructive"
                          : "bg-warning/10 text-warning"
                      )}
                    >
                      {FIREWALL_CATEGORY_LABEL[item.category]} · {FIREWALL_SEVERITY_LABEL[item.severity]} ×{item.count}
                    </span>
                  ))}
                </div>
              )}
              {draft.findings.length > 0 && (
                <>
                  <ul className="space-y-1.5" aria-label="敏感项列表">
                    {draft.findings.map((finding) => {
                      const excluded = excludedFindingIds.has(finding.id);
                      return (
                        <li
                          key={finding.id}
                          className="rounded-md bg-background/60 p-1.5"
                        >
                          <div className="flex items-center gap-1 text-label">
                            <span className="font-medium">
                              {FIREWALL_CATEGORY_LABEL[finding.category]}
                            </span>
                            <span className={cn(
                              "rounded-sm px-1 py-0.5 text-micro",
                              finding.severity === "block"
                                ? "bg-destructive/10 text-destructive"
                                : "bg-warning/10 text-warning"
                            )}>
                              {FIREWALL_SEVERITY_LABEL[finding.severity]}
                            </span>
                            <code className="min-w-0 flex-1 truncate text-right text-micro text-muted-foreground">
                              {finding.maskedPreview}
                            </code>
                          </div>
                          <div className="mt-1 flex flex-wrap gap-1">
                            <Button
                              type="button"
                              size="xs"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => locateFinding(
                                finding.startUtf16,
                                finding.endUtf16
                              )}
                            >
                              <LocateFixed className="size-3" /> 定位
                            </Button>
                            <Button
                              type="button"
                              size="xs"
                              variant="secondary"
                              disabled={busy}
                              onClick={() =>
                                useDeliveryStore.getState()
                                  .replaceFirewallFinding(finding.id)}
                            >
                              替换此项
                            </Button>
                            <Button
                              type="button"
                              size="xs"
                              variant="ghost"
                              disabled={busy}
                              onClick={() =>
                                useDeliveryStore.getState()
                                  .replaceFirewallCategory(finding.category)}
                            >
                              替换同类
                            </Button>
                            <Button
                              type="button"
                              size="xs"
                              variant="ghost"
                              disabled={busy || excluded}
                              onClick={() =>
                                useDeliveryStore.getState()
                                  .excludeFirewallFinding(finding.id)}
                            >
                              {excluded ? "已明确保留" : "本次保留原文"}
                            </Button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                  <Button
                    type="button"
                    size="xs"
                    variant="secondary"
                    disabled={busy}
                    onClick={() =>
                      useDeliveryStore.getState().replaceAllFirewallFindings()}
                  >
                    替换所有建议项
                  </Button>
                </>
              )}
              {firewall?.needsRawConfirmation && (
                <Button
                  type="button"
                  size="xs"
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    useDeliveryStore.getState().confirmRawPrivacy(
                      firewall.needsRawConfirmation!
                    )}
                >
                  {firewall.needsRawConfirmation === "block"
                    ? "再次确认保留高风险原文"
                    : "确认本次保留提示级原文"}
                </Button>
              )}
              {draft.firewallStatus === "failed" && (
                <Button
                  type="button"
                  size="xs"
                  variant="secondary"
                  disabled={busy}
                  onClick={retryOpenDeliveryDraftScan}
                >
                  重新执行本地检查
                </Button>
              )}
              {firewall?.reason && (
                <p role="status" className="text-micro text-warning">
                  {firewall.reason}
                </p>
              )}
            </section>
          </section>

          <section
            aria-label="最终投递内容"
            className={cn(
              "min-h-0 flex-1 flex-col gap-2 overflow-y-auto rounded-lg bg-muted/30 p-2",
              showContent ? "flex" : "hidden"
            )}
          >
            <div className="flex items-center gap-2">
              <label htmlFor="preflight-final-text" className="text-label font-medium">
                最终文本
              </label>
              <span className="ml-auto text-micro tabular-nums text-muted-foreground">
                {draft.finalText.length} 字符
              </span>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={busy || draft.finalText === draft.assembledText}
                onClick={() => useDeliveryStore.getState().resetFinalText()}
              >
                <RotateCcw className="size-3" /> 恢复自动组装
              </Button>
            </div>
            <textarea
              ref={finalTextRef}
              id="preflight-final-text"
              value={draft.finalText}
              disabled={busy}
              spellCheck={false}
              onChange={(event) => useDeliveryStore.getState().setFinalText(event.target.value)}
              className="min-h-24 flex-1 resize-none rounded-lg border border-border bg-background/70 p-2 font-mono text-body leading-relaxed outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/20"
            />
            <AiTransformPanel
              draft={draft}
              disabled={busy || retryBlocked}
              horizontal={horizontal}
            />
          </section>
        </div>

        <footer className="flex items-center gap-2 border-t border-border px-3 py-2">
          <p
            id="preflight-status"
            role="status"
            aria-live="polite"
            className={cn(
              "min-w-0 flex-1 truncate text-label",
              staleMessage || lastError || firewall?.reason
                ? "text-warning"
                : "text-muted-foreground"
            )}
          >
            {staleMessage ?? lastError ?? firewall?.reason ??
              (draft.safeRehearsal
                ? "演练只会把最终文本粘贴到已确认目标，不会自动回车"
                : "本次修改不会改动原始卡片")}
          </p>
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={close}>
            取消
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!canSubmit}
            aria-describedby="preflight-status"
            onClick={() => void submitPreflightDraft()}
          >
            <Send className="size-3.5" />
            {busy
              ? "发送中…"
              : canRecoverTarget
                ? "重新识别并重试"
                : draft.safeRehearsal
                  ? "安全粘贴"
                  : "确认发送"}
            <Kbd inline>⌘⏎</Kbd>
          </Button>
        </footer>
      </div>
    </>
  );
}
