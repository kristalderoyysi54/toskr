import { describe, expect, it } from "vitest";

import { imageFilePaths } from "./imageFiles";

describe("imageFilePaths", () => {
  it("按扩展名筛出可导入图片（大小写不敏感、中文/空格路径）", () => {
    expect(
      imageFilePaths([
        "/Users/kai/图 片/猫 咪.PNG",
        "/tmp/a.jpeg",
        "/tmp/b.webp",
        "/tmp/c.heic",
        "/tmp/d.pdf",
        "/tmp/noext",
        "/tmp/.png",
        "/tmp/dir.png/file",
      ])
    ).toEqual(["/Users/kai/图 片/猫 咪.PNG", "/tmp/a.jpeg", "/tmp/b.webp"]);
  });

  it("空列表原样返回", () => {
    expect(imageFilePaths([])).toEqual([]);
  });
});
