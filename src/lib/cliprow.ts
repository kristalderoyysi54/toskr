/** 剪贴板行样式的纯函数：时间分组 / 等宽内容判定 / 中段省略拆分。 */

/** 时间分组段名（连续同段在渲染层合并为一个小节头，Raycast 剪贴板风格）。 */
export function clipTimeBand(ts: number, now: number): string {
  const diff = now - ts;
  const M = 60_000;
  const H = 3_600_000;
  const D = 86_400_000;
  if (diff < 15 * M) return "刚刚";
  if (diff < H) return "1 小时内";
  const dt = new Date(ts);
  const dn = new Date(now);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDay(dt, dn)) return "今天";
  if (sameDay(dt, new Date(now - D))) return "昨天";
  if (diff < 7 * D) return "7 天内";
  return "更早";
}

const CMD_HEADS = new Set([
  "git", "grep", "rg", "ssh", "cd", "ls", "cat", "tail", "head", "find",
  "npm", "pnpm", "yarn", "cargo", "curl", "wget", "brew", "docker", "kubectl",
  "python", "python3", "node", "make", "vim", "nvim", "code", "open",
  "kill", "pkill", "chmod", "chown", "tar", "rm", "cp", "mv", "mkdir",
  "echo", "export", "source", "sudo",
]);

/** 路径/命令类内容：这类文本用等宽字体 + 中段省略（尾段才是身份）。 */
export function isMonoLike(text: string): boolean {
  const line = text.split("\n")[0].trim();
  if (!line) return false;
  // 纯路径：/... ~/... ./...（无空格）
  if (/^(\/|~\/|\.\/)\S*$/.test(line)) return true;
  // 常见命令开头
  return CMD_HEADS.has(line.split(/\s+/)[0]);
}

/**
 * 中段省略拆分：head 弹性截断、tail 定长保留（配合 flex+truncate 实现
 * 「保头保尾」——路径的文件名段不再被尾部截断吃掉）。
 */
export function splitMiddle(
  text: string,
  tailLen = 18
): { head: string; tail: string } {
  const line = text.split("\n")[0];
  const chars = [...line];
  if (chars.length <= tailLen * 2) return { head: line, tail: "" };
  return {
    head: chars.slice(0, chars.length - tailLen).join(""),
    tail: chars.slice(chars.length - tailLen).join(""),
  };
}

export const CLIP_PINNED_BAND = "__pinned__";

/** 剪贴来源键：bundle id 优先，其次应用名；都没有为空串（「未知来源」）。 */
export function clipSourceKey(n: { sourceApp?: string; sourceBundle?: string }): string {
  return n.sourceBundle || n.sourceApp || "";
}

export interface ClipSourceBand<T> {
  /** 分组键：bundle id 优先，其次应用名；置顶段为 CLIP_PINNED_BAND。 */
  key: string;
  label: string;
  bundle?: string;
  notes: T[];
}

/**
 * 按来源应用分组：置顶独立成段排最前；其余按入参顺序（新在前）首次出现
 * 的先后排列，即「最近活跃的来源在上」。无来源信息的归入「未知来源」。
 */
export function groupClipsBySource<
  T extends { keep?: boolean; sourceApp?: string; sourceBundle?: string },
>(notes: T[]): ClipSourceBand<T>[] {
  const pinned: T[] = [];
  const bands = new Map<string, ClipSourceBand<T>>();
  for (const n of notes) {
    if (n.keep) {
      pinned.push(n);
      continue;
    }
    const key = clipSourceKey(n);
    let band = bands.get(key);
    if (!band) {
      band = { key, label: n.sourceApp || "未知来源", bundle: n.sourceBundle, notes: [] };
      bands.set(key, band);
    }
    band.notes.push(n);
  }
  const rest = [...bands.values()];
  return pinned.length > 0
    ? [{ key: CLIP_PINNED_BAND, label: "置顶", notes: pinned }, ...rest]
    : rest;
}
