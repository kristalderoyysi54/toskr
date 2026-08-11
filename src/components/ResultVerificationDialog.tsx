import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  FileCheck2,
  LoaderCircle,
  Save,
  Send,
  ShieldCheck,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";

import { SimpleSelect, type SimpleSelectOption } from "@/components/SimpleSelect";
import { Button } from "@/components/ui/button";
import { floatingSurface } from "@/components/ui/floating-surface";
import { IconButton } from "@/components/ui/icon-button";
import { sendNotesToChat } from "@/lib/actions";
import { describeAiClient } from "@/lib/aiClient";
import {
  beginDataGenerationLease,
  currentDataGeneration,
  matchesDataGeneration,
} from "@/lib/dataGeneration";
import {
  DELIVERY_ACTIVITY_MAX_EVENTS,
  getRecentDeliveryEvents,
  recordDeliveryEvent,
  type DeliveryEvent,
} from "@/lib/deliveryActivity";
import {
  deliveryPlaceholderCounts,
} from "@/lib/resultReturn";
import {
  RESULT_VERIFICATION_REQUEST_EVENT,
  awaitResultVerificationTransport,
  buildVerificationContext,
  cancelAiResultVerification,
  createVerificationQuestionsNote,
  isVerificationReportStale,
  prepareVerificationAiInput,
  resultVerifiedEvent,
  runAiResultVerification,
  saveVerificationReportAsNote,
  verifyResultDeterministically,
  type PreparedVerificationAiInput,
  type ResultExpectedFormat,
  type ResultVerificationContext,
  type ResultVerificationExpectation,
  type ResultVerificationRequest,
  type VerificationReport,
  type VerificationStatus,
} from "@/lib/resultVerification";
import { tip } from "@/lib/tip";
import { cn } from "@/lib/utils";
import { isDataOperationLocked } from "@/store/dataOperationStore";
import { useNotesStore } from "@/store/notesStore";

const FORMAT_OPTIONS = [
  { value: "auto", label: "自动判断" },
  { value: "text", label: "普通文本" },
  { value: "json", label: "JSON" },
] as const satisfies readonly SimpleSelectOption<ResultExpectedFormat>[];

const STATUS_LABEL: Record<VerificationStatus, string> = {
  pass: "规则内未发现问题",
  needsReview: "需要人工复核",
  blocked: "存在明确缺失或阻断",
};

const STATUS_STYLE: Record<VerificationStatus, string> = {
  pass: "bg-success/10 text-success",
  needsReview: "bg-warning/10 text-warning",
  blocked: "bg-destructive/10 text-destructive",
};

type PreparedState = PreparedVerificationAiInput | { status: "loading" };

type VerificationSession = {
  requestId: number;
  noteId: string;
  deliveryId: string;
  dataGeneration: number;
  baselineSourceRevision: string;
  deliveryEvent: DeliveryEvent | null;
};

function lines(value: string): string[] {
  return [...new Set(value.split("\n").map((item) => item.trim()).filter(Boolean))];
}

function liveContext(noteId: string): ResultVerificationContext | null {
  const state = useNotesStore.getState();
  const note = state.notes.find((item) => item.id === noteId);
  return note?.provenance
    ? buildVerificationContext(note, state.notes, state.tasks)
    : null;
}

function ReportList({ title, values }: { title: string; values: readonly string[] }) {
  if (!values.length) return null;
  return (
    <section>
      <h4 className="text-label font-semibold text-foreground">{title}</h4>
      <ul className="mt-1 space-y-1 text-body text-muted-foreground">
        {values.map((value) => <li key={value}>• {value}</li>)}
      </ul>
    </section>
  );
}

