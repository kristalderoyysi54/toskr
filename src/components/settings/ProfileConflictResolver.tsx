import { AlertTriangle } from "lucide-react";
import { useMemo } from "react";

import { AppIcon } from "@/components/settings/AppIdentity";
import { useAppIdentity } from "@/components/settings/useAppIdentity";
import {
  findDuplicateBundleAssignments,
  keepTargetProfileBundleAssignment,
  type TargetProfile,
} from "@/lib/targetProfiles";

function focusAfterConflictResolution(profileId: string) {
  requestAnimationFrame(() => {
    const nextConflict = document.querySelector<HTMLButtonElement>(
      "[data-profile-conflict-action]"
    );
    if (nextConflict) {
      nextConflict.focus();
      return;
    }
    const profileOption = Array.from(
      document.querySelectorAll<HTMLButtonElement>("[data-profile-select]")
    ).find((option) => option.dataset.profileSelect === profileId);
    if (profileOption) {
      profileOption.focus();
      return;
    }
    const firstVisibleProfile = document.querySelector<HTMLButtonElement>(
      "[data-profile-select]"
    );
    if (firstVisibleProfile) {
      firstVisibleProfile.focus();
      return;
    }
    document.querySelector<HTMLElement>("[data-profile-list-focus-fallback]")?.focus();
  });
}

function ConflictRow({
  bundleId,
  profileIds,
  profileNames,
  profiles,
  onResolve,
}: {
  bundleId: string;
  profileIds: string[];
  profileNames: string[];
  profiles: TargetProfile[];
  onResolve: (profiles: TargetProfile[]) => void;
}) {
  const info = useAppIdentity(bundleId);
  const name = info?.name || bundleId;
  return (
    <div className="rounded-lg border border-warning/35 bg-warning/10 p-2">
      <div className="flex min-w-0 items-center gap-2">
        <AppIcon bundleId={bundleId} appName={name} size="xs" />
        <p className="min-w-0 flex-1 text-body">
          <span className="font-medium">{name}</span>
          <span className="text-muted-foreground"> 同时属于 {profileNames.join("、")}</span>
        </p>
      </div>
      <p className="mt-1 text-label text-warning">
        当前保持原有稳定命中结果；请选择唯一保留方案后才会修复。
      </p>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {profileIds.map((profileId, index) => (
           <button
             key={profileId}
             type="button"
             data-profile-conflict-action
             onClick={() => {
               onResolve(
                 keepTargetProfileBundleAssignment(profiles, bundleId, profileId)
               );
               focusAfterConflictResolution(profileId);
             }}
            className="rounded-md border border-warning/40 px-2 py-1 text-label font-medium text-warning outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          >
            保留在 {profileNames[index]}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ProfileConflictResolver({
  profiles,
  onResolve,
}: {
  profiles: TargetProfile[];
  onResolve: (profiles: TargetProfile[]) => void;
}) {
  const duplicates = useMemo(
    () => findDuplicateBundleAssignments(profiles),
    [profiles]
  );
  if (duplicates.length === 0) return null;

  return (
    <section aria-labelledby="profile-conflicts-title" className="mb-3 space-y-1.5">
      <h3 id="profile-conflicts-title" className="flex items-center gap-1 text-label font-semibold text-warning">
        <AlertTriangle aria-hidden className="size-3.5" /> 历史绑定冲突
      </h3>
      {duplicates.map((duplicate) => (
        <ConflictRow
          key={duplicate.bundleId}
          {...duplicate}
          profiles={profiles}
          onResolve={onResolve}
        />
      ))}
    </section>
  );
}
