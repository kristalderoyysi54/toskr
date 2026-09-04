import { describe, expect, it } from "vitest";

import { stats } from "./textStats";

describe("stats", () => {
  it("keeps the existing CJK, ASCII word, Unicode character and line semantics", () => {
    expect(stats("Toskr-test 中文🙂\n第二行")).toEqual({
      chars: 18,
      words: 6,
      lines: 2,
    });
    expect(stats("")).toEqual({ chars: 0, words: 0, lines: 1 });
  });

  it("matches the previous implementation on punctuation and surrogate edges", () => {
    const legacyStats = (text: string) => ({
      chars: [...text].length,
      words: (text.match(/[一-鿿぀-ヿ]|[a-zA-Z0-9_'-]+/g) ?? []).length,
      lines: text.split("\n").length,
    });
    for (const text of [
      "alpha_beta isn't two",
      "中文、カタカナ。ひらがな",
      "🙂🙂\r\nnext",
      "a--b\n\n",
      "\ud800 lone surrogate",
    ]) {
      expect(stats(text)).toEqual(legacyStats(text));
    }
  });
});
