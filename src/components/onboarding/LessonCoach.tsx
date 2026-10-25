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
import { tNode, useT } from "@/lib/i18n";
import { useLessonStore } from "@/store/lessonStore";
import { useNotesStore } from "@/store/notesStore";

const CAPTURE_KEY = { shift: "⇧ Shift", control: "⌃ Control", option: "⌥ Option" } as const;

/** 主面板里的进阶课卡片：与基础课同位置同外观，每一步都落在真实操作上。 */
export function LessonCoach() {
  const t = useT();
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
      aria-label={merge ? t("进阶课：合并发送") : t("进阶课：智能脱敏与还原")}
      className="mx-1 mb-2 mt-1 rounded-xl border border-foreground/10 bg-surface-raised/90 p-3 elevation-3"
    >
      <div className="flex items-center gap-2">
        <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-lg bg-muted text-foreground/75 [&_svg]:size-3.5">
          {merge ? <Layers /> : <VenetianMask />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-body font-semibold">{t("进阶 · {lesson}", { lesson: merge ? t("合并发送") : t("智能脱敏与还原") })}</p>
          <p className="text-micro text-muted-foreground">
            {done ? t("已完成") : t("第 {step} 步，共 3 步 · 不会自动按回车", { step: progress.step + 1 })}
          </p>
        </div>
        {!done && (
          <Button size="xs" variant="ghost" onClick={() => abandonAdvancedLesson()}>
            {t("退出")}
          </Button>
        )}
      </div>

      <TourScene
        kind={merge ? "merge" : "privacy"}
        label={merge ? t("合并发送示意动画") : t("脱敏与还原示意动画")}
        className="mx-auto mt-2 block h-24 w-auto"
      />

      <ol aria-label={t("课程进度")} className="mt-2 grid grid-cols-3 gap-2">
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
              <span className="truncate">{t(label)}</span>
            </li>
          );
        })}
      </ol>

      <div role="status" className="mt-2 rounded-lg bg-muted/40 p-2.5">
        {merge ? (
          progress.step === 0 ? (
            <Step title={t("放入两张示例卡片")} hint={t("会放进收件箱，带「Toskr 教程」标记，完成后自动清理。")}>
              <Button size="xs" onClick={prepareLessonSamples}>{t("放入示例卡片")}</Button>
            </Step>
          ) : progress.step === 1 ? (
            <Step
              title={t("勾选这两张卡片")}
              hint={tNode("点卡片左侧的圆圈，或选中后按 {key}。已勾选 {n} / 2。", { key: <Kbd>X</Kbd>, n: checkedCount })}
            >
              <Button size="xs" variant="ghost" onClick={checkLessonSamples}>{t("帮我勾选")}</Button>
            </Step>
          ) : progress.step === 2 ? (
            <Step
              title={tNode("按 {key} 一起发送", { key: <Kbd>⌘ ⏎</Kbd> })}
              hint={t("先点一下文档或 AI 输入框的空白处，再回来发送；两张卡会合成一次粘贴。")}
            >
              <Button size="xs" onClick={sendLessonSamples}>{t("发送这两张")}</Button>
            </Step>
          ) : (
            <Step title={t("完成：两张卡合成了一次发送")} hint={t("以后勾选多张卡片，按 ⌘⏎ 就能一起发。")}>
              <Button size="xs" onClick={() => finishAdvancedLesson()}>{t("完成并清理示例")}</Button>
            </Step>
          )
        ) : progress.step === 0 ? (
          <Step
            title={t("准备示例")}
            hint={t("会添加化名「{alias}」和一张示例卡片，并打开「捕获时自动还原」。", { alias: t(PRIVACY_LESSON_ALIAS) })}
          >
            <Button size="xs" onClick={prepareLessonSamples}>{t("准备示例")}</Button>
          </Step>
        ) : progress.step === 1 ? (
          <Step
            title={t("发送这张示例卡")}
            hint={t("发送时「{alias}」会换成 {placeholder}，邮箱会被隐私检查发现并替换。先点一下文档空白处，再发送。", { alias: t(PRIVACY_LESSON_ALIAS), placeholder })}
          >
            <Button size="xs" onClick={sendLessonSamples}>{t("发送示例")}</Button>
          </Step>
        ) : progress.step === 2 ? (
          <Step
            title={t("把 AI 的回复收回来")}
            hint={tNode("复制下面这段模拟回复，粘贴到文档后选中，再连按两次 {key} 收进来", { key: <Kbd>{CAPTURE_KEY[captureKey]}</Kbd> })}
          >
            <p className="mb-2 rounded-lg bg-background/70 p-2 font-mono text-label">
              {privacyLessonReply(placeholder)}
            </p>
            <Button size="xs" onClick={copyLessonReply}>{t("复制模拟回复")}</Button>
          </Step>
        ) : (
          <Step
            title={t("完成：{placeholder} 已还原成「{alias}」", { placeholder, alias: t(PRIVACY_LESSON_ALIAS) })}
            hint={t("AI 只看到占位符，你收回的内容自动变回原文。示例化名要保留吗？")}
          >
            <div className="flex flex-wrap gap-1.5">
              <Button size="xs" onClick={() => finishAdvancedLesson(true)}>{t("保留化名")}</Button>
              <Button size="xs" variant="ghost" onClick={() => finishAdvancedLesson(false)}>{t("删除化名")}</Button>
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
