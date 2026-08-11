import { ContextMenuItem } from "@/components/ui/context-menu";
import { useTargetStore } from "@/store/targetStore";

/** 仅右键菜单打开时挂载订阅，避免每次发送刷新让全部 NoteCard 重渲染。 */
export function TargetSendMenuItem({
  onClick,
  children,
  allowInternal = false,
}: {
  onClick: () => void;
  children: React.ReactNode;
  allowInternal?: boolean;
}) {
  const ready = useTargetStore(
    (state) => state.status === "ready" && !state.profileOverrideNeedsConfirmation
  );
  const profileChanged = useTargetStore(
    (state) => state.profileOverrideNeedsConfirmation
  );
  const enabled = ready || allowInternal;
  return (
    <ContextMenuItem
      disabled={!enabled}
      aria-label={
        ready
          ? "发送到当前目标"
          : allowInternal
            ? "优先添加到当前卡片编辑器"
          : profileChanged
            ? "发送不可用：原临时投递方案已暂停"
            : "发送不可用：投递目标未就绪"
      }
      onClick={onClick}
    >
      {children}
    </ContextMenuItem>
  );
}
