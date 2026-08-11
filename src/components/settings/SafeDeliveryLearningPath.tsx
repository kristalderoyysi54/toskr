import {
  CheckCircle2,
  LockKeyhole,
  RotateCcw,
} from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import type { OnboardingState } from "@/lib/onboarding";
import { safeDeliveryLearningTasks } from "@/lib/safeDeliveryLearningPath";
import { cn } from "@/lib/utils";

export interface SafeDeliveryLearningPathProps {
  onboarding: OnboardingState;
  onRunRehearsal: (mode: "start" | "resume") => void;
  onCompleteRecoveryTutorial: () => void;
}

function CompactGuide({
  complete,
  completedCount,
  onExpand,
  onRestart,
}: {
  complete: boolean;
  completedCount: number;
  onExpand: () => void;
  onRestart: () => void;
}) {
  return (
    <section
      aria-label="安全发送入门"
      className="mb-3 flex items-center gap-3 rounded-xl border border-border/60 bg-card px-3.5 py-3"
    >
      <CheckCircle2
        aria-hidden
        className={cn(
          "size-4 shrink-0",
          complete ? "text-success" : "text-muted-foreground"
        )}
      />
      <div className="min-w-0 flex-1">
        <h3 className="text-title font-medium">
          {complete ? "安全发送入门已完成" : "开始使用 Toskr"}
        </h3>
        <p className="mt-0.5 text-label text-muted-foreground">
          {completedCount} / 4 已完成 · 进度保存在本机
        </p>
      </div>
      {complete && (
        <Button type="button" size="sm" variant="ghost" onClick={onRestart}>
          <RotateCcw aria-hidden /> 重新演练
        </Button>
      )}
      <Button type="button" size="sm" variant="secondary" onClick={onExpand}>
        {complete ? "查看任务" : "继续"}
      </Button>
    </section>
  );
}

export function SafeDeliveryLearningPath({
  onboarding,
  onRunRehearsal,
  onCompleteRecoveryTutorial,
}: SafeDeliveryLearningPathProps) {
  const tasks = safeDeliveryLearningTasks(onboarding);
  const completedCount = tasks.filter((task) => task.status === "done").length;
  const complete = completedCount === tasks.length;
  const [deferred, setDeferred] = useState(false);
  const [showCompletedTasks, setShowCompletedTasks] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [restored, setRestored] = useState(false);

  if (deferred || (complete && !showCompletedTasks)) {
    return (
      <CompactGuide
        complete={complete}
        completedCount={completedCount}
        onExpand={() => {
          setDeferred(false);
          setShowCompletedTasks(true);
        }}
        onRestart={() => onRunRehearsal("start")}
      />
    );
  }

  const resumeMode = onboarding.rehearsalStep === "complete"
    ? "start"
    : "resume";

  return (
    <section
      aria-label="安全发送入门"
      className="mb-3 overflow-hidden rounded-xl border border-border/60 bg-card"
    >
      <header className="flex items-center gap-2 border-b border-border/50 px-3.5 py-3 sm:gap-3">
        <h3 className="whitespace-nowrap text-title font-medium">开始使用 Toskr</h3>
        <p className="whitespace-nowrap text-label text-muted-foreground">
          <span className="font-medium text-success">{completedCount}</span> / 4 已完成
        </p>
        <p className="ml-auto hidden whitespace-nowrap text-label text-muted-foreground sm:block">
          进度保存在本机
        </p>
        <span aria-hidden className="hidden h-3 w-px bg-border sm:block" />
        <button
          type="button"
          onClick={() => {
            if (complete) setShowCompletedTasks(false);
            else setDeferred(true);
          }}
          className="ml-auto whitespace-nowrap rounded-sm text-label text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/50 sm:ml-0"
        >
          {complete ? "收起" : "稍后继续"}
        </button>
      </header>

      <ol className="divide-y divide-border/50">
        {tasks.map((task, index) => {
          const current = task.status === "current";
          const done = task.status === "done";
          const isRecovery = task.id === "restore";
          return (
            <li key={task.id} className="px-3.5 py-2.5">
              <div className="flex min-h-8 items-center gap-3">
                {done ? (
                  <CheckCircle2 aria-hidden className="size-4 shrink-0 text-success" />
                ) : current ? (
                  <span
                    aria-hidden
                    className="flex size-4 shrink-0 items-center justify-center rounded-full border border-foreground text-micro font-medium"
                  >
                    {index + 1}
                  </span>
                ) : (
                  <LockKeyhole aria-hidden className="size-4 shrink-0 text-muted-foreground/60" />
                )}

                <div className="min-w-0 flex-1">
                  <p className={cn(
                    "text-title font-medium",
                    task.status === "locked" && "text-muted-foreground"
                  )}>
                    {task.title}
                  </p>
                  {!done && (
                    <p className="mt-0.5 text-label text-muted-foreground">
                      {task.description}
                    </p>
                  )}
                </div>

                {done ? (
                  <span className="text-label font-medium text-success">已完成</span>
                ) : current ? (
                  <Button
                    type="button"
                    size="sm"
                    className="border-paper bg-paper text-paper-foreground hover:bg-paper/90 dark:border-paper dark:bg-paper dark:text-paper-foreground dark:hover:bg-paper/90"
                    onClick={() => {
                      if (isRecovery) {
                        setRecoveryOpen(true);
                        return;
                      }
                      onRunRehearsal(resumeMode);
                    }}
                  >
                    {isRecovery
                      ? recoveryOpen
                        ? "演示中"
                        : "体验恢复"
                      : task.id === "safe-send"
                        ? "开始"
                        : completedCount
                          ? "继续"
                          : "开始"}
                  </Button>
                ) : (
                  <span className="text-label text-muted-foreground">待完成</span>
                )}
              </div>

              {current && isRecovery && recoveryOpen && (
                <div
                  role="group"
                  aria-label="本地恢复演示"
                  className="ml-7 mt-2 flex items-center gap-2 rounded-lg bg-muted/50 px-2.5 py-2"
                >
                  <code
                    aria-live="polite"
                    className="min-w-0 flex-1 truncate text-body text-foreground"
                  >
                    {restored
                      ? "demo.user@example.com 已收到"
                      : "[EMAIL_01] 已收到"}
                  </code>
                  <p className="hidden text-micro text-muted-foreground lg:block">
                    演练假数据 · 不读取真实内容
                  </p>
                  <Button
                    type="button"
                    size="xs"
                    variant={restored ? "secondary" : "outline"}
                    onClick={() => {
                      if (!restored) {
                        setRestored(true);
                        return;
                      }
                      onCompleteRecoveryTutorial();
                    }}
                  >
                    {restored ? "完成教学" : "本地恢复"}
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
