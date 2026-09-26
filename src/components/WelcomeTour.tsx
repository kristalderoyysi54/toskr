import { TourScene } from "@/components/onboarding/TourScene";
import { Button } from "@/components/ui/button";
import {
  CAPTURE_KEY_SYMBOL,
  WELCOME_TOUR_COPY,
  welcomeTourExitEvent,
  type WelcomeTourExitMode,
} from "@/lib/welcomeTour";
import { useNotesStore } from "@/store/notesStore";
import { useUIStore } from "@/store/uiStore";

/**
 * 首启只讲清三件别处没有的事：多处收集、合成一次发送、敏感信息自动替换。
 * 动画演示完整流程；用户选择尝试后才开始实际操作。
 */
export function WelcomeTour() {
  const captureKey = useNotesStore((state) => state.settings.hotkeyModifier);
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
      <div className="mx-auto flex min-h-full w-full max-w-md flex-col justify-center gap-5 px-5 py-6">
        <header>
          <p className="text-label text-muted-foreground">欢迎使用 Toskr</p>
          <h3 className="mt-1 text-heading font-semibold leading-snug">{WELCOME_TOUR_COPY.title}</h3>
        </header>

        <div className="rounded-xl border border-border/60 bg-muted/30 p-2">
          <TourScene
            kind="welcome"
            captureKey={CAPTURE_KEY_SYMBOL[captureKey]}
            label="演示：从浏览器和文档各收一段文字，勾选后一起发送给 AI，邮箱自动替换"
            className="block h-auto w-full"
          />
        </div>

        <ol className="space-y-1.5">
          {WELCOME_TOUR_COPY.points.map((point, index) => (
            <li key={point} className="flex items-center gap-2 text-body">
              <span
                aria-hidden
                className="grid size-5 shrink-0 place-items-center rounded-full bg-muted text-micro font-medium text-muted-foreground"
              >
                {index + 1}
              </span>
              {point}
            </li>
          ))}
        </ol>

        <div className="space-y-2">
          <Button className="w-full" onClick={() => leaveTour("rehearse")}>
            花 1 分钟试一下
          </Button>
          <Button variant="ghost" className="w-full" onClick={() => leaveTour("use-now")}>
            直接开始使用
          </Button>
          <p className="text-center text-micro text-muted-foreground">
            随时可在「设置 → 帮助与更新」继续学习
          </p>
        </div>
      </div>
    </div>
  );
}
