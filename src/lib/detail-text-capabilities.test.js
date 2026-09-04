import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("../TextPreviewView.tsx", import.meta.url)),
  "utf8"
);

const section = (startMarker, endMarker) => {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
};

describe("detail text capabilities", () => {
  it("keeps native text selection available for code and link details", () => {
    const selectionSync = section(
      "const syncPreviewSelection = () =>",
      "syncPreviewSelectionRef.current = syncPreviewSelection"
    );

    expect(selectionSync).not.toContain("note.codeLang");
    expect(selectionSync).not.toContain('note.kind === "link"');
    expect(source).toMatch(
      /ref=\{previewContentRef as React\.RefObject<HTMLPreElement>\}[\s\S]{0,220}className="hljs/
    );
  });

  it("shows the shared selection toolbar for code and link details", () => {
    const toolbarPolicy = section(
      "const selectionToolbarOpen =",
      "const anySelectionSendOpen ="
    );

    expect(toolbarPolicy).not.toContain("note.codeLang");
    expect(toolbarPolicy).not.toContain("isLink");
  });

  it("offers pick mode without filtering by detected content type", () => {
    const keyboardPolicy = section(
      "const onPickModeKey = (event: KeyboardEvent)",
      'window.addEventListener("keydown", onPickModeKey)'
    );
    const viewDock = section(
      ") : (\n          <>",
      "{!mixedContent && isMd && !pickMode"
    );

    expect(keyboardPolicy).not.toContain("current.codeLang");
    expect(keyboardPolicy).not.toContain('current.kind === "link"');
    expect(viewDock).not.toContain("note.codeLang");
    expect(viewDock).not.toContain("!isLink");
    expect(viewDock).toContain("enterPickMode");
    expect(source.indexOf(") : pickMode ? (")).toBeLessThan(
      source.indexOf(") : note.codeLang ? (")
    );
  });
});
