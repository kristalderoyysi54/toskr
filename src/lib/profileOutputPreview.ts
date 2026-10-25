import { applyDeliveryOutputCodec } from "@/lib/delivery/outputCodec";
import { t } from "@/lib/i18n";
import {
  targetProfileOutputPatch,
  type DeliveryOutputMode,
} from "@/lib/targetProfiles";

/** 预览示例按当前语言生成；只作可编辑的初始测试内容。 */
export function defaultDeliveryOutputPreviewText(): string {
  return [
    t("# 项目更新"),
    "",
    t("- **完成**：修复发送"),
    t("- [查看文档](https://example.com)"),
  ].join("\n");
}

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
