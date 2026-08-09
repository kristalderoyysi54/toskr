import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { TargetSnapshot } from "@/lib/tauri";
import {
  TargetLensProfileDetails,
  TargetLensView,
  type TargetLensViewProps,
} from "@/components/TargetLensBar";

const readySnapshot: TargetSnapshot = {
  token: "token",
  pid: 42,
  bundleId: "com.openai.codex",
  appName: "Codex",
  launchedAtMs: 500,
  capturedAtMs: 900,
  revision: 1,
  ready: true,
  reason: null,
  windowId: null,
};

function render(props: Partial<TargetLensViewProps>) {
  return renderToStaticMarkup(
    <TargetLensView
      snapshot={null}
      status="unknown"
      reason={null}
      icon={null}
      profileName="安全默认"
      promptGroupName="通用"
      profileSource="safe"
      defaultFormat="plain"
      enterPolicy="never"
      privacyPolicy="requireRedaction"
      duplicateBundleProfileIds={[]}
      profileOverrideNeedsConfirmation={false}
      profileOverrideId={null}
      profileOptions={[{ id: "codex", name: "Codex" }]}
      onRefresh={vi.fn()}
      onConfirmProfile={vi.fn()}
      onSelectProfile={vi.fn()}
      onManageProfiles={vi.fn()}
      {...props}
    />
  );
}

describe("TargetLensView", () => {
  it.each([
    ["unknown", "尚未识别"],
    ["refreshing", "正在确认"],
    ["ready", "可发送"],
    ["blocked", "目标已失效"],
  ] as const)("稳定渲染 %s 状态", (status, label) => {
    const html = render({
      status,
      snapshot: status === "ready" || status === "blocked" ? readySnapshot : null,
      reason: status === "blocked" ? "target_exited" : null,
    });
    expect(html).toContain(label);
  });

  it("VoiceOver 名称包含目标、Profile、分组、格式、回车与隐私策略", () => {
    const html = render({
      status: "ready",
      snapshot: readySnapshot,
      profileName: "Codex",
      promptGroupName: "编程",
      defaultFormat: "code",
      enterPolicy: "allow",
      privacyPolicy: "confirmRaw",
    });

    expect(html).toContain("Codex");
    // 行内只保留非默认回车的警示徽章；完整策略经 aria 与弹层继续可达
    expect(html).toContain("回车：自动");
    expect(html).toContain("自动回车允许");
    expect(html).toContain("Profile Codex");
    expect(html).toContain("Prompt 分组 编程");
    expect(html).toContain("格式代码");
    expect(html).toContain("隐私原文需确认");
    expect(html).toContain("本次投递 Profile：Codex");
    expect(html).toContain('aria-label="重新识别投递目标"');
    expect(html).toContain('tabindex="0"');
  });

  it("回车为关闭时不渲染行内回车徽章", () => {
    const html = render({ status: "ready", snapshot: readySnapshot });
    expect(html).not.toContain("回车：");
  });

  it("Profile 弹层明细包含覆盖选择、分组、格式、回车与隐私（未生效）", () => {
    const html = renderToStaticMarkup(
      <TargetLensProfileDetails
        profileName="Codex"
        promptGroupName="编程"
        defaultFormat="code"
        enterPolicy="allow"
        privacyPolicy="confirmRaw"
        selectDisabled={false}
        profileOverrideId={null}
        profileOptions={[{ id: "codex", name: "Codex" }]}
        onSelectProfile={vi.fn()}
        onManageProfiles={vi.fn()}
      />
    );

    expect(html).toContain('aria-label="本次投递 Profile"');
    expect(html).toContain("自动：Codex");
    expect(html).toContain("模板分组");
    expect(html).toContain("编程");
    expect(html).toContain("代码块");
    expect(html).toContain("自动回车");
    expect(html).toContain("原文需确认（未生效）");
    expect(html).toContain("管理 Profile 与模板…");
  });

  it("目标变化与重复 bundle 都提供同窗可访问警告", () => {
    const html = render({
      status: "ready",
      snapshot: readySnapshot,
      profileName: "临时",
      profileSource: "temporary",
      profileOverrideNeedsConfirmation: true,
      duplicateBundleProfileIds: ["one", "two"],
    });

    expect(html).toContain("目标已变化，请确认 Profile");
    expect(html).toContain("确认本次 Profile");
    expect(html).toContain("多个 Profile 命中");
    expect(html).toContain('role="alert"');
  });

  it("图标缺失时提供稳定 fallback，blocked 展示可行动原因", () => {
    const html = render({
      status: "blocked",
      snapshot: { ...readySnapshot, ready: false, reason: "target_exited" },
      reason: "target_exited",
    });

    expect(html).toContain('data-target-icon="fallback"');
    expect(html).toContain("目标应用已退出，请重新识别");
    expect(html).toContain(
      "隐私要求脱敏"
    );
    expect(html).toContain("重新识别");
  });
});
