import { CheckCircle2, LockKeyhole } from "lucide-react";
import { useState, type ReactNode } from "react";

import { TourScene, type TourSceneKind } from "@/components/onboarding/TourScene";
import { SettingsGroup } from "@/components/settings/SettingsLayout";
import { Button } from "@/components/ui/button";
import type { OnboardingState } from "@/lib/onboarding";
import type { LessonId } from "@/lib/lessons";
import { safeDeliveryLearningTasks } from "@/lib/safeDeliveryLearningPath";

/**
 * 设置 → 使用概览：一张「上手课程」卡。基础课沿用原三步状态机；
 * 两门进阶课在主面板跟着真实操作走。缩略动画悬停时播放，平时停在结果画面。
 */
export function LearningCourses({
  onboarding,
  onRunRehearsal,
  onStartLesson,
  onReplayTour,
}: {
  onboarding: OnboardingState;
  onRunRehearsal: (mode: "start" | "resume") => void;
  onStartLesson: (id: LessonId) => void;
  onReplayTour: () => void;
}) {
  const basicDone = safeDeliveryLearningTasks(onboarding).filter((task) => task.status === "done").length;
  const basicComplete = basicDone === 3;
  const resumable = onboarding.rehearsalStatus === "paused" || onboarding.rehearsalStatus === "active";
  // 进阶课需要能真实发送：基础课完成或已经发送过内容即可解锁
  const advancedUnlocked = basicComplete || onboarding.sent;

  return (
    <SettingsGroup
      title="上手课程"
      footer="每门课都在主面板里跟着真实操作走，不会自动按回车；示例内容在课程结束时清理。"
    >
      <CourseRow
        scene="basic"
        title="基础：收集并粘贴"
        description="收进一条内容，选好粘贴位置，检查后粘贴"
        meta={basicComplete ? "3 步 · 已完成" : `3 步 · 已完成 ${basicDone} / 3`}
        done={basicComplete}
        action={
          <Button size="sm" variant={basicComplete ? "ghost" : "default"}
            onClick={() => onRunRehearsal(basicComplete || !resumable ? "start" : "resume")}>
            {basicComplete ? "重新练习" : resumable ? "继续" : "开始"}
          </Button>
        }
      />
      <CourseRow
        scene="merge"
        title="进阶：合并发送"
        description="勾选多张卡片，按 ⌘⏎ 合成一次粘贴"
        meta="3 步 · 使用示例卡片，结束时自动清理"
        done={onboarding.mergeTutorialCompletedAtMs !== null}
        action={advancedUnlocked ? (
          <Button size="sm" variant={onboarding.mergeTutorialCompletedAtMs ? "ghost" : "default"}
            onClick={() => onStartLesson("merge")}>
            {onboarding.mergeTutorialCompletedAtMs ? "再练一次" : "开始"}
          </Button>
        ) : <Locked />}
      />
      <CourseRow
        scene="privacy"
        title="进阶：智能脱敏与还原"
        description="发送时把名字换成占位符，收回 AI 回复时自动还原"
        meta="3 步 · 使用示例化名，结束时可保留或删除"
        done={onboarding.recoveryTutorialCompletedAtMs !== null}
        action={advancedUnlocked ? (
          <Button size="sm" variant={onboarding.recoveryTutorialCompletedAtMs ? "ghost" : "default"}
            onClick={() => onStartLesson("privacy")}>
            {onboarding.recoveryTutorialCompletedAtMs ? "再练一次" : "开始"}
          </Button>
        ) : <Locked />}
      />
      <div
        data-settings-search="新手导览"
        className="flex min-h-12 items-center justify-between gap-3 px-3.5 py-2.5"
      >
        <div className="min-w-0">
          <p className="text-title">新手导览</p>
          <p className="mt-0.5 text-label text-muted-foreground">重看首次打开时的动画演示</p>
        </div>
        <Button size="xs" onClick={onReplayTour}>重看导览</Button>
      </div>
    </SettingsGroup>
  );
}

function Locked() {
  return (
    <span className="flex shrink-0 items-center gap-1 text-label text-muted-foreground">
      <LockKeyhole aria-hidden className="size-3.5" /> 先完成基础课
    </span>
  );
}

function CourseRow({ scene, title, description, meta, done, action }: {
  scene: TourSceneKind;
  title: string;
  description: string;
  meta: string;
  done: boolean;
  action: ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      className="flex items-center gap-3 px-3.5 py-3"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
    >
      <div className="shrink-0 rounded-lg border border-border/60 bg-muted/30 p-1">
        <TourScene kind={scene} playing={hovered} label={`${title}示意动画`} className="block h-14 w-24" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-title font-semibold">
          {title}
          {done && <CheckCircle2 aria-label="已完成" className="size-3.5 text-success" />}
        </p>
        <p className="mt-0.5 text-label text-muted-foreground">{description}</p>
        <p className="mt-0.5 text-micro text-muted-foreground">{meta}</p>
      </div>
      {action}
    </div>
  );
}
