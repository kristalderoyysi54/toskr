import { useEffect, useState } from "react";

import { api } from "@/lib/tauri";

export interface AppIconInfo {
  url: string;
  /** 图标主色（"#rrggbb"），用作卡片顶部通栏底色。 */
  color: string;
}

/** 应用图标内存缓存（bundle id → 图标信息 | null），不落盘。 */
const cache = new Map<string, Promise<AppIconInfo | null>>();

function fetchIcon(bundleId: string): Promise<AppIconInfo | null> {
  let hit = cache.get(bundleId);
  if (!hit) {
    hit = api.appIcon(bundleId).catch(() => null);
    cache.set(bundleId, hit);
  }
  return hit;
}

/** 按 bundle id 取应用图标与主色（未就绪/取不到为 null）。 */
export function useAppIcon(bundleId: string | undefined): AppIconInfo | null {
  const [info, setInfo] = useState<AppIconInfo | null>(null);
  useEffect(() => {
    if (!bundleId) return;
    let alive = true;
    fetchIcon(bundleId).then((i) => {
      if (alive) setInfo(i);
    });
    return () => {
      alive = false;
    };
  }, [bundleId]);
  return bundleId ? info : null;
}
