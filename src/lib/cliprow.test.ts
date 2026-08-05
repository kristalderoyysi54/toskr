import { describe, expect, it } from "vitest";

import { clipTimeBand, isMonoLike, splitMiddle } from "./cliprow";

const H = 3_600_000;
const D = 86_400_000;
// 固定「当前时刻」：本地时区某日中午，避免跨日边界抖动
const NOW = new Date(2026, 7, 5, 12, 0, 0).getTime();

describe("clipTimeBand", () => {
  it("15 分钟内为「刚刚」", () => {
    expect(clipTimeBand(NOW - 5 * 60_000, NOW)).toBe("刚刚");
  });
  it("1 小时内", () => {
    expect(clipTimeBand(NOW - 30 * 60_000, NOW)).toBe("1 小时内");
  });
  it("当天更早为「今天」", () => {
    expect(clipTimeBand(NOW - 3 * H, NOW)).toBe("今天");
  });
  it("昨天", () => {
    expect(clipTimeBand(NOW - 24 * H, NOW)).toBe("昨天");
  });
  it("7 天内", () => {
    expect(clipTimeBand(NOW - 3 * D, NOW)).toBe("7 天内");
  });
  it("更早", () => {
    expect(clipTimeBand(NOW - 30 * D, NOW)).toBe("更早");
  });
});

describe("isMonoLike", () => {
  it("绝对/家目录/相对路径", () => {
    expect(isMonoLike("/home/q/php/backendSystem/src")).toBe(true);
    expect(isMonoLike("~/Documents/notes.md")).toBe(true);
    expect(isMonoLike("./script/release.sh")).toBe(true);
  });
  it("常见命令", () => {
    expect(isMonoLike("grep -c 'FAC_DOUYIN' /home/q/sys.log")).toBe(true);
    expect(isMonoLike("git status --short")).toBe(true);
  });
  it("普通中文/英文句子不是", () => {
    expect(isMonoLike("建立统一的 Design Tokens")).toBe(false);
    expect(isMonoLike("hello world this is text")).toBe(false);
  });
  it("含空格的路径样文本不误判为纯路径", () => {
    expect(isMonoLike("/home 目录说明文档")).toBe(false);
  });
});

describe("splitMiddle", () => {
  it("短文本不拆", () => {
    expect(splitMiddle("query_mode")).toEqual({ head: "query_mode", tail: "" });
  });
  it("长路径保尾", () => {
    const p = "/home/q/php/backendSystem/src/recon/NewRecvReconDispatchSvc.php";
    const { head, tail } = splitMiddle(p, 18);
    expect(head + tail).toBe(p);
    expect(tail).toBe("RecvReconDispatchSvc.php".slice(-18));
    expect([...tail].length).toBe(18);
  });
  it("多行取首行", () => {
    const { head, tail } = splitMiddle("short\n第二行");
    expect(head).toBe("short");
    expect(tail).toBe("");
  });
});
