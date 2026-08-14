/**
 * 秘文页：本地中文密写的收发中心。
 * 顶部 Composer 把明文加密成中文密文串（走既有发送链路发去 IM，或降级复制）；
 * 下方卡片列表默认磨砂遮罩、点击解密显现、可重新遮罩，面板隐藏/失焦/超时自动回遮罩。
 * 明文永不落盘：卡片 text 存密文信封，解密仅在内存，收起即丢弃。
 */

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import {
  Copy,
  EyeOff,
  KeyRound,
  Lock,
  LockOpen,
  SendHorizontal,
  ShieldCheck,
  Trash2,
} from "lucide-react";

import { deleteNotesWithUndo, sendNotesToChat } from "@/lib/actions";
import { timeAgo } from "@/lib/media";
import { tweenFade, tweenMenu } from "@/lib/motion";
import {
  estimateCipherLength,
  openFromChinese,
  sealToChinese,
} from "@/lib/secret/secret";
import { tip } from "@/lib/tip";
import { api } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useNotesStore, type Note } from "@/store/notesStore";
import { useUIStore } from "@/store/uiStore";
import { EmptyState } from "@/components/ui/empty-state";
import { floatingSurface } from "@/components/ui/floating-surface";
import { IconButton } from "@/components/ui/icon-button";
import { SimpleSelect } from "@/components/SimpleSelect";

const FIELD =
  "w-full rounded-lg border border-border bg-transparent px-2.5 py-2 text-body text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-primary/50";

/** 顶部收发条：选密钥 → 输明文 → 加密发送 / 加密复制。 */
function SecretComposer() {
  const keys = useNotesStore((s) => s.settings.secretKeys);
  const defaultKeyId = useNotesStore((s) => s.settings.secretDefaultKeyId);
  const [draft, setDraft] = useState("");
  const [keyId, setKeyId] = useState<string>(defaultKeyId ?? keys[0]?.id ?? "");
  const [busy, setBusy] = useState(false);

  // 密钥增删后保证选择项仍有效
  useEffect(() => {
    if (!keys.some((k) => k.id === keyId)) {
      setKeyId(defaultKeyId ?? keys[0]?.id ?? "");
    }
  }, [keys, defaultKeyId, keyId]);

  if (keys.length === 0) {
    return (
      <div className="border-b border-border/60 px-3 py-2.5 text-label text-muted-foreground">
        还没有共享密钥。去 设置 → 秘文 添加一组、与对方约定相同的暗号即可开始收发。
      </div>
    );
  }

  const seal = async (send: boolean) => {
    const key = keys.find((k) => k.id === keyId);
    const text = draft.trim();
    if (!key || !text || busy) return;
    setBusy(true);
    try {
      const cipher = await sealToChinese(text, key.passphrase);
      const { id } = useNotesStore.getState().addSecretNote(cipher, {
        keyId: key.id,
        keyLabel: key.label,
        direction: "out",
      });
      setDraft("");
      if (send && id) {
        // 走既有 ⌘⏎ 发送链路：发的是密文，目标就绪校验/焦点归还/剪贴板还原全复用
        void sendNotesToChat([id]);
      } else {
        await api.copyText(cipher);
        tip("ok", "已加密并复制，去 IM 粘贴即可");
      }
    } catch {
      tip("warn", "加密失败，请重试");
    } finally {
      setBusy(false);
    }
  };

  const keyOptions = keys.map((k) => ({
    value: k.id,
    label: k.label || "未命名密钥",
  }));

  return (
    <div className="flex flex-col gap-2 border-b border-border/60 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <KeyRound className="size-3.5 shrink-0 text-muted-foreground" />
        <SimpleSelect
          value={keyId}
          options={keyOptions}
          onChange={setKeyId}
          ariaLabel="选择加密密钥"
          menuLabel="用哪把密钥"
        />
      </div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void seal(true);
          }
        }}
        rows={2}
        placeholder="写下要加密的话，⌘⏎ 加密并发送"
        className={FIELD + " resize-none"}
      />
      <div className="flex items-center justify-end gap-2">
        {draft.trim() && (
          <span className="mr-auto text-micro text-muted-foreground">
            密文约 {estimateCipherLength(draft.trim())} 字 · 以「话说」开头
          </span>
        )}
        <button
          onClick={() => void seal(false)}
          disabled={busy || !draft.trim()}
          className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-label text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
        >
          <Copy className="size-3.5" /> 加密复制
        </button>
        <button
          onClick={() => void seal(true)}
          disabled={busy || !draft.trim()}
          className="flex items-center gap-1 rounded-lg bg-paper px-3 py-1.5 text-label font-medium text-paper-foreground outline-none hover:brightness-105 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
        >
          <SendHorizontal className="size-3.5" /> 加密发送
        </button>
      </div>
    </div>
  );
}

