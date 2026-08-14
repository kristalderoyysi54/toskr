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

/** 缩略图 data URL 内存缓存（卡面用小图，与全尺寸分开存）。 */
const thumbCache = new Map<string, Promise<string | null>>();

function fetchThumb(name: string): Promise<string | null> {
  let hit = thumbCache.get(name);
  if (!hit) {
    hit = api.imageThumbUrl(name).catch(() => null);
    thumbCache.set(name, hit);
  }
  return hit;
}

/** 卡面缩略图（≤320px，KB 级）：列表滚动/切页不再解码全尺寸大位图。 */
export function useNoteThumb(name: string | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!name) return;
    let alive = true;
    fetchThumb(name).then((u) => {
      if (alive) setUrl(u);
    });
    return () => {
      alive = false;
    };
  }, [name]);
  return name ? url : null;
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

/** 卡片时间标签：内容改过的卡显示「改于 …」（更新时间），否则显示创建时间。 */
export function noteTimeLabel(note: {
  createdAt: number;
  updatedAt?: number;
}): string {
  return note.updatedAt && note.updatedAt > note.createdAt
    ? `改于 ${timeAgo(note.updatedAt)}`
    : timeAgo(note.createdAt);
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
