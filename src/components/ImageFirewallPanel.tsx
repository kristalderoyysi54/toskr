import { Image as ImageIcon, ShieldAlert, ShieldCheck } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  confirmOpenDeliveryImageRaw,
  containedImageRegionStyle,
  evaluateImageFirewallPolicy,
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
import { useNoteThumb } from "@/lib/media";
import { api } from "@/lib/tauri";
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
      redacted ? "w-48 grid-cols-2" : "w-24 grid-cols-1"
    )}>
      <div className="min-w-0 space-y-0.5 text-center">
        <AttachmentPreview
          url={originalUrl}
          label={`查看图片 ${index + 1} 原图`}
          title="点击查看原图"
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
        <p className="text-micro text-muted-foreground">原图</p>
      </div>
      {redacted && (
        <div className="min-w-0 space-y-0.5 text-center">
          <AttachmentPreview
            url={sendUrl}
            label={`查看图片 ${index + 1} 实际发送图`}
            title="点击查看实际发送图"
            onClick={() => void api.quickLook(sendFiles, index)}
          />
          <p className="text-micro font-medium text-success">实际发送</p>
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
  const hasUnresolved = draft.imageFirewall.some((item) =>
    item.findings.some(
      (finding) => !item.redactedFindingIds.includes(finding.id)
    )
  );
  const originalFiles = draft.imageFirewall.map((item) => item.originalFile);
  const sendFiles = draft.imageFirewall.map((item) => item.sendFile);
  return (
    <section
      aria-label="图片隐私检查"
      className="space-y-2 rounded-lg border border-border/70 p-2"
    >
      <div className="flex items-center gap-1.5">
        <ImageIcon className="size-3.5 text-warning" aria-hidden />
        <p className="text-label font-medium">
          图片隐私检查 · {draft.imageFirewall.length} 张
        </p>
        <span className="ml-auto text-micro text-muted-foreground">
          {evaluation.canSend ? "可发送" : evaluation.reason ?? "等待检查"}
        </span>
      </div>
      <p className="text-micro text-muted-foreground">
        OCR 仅在本机运行；首版使用不可逆纯色遮挡，原图不会修改
      </p>
      <div className="space-y-2">
        {draft.imageFirewall.map((item, index) => {
          const redacted = new Set(item.redactedFindingIds);
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
              <div className="flex gap-2">
                <AttachmentComparison
                  item={item}
                  index={index}
                  originalFiles={originalFiles}
                  sendFiles={sendFiles}
                />
                <div className="min-w-0 flex-1 text-micro">
                  <p className="font-medium">图片 {index + 1}</p>
                  <p className={cn(
                    item.status === "failed"
                      ? "text-destructive"
                      : item.status === "ready"
                        ? "text-muted-foreground"
                        : "text-warning"
                  )}>
                    {item.status === "idle"
                      ? "等待 OCR"
                      : item.status === "scanning"
                        ? "本地 OCR 中…"
                        : item.status === "redacting"
                          ? "正在生成发送副本…"
                          : item.status === "failed"
                            ? item.failureMessage
                            : item.status === "disabled"
                              ? "检查已关闭 · 发送原图"
                              : item.sendFile === item.originalFile
                                ? `${item.findings.length} 项 · 发送原图`
                                : `${item.redactedFindingIds.length} 项已遮挡 · 发送副本`}
                  </p>
                  {item.width && item.height && (
                    <p className="text-muted-foreground">
                      {item.width} × {item.height}
                    </p>
                  )}
                </div>
              </div>
              {item.findings.length > 0 && (
                <ul className="space-y-1" aria-label={`图片 ${index + 1} 敏感区域`}>
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
                      <span>{FIREWALL_CATEGORY_LABEL[finding.category]}</span>
                      <span className={finding.severity === "block" ? "text-destructive" : "text-warning"}>
                        {FIREWALL_SEVERITY_LABEL[finding.severity]}
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
                        {redacted.has(finding.id) ? "已遮挡" : "遮挡此文字区域"}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex flex-wrap gap-1">
                {item.findings.length > 0 &&
                  item.redactedFindingIds.length < item.findings.length && (
                    <Button
                      type="button"
                      size="xs"
                      variant="secondary"
                      disabled={busy || item.status !== "ready"}
                      onClick={() => void redactOpenDeliveryImage(item.originalFile)}
                    >
                      遮挡此图全部
                    </Button>
                  )}
                {item.sendFile !== item.originalFile && (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    disabled={busy || item.status !== "ready"}
                    onClick={() => restoreOpenDeliveryImage(item.originalFile)}
                  >
                    恢复发送原图
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
                    重试 OCR
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
                      ? "确认发送未经 OCR 的原图"
                      : itemPolicy.needsRawConfirmation === "block"
                        ? "再次确认保留图中高风险原文"
                        : "确认保留图中提示级原文"}
                  </Button>
                )}
              </div>
            </article>
          );
        })}
      </div>
      {hasUnresolved && (
        <Button
          type="button"
          size="xs"
          variant="secondary"
          disabled={busy || draft.imageFirewall.some(
            (item) => item.status === "scanning" || item.status === "redacting"
          )}
          onClick={() => void redactAllOpenDeliveryImages()}
        >
          遮挡全部图片敏感区域
        </Button>
      )}
    </section>
  );
}
