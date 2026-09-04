/** 字符 / 单词（CJK 按字计）/ 行；单次扫描，避免大文本的数组与正则结果分配。 */
export function stats(text: string) {
  let chars = 0;
  let words = 0;
  let lines = 1;
  let inAsciiWord = false;

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    chars += 1;
    if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      index + 1 < text.length
    ) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        inAsciiWord = false;
        continue;
      }
    }
    if (code === 0x0a) lines += 1;
    const cjk =
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3040 && code <= 0x30ff);
    const asciiWord =
      (code >= 0x30 && code <= 0x39) ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      code === 0x5f ||
      code === 0x27 ||
      code === 0x2d;

    if (cjk) {
      words += 1;
      inAsciiWord = false;
    } else if (asciiWord) {
      if (!inAsciiWord) words += 1;
      inAsciiWord = true;
    } else {
      inAsciiWord = false;
    }
  }

  return { chars, words, lines };
}
