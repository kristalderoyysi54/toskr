import { Button } from "@/components/ui/button";
import {
  WELCOME_TOUR_COPY,
  welcomeTourExitEvent,
  type WelcomeTourExitMode,
} from "@/lib/welcomeTour";
import { useNotesStore } from "@/store/notesStore";
import { useUIStore } from "@/store/uiStore";

/** 首启只介绍一次收集与粘贴；用户选择尝试后才开始实际操作。 */
export function WelcomeTour() {
  const leaveTour = (mode: WelcomeTourExitMode) => {
    const store = useNotesStore.getState();
    const event = welcomeTourExitEvent(mode);
    if (event) {
      const ui = useUIStore.getState();
      ui.setContentSubview("notes");
      ui.setPage("notes");
    }
    store.setSettings({ welcomeTourSeen: true });
    if (event) store.transitionOnboarding(event);
  };

  return (
    <div
      role="dialog"
      aria-label="新手导览"
      className="absolute inset-0 z-40 overflow-y-auto overscroll-contain bg-background/95 backdrop-blur-sm"
    >
      <div className="mx-auto grid min-h-full w-full max-w-3xl content-center gap-6 px-5 py-6 sm:grid-cols-2 sm:gap-x-8">
        <header className="sm:col-start-1 sm:row-start-1">
          <p className="mb-2 text-label text-muted-foreground">欢迎使用 Toskr</p>
          <h3 className="text-heading font-semibold">{WELCOME_TOUR_COPY.title}</h3>
          <p className="mt-2 text-body leading-relaxed text-muted-foreground">
            {WELCOME_TOUR_COPY.body}
          </p>
        </header>

        <ol
          aria-label="收集到粘贴的示例"
          className="space-y-3 rounded-xl border border-border/60 bg-card p-3 sm:col-start-2 sm:row-span-2 sm:row-start-1 sm:self-center"
        >
          <li>
            <p className="mb-1 text-label text-muted-foreground">1 · 选中一句话</p>
            <p className="text-body leading-relaxed">
              <span className="rounded-sm bg-primary/15 px-1 text-foreground">
                {WELCOME_TOUR_COPY.sample}
              </span>
            </p>
          </li>
          <li>
            <p className="mb-1 text-label text-muted-foreground">2 · 收成一张卡片</p>
            <p className="rounded-lg border border-border bg-background px-2 py-1.5 text-body">
              {WELCOME_TOUR_COPY.sample}
            </p>
          </li>
          <li>
            <p className="mb-1 text-label text-muted-foreground">3 · 粘贴到 AI 输入框</p>
            <p className="rounded-lg border border-border bg-background px-2 py-1.5 text-body">
              {WELCOME_TOUR_COPY.sample}
            </p>
          </li>
        </ol>

        <div className="space-y-2 sm:col-start-1 sm:row-start-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => leaveTour("rehearse")}>试着收一条内容</Button>
            <Button variant="ghost" size="sm" onClick={() => leaveTour("use-now")}>
              直接开始使用
            </Button>
          </div>
          <p className="text-micro leading-relaxed text-muted-foreground">
            以后可在「设置 → 帮助与更新」继续学习
          </p>
        </div>
      </div>
    </div>
  );
}
