import { useState } from "react";
import { ChevronLeft } from "lucide-react";

import tourMergeArt from "@/assets/tour-merge.png";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import { useNotesStore } from "@/store/notesStore";

interface TourPage {
  /** art 区主视觉（大字形；后续可替换为插画）。 */
  art: React.ReactNode;
  mini: string;
  title: string;
  body: string;
}

const PAGES: TourPage[] = [
  {
    art: (
      <span className="flex items-center gap-1.5">
        <Kbd className="px-2.5 py-1.5 text-2xl">⇧</Kbd>
        <Kbd className="px-2.5 py-1.5 text-2xl">⇧</Kbd>
      </span>
    ),
    mini: "双击 Shift",
    title: "随手一划，收进队列",
    body: "在任何应用里选中文字或图片，双击 Shift 即刻捕获——不打断当前工作，右上角气泡确认入库。",
  },
  {
    art: <span className="text-4xl">🗂</span>,
    mini: "剪贴 · 笔记 · 任务",
    title: "三个页面，各管一摊",
    body: "剪贴板历史自动收集；笔记是待发送的队列；任务管到期提醒。消息监听、秘文、订阅在设置里按需开启。",
  },
  {
    art: (
      <span className="flex items-center gap-1.5">
        <Kbd className="px-2.5 py-1.5 text-2xl">⌘</Kbd>
        <Kbd className="px-2.5 py-1.5 text-2xl">⏎</Kbd>
      </span>
    ),
    mini: "焦点归还 → 粘贴 → 还原剪贴板",
    title: "一键发回对话",
    body: "勾选卡片按 ⌘⏎，Toskr 自动切回目标窗口粘贴发送；目标未就绪会安全中止，绝不误发。",
  },
  {
    art: (
      <img
        src={tourMergeArt}
        alt=""
        className="h-full w-full rounded-2xl object-cover"
      />
    ),
    mini: "⌘ 点选 · Shift 范围选",
    title: "多张卡片，合并一次发出",
    body: "多选几张卡再发送，内容会按顺序自动合并成一条消息——拼报错日志、凑上下文，一步到位。",
  },
  {
    art: <span className="text-4xl">🎭</span>,
    mini: "发出化名 · 收回还原",
    title: "隐私过滤，来回自动",
    body: "发送前自动做敏感信息检查；配置过的名字、订单号等会替换成化名再发出，捕获对方回复时本机自动还原——真实信息不出本机。",
  },
  {
    art: <span className="text-4xl">🚀</span>,
    mini: "设置 → 通用 可随时重看",
    title: "准备好了",
    body: "选中一段文字双击 ⇧ 试试吧；也可以先跟着安全演练完整走一遍发送流程。",
  },
];

/**
 * 首启欢迎轮播（方案 B，用户 2026-08-19 选定）：介绍核心功能与特色，
 * 末页衔接既有安全发送演练。看完/跳过持久化 welcomeTourSeen；
 * 设置 → 通用「重看导览」将其复位即可再次显示。
 */
export function WelcomeTour() {
  const [page, setPage] = useState(0);
  const current = PAGES[page];
  const last = page === PAGES.length - 1;

  const finish = () => useNotesStore.getState().setSettings({ welcomeTourSeen: true });
  const startRehearsal = () => {
    finish();
    useNotesStore.getState().transitionOnboarding({ type: "start" });
  };

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
        跳过
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
        {PAGES.map((_, index) => (
          <span
            key={index}
            className={cn(
              "h-1.5 rounded-full transition-all duration-(--duration-control)",
              index === page ? "w-4.5 bg-foreground" : "w-1.5 bg-foreground/15"
            )}
          />
        ))}
      </div>

      {last ? (
        <div className="flex flex-col items-center gap-2">
          <Button onClick={finish}>开始使用</Button>
          <Button variant="ghost" size="sm" onClick={startRehearsal}>
            先做一次安全发送演练
          </Button>
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
