import { ask } from "@tauri-apps/plugin-dialog";
import {
  Check,
  FileText,
  Image as ImageIcon,
  Link2,
  ShieldAlert,
  X,
} from "lucide-react";
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
  retainExplicitResultSelection,
  resultCapturedEvent,
  resultNoteCandidatesForDelivery,
  type ResultReturnRequest,
} from "@/lib/resultReturn";
import { currentDataGeneration, matchesDataGeneration } from "@/lib/dataGeneration";
import { imageListLabel, previewOf } from "@/lib/format";
import { useNoteThumb } from "@/lib/media";
import { tip } from "@/lib/tip";
import { cn } from "@/lib/utils";
import { isDataOperationLocked } from "@/store/dataOperationStore";
import {
  useNotesStore,
  type Note,
  type NoteProvenance,
  type Task,
} from "@/store/notesStore";

type ChoiceMode = "delivery" | "note";
const EMPTY_NOTES: readonly Note[] = [];
const EMPTY_TASKS: readonly Task[] = [];

function localTime(timestampMs: number): string {
  return new Date(timestampMs).toLocaleString("zh-CN", { hour12: false });
}

function noteImageCount(note: Note): number {
  return (note.imageFile ? 1 : 0) + (note.attachments?.length ?? 0);
}

function notePreview(note: Note): string {
  const title = note.title?.trim();
  if (title) return title;
  if (note.kind === "image" || note.imageFile) {
    return imageListLabel(note, noteImageCount(note));
  }
  return previewOf(note.text) || "空白卡片";
}

function deliverySourcePreview(
  delivery: DeliveryEvent,
  notesById: ReadonlyMap<string, Note>,
  tasksById: ReadonlyMap<string, Task>
): string {
  const items = delivery.sourceKind === "task"
    ? delivery.sourceItemIds
        .map((id) => tasksById.get(id)?.text)
        .filter((text): text is string => !!text)
        .map(previewOf)
    : delivery.sourceItemIds
        .map((id) => notesById.get(id))
        .filter((note): note is Note => !!note)
        .map(notePreview);
  if (!items.length) return "原内容已不存在";
  return items.length > 1 ? `${items[0]}，另有 ${items.length - 1} 项` : items[0];
}

function ResultNoteThumb({ note }: { note: Note }) {
  const thumb = useNoteThumb(note.imageFile);
  if (thumb) {
    return (
      <img
        src={thumb}
        alt="回复卡片缩略图"
        className="size-10 shrink-0 rounded-md object-cover ring-1 ring-foreground/10"
      />
    );
  }
  return (
    <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
      {note.imageFile
        ? <ImageIcon className="size-4" aria-hidden />
        : <FileText className="size-4" aria-hidden />}
    </span>
  );
}

