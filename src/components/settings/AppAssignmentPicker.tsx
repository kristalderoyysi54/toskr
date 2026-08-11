import { FolderOpen, History, Link2, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { AppIcon } from "@/components/settings/AppIdentity";
import { useAppIdentity } from "@/components/settings/useAppIdentity";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import {
  buildAppMoveQuestion,
} from "@/lib/profileManager";
import { api, type TargetSnapshot } from "@/lib/tauri";
import {
  assignTargetProfileBundle,
  updateTargetProfileBundleIds,
  type TargetProfile,
} from "@/lib/targetProfiles";

interface RecentApp {
  bundleId: string;
  appName: string;
}

function BoundAppRow({
  bundleId,
  onRemove,
}: {
  bundleId: string;
  onRemove: () => void;
}) {
  const info = useAppIdentity(bundleId);
  const name = info?.name || bundleId;
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-lg bg-muted/35 px-2 py-1.5">
      <AppIcon bundleId={bundleId} appName={name} size="xs" />
      <span className="min-w-0 flex-1 truncate text-body" title={`${name} · ${bundleId}`}>
        {name}
      </span>
      <IconButton label={`从当前投递方案移除 ${name}`} tone="danger" size="xs" onClick={onRemove}>
        <X />
      </IconButton>
    </div>
  );
}

