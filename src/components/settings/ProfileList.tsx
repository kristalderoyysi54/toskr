import { ArrowDown, ArrowUp, MoreHorizontal, Plus, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { AppIcon } from "@/components/settings/AppIdentity";
import { SimpleMenu, SimpleMenuItem, SimpleMenuSeparator } from "@/components/SimpleMenu";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { DELIVERY_FORMAT_LABEL, ENTER_POLICY_STATUS_LABEL } from "@/lib/targetLens";
import {
  filterAndPinProfiles,
  profileFocusAfterDeleteId,
  profileListKeyboardIndex,
  profileReorderAvailability,
  shouldShowProfileSearch,
} from "@/lib/profileManager";
import {
  targetProfileOutputMode,
  type PromptGroup,
  type TargetProfile,
} from "@/lib/targetProfiles";
import { cn } from "@/lib/utils";

export function ProfileList({
  profiles,
  groups,
  defaultProfileId,
  selectedProfileId,
  currentProfileId,
  onSelect,
  onCreate,
  onMove,
  onDelete,
}: {
  profiles: TargetProfile[];
  groups: PromptGroup[];
  defaultProfileId: string;
  selectedProfileId: string;
  currentProfileId: string;
  onSelect: (profileId: string) => void;
  onCreate: (trigger: HTMLButtonElement) => void;
  onMove: (profileId: string, direction: -1 | 1) => void;
  onDelete: (profileId: string, nextVisibleProfileId: string | null) => void;
}) {
  const [query, setQuery] = useState("");
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());
  const searchVisible = shouldShowProfileSearch(profiles);
  const visibleProfiles = useMemo(
    () => filterAndPinProfiles(profiles, defaultProfileId, searchVisible ? query : ""),
    [defaultProfileId, profiles, query, searchVisible]
  );
  const groupNames = useMemo(
    () => new Map(groups.map((group) => [group.id, group.name])),
    [groups]
  );
  const reorderAvailability = useMemo(
    () => new Map(
      profileReorderAvailability(profiles, defaultProfileId).map((item) => [item.id, item])
    ),
    [defaultProfileId, profiles]
  );

  useEffect(() => {
    if (!searchVisible) setQuery("");
  }, [searchVisible]);

  const moveFocus = (currentId: string, delta: -1 | 1) => {
    const index = visibleProfiles.findIndex((profile) => profile.id === currentId);
    if (index < 0) return;
    const nextIndex = profileListKeyboardIndex(
      delta === 1 ? "ArrowDown" : "ArrowUp",
      index,
      visibleProfiles.length
    );
    const next = nextIndex === null ? undefined : visibleProfiles[nextIndex];
    if (!next) return;
    onSelect(next.id);
    optionRefs.current.get(next.id)?.focus();
  };

  return (
    <section
      aria-labelledby="profile-list-title"
      data-profile-list-focus-fallback
      tabIndex={-1}
      className="min-w-0 outline-none"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <div>
          <h3 id="profile-list-title" className="text-title font-semibold">发送方案</h3>
          <p className="text-micro text-muted-foreground">未识别应用的默认方案固定在顶部</p>
        </div>
        <Button
          type="button"
          onClick={(event) => onCreate(event.currentTarget)}
          className="shrink-0"
        >
          <Plus aria-hidden className="size-3.5" />
          新建
        </Button>
      </div>

      {searchVisible && (
        <label className="relative mb-2 block">
          <span className="sr-only">搜索发送方案</span>
          <Search aria-hidden className="pointer-events-none absolute left-2 top-2 size-3.5 text-muted-foreground" />
          <input
            type="search"
            aria-label="搜索发送方案"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索方案或应用"
            className="h-8 w-full rounded-lg border border-border bg-transparent pl-7 pr-2 text-body outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          />
        </label>
      )}

      <ul aria-label="发送方案列表" className="space-y-1">
        {visibleProfiles.map((profile) => {
          const selected = profile.id === selectedProfileId;
          const isDefault = profile.id === defaultProfileId;
          const inUse = profile.id === currentProfileId;
          const canMoveUp = reorderAvailability.get(profile.id)?.up ?? false;
          const canMoveDown = reorderAvailability.get(profile.id)?.down ?? false;
          const visibleApps = profile.bundleIds.slice(0, 3);
          return (
            <li
              key={profile.id}
              className={cn(
                "group flex min-w-0 items-start gap-1 rounded-xl border p-1 transition-colors duration-100 motion-reduce:transition-none",
                selected
                  ? "border-primary/50 bg-primary/10"
                  : "border-border/60 bg-card"
              )}
            >
              <button
                ref={(node) => {
                  if (node) optionRefs.current.set(profile.id, node);
                  else optionRefs.current.delete(profile.id);
                }}
                type="button"
                aria-current={selected ? "true" : undefined}
                aria-label={`${profile.name}${isDefault ? "，未识别应用的默认方案" : ""}${inUse ? "，当前目标正在使用" : ""}`}
                data-profile-select={profile.id}
                onClick={() => onSelect(profile.id)}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                  event.preventDefault();
                  moveFocus(profile.id, event.key === "ArrowDown" ? 1 : -1);
                }}
                className="min-w-0 flex-1 rounded-lg px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
              >
                <span className="flex min-w-0 items-start gap-1.5">
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-2 break-words text-body font-semibold" title={profile.name}>
                      {profile.name}
                    </span>
                    <span className="mt-0.5 flex flex-wrap gap-1">
                      {isDefault && (
                        <span className="rounded-sm bg-muted px-1 py-0.5 text-micro text-muted-foreground">
                          未识别应用的默认方案
                        </span>
                      )}
                      {inUse && (
                        <span className="rounded-sm bg-primary/10 px-1 py-0.5 text-micro text-primary">
                          当前目标使用
                        </span>
                      )}
                    </span>
                  </span>
                  <span className="flex shrink-0 -space-x-1" aria-label={`已绑定 ${profile.bundleIds.length} 个应用`}>
                    {visibleApps.map((bundleId) => (
                      <AppIcon key={bundleId} bundleId={bundleId} size="xs" className="ring-1 ring-background" />
                    ))}
                    {profile.bundleIds.length > 3 && (
                      <span className="flex size-4 items-center justify-center rounded-md bg-muted text-micro text-muted-foreground ring-1 ring-background">
                        +{profile.bundleIds.length - 3}
                      </span>
                    )}
                  </span>
                </span>
                <span
                  className={cn(
                    "mt-1 line-clamp-2 block break-words text-micro leading-tight",
                    profile.enterPolicy === "allow" ? "text-warning" : "text-muted-foreground"
                  )}
                >
                  {groupNames.get(profile.promptGroupId) ?? "通用"} · {DELIVERY_FORMAT_LABEL[targetProfileOutputMode(profile)]} · {ENTER_POLICY_STATUS_LABEL[profile.enterPolicy]}
                </span>
              </button>

              <SimpleMenu
                trigger={({ open, toggle, controls }) => (
                  <IconButton
                    label={`${profile.name} 更多操作${isDefault ? "，未识别应用的默认方案不可删除" : ""}`}
                    size="xs"
                    pressed={open}
                    aria-haspopup="menu"
                    aria-expanded={open}
                    aria-controls={controls}
                    onClick={toggle}
                  >
                    <MoreHorizontal />
                  </IconButton>
                )}
              >
                {(close) => (
                  <>
                    <SimpleMenuItem
                      disabled={!canMoveUp}
                      onClick={() => {
                        close();
                        onMove(profile.id, -1);
                      }}
                    >
                      <ArrowUp className="size-3.5" /> 上移
                    </SimpleMenuItem>
                    <SimpleMenuItem
                      disabled={!canMoveDown}
                      onClick={() => {
                        close();
                        onMove(profile.id, 1);
                      }}
                    >
                      <ArrowDown className="size-3.5" /> 下移
                    </SimpleMenuItem>
                    <SimpleMenuSeparator />
                    <SimpleMenuItem
                      destructive
                      disabled={isDefault}
                      title={isDefault ? "未识别应用的默认方案不能删除" : undefined}
                      onClick={() => {
                        const focusProfileId = profileFocusAfterDeleteId(
                          visibleProfiles,
                          profile.id
                        );
                        close();
                        onDelete(profile.id, focusProfileId);
                        requestAnimationFrame(() => {
                          if (focusProfileId) {
                            optionRefs.current.get(focusProfileId)?.focus();
                          }
                        });
                      }}
                    >
                      <Trash2 className="size-3.5" />
                      {isDefault ? "未识别应用的默认方案不可删除" : "删除方案"}
                    </SimpleMenuItem>
                  </>
                )}
              </SimpleMenu>
            </li>
          );
        })}
        {visibleProfiles.length === 0 && (
          <li className="rounded-xl border border-border/60 px-3 py-4 text-center text-body text-muted-foreground">
            没有匹配的发送方案
          </li>
        )}
      </ul>
    </section>
  );
}
