import { describe, expect, it } from "vitest";

import type { Note } from "@/store/notesStore";
import { matchNote, matchSecretNote, splitHighlight } from "./search";

const note = (text: string, sourceApp?: string, tags?: string[]): Note => ({
  id: "x",
  text,
  sectionId: "inbox",
  done: false,
  createdAt: 0,
  sourceApp,
  tags,
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

  it("普通词也匹配标签；# 前缀只按标签前缀匹配", () => {
    const tagged = note("正文无关", undefined, ["前端评审", "架构"]);
    expect(matchNote(tagged, "评审")).toBe(true);
    expect(matchNote(tagged, "#前端")).toBe(true);
    // # 语法不混入正文命中：正文里出现的词按标签查不命中
    expect(matchNote(note("包含 前端 字样"), "#前端")).toBe(false);
    // # 后为空视为未输入完成，恒命中
    expect(matchNote(note("abc"), "#")).toBe(true);
  });
});

describe("matchSecretNote", () => {
  const secret = (cipher: string, keyLabel?: string): Note => ({
    id: "s",
    text: cipher,
    sectionId: "secret",
    kind: "secret",
    done: false,
    createdAt: 0,
    secretMeta: { keyId: "k", keyLabel, direction: "in" },
  });

  it("按密钥名命中，密文正文绝不参与匹配", () => {
    expect(matchSecretNote(secret("「话说霜叶」", "家人"), "家人")).toBe(true);
    expect(matchSecretNote(secret("「话说霜叶」", "家人"), "同事")).toBe(false);
    // 密文里的汉字不应被当作可搜索正文
    expect(matchSecretNote(secret("「话说霜叶孤舟」", "家人"), "霜叶")).toBe(false);
  });

  it("空查询恒命中；# 语法按标签匹配", () => {
    expect(matchSecretNote(secret("「话说x」"), "")).toBe(true);
    const tagged = { ...secret("「话说x」", "家人"), tags: ["八卦"] };
    expect(matchSecretNote(tagged, "#八卦")).toBe(true);
    expect(matchSecretNote(tagged, "#工作")).toBe(false);
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
