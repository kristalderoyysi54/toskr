import type { FirewallFinding } from "./tauri";

function splitsSurrogatePair(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false;
  const previous = text.charCodeAt(offset - 1);
  const next = text.charCodeAt(offset);
  return (
    previous >= 0xd800 &&
    previous <= 0xdbff &&
    next >= 0xdc00 &&
    next <= 0xdfff
  );
}

/** Rust finding 使用 UTF-16 offset；先校验边界再交给 JS slice/highlight。 */
export function findingUtf16RangeIsValid(
  text: string,
  finding: Pick<FirewallFinding, "startUtf16" | "endUtf16">
): boolean {
  const { startUtf16, endUtf16 } = finding;
  return (
    Number.isSafeInteger(startUtf16) &&
    Number.isSafeInteger(endUtf16) &&
    startUtf16 >= 0 &&
    startUtf16 < endUtf16 &&
    endUtf16 <= text.length &&
    !splitsSurrogatePair(text, startUtf16) &&
    !splitsSurrogatePair(text, endUtf16)
  );
}

export function findingSourceText(
  text: string,
  finding: Pick<FirewallFinding, "startUtf16" | "endUtf16">
): string | null {
  return findingUtf16RangeIsValid(text, finding)
    ? text.slice(finding.startUtf16, finding.endUtf16)
    : null;
}
