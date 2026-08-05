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
