import { ApplicationIcon } from "@/components/ApplicationIcon";
import { useAppIdentity } from "@/components/settings/useAppIdentity";
import { useT } from "@/lib/i18n";

export function AppIcon({
  bundleId,
  appName,
  size = "sm",
  className,
}: {
  bundleId: string | null;
  appName?: string | null;
  size?: "xs" | "sm" | "md";
  className?: string;
}) {
  const t = useT();
  const info = useAppIdentity(bundleId, appName);
  const name = info?.name || appName || bundleId || t("未识别目标");
  const sizeClass = size === "xs" ? "size-4" : size === "md" ? "size-8" : "size-6";

  return (
    <ApplicationIcon
      src={info?.iconUrl}
      name={name}
      className={`${sizeClass} rounded-md ${className ?? ""}`}
    />
  );
}
