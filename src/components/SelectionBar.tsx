import { CheckCheck, ChevronDown, ListOrdered, Merge, Send, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  SimpleMenu,
  SimpleMenuItem,
  SimpleMenuLabel,
  SimpleMenuSeparator,
} from "@/components/SimpleMenu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  copyCheckedAsList,
  deleteNotesWithUndo,
  mergeCheckedWithUndo,
  sendCheckedToChat,
} from "@/lib/actions";
import { buildSendText, sendPreview } from "@/lib/format";
import { orderedCheckedNotes, useNotesStore } from "@/store/notesStore";

/** 勾选 ≥1 条时出现的批量操作条。 */
export function SelectionBar() {
  const checkedIds = useNotesStore((s) => s.checkedIds);
  const snippets = useNotesStore((s) => s.settings.promptSnippets);
  const count = checkedIds.length;
  if (count === 0) return null;

  const state = useNotesStore.getState();
  const orderedIds = () => orderedCheckedNotes(useNotesStore.getState()).map((n) => n.id);
  const previewText = () =>
    sendPreview(buildSendText(orderedCheckedNotes(useNotesStore.getState()).map((n) => n.text)));

  return (
    <div className="mx-3 mb-1 flex items-center gap-0.5 rounded-xl border border-black/10 bg-white/70 px-2 py-1.5 shadow-sm dark:border-white/10 dark:bg-black/40">
      <span className="px-1 text-[11px] tabular-nums text-muted-foreground">
        已选 {count}
      </span>

      <div className="ml-auto flex items-center gap-0.5">
        <IconAction label="复制为列表" onClick={() => copyCheckedAsList()}>
          <ListOrdered className="size-3.5" />
        </IconAction>
        <IconAction label="合并笔记" disabled={count < 2} onClick={mergeCheckedWithUndo}>
          <Merge className="size-3.5" />
        </IconAction>
        <IconAction label="标记完成" onClick={() => state.setDone(orderedIds(), true)}>
          <CheckCheck className="size-3.5" />
        </IconAction>
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
                size="sm"
                className="h-6 gap-1 rounded-l-lg rounded-r-none px-2 text-[11px]"
                onClick={() => sendCheckedToChat()}
              >
                <Send className="size-3" /> 发送到对话
                <kbd className="ml-0.5 text-[9px] opacity-70">⌘⏎</kbd>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-72">
              <p className="mb-1 text-[10px] font-medium opacity-70">将粘贴以下内容：</p>
              <pre className="max-h-48 overflow-hidden whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed">
                {previewText()}
              </pre>
            </TooltipContent>
          </Tooltip>
          <SimpleMenu
            side="top"
            align="end"
            trigger={({ toggle }) => (
              <Button
                size="sm"
                aria-label="带 Prompt 模板发送"
                onClick={toggle}
                className="h-6 rounded-l-none rounded-r-lg border-l border-primary-foreground/20 px-1"
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
                <SimpleMenuLabel>带 Prompt 前缀发送</SimpleMenuLabel>
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
        <button
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
          className="rounded-md p-1 text-muted-foreground hover:bg-black/5 hover:text-foreground disabled:opacity-40 dark:hover:bg-white/10"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-[11px]">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
