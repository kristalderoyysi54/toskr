import { applyDeliveryOutputCodec } from "@/lib/delivery/outputCodec";
import {
  targetProfileOutputPatch,
  type DeliveryOutputMode,
} from "@/lib/targetProfiles";

export const DEFAULT_DELIVERY_OUTPUT_PREVIEW_TEXT = [
  "# 项目更新",
  "",
  "- **完成**：修复发送",
  "- [查看文档](https://example.com)",
].join("\n");

export const MAX_DELIVERY_OUTPUT_PREVIEW_LENGTH = 4_000;

/** 设置页使用与发送链路相同的文字转换器，不触碰卡片或剪贴板。 */
export function buildDeliveryOutputPreview(
  sourceText: string,
  mode: DeliveryOutputMode
): string {
  const output = targetProfileOutputPatch(mode);
  return applyDeliveryOutputCodec(
    sourceText,
    output.defaultFormat,
    output.defaultMarkdownMode
  );
}
