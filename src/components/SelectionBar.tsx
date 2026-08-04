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
import { orderedCheckedNotes, useNotesStore } from "@/store/notesStore";
import { useUIStore } from "@/store/uiStore";

/** 勾选 ≥1 条时出现的批量操作条。 */
export function SelectionBar() {
  const checkedIds = useNotesStore((s) => s.checkedIds);
  const snippets = useNotesStore((s) => s.settings.promptSnippets);
  const page = useUIStore((s) => s.page);
  const count = checkedIds.length;
  if (count === 0) return null;

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
                aria-label="带 Prompt 模板发送"
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
                  onClick={() => {
                    close();
                    void sendCheckedToChat();
                  }}
                >
                  纯文本（默认）
                </SimpleMenuItem>
                <SimpleMenuItem
                  title="包裹为 Markdown 代码块，单条会带上检测到的语言"
                  onClick={() => {
                    close();
                    void sendCheckedToChat(undefined, { asCode: true });
                  }}
                >
                  代码块 ```
                </SimpleMenuItem>
                <SimpleMenuSeparator />
                <SimpleMenuLabel>带 Prompt 模板发送</SimpleMenuLabel>
                {snippets.map((sn) => (
                  <SimpleMenuItem
                    key={sn.id}
                    title={sn.text}
                    onClick={() => {
                      close();
                      void sendCheckedToChat(sn.text);
                    }}
                  >
                    {sn.label}
                  </SimpleMenuItem>
                ))}
                {snippets.length === 0 && (
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
