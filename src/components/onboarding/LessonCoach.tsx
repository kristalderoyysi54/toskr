import { CheckCircle2, Circle, Layers, VenetianMask } from "lucide-react";
import { useEffect } from "react";

import { TourScene } from "@/components/onboarding/TourScene";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import {
  abandonAdvancedLesson,
  checkLessonSamples,
  copyLessonReply,
  finishAdvancedLesson,
  lessonAliasPlaceholder,
  prepareLessonSamples,
  sendLessonSamples,
} from "@/lib/lessonActions";
import { advanceLessonAfterChecked } from "@/lib/lessonProgress";
import { LESSON_STEPS, PRIVACY_LESSON_ALIAS, privacyLessonReply } from "@/lib/lessons";
import { cn } from "@/lib/utils";
import { useLessonStore } from "@/store/lessonStore";
import { useNotesStore } from "@/store/notesStore";

const CAPTURE_KEY = { shift: "⇧ Shift", control: "⌃ Control", option: "⌥ Option" } as const;

/** 主面板里的进阶课卡片：与基础课同位置同外观，每一步都落在真实操作上。 */
export function LessonCoach() {
  const session = useLessonStore((state) => state.session);
  const checkedIds = useNotesStore((state) => state.checkedIds);
  const captureKey = useNotesStore((state) => state.settings.hotkeyModifier);
  useEffect(() => {
    if (session?.progress.id === "merge") advanceLessonAfterChecked(checkedIds);
  }, [checkedIds, session?.progress.id]);
  if (!session) return null;

  const { progress } = session;
  const merge = progress.id === "merge";
  const steps = LESSON_STEPS[progress.id];
  const done = progress.step === 3;
  const placeholder = lessonAliasPlaceholder() ?? "[USER_01]";
  const checkedCount = progress.sampleNoteIds.filter((id) => checkedIds.includes(id)).length;

  return (
    <section
      aria-label={merge ? "进阶课：合并发送" : "进阶课：智能脱敏与还原"}
      className="mx-1 mb-2 mt-1 rounded-xl border border-foreground/10 bg-surface-raised/90 p-3 elevation-3"
    >
      <div className="flex items-center gap-2">
        <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-lg bg-muted text-foreground/75 [&_svg]:size-3.5">
          {merge ? <Layers /> : <VenetianMask />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-body font-semibold">进阶 · {merge ? "合并发送" : "智能脱敏与还原"}</p>
          <p className="text-micro text-muted-foreground">
            {done ? "已完成" : `第 ${progress.step + 1} 步，共 3 步 · 不会自动按回车`}
          </p>
        </div>
        {!done && (
          <Button size="xs" variant="ghost" onClick={() => abandonAdvancedLesson()}>
            退出
          </Button>
        )}
      </div>

      <TourScene
        kind={merge ? "merge" : "privacy"}
        label={merge ? "合并发送示意动画" : "脱敏与还原示意动画"}
        className="mx-auto mt-2 block h-24 w-auto"
      />

      <ol aria-label="课程进度" className="mt-2 grid grid-cols-3 gap-2">
        {steps.map((label, index) => {
          const stepDone = index < progress.step;
          const current = index === progress.step;
          return (
            <li
              key={label}
              aria-current={current ? "step" : undefined}
              className={cn(
                "flex min-w-0 flex-col items-center gap-0.5 text-center text-micro",
                current ? "text-foreground" : "text-muted-foreground"
              )}
            >
              {stepDone ? (
                <CheckCircle2 className="size-3 text-success" aria-hidden />
              ) : (
                <Circle className={cn("size-3", current && "text-primary")} aria-hidden />
              )}
              <span className="truncate">{label}</span>
            </li>
          );
        })}
      </ol>

      <div role="status" className="mt-2 rounded-lg bg-muted/40 p-2.5">
        {merge ? (
          progress.step === 0 ? (
            <Step title="放入两张示例卡片" hint="会放进收件箱，带「Toskr 教程」标记，完成后自动清理。">
              <Button size="xs" onClick={prepareLessonSamples}>放入示例卡片</Button>
            </Step>
          ) : progress.step === 1 ? (
            <Step
              title="勾选这两张卡片"
              hint={<>点卡片左侧的圆圈，或选中后按 <Kbd>X</Kbd>。已勾选 {checkedCount} / 2。</>}
            >
              <Button size="xs" variant="ghost" onClick={checkLessonSamples}>帮我勾选</Button>
            </Step>
          ) : progress.step === 2 ? (
            <Step
              title={<>按 <Kbd>⌘ ⏎</Kbd> 一起发送</>}
              hint="先点一下文档或 AI 输入框的空白处，再回来发送；两张卡会合成一次粘贴。"
            >
              <Button size="xs" onClick={sendLessonSamples}>发送这两张</Button>
            </Step>
          ) : (
            <Step title="完成：两张卡合成了一次发送" hint="以后勾选多张卡片，按 ⌘⏎ 就能一起发。">
              <Button size="xs" onClick={() => finishAdvancedLesson()}>完成并清理示例</Button>
            </Step>
          )
        ) : progress.step === 0 ? (
          <Step
            title="准备示例"
            hint={`会添加化名「${PRIVACY_LESSON_ALIAS}」和一张示例卡片，并打开「捕获时自动还原」。`}
          >
            <Button size="xs" onClick={prepareLessonSamples}>准备示例</Button>
          </Step>
        ) : progress.step === 1 ? (
          <Step
            title="发送这张示例卡"
            hint={`发送时「${PRIVACY_LESSON_ALIAS}」会换成 ${placeholder}，邮箱会被隐私检查发现并替换。先点一下文档空白处，再发送。`}
          >
            <Button size="xs" onClick={sendLessonSamples}>发送示例</Button>
          </Step>
        ) : progress.step === 2 ? (
          <Step
            title="把 AI 的回复收回来"
            hint={<>复制下面这段模拟回复，粘贴到文档后选中，再连按两次 <Kbd>{CAPTURE_KEY[captureKey]}</Kbd> 收进来</>}
          >
            <p className="mb-2 rounded-lg bg-background/70 p-2 font-mono text-label">
              {privacyLessonReply(placeholder)}
            </p>
            <Button size="xs" onClick={copyLessonReply}>复制模拟回复</Button>
          </Step>
        ) : (
          <Step
            title={`完成：${placeholder} 已还原成「${PRIVACY_LESSON_ALIAS}」`}
            hint="AI 只看到占位符，你收回的内容自动变回原文。示例化名要保留吗？"
          >
            <div className="flex flex-wrap gap-1.5">
              <Button size="xs" onClick={() => finishAdvancedLesson(true)}>保留化名</Button>
              <Button size="xs" variant="ghost" onClick={() => finishAdvancedLesson(false)}>删除化名</Button>
            </div>
          </Step>
        )}
      </div>
    </section>
  );
}

function Step({ title, hint, children }: { title: React.ReactNode; hint: React.ReactNode; children: React.ReactNode }) {
  return (
    <>
      <p className="text-body font-medium">{title}</p>
      <p className="mb-2 mt-1 text-label leading-relaxed text-muted-foreground">{hint}</p>
      {children}
    </>
  );
}
