import { ApplicationIcon } from "@/components/ApplicationIcon";
import { useAppIdentity } from "@/components/settings/useAppIdentity";

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
  const info = useAppIdentity(bundleId, appName);
  const name = info?.name || appName || bundleId || "未识别目标";
  const sizeClass = size === "xs" ? "size-4" : size === "md" ? "size-8" : "size-6";

  return (
    <ApplicationIcon
      src={info?.iconUrl}
      name={name}
      className={`${sizeClass} rounded-md ${className ?? ""}`}
    />
  );
}