export function ResultLinkChoices({
  mode,
  deliveries,
  notes,
  sourceNotes = EMPTY_NOTES,
  sourceTasks = EMPTY_TASKS,
  selectedId,
  onSelect,
}: {
  mode: ChoiceMode;
  deliveries: readonly DeliveryEvent[];
  notes: readonly Note[];
  sourceNotes?: readonly Note[];
  sourceTasks?: readonly Task[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const sourceNotesById = useMemo(
    () => new Map(sourceNotes.map((note) => [note.id, note])),
    [sourceNotes]
  );
  const sourceTasksById = useMemo(
    () => new Map(sourceTasks.map((task) => [task.id, task])),
    [sourceTasks]
  );
  const empty = mode === "delivery" ? deliveries.length === 0 : notes.length === 0;
  if (empty) {
    return (
      <p className="rounded-lg bg-muted/50 px-2 py-5 text-center text-body text-muted-foreground">
        {mode === "delivery"
          ? "找不到可对应的发送记录"
          : "这次发送后还没有从目标应用捕获卡片"}
      </p>
    );
  }
  return (
    <div role="radiogroup" aria-label={mode === "delivery" ? "选择对应发送" : "选择对应回复"} className="space-y-2">
      {mode === "delivery"
        ? deliveries.map((delivery) => (
            <button
              key={delivery.deliveryId}
              type="button"
              role="radio"
              aria-checked={selectedId === delivery.deliveryId}
              onClick={() => onSelect(delivery.deliveryId)}
              className={cn(
                "flex w-full items-start gap-2.5 rounded-xl border px-2.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                selectedId === delivery.deliveryId
                  ? "border-primary/45 bg-primary/8"
                  : "border-foreground/10 bg-muted/30 hover:bg-muted/55"
              )}
            >
              <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-foreground/25">
                {selectedId === delivery.deliveryId && <Check className="size-3 text-primary" aria-hidden />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-2 text-title font-semibold">
                  <span className="truncate">{delivery.targetAppName || delivery.targetBundleId || "未识别目标"}</span>
                  <time className="ml-auto shrink-0 text-label font-normal tabular-nums text-muted-foreground">
                    {localTime(delivery.timestampMs)}
                  </time>
                </span>
                <span className="mt-0.5 block truncate text-body text-foreground/90">
                  发送内容：{deliverySourcePreview(delivery, sourceNotesById, sourceTasksById)}
                </span>
                <span className="mt-0.5 block text-label text-muted-foreground">
                  {delivery.textCharCount ? `${delivery.textCharCount} 字文字` : "无文字"}
                  {delivery.imageCount ? ` · ${delivery.imageCount} 张图片` : ""}
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
                "flex w-full items-start gap-2.5 rounded-xl border px-2.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                selectedId === note.id
                  ? "border-primary/45 bg-primary/8"
                  : "border-foreground/10 bg-muted/30 hover:bg-muted/55"
              )}
            >
              <ResultNoteThumb note={note} />
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-2 text-title font-semibold">
                  <span className="truncate">{note.sourceApp || note.sourceBundle || "未知来源"}</span>
                  <time className="ml-auto shrink-0 text-label font-normal tabular-nums text-muted-foreground">
                    {localTime(note.createdAt)}
                  </time>
                </span>
                <span className="mt-0.5 flex items-center gap-1 text-body text-foreground/90">
                  <span className="truncate">{notePreview(note)}</span>
                  <span className="ml-auto flex size-4 shrink-0 items-center justify-center rounded-full border border-foreground/25">
                    {selectedId === note.id && <Check className="size-3 text-primary" aria-hidden />}
                  </span>
                </span>
                <span className="mt-0.5 block text-label text-muted-foreground">
                  回复候选{note.imageFile ? " · 图片卡" : ` · ${[...note.text].length} 字`}
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
  const tasks = useNotesStore((state) => state.tasks);
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
      const confirmed = await ask("只会移除这次发送与回复卡的对应关系，不会删除回复卡或内容。确认继续吗？", {
        title: "这不是对应回复",
        kind: "warning",
      });
      if (!confirmed || !matchesDataGeneration(generation) || isDataOperationLocked()) return;
      const current = useNotesStore.getState().notes.find((item) => item.id === noteId);
      if (current?.provenance?.deliveryId !== expected) {
        tip("warn", "回复对应关系已变化，请重试");
        return;
      }
      useNotesStore.getState().setNoteProvenance(noteId, undefined);
      window.dispatchEvent(new Event(RESULT_LINK_CHANGED_EVENT));
      tip("ok", "已移除对应关系，回复卡保持不变");
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
            if (sequence.current === requestId) setError("最近发送读取失败，请稍后重试");
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
  const notesById = useMemo(
    () => new Map(notes.map((note) => [note.id, note])),
    [notes]
  );
  const tasksById = useMemo(
    () => new Map(tasks.map((task) => [task.id, task])),
    [tasks]
  );
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
    const retained = retainExplicitResultSelection(selectedId, candidateIds);
    if (retained !== selectedId) setSelectedId(retained);
  }, [candidateIds, loading, request, selectedId]);

  const applyLink = async () => {
    if (!request || !selectedId || busy || isDataOperationLocked()) return;
    if (!matchesDataGeneration(request.dataGeneration)) {
      setError("数据目录已变化，请重新选择回复");
      return;
    }
    const delivery = request.kind === "linkNote"
      ? deliveryCandidates.find((item) => item.deliveryId === selectedId)
      : request.delivery;
    const note = request.kind === "linkNote"
      ? useNotesStore.getState().notes.find((item) => item.id === request.noteId)
      : useNotesStore.getState().notes.find((item) => item.id === selectedId);
    if (!delivery || !note || !delivery.targetBundleId) {
      setError("可选内容已变化，请重新选择");
      return;
    }
    const stillCandidate = request.kind === "linkNote"
      ? deliveryCandidatesForCapturedNote(note, [delivery]).length === 1
      : resultNoteCandidatesForDelivery(delivery, [note]).length === 1;
    if (!stillCandidate) {
      setError("这项内容已不再符合条件，请重新选择");
      return;
    }
    if (note.provenance?.deliveryId === delivery.deliveryId) {
      tip("info", "这张卡片已经是该发送的回复");
      reset();
      return;
    }
    const previous = note.provenance?.deliveryId ?? null;
    if (previous) {
      const confirmed = await ask("这会把回复卡从原发送移到当前选择的发送。确认继续吗？", {
        title: "更换对应发送",
        kind: "warning",
      });
      if (!confirmed) return;
      const current = useNotesStore.getState().notes.find((item) => item.id === note.id);
      if (current?.provenance?.deliveryId !== previous) {
        setError("回复对应关系已变化，请重试");
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
      setError("回复卡已不存在");
      return;
    }
    setBusy(true);
    const recorded = await recordDeliveryEvent(resultCapturedEvent(delivery, note.id));
    window.dispatchEvent(new Event(RESULT_LINK_CHANGED_EVENT));
    reset();
    tip(recorded ? "ok" : "warn", recorded ? "回复已保存到对应发送" : "回复已保存，但发送记录更新失败");
  };

  const open = !!request || !!preview;
  const mode: ChoiceMode = request?.kind === "linkNote" ? "delivery" : "note";
  const candidateCount = mode === "delivery"
    ? deliveryCandidates.length
    : noteCandidates.length;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => !next && reset()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[70] bg-background/70 data-open:animate-in data-open:fade-in-0 duration-100 motion-reduce:!animate-none" />
        <div className="pointer-events-none fixed inset-0 z-[71] grid place-items-center p-2">
          <DialogPrimitive.Content
            data-toskr-modal="result-link"
            className={cn(
              "pointer-events-auto flex max-h-[min(34rem,calc(100vh-1rem))] w-full max-w-[25rem] flex-col overflow-hidden rounded-2xl p-3 outline-none duration-100 data-open:animate-in data-open:fade-in-0 motion-reduce:!animate-none",
              floatingSurface(3),
              "bg-surface-raised"
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
              <DialogPrimitive.Title className="text-heading font-semibold">
                {preview
                  ? "恢复占位符预览"
                  : request?.kind === "linkNote"
                    ? "这张卡片是哪次回复？"
                    : "选择这次发送的回复"}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="mt-0.5 text-label leading-relaxed text-muted-foreground">
                {preview
                  ? `仅在当前会话临时显示 · 已恢复 ${preview.replacedCount} 处，不会保存`
                  : "选择后可从发送记录查看和检查回复；不会修改卡片内容。"}
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close asChild><IconButton label="关闭回复选择" size="sm"><X /></IconButton></DialogPrimitive.Close>
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
                <section aria-label="本次发送内容" className="mt-2 rounded-lg border border-foreground/10 bg-muted/35 p-2">
                  <p className="text-label text-muted-foreground">这次发送</p>
                  <p className="mt-0.5 flex min-w-0 items-center gap-2 text-title font-semibold">
                    <span className="truncate">{request.delivery.targetAppName || request.delivery.targetBundleId || "未识别目标"}</span>
                    <time className="ml-auto shrink-0 text-label font-normal tabular-nums text-muted-foreground">
                      {localTime(request.delivery.timestampMs)}
                    </time>
                  </p>
                  <p className="mt-1 truncate text-body text-foreground/90">
                    发送内容：{deliverySourcePreview(request.delivery, notesById, tasksById)}
                  </p>
                </section>
              )}
              {request?.kind === "linkNote" && currentNote && (
                <section aria-label="当前回复卡片" className="mt-2 flex items-center gap-2 rounded-lg border border-foreground/10 bg-muted/35 p-2">
                  <ResultNoteThumb note={currentNote} />
                  <div className="min-w-0 flex-1">
                    <p className="text-label text-muted-foreground">当前卡片</p>
                    <p className="mt-0.5 truncate text-title font-semibold">{notePreview(currentNote)}</p>
                    <p className="mt-0.5 text-label text-muted-foreground">
                      来自 {currentNote.sourceApp || currentNote.sourceBundle || "未知应用"} · {localTime(currentNote.createdAt)}
                    </p>
                  </div>
                </section>
              )}
              {error && <p role="alert" className="mt-2 rounded-lg bg-destructive/10 px-2 py-1.5 text-body text-destructive">{error}</p>}
              {!loading && candidateCount > 0 && (
                <p className={cn(
                  "mt-2 rounded-lg px-2 py-1.5 text-body leading-relaxed",
                  candidateCount > 1
                    ? "bg-warning/10 text-warning"
                    : "bg-muted/45 text-muted-foreground"
                )}>
                  {candidateCount > 1
                    ? `找到 ${candidateCount} 个可能选项。请根据内容确认，不要只看时间；不确定就先取消。`
                    : "请确认它确实是这次发送产生的回复，再保存。"}
                </p>
              )}
              <div className="mt-2 min-h-0 flex-1 overflow-y-auto pr-0.5">
                {loading ? (
                  <p role="status" className="py-5 text-center text-body text-muted-foreground">读取候选中…</p>
                ) : (
                  <ResultLinkChoices
                    mode={mode}
                    deliveries={deliveryCandidates}
                    notes={noteCandidates}
                    sourceNotes={notes}
                    sourceTasks={tasks}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                  />
                )}
              </div>
              <footer className="mt-2 flex items-center justify-end gap-1.5 border-t border-border/70 pt-2">
                <DialogPrimitive.Close asChild><Button type="button" size="sm" variant="ghost">取消</Button></DialogPrimitive.Close>
                <Button type="button" size="sm" disabled={loading || busy || !selectedId} onClick={() => void applyLink()}>
                  <Link2 className="size-3.5" aria-hidden /> {busy ? "保存中…" : "保存回复"}
                </Button>
              </footer>
            </>
          )}
          </DialogPrimitive.Content>
        </div>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
