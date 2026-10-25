import {
  CheckCircle2,
  Circle,
  Copy,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { tNode, useT, type MessageKey } from "@/lib/i18n";
import { resetInputMonitoringAndReopen } from "@/lib/permissionRecovery";
import {
  SAFE_REHEARSAL_TEXT,
  permissionRehearsalStatus,
  type OnboardingState,
  type PermissionRehearsalStatus,
} from "@/lib/onboarding";
import { openSafeRehearsalPreflight } from "@/lib/actions";
import { api } from "@/lib/tauri";
import { tip } from "@/lib/tip";
import { cn } from "@/lib/utils";
import { useNotesStore } from "@/store/notesStore";
import {
  refreshTarget,
  targetSendDisabled,
  useTargetStore,
} from "@/store/targetStore";
import { useUIStore } from "@/store/uiStore";

const STEP_LABEL: readonly MessageKey[] = ["收进内容", "选择位置", "检查并粘贴"];

export interface SafeDeliveryRehearsalViewProps {
  onboarding: OnboardingState;
  permissionStatus: PermissionRehearsalStatus;
  targetReady: boolean;
  targetName: string;
  targetNeedsConfirmation?: boolean;
  captureKeyLabel?: string;
  onContinuePermissions: () => void;
  onCopySample: () => void;
  onRefreshTarget: () => void;
  onConfirmTarget: () => void;
  onOpenPreflight: () => void;
  onPause: () => void;
  onResume: () => void;
  onSkip: () => void;
  onOpenAccessibility: () => void;
  onOpenInputMonitoring: () => void;
  onResetInputMonitoring: () => void;
}

function PermissionStep({
  status,
  props,
}: {
  status: PermissionRehearsalStatus;
  props: SafeDeliveryRehearsalViewProps;
}) {
  const t = useT();
  if (status === "accessibilityDenied") {
    return (
      <>
        <p className="text-body font-medium">{t("先允许 Toskr 读取选中的文字")}</p>
        <p className="mt-1 text-label text-muted-foreground">
          {t("在系统设置中找到 Toskr，打开开关，然后回到这里。")}
        </p>
        <Button size="xs" className="mt-2" onClick={props.onOpenAccessibility}>
          {t("打开辅助功能设置")}
        </Button>
      </>
    );
  }
  if (status === "tapUnavailable") {
    return (
      <>
        <p className="text-body font-medium">{t("快捷键还没准备好")}</p>
        <p className="mt-1 text-label text-muted-foreground">
          {t("Toskr 正在重试。如果一直停在这里，请检查辅助功能中的 Toskr 开关。")}
        </p>
        <Button size="xs" className="mt-2" onClick={props.onOpenAccessibility}>
          {t("检查辅助功能设置")}
        </Button>
      </>
    );
  }
  if (status === "waitingForEvents") {
    return (
      <>
        <p className="text-body font-medium">{t("按一下键盘，确认快捷键可用")}</p>
        <p className="mt-1 text-label text-muted-foreground">
          {t("请按一下空格键。显示准备好后，点击按钮继续。")}
        </p>
      </>
    );
  }
  if (status === "inputMonitoringBlocked") {
    return (
      <>
        <p className="text-body font-medium text-destructive">{t("还需要允许 Toskr 接收按键")}</p>
        <p className="mt-1 text-label text-muted-foreground">
          {t("打开「输入监控」，开启 Toskr。如果已经开启但仍无反应，可重置授权后重新开启。")}
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Button size="xs" onClick={props.onResetInputMonitoring}>
            {t("重置输入监控授权")}
          </Button>
          <Button size="xs" variant="outline" onClick={props.onOpenInputMonitoring}>
            {t("打开输入监控设置")}
          </Button>
        </div>
      </>
    );
  }
  return (
    <>
      <p className="flex items-center gap-1 text-body font-medium text-success">
        <ShieldCheck className="size-3.5" aria-hidden /> {t("快捷键已准备好")}
      </p>
      <Button size="xs" className="mt-2" onClick={props.onContinuePermissions}>
        {t("开始收一条内容")}
      </Button>
    </>
  );
}

function StepContent(props: SafeDeliveryRehearsalViewProps) {
  const t = useT();
  const { onboarding } = props;
  switch (onboarding.rehearsalStep) {
    case "permissions":
      return <PermissionStep status={props.permissionStatus} props={props} />;
    case "capture": {
      const samplePrepared = onboarding.activationStartedAtMs !== null;
      return (
        <>
          <p className="text-body font-medium">
            {samplePrepared ? t("把示例文字收进 Toskr") : t("先复制这段示例")}
          </p>
          {samplePrepared ? (
            <>
              <ol className="mt-2 list-decimal space-y-2 pl-4 text-label leading-relaxed">
                <li>{tNode("打开「文本编辑」等空白文档，按 {key} 粘贴。", { key: <Kbd>⌘ V</Kbd> })}</li>
                <li>{t("选中刚粘贴的整段文字。")}</li>
                <li>{tNode("连按两次 {key} 键：按下、松开，再按一下。", { key: <Kbd>{props.captureKeyLabel ?? "⇧ Shift"}</Kbd> })}</li>
              </ol>
              <p className="mt-2 text-label text-muted-foreground">
                {t("收好后，Toskr 会自动进入下一步。")}
              </p>
            </>
          ) : (
            <>
              <p className="mt-1 text-label text-muted-foreground">{t("用这段示例试着收进第一张卡片。")}</p>
              <p
                role="textbox"
                aria-readonly="true"
                aria-label={t("教程示例文本")}
                className="mt-2 select-text rounded-lg bg-background/60 p-2 text-label leading-relaxed"
              >
                {SAFE_REHEARSAL_TEXT}
              </p>
            </>
          )}
          <Button size="xs" className="mt-2" onClick={props.onCopySample}>
            <Copy className="size-3" aria-hidden /> {samplePrepared ? t("重新复制示例") : t("复制示例文字")}
          </Button>
        </>
      );
    }
    case "target":
      return (
        <>
          <p className="flex items-center gap-1 text-label text-success">
            <CheckCircle2 className="size-3.5" aria-hidden /> {t("示例内容已收好")}
          </p>
          <p className="mt-1 rounded-lg bg-background/60 p-2 text-label leading-relaxed">
            {SAFE_REHEARSAL_TEXT}
          </p>
          <p className="mt-2 text-body font-medium">{t("这段内容要粘贴到哪里？")}</p>
          <ol className="mt-2 list-decimal space-y-2 pl-4 text-label leading-relaxed">
            <li>{t("回到刚才的空白文档，点击一处空白，让光标停在那里。")}</li>
            <li>{props.targetNeedsConfirmation
              ? t("回到 Toskr，在顶部确认当前应用的方案。")
              : t("回到 Toskr，点「识别粘贴位置」，再确认应用名称。")}</li>
          </ol>
          <p aria-live="polite" className="mt-2 text-label">
            {props.targetNeedsConfirmation
              ? t("已识别到 {name}。请先在面板顶部点击「将…用于当前目标」，确认沿用原方案。", { name: props.targetName })
              : props.targetReady ? t("将粘贴到：{name}", { name: props.targetName }) : t("还没有可用的粘贴位置")}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {!props.targetNeedsConfirmation && (
              <Button size="xs" onClick={props.onRefreshTarget}>
                <RefreshCw className="size-3" aria-hidden /> {t("识别粘贴位置")}
              </Button>
            )}
            {props.targetReady && (
              <Button size="xs" onClick={props.onConfirmTarget}>
                {t("就粘贴到这里")}
              </Button>
            )}
          </div>
        </>
      );
    case "firewall":
    case "delivery":
      return (
        <>
          <p className="text-body font-medium">{t("最后，检查一下要粘贴的内容")}</p>
          <p className="mt-1 text-label leading-relaxed text-muted-foreground">
            {t("下一页会标出示例里的邮箱。选择替换后，检查正文，再点「安全粘贴」。")}
          </p>
          <p className="mt-2 text-label text-muted-foreground">
            {t("完成后，文字会出现在刚才的文档中。教程不会自动按回车。")}
          </p>
          <Button size="xs" className="mt-2" onClick={props.onOpenPreflight}>
            {onboarding.rehearsalStep === "delivery" ? t("继续检查并粘贴") : t("查看要粘贴的内容")}
          </Button>
        </>
      );
    case "complete":
      return null;
  }
}

export function SafeDeliveryRehearsalView(
  props: SafeDeliveryRehearsalViewProps
) {
  const t = useT();
  const { onboarding } = props;
  if (
    onboarding.rehearsalStatus === "notStarted" ||
    onboarding.rehearsalStatus === "skipped" ||
    onboarding.rehearsalStatus === "completed"
  ) {
    return null;
  }
  if (onboarding.rehearsalStatus === "paused") {
    return (
      <section
        aria-label={t("上手教程")}
        className="mx-1 mb-2 mt-1 rounded-xl border border-foreground/10 bg-surface-raised/90 p-3 elevation-3"
      >
        <p className="text-body font-semibold">{t("教程已暂停")}</p>
        <p className="mt-1 text-label text-muted-foreground">
          {t("进度已保存在本机，可在「设置 → 帮助与更新」继续。")}
        </p>
        <Button size="xs" className="mt-2" onClick={props.onResume}>
          {t("继续教程")}
        </Button>
      </section>
    );
  }

  const activeIndex = onboarding.rehearsalStep === "target"
    ? 1
    : ["firewall", "delivery"].includes(onboarding.rehearsalStep) ? 2 : 0;
  return (
    <section
      aria-label={t("上手教程")}
      className="mx-1 mb-2 mt-1 rounded-xl border border-foreground/10 bg-surface-raised/90 p-3 elevation-3"
    >
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-body font-semibold">{t("上手教程")}</p>
          <p className="text-micro text-muted-foreground">{t("一步一步试用 · 不会自动按回车")}</p>
        </div>
        <Button size="xs" variant="ghost" onClick={props.onPause}>
          {t("稍后继续")}
        </Button>
      </div>
      <ol aria-label={t("教程进度")} className="mt-3 grid grid-cols-3 gap-2">
        {STEP_LABEL.map((label, index) => {
          const done = index < activeIndex;
          const current = index === activeIndex;
          return (
            <li
              key={label}
              aria-current={current ? "step" : undefined}
              className={cn(
                "flex min-w-0 flex-col items-center gap-0.5 text-center text-micro",
                current ? "text-foreground" : "text-muted-foreground"
              )}
            >
              {done ? (
                <CheckCircle2 className="size-3 text-success" aria-hidden />
              ) : (
                <Circle className={cn("size-3", current && "text-primary")} aria-hidden />
              )}
              <span className="truncate">{t(label)}</span>
              <span className="sr-only">{done ? t("已完成") : current ? t("当前步骤") : t("未开始")}</span>
            </li>
          );
        })}
      </ol>
      <div role="status" className="mt-2 rounded-lg bg-muted/40 p-2.5">
        <StepContent {...props} />
      </div>
      <button
        type="button"
        onClick={props.onSkip}
        className="mt-2 text-label text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
      >
        {t("退出教程")}
      </button>
    </section>
  );
}

/** 仅做状态接线；步骤展示保留为纯组件，便于无 Tauri 环境审计。 */
export function SafeDeliveryRehearsal() {
  const t = useT();
  const onboarding = useNotesStore((state) => state.settings.onboarding);
  const captureKey = useNotesStore((state) => state.settings.hotkeyModifier);
  const captureKeyLabel = { shift: "⇧ Shift", control: "⌃ Control", option: "⌥ Option" }[captureKey];
  const permissionAx = useUIStore((state) => state.permissionAx);
  const permissionInstalled = useUIStore((state) => state.permissionInstalled);
  const permissionReceiving = useUIStore((state) => state.permissionReceiving);
  const eventsStuck = useUIStore((state) => state.eventsStuck);
  const targetStatus = useTargetStore((state) => state.status);
  const targetSnapshot = useTargetStore((state) => state.snapshot);
  const overrideNeedsConfirmation = useTargetStore(
    (state) => state.profileOverrideNeedsConfirmation
  );
  const permissionStatus = permissionRehearsalStatus(
    permissionAx,
    permissionInstalled,
    permissionReceiving,
    eventsStuck
  );
  const targetReady = targetStatus === "ready" &&
    !overrideNeedsConfirmation &&
    !targetSendDisabled();
  const transition = useNotesStore.getState().transitionOnboarding;

  return (
    <SafeDeliveryRehearsalView
      onboarding={onboarding}
      permissionStatus={permissionStatus}
      captureKeyLabel={captureKeyLabel}
      targetReady={targetReady}
      targetNeedsConfirmation={overrideNeedsConfirmation}
      targetName={
        targetSnapshot?.appName ?? targetSnapshot?.bundleId ?? t("未识别目标")
      }
      onContinuePermissions={() => {
        if (permissionStatus === "ready") {
          transition({ type: "permissionsReady" });
        }
      }}
      onCopySample={() => {
        void api.copyText(SAFE_REHEARSAL_TEXT).then(
          () => {
            transition({ type: "samplePrepared" });
            tip("ok", t("示例已复制，接下来打开空白文档，按 ⌘ V 粘贴"));
          },
          (error) => tip("warn", t("复制示例失败：{error}", { error: String(error) }))
        );
      }}
      onRefreshTarget={() => void refreshTarget()}
      onConfirmTarget={() => {
        if (targetReady) transition({ type: "targetConfirmed" });
      }}
      onOpenPreflight={() => {
        const noteId = onboarding.rehearsalNoteId;
        if (noteId) void openSafeRehearsalPreflight(noteId);
      }}
      onPause={() => {
        transition({ type: "pause" });
        tip("info", t("教程已暂停，可在「设置 → 帮助与更新」继续"));
      }}
      onResume={() => transition({ type: "resume" })}
      onSkip={() => {
        transition({ type: "skip" });
        tip("info", t("已退出教程，可在「设置 → 帮助与更新」重新开始"));
      }}
      onOpenAccessibility={() =>
        void api.openPrivacySettings("accessibility")}
      onOpenInputMonitoring={() =>
        void api.openPrivacySettings("input-monitoring")}
      onResetInputMonitoring={() => void resetInputMonitoringAndReopen()}
    />
  );
}
