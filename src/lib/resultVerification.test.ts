import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/store/persistStorage", () => ({
  tauriStateStorage: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

import {
  buildVerificationContext,
  cancelAiResultVerification,
  createVerificationQuestionsNote,
  isAiVerificationPayload,
  isVerificationReportStale,
  prepareVerificationAiInput,
  resultVerifiedEvent,
  runAiResultVerification,
  saveVerificationReportAsNote,
  verifyResultDeterministically,
  type ResultVerificationExpectation,
  type VerificationReport,
} from "./resultVerification";
import { AiError, type AiRequestHandle, type AiRequestInput } from "./aiClient";
import type { DeliveryEvent } from "./deliveryActivityCore";
import {
  defaultSettings,
  INBOX_ID,
  TASK_INBOX_ID,
  useNotesStore,
  type Note,
} from "@/store/notesStore";

const expectation = (overrides: Partial<ResultVerificationExpectation> = {}) => ({
  format: "auto" as const,
  requiredJsonFields: [],
  requiredSections: [],
  expectedPlaceholderCounts: { "[EMAIL_01]": 1 },
  ...overrides,
});

function resultNote(text: string): Note {
  return {
    id: "result-1",
    text,
    sectionId: INBOX_ID,
    done: false,
    createdAt: 2_000,
    sourceBundle: "com.openai.chat",
    provenance: {
      kind: "deliveryResult",
      deliveryId: "delivery-1",
      capturedAtMs: 2_000,
      sourceBundle: "com.openai.chat",
      sourceItemIds: ["source-1"],
    },
  };
}

function sourceNote(text = "联系 [EMAIL_01] 并输出摘要"): Note {
  return {
    id: "source-1",
    text,
    sectionId: INBOX_ID,
    done: false,
    createdAt: 1_000,
  };
}

function sentEvent(): DeliveryEvent {
  return {
    eventId: "sent-1",
    deliveryId: "delivery-1",
    eventType: "sendSent",
    timestampMs: 1_500,
    sourceKind: "note",
    sourceItemIds: ["source-1"],
    targetBundleId: "com.openai.chat",
    targetAppName: "Chat",
    profileId: "safe",
    status: "sent",
    reasonCode: null,
    durationMs: 20,
    textCharCount: 42,
    imageCount: 0,
    firewallCounts: {
      privateKey: 0, authorization: 0, apiKey: 0, databaseUrl: 0, email: 1,
      phone: 0, nationalId: 0, bankCard: 0, ipAddress: 0, cookie: 0, session: 0,
    },
    redactionCount: 1,
    clipboardOutcome: "restored",
    resultNoteId: null,
    verificationStatus: null,
    verificationCheckCount: null,
    verificationIssueCount: null,
  };
}

function report(overrides: Partial<VerificationReport> = {}): VerificationReport {
  return {
    status: "needsReview",
    checks: [{ id: "local", status: "needsReview", message: "需核对一项" }],
    missing: ["摘要"],
    newAssumptions: [],
    risks: ["数字需复核"],
    questions: ["是否补充摘要？"],
    createdAtMs: 3_000,
    sourceRevision: "source:1",
    resultRevision: "result:2",
    ...overrides,
  };
}

