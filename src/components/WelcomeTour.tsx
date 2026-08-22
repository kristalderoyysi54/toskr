import { useState } from "react";
import { ChevronLeft } from "lucide-react";

import tourMergeArt from "@/assets/tour-merge.png";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import {
  WELCOME_TOUR_COPY,
  welcomeTourExitEvent,
  type WelcomeTourExitMode,
} from "@/lib/welcomeTour";
import { useNotesStore } from "@/store/notesStore";

interface TourPage {
  /** art 区主视觉（大字形；后续可替换为插画）。 */
  art: React.ReactNode;
  mini: string;
  title: string;
  body: string;
}

const WELCOME_TOUR_PAGES: readonly TourPage[] = [
  {
    art: (
      <span className="flex items-center gap-1 whitespace-nowrap text-micro font-medium">
        <span className="rounded-lg border border-paper-foreground/15 bg-background/50 px-1.5 py-1.5">
          文字 · 图片
        </span>
        <span aria-hidden>→</span>
        <span className="rounded-lg bg-paper-foreground px-2 py-1.5 text-paper">
          Toskr
        </span>
        <span aria-hidden>→</span>
        <span className="rounded-lg border border-paper-foreground/15 bg-background/50 px-1.5 py-1.5">
          AI 输入框
        </span>
      </span>
    ),
    ...WELCOME_TOUR_COPY[0],
  },
  {
    art: (
      <span className="flex items-center gap-1.5">
        <Kbd className="px-2.5 py-1.5 text-2xl">⇧</Kbd>
        <Kbd className="px-2.5 py-1.5 text-2xl">⇧</Kbd>
      </span>
    ),
    ...WELCOME_TOUR_COPY[1],
  },
  {
    art: (
      <img
        src={tourMergeArt}
        alt=""
        className="h-full w-full rounded-2xl object-cover"
      />
    ),
    ...WELCOME_TOUR_COPY[2],
  },
  {
    art: (
      <span className="flex items-center gap-2 text-label">
        <span className="rounded-lg border border-paper-foreground/15 bg-background/50 px-2 py-1.5 line-through opacity-60">
          demo@example.com
        </span>
        <span aria-hidden>→</span>
        <span className="rounded-lg border border-paper-foreground/20 bg-background/70 px-2 py-1.5 font-medium">
          [邮箱]
        </span>
      </span>
    ),
    ...WELCOME_TOUR_COPY[3],
  },
];

/**
 * 首启欢迎轮播：四屏说明“是什么 → 收集 → 粘贴 → 隐私”，
 * 末页可选衔接安全发送演练。看完/跳过持久化 welcomeTourSeen；
 * 设置 → 使用概览「重看导览」将其复位即可再次显示。
 */
export function WelcomeTour() {
  const [page, setPage] = useState(0);
  const current = WELCOME_TOUR_PAGES[page];
  const last = page === WELCOME_TOUR_PAGES.length - 1;

  const leaveTour = (mode: WelcomeTourExitMode) => {
    const store = useNotesStore.getState();
    const event = welcomeTourExitEvent(mode);
    store.setSettings({ welcomeTourSeen: true });
    if (event) store.transitionOnboarding(event);
  };
  const finish = () => leaveTour("use-now");
  const startRehearsal = () => leaveTour("rehearse");

  return (
    <div
      role="dialog"
      aria-label="新手导览"
      className="absolute inset-0 z-40 flex flex-col items-center justify-center bg-background/95 px-7 text-center backdrop-blur-sm"
    >
      <button
        onClick={finish}
        className="absolute right-4 top-3 rounded-md px-2 py-1 text-label text-muted-foreground outline-none transition-colors hover:text-foreground"
      >
        跳过导览
      </button>

      {/* key 重挂载：翻页时轻淡入（reduced-motion 下由全局 MotionConfig/CSS 静止） */}
      <div key={page} className="flex flex-col items-center animate-in fade-in duration-(--duration-overlay) motion-reduce:animate-none">
        <div className="relative mb-6 flex h-36 w-48 items-center justify-center rounded-2xl bg-paper text-paper-foreground">
          {current.art}
          <span className="absolute bottom-2.5 text-micro text-paper-foreground/80">{current.mini}</span>
        </div>
        <h3 className="mb-2 text-heading font-semibold">{current.title}</h3>
        <p className="mb-6 min-h-16 max-w-64 text-body leading-relaxed text-muted-foreground">
          {current.body}
        </p>
      </div>

      <div className="mb-5 flex items-center gap-1.5" aria-hidden>
        {WELCOME_TOUR_PAGES.map((_, index) => (
          <span
            key={index}
            className={cn(
              "h-1.5 rounded-full transition-[width,background-color] duration-(--duration-control)",
              index === page ? "w-4.5 bg-foreground" : "w-1.5 bg-foreground/15"
            )}
          />
        ))}
      </div>

      {last ? (
        <div className="flex flex-col items-center gap-2">
          <Button onClick={startRehearsal}>跟着示例试一次</Button>
          <Button variant="ghost" size="sm" onClick={finish}>
            直接开始使用
          </Button>
          <p className="max-w-64 text-micro text-muted-foreground">
            可在「设置 → 使用概览」重看介绍或运行示例
          </p>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          {page > 0 && (
            <Button variant="ghost" size="sm" onClick={() => setPage((value) => value - 1)}>
              <ChevronLeft data-icon="inline-start" />上一页
            </Button>
          )}
          <Button onClick={() => setPage((value) => value + 1)}>下一页</Button>
        </div>
      )}
    </div>
  );
}
