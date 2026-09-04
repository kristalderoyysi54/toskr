export function shouldResetPlaceholderHeight(
  previousEstimatedHeight: number,
  estimatedHeight: number,
  mounted: boolean
): boolean {
  return !mounted && previousEstimatedHeight !== estimatedHeight;
}
