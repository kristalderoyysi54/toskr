import { Check, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";

import { AppIcon } from "@/components/settings/AppIdentity";
import { Button } from "@/components/ui/button";
import { floatingSurface } from "@/components/ui/floating-surface";
import { IconButton } from "@/components/ui/icon-button";
import {
  PROFILE_PRESETS,
  buildAppMoveQuestion,
  createProfileFromPreset,
  type ProfilePresetId,
} from "@/lib/profileManager";
import type { TargetSnapshot } from "@/lib/tauri";
import type { TargetProfile } from "@/lib/targetProfiles";
import { cn } from "@/lib/utils";

export function ProfileCreateSheet({
  open,
  returnFocusRef,
  currentTarget,
  profiles,
  promptGroupId,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  returnFocusRef: React.RefObject<HTMLButtonElement | null>;
  currentTarget: TargetSnapshot | null;
  profiles: TargetProfile[];
  promptGroupId: string;
  onOpenChange: (open: boolean) => void;
  onCreate: (profile: TargetProfile, moveCurrentBundle: boolean) => void;
}) {
  const [presetId, setPresetId] = useState<ProfilePresetId>("safe");
  const [name, setName] = useState("稳妥发送");
  const [includeCurrent, setIncludeCurrent] = useState(false);
  const [confirmedMoveBundleId, setConfirmedMoveBundleId] = useState<string | null>(null);
  const currentBundleId = currentTarget?.ready ? currentTarget.bundleId : null;
  const currentAppName = currentTarget?.appName || currentBundleId || "当前目标";
  const owners = useMemo(
    () =>
      currentBundleId
        ? profiles.filter((profile) => profile.bundleIds.includes(currentBundleId))
        : [],
    [currentBundleId, profiles]
  );
  const sourceNames = owners.map((profile) => profile.name).join("、");
  const needsMoveConfirmation = includeCurrent && owners.length > 0;
  const moveConfirmed = Boolean(
    currentBundleId && confirmedMoveBundleId === currentBundleId
  );

  useEffect(() => {
    if (!open) return;
    setPresetId("safe");
    setName("稳妥发送");
    setIncludeCurrent(false);
    setConfirmedMoveBundleId(null);
  }, [open]);

  useEffect(() => {
    if (currentBundleId) {
      setConfirmedMoveBundleId(null);
      return;
    }
    setIncludeCurrent(false);
    setConfirmedMoveBundleId(null);
  }, [currentBundleId]);

  const choosePreset = (nextId: ProfilePresetId) => {
    const previous = PROFILE_PRESETS.find((item) => item.id === presetId);
    const next = PROFILE_PRESETS.find((item) => item.id === nextId);
    setPresetId(nextId);
    if (!name.trim() || name === previous?.name) setName(next?.name ?? "自定义");
    setConfirmedMoveBundleId(null);
  };

  const create = () => {
    if (!name.trim() || (needsMoveConfirmation && !moveConfirmed)) return;
    const profile = createProfileFromPreset({
      id: crypto.randomUUID(),
      presetId,
      name,
      promptGroupId,
      bundleId: includeCurrent ? currentBundleId : null,
    });
    onCreate(profile, needsMoveConfirmation);
    onOpenChange(false);
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-background/70 backdrop-blur-sm data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 duration-100 motion-reduce:!animate-none motion-reduce:!transition-none" />
        <DialogPrimitive.Content
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocusRef.current?.focus();
          }}
          className={cn(
            "fixed inset-y-0 right-0 z-50 flex w-full max-w-md origin-right flex-col border-l p-4 outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 motion-reduce:!animate-none motion-reduce:!transition-none",
            floatingSurface(3)
          )}
        >
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title className="text-heading font-semibold">
                新建发送方案
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="mt-1 text-body text-muted-foreground">
                推荐方案只填入初始值，创建后可在完整编辑器中继续调整。
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close asChild>
              <IconButton label="关闭新建发送方案" size="sm"><X /></IconButton>
            </DialogPrimitive.Close>
          </div>

          <div className="mt-4 min-h-0 flex-1 overflow-y-auto pr-1">
            <fieldset>
              <legend className="mb-1.5 text-label font-semibold text-muted-foreground">推荐初始方案</legend>
              <div className="grid grid-cols-2 gap-2">
                {PROFILE_PRESETS.map((preset) => {
                  const selected = preset.id === presetId;
                  return (
                    <label
                      key={preset.id}
                      className="min-w-0 cursor-pointer"
                    >
                      <input
                        type="radio"
                        name="profile-create-preset"
                        checked={selected}
                        onChange={() => choosePreset(preset.id)}
                        className="peer sr-only"
                      />
                      <span className={cn(
                        "block min-h-full rounded-xl border p-2 text-left outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-1 peer-focus-visible:ring-offset-background",
                        selected ? "border-primary/50 bg-primary/10" : "border-border bg-card"
                      )}>
                        <span className="flex items-center gap-1 text-body font-semibold">
                          <Check aria-hidden className={cn("size-3 text-primary", !selected && "invisible")} />
                          {preset.name}
                        </span>
                        <span className="mt-0.5 block text-micro leading-tight text-muted-foreground">
                          {preset.description}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>

            <label className="mt-4 block text-label font-medium text-muted-foreground">
              方案名称
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={80}
                className="mt-1 h-9 w-full rounded-lg border border-border bg-transparent px-2 text-body text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
              />
            </label>

            <label className={cn(
              "mt-3 flex items-center gap-2 rounded-xl border border-border p-2",
              !currentBundleId && "opacity-50"
            )}>
              <input
                type="checkbox"
                checked={includeCurrent}
                disabled={!currentBundleId}
                onChange={(event) => {
                  setIncludeCurrent(event.target.checked);
                  setConfirmedMoveBundleId(null);
                }}
                className="size-4 accent-primary"
              />
              <AppIcon bundleId={currentBundleId} appName={currentAppName} size="sm" />
              <span className="min-w-0">
                <span className="block text-body font-medium">添加当前目标应用</span>
                <span className="block truncate text-label text-muted-foreground" title={currentAppName}>
                  {currentBundleId ? currentAppName : "尚未识别目标"}
                </span>
              </span>
            </label>

            {needsMoveConfirmation && (
              <div role="alert" className="mt-2 rounded-lg border border-warning/40 bg-warning/10 p-2">
                <p className="text-body">
                  {buildAppMoveQuestion(currentAppName, sourceNames, name.trim() || "新方案")}
                </p>
                <button
                  type="button"
                  aria-pressed={moveConfirmed}
                  onClick={() => setConfirmedMoveBundleId(currentBundleId)}
                  className={cn(
                    "mt-2 rounded-md border px-2 py-1 text-label font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                    moveConfirmed
                      ? "border-primary/40 bg-primary/10 text-primary"
                      : "border-warning/40 text-warning"
                  )}
                >
                  {moveConfirmed ? "已确认移动" : "确认移动应用"}
                </button>
              </div>
            )}
          </div>

          <div className="mt-3 flex justify-end gap-2 border-t border-border pt-3">
            <DialogPrimitive.Close asChild>
              <button type="button" className="h-8 rounded-lg border border-border px-3 text-body outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background">
                取消
              </button>
            </DialogPrimitive.Close>
            <Button
              type="button"
              disabled={!name.trim() || (needsMoveConfirmation && !moveConfirmed)}
              onClick={create}
            >
              创建
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
