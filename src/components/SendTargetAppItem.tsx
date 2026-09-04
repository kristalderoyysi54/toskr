import { useRef } from "react";

import { ApplicationIcon } from "@/components/ApplicationIcon";
import { SimpleMenuItem } from "@/components/SimpleMenu";
import { useAppIcon } from "@/lib/icons";
import { useNearViewport } from "@/lib/viewportMedia";

export interface SendTargetApp {
  pid: number;
  name: string;
  bundleId: string;
}

/** 菜单打开后先出名称；只为可见邻近行异步取图标，避免批量解码阻塞展开。 */
export function SendTargetAppItem({
  target,
  onSelect,
}: {
  target: SendTargetApp;
  onSelect: () => void;
}) {
  const iconAnchorRef = useRef<HTMLSpanElement>(null);
  const near = useNearViewport(iconAnchorRef);
  const icon = useAppIcon(target.bundleId, near);

  return (
    <SimpleMenuItem onClick={onSelect}>
      <span ref={iconAnchorRef} aria-hidden="true" className="size-4 shrink-0">
        <ApplicationIcon
          src={icon?.url}
          name={target.name}
          className="size-4 rounded-sm"
        />
      </span>
      <span className="min-w-0 flex-1 truncate">{target.name}</span>
    </SimpleMenuItem>
  );
}
