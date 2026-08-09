import { ContextMenuItem } from "@/components/ui/context-menu";
import { useTargetStore } from "@/store/targetStore";

/** 仅右键菜单打开时挂载订阅，避免每次发送刷新让全部 NoteCard 重渲染。 */
export function TargetSendMenuItem({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  const ready = useTargetStore(
    (state) => state.status === "ready" && !state.profileOverrideNeedsConfirmation
  );
  const profileChanged = useTargetStore(
    (state) => state.profileOverrideNeedsConfirmation
  );
  return (
    <ContextMenuItem
      disabled={!ready}
      aria-label={
        ready
          ? "发送到当前目标"
          : profileChanged
            ? "发送不可用：目标已变化，请确认 Profile"
            : "发送不可用：投递目标未就绪"
      }
      onClick={onClick}
    >
      {children}
    </ContextMenuItem>
  );
}
