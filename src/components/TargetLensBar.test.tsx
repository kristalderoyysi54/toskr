import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { TargetSnapshot } from "@/lib/tauri";
import {
  TargetLensView,
  type TargetLensViewProps,
} from "@/components/TargetLensBar";
import {
  canPermanentlyAssignTargetProfileOverride,
  INITIAL_TARGET_LENS_DISCLOSURE_STATE,
  shouldClearOpenQuickSwitchOverride,
  targetLensDetailsExpanded,
  targetLensDisclosureStateAfter,
} from "@/lib/targetLens";

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
      profileId="default-safe"
      promptGroupName="通用"
      profileSource="fallback"
      defaultFormat="plain"
      enterPolicy="never"
      keepPanel={false}
      privacyCapabilityActive={false}
      profileOverrideNeedsConfirmation={false}
      profileOverrideId={null}
      profileOverrideName={null}
      automaticProfileName="安全默认"
      quickProfiles={[
        {
          id: "default-safe",
          name: "安全默认",
          promptGroupName: "通用",
          defaultFormat: "plain",
          enterPolicy: "never",
          keepPanel: false,
        },
      ]}
      quickSwitchOpen={false}
      canMakePermanent={false}
      onRefresh={vi.fn()}
      onConfirmProfile={vi.fn()}
      onSelectProfile={vi.fn()}
      onQuickSwitchOpenChange={vi.fn()}
      onMakePermanent={vi.fn()}
      onEditCurrentProfile={vi.fn()}
      onOpenActivity={vi.fn()}
      {...props}
    />
  );
}

