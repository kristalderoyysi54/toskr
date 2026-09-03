import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("../TextPreviewView.tsx", import.meta.url)),
  "utf8"
);

describe("detail editor bottom dock hit testing", () => {
  it("lets text receive clicks through the dock gradient", () => {
    const dockStart = source.indexOf("{/* 底部操作坞");
    const dockEnd = source.indexOf("</DetailWindowFrame>", dockStart);
    const dock = source.slice(dockStart, dockEnd);

    expect(dockStart).toBeGreaterThan(-1);
    expect(dock).toContain(
      '"pointer-events-none absolute inset-x-0 bottom-0 z-30'
    );
    expect(dock).toContain(
      '? "[&>*]:pointer-events-auto translate-y-0 opacity-100"'
    );
  });

  it("keeps image actions above the bottom dock stacking layer", () => {
    expect(source).toContain(
      'className="relative z-40 mb-12 flex shrink-0 gap-1.5 overflow-x-auto'
    );
    expect(source).toContain(
      '"pointer-events-none absolute inset-x-0 bottom-0 z-30'
    );
  });
});
