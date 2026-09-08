import { ArrowLeft, ChevronRight, Eraser, Magnet, Menu, Move, Pin, Rows3 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { SimpleMenu, SimpleMenuItem, SimpleMenuLabel, SimpleMenuSeparator } from "@/components/SimpleMenu";
import { IconButton } from "@/components/ui/icon-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { applySettingsPatch } from "@/lib/settingsSync";
import { handlePanelPlacementKeyDown } from "@/lib/menuKeyboard";
import { useNotesStore } from "@/store/notesStore";
import { applyCompanionSide, applySidebar } from "@/lib/panelPlacement";
import { useUIStore } from "@/store/uiStore";

interface PanelOptionsMenuProps {
  doneCount: number;
  doneTaskCount: number;
  onClearNotes: () => void;
  onClearTasks: () => void;
}

const EDGE_LABEL = { right: "屏幕右侧", left: "屏幕左侧", top: "屏幕顶部", bottom: "屏幕底部" };

/** 两种布局共用同一菜单：日常选项在前，位置配置按需展开。 */
export function PanelOptionsMenu({ doneCount, doneTaskCount, onClearNotes, onClearTasks }: PanelOptionsMenuProps) {
  const settings = useNotesStore((state) => state.settings);
  const pinned = useUIStore((state) => state.pinned);
  const page = useUIStore((state) => state.page);
  const contentSubview = useUIStore((state) => state.contentSubview);
  const [placementOpen, setPlacementOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const next = placementOpen
        ? rootRef.current?.querySelector<HTMLButtonElement>("[data-simple-menu-item]")
        : rootRef.current?.querySelector("[data-panel-placement]")?.closest("button");
      next?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [placementOpen]);
  const notesView = page === "notes" && contentSubview === "notes";
  const densityAvailable = page === "clipboard" || notesView;
  const completed = notesView ? doneCount : page === "tasks" ? doneTaskCount : 0;
  const placementLabel = settings.companionEnabled
    ? `跟随应用 · ${settings.sidebarEdge === "left" ? "左侧" : "右侧"}`
    : settings.rightSidebar ? EDGE_LABEL[settings.sidebarEdge] : "自由移动";

  return (
    <div ref={rootRef} className="flex" onKeyDownCapture={(event) => handlePanelPlacementKeyDown(event, placementOpen, setPlacementOpen)}>
    <SimpleMenu
      className="flex"
      menuClassName="w-56"
      onOpenChange={(open) => { if (open) setPlacementOpen(false); }}
      menuAriaLabel={placementOpen ? "位置与停靠" : "面板选项"}
      trigger={({ open, toggle, controls }) => (
        <Tooltip>
          <TooltipTrigger asChild>
          <IconButton
            label="面板选项"
            withTitle={false}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={open ? controls : undefined}
            onClick={() => {
              if (!open) setPlacementOpen(false);
              toggle();
            }}
          >
            <Menu />
          </IconButton>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-label">面板选项</TooltipContent>
        </Tooltip>
      )}
    >
      {(close) => placementOpen ? (
        <>
          <SimpleMenuItem onClick={() => setPlacementOpen(false)}>
            <ArrowLeft className="size-3.5" /> 返回面板选项
          </SimpleMenuItem>
          <SimpleMenuSeparator />
          <SimpleMenuLabel>当前位置：{placementLabel}</SimpleMenuLabel>
          <SimpleMenuItem
            checked={settings.companionEnabled}
            title="只跟随设置中选定的应用；可在设置 → 窗口与外观 → 伴随停靠调整应用名单"
            onClick={() => {
              applySettingsPatch({ companionEnabled: !settings.companionEnabled });
            }}
          >
            <Magnet className="size-3.5" /> 跟随应用
          </SimpleMenuItem>
          {settings.companionEnabled ? (
            <>
              <SimpleMenuLabel>跟随位置</SimpleMenuLabel>
              {(["left", "right"] as const).map((edge) => (
                <SimpleMenuItem
                  key={edge}
                  radio
                  checked={(settings.sidebarEdge === "left" ? "left" : "right") === edge}
                  onClick={() => {
                    close();
                    applyCompanionSide(edge);
                  }}
                >
                  {edge === "left" ? "应用左侧" : "应用右侧"}
                </SimpleMenuItem>
              ))}
            </>
          ) : (
            <>
              <SimpleMenuLabel>屏幕位置</SimpleMenuLabel>
              <SimpleMenuItem
                radio
                checked={!settings.rightSidebar}
                onClick={() => { close(); void applySidebar(false, settings.sidebarEdge); }}
              >
                <Move className="size-3.5" /> 自由移动
              </SimpleMenuItem>
              {(["right", "bottom"] as const).map((edge) => (
                <SimpleMenuItem
                  key={edge}
                  radio
                  checked={settings.rightSidebar && settings.sidebarEdge === edge}
                  onClick={() => { close(); void applySidebar(true, edge); }}
                >
                  {EDGE_LABEL[edge]}
                </SimpleMenuItem>
              ))}
            </>
          )}
        </>
      ) : (
        <>
          {(densityAvailable || completed > 0) && (
            <>
              <SimpleMenuLabel>当前列表</SimpleMenuLabel>
              {densityAvailable && (
                <SimpleMenuItem
                  checked={settings.cardDensity === "compact"}
                  onClick={() => {
                    close();
                    applySettingsPatch({ cardDensity: settings.cardDensity === "compact" ? "comfortable" : "compact" });
                  }}
                >
                  <Rows3 className="size-3.5" /> 紧凑列表
                </SimpleMenuItem>
              )}
              {completed > 0 && (
                <SimpleMenuItem onClick={() => { close(); (notesView ? onClearNotes : onClearTasks)(); }}>
                  <Eraser className="size-3.5" /> 清理已完成（{completed}）
                  <span className="ml-auto pl-2 text-micro text-muted-foreground">⇧⌘⌫</span>
                </SimpleMenuItem>
              )}
              <SimpleMenuSeparator />
            </>
          )}
          <SimpleMenuLabel>面板</SimpleMenuLabel>
          <SimpleMenuItem
            checked={pinned}
            title="切换应用或粘贴后保持显示；仍可用关闭按钮或快捷键收起"
            onClick={() => { close(); useUIStore.getState().setPinned(!pinned); }}
          >
            <Pin className="size-3.5" /> 保持面板展开
          </SimpleMenuItem>
          <SimpleMenuItem onClick={() => setPlacementOpen(true)}>
            <Move className="size-3.5" /> <span data-panel-placement>位置与停靠</span>
            <ChevronRight className="ml-auto size-3.5" />
          </SimpleMenuItem>
        </>
      )}
    </SimpleMenu>
    </div>
  );
}
