import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CurrentTargetPreview } from "@/components/settings/CurrentTargetPreview";
import { Disclosure } from "@/components/ui/disclosure";
import { ProfileConflictResolver } from "@/components/settings/ProfileConflictResolver";
import { ProfileCreateSheet } from "@/components/settings/ProfileCreateSheet";
import { ProfileEditor } from "@/components/settings/ProfileEditor";
import { ProfileList } from "@/components/settings/ProfileList";
import { api, TARGET_CHANGED_EVENT, type TargetSnapshot } from "@/lib/tauri";
import {
  reorderProfilesKeepingDefault,
  profileSelectionAfterDelete,
  settingsTargetAfterObservation,
} from "@/lib/profileManager";
import {
  assignTargetProfileBundle,
  deleteTargetProfile,
  resolveTargetProfile,
  type TargetProfile,
} from "@/lib/targetProfiles";
import type { Settings } from "@/store/notesStore";

const TOSKR_BUNDLE_ID = "com.toskr.app";

export function TargetProfileManager({
  settings,
  patch,
  requestedProfileId = null,
  requestSequence = 0,
}: {
  settings: Settings;
  patch: (patch: Partial<Settings>) => void;
  requestedProfileId?: string | null;
  requestSequence?: number;
}) {
  const [selectedProfileId, setSelectedProfileId] = useState(
    settings.defaultTargetProfileId
  );
  const [currentTarget, setCurrentTarget] = useState<TargetSnapshot | null>(null);
  const [recentApps, setRecentApps] = useState<
    { bundleId: string; appName: string }[]
  >([]);
  const [refreshing, setRefreshing] = useState(false);
  const [testMessage, setTestMessage] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const selectionTouched = useRef(false);
  const createReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const latestTargetRevision = useRef(-1);
  const handledRequestSequence = useRef(0);

  const acceptTarget = useCallback((snapshot: TargetSnapshot) => {
    if (snapshot.revision < latestTargetRevision.current) return;
    latestTargetRevision.current = snapshot.revision;
    setCurrentTarget((previous) => settingsTargetAfterObservation(previous, snapshot));
    if (snapshot.bundleId && snapshot.bundleId !== TOSKR_BUNDLE_ID) {
      const bundleId = snapshot.bundleId;
      setRecentApps((previous) => [
        {
          bundleId,
          appName: snapshot.appName || bundleId,
        },
        ...previous.filter((item) => item.bundleId !== bundleId),
      ].slice(0, 8));
    }
    setTestMessage(null);
  }, []);

  useEffect(() => {
    let alive = true;
    void api.getTargetSnapshot().then((snapshot) => {
      if (alive) acceptTarget(snapshot);
    }).catch(() => {});
    const unlisten = listen<TargetSnapshot>(TARGET_CHANGED_EVENT, (event) => {
      if (alive) acceptTarget(event.payload);
    });
    return () => {
      alive = false;
      void unlisten.then((fn) => fn()).catch(() => {});
    };
  }, [acceptTarget]);

  const currentResolution = useMemo(
    () =>
      resolveTargetProfile({
        bundleId: currentTarget?.bundleId ?? null,
        isTargetReady: Boolean(currentTarget?.ready),
        groups: settings.promptGroups,
        profiles: settings.targetProfiles,
        defaultProfileId: settings.defaultTargetProfileId,
        privacyCapabilityActive: settings.firewallEnabled,
      }),
    [
      currentTarget?.bundleId,
      currentTarget?.ready,
      settings.defaultTargetProfileId,
      settings.firewallEnabled,
      settings.promptGroups,
      settings.targetProfiles,
    ]
  );

  useEffect(() => {
    const selectedStillExists = settings.targetProfiles.some(
      (profile) => profile.id === selectedProfileId
    );
    if (!selectedStillExists) {
      setSelectedProfileId(currentResolution.profileId);
      selectionTouched.current = false;
    } else if (!selectionTouched.current) {
      setSelectedProfileId(currentResolution.profileId);
    }
  }, [currentResolution.profileId, selectedProfileId, settings.targetProfiles]);

  // 方案管理默认折叠（回答「现在会发生什么」的当前目标卡常驻即可）；
  // 深链首帧直接展开，避免先收起再展开的闪动
  const [managementOpen, setManagementOpen] = useState(
    () => Boolean(requestedProfileId) && requestSequence > 0
  );
  const [scrollRequestId, setScrollRequestId] = useState(0);
  const openManagementAndScroll = () => {
    setManagementOpen(true);
    setScrollRequestId((n) => n + 1);
  };
  useEffect(() => {
    if (scrollRequestId === 0) return;
    scrollSettingsElementIntoView("target-profile-management");
  }, [scrollRequestId]);

  useEffect(() => {
    if (
      requestSequence <= handledRequestSequence.current ||
      !requestedProfileId ||
      !settings.targetProfiles.some((profile) => profile.id === requestedProfileId)
    ) {
      return;
    }
    handledRequestSequence.current = requestSequence;
    selectionTouched.current = true;
    setSelectedProfileId(requestedProfileId);
    openManagementAndScroll();
  }, [requestSequence, requestedProfileId, settings.targetProfiles]);

  const selectedProfile =
    settings.targetProfiles.find((profile) => profile.id === selectedProfileId) ??
    settings.targetProfiles.find((profile) => profile.id === settings.defaultTargetProfileId) ??
    settings.targetProfiles[0];

  const updateSelectedProfile = (
    profilePatch: Partial<Omit<TargetProfile, "id" | "bundleIds">>
  ) => {
    if (!selectedProfile) return;
    patch({
      targetProfiles: settings.targetProfiles.map((profile) =>
        profile.id === selectedProfile.id ? { ...profile, ...profilePatch } : profile
      ),
    });
  };

  const moveProfile = (profileId: string, direction: -1 | 1) => {
    const next = reorderProfilesKeepingDefault(
      settings.targetProfiles,
      settings.defaultTargetProfileId,
      profileId,
      direction
    );
    if (next === settings.targetProfiles) return;
    patch({ targetProfiles: next });
  };

  const removeProfile = (profileId: string, nextVisibleProfileId: string | null) => {
    const next = deleteTargetProfile(
      {
        groups: settings.promptGroups,
        snippets: settings.promptSnippets,
        profiles: settings.targetProfiles,
        defaultProfileId: settings.defaultTargetProfileId,
      },
      profileId
    );
    patch({
      targetProfiles: next.profiles,
      defaultTargetProfileId: next.defaultProfileId,
    });
    if (profileId === selectedProfileId) {
      selectionTouched.current = true;
      setSelectedProfileId(profileSelectionAfterDelete({
        profiles: next.profiles,
        defaultProfileId: next.defaultProfileId,
        deletedProfileId: profileId,
        selectedProfileId,
        nextVisibleProfileId,
      }));
    }
  };

  const refreshCurrentTarget = async () => {
    if (refreshing) return;
    const revisionAtStart = latestTargetRevision.current;
    setRefreshing(true);
    setTestMessage(null);
    try {
      acceptTarget(await api.refreshTargetSnapshot());
    } catch {
      if (latestTargetRevision.current === revisionAtStart) {
        setTestMessage("刷新目标失败，请切回目标应用后重试。");
      }
    } finally {
      setRefreshing(false);
    }
  };

  const testCurrentTarget = () => {
    const availability = !currentTarget?.bundleId
      ? "尚未识别，发送已锁定"
      : currentResolution.isTargetReady
        ? "可发送"
        : "目标已失效，发送已锁定";
    setTestMessage(
      `解析完成：${currentResolution.profile.name} · ${availability}。未访问剪贴板，未模拟粘贴或回车。`
    );
  };

  const editCurrentlyResolvedProfile = () => {
    selectionTouched.current = true;
    setSelectedProfileId(currentResolution.profileId);
    openManagementAndScroll();
  };

  return (
    <div className="mb-5 min-w-0">
      <CurrentTargetPreview
        snapshot={currentTarget}
        resolution={currentResolution}
        refreshing={refreshing}
        testMessage={testMessage}
        onRefresh={() => void refreshCurrentTarget()}
        onTest={testCurrentTarget}
        onEditProfile={editCurrentlyResolvedProfile}
      />

      <ProfileConflictResolver
        profiles={settings.targetProfiles}
        onResolve={(targetProfiles) => {
          patch({ targetProfiles });
          // 修复后的焦点兜底目标在管理区里，须同步展开（不能异步，
          // 保证 requestAnimationFrame 前 ProfileList 已在 DOM）
          openManagementAndScroll();
        }}
      />

      <Disclosure
        title="发送方案管理"
        id="target-profile-management"
        open={managementOpen}
        onOpenChange={setManagementOpen}
      >
      <div className="grid min-w-0 gap-3 lg:grid-cols-3">
        <ProfileList
          profiles={settings.targetProfiles}
          groups={settings.promptGroups}
          defaultProfileId={settings.defaultTargetProfileId}
          selectedProfileId={selectedProfile?.id ?? ""}
          currentProfileId={currentResolution.profileId}
          onSelect={(profileId) => {
            selectionTouched.current = true;
            setSelectedProfileId(profileId);
          }}
          onCreate={(trigger) => {
            createReturnFocusRef.current = trigger;
            setCreateOpen(true);
          }}
          onMove={moveProfile}
          onDelete={removeProfile}
        />

        {selectedProfile && (
          <div className="min-w-0 lg:col-span-2">
            <ProfileEditor
              profile={selectedProfile}
              profiles={settings.targetProfiles}
              groups={settings.promptGroups}
              snippets={settings.promptSnippets}
              defaultProfileId={settings.defaultTargetProfileId}
              firewallEnabled={settings.firewallEnabled}
              currentTarget={currentTarget}
              recentApps={recentApps}
              onUpdate={updateSelectedProfile}
              onProfilesChange={(targetProfiles) => patch({ targetProfiles })}
              onSetDefault={() =>
                patch({ defaultTargetProfileId: selectedProfile.id })
              }
            />
          </div>
        )}
      </div>

      <ProfileCreateSheet
        open={createOpen}
        returnFocusRef={createReturnFocusRef}
        currentTarget={currentTarget}
        profiles={settings.targetProfiles}
        promptGroupId={settings.promptGroups[0]?.id ?? "general"}
        onOpenChange={setCreateOpen}
        onCreate={(profile, moveCurrentBundle) => {
          let next = [...settings.targetProfiles, profile];
          const includedBundleId = profile.bundleIds[0];
          if (moveCurrentBundle && includedBundleId) {
            next = assignTargetProfileBundle(next, includedBundleId, profile.id);
          }
          patch({ targetProfiles: next });
          selectionTouched.current = true;
          setSelectedProfileId(profile.id);
        }}
      />
      </Disclosure>
    </div>
  );
}

/** 只滚动设置页 main 容器（scrollTo 自带钳制）；不能用 scrollIntoView：
 *  它会连带程序化滚动 overflow:hidden 的 body，把整页顶出可视区露出窗口底色。 */
function scrollSettingsElementIntoView(elementId: string) {
  const target = document.getElementById(elementId);
  const container = target?.closest("main");
  if (!target || !container) return;
  const top =
    container.scrollTop +
    target.getBoundingClientRect().top -
    container.getBoundingClientRect().top -
    12;
  container.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
}