describe("result verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useNotesStore.setState({
      sections: [{ id: INBOX_ID, name: "收件箱" }],
      notes: [],
      tasks: [],
      taskSections: [{ id: TASK_INBOX_ID, name: "收集箱" }],
      checkedIds: [],
      settings: defaultSettings(),
      undoStack: [],
    });
  });

  it("准确检查 JSON、必填字段、章节和占位符", () => {
    const source = sourceNote();
    const result = resultNote('{"answer":"[EMAIL_01]","items":[],"摘要":"已处理"}');
    const context = buildVerificationContext(result, [source], []);
    const passed = verifyResultDeterministically(context, expectation({
      format: "json",
      requiredJsonFields: ["answer", "items"],
      requiredSections: ["摘要"],
    }), 4_000);
    expect(passed.status).toBe("pass");
    expect(passed.missing).toEqual([]);

    const failed = verifyResultDeterministically(
      buildVerificationContext(resultNote('{"answer":"[EMAIL_01]"}'), [source], []),
      expectation({ format: "json", requiredJsonFields: ["items"], requiredSections: ["摘要"] }),
      4_001
    );
    expect(failed.status).toBe("blocked");
    expect(failed.missing).toEqual(expect.arrayContaining(["JSON 字段 items", "章节 摘要"]));
  });

  it("识别占位符丢失、重复、未知和映射失效", () => {
    const source = sourceNote();
    const missing = verifyResultDeterministically(
      buildVerificationContext(resultNote("正常长度但没有占位符的结果内容"), [source], []),
      expectation()
    );
    expect(missing.missing).toContain("占位符 [EMAIL_01]");

    const duplicate = verifyResultDeterministically(
      buildVerificationContext(resultNote("[EMAIL_01] 与 [EMAIL_01]，并新增 [PHONE_01]"), [source], []),
      expectation()
    );
    expect(duplicate.risks.join(" ")).toContain("重复");
    expect(duplicate.newAssumptions).toContain("未知占位符 [PHONE_01]");

    const expired = verifyResultDeterministically(
      buildVerificationContext(resultNote("结果包含 [EMAIL_01] 但会话已重启"), [sourceNote("原始邮箱" )], []),
      expectation({ expectedPlaceholderCounts: null })
    );
    expect(expired.status).toBe("needsReview");
    expect(expired.risks.join(" ")).toContain("映射已失效");

    const expiredWithoutVisiblePlaceholder = verifyResultDeterministically(
      buildVerificationContext(resultNote("结果正文足够长，但当前没有可见占位符。"), [sourceNote("普通来源正文")], []),
      expectation({ expectedPlaceholderCounts: null })
    );
    expect(expiredWithoutVisiblePlaceholder.status).toBe("needsReview");
    expect(expiredWithoutVisiblePlaceholder.checks.find(
      (check) => check.id === "privacy.placeholders"
    )?.message).toContain("无法完整核对");
  });

  it("JSON 必填路径只接受对象自身字段，不把原型属性误判为结果字段", () => {
    const report = verifyResultDeterministically(
      buildVerificationContext(resultNote('{"summary":"ok"}'), [sourceNote("普通来源正文")], []),
      expectation({
        format: "json",
        requiredJsonFields: ["summary", "constructor"],
        expectedPlaceholderCounts: {},
      })
    );
    expect(report.missing).toContain("JSON 字段 constructor");
    expect(report.status).toBe("blocked");
  });

  it("空结果阻断，过短和异常截断要求复核", () => {
    const source = sourceNote("很长的来源".repeat(80));
    const empty = verifyResultDeterministically(
      buildVerificationContext(resultNote("   "), [source], []), expectation({ expectedPlaceholderCounts: {} })
    );
    expect(empty.status).toBe("blocked");

    const truncated = verifyResultDeterministically(
      buildVerificationContext(resultNote("简短结果…"), [source], []), expectation({ expectedPlaceholderCounts: {} })
    );
    expect(truncated.status).toBe("needsReview");
    expect(truncated.risks.join(" ")).toContain("截断");
  });

  it("图片附件明确留在文本核验范围外，不会显示整体通过", () => {
    const source: Note = {
      ...sourceNote("图片说明文字足够长"),
      kind: "image",
      imageFile: "synthetic-source.png",
      imageW: 20,
      imageH: 20,
    };
    const result: Note = {
      ...resultNote("结果说明文字足够长，且没有其他格式缺失。"),
      imageFile: "synthetic-result.png",
    };
    const verified = verifyResultDeterministically(
      buildVerificationContext(result, [source], []),
      expectation({ expectedPlaceholderCounts: {} })
    );
    expect(verified.status).toBe("needsReview");
    expect(verified.checks.find((check) => check.id === "scope.images")?.message)
      .toContain("来源 1，结果 1");
    expect(verified.risks).toContain("图片附件内容需人工核对");
  });

  it("来源删除或在本次核验后变化会阻断并让旧报告过期", () => {
    const originalSource = sourceNote();
    const result = resultNote("足够长的完整结果，包含 [EMAIL_01] 并给出明确结论。");
    const baseline = buildVerificationContext(result, [originalSource], []);
    const missing = buildVerificationContext(result, [], []);
    expect(verifyResultDeterministically(missing, expectation()).status).toBe("blocked");

    const changed = buildVerificationContext(result, [{ ...originalSource, text: "已修改来源" }], []);
    const changedReport = verifyResultDeterministically(changed, expectation({ expectedPlaceholderCounts: {} }), 5_000, baseline.sourceRevision);
    expect(changedReport.status).toBe("blocked");

    const old = verifyResultDeterministically(baseline, expectation(), 4_000);
    expect(isVerificationReportStale(old, changed)).toBe(true);
    expect(isVerificationReportStale(old, { ...baseline, resultNote: { ...result, text: "改过结果" } })).toBe(true);

    const emptySource = verifyResultDeterministically(
      buildVerificationContext(result, [sourceNote("   ")], []),
      expectation({ expectedPlaceholderCounts: {} })
    );
    expect(emptySource.status).toBe("blocked");
    expect(emptySource.missing).toContain("来源文本");
  });

  it("AI payload guard 拒绝未知字段、空内容和错误结构", () => {
    const valid = {
      status: "needsReview",
      checks: [{ id: "facts", status: "needsReview", message: "数字需人工确认" }],
      missing: [],
      newAssumptions: [],
      risks: ["数字来源不明"],
      questions: ["数字是否准确？"],
    };
    expect(isAiVerificationPayload(valid)).toBe(true);
    expect(isAiVerificationPayload({ ...valid, body: "secret" })).toBe(false);
    expect(isAiVerificationPayload({ ...valid, checks: [{ id: "", status: "pass", message: "" }] })).toBe(false);
  });

  it("AI 输入先本地脱敏，block finding 不会以原值外发", async () => {
    const finding = (text: string, category: "email" | "apiKey") => ({
      id: `${category}-1`,
      category,
      severity: category === "apiKey" ? "block" as const : "warn" as const,
      startUtf16: 0,
      endUtf16: text.length,
      maskedPreview: "***",
      suggestedPlaceholder: category === "apiKey" ? "[API_KEY]" : "[EMAIL]",
      ruleId: `test.${category}`,
    });
    const scan = vi.fn(async (text: string) => ({
      findings: [finding(text, text.startsWith("sk-") ? "apiKey" : "email")],
      warnings: [],
      inputUtf16: text.length,
      scannedUtf16: text.length,
      complete: true,
    }));
    const context = {
      ...buildVerificationContext(resultNote("sk-result-secret"), [sourceNote("alice@example.com")], []),
      sourceText: "alice@example.com",
      resultText: "sk-result-secret",
    };
    const prepared = await prepareVerificationAiInput(context, scan);
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") throw new Error("expected ready");
    expect(prepared.sourceText).not.toContain("alice@example.com");
    expect(prepared.resultText).not.toContain("sk-result-secret");
    expect(prepared.findingCount).toBe(2);
    expect(prepared.replacedCount).toBe(2);
  });

  it("扫描失败或不完整时 AI 准备 fail-closed", async () => {
    const context = buildVerificationContext(resultNote("结果正文"), [sourceNote("来源正文")], []);
    const incomplete = await prepareVerificationAiInput(context, async (text) => ({
      findings: [],
      warnings: [{ code: "inputTooLong" as const, message: "too long", maxBytes: 1, actualBytes: 2 }],
      inputUtf16: text.length,
      scannedUtf16: 0, complete: false,
    }));
    expect(incomplete).toMatchObject({ status: "blocked" });
    const failed = await prepareVerificationAiInput(context, async () => { throw new Error("offline"); });
    expect(failed).toMatchObject({ status: "blocked" });
  });

  it("AI 成功使用严格 JSON，本地控制 revision；错误 JSON 不修改结果卡", async () => {
    const context = buildVerificationContext(resultNote("完整结果正文"), [sourceNote("完整来源正文")], []);
    const local = verifyResultDeterministically(context, expectation({ expectedPlaceholderCounts: {} }), 8_000);
    const startRequest = vi.fn((_input: AiRequestInput) => ({
      descriptor: { provider: "Local", model: "mock", baseUrl: "http://localhost", enabled: true, ready: true },
      result: Promise.resolve(JSON.stringify({
        status: "needsReview",
        checks: [{ id: "facts", status: "needsReview", message: "一项事实待确认" }],
        missing: [], newAssumptions: [], risks: ["事实风险"], questions: ["是否确认？"],
      })),
      cancel: vi.fn(),
      transportSettled: Promise.resolve(),
    } satisfies AiRequestHandle));
    const prepared = {
      status: "ready" as const,
      sourceText: "脱敏来源",
      resultText: "脱敏结果",
      sourceChars: 4,
      resultChars: 4,
      findingCount: 0,
      replacedCount: 0,
      sourceRevision: context.sourceRevision,
      resultRevision: context.resultRevision,
    };
    const outcome = await runAiResultVerification({
      resultNoteId: "result-1", expectation: expectation({ expectedPlaceholderCounts: {} }),
      localReport: local, prepared,
    }, { startRequest, now: () => 9_000, requestId: () => "verify-1" });
    expect(outcome.status).toBe("ready");
    if (outcome.status === "ready") {
      expect(outcome.report.sourceRevision).toBe(context.sourceRevision);
      expect(outcome.report.resultRevision).toBe(context.resultRevision);
      expect(outcome.report.createdAtMs).toBe(9_000);
    }
    const request = startRequest.mock.calls[0]?.[0];
    if (!request) throw new Error("missing AI request");
    expect(request.user).toContain("脱敏来源");
    expect(request.user).not.toContain("完整来源正文");

    const before = resultNote("不可修改的结果正文");
    const bad = await runAiResultVerification({
      resultNoteId: "result-bad", expectation: expectation({ expectedPlaceholderCounts: {} }),
      localReport: local, prepared,
    }, { startRequest: (input) => ({ ...startRequest(input), result: Promise.resolve("not-json") }), requestId: () => "verify-bad" });
    expect(bad.status).toBe("error");
    expect(before.text).toBe("不可修改的结果正文");
  });

  it("AI 空响应和超时都只返回错误，不修改结果 Note", async () => {
    const result = resultNote("结果正文保持原样");
    const context = buildVerificationContext(result, [sourceNote("来源正文足够长")], []);
    const localReport = verifyResultDeterministically(
      context,
      expectation({ expectedPlaceholderCounts: {} })
    );
    const prepared = {
      status: "ready" as const,
      sourceText: "safe source",
      resultText: "safe result",
      sourceChars: 11,
      resultChars: 11,
      findingCount: 0,
      replacedCount: 0,
      sourceRevision: context.sourceRevision,
      resultRevision: context.resultRevision,
    };
    const handle = (response: Promise<string>): AiRequestHandle => ({
      descriptor: {
        provider: "Local", model: "mock", baseUrl: "http://localhost",
        enabled: true, ready: true,
      },
      result: response,
      cancel: vi.fn(),
      transportSettled: response.then(() => undefined, () => undefined),
    });
    const empty = await runAiResultVerification({
      resultNoteId: "empty-result", expectation: expectation(), localReport, prepared,
    }, { startRequest: () => handle(Promise.resolve("")) });
    expect(empty.status).toBe("error");
    const timeout = await runAiResultVerification({
      resultNoteId: "timeout-result", expectation: expectation(), localReport, prepared,
    }, {
      startRequest: () => handle(Promise.reject(new AiError("network", "AI 请求超时"))),
    });
    expect(timeout.status).toBe("error");
    expect(result.text).toBe("结果正文保持原样");
  });

  it("重复 AI 点击只允许一个在途，取消后迟到结果不会生效", async () => {
    let resolve!: (value: string) => void;
    const result = new Promise<string>((done) => { resolve = done; });
    let settle!: () => void;
    const transportSettled = new Promise<void>((done) => { settle = done; });
    const cancel = vi.fn();
    const startRequest = vi.fn((_input: AiRequestInput) => ({
      descriptor: { provider: "Local", model: "mock", baseUrl: "http://localhost", enabled: true, ready: true },
      result,
      cancel,
      transportSettled,
    } satisfies AiRequestHandle));
    const context = buildVerificationContext(resultNote("结果正文足够长"), [sourceNote("来源正文足够长")], []);
    const input = {
      resultNoteId: "result-1",
      expectation: expectation({ expectedPlaceholderCounts: {} }),
      localReport: verifyResultDeterministically(context, expectation({ expectedPlaceholderCounts: {} })),
      prepared: {
        status: "ready" as const, sourceText: "safe source", resultText: "safe result",
        sourceChars: 11, resultChars: 11, findingCount: 0, replacedCount: 0,
        sourceRevision: context.sourceRevision, resultRevision: context.resultRevision,
      },
    };
    const first = runAiResultVerification(input, { startRequest, requestId: () => "verify-1" });
    const duplicate = await runAiResultVerification(input, { startRequest, requestId: () => "verify-2" });
    expect(duplicate.status).toBe("duplicate");
    const otherResult = await runAiResultVerification(
      { ...input, resultNoteId: "result-2" },
      { startRequest, requestId: () => "verify-3" }
    );
    expect(otherResult.status).toBe("duplicate");
    expect(startRequest).toHaveBeenCalledOnce();
    cancelAiResultVerification("result-1");
    expect(cancel).toHaveBeenCalledOnce();
    resolve("{}");
    expect((await first).status).toBe("cancelled");
    settle();
  });

  it("保存报告生成普通 Note 并保留 delivery provenance；问题 Note 可继续发送", () => {
    const source = sourceNote();
    const result = resultNote("足够长的结果正文，包含 [EMAIL_01]。");
    useNotesStore.setState({ notes: [result, source] });
    const context = buildVerificationContext(result, [source, result], []);
    const current = report({
      sourceRevision: context.sourceRevision,
      resultRevision: context.resultRevision,
    });
    const saved = saveVerificationReportAsNote(current, context);
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error("expected saved report");
    const reportNote = useNotesStore.getState().notes.find((note) => note.id === saved.noteId)!;
    expect(reportNote.kind).toBe("text");
    expect(reportNote.provenance?.deliveryId).toBe("delivery-1");
    expect(reportNote.text).toContain("核验报告");
    expect(reportNote.text).not.toContain(result.text);

    const questions = createVerificationQuestionsNote(current, context);
    expect(questions.ok).toBe(true);
    if (!questions.ok) throw new Error("expected question note");
    const questionNote = useNotesStore.getState().notes.find((note) => note.id === questions.noteId)!;
    expect(questionNote.text).toContain("是否补充摘要？");
    expect(questionNote.provenance?.deliveryId).toBe("delivery-1");
  });

  it("stale 报告不能保存或生成问题 Note", () => {
    const source = sourceNote();
    const result = resultNote("结果正文");
    useNotesStore.setState({ notes: [result, source] });
    const context = buildVerificationContext(result, [source, result], []);
    const stale = report({ sourceRevision: "old", resultRevision: "old" });
    expect(saveVerificationReportAsNote(stale, context)).toMatchObject({ ok: false, reason: "stale" });
    expect(createVerificationQuestionsNote(stale, context)).toMatchObject({ ok: false, reason: "stale" });
  });

  it("resultVerified 活动只含状态/计数和结果 ID，不含报告正文", () => {
    const event = resultVerifiedEvent(sentEvent(), "result-1", report(), 10_000);
    expect(event).toMatchObject({
      eventType: "resultVerified",
      status: "verified",
      resultNoteId: "result-1",
      verificationStatus: "needsReview",
      verificationCheckCount: 1,
      verificationIssueCount: 4,
    });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("需核对一项");
    expect(serialized).not.toContain("数字需复核");
    expect(Object.keys(event).sort()).toEqual([
      "clipboardOutcome", "deliveryId", "durationMs", "eventId", "eventType",
      "firewallCounts", "imageCount", "metricsEligible", "metricsEpoch", "profileId", "reasonCode", "redactionCount",
      "resultNoteId", "sourceItemIds", "sourceKind", "status", "targetAppName",
      "targetBundleId", "textCharCount", "timestampMs", "transformRecipeId", "verificationCheckCount",
      "verificationIssueCount", "verificationStatus",
    ].sort());
  });
});
