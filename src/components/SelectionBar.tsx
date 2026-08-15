import { CheckCheck, ChevronDown, Merge, Send, Tag, Trash2, X } from "lucide-react";
import { useMemo } from "react";

import { Button } from "@/components/ui/button";
import {
  SimpleMenu,
  SimpleMenuItem,
  SimpleMenuLabel,
  SimpleMenuSeparator,
} from "@/components/SimpleMenu";
import { IconButton } from "@/components/ui/icon-button";
import { Kbd } from "@/components/ui/kbd";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  deleteNotesWithUndo,
  mergeCheckedWithUndo,
  sendCheckedToChat,
} from "@/lib/actions";
import { currentDataGeneration } from "@/lib/dataGeneration";
import { buildDeliveryDraft } from "@/lib/delivery/buildDraft";
import { ENTER_POLICY_STATUS_LABEL } from "@/lib/targetLens";
import { cn } from "@/lib/utils";
import {
  promptSnippetsForGroup,
  resolveTargetProfile,
} from "@/lib/targetProfiles";
import {
  CLIPBOARD_ID,
  orderedCheckedNotes,
  sanitizeNoteTags,
  useNotesStore,
} from "@/store/notesStore";
import { useDeliveryStore, type PreflightMode } from "@/store/deliveryStore";
import { useUIStore } from "@/store/uiStore";
import {
  clearTargetProfileOverride,
  confirmTargetProfileOverride,
  setTargetProfileOverride,
  targetProfileIdentity,
  useTargetStore,
} from "@/store/targetStore";

