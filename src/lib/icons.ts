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
    // 只长期缓存成功结果：null 缓存住会让该应用的图标整个会话都停在
    // 兜底态；下次挂载/渲染重试即可自愈
    void hit.then((loaded) => {
      if (loaded === null && cache.get(bundleId) === hit) {
        cache.delete(bundleId);
      }
    });
  }
  return hit;
}

/** 按 bundle id 取应用图标与主色（未就绪/取不到为 null）。 */
export function useAppIcon(
  bundleId: string | undefined,
  enabled = true
): AppIconInfo | null {
  const [info, setInfo] = useState<AppIconInfo | null>(null);
  useEffect(() => {
    if (!bundleId || !enabled) return;
    let alive = true;
    fetchIcon(bundleId).then((i) => {
      if (alive) setInfo(i);
    });
    return () => {
      alive = false;
    };
  }, [bundleId, enabled]);
  return bundleId && enabled ? info : null;
}
