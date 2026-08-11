import { LoaderCircle, RotateCcw, Sparkles, Square, X } from "lucide-react";
import { useMemo, useState } from "react";

import { SimpleSelect, type SimpleSelectOption } from "@/components/SimpleSelect";
import { Button } from "@/components/ui/button";
import { describeAiClient } from "@/lib/aiClient";
import {
  applyOpenDraftTransform,
  cancelOpenDraftTransform,
  discardOpenDraftTransform,
  restoreOpenDraftTransform,
  runOpenDraftTransform,
  summarizeTransformChange,
  transformRecipe,
  TRANSFORM_RECIPES,
  type TransformRecipeId,
} from "@/lib/aiTransform";
import { evaluateDeliveryDraftFirewall } from "@/lib/delivery/firewallController";
import type { DeliveryDraft } from "@/lib/delivery/types";
import { cn } from "@/lib/utils";
import { useDeliveryStore } from "@/store/deliveryStore";
import { useNotesStore } from "@/store/notesStore";

const RECIPE_OPTIONS = TRANSFORM_RECIPES.map((recipe) => ({
  value: recipe.id,
  label: recipe.label,
})) satisfies readonly SimpleSelectOption<TransformRecipeId>[];

export function AiTransformPanel({
  draft,
  disabled,
  horizontal,
}: {
  draft: DeliveryDraft;
  disabled: boolean;
  horizontal: boolean;
}) {
  const [recipeId, setRecipeId] = useState<TransformRecipeId>("summarize");
  const transform = useDeliveryStore((state) => state.transform);
  const aiEnabled = useNotesStore((state) => state.settings.aiEnabled);
  const aiBaseUrl = useNotesStore((state) => state.settings.aiBaseUrl);
  const aiModel = useNotesStore((state) => state.settings.aiModel);
  const descriptor = useMemo(
    () => describeAiClient(undefined, { aiEnabled, aiBaseUrl, aiModel }),
    [aiBaseUrl, aiEnabled, aiModel]
  );
  const recipe = transformRecipe(recipeId)!;
  const firewall = evaluateDeliveryDraftFirewall(draft);
  const privacyReady = draft.firewallEnabled &&
    draft.firewallStatus === "ready" &&
    firewall.canSend;
  const request = transform.request;
  const result = transform.result;
  const provider = request?.provider ?? descriptor.provider;
  const model = request?.model ?? descriptor.model;
  const inputChars = request?.inputChars ?? draft.finalText.length;
  const beforeText = transform.status === "applied" && transform.restoreText !== null
    ? transform.restoreText
    : draft.finalText;
  const changeSummary = useMemo(
    () => result ? summarizeTransformChange(beforeText, result.text) : null,
    [beforeText, result]
  );
  const canStart = !disabled &&
    transform.status !== "running" &&
    !transform.transportPending &&
    descriptor.ready &&
    privacyReady;

  return (
    <section
      aria-label="AI 显式转换"
      className={cn(
        "space-y-2 rounded-lg border border-border/70 bg-background/40 p-2",
        horizontal && "space-y-1"
      )}
    >
      <div className="flex items-center gap-1.5">
        <Sparkles className="size-3.5 text-primary" aria-hidden />
        <h3 className="text-label font-medium">AI 转换预览</h3>
        <span className="ml-auto text-micro text-muted-foreground">
          仅点击后调用
        </span>
      </div>

      <div className="rounded-md bg-muted/50 p-1.5 text-micro text-muted-foreground">
        {horizontal ? (
          <p>
            {provider} · {model || "模型未配置"} · {inputChars} 字符 ·
            仅发送 Firewall 处理后的文本，图片附件不会发送
          </p>
        ) : (
          <>
            <p className="truncate">
              {provider} · {model || "模型未配置"} · {inputChars} 字符
            </p>
            <p>将发送 Firewall 处理后的最终文本；图片附件不会发送</p>
          </>
        )}
      </div>

      <div className="flex items-end gap-1.5">
        <label className="min-w-0 flex-1 space-y-1 text-label">
          <span className="sr-only">转换方式</span>
          <SimpleSelect
            value={recipeId}
            options={RECIPE_OPTIONS}
            ariaLabel="选择 AI 转换方式"
            size="micro"
            disabled={disabled || transform.status === "running"}
            onChange={setRecipeId}
          />
        </label>
        {transform.status === "running" ? (
          <Button
            type="button"
            size="xs"
            variant="secondary"
            onClick={cancelOpenDraftTransform}
          >
            <Square className="size-3" /> 取消
          </Button>
        ) : (
          <Button
            type="button"
            size="xs"
            variant="secondary"
            disabled={!canStart}
            onClick={() => void runOpenDraftTransform(recipeId)}
          >
            <Sparkles className="size-3" /> 生成预览
          </Button>
        )}
      </div>
      <p className={cn("text-micro text-muted-foreground", horizontal && "sr-only")}>
        {recipe.description}
      </p>

      {!descriptor.ready && (
        <p role="status" className="text-micro text-warning">
          请先在设置中启用 AI，并配置服务地址与模型
        </p>
      )}
      {!privacyReady && (
        <p role="status" className="text-micro text-warning">
          请先完成并处理本地隐私检查
        </p>
      )}
      {transform.status === "running" && (
        <p role="status" className="flex items-center gap-1 text-micro text-muted-foreground">
          <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" />
          正在生成候选；当前文本不会被覆盖
        </p>
      )}
      {transform.status === "cancelled" && (
        <p role="status" className="text-micro text-muted-foreground">
          已取消，迟到结果会被丢弃
        </p>
      )}
      {transform.error && (
        <p role="alert" className="text-micro text-warning">
          {transform.error}
        </p>
      )}

      {result && (
        <div className="space-y-1.5">
          <p
            role="status"
            className={cn(
              "text-micro",
              transform.status === "stale" ? "text-warning" : "text-muted-foreground"
            )}
          >
            {transform.status === "stale"
              ? "结果已过期：草稿已变化，只能查看或丢弃"
              : changeSummary}
          </p>
          <div className={cn("grid gap-1.5", horizontal && "grid-cols-2")}>
            <div className="min-w-0 rounded-md bg-muted/40 p-1.5">
              <p className="mb-1 text-micro font-medium text-muted-foreground">
                {transform.status === "stale" ? "当前文本" : "转换前"}
              </p>
              <pre className={cn(
                "max-h-24 overflow-auto whitespace-pre-wrap break-words font-mono text-micro",
                horizontal && "max-h-16"
              )}>
                {beforeText}
              </pre>
            </div>
            <div className="min-w-0 rounded-md bg-primary/5 p-1.5">
              <p className="mb-1 text-micro font-medium text-muted-foreground">
                AI 候选 · {result.provider} / {result.model}
              </p>
              <pre className={cn(
                "max-h-24 overflow-auto whitespace-pre-wrap break-words font-mono text-micro",
                horizontal && "max-h-16"
              )}>
                {result.text}
              </pre>
            </div>
          </div>
          <div className="flex flex-wrap justify-end gap-1">
            {(transform.status === "ready" || transform.status === "stale") && (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={disabled || transform.transportPending}
                onClick={discardOpenDraftTransform}
              >
                <X className="size-3" /> 丢弃候选
              </Button>
            )}
            {transform.status === "ready" && (
              <Button
                type="button"
                size="xs"
                variant="secondary"
                disabled={disabled || transform.transportPending}
                onClick={() => void applyOpenDraftTransform()}
              >
                应用为最终文本
              </Button>
            )}
            {transform.restoreText !== null && (
              <Button
                type="button"
                size="xs"
                variant="secondary"
                disabled={disabled}
                onClick={() => void restoreOpenDraftTransform()}
              >
                <RotateCcw className="size-3" /> 恢复转换前版本
              </Button>
            )}
          </div>
          {transform.status === "applied" && (
            <p className="text-micro text-muted-foreground">
              已应用；正在重新执行 Context Firewall，发送前仍需复核
            </p>
          )}
        </div>
      )}
    </section>
  );
}
