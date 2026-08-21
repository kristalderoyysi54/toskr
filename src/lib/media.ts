import { useEffect, useState } from "react";

import { api } from "@/lib/tauri";

/** 全尺寸图片 data URL 很大，只保留最近少量预览，避免连续放大后内存只增不减。 */
const cache = new Map<string, Promise<string | null>>();
const IMAGE_CACHE_LIMIT = 12;

function fetchImage(name: string): Promise<string | null> {
  let hit = cache.get(name);
  if (hit) {
    cache.delete(name);
    cache.set(name, hit);
  } else {
    hit = api.imageDataUrl(name).catch(() => null);
    cache.set(name, hit);
    // 文件刚写入或瞬时 IPC 失败时不做长期负缓存，下次打开允许重试。
    void hit.then((loaded) => {
      if (loaded === null && cache.get(name) === hit) cache.delete(name);
    });
    if (cache.size > IMAGE_CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
  }
  return hit;
}

/** 缩略图 data URL 内存缓存（卡面用小图，与全尺寸分开存）。 */
const thumbCache = new Map<string, Promise<string | null>>();
const THUMB_CACHE_LIMIT = 128;

function fetchThumb(name: string): Promise<string | null> {
  let hit = thumbCache.get(name);
  if (hit) {
    // Map 插入序即 LRU 顺序；命中后移到队尾。
    thumbCache.delete(name);
    thumbCache.set(name, hit);
  } else {
    hit = api.imageThumbUrl(name).catch(() => null);
    thumbCache.set(name, hit);
    // 瞬时 IPC/文件失败不应在 LRU 内变成长期负缓存；下次挂载允许自愈重试。
    void hit.then((loaded) => {
      if (loaded === null && thumbCache.get(name) === hit) thumbCache.delete(name);
    });
    if (thumbCache.size > THUMB_CACHE_LIMIT) {
      const oldest = thumbCache.keys().next().value;
      if (oldest) thumbCache.delete(oldest);
    }
  }
  return hit;
}

/** 卡面缩略图状态：失败/null 与加载中分开，避免失败占位永久 pulse。 */
export function useNoteThumbState(name: string | undefined): {
  url: string | null;
  loading: boolean;
} {
  const [result, setResult] = useState<{
    name: string;
    url: string | null;
  } | null>(null);
  useEffect(() => {
    if (!name) return;
    let alive = true;
    fetchThumb(name).then((u) => {
      if (alive) setResult({ name, url: u });
    });
    return () => {
      alive = false;
    };
  }, [name]);
  const settled = !!name && result?.name === name;
  return {
    url: settled ? result.url : null,
    loading: !!name && !settled,
  };
}

/** 卡面缩略图（≤320px，KB 级）：列表滚动/切页不再解码全尺寸大位图。 */
export function useNoteThumb(name: string | undefined): string | null {
  return useNoteThumbState(name).url;
}

/** 按附件名取图片 data URL（加载中/失败为 null）。 */
export function useNoteImage(name: string | undefined): string | null {
  const [result, setResult] = useState<{
    name: string;
    url: string | null;
  } | null>(null);
  useEffect(() => {
    if (!name) return;
    let alive = true;
    fetchImage(name).then((u) => {
      if (alive) setResult({ name, url: u });
    });
    return () => {
      alive = false;
    };
  }, [name]);
  return name && result?.name === name ? result.url : null;
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
