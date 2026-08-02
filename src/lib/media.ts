import { useEffect, useState } from "react";

import { api } from "@/lib/tauri";

/** 图片附件 data URL 内存缓存（按文件名，不落盘）。 */
const cache = new Map<string, Promise<string | null>>();

function fetchImage(name: string): Promise<string | null> {
  let hit = cache.get(name);
  if (!hit) {
    hit = api.imageDataUrl(name).catch(() => null);
    cache.set(name, hit);
  }
  return hit;
}

/** 按附件名取图片 data URL（加载中/失败为 null）。 */
export function useNoteImage(name: string | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!name) return;
    let alive = true;
    fetchImage(name).then((u) => {
      if (alive) setUrl(u);
    });
    return () => {
      alive = false;
    };
  }, [name]);
  return name ? url : null;
}

/** 相对时间（Paste 风格：刚刚 / N 分钟前 / N 小时前 / N 天前）。 */
export function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(ts).toLocaleDateString("zh-CN");
}