/** 单张秘文卡：默认遮罩，点击解密显现，可重新遮罩；多重兜底自动回遮罩。 */
function SecretCard({ note }: { note: Note }) {
  const secretKeys = useNotesStore((s) => s.settings.secretKeys);
  const revealTimeout = useNotesStore((s) => s.settings.secretRevealTimeoutMs);
  const open = useUIStore((s) => s.open);
  const [plain, setPlain] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timerRef = useRef<number | null>(null);
  const revealed = plain !== null;
  const meta = note.secretMeta ?? { keyId: null, direction: "in" as const };
  const outgoing = meta.direction === "out";

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };
  const remask = () => {
    clearTimer();
    setPlain(null);
  };

  const toggle = async () => {
    if (revealed) {
      remask();
      return;
    }
    if (busy) return;
    setBusy(true);
    try {
      // 对当前全部密钥逐把试解（不依赖存储 keyId）：补配/重建密钥后锁定卡自愈
      const res = await openFromChinese(note.text, secretKeys);
      if (res.status !== "plaintext") {
        tip("warn", "无匹配密钥，去 设置 → 秘文 添加后可解密");
        return;
      }
      setPlain(res.plaintext);
      if (res.keyId !== meta.keyId || res.keyLabel !== meta.keyLabel) {
        useNotesStore
          .getState()
          .setSecretMeta(note.id, { keyId: res.keyId, keyLabel: res.keyLabel });
      }
      clearTimer();
      if (revealTimeout > 0) {
        timerRef.current = window.setTimeout(() => setPlain(null), revealTimeout);
      }
    } catch {
      tip("warn", "解密失败");
    } finally {
      setBusy(false);
    }
  };

  // 面板隐藏 → 立即回遮罩
  useEffect(() => {
    if (!open) remask();
  }, [open]);

  // 窗口失焦 / 切后台 → 回遮罩（覆盖面板常驻场景），卸载清理定时器
  useEffect(() => {
    const onBlur = () => remask();
    const onVis = () => {
      if (document.hidden) remask();
    };
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVis);
      clearTimer();
    };
  }, []);

  return (
    <div className="rounded-lg border border-border/70 bg-card">
      <div className="flex items-center gap-1.5 px-3 pt-2 text-micro text-muted-foreground">
        {outgoing ? (
          <SendHorizontal className="size-3" />
        ) : (
          <ShieldCheck className="size-3" />
        )}
        <span className="font-medium">
          {meta.keyLabel ?? (meta.keyId ? "已解密" : "未匹配密钥")}
        </span>
        <span aria-hidden>·</span>
        <span>{outgoing ? "我发出" : "收到"}</span>
        <span className="ml-auto tabular-nums">{timeAgo(note.createdAt)}</span>
      </div>

      <button
        onClick={() => void toggle()}
        aria-label={revealed ? "重新遮罩" : "点击解密查看"}
        className="block w-full px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <AnimatePresence mode="wait" initial={false}>
          {revealed ? (
            // 解密显现 = 「对上焦」：明文从虚化中浮出，呼应遮罩态的虚化密文
            <motion.div
              key="plain"
              initial={{ opacity: 0, filter: "blur(6px)" }}
              animate={{ opacity: 1, filter: "blur(0px)" }}
              exit={{ opacity: 0, transition: tweenMenu }}
              transition={{ duration: 0.3, ease: [0.2, 0.9, 0.3, 1] }}
              className="flex items-start gap-2"
            >
              <LockOpen className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <span className="whitespace-pre-wrap break-words text-body text-foreground">
                {plain}
              </span>
            </motion.div>
          ) : (
            // 遮罩态：展示真实密文的虚化片段（密文本就发在 IM 里、非机密），
            // 比一排圆点更有「封着一段话」的实感；明文仍绝不进 DOM
            <motion.div
              key="mask"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={tweenFade}
              className="relative py-0.5"
            >
              <p
                aria-hidden
                className="line-clamp-2 select-none text-body leading-relaxed text-muted-foreground/80 blur-xs"
              >
                {[...note.text].slice(0, 72).join("")}
              </p>
              <span
                className={cn(
                  "absolute inset-0 m-auto flex h-fit w-fit items-center gap-1.5 rounded-full px-2.5 py-1 text-label text-muted-foreground",
                  floatingSurface(2)
                )}
              >
                {busy ? (
                  <span className="animate-pulse">解密中…</span>
                ) : meta.keyId === null ? (
                  <>
                    <KeyRound className="size-3" /> 无匹配密钥 · 点击重试
                  </>
                ) : (
                  <>
                    <Lock className="size-3" /> 点击解密查看
                  </>
                )}
              </span>
            </motion.div>
          )}
        </AnimatePresence>
      </button>

      {/* 倒计时燃尽条：显现期间从满格匀速烧到零，烧完即回遮罩（与定时器同步同长） */}
      {revealed && revealTimeout > 0 && (
        <div className="mx-3 h-0.5 overflow-hidden rounded-full bg-border/40">
          <motion.div
            initial={{ scaleX: 1 }}
            animate={{ scaleX: 0 }}
            transition={{ duration: revealTimeout / 1000, ease: "linear" }}
            style={{ transformOrigin: "left" }}
            className="h-full rounded-full bg-warning"
          />
        </div>
      )}

      <div className="flex items-center justify-end gap-1 px-2 pb-1.5 pt-0.5">
        {revealed && (
          <>
            <IconButton
              label="重新遮罩"
              size="xs"
              onClick={() => remask()}
            >
              <EyeOff />
            </IconButton>
            <IconButton
              label="复制明文"
              size="xs"
              onClick={() => {
                if (plain !== null) {
                  void api.copyText(plain);
                  tip("ok", "已复制明文");
                }
              }}
            >
              <Copy />
            </IconButton>
          </>
        )}
        <IconButton
          label="删除"
          size="xs"
          tone="danger"
          onClick={() => deleteNotesWithUndo([note.id], "已删除 1 条秘文")}
        >
          <Trash2 />
        </IconButton>
      </div>
    </div>
  );
}

export function SecretPage({ notes, query }: { notes: Note[]; query: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SecretComposer />
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
        {notes.length === 0 ? (
          <EmptyState
            icon={<Lock />}
            title={query ? "没有匹配的秘文" : "还没有秘文"}
            hint={
              query
                ? "换个关键词试试（只按密钥名/标题/标签搜索）"
                : "选中对方发来的中文密文，连按两次 ⇧ Shift 即可解密到这里"
            }
          />
        ) : (
          <div className="flex flex-col gap-2">
            {notes.map((n) => (
              <SecretCard key={n.id} note={n} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
