import { describe, expect, it } from "vitest";

import type { Note } from "@/store/notesStore";
import { matchNote, splitHighlight } from "./search";

const note = (text: string, sourceApp?: string): Note => ({
  id: "x",
  text,
  sectionId: "inbox",
  done: false,
  createdAt: 0,
  sourceApp,
});

describe("matchNote", () => {
  it("空查询恒命中", () => {
    expect(matchNote(note("abc"), "")).toBe(true);
    expect(matchNote(note("abc"), "   ")).toBe(true);
  });

  it("大小写不敏感匹配文本", () => {
    expect(matchNote(note("Hello World"), "world")).toBe(true);
    expect(matchNote(note("你好世界"), "世界")).toBe(true);
    expect(matchNote(note("abc"), "xyz")).toBe(false);
  });

  it("匹配来源应用名", () => {
    expect(matchNote(note("abc", "Safari"), "safa")).toBe(true);
  });
});

describe("splitHighlight", () => {
  it("无查询返回整段", () => {
    expect(splitHighlight("abc", "")).toEqual([{ text: "abc", hit: false }]);
  });

  it("切分多处命中", () => {
    expect(splitHighlight("aXbXc", "x")).toEqual([
      { text: "a", hit: false },
      { text: "X", hit: true },
      { text: "b", hit: false },
      { text: "X", hit: true },
      { text: "c", hit: false },
    ]);
  });

  it("命中在开头与结尾", () => {
    expect(splitHighlight("哈喽世界哈喽", "哈喽")).toEqual([
      { text: "哈喽", hit: true },
      { text: "世界", hit: false },
      { text: "哈喽", hit: true },
    ]);
  });
});
