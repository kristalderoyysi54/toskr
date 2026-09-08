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
          {complete ? "基础教程已完成" : "开始使用 Toskr"}
        </h3>
        <p className="mt-0.5 text-label text-muted-foreground">
          {completedCount} / 3 已完成 · 进度保存在本机
        </p>
      </div>
      {complete && (
        <Button type="button" size="sm" variant="ghost" onClick={onRestart}>
          <RotateCcw aria-hidden /> 重新演练
        </Button>
      )}
      <Button type="button" size="sm" variant="secondary" onClick={onExpand}>
        {complete ? "查看步骤" : "展开教程"}
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
  const [collapsed, setCollapsed] = useState(false);
  const [showCompletedTasks, setShowCompletedTasks] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [restored, setRestored] = useState(false);

  const resumable = onboarding.rehearsalStatus === "paused" ||
    onboarding.rehearsalStatus === "active";
  const resumeMode = resumable ? "resume" : "start";
  const recoveryComplete = onboarding.recoveryTutorialCompletedAtMs !== null;

  return (
    <>
      {collapsed || (complete && !showCompletedTasks) ? (
        <CompactGuide
          complete={complete}
          completedCount={completedCount}
          onExpand={() => {
            setCollapsed(false);
            setShowCompletedTasks(true);
          }}
          onRestart={() => onRunRehearsal("start")}
        />
      ) : (
        <section
          aria-label="安全发送入门"
          className="mb-3 overflow-hidden rounded-xl border border-border/60 bg-card"
        >
          <header className="flex items-center gap-2 border-b border-border/50 px-3.5 py-3 sm:gap-3">
            <h3 className="whitespace-nowrap text-title font-medium">开始使用 Toskr</h3>
            <p className="whitespace-nowrap text-label text-muted-foreground">
              <span className="font-medium text-success">{completedCount}</span> / 3 已完成
            </p>
            <p className="ml-auto hidden whitespace-nowrap text-label text-muted-foreground sm:block">
              进度保存在本机
            </p>
            <span aria-hidden className="hidden h-3 w-px bg-border sm:block" />
            <button
              type="button"
              onClick={() => {
                if (complete) setShowCompletedTasks(false);
                else setCollapsed(true);
              }}
              className="ml-auto whitespace-nowrap rounded-sm text-label text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background sm:ml-0"
            >
              收起教程
            </button>
          </header>

          <ol className="divide-y divide-border/50">
            {tasks.map((task, index) => {
              const current = task.status === "current";
              const done = task.status === "done";
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
                      <LockKeyhole aria-hidden className="size-4 shrink-0 text-muted-foreground" />
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
                        onClick={() => onRunRehearsal(resumeMode)}
                      >
                        {resumable ? "继续教程" : "开始教程"}
                      </Button>
                    ) : (
                      <span className="text-label text-muted-foreground">待完成</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      )}
      <details className="mb-3 rounded-xl border border-border/60 bg-card px-3.5 py-3">
        <summary className="cursor-pointer rounded-sm text-label font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
          可选进阶 · 恢复替换后的内容{recoveryComplete ? " · 已体验" : ""}
        </summary>
        <p className="mt-2 text-label text-muted-foreground">
          例如把回复中的 [EMAIL_01] 恢复为邮箱地址。此项不计入基础教程进度。
        </p>
        {!recoveryOpen ? (
          <Button type="button" size="sm" className="mt-2" onClick={() => setRecoveryOpen(true)}>
            {recoveryComplete ? "再看一次" : "体验恢复"}
          </Button>
        ) : (
          <div className="mt-2 space-y-1.5">
            <div
              role="group"
              aria-label="本地恢复演示"
              className="flex items-center gap-2 rounded-lg bg-muted/50 px-2.5 py-2"
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
                示例假数据 · 不读取真实内容
              </p>
              <Button
                type="button"
                size="xs"
                variant={restored ? "secondary" : "outline"}
                disabled={restored && recoveryComplete}
                onClick={() => {
                  if (!restored) {
                    setRestored(true);
                    return;
                  }
                  onCompleteRecoveryTutorial();
                }}
              >
                {restored ? recoveryComplete ? "已体验" : "完成教学" : "本地恢复"}
              </Button>
            </div>
            {restored && (
              <p className="text-micro text-muted-foreground">
                如需处理自己的内容，可在「设置 → 粘贴与隐私 → 可逆化名」添加替换词。
                发送时会替换，收进 AI 回复时会在本机恢复原文。
              </p>
            )}
          </div>
        )}
      </details>
    </>
  );
}
