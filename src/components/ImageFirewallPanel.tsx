import { Image as ImageIcon, ShieldAlert, ShieldCheck } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  confirmOpenDeliveryImageRaw,
  containedImageRegionStyle,
  evaluateImageFirewallPolicy,
  keepOpenDeliveryImageFinding,
  keepOpenDeliveryImageFindings,
  redactAllOpenDeliveryImages,
  redactOpenDeliveryImage,
  restoreOpenDeliveryImage,
  retryOpenDeliveryImageScan,
  type ImageFirewallEvaluation,
} from "@/lib/delivery/imageFirewall";
import type { DeliveryDraft, ImageFirewallItem } from "@/lib/delivery/types";
import {
  FIREWALL_CATEGORY_LABEL,
  FIREWALL_SEVERITY_LABEL,
} from "@/lib/delivery/firewall";
import { findingReason } from "@/lib/delivery/findingReason";
import { useT } from "@/lib/i18n";
import { useNoteThumb } from "@/lib/media";
import { api, type FindingCategory } from "@/lib/tauri";
import { cn } from "@/lib/utils";

function AttachmentImage({
  url,
}: {
  url: string | null;
}) {
  return url ? (
    <img
      src={url}
      alt=""
      className="size-full object-contain"
    />
  ) : (
    <span
      aria-hidden
      className="flex size-full items-center justify-center text-muted-foreground"
    >
      <ImageIcon className="size-4" aria-hidden />
    </span>
  );
}

function AttachmentPreview({
  url,
  label,
  title,
  onClick,
  children,
}: {
  url: string | null;
  label: string;
  title: string;
  onClick: () => void;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      onClick={onClick}
      className={cn(
        "relative aspect-[4/3] w-full cursor-zoom-in overflow-hidden rounded-md bg-muted/60 outline-none ring-1 ring-foreground/10",
        "hover:ring-primary/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
      )}
    >
      <AttachmentImage url={url} />
      {children}
    </button>
  );
}

function AttachmentComparison({
  item,
  index,
  originalFiles,
  sendFiles,
}: {
  item: ImageFirewallItem;
  index: number;
  originalFiles: string[];
  sendFiles: string[];
}) {
  const t = useT();
  const originalUrl = useNoteThumb(item.originalFile);
  const redacted = item.sendFile !== item.originalFile;
  const [sendUrl, setSendUrl] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setSendUrl(null);
    if (!redacted) return () => { active = false; };
    void api.deliveryImageDataUrl(item.sendFile)
      .then((url) => {
        if (active) setSendUrl(url);
      })
      .catch(() => {});
    return () => { active = false; };
  }, [item.sendFile, redacted]);
  return (
    <div className={cn(
      "grid min-w-0 shrink gap-1.5",
      redacted ? "w-48 max-w-full grid-cols-2" : "w-24 max-w-full grid-cols-1"
    )}>
      <div className="min-w-0 space-y-0.5 text-center">
        <AttachmentPreview
          url={originalUrl}
          label={t("查看图片 {n} 原图", { n: index + 1 })}
          title={t("点击查看原图")}
          onClick={() => void api.quickLook(originalFiles, index)}
        >
          {item.findings.map((finding) => (
            <span
              key={finding.id}
              aria-hidden
              className={cn(
                "pointer-events-none absolute border",
                item.redactedFindingIds.includes(finding.id)
                  ? "border-success bg-success/20"
                  : finding.severity === "block"
                    ? "border-destructive bg-destructive/20"
                    : "border-warning bg-warning/20"
              )}
              style={containedImageRegionStyle(
                finding.boundingBox,
                item.width,
                item.height
              )}
            />
          ))}
        </AttachmentPreview>
        <p className="text-micro text-muted-foreground">{t("原图")}</p>
      </div>
      {redacted && (
        <div className="min-w-0 space-y-0.5 text-center">
          <AttachmentPreview
            url={sendUrl}
            label={t("查看图片 {n} 实际发送图", { n: index + 1 })}
            title={t("点击查看实际发送图")}
            onClick={() => void api.quickLook(sendFiles, index)}
          />
          <p className="text-micro font-medium text-success">{t("实际发送")}</p>
        </div>
      )}
    </div>
  );
}

