import { DELIVERY_FORMAT_LABEL, ENTER_POLICY_STATUS_LABEL } from "@/lib/targetLens";
import { cn } from "@/lib/utils";
import type { TargetProfile } from "@/lib/targetProfiles";

export function DeliveryPolicySummary({
  profile,
  promptGroupName,
  privacyCapabilityActive = false,
  className,
}: {
  profile: TargetProfile;
  promptGroupName: string;
  privacyCapabilityActive?: boolean;
  className?: string;
}) {
  const rules = [
    { label: `提示词组：${promptGroupName}`, warning: false },
    { label: `输出格式：${DELIVERY_FORMAT_LABEL[profile.defaultFormat]}`, warning: false },
    {
      label: `粘贴后动作：${ENTER_POLICY_STATUS_LABEL[profile.enterPolicy]}`,
      warning: profile.enterPolicy === "allow",
    },
    {
      label: profile.keepPanel ? "发送完成后：保持打开" : "发送完成后：关闭面板",
      warning: false,
    },
  ];

  return (
    <div className={cn("flex min-w-0 flex-wrap gap-1", className)} aria-label="当前生效规则摘要">
      {rules.map((rule) => (
        <span
          key={rule.label}
          className={cn(
            "line-clamp-2 max-w-full break-words rounded-sm px-1.5 py-0.5 text-micro leading-tight",
            rule.warning
              ? "bg-warning/10 text-warning"
              : "bg-muted/60 text-muted-foreground"
          )}
        >
          {rule.label}
        </span>
      ))}
      <span
        className={cn(
          "line-clamp-2 max-w-full break-words rounded-sm px-1.5 py-0.5 text-micro leading-tight",
          privacyCapabilityActive
            ? "bg-muted/60 text-muted-foreground"
            : "bg-warning/10 text-warning"
        )}
      >
        {privacyCapabilityActive ? "隐私检查：已启用" : "隐私检查：尚未启用"}
      </span>
    </div>
  );
}
