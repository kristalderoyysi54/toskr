import { cn } from "@/lib/utils";

/** Platinum 标题栏的关闭 / 缩放 / 收起框（仅 Platinum 配色方案渲染）。 */
export function PlatinumBox({
  kind,
  label,
  disabled,
  onClick,
}: {
  kind: "close" | "zoom" | "shade";
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn("platinum-tbox", kind !== "close" && `platinum-tbox--${kind}`)}
    />
  );
}

/** 独立窗口的 Platinum 标题栏：关闭框 · 条纹 · 居中标题 · 条纹 · 缩放框，整条可拖动。 */
export function PlatinumTitlebar({
  title,
  onClose,
  onZoom,
}: {
  title: string;
  onClose: () => void;
  onZoom?: () => void;
}) {
  return (
    <div data-tauri-drag-region className="platinum-titlebar platinum-window-titlebar">
      <PlatinumBox kind="close" label="关闭" onClick={onClose} />
      <span aria-hidden data-tauri-drag-region className="platinum-stripe platinum-stripe--lead" />
      <span data-tauri-drag-region className="platinum-window-titlebar__title">
        {title}
      </span>
      <span aria-hidden data-tauri-drag-region className="platinum-stripe" />
      {onZoom && <PlatinumBox kind="zoom" label="缩放" onClick={onZoom} />}
    </div>
  );
}
