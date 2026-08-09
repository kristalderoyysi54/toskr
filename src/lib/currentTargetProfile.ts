import {
  resolveTargetProfile,
  type TargetProfileResolution,
} from "@/lib/targetProfiles";
import { useNotesStore } from "@/store/notesStore";
import { useTargetStore } from "@/store/targetStore";

/** 当前 UI 与发送链共用的解析入口，避免 Lens/菜单/执行器各自猜策略。 */
export function currentTargetProfileResolution(): TargetProfileResolution {
  const settings = useNotesStore.getState().settings;
  const target = useTargetStore.getState();
  return resolveTargetProfile({
    bundleId: target.snapshot?.bundleId,
    groups: settings.promptGroups,
    profiles: settings.targetProfiles,
    defaultProfileId: settings.defaultTargetProfileId,
    temporaryProfileId: target.profileOverrideId,
  });
}