export function VerificationReportView({
  report,
  stale,
}: {
  report: VerificationReport;
  stale: boolean;
}) {
  return (
    <div className="space-y-3">
      {stale && (
        <div role="alert" className="rounded-xl bg-destructive/10 px-2.5 py-2 text-body text-destructive">
          <strong className="block font-semibold">报告已过期</strong>
          来源、结果或数据上下文已变化，旧报告不能保存或继续发送；请关闭后重新核验。
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("rounded-lg px-2 py-1 text-label font-semibold", STATUS_STYLE[report.status])}>
          {STATUS_LABEL[report.status]}
        </span>
        <time className="text-label tabular-nums text-muted-foreground">
          {new Date(report.createdAtMs).toLocaleString("zh-CN", { hour12: false })}
        </time>
      </div>
      <ol className="space-y-1.5" aria-label="回复检查项">
        {report.checks.map((check) => (
          <li key={check.id} className="flex items-start gap-1.5 rounded-lg bg-muted/45 px-2 py-1.5 text-body">
            {check.status === "pass" ? (
              <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
            ) : (
              <AlertTriangle className={cn(
                "mt-0.5 size-3.5 shrink-0",
                check.status === "blocked" ? "text-destructive" : "text-warning"
              )} aria-hidden />
            )}
            <span>{check.message}</span>
          </li>
        ))}
      </ol>
      <div className="grid gap-3 sm:grid-cols-2">
        <ReportList title="明确缺失" values={report.missing} />
        <ReportList title="新增假设" values={report.newAssumptions} />
        <ReportList title="风险" values={report.risks} />
        <ReportList title="待确认问题" values={report.questions} />
      </div>
      <p className="rounded-lg bg-muted/45 px-2 py-1.5 text-label leading-relaxed text-muted-foreground">
        核验只呈现规则内证据、遗漏和问题，不代表结果完全正确，也不替代人工审批。
      </p>
    </div>
  );
}

export function VerificationPrivacySummary({
  provider,
  model,
  prepared,
}: {
  provider: string;
  model: string;
  prepared: PreparedState;
}) {
  return (
    <div className="rounded-xl bg-muted/45 px-2.5 py-2 text-body">
      <div className="flex items-center gap-1.5 font-medium">
        <ShieldCheck className="size-3.5 text-success" aria-hidden />
        {provider || "未配置服务"} · {model || "未配置模型"}
      </div>
      {prepared.status === "loading" ? (
        <p className="mt-1 text-muted-foreground">正在执行本地隐私检查…</p>
      ) : prepared.status === "blocked" ? (
        <p role="alert" className="mt-1 text-warning">{prepared.reason}</p>
      ) : (
        <>
          <p className="mt-1 text-muted-foreground">
            来源 {prepared.sourceChars} 字符 · 结果 {prepared.resultChars} 字符
          </p>
          <p className="mt-0.5 text-muted-foreground">
            {prepared.findingCount
              ? `${prepared.replacedCount} 项 finding 已本地替换`
              : "本地扫描未发现需替换项"}
          </p>
        </>
      )}
    </div>
  );
}

export function ResultVerificationDialog() {
  const notes = useNotesStore((state) => state.notes);
  const tasks = useNotesStore((state) => state.tasks);
  const aiEnabled = useNotesStore((state) => state.settings.aiEnabled);
  const aiBaseUrl = useNotesStore((state) => state.settings.aiBaseUrl);
  const aiModel = useNotesStore((state) => state.settings.aiModel);
  const [session, setSession] = useState<VerificationSession | null>(null);
  const [expectation, setExpectation] = useState<ResultVerificationExpectation>({
    format: "auto",
    requiredJsonFields: [],
    requiredSections: [],
    expectedPlaceholderCounts: null,
  });
  const [jsonFieldsText, setJsonFieldsText] = useState("");
  const [sectionsText, setSectionsText] = useState("");
  const [report, setReport] = useState<VerificationReport | null>(null);
  const [prepared, setPrepared] = useState<PreparedState>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aiAttribution, setAiAttribution] = useState<string | null>(null);
  const [activityUnavailable, setActivityUnavailable] = useState(false);
  const expectationRef = useRef(expectation);
  const requestSequence = useRef(0);
  const activeNoteId = useRef<string | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const recordedReports = useRef(new Set<number>());

  const descriptor = useMemo(
    () => describeAiClient(undefined, { aiEnabled, aiBaseUrl, aiModel }),
    [aiBaseUrl, aiEnabled, aiModel]
  );

  const currentContext = useMemo(() => {
    if (!session) return null;
    const note = notes.find((item) => item.id === session.noteId);
    return note?.provenance
      ? buildVerificationContext(note, notes, tasks)
      : null;
  }, [notes, session, tasks]);

  const stale = Boolean(
    session && report && (
      !matchesDataGeneration(session.dataGeneration) ||
      !currentContext ||
      isVerificationReportStale(report, currentContext)
    )
  );

  const reset = useCallback(() => {
    requestSequence.current += 1;
    if (activeNoteId.current) cancelAiResultVerification(activeNoteId.current);
    activeNoteId.current = null;
    setSession(null);
    setReport(null);
    setPrepared({ status: "loading" });
    setBusy(false);
    setError(null);
    setAiAttribution(null);
    setActivityUnavailable(false);
    recordedReports.current.clear();
  }, []);

  const startSession = useCallback((detail: Extract<ResultVerificationRequest, { kind: "open" }>) => {
    const context = liveContext(detail.noteId);
    if (!context?.resultNote.provenance) {
      tip("warn", "对应回复已变化，请重新打开检查");
      return;
    }
    if (isDataOperationLocked()) {
      tip("warn", "数据只读期间不能检查回复");
      return;
    }
    if (activeNoteId.current) cancelAiResultVerification(activeNoteId.current);
    const requestId = ++requestSequence.current;
    const dataGeneration = currentDataGeneration();
    const deliveryId = context.resultNote.provenance.deliveryId;
    const knownPlaceholders = deliveryPlaceholderCounts(deliveryId);
    const nextExpectation: ResultVerificationExpectation = {
      format: "auto",
      requiredJsonFields: [],
      requiredSections: [],
      expectedPlaceholderCounts: knownPlaceholders,
    };
    expectationRef.current = nextExpectation;
    returnFocus.current = detail.returnFocus ?? null;
    activeNoteId.current = detail.noteId;
    recordedReports.current.clear();
    setExpectation(nextExpectation);
    setJsonFieldsText("");
    setSectionsText("");
    setReport(verifyResultDeterministically(
      context,
      nextExpectation,
      Date.now(),
      context.sourceRevision
    ));
    setPrepared({ status: "loading" });
    setBusy(false);
    setError(null);
    setAiAttribution(null);
    setActivityUnavailable(false);
    setSession({
      requestId,
      noteId: detail.noteId,
      deliveryId,
      dataGeneration,
      baselineSourceRevision: context.sourceRevision,
      deliveryEvent: null,
    });

    void prepareVerificationAiInput(context).then((next) => {
      if (
        requestSequence.current === requestId &&
        matchesDataGeneration(dataGeneration)
      ) setPrepared(next);
    });

    void getRecentDeliveryEvents(DELIVERY_ACTIVITY_MAX_EVENTS)
      .then((events) => {
        if (
          requestSequence.current !== requestId ||
          !matchesDataGeneration(dataGeneration)
        ) return;
        const deliveryEvent = events.find(
          (event) => event.deliveryId === deliveryId && event.eventType === "sendSent"
        ) ?? null;
        setSession((current) => current?.requestId === requestId
          ? { ...current, deliveryEvent }
          : current);
        setActivityUnavailable(!deliveryEvent);
        const expected = knownPlaceholders ??
          (deliveryEvent?.redactionCount === 0 ? {} : null);
        if (expected === expectationRef.current.expectedPlaceholderCounts) return;
        const updated = {
          ...expectationRef.current,
          expectedPlaceholderCounts: expected,
        };
        expectationRef.current = updated;
        setExpectation(updated);
        setReport((currentReport) => {
          const live = liveContext(detail.noteId);
          return currentReport && live && !isVerificationReportStale(currentReport, live)
            ? verifyResultDeterministically(
                live,
                updated,
                Date.now(),
                context.sourceRevision
              )
            : currentReport;
        });
      })
      .catch(() => {
        if (requestSequence.current === requestId) setActivityUnavailable(true);
      });
  }, []);

  useEffect(() => {
    const onRequest = (event: Event) => {
      const detail = (event as CustomEvent<ResultVerificationRequest>).detail;
      if (!detail) return;
      if (detail.kind === "close") reset();
      else startSession(detail);
    };
    window.addEventListener(RESULT_VERIFICATION_REQUEST_EVENT, onRequest);
    return () => window.removeEventListener(RESULT_VERIFICATION_REQUEST_EVENT, onRequest);
  }, [reset, startSession]);

  const updateExpectation = (next: ResultVerificationExpectation) => {
    if (
      !session || !currentContext || !report || stale ||
      !matchesDataGeneration(session.dataGeneration) || isDataOperationLocked()
    ) return;
    expectationRef.current = next;
    setExpectation(next);
    setAiAttribution(null);
    setReport(verifyResultDeterministically(
      currentContext,
      next,
      Date.now(),
      session.baselineSourceRevision
    ));
  };

  const commitTextExpectations = () => updateExpectation({
    ...expectationRef.current,
    requiredJsonFields: lines(jsonFieldsText),
    requiredSections: lines(sectionsText),
  });

  const recordReport = async (
    currentReport: VerificationReport,
    currentSession: VerificationSession
  ): Promise<boolean> => {
    if (recordedReports.current.has(currentReport.createdAtMs)) return true;
    if (!currentSession.deliveryEvent) return false;
    const recorded = await recordDeliveryEvent(resultVerifiedEvent(
      currentSession.deliveryEvent,
      currentSession.noteId,
      currentReport
    ));
    if (recorded) recordedReports.current.add(currentReport.createdAtMs);
    return recorded;
  };

  const runAi = async () => {
    if (
      !session || !report || !currentContext || stale || busy ||
      prepared.status !== "ready" || !descriptor.ready || isDataOperationLocked()
    ) return;
    if (!matchesDataGeneration(session.dataGeneration)) {
      setError("数据上下文已变化，请重新打开回复检查");
      return;
    }
    if (
      prepared.sourceRevision !== currentContext.sourceRevision ||
      prepared.resultRevision !== currentContext.resultRevision
    ) {
      setError("发送内容或回复已变化，请重新打开检查");
      return;
    }
    const lease = beginDataGenerationLease();
    const requestId = session.requestId;
    setBusy(true);
    setError(null);
    try {
      if (!matchesDataGeneration(lease.generation)) return;
      const outcome = await runAiResultVerification({
        resultNoteId: session.noteId,
        expectation: expectationRef.current,
        localReport: report,
        prepared,
      });
      if (
        requestSequence.current !== requestId ||
        activeNoteId.current !== session.noteId
      ) return;
      if (outcome.status === "ready") {
        setReport(outcome.report);
        setAiAttribution(`${outcome.provider} · ${outcome.model}`);
        const live = liveContext(session.noteId);
        if (
          live && matchesDataGeneration(session.dataGeneration) &&
          !isVerificationReportStale(outcome.report, live)
        ) {
          const recorded = await recordReport(outcome.report, session);
          if (!recorded && session.deliveryEvent) {
            tip("warn", "回复检查已完成，但发送记录更新失败");
          }
        }
      } else if (outcome.status === "error") {
        setError(outcome.error);
      } else if (outcome.status === "duplicate") {
        setError("已有 AI 检查正在收尾，请稍候");
      }
    } finally {
      await awaitResultVerificationTransport(session.noteId);
      lease.release();
      if (
        requestSequence.current === requestId &&
        activeNoteId.current === session.noteId
      ) setBusy(false);
    }
  };

  const cancelAi = () => {
    if (!session) return;
    cancelAiResultVerification(session.noteId);
    setError("AI 检查已取消；回复卡没有被修改");
  };

  const saveReport = async () => {
    if (!session || !report || stale || busy) return;
    if (!matchesDataGeneration(session.dataGeneration) || isDataOperationLocked()) {
      setError("数据上下文已变化，报告未保存");
      return;
    }
    const result = saveVerificationReportAsNote(report, currentContext!);
    if (!result.ok) {
      setError(result.reason === "stale" ? "检查结果已过期，请重新检查" : "报告保存失败");
      return;
    }
    const recorded = await recordReport(report, session);
    tip(
      recorded || !session.deliveryEvent ? "ok" : "warn",
      result.created ? "回复检查报告已保存为普通笔记" : "回复检查报告笔记已存在"
    );
  };

  const continueWithQuestions = async () => {
    if (!session || !report || stale || busy) return;
    if (!matchesDataGeneration(session.dataGeneration) || isDataOperationLocked()) {
      setError("数据上下文已变化，未创建问题清单");
      return;
    }
    const result = createVerificationQuestionsNote(report, currentContext!);
    if (!result.ok) {
      setError(result.reason === "empty"
        ? "当前报告没有可继续发送的问题"
        : result.reason === "stale"
          ? "报告已过期，请重新检查"
          : "问题清单创建失败");
      return;
    }
    await recordReport(report, session);
    reset();
    void sendNotesToChat([result.noteId], undefined, { forcePreflight: true });
  };

  const canContinue = Boolean(
    report && (report.questions.length || report.missing.length || report.risks.length)
  );
  const canRunAi = Boolean(
    session && report && currentContext && !stale && !busy && descriptor.ready &&
    prepared.status === "ready" &&
    prepared.sourceRevision === currentContext.sourceRevision &&
    prepared.resultRevision === currentContext.resultRevision
  );

  return (
    <DialogPrimitive.Root open={!!session} onOpenChange={(open) => !open && reset()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[80] bg-background/70 data-open:animate-in data-open:fade-in-0 duration-100 motion-reduce:!animate-none" />
        <div className="pointer-events-none fixed inset-0 z-[81] grid place-items-center p-2">
          <DialogPrimitive.Content
            data-toskr-modal="result-verification"
            onKeyDown={(event) => event.stopPropagation()}
            onCloseAutoFocus={(event) => {
              const target = returnFocus.current;
              returnFocus.current = null;
              if (!target?.isConnected) return;
              event.preventDefault();
              target.focus();
            }}
            className={cn(
              "pointer-events-auto flex max-h-[calc(100vh-1rem)] w-full max-w-[46rem] flex-col overflow-hidden rounded-2xl p-3 outline-none duration-100 data-open:animate-in data-open:fade-in-0 motion-reduce:!animate-none",
              floatingSurface(3),
              "bg-surface-raised"
            )}
          >
          <header className="flex items-start gap-2 border-b border-border/70 pb-2">
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title className="flex items-center gap-1.5 text-heading font-semibold">
                <FileCheck2 className="size-4 text-primary" aria-hidden /> 检查回复
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="mt-0.5 text-label leading-relaxed text-muted-foreground">
                先用本地规则查找遗漏和格式问题；需要时再让 AI 对照。
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close asChild>
              <IconButton label="关闭回复检查" size="sm"><X /></IconButton>
            </DialogPrimitive.Close>
          </header>

          <div className="mt-2 min-h-0 flex-1 overflow-y-auto pr-0.5">
            <div className="grid gap-3 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
              <aside className="space-y-3">
                <section className="space-y-2 rounded-xl bg-muted/30 p-2.5">
                  <h3 className="text-title font-semibold">你希望回复满足什么？</h3>
                  <SimpleSelect
                    value={expectation.format}
                    options={FORMAT_OPTIONS}
                    onChange={(format) => updateExpectation({
                      ...expectationRef.current,
                      format,
                    })}
                    ariaLabel="结果预期格式"
                    menuLabel="预期格式"
                    disabled={stale || busy}
                  />
                  <label className="block text-label text-foreground/80">
                    JSON 必填字段（每行一个，可用 a.b）
                    <textarea
                      value={jsonFieldsText}
                      maxLength={1_000}
                      disabled={stale || busy}
                      onChange={(event) => {
                        setJsonFieldsText(event.target.value);
                      }}
                      onBlur={commitTextExpectations}
                      className="mt-1 h-16 w-full resize-y rounded-lg border border-border bg-transparent px-2 py-1.5 text-body text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:opacity-50"
                    />
                  </label>
                  <label className="block text-label text-foreground/80">
                    必要标题或段落（每行一个）
                    <textarea
                      value={sectionsText}
                      maxLength={1_000}
                      disabled={stale || busy}
                      onChange={(event) => {
                        setSectionsText(event.target.value);
                      }}
                      onBlur={commitTextExpectations}
                      className="mt-1 h-16 w-full resize-y rounded-lg border border-border bg-transparent px-2 py-1.5 text-body text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:opacity-50"
                    />
                  </label>
                  <p className="text-label leading-relaxed text-muted-foreground">
                    {expectation.expectedPlaceholderCounts === null
                      ? "发送会话映射已失效：无法完整核对占位符，需人工复核。"
                      : `已知发送占位符 ${Object.keys(expectation.expectedPlaceholderCounts).length} 项。`}
                  </p>
                </section>

                <section className="space-y-2">
                  <h3 className="flex items-center gap-1.5 text-title font-semibold">
                    <Bot className="size-3.5" aria-hidden /> 需要时再用 AI 检查
                  </h3>
                  <VerificationPrivacySummary
                    provider={descriptor.provider}
                    model={descriptor.model}
                    prepared={prepared}
                  />
                  {!descriptor.ready && (
                    <p className="text-label text-warning">请先在设置 → AI 智能中配置并启用。</p>
                  )}
                  <div className="flex gap-1.5">
                    {busy ? (
                      <Button type="button" size="sm" variant="secondary" onClick={cancelAi}>
                        <X className="size-3.5" /> 取消检查
                      </Button>
                    ) : (
                      <Button type="button" size="sm" variant="secondary" disabled={!canRunAi} onClick={() => void runAi()}>
                        <Bot className="size-3.5" /> AI 深度检查
                      </Button>
                    )}
                    {busy && <LoaderCircle className="mt-1.5 size-4 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden />}
                  </div>
                  {aiAttribution && (
                    <p className="text-label text-muted-foreground">AI 报告：{aiAttribution}</p>
                  )}
                </section>

                <p className="rounded-lg bg-warning/10 px-2 py-1.5 text-label leading-relaxed text-warning">
                  为保护隐私，发送记录不保存正文。本次比较的是当前发送内容与当前回复；如果原卡后来编辑过，请人工再确认。
                </p>
                {activityUnavailable && (
                  <p className="text-label text-muted-foreground">发送记录暂不可用；仍可在本机检查，但不会补写历史。</p>
                )}
              </aside>

              <main className="min-w-0">
                {error && (
                  <p role="alert" className="mb-2 rounded-lg bg-destructive/10 px-2 py-1.5 text-body text-destructive">
                    {error}
                  </p>
                )}
                {report ? (
                  <VerificationReportView report={report} stale={stale} />
                ) : (
                  <p role="status" className="py-8 text-center text-body text-muted-foreground">正在准备本地检查…</p>
                )}
              </main>
            </div>
          </div>

          <footer className="mt-2 flex flex-wrap items-center justify-end gap-1.5 border-t border-border/70 pt-2">
            <Button type="button" size="sm" variant="ghost" disabled={!report || stale || busy} onClick={() => void saveReport()}>
              <Save className="size-3.5" /> 保存为笔记
            </Button>
            <Button type="button" size="sm" variant="secondary" disabled={!report || stale || busy || !canContinue} onClick={() => void continueWithQuestions()}>
              <Send className="size-3.5" /> 问题进入预检
            </Button>
          </footer>
          <div role="status" aria-live="polite" className="sr-only">
            {busy ? "AI 检查进行中" : error ?? (stale ? "检查报告已过期" : "")}
          </div>
          </DialogPrimitive.Content>
        </div>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
