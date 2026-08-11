import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  VerificationPrivacySummary,
  VerificationReportView,
} from "./ResultVerificationDialog";
import type { VerificationReport } from "@/lib/resultVerification";

const report: VerificationReport = {
  status: "needsReview",
  checks: [
    { id: "json", status: "pass", message: "JSON 语法有效" },
    { id: "facts", status: "needsReview", message: "数字需人工确认" },
  ],
  missing: ["章节 验收标准"],
  newAssumptions: [],
  risks: ["来源版本需确认"],
  questions: ["截止日期是什么？"],
  createdAtMs: 1,
  sourceRevision: "source:1",
  resultRevision: "result:2",
};

describe("ResultVerificationDialog", () => {
  it("报告只展示证据与问题，不渲染来源或结果正文", () => {
    const html = renderToStaticMarkup(
      <VerificationReportView report={report} stale={false} />
    );
    expect(html).toContain("需要人工复核");
    expect(html).toContain("JSON 语法有效");
    expect(html).toContain("截止日期是什么？");
    expect(html).toContain("不代表结果完全正确");
    expect(html).not.toContain("secret source body");
    expect(html).not.toContain("secret result body");
  });

  it("来源或结果变化时明确标记旧报告过期", () => {
    const html = renderToStaticMarkup(
      <VerificationReportView report={report} stale />
    );
    expect(html).toContain("报告已过期");
    expect(html).toContain("不能保存或继续发送");
  });

  it("AI 按钮前只显示 provider、模型、字符范围和 finding 状态", () => {
    const html = renderToStaticMarkup(
      <VerificationPrivacySummary
        provider="OpenAI"
        model="gpt-test"
        prepared={{
          status: "ready",
          sourceText: "safe source",
          resultText: "safe result",
          sourceChars: 120,
          resultChars: 80,
          findingCount: 3,
          replacedCount: 3,
          sourceRevision: "source:1",
          resultRevision: "result:2",
        }}
      />
    );
    expect(html).toContain("OpenAI");
    expect(html).toContain("gpt-test");
    expect(html).toContain("来源 120 字符 · 结果 80 字符");
    expect(html).toContain("3 项 finding 已本地替换");
    expect(html).not.toContain("safe source");
    expect(html).not.toContain("safe result");
  });

  it("报告与 AI 摘要不使用最小字阶承载需要逐字判断的信息", () => {
    const reportHtml = renderToStaticMarkup(
      <VerificationReportView report={report} stale={false} />
    );
    const summaryHtml = renderToStaticMarkup(
      <VerificationPrivacySummary
        provider="DeepSeek"
        model="deepseek-v4-flash"
        prepared={{
          status: "ready",
          sourceText: "safe source",
          resultText: "safe result",
          sourceChars: 26,
          resultChars: 648,
          findingCount: 0,
          replacedCount: 0,
          sourceRevision: "source:1",
          resultRevision: "result:2",
        }}
      />
    );

    expect(reportHtml).not.toContain("text-micro");
    expect(summaryHtml).not.toContain("text-micro");
  });
});
