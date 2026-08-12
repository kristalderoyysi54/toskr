import {
  CheckCircle2,
  Circle,
  Copy,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
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

const STEP_ORDER = [
  "permissions",
  "capture",
  "target",
  "firewall",
  "delivery",
] as const;
const STEP_LABEL = ["权限", "捕获", "目标", "脱敏预检", "安全发送"];

export interface SafeDeliveryRehearsalViewProps {
  onboarding: OnboardingState;
  permissionStatus: PermissionRehearsalStatus;
  targetReady: boolean;
  targetName: string;
  onContinuePermissions: () => void;
  onCopySample: () => void;
  onRefreshTarget: () => void;
  onConfirmTarget: () => void;
  onOpenPreflight: () => void;
  onPause: () => void;
  onResume: () => void;
  onDefer: () => void;
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
  if (status === "accessibilityDenied") {
    return (
      <>
        <p className="text-body font-medium">辅助功能尚未授权</p>
        <p className="mt-1 text-label text-muted-foreground">
          只用于监听双击触发和读取你主动选择的文本；授权等待不计入演练耗时。
        </p>
        <Button size="xs" className="mt-2" onClick={props.onOpenAccessibility}>
          打开辅助功能设置
        </Button>
      </>
    );
  }
  if (status === "tapUnavailable") {
    return (
      <>
        <p className="text-body font-medium">权限已给，但监听尚未建立</p>
        <p className="mt-1 text-label text-muted-foreground">
          Toskr 会自动重试；也可先去系统设置确认当前签名条目仍在。
        </p>
        <Button size="xs" className="mt-2" onClick={props.onOpenAccessibility}>
          检查辅助功能设置
        </Button>
      </>
    );
  }
  if (status === "waitingForEvents") {
    return (
      <>
        <p className="text-body font-medium">正在确认按键事件流</p>
        <p className="mt-1 text-label text-muted-foreground">
          请按任意普通按键；系统权限页停留多久都不会被判为失败。
        </p>
      </>
    );
  }
  if (status === "inputMonitoringBlocked") {
    return (
      <>
        <p className="text-body font-medium text-destructive">键盘事件被系统拦截</p>
        <p className="mt-1 text-label text-muted-foreground">
          监听已建立但收不到事件，通常需要重新生成「输入监控」授权条目。
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Button size="xs" onClick={props.onResetInputMonitoring}>
            一键重置授权
          </Button>
          <Button size="xs" variant="outline" onClick={props.onOpenInputMonitoring}>
            打开输入监控设置
          </Button>
        </div>
      </>
    );
  }
  return (
    <>
      <p className="flex items-center gap-1 text-body font-medium text-success">
        <ShieldCheck className="size-3.5" aria-hidden /> 权限与事件流均已就绪
      </p>
      <Button size="xs" className="mt-2" onClick={props.onContinuePermissions}>
        继续示例捕获
      </Button>
    </>
  );
}

function StepContent(props: SafeDeliveryRehearsalViewProps) {
  const { onboarding } = props;
  switch (onboarding.rehearsalStep) {
    case "permissions":
      return <PermissionStep status={props.permissionStatus} props={props} />;
    case "capture":
      return (
        <>
          <p className="text-body font-medium">捕获一段受控示例</p>
          <p
            role="textbox"
            aria-readonly="true"
            aria-label="演练示例文本"
            className="mt-1 select-text rounded-lg bg-background/60 p-2 text-label leading-relaxed"
          >
            {SAFE_REHEARSAL_TEXT}
          </p>
          <p className="mt-1.5 text-label text-muted-foreground">
            复制后粘贴到 TextEdit 等临时文档，选中全文并连按两次 <Kbd>⇧</Kbd>；
            捕获成功会自动进入下一步。
          </p>
          <Button size="xs" className="mt-2" onClick={props.onCopySample}>
            <Copy className="size-3" aria-hidden /> 复制演练示例
          </Button>
        </>
      );
    case "target":
      return (
        <>
          <p className="text-body font-medium">确认一个安全目标</p>
          <p className="mt-1 text-label text-muted-foreground">
            建议使用 TextEdit 空白文档。先切到目标，再回 Toskr 重新识别；演练不会自动回车。
          </p>
          <p aria-live="polite" className="mt-1.5 text-label">
            当前：{props.targetReady ? props.targetName : "请先打开一个安全目标"}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Button size="xs" variant="outline" onClick={props.onRefreshTarget}>
              <RefreshCw className="size-3" aria-hidden /> 重新识别
            </Button>
            {props.targetReady && (
              <Button size="xs" onClick={props.onConfirmTarget}>
                确认这个目标
              </Button>
            )}
          </div>
        </>
      );
    case "firewall":
    case "delivery":
      return (
        <>
          <p className="text-body font-medium">脱敏、核对最终正文，再安全发送</p>
          <p className="mt-1 text-label text-muted-foreground">
            本地隐私检查会识别假邮箱；请应用替换并检查最终正文。演练安全锁下自动回车始终关闭。
          </p>
          <Button size="xs" className="mt-2" onClick={props.onOpenPreflight}>
            {onboarding.rehearsalStep === "delivery" ? "重新打开演练预检" : "打开演练预检"}
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
  const { onboarding } = props;
  if (onboarding.rehearsalStep === "complete" && !onboarding.rehearsalActive) {
    return null;
  }
  if (!onboarding.rehearsalActive) {
    return (
      <section
        aria-label="安全发送演练"
        className="mx-1 mb-2 mt-1 rounded-xl border border-foreground/10 bg-surface-raised/90 p-3 elevation-3"
      >
        <p className="text-body font-semibold">安全发送演练已暂停</p>
        <p className="mt-1 text-label text-muted-foreground">
          进度已保存在本机，继续时会从上一步恢复。
        </p>
        <Button size="xs" className="mt-2" onClick={props.onResume}>
          继续演练
        </Button>
      </section>
    );
  }

  const activeIndex = Math.max(
    0,
    STEP_ORDER.indexOf(onboarding.rehearsalStep as (typeof STEP_ORDER)[number])
  );
  return (
    <section
      aria-label="安全发送演练"
      className="mx-1 mb-2 mt-1 rounded-xl border border-foreground/10 bg-surface-raised/90 p-3 elevation-3"
    >
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-body font-semibold">安全发送演练</p>
          <p className="text-micro text-muted-foreground">真实链路 · 假数据 · 不自动回车</p>
        </div>
        <Button size="xs" variant="ghost" onClick={props.onPause}>
          暂停
        </Button>
      </div>
      <ol aria-label="演练进度" className="mt-2 grid grid-cols-5 gap-1">
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
              <span className="truncate">{label}</span>
              <span className="sr-only">{done ? "已完成" : current ? "当前步骤" : "未开始"}</span>
            </li>
          );
        })}
      </ol>
      <div role="status" className="mt-2 rounded-lg bg-muted/40 p-2.5">
        <StepContent {...props} />
      </div>
      <button
        type="button"
        onClick={props.onDefer}
        className="mt-2 text-label text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
      >
        稍后在真实应用演练
      </button>
    </section>
  );
}

/** 仅做状态接线；步骤展示保留为纯组件，便于无 Tauri 环境审计。 */
export function SafeDeliveryRehearsal() {
  const onboarding = useNotesStore((state) => state.settings.onboarding);
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
      targetReady={targetReady}
      targetName={
        targetSnapshot?.appName ?? targetSnapshot?.bundleId ?? "未识别目标"
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
            tip("ok", "演练示例已复制，请粘贴到临时文档后双击 ⇧ 捕获");
          },
          (error) => tip("warn", `复制演练示例失败：${error}`)
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
      onPause={() => transition({ type: "pause" })}
      onResume={() => transition({ type: "resume" })}
      onDefer={() => {
        transition({ type: "defer" });
        tip("info", "已跳过演练，可随时在「设置 → 关于」重新运行");
      }}
      onOpenAccessibility={() =>
        void api.openPrivacySettings("accessibility")}
      onOpenInputMonitoring={() =>
        void api.openPrivacySettings("input-monitoring")}
      onResetInputMonitoring={() => void resetInputMonitoringAndReopen()}
    />
  );
}
