import { ask } from "@tauri-apps/plugin-dialog";
import { Check, Link2, ShieldAlert, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";

import { Button } from "@/components/ui/button";
import { floatingSurface } from "@/components/ui/floating-surface";
import { IconButton } from "@/components/ui/icon-button";
import {
  DELIVERY_ACTIVITY_MAX_EVENTS,
  getRecentDeliveryEvents,
  recordDeliveryEvent,
  type DeliveryEvent,
} from "@/lib/deliveryActivity";
import {
  RESULT_LINK_CHANGED_EVENT,
  RESULT_RETURN_REQUEST_EVENT,
  deliveryCandidatesForCapturedNote,
  deliveryRedactionMapAvailable,
  previewRestoredPlaceholders,
  resultCapturedEvent,
  resultNoteCandidatesForDelivery,
  type ResultReturnRequest,
} from "@/lib/resultReturn";
import { currentDataGeneration, matchesDataGeneration } from "@/lib/dataGeneration";
import { tip } from "@/lib/tip";
import { cn } from "@/lib/utils";
import { isDataOperationLocked } from "@/store/dataOperationStore";
import { useNotesStore, type Note, type NoteProvenance } from "@/store/notesStore";

type ChoiceMode = "delivery" | "note";

function localTime(timestampMs: number): string {
  return new Date(timestampMs).toLocaleString("zh-CN", { hour12: false });
}

export function ResultLinkChoices({
  mode,
  deliveries,
  notes,
  selectedId,
  onSelect,
}: {
  mode: ChoiceMode;
  deliveries: readonly DeliveryEvent[];
  notes: readonly Note[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const empty = mode === "delivery" ? deliveries.length === 0 : notes.length === 0;
  if (empty) {
    return (
      <p className="rounded-lg bg-muted/50 px-2 py-5 text-center text-body text-muted-foreground">
        {mode === "delivery" ? "没有符合条件的最近投递" : "没有符合条件的现有卡片"}
      </p>
    );
  }
  return (
    <div role="radiogroup" aria-label={mode === "delivery" ? "选择投递" : "选择结果卡片"} className="space-y-1.5">
      {mode === "delivery"
        ? deliveries.map((delivery) => (
            <button
              key={delivery.deliveryId}
              type="button"
              role="radio"
              aria-checked={selectedId === delivery.deliveryId}
              onClick={() => onSelect(delivery.deliveryId)}
              className={cn(
                "flex w-full items-start gap-2 rounded-lg border px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
                selectedId === delivery.deliveryId
                  ? "border-primary/45 bg-primary/8"
                  : "border-foreground/10 bg-muted/30 hover:bg-muted/55"
              )}
            >
              <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-foreground/25">
                {selectedId === delivery.deliveryId && <Check className="size-3 text-primary" aria-hidden />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-2 text-body font-medium">
                  <span className="truncate">{delivery.targetAppName || delivery.targetBundleId || "未识别目标"}</span>
                  <time className="ml-auto shrink-0 text-micro font-normal tabular-nums text-muted-foreground">
                    {localTime(delivery.timestampMs)}
                  </time>
                </span>
                <span className="mt-0.5 block text-micro text-muted-foreground">
                  来源 {delivery.sourceItemIds.length} 项 · {delivery.textCharCount} 字符{delivery.imageCount ? ` · ${delivery.imageCount} 图` : ""}
                </span>
              </span>
            </button>
          ))
        : notes.map((note) => (
            <button
              key={note.id}
              type="button"
              role="radio"
              aria-checked={selectedId === note.id}
              onClick={() => onSelect(note.id)}
              className={cn(
                "flex w-full items-start gap-2 rounded-lg border px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
                selectedId === note.id
                  ? "border-primary/45 bg-primary/8"
                  : "border-foreground/10 bg-muted/30 hover:bg-muted/55"
              )}
            >
              <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-foreground/25">
                {selectedId === note.id && <Check className="size-3 text-primary" aria-hidden />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-2 text-body font-medium">
                  <span className="truncate">{note.sourceApp || note.sourceBundle || "未知来源"}</span>
                  <time className="ml-auto shrink-0 text-micro font-normal tabular-nums text-muted-foreground">
                    {localTime(note.createdAt)}
                  </time>
                </span>
                <span className="mt-0.5 block text-micro text-muted-foreground">
                  捕获结果 · {[...note.text].length} 字符{note.imageFile ? " · 含图片" : ""}
                </span>
              </span>
            </button>
          ))}
    </div>
  );
}

type LinkRequest = Extract<ResultReturnRequest, { kind: "linkNote" | "linkDelivery" }> & {
  requestId: number;
  dataGeneration: number;
};

type PreviewState = { noteId: string; text: string; replacedCount: number };

export function ResultLinkDialog() {
  const notes = useNotesStore((state) => state.notes);
  const [request, setRequest] = useState<LinkRequest | null>(null);
  const [deliveries, setDeliveries] = useState<DeliveryEvent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const sequence = useRef(0);
  const returnFocus = useRef<HTMLElement | null>(null);

  const reset = () => {
    sequence.current += 1;
    setRequest(null);
    setDeliveries([]);
    setSelectedId(null);
    setLoading(false);
    setBusy(false);
    setError(null);
    setPreview(null);
  };

  useEffect(() => {
    const unlink = async (noteId: string) => {
      const generation = currentDataGeneration();
      const note = useNotesStore.getState().notes.find((item) => item.id === noteId);
      if (!note?.provenance) return;
      const expected = note.provenance.deliveryId;
      const confirmed = await ask("只解除这张结果卡的投递来源关联，不会删除卡片或正文。确认继续吗？", {
        title: "解除投递关联",
        kind: "warning",
      });
      if (!confirmed || !matchesDataGeneration(generation) || isDataOperationLocked()) return;
      const current = useNotesStore.getState().notes.find((item) => item.id === noteId);
      if (current?.provenance?.deliveryId !== expected) {
        tip("warn", "卡片关联已变化，请重试");
        return;
      }
      useNotesStore.getState().setNoteProvenance(noteId, undefined);
      window.dispatchEvent(new Event(RESULT_LINK_CHANGED_EVENT));
      tip("ok", "已解除投递关联，卡片内容保持不变");
    };

    const showPreview = async (noteId: string) => {
      const generation = currentDataGeneration();
      const note = useNotesStore.getState().notes.find((item) => item.id === noteId);
      if (!note?.provenance) return;
      if (!deliveryRedactionMapAvailable(note.provenance.deliveryId)) {
        tip("info", "本次会话没有可用的占位符映射；重启后不会保留");
        return;
      }
      const confirmed = await ask("临时预览会在本机显示脱敏前内容。预览不会写回卡片或活动记录，确认显示吗？", {
        title: "恢复占位符预览",
        kind: "warning",
      });
      if (!confirmed || !matchesDataGeneration(generation)) return;
      const current = useNotesStore.getState().notes.find((item) => item.id === noteId);
      if (current?.provenance?.deliveryId !== note.provenance.deliveryId) return;
      const restored = previewRestoredPlaceholders(note.provenance.deliveryId, current.text);
      if (!restored?.replacedCount) {
        tip("info", "这张结果卡中没有可恢复的占位符");
        return;
      }
      setRequest(null);
      setPreview({ noteId, ...restored });
    };

    const onRequest = (raw: Event) => {
      const detail = (raw as CustomEvent<ResultReturnRequest>).detail;
      if (!detail) return;
      if (detail.kind === "close") {
        reset();
        return;
      }
      if (detail.kind === "unlink") {
        returnFocus.current = detail.returnFocus ?? null;
        void unlink(detail.noteId);
        return;
      }
      if (detail.kind === "preview") {
        returnFocus.current = detail.returnFocus ?? null;
        void showPreview(detail.noteId);
        return;
      }
      const requestId = ++sequence.current;
      returnFocus.current = detail.returnFocus ?? null;
      const next: LinkRequest = {
        ...detail,
        requestId,
        dataGeneration: currentDataGeneration(),
      };
      setPreview(null);
      setRequest(next);
      setDeliveries(detail.kind === "linkDelivery" ? [detail.delivery] : []);
      setSelectedId(null);
      setError(null);
      setLoading(detail.kind === "linkNote");
      if (detail.kind === "linkNote") {
        void getRecentDeliveryEvents(DELIVERY_ACTIVITY_MAX_EVENTS)
          .then((events) => {
            if (sequence.current !== requestId) return;
            setDeliveries(events);
          })
          .catch(() => {
            if (sequence.current === requestId) setError("最近投递读取失败，请稍后重试");
          })
          .finally(() => {
            if (sequence.current === requestId) setLoading(false);
          });
      }
    };
    window.addEventListener(RESULT_RETURN_REQUEST_EVENT, onRequest);
    return () => window.removeEventListener(RESULT_RETURN_REQUEST_EVENT, onRequest);
  }, []);

  const currentNote = request?.kind === "linkNote"
    ? notes.find((note) => note.id === request.noteId) ?? null
    : null;
  const deliveryCandidates = useMemo(
    () => currentNote ? deliveryCandidatesForCapturedNote(currentNote, deliveries) : [],
    [currentNote, deliveries]
  );
  const selectedDelivery = request?.kind === "linkDelivery" ? request.delivery : null;
  const noteCandidates = useMemo(
    () => selectedDelivery ? resultNoteCandidatesForDelivery(selectedDelivery, notes) : [],
    [notes, selectedDelivery]
  );
  const candidateIds = useMemo(
    () => request?.kind === "linkNote"
      ? deliveryCandidates.map((item) => item.deliveryId)
      : noteCandidates.map((item) => item.id),
    [deliveryCandidates, noteCandidates, request?.kind]
  );

  useEffect(() => {
    if (!request || loading) return;
    if (!selectedId || !candidateIds.includes(selectedId)) {
      setSelectedId(candidateIds[0] ?? null);
    }
  }, [candidateIds, loading, request, selectedId]);

  const applyLink = async () => {
    if (!request || !selectedId || busy || isDataOperationLocked()) return;
    if (!matchesDataGeneration(request.dataGeneration)) {
      setError("数据目录已变化，请重新打开关联入口");
      return;
    }
    const delivery = request.kind === "linkNote"
      ? deliveryCandidates.find((item) => item.deliveryId === selectedId)
      : request.delivery;
    const note = request.kind === "linkNote"
      ? useNotesStore.getState().notes.find((item) => item.id === request.noteId)
      : useNotesStore.getState().notes.find((item) => item.id === selectedId);
    if (!delivery || !note || !delivery.targetBundleId) {
      setError("候选已变化，请重新选择");
      return;
    }
    const stillCandidate = request.kind === "linkNote"
      ? deliveryCandidatesForCapturedNote(note, [delivery]).length === 1
      : resultNoteCandidatesForDelivery(delivery, [note]).length === 1;
    if (!stillCandidate) {
      setError("候选已过期或来源应用已变化");
      return;
    }
    if (note.provenance?.deliveryId === delivery.deliveryId) {
      tip("info", "这张卡片已经关联到该投递");
      reset();
      return;
    }
    const previous = note.provenance?.deliveryId ?? null;
    if (previous) {
      const confirmed = await ask("这张卡片已经关联到另一条投递。确认改绑吗？", {
        title: "更改投递关联",
        kind: "warning",
      });
      if (!confirmed) return;
      const current = useNotesStore.getState().notes.find((item) => item.id === note.id);
      if (current?.provenance?.deliveryId !== previous) {
        setError("卡片关联已变化，请重试");
        return;
      }
    }
    if (
      sequence.current !== request.requestId ||
      !matchesDataGeneration(request.dataGeneration) ||
      isDataOperationLocked()
    ) return;
    const provenance: NoteProvenance = {
      kind: "deliveryResult",
      deliveryId: delivery.deliveryId,
      capturedAtMs: note.createdAt,
      sourceBundle: delivery.targetBundleId,
      sourceItemIds: [...delivery.sourceItemIds],
    };
    if (!useNotesStore.getState().setNoteProvenance(note.id, provenance)) {
      setError("结果卡已不存在");
      return;
    }
    setBusy(true);
    const recorded = await recordDeliveryEvent(resultCapturedEvent(delivery, note.id));
    window.dispatchEvent(new Event(RESULT_LINK_CHANGED_EVENT));
    reset();
    tip(recorded ? "ok" : "warn", recorded ? "已关联到投递结果" : "卡片已关联，但活动记录写入失败");
  };

  const open = !!request || !!preview;
  const mode: ChoiceMode = request?.kind === "linkNote" ? "delivery" : "note";

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => !next && reset()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[70] bg-background/55 backdrop-blur-sm data-open:animate-in data-open:fade-in-0 duration-100 motion-reduce:!animate-none" />
        <DialogPrimitive.Content className={cn(
          "fixed left-1/2 top-1/2 z-[71] flex max-h-[min(34rem,calc(100vh-1rem))] w-[min(25rem,calc(100vw-1rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl p-3 outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 motion-reduce:!animate-none",
          floatingSurface(3)
        )}
          onCloseAutoFocus={(event) => {
            const target = returnFocus.current;
            if (!target?.isConnected) return;
            event.preventDefault();
            target.focus();
            returnFocus.current = null;
          }}
        >
          <header className="flex items-start gap-2 border-b border-border/70 pb-2">
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title className="text-title font-semibold">
                {preview ? "恢复占位符预览" : request?.kind === "linkNote" ? "关联到最近投递" : "关联现有卡片"}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="mt-0.5 text-micro leading-relaxed text-muted-foreground">
                {preview
                  ? `仅在当前会话临时显示 · 已恢复 ${preview.replacedCount} 处，不会保存`
                  : "关联只保存来源 ID 与时间等元数据，不复制投递或结果正文。"}
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close asChild><IconButton label="关闭结果关联" size="sm"><X /></IconButton></DialogPrimitive.Close>
          </header>
          {preview ? (
            <div className="mt-2 min-h-0 overflow-y-auto">
              <p className="mb-2 flex items-center gap-1 rounded-lg bg-warning/10 px-2 py-1.5 text-label text-warning">
                <ShieldAlert className="size-3.5 shrink-0" aria-hidden /> 此处可能包含敏感原文，关闭即清除预览
              </p>
              <pre className="whitespace-pre-wrap break-words rounded-xl bg-muted/60 p-2 text-body leading-relaxed">{preview.text}</pre>
            </div>
          ) : (
            <>
              {request?.kind === "linkDelivery" && (
                <p className="mt-2 rounded-lg bg-muted/45 px-2 py-1.5 text-label text-muted-foreground">
                  目标 {request.delivery.targetAppName || request.delivery.targetBundleId || "未识别"}
                  {` · ${localTime(request.delivery.timestampMs)} · 来源 ${request.delivery.sourceItemIds.length} 项`}
                </p>
              )}
              {error && <p role="alert" className="mt-2 rounded-lg bg-destructive/10 px-2 py-1.5 text-body text-destructive">{error}</p>}
              <div className="mt-2 min-h-0 flex-1 overflow-y-auto pr-0.5">
                {loading ? (
                  <p role="status" className="py-5 text-center text-body text-muted-foreground">读取候选中…</p>
                ) : (
                  <ResultLinkChoices
                    mode={mode}
                    deliveries={deliveryCandidates}
                    notes={noteCandidates}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                  />
                )}
              </div>
              <footer className="mt-2 flex items-center justify-end gap-1.5 border-t border-border/70 pt-2">
                <DialogPrimitive.Close asChild><Button type="button" size="sm" variant="ghost">取消</Button></DialogPrimitive.Close>
                <Button type="button" size="sm" disabled={loading || busy || !selectedId} onClick={() => void applyLink()}>
                  <Link2 className="size-3.5" aria-hidden /> {busy ? "记录中…" : "确认关联"}
                </Button>
              </footer>
            </>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