export function ImageFirewallPanel({
  draft,
  busy,
  evaluation,
}: {
  draft: DeliveryDraft;
  busy: boolean;
  evaluation: ImageFirewallEvaluation;
}) {
  const t = useT();
  const hasUnresolved = draft.imageFirewall.some((item) =>
    item.findings.some(
      (finding) => !item.redactedFindingIds.includes(finding.id)
    )
  );
  // 各类别尚未遮挡/保留的区域数（跨图片），决定是否提供「同类全部保留」
  const pendingByCategory = new Map<FindingCategory, number>();
  for (const item of draft.imageFirewall) {
    if (item.status !== "ready") continue;
    for (const finding of item.findings) {
      if (item.redactedFindingIds.includes(finding.id) || item.keptFindingIds.includes(finding.id)) continue;
      pendingByCategory.set(finding.category, (pendingByCategory.get(finding.category) ?? 0) + 1);
    }
  }
  const originalFiles = draft.imageFirewall.map((item) => item.originalFile);
  const sendFiles = draft.imageFirewall.map((item) => item.sendFile);
  return (
    <section
      aria-label={t("图片隐私检查")}
      className="space-y-2 rounded-lg border border-border/70 p-2"
    >
      <div className="flex items-center gap-1.5">
        <ImageIcon className="size-3.5 text-warning" aria-hidden />
        <p className="text-label font-medium">
          {t("图片隐私检查 · {n} 张", { n: draft.imageFirewall.length })}
        </p>
        <span className="ml-auto text-micro text-muted-foreground">
          {evaluation.canSend ? t("可发送") : evaluation.reason ?? t("等待检查")}
        </span>
      </div>
      <p className="text-micro text-muted-foreground">
        {t("OCR 仅在本机运行；自动与手动打码都使用不可逆纯色遮挡，原图不会修改")}
      </p>
      <div className="space-y-2">
        {draft.imageFirewall.map((item, index) => {
          const redacted = new Set(item.redactedFindingIds);
          const kept = new Set(item.keptFindingIds);
          const itemPolicy = evaluateImageFirewallPolicy({
            enabled: draft.firewallEnabled,
            items: [item],
            policy: draft.privacyPolicy,
            targetToken: draft.targetSnapshot?.token ?? null,
          });
          return (
            <article
              key={item.originalFile}
              className="space-y-1.5 rounded-md bg-background/60 p-1.5"
            >
              <div className="min-w-0 space-y-2">
                <AttachmentComparison
                  item={item}
                  index={index}
                  originalFiles={originalFiles}
                  sendFiles={sendFiles}
                />
                <div className="min-w-0 break-words text-micro">
                  <p className="font-medium">{t("图片 {n}", { n: index + 1 })}</p>
                  <p className={cn(
                    item.status === "failed"
                      ? "text-destructive"
                      : item.status === "ready"
                        ? "text-muted-foreground"
                        : "text-warning"
                  )}>
                    {item.status === "idle"
                      ? t("等待 OCR")
                      : item.status === "scanning"
                        ? t("本地 OCR 中…")
                        : item.status === "redacting"
                          ? t("正在生成发送副本…")
                          : item.status === "failed"
                            ? `${item.failureMessage}${
                                item.manualRegions.length ? ` · ${t("已应用手动打码")}` : ""
                              }`
                            : item.status === "disabled"
                              ? item.sendFile === item.originalFile
                                ? t("检查已关闭 · 发送原图")
                                : t("检查已关闭 · {n} 个手工区域已遮挡 · 发送副本", { n: item.manualRegions.length })
                              : item.sendFile === item.originalFile
                                ? t("{n} 项 · 发送原图", { n: item.findings.length })
                                : t("{found} 项识别区域、{manual} 个手工区域已遮挡 · 发送副本", {
                                    found: item.redactedFindingIds.length,
                                    manual: item.manualRegions.length,
                                  })}
                  </p>
                  {item.width && item.height && (
                    <p className="text-muted-foreground">
                      {item.width} × {item.height}
                    </p>
                  )}
                </div>
              </div>
              {item.findings.length > 0 && (
                <ul className="space-y-1" aria-label={t("图片 {n} 敏感区域", { n: index + 1 })}>
                  {item.findings.map((finding) => (
                    <li
                      key={finding.id}
                      className="flex flex-wrap items-center gap-1 rounded-md bg-muted/50 px-1.5 py-1 text-micro"
                    >
                      {redacted.has(finding.id) ? (
                        <ShieldCheck className="size-3 text-success" aria-hidden />
                      ) : (
                        <ShieldAlert className="size-3 text-warning" aria-hidden />
                      )}
                      <span>{t(FIREWALL_CATEGORY_LABEL[finding.category])}</span>
                      <span className={finding.severity === "block" ? "text-destructive" : "text-warning"}>
                        {t(FIREWALL_SEVERITY_LABEL[finding.severity])}
                      </span>
                      <code className="min-w-0 flex-1 truncate text-muted-foreground">
                        {finding.maskedPreview}
                      </code>
                      <Button
                        type="button"
                        size="xs"
                        variant="secondary"
                        disabled={busy || item.status !== "ready" || redacted.has(finding.id)}
                        onClick={() => void redactOpenDeliveryImage(
                          item.originalFile,
                          finding.id
                        )}
                      >
                        {redacted.has(finding.id) ? t("已遮挡") : t("遮挡此文字区域")}
                      </Button>
                      {!redacted.has(finding.id) && (
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          className="text-muted-foreground"
                          title={t("不遮挡这一处，按原样发出（仅本次发送有效）")}
                          disabled={busy || item.status !== "ready" || kept.has(finding.id)}
                          onClick={() => keepOpenDeliveryImageFinding(
                            item.originalFile,
                            finding.id
                          )}
                        >
                          {kept.has(finding.id) ? t("已确认保留原文") : t("保留原文发送")}
                        </Button>
                      )}
                      {!redacted.has(finding.id) && !kept.has(finding.id) &&
                        (pendingByCategory.get(finding.category) ?? 0) > 1 && (
                          <Button
                            type="button"
                            size="xs"
                            variant="ghost"
                            className="text-muted-foreground"
                            title={t("所有图片里这一类都不遮挡，按原样发出（仅本次发送有效）")}
                            disabled={busy || item.status !== "ready"}
                            onClick={() => keepOpenDeliveryImageFindings(finding.category)}
                          >
                            {t("同类全部保留")}
                          </Button>
                        )}
                      <details className="w-full min-w-0 text-muted-foreground">
                        <summary className="cursor-pointer">{t("命中依据")}</summary>
                        <p className="mt-1 break-words">{findingReason(finding)}</p>
                      </details>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex flex-wrap gap-1">
                <Button
                  type="button"
                  size="xs"
                  disabled={
                    busy ||
                    !["ready", "failed", "disabled"].includes(item.status)
                  }
                  onClick={() => void api.quickLook(
                    [item.sendFile],
                    0,
                    undefined,
                    {
                      kind: "delivery",
                      draftId: draft.id,
                      draftRevision: draft.revision,
                      originalFile: item.originalFile,
                      startEditing: true,
                    }
                  )}
                >
                  {t("手动打码")}
                </Button>
                {item.findings.length > 0 &&
                  item.redactedFindingIds.length < item.findings.length && (
                    <Button
                      type="button"
                      size="xs"
                      variant="secondary"
                      disabled={busy || item.status !== "ready"}
                      onClick={() => void redactOpenDeliveryImage(item.originalFile)}
                    >
                      {t("遮挡此图全部")}
                    </Button>
                  )}
                {item.sendFile !== item.originalFile && (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    disabled={busy || !["ready", "failed", "disabled"].includes(item.status)}
                    onClick={() => restoreOpenDeliveryImage(item.originalFile)}
                  >
                    {t("恢复发送原图")}
                  </Button>
                )}
                {item.status === "failed" && (
                  <Button
                    type="button"
                    size="xs"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => retryOpenDeliveryImageScan(item.originalFile)}
                  >
                    {t("重试 OCR")}
                  </Button>
                )}
                {itemPolicy.needsRawConfirmation && (
                  <Button
                    type="button"
                    size="xs"
                    variant="secondary"
                    disabled={busy || item.status === "scanning" || item.status === "redacting"}
                    onClick={() => confirmOpenDeliveryImageRaw(
                      item.originalFile,
                      itemPolicy.needsRawConfirmation!
                    )}
                  >
                    {item.status === "failed"
                      ? t("确认发送未经 OCR 的原图")
                      : itemPolicy.needsRawConfirmation === "block"
                        ? t("再次确认保留图中高风险原文")
                        : t("确认保留图中提示级原文")}
                  </Button>
                )}
              </div>
            </article>
          );
        })}
      </div>
      {hasUnresolved && (
        <div className="flex flex-wrap gap-1.5">
          <Button
            type="button"
            size="xs"
            variant="secondary"
            disabled={busy || draft.imageFirewall.some(
              (item) => item.status === "scanning" || item.status === "redacting"
            )}
            onClick={() => void redactAllOpenDeliveryImages()}
          >
            {t("遮挡全部图片敏感区域")}
          </Button>
          {pendingByCategory.size > 0 && (
            <Button
              type="button"
              size="xs"
              title={t("本次图片全部不遮挡，按原图发出；文字脱敏不受影响")}
              disabled={busy || draft.imageFirewall.some(
                (item) => item.status === "scanning" || item.status === "redacting"
              )}
              onClick={() => keepOpenDeliveryImageFindings()}
            >
              {t("图片全部不遮挡")}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
