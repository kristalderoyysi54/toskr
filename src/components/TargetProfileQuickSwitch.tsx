import { Check, Link2, RotateCcw, Settings2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { ApplicationIcon } from "@/components/ApplicationIcon";
import type { AppIconInfo } from "@/lib/icons";
import {
  DELIVERY_FORMAT_LABEL,
  ENTER_POLICY_STATUS_LABEL,
  quickSwitchKeyboardCommand,
  type QuickProfileOption,
} from "@/lib/targetLens";
import { cn } from "@/lib/utils";
import { targetStatusLabel, type TargetStatus } from "@/store/targetStore";

function ProfileSummary({ profile }: { profile: QuickProfileOption }) {
  return (
    <span
      className={cn(
        "line-clamp-2 min-w-0 break-words text-micro leading-tight",
        profile.enterPolicy === "allow" ? "text-warning" : "text-muted-foreground"
      )}
    >
      {profile.promptGroupName} · {DELIVERY_FORMAT_LABEL[profile.defaultFormat]} · {ENTER_POLICY_STATUS_LABEL[profile.enterPolicy]} · {profile.keepPanel ? "发送后保持打开" : "发送后关闭面板"}
    </span>
  );
}

export function TargetProfileQuickSwitch({
  appName,
  icon,
  status,
  matchReason,
  currentProfile,
  candidates,
  privacyCapabilityActive,
  temporaryProfileId,
  automaticProfileName,
  canMakePermanent,
  onSelectTemporary,
  onRestoreAutomatic,
  onMakePermanent,
  onEdit,
  onClose,
}: {
  appName: string;
  icon: AppIconInfo | null;
  status: TargetStatus;
  matchReason: string;
  currentProfile: QuickProfileOption;
  candidates: QuickProfileOption[];
  privacyCapabilityActive: boolean;
  temporaryProfileId: string | null;
  automaticProfileName: string;
  canMakePermanent: boolean;
  onSelectTemporary: (profileId: string) => void;
  onRestoreAutomatic: () => void;
  onMakePermanent: () => void;
  onEdit: () => void;
  onClose: () => void;
}) {
  const visibleCandidates = useMemo(() => candidates.slice(0, 3), [candidates]);
  const [activeProfileId, setActiveProfileId] = useState(currentProfile.id);
  const activeIndex = visibleCandidates.findIndex(
    (profile) => profile.id === activeProfileId
  );
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const candidateKey = visibleCandidates.map((profile) => profile.id).join("\u0000");
  const statusLabel = targetStatusLabel(status);
  const targetReady = status === "ready";
  const statusTone = targetReady
    ? "bg-success/10 text-success"
    : status === "blocked" || status === "unknown"
      ? "bg-destructive/10 text-destructive"
      : "bg-muted text-muted-foreground";
  const privacyLabel = privacyCapabilityActive
    ? "隐私检查：发送时执行"
    : "隐私检查：尚未启用";

  useEffect(() => {
    if (activeIndex >= 0) return;
    setActiveProfileId(
      visibleCandidates.some((profile) => profile.id === currentProfile.id)
        ? currentProfile.id
        : (visibleCandidates[0]?.id ?? "")
    );
  }, [activeIndex, candidateKey, currentProfile.id, visibleCandidates]);

  useEffect(() => {
    optionRefs.current[activeIndex]?.focus();
  }, [activeIndex, candidateKey]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const command = quickSwitchKeyboardCommand(
        event.key,
        activeIndex,
        visibleCandidates.length
      );
      if (!command) return;
      if (command.type === "select") {
        if (!targetReady) return;
        if (
          !(event.target as HTMLElement | null)?.closest?.(
            "[data-quick-profile-option]"
          )
        ) {
          return;
        }
      }
      event.preventDefault();
      event.stopPropagation();
      if (command.type === "close") {
        onClose();
      } else if (command.type === "move") {
        const profile = visibleCandidates[command.index];
        if (profile) setActiveProfileId(profile.id);
      } else {
        const profile = visibleCandidates[command.index];
        if (profile && profile.id !== currentProfile.id) {
          onSelectTemporary(profile.id);
        }
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [activeIndex, currentProfile.id, onClose, onSelectTemporary, targetReady, visibleCandidates]);

  return (
    <div className="flex min-w-0 flex-col gap-2" aria-label={`投递到 ${appName}`}>
      <header className="flex min-w-0 items-center gap-2">
        <ApplicationIcon
          src={icon?.url}
          name={appName}
          className="size-6 rounded-md"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-title font-medium" title={appName}>
            投递到 {appName}
          </p>
          <p className="line-clamp-2 break-words text-micro leading-tight text-muted-foreground">
            匹配来源：{matchReason}
          </p>
        </div>
        <span
          role="status"
          aria-live="off"
          aria-label={`目标状态：${statusLabel}`}
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-micro font-medium",
            statusTone
          )}
        >
          <span aria-hidden className="size-1.5 rounded-full bg-current" />
          {statusLabel}
        </span>
      </header>

      <section className="rounded-lg bg-muted/45 px-2 py-1.5" aria-label="当前投递方案">
        <p className="text-micro text-muted-foreground">当前投递方案</p>
        <p className="line-clamp-2 break-words text-body font-medium" title={currentProfile.name}>
          {currentProfile.name}
        </p>
        <ProfileSummary profile={currentProfile} />
      </section>

      <section aria-labelledby="quick-profile-options-label">
        <p id="quick-profile-options-label" className="mb-1 text-micro font-medium text-muted-foreground">
          快速选择 · ↑↓ 移动 · Enter 使用
        </p>
        <div role="listbox" aria-label="选择本次临时投递方案" className="space-y-0.5">
          {visibleCandidates.map((profile, index) => {
            const selected = profile.id === currentProfile.id;
            return (
              <button
                key={profile.id}
                ref={(node) => {
                  optionRefs.current[index] = node;
                }}
                type="button"
                role="option"
                aria-selected={selected}
                data-quick-profile-option={profile.id}
                tabIndex={index === activeIndex ? 0 : -1}
                disabled={!targetReady}
                onFocus={() => setActiveProfileId(profile.id)}
                onClick={() => {
                  if (!selected) onSelectTemporary(profile.id);
                }}
                className={cn(
                  "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none transition-colors duration-100 motion-reduce:transition-none",
                  "focus-visible:ring-2 focus-visible:ring-primary/50 disabled:opacity-40",
                  selected
                    ? "bg-primary/10 text-foreground"
                    : "hover:bg-black/5 dark:hover:bg-white/10"
                )}
              >
                <Check
                  aria-hidden
                  className={cn("size-3 shrink-0 text-primary", !selected && "invisible")}
                />
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 block break-words text-body font-medium">
                    {profile.name}
                  </span>
                  <ProfileSummary profile={profile} />
                </span>
              </button>
            );
          })}
          {visibleCandidates.length === 0 && (
            <p className="rounded-md bg-muted/40 px-2 py-1.5 text-body text-muted-foreground">
              暂无可切换方案
            </p>
          )}
        </div>
      </section>

      <section aria-label="本次真实生效规则" className="flex flex-wrap gap-1">
        <span className="line-clamp-2 max-w-full break-words rounded-sm bg-muted/60 px-1.5 py-0.5 text-micro text-muted-foreground">
          提示词组：{currentProfile.promptGroupName}
        </span>
        <span className="line-clamp-2 max-w-full break-words rounded-sm bg-muted/60 px-1.5 py-0.5 text-micro text-muted-foreground">
          输出格式：{DELIVERY_FORMAT_LABEL[currentProfile.defaultFormat]}
        </span>
        <span
          className={cn(
            "line-clamp-2 max-w-full break-words rounded-sm px-1.5 py-0.5 text-micro",
            currentProfile.enterPolicy === "allow"
              ? "bg-warning/10 text-warning"
              : "bg-muted/60 text-muted-foreground"
          )}
        >
          粘贴后动作：{ENTER_POLICY_STATUS_LABEL[currentProfile.enterPolicy]}
        </span>
        <span className="line-clamp-2 max-w-full break-words rounded-sm bg-muted/60 px-1.5 py-0.5 text-micro text-muted-foreground">
          发送完成后：{currentProfile.keepPanel ? "保持打开" : "关闭面板"}
        </span>
        <span
          className={cn(
            "line-clamp-2 max-w-full break-words rounded-sm px-1.5 py-0.5 text-micro",
            privacyCapabilityActive
              ? "bg-muted/60 text-muted-foreground"
              : "bg-warning/10 text-warning"
          )}
        >
          {privacyLabel}
        </span>
      </section>

      {temporaryProfileId && canMakePermanent && (
        <button
          type="button"
          onClick={() => {
            onMakePermanent();
            onClose();
          }}
          className="flex min-w-0 items-center gap-1.5 rounded-md border border-border px-2 py-1.5 text-left text-body outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-primary/50 dark:hover:bg-white/10"
        >
          <Link2 aria-hidden className="size-3.5 shrink-0" />
          <span className="line-clamp-2 break-words">
            以后发给 {appName} 都使用此方案
          </span>
        </button>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 pt-1.5">
        <button
          type="button"
          disabled={!temporaryProfileId}
          onClick={() => {
            onRestoreAutomatic();
            onClose();
          }}
          className="flex items-center gap-1 rounded-sm text-micro text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/50 disabled:opacity-40"
        >
          <RotateCcw aria-hidden className="size-3" />
          恢复自动匹配：{automaticProfileName}
        </button>
        <button
          type="button"
          onClick={() => {
            onClose();
            onEdit();
          }}
          className="ml-auto flex items-center gap-1 rounded-sm text-micro text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/50"
        >
          <Settings2 aria-hidden className="size-3" />
          编辑 {appName} 的投递方案
        </button>
      </div>
    </div>
  );
}