/** 勾选 ≥1 条时出现的批量操作条。 */
export function SelectionBar({ compact = false }: { compact?: boolean }) {
  const checkedIds = useNotesStore((s) => s.checkedIds);
  const notes = useNotesStore((s) => s.notes);
  const settings = useNotesStore((s) => s.settings);
  const page = useUIStore((s) => s.page);
  const pinned = useUIStore((s) => s.pinned);
  const preflightMode = useDeliveryStore((s) => s.preflightMode);
  const targetStatus = useTargetStore((s) => s.status);
  const targetSnapshot = useTargetStore((s) => s.snapshot);
  const profileOverrideId = useTargetStore((s) => s.profileOverrideId);
  const profileOverrideTargetIdentity = useTargetStore(
    (s) => s.profileOverrideTargetIdentity
  );
  const profileOverrideNeedsConfirmation = useTargetStore(
    (s) => s.profileOverrideNeedsConfirmation
  );
  const targetIdentity = useMemo(
    () => targetProfileIdentity(targetSnapshot),
    [targetSnapshot]
  );
  const resolution = useMemo(
    () =>
      resolveTargetProfile({
        bundleId: targetSnapshot?.bundleId,
        isTargetReady: targetStatus === "ready",
        targetIdentity,
        groups: settings.promptGroups,
        profiles: settings.targetProfiles,
        defaultProfileId: settings.defaultTargetProfileId,
        temporaryProfileId: profileOverrideId,
        temporaryTargetIdentity: profileOverrideTargetIdentity,
        temporaryNeedsConfirmation: profileOverrideNeedsConfirmation,
        privacyCapabilityActive: settings.firewallEnabled,
      }),
    [
      profileOverrideId,
      profileOverrideTargetIdentity,
      profileOverrideNeedsConfirmation,
      settings.defaultTargetProfileId,
      settings.firewallEnabled,
      settings.promptGroups,
      settings.targetProfiles,
      targetIdentity,
      targetSnapshot?.bundleId,
      targetStatus,
    ]
  );
  const automaticResolution = useMemo(
    () =>
      resolveTargetProfile({
        bundleId: targetSnapshot?.bundleId,
        isTargetReady: targetStatus === "ready",
        targetIdentity,
        groups: settings.promptGroups,
        profiles: settings.targetProfiles,
        defaultProfileId: settings.defaultTargetProfileId,
        privacyCapabilityActive: settings.firewallEnabled,
      }),
    [
      settings.defaultTargetProfileId,
      settings.firewallEnabled,
      settings.promptGroups,
      settings.targetProfiles,
      targetIdentity,
      targetSnapshot?.bundleId,
      targetStatus,
    ]
  );
  const profileOverrideName = useMemo(
    () =>
      settings.targetProfiles.find((profile) => profile.id === profileOverrideId)
        ?.name ?? null,
    [profileOverrideId, settings.targetProfiles]
  );
  const nativeTargetReady = resolution.isTargetReady;
  const internalSendAvailable = page === "clipboard";
  const targetReady =
    internalSendAvailable ||
    (nativeTargetReady && !profileOverrideNeedsConfirmation);
  const snippetMenu = useMemo(
    () =>
      promptSnippetsForGroup(
        settings.promptSnippets,
        resolution.promptGroup.id
      ),
    [resolution.promptGroup.id, settings.promptSnippets]
  );
  const count = checkedIds.length;
  // 只在「当前页存在选中项」时显示：笔记页的选中切到剪贴板页不显示，
  // 切回笔记页恢复（反之亦然；跨域混选则两页都显示）
  const relevantHere = useMemo(
    () => {
      if (page === "tasks") return false;
      const checkedSet = new Set(checkedIds);
      return notes.some(
        (n) =>
          checkedSet.has(n.id) &&
          (n.sectionId === CLIPBOARD_ID) === (page === "clipboard")
      );
    },
    [checkedIds, notes, page]
  );
  const orderedSelection = useMemo(
    () => orderedCheckedNotes({ notes, checkedIds }),
    [checkedIds, notes]
  );
  const previewDraft = useMemo(
    () => {
      // 单选也出条（2026-08 曾试过「仅 ≥2 出现」，用户否决恢复）：
      // ⌄ 里的模板/格式/方案选择在单选同样高频，底栏是它们的恒定锚点，
      // 右键子菜单替代路径被用户评价为不便。勿再改成多选门槛。
      if (count === 0 || !relevantHere) return null;
      return buildDeliveryDraft(
        {
          id: "selection-preview",
          // UI 预览不可执行，不占用发送会话的全局 revision。
          revision: 0,
          createdAtMs: Date.now(),
          sourceKind: orderedSelection.length === 1 ? "note" : "note-batch",
          sourceItemIds: orderedSelection.map((note) => note.id),
        },
        {
          notes,
          tasks: [],
          promptSnippets: settings.promptSnippets,
          checkedItemIds: checkedIds,
          // Tooltip 只消费 finalText；不让原生刷新时间戳制造虚假的内容版本。
          targetSnapshot: null,
          profileResolution: resolution,
          panelPinned: pinned,
          dataGeneration: currentDataGeneration(),
          firewallEnabled: settings.firewallEnabled,
          firewallDisabledWarnCategories:
            settings.firewallDisabledWarnCategories,
          aliasEntitiesEnabled: settings.aliasEntitiesEnabled,
          aliasEntities: settings.aliasEntities,
        }
      );
    },
    [
      checkedIds,
      count,
      notes,
      orderedSelection,
      pinned,
      relevantHere,
      resolution,
      settings.aliasEntities,
      settings.aliasEntitiesEnabled,
      settings.firewallDisabledWarnCategories,
      settings.firewallEnabled,
      settings.promptSnippets,
    ]
  );
  // 全库标签目录（批量追加候选）；useMemo 派生，遵守选择器稳定引用红线。
  // 必须先于下面的条件 return——Hook 出现在 early return 之后会让渲染间
  // Hook 数量不一致，React 整树崩溃（主面板白屏）。
  const tagCatalog = useMemo(
    () => sanitizeNoteTags(notes.flatMap((n) => n.tags ?? [])) ?? [],
    [notes]
  );
  if (!previewDraft) return null;

  const state = useNotesStore.getState();
  const orderedIds = () => orderedCheckedNotes(useNotesStore.getState()).map((n) => n.id);

  return (
    <div
      role="toolbar"
      aria-label="批量操作"
      className={cn(
        "flex items-center gap-0.5 rounded-xl border border-black/10 bg-white/70 px-2 py-1.5 elevation-3 dark:border-white/10 dark:bg-black/40",
        // 竖栏形态四周等距：左右/底部均 8px，与列表卡片同一对齐系
        compact ? "absolute bottom-2 right-3 z-30" : "mx-2 mb-2"
      )}
    >
      <span className="px-1 text-label tabular-nums text-muted-foreground">
        已选 {count}
      </span>

      <div className="ml-auto flex items-center gap-0.5">
        {!compact && (
          <>
            <IconAction label="合并笔记" disabled={count < 2} onClick={mergeCheckedWithUndo}>
              <Merge className="size-3.5" />
            </IconAction>
            {/* 剪贴板历史无「完成」语义（发送也不标完成），该页隐藏 */}
            {page !== "clipboard" && (
              <IconAction label="标记完成" onClick={() => state.setDone(orderedIds(), true)}>
                <CheckCheck className="size-3.5" />
              </IconAction>
            )}
            <SimpleMenu
              side="top"
              align="end"
              // flex 消除包裹层行盒：block div 内联按钮会吃基线下沉，图标偏上错位
              className="flex"
              trigger={({ toggle }) => (
                <IconAction label="打标签" onClick={toggle}>
                  <Tag className="size-3.5" />
                </IconAction>
              )}
            >
              {(close) => (
                <>
                  <SimpleMenuLabel>为已选卡片追加标签</SimpleMenuLabel>
                  {tagCatalog.length ? (
                    tagCatalog.map((tag) => (
                      <SimpleMenuItem
                        key={tag}
                        onClick={() => {
                          state.addNoteTags(orderedIds(), [tag]);
                          close();
                        }}
                      >
                        <span className="truncate">#{tag}</span>
                      </SimpleMenuItem>
                    ))
                  ) : (
                    <SimpleMenuItem disabled onClick={() => {}}>
                      暂无标签 · 先在卡片右键「标签」创建
                    </SimpleMenuItem>
                  )}
                </>
              )}
            </SimpleMenu>
            <IconAction
              label="删除"
              onClick={() => deleteNotesWithUndo(orderedIds())}
            >
              <Trash2 className="size-3.5" />
            </IconAction>
          </>
        )}
        <IconAction label="清除选择" onClick={() => state.clearChecked()}>
          <X className="size-3.5" />
        </IconAction>

        <div className="ml-1 flex items-center">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="xs"
                disabled={!targetReady}
                aria-label={
                  internalSendAvailable
                    ? "优先添加到当前卡片编辑器，否则发送到当前目标"
                    : targetReady
                    ? `发送到当前目标，发送方案 ${resolution.profile.name}，粘贴后动作 ${ENTER_POLICY_STATUS_LABEL[resolution.profile.enterPolicy]}`
                    : profileOverrideNeedsConfirmation
                      ? "发送不可用：原临时发送方案已暂停"
                      : "发送不可用：发送目标未就绪"
                }
                className="rounded-l-lg rounded-r-none"
                onClick={() => sendCheckedToChat()}
              >
                <Send className="size-3" />
                {internalSendAvailable ? "发送 / 添加" : "发送到对话"}
                {/* token-exception: 9px 为重塑前原始尺寸，用户指定还原 */}
                <Kbd inline className="ml-0.5 text-[9px]">⌘⏎</Kbd>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-72">
              <p className="mb-1 text-micro font-medium opacity-70">将粘贴以下内容：</p>
              <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words font-mono text-micro leading-relaxed">
                {previewDraft.finalText}
              </pre>
            </TooltipContent>
          </Tooltip>
          <SimpleMenu
            side="top"
            align="end"
            className="flex"
            trigger={({ toggle }) => (
              <Button
                size="xs"
                aria-label="选择本次发送方案、输出格式或提示词模板"
                disabled={!nativeTargetReady && !internalSendAvailable}
                onClick={toggle}
                className="rounded-l-none rounded-r-lg border-l border-border px-1"
              >
                <ChevronDown className="size-3" />
              </Button>
            )}
          >
            {(close) => (
              <>
                <SimpleMenuLabel>发送前</SimpleMenuLabel>
                <SimpleMenuItem
                  disabled={!nativeTargetReady || profileOverrideNeedsConfirmation}
                  onClick={() => {
                    close();
                    void sendCheckedToChat(undefined, { forcePreflight: true });
                  }}
                >
                  预检并发送
                </SimpleMenuItem>
                <SimpleMenuLabel>预检方式</SimpleMenuLabel>
                {(
                  [
                    ["smart", "智能（复杂内容时打开）"],
                    ["always", "每次发送前打开"],
                    ["off", "关闭自动预检"],
                  ] as const satisfies readonly (readonly [PreflightMode, string])[]
                ).map(([mode, label]) => (
                  <SimpleMenuItem
                    key={mode}
                    selected={preflightMode === mode}
                    onClick={() => {
                      useDeliveryStore.getState().setPreflightMode(mode);
                      close();
                    }}
                  >
                    {preflightMode === mode ? "✓ " : ""}{label}
                  </SimpleMenuItem>
                ))}
                <SimpleMenuSeparator />
                <SimpleMenuLabel>输出格式</SimpleMenuLabel>
                <SimpleMenuItem
                  disabled={!targetReady}
                  onClick={() => {
                    close();
                    void sendCheckedToChat(undefined, { format: "plain" });
                  }}
                >
                  纯文本{resolution.profile.defaultFormat === "plain" ? "（方案默认）" : ""}
                </SimpleMenuItem>
                <SimpleMenuItem
                  disabled={!targetReady}
                  title="包裹为 Markdown 代码块，单条会带上检测到的语言"
                  onClick={() => {
                    close();
                    void sendCheckedToChat(undefined, { format: "code" });
                  }}
                >
                  代码块 ```{resolution.profile.defaultFormat === "code" ? "（方案默认）" : ""}
                </SimpleMenuItem>
                <SimpleMenuSeparator />
                <SimpleMenuLabel>本次发送方案</SimpleMenuLabel>
                {profileOverrideNeedsConfirmation && (
                  <SimpleMenuItem
                    onClick={() => {
                      confirmTargetProfileOverride();
                      close();
                    }}
                  >
                    将 {profileOverrideName ?? "原方案"} 用于当前目标
                  </SimpleMenuItem>
                )}
                <SimpleMenuItem
                  onClick={() => {
                    clearTargetProfileOverride();
                    close();
                  }}
                >
                  {profileOverrideId ? "" : "✓ "}自动匹配：{automaticResolution.profile.name}
                </SimpleMenuItem>
                {settings.targetProfiles.map((profile) => (
                  <SimpleMenuItem
                    key={profile.id}
                    onClick={() => {
                      setTargetProfileOverride(profile.id);
                      close();
                    }}
                  >
                    {profileOverrideId === profile.id ? "✓ " : ""}{profile.name}
                  </SimpleMenuItem>
                ))}
                <SimpleMenuSeparator />
                <SimpleMenuLabel>
                  当前提示词组 · {resolution.promptGroup.name}
                </SimpleMenuLabel>
                {snippetMenu.prioritized.map((sn) => (
                  <SimpleMenuItem
                    key={`priority-${sn.id}`}
                    disabled={!targetReady}
                    title={sn.text}
                    onClick={() => {
                      close();
                      void sendCheckedToChat(sn.text, { promptSnippetId: sn.id });
                    }}
                  >
                    {sn.label}
                  </SimpleMenuItem>
                ))}
                {snippetMenu.prioritized.length === 0 && (
                  <SimpleMenuItem disabled onClick={() => {}}>
                    {snippetMenu.remaining.length > 0
                      ? "当前分组暂无模板"
                      : "去设置里添加模板"}
                  </SimpleMenuItem>
                )}
                {snippetMenu.remaining.length > 0 && (
                  <>
                    <SimpleMenuSeparator />
                    <SimpleMenuLabel>其他模板</SimpleMenuLabel>
                    {snippetMenu.remaining.map((sn) => (
                      <SimpleMenuItem
                        key={`remaining-${sn.id}`}
                        disabled={!targetReady}
                        title={sn.text}
                        onClick={() => {
                          close();
                          void sendCheckedToChat(sn.text, { promptSnippetId: sn.id });
                        }}
                      >
                        {sn.label}
                      </SimpleMenuItem>
                    ))}
                  </>
                )}
              </>
            )}
          </SimpleMenu>
        </div>
      </div>
    </div>
  );
}

function IconAction({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <IconButton label={label} withTitle={false} disabled={disabled} onClick={onClick}>
          {children}
        </IconButton>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-label">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
