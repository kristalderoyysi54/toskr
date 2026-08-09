import { CheckCheck, ChevronDown, Merge, Send, Trash2, X } from "lucide-react";

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
import { buildSendText, sendPreview } from "@/lib/format";
import {
  promptSnippetsForGroup,
  resolveTargetProfile,
} from "@/lib/targetProfiles";
import { CLIPBOARD_ID, orderedCheckedNotes, useNotesStore } from "@/store/notesStore";
import { useUIStore } from "@/store/uiStore";
import {
  clearTargetProfileOverride,
  confirmTargetProfileOverride,
  setTargetProfileOverride,
  useTargetStore,
} from "@/store/targetStore";

/** 勾选 ≥1 条时出现的批量操作条。 */
export function SelectionBar() {
  const checkedIds = useNotesStore((s) => s.checkedIds);
  const notes = useNotesStore((s) => s.notes);
  const settings = useNotesStore((s) => s.settings);
  const page = useUIStore((s) => s.page);
  const targetStatus = useTargetStore((s) => s.status);
  const targetBundleId = useTargetStore((s) => s.snapshot?.bundleId);
  const profileOverrideId = useTargetStore((s) => s.profileOverrideId);
  const profileOverrideNeedsConfirmation = useTargetStore(
    (s) => s.profileOverrideNeedsConfirmation
  );
  const nativeTargetReady = targetStatus === "ready";
  const targetReady = nativeTargetReady && !profileOverrideNeedsConfirmation;
  const resolution = resolveTargetProfile({
    bundleId: targetBundleId,
    groups: settings.promptGroups,
    profiles: settings.targetProfiles,
    defaultProfileId: settings.defaultTargetProfileId,
    temporaryProfileId: profileOverrideId,
  });
  const snippetMenu = promptSnippetsForGroup(
    settings.promptSnippets,
    resolution.promptGroup.id
  );
  const count = checkedIds.length;
  // 只在「当前页存在选中项」时显示：笔记页的选中切到剪贴板页不显示，
  // 切回笔记页恢复（反之亦然；跨域混选则两页都显示）
  const checkedSet = new Set(checkedIds);
  const relevantHere = notes.some(
    (n) =>
      checkedSet.has(n.id) &&
      (n.sectionId === CLIPBOARD_ID) === (page === "clipboard")
  );
  if (count === 0 || !relevantHere) return null;

  const state = useNotesStore.getState();
  const orderedIds = () => orderedCheckedNotes(useNotesStore.getState()).map((n) => n.id);
  const previewText = () =>
    sendPreview(buildSendText(orderedCheckedNotes(useNotesStore.getState()).map((n) => n.text)));

  return (
    <div
      role="toolbar"
      aria-label="批量操作"
      className="mx-3 mb-1 flex items-center gap-0.5 rounded-xl border border-black/10 bg-white/70 px-2 py-1.5 elevation-3 dark:border-white/10 dark:bg-black/40"
    >
      <span className="px-1 text-label tabular-nums text-muted-foreground">
        已选 {count}
      </span>

      <div className="ml-auto flex items-center gap-0.5">
        <IconAction label="合并笔记" disabled={count < 2} onClick={mergeCheckedWithUndo}>
          <Merge className="size-3.5" />
        </IconAction>
        {/* 剪贴板历史无「完成」语义（发送也不标完成），该页隐藏 */}
        {page !== "clipboard" && (
          <IconAction label="标记完成" onClick={() => state.setDone(orderedIds(), true)}>
            <CheckCheck className="size-3.5" />
          </IconAction>
        )}
        <IconAction
          label="删除"
          onClick={() => deleteNotesWithUndo(orderedIds())}
        >
          <Trash2 className="size-3.5" />
        </IconAction>
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
                  targetReady
                    ? `发送到当前目标，Profile ${resolution.profile.name}，回车策略 ${resolution.profile.enterPolicy}`
                    : profileOverrideNeedsConfirmation
                      ? "发送不可用：目标已变化，请确认 Profile"
                      : "发送不可用：投递目标未就绪"
                }
                className="rounded-l-lg rounded-r-none"
                onClick={() => sendCheckedToChat()}
              >
                <Send className="size-3" /> 发送到对话
                {/* token-exception: 9px 为重塑前原始尺寸，用户指定还原 */}
                <Kbd inline className="ml-0.5 text-[9px]">⌘⏎</Kbd>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-72">
              <p className="mb-1 text-micro font-medium opacity-70">将粘贴以下内容：</p>
              <pre className="max-h-48 overflow-hidden whitespace-pre-wrap break-words font-mono text-micro leading-relaxed">
                {previewText()}
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
                aria-label="选择本次 Profile、格式或 Prompt 模板"
                disabled={!nativeTargetReady}
                onClick={toggle}
                className="rounded-l-none rounded-r-lg border-l border-border px-1"
              >
                <ChevronDown className="size-3" />
              </Button>
            )}
          >
            {(close) => (
              <>
                <SimpleMenuLabel>发送格式</SimpleMenuLabel>
                <SimpleMenuItem
                  disabled={!targetReady}
                  onClick={() => {
                    close();
                    void sendCheckedToChat(undefined, { format: "plain" });
                  }}
                >
                  纯文本{resolution.profile.defaultFormat === "plain" ? "（Profile 默认）" : ""}
                </SimpleMenuItem>
                <SimpleMenuItem
                  disabled={!targetReady}
                  title="包裹为 Markdown 代码块，单条会带上检测到的语言"
                  onClick={() => {
                    close();
                    void sendCheckedToChat(undefined, { format: "code" });
                  }}
                >
                  代码块 ```{resolution.profile.defaultFormat === "code" ? "（Profile 默认）" : ""}
                </SimpleMenuItem>
                <SimpleMenuSeparator />
                <SimpleMenuLabel>本次 Profile</SimpleMenuLabel>
                {profileOverrideNeedsConfirmation && (
                  <SimpleMenuItem
                    onClick={() => {
                      confirmTargetProfileOverride();
                      close();
                    }}
                  >
                    确认当前选择：{resolution.profile.name}
                  </SimpleMenuItem>
                )}
                <SimpleMenuItem
                  onClick={() => {
                    clearTargetProfileOverride();
                    close();
                  }}
                >
                  {profileOverrideId ? "跟随目标自动匹配" : "✓ 跟随目标自动匹配"}
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
                  当前分组 · {resolution.promptGroup.name}
                </SimpleMenuLabel>
                {snippetMenu.prioritized.map((sn) => (
                  <SimpleMenuItem
                    key={`priority-${sn.id}`}
                    disabled={!targetReady}
                    title={sn.text}
                    onClick={() => {
                      close();
                      void sendCheckedToChat(sn.text);
                    }}
                  >
                    {sn.label}
                  </SimpleMenuItem>
                ))}
                {snippetMenu.prioritized.length === 0 && (
                  <SimpleMenuItem disabled onClick={() => {}}>
                    当前分组暂无模板
                  </SimpleMenuItem>
                )}
                <SimpleMenuSeparator />
                <SimpleMenuLabel>全部模板</SimpleMenuLabel>
                {snippetMenu.all.map((sn) => (
                  <SimpleMenuItem
                    key={`all-${sn.id}`}
                    disabled={!targetReady}
                    title={sn.text}
                    onClick={() => {
                      close();
                      void sendCheckedToChat(sn.text);
                    }}
                  >
                    {sn.label}
                  </SimpleMenuItem>
                ))}
                {snippetMenu.all.length === 0 && (
                  <SimpleMenuItem disabled onClick={() => {}}>
                    去设置里添加模板
                  </SimpleMenuItem>
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