export function AppAssignmentPicker({
  profile,
  profiles,
  currentTarget,
  recentApps,
  onProfilesChange,
}: {
  profile: TargetProfile;
  profiles: TargetProfile[];
  currentTarget: TargetSnapshot | null;
  recentApps: RecentApp[];
  onProfilesChange: (profiles: TargetProfile[]) => void;
}) {
  const [pendingMove, setPendingMove] = useState<{
    profileId: string;
    bundleId: string;
    appName: string;
    sourceNames: string;
  } | null>(null);
  const activeProfileId = useRef(profile.id);
  const latestProfiles = useRef(profiles);
  const requestSequence = useRef(0);
  activeProfileId.current = profile.id;
  latestProfiles.current = profiles;

  useEffect(() => {
    activeProfileId.current = profile.id;
    requestSequence.current += 1;
    setPendingMove(null);
  }, [profile.id]);

  const requestAssignment = async (bundleId: string, fallbackName?: string | null) => {
    const requestProfileId = profile.id;
    if (!bundleId || activeProfileId.current !== requestProfileId) return;
    const requestId = ++requestSequence.current;
    setPendingMove(null);
    let liveProfiles = latestProfiles.current;
    let liveProfile = liveProfiles.find((item) => item.id === requestProfileId);
    if (!liveProfile || liveProfile.bundleIds.includes(bundleId)) return;
    let owners = liveProfiles.filter(
      (item) => item.id !== requestProfileId && item.bundleIds.includes(bundleId)
    );
    if (owners.length === 0) {
      const updated = updateTargetProfileBundleIds(
        liveProfiles,
        requestProfileId,
        [...liveProfile.bundleIds, bundleId]
      );
      latestProfiles.current = updated.profiles;
      onProfilesChange(updated.profiles);
      return;
    }
    const info = await api.appListInfo(bundleId).catch(() => null);
    if (
      activeProfileId.current !== requestProfileId ||
      requestSequence.current !== requestId
    ) {
      return;
    }
    liveProfiles = latestProfiles.current;
    liveProfile = liveProfiles.find((item) => item.id === requestProfileId);
    if (!liveProfile || liveProfile.bundleIds.includes(bundleId)) return;
    owners = liveProfiles.filter(
      (item) => item.id !== requestProfileId && item.bundleIds.includes(bundleId)
    );
    if (owners.length === 0) {
      const updated = updateTargetProfileBundleIds(
        liveProfiles,
        requestProfileId,
        [...liveProfile.bundleIds, bundleId]
      );
      latestProfiles.current = updated.profiles;
      onProfilesChange(updated.profiles);
      return;
    }
    const appName = info?.name || fallbackName || bundleId;
    setPendingMove({
      profileId: requestProfileId,
      bundleId,
      appName,
      sourceNames: owners.map((item) => item.name).join("、"),
    });
  };

  const pickInstalledApp = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        multiple: false,
        defaultPath: "/Applications",
        filters: [{ name: "应用程序", extensions: ["app"] }],
      });
      if (typeof picked !== "string") return;
      const bundleId = await api.bundleIdOfApp(picked);
      if (bundleId) await requestAssignment(bundleId);
    } catch {
      // 用户取消或原生选择器不可用时保持现状。
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          disabled={!currentTarget?.ready || !currentTarget.bundleId}
          onClick={() => {
            if (currentTarget?.ready && currentTarget.bundleId) {
              void requestAssignment(currentTarget.bundleId, currentTarget.appName);
            }
          }}
          className="inline-flex h-8 items-center gap-1 rounded-lg border border-border px-2 text-body outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-primary/50 disabled:opacity-40 dark:hover:bg-white/10"
        >
          <Plus aria-hidden className="size-3.5" /> 添加当前目标应用
        </button>
        <button
          type="button"
          onClick={() => void pickInstalledApp()}
          className="inline-flex h-8 items-center gap-1 rounded-lg border border-border px-2 text-body outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-primary/50 dark:hover:bg-white/10"
        >
          <FolderOpen aria-hidden className="size-3.5" /> 选择应用…
        </button>
      </div>

      {pendingMove?.profileId === profile.id && (
        <div role="alert" aria-label="移动应用确认" className="rounded-lg border border-warning/40 bg-warning/10 p-2">
          <p className="text-body text-foreground">
            {buildAppMoveQuestion(pendingMove.appName, pendingMove.sourceNames, profile.name)}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Button
              type="button"
              onClick={() => {
                const assigned = assignTargetProfileBundle(
                  latestProfiles.current,
                  pendingMove.bundleId,
                  profile.id
                );
                latestProfiles.current = assigned;
                onProfilesChange(assigned);
                setPendingMove(null);
              }}
              size="sm"
            >
              <Link2 aria-hidden className="size-3" /> 确认移动
            </Button>
            <button
              type="button"
              onClick={() => setPendingMove(null)}
              className="h-7 rounded-md border border-border px-2 text-label outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
            >
              取消
            </button>
          </div>
        </div>
      )}

      <div>
        <p className="mb-1 text-micro font-medium text-muted-foreground">已绑定应用</p>
        <div className="space-y-1" aria-label={`${profile.name} 已绑定应用`}>
          {profile.bundleIds.map((bundleId) => (
            <BoundAppRow
              key={bundleId}
              bundleId={bundleId}
              onRemove={() => {
                const currentBundleIds = latestProfiles.current.find(
                  (item) => item.id === profile.id
                )?.bundleIds ?? [];
                const updated = updateTargetProfileBundleIds(
                  latestProfiles.current,
                  profile.id,
                  currentBundleIds.filter((item) => item !== bundleId)
                );
                latestProfiles.current = updated.profiles;
                onProfilesChange(updated.profiles);
              }}
            />
          ))}
          {profile.bundleIds.length === 0 && (
            <p className="rounded-lg bg-muted/35 px-2 py-2 text-body text-muted-foreground">
              尚未绑定应用；未命中时仍按默认方案解析。
            </p>
          )}
        </div>
      </div>

      <div>
        <p className="mb-1 flex items-center gap-1 text-micro font-medium text-muted-foreground">
          <History aria-hidden className="size-3" /> 最近出现的应用
        </p>
        <div className="flex flex-wrap gap-1" aria-label="最近出现的应用">
          {recentApps.map((app) => (
            <button
              key={app.bundleId}
              type="button"
              disabled={profile.bundleIds.includes(app.bundleId)}
              onClick={() => void requestAssignment(app.bundleId, app.appName)}
              aria-label={`将 ${app.appName} 添加到 ${profile.name}`}
              className="inline-flex max-w-full items-center gap-1 rounded-md border border-border px-1.5 py-1 text-label outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-primary/50 disabled:opacity-40 dark:hover:bg-white/10"
            >
              <AppIcon bundleId={app.bundleId} appName={app.appName} size="xs" />
              <span className="max-w-36 truncate">{app.appName}</span>
            </button>
          ))}
          {recentApps.length === 0 && (
            <span className="text-label text-muted-foreground">本次设置会话尚无记录</span>
          )}
        </div>
      </div>
    </div>
  );
}