describe("TargetLensView", () => {
  it("浮层打开期间目标变化会清除不适用的临时覆盖", () => {
    expect(
      shouldClearOpenQuickSwitchOverride({
        open: true,
        profileOverrideId: "temporary",
        profileOverrideTargetIdentity: "otty:42:500",
        targetIdentity: "codex:99:700",
        profileOverrideNeedsConfirmation: true,
      })
    ).toBe(true);
    expect(
      shouldClearOpenQuickSwitchOverride({
        open: false,
        profileOverrideId: "temporary",
        profileOverrideTargetIdentity: "otty:42:500",
        targetIdentity: "codex:99:700",
        profileOverrideNeedsConfirmation: true,
      })
    ).toBe(false);
  });

  it("只有仍绑定当前目标且被统一解析为 temporary 的覆盖才能永久绑定", () => {
    const valid = {
      targetBundleId: "com.example.otty",
      targetIdentity: "otty:42:500",
      profileOverrideId: "writing",
      profileOverrideTargetIdentity: "otty:42:500",
      profileOverrideNeedsConfirmation: false,
      resolvedProfileId: "writing",
      resolvedSource: "temporary" as const,
      isTargetReady: true,
    };

    expect(canPermanentlyAssignTargetProfileOverride(valid)).toBe(true);
    expect(
      canPermanentlyAssignTargetProfileOverride({
        ...valid,
        targetIdentity: "codex:99:700",
      })
    ).toBe(false);
    expect(
      canPermanentlyAssignTargetProfileOverride({
        ...valid,
        profileOverrideNeedsConfirmation: true,
      })
    ).toBe(false);
    expect(
      canPermanentlyAssignTargetProfileOverride({
        ...valid,
        resolvedSource: "fallback",
      })
    ).toBe(false);
  });

  it("默认收起只保留目标与状态，隐藏规则用风险点提示", () => {
    const html = render({
      status: "ready",
      snapshot: { ...readySnapshot, appName: "Otty" },
      profileName: "终端发送",
      profileSource: "exact",
      promptGroupName: "终端问答",
      defaultFormat: "code",
      enterPolicy: "allow",
    });

    expect(html).toContain("Otty");
    expect(html).toContain("可发送");
    expect(html).toContain("data-target-lens-identity");
    expect(html).toContain("size-4 shrink-0 rounded-sm");
    expect(html).toContain("truncate text-label font-semibold");
    expect(html).not.toContain("truncate text-body font-semibold");
    expect(html).toContain("items-center gap-1 text-micro font-medium");
    expect(html).not.toContain("items-center gap-1 text-label font-medium");
    expect(html).toContain(">·</span>");
    expect(html).not.toContain("bg-success/10");
    expect(html).toContain('aria-label="打开最近发送"');
    expect(html).not.toContain("应用指定 · 终端问答 · 代码块");
    expect(html).not.toContain('aria-label="本次发送方案');
    expect(html).not.toContain('aria-label="重新识别发送目标"');
    expect(html).not.toContain("提示词组：终端问答");
    expect(html).not.toContain("输出格式：代码块");
    expect(html).not.toContain("发送完成后：关闭面板");
    expect(html).not.toContain(">自动按回车 · 高风险</span>");
    expect(html).not.toContain(">隐私未启用</span>");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="');
    expect(html).toContain(
      'aria-label="展开发送详情 · 隐私检查已关闭、自动回车已开启"'
    );
    expect(html).toContain("data-target-lens-warning-indicator");
  });

  it("详情状态只响应箭头切换，Escape 收起", () => {
    let state = INITIAL_TARGET_LENS_DISCLOSURE_STATE;
    expect(targetLensDetailsExpanded(state)).toBe(false);

    state = targetLensDisclosureStateAfter(state, { type: "toggle" });
    expect(targetLensDetailsExpanded(state)).toBe(true);

    state = targetLensDisclosureStateAfter(state, { type: "dismiss" });
    expect(targetLensDetailsExpanded(state)).toBe(false);

    state = targetLensDisclosureStateAfter(state, { type: "toggle" });
    state = targetLensDisclosureStateAfter(state, { type: "toggle" });
    expect(targetLensDetailsExpanded(state)).toBe(false);
  });

  it.each([
    ["fallback", "未匹配具体应用，使用默认方案"],
    ["temporary", "仅本次手动选择"],
    ["conflict", "存在重复应用绑定"],
  ] as const)("%s 匹配展示真实选择原因", (profileSource, expected) => {
    const html = render({
      status: "ready",
      snapshot: readySnapshot,
      profileSource,
      profileName: "当前方案",
    });
    expect(html).toContain(expected);
  });

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

  it("VoiceOver 名称使用发送方案术语并如实说明隐私能力", () => {
    const html = render({
      status: "ready",
      snapshot: readySnapshot,
      profileName: "Codex",
      profileSource: "exact",
      promptGroupName: "编程",
      defaultFormat: "code",
      enterPolicy: "allow",
    });

    expect(html).toContain("Codex");
    // 收起态只呈现目标与状态；完整规则仍进入 region 的可访问名称。
    expect(html).toContain("粘贴后动作 自动按回车 · 高风险");
    expect(html).toContain("发送方案 Codex");
    expect(html).toContain("提示词组 编程");
    expect(html).toContain("输出格式 代码块");
    expect(html).toContain("隐私检查：尚未启用");
    expect(html).not.toContain('aria-label="本次发送方案：Codex');
    expect(html).not.toContain('aria-label="重新识别发送目标"');
    expect(html).not.toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-live="off"');
    expect(html).toContain('tabindex="0"');
  });

  it("无目标明确锁定发送，长应用与长方案保持窄宽截断和两行规则", () => {
    const longName = "这是一个非常非常长的目标应用名称用于验证窄面板布局";
    const html = render({
      status: "unknown",
      snapshot: null,
      profileName: `${longName}发送方案`,
      promptGroupName: `${longName}提示词组`,
    });

    expect(html).toContain("尚未识别发送目标，发送已锁定");
    expect(html).toContain("overflow-hidden");
    expect(html).toContain("truncate");
    expect(html).toContain("line-clamp-2");
    expect(html).toContain('aria-label="重新识别发送目标"');
    expect(html).not.toContain("overflow-x-auto");
  });

  it("仅粘贴明确展示不自动回车", () => {
    const html = render({ status: "ready", snapshot: readySnapshot });
    expect(html).toContain("从不按回车");
  });

  it("目标变化后暂停旧临时方案并提供显式应用入口", () => {
    const html = render({
      status: "ready",
      snapshot: readySnapshot,
      profileName: "临时",
      profileSource: "temporary",
      profileOverrideNeedsConfirmation: true,
      profileOverrideName: "临时",
    });

    expect(html).toContain("原临时发送方案已暂停");
    expect(html).toContain("需确认");
    expect(html).not.toContain("目标状态：可发送");
    expect(html).toContain("将 临时 用于当前目标");
  });

  it("图标缺失时提供稳定 fallback，blocked 展示可行动原因", () => {
    const html = render({
      status: "blocked",
      snapshot: { ...readySnapshot, ready: false, reason: "target_exited" },
      reason: "target_exited",
    });

    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Codex 应用图标"');
    expect(html).toContain("目标应用已退出，请重新识别");
    expect(html).toContain("隐私检查：尚未启用");
    expect(html).toContain("重新识别");
  });
});
