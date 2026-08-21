/**
 * 设计样张（dev-only）——新 token 与软玻璃质感的人工验收页。
 * 入口：pnpm dev → 浏览器打开 http://localhost:1420/?styletile=1
 * `import.meta.env.DEV` 编译期常量保证生产构建整分支死代码消除，零字节进包。
 *
 * 浅/深两栏并排（.dark 类作用于容器子树，无需翻全局主题）；
 * accent 已全局落地（index.css --accent-hue），本页直接消费真实 token。
 */
import { Check, CircleCheck, ClipboardCheck, Send, TriangleAlert } from "lucide-react";

function Spec({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <h3 className="text-label font-semibold uppercase tracking-widest text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Swatch({ name, className, note }: { name: string; className: string; note?: string }) {
  return (
    <div className="flex flex-col items-start gap-1">
      <span className={`h-9 w-16 rounded-md border border-foreground/10 ${className}`} />
      <span className="text-micro font-medium">{name}</span>
      {note && <span className="text-micro text-muted-foreground">{note}</span>}
    </div>
  );
}

function TypeRow({ cls, px, use }: { cls: string; px: string; use: string }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="w-24 shrink-0 text-micro tabular-nums text-muted-foreground">
        {cls} · {px}
      </span>
      <span className={`${cls} font-medium`}>划词捕获，一键发回对话 Aa 123</span>
      <span className="text-micro text-muted-foreground">{use}</span>
    </div>
  );
}

function PrimaryButton({ children }: { children: React.ReactNode }) {
  return (
    <button
      type="button"
      className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-(--button-primary-border) bg-button-primary px-4 text-title font-medium text-button-primary-foreground shadow-(--button-primary-shadow) transition-all duration-(--duration-control) hover:bg-button-primary-hover active:translate-y-[0.5px] active:shadow-none"
    >
      {children}
    </button>
  );
}

function SwitchMock({ on }: { on: boolean }) {
  return (
    <span
      className={`relative inline-block h-[18px] w-8 rounded-full border shadow-[inset_0_1px_2px_oklch(0_0_0/0.18)] transition-colors ${
        on
          ? "border-transparent bg-primary"
          : "border-(--switch-track-off-border) bg-(--switch-track-off)"
      }`}
    >
      <span
        className={`glass-sheen absolute top-1/2 size-4 -translate-y-1/2 rounded-full bg-white shadow-[0_1px_2px_oklch(0_0_0/0.3),0_1px_1px_oklch(0_0_0/0.1)] ${
          on ? "right-px" : "left-px"
        }`}
      />
    </span>
  );
}

/** NoteCard 形制样机（comfortable 密度）：default / hover / selected 三态 */
function CardMock({ state }: { state: "default" | "hover" | "selected" }) {
  const stateCls =
    state === "hover"
      ? "-translate-y-px elevation-2"
      : state === "selected"
        ? "border-primary/40 elevation-2"
        : "";
  return (
    <div
      className={`relative h-[136px] w-full overflow-hidden rounded-lg border bg-card text-card-foreground transition-[transform,box-shadow] duration-150 ${stateCls}`}
    >
      {state === "selected" && (
        <span className="absolute inset-0 bg-primary/[0.06] dark:bg-primary/[0.1]" />
      )}
      <div className="relative flex h-9 items-center justify-between bg-amber-500/90 pl-2.5">
        <div className="flex flex-col">
          <span className="text-body font-medium text-white">文本</span>
          <span className="text-micro text-white/70">13 小时前</span>
        </div>
        {/* 来源应用图标区：布局冻结，仅示意占位 */}
        <span className="-mr-2 flex h-9 w-11 items-center justify-start overflow-hidden">
          <span className="size-[52px] max-w-none rounded-xl bg-white/30" />
        </span>
      </div>
      <p className="relative px-2.5 py-2 text-title leading-normal">
        建立统一的 Design Tokens，间距与尺寸统一到网格，字阶明确、层级不超过五档，色彩语义化并保证对比度。
      </p>
      <span className="absolute bottom-1.5 right-2 text-micro text-muted-foreground">
        {state === "default" ? "默认" : state === "hover" ? "悬浮 · 微升" : "选中 · 填色+边框"}
      </span>
    </div>
  );
}

function HudMock({
  kind,
  text,
}: {
  kind: "added" | "sent" | "warn";
  text: string;
}) {
  const icon =
    kind === "added" ? (
      <ClipboardCheck className="size-3 text-white" />
    ) : kind === "sent" ? (
      <Send className="size-3 text-white" />
    ) : (
      <TriangleAlert className="size-3 text-white" />
    );
  const dot =
    kind === "added" ? "bg-emerald-500/90" : kind === "sent" ? "bg-sky-500/90" : "bg-amber-500/90";
  return (
    <div className="relative flex h-14 w-60 items-center gap-2.5 rounded-[14px] bg-zinc-800/85 px-3 backdrop-blur-xl">{/* token-exception: rounded-[14px] 模拟 HUD 窗口的 Rust 原生 vibrancy 圆角（apply_vibrancy radius=14），非样式体系值 */}
      {/* rim-light 装饰层：对齐原生 vibrancy 圆角，仅内描边（外影会被窗口裁剪，省略） */}
      <span className="pointer-events-none absolute inset-0 rounded-[14px] shadow-[inset_0_1px_0_oklch(1_0_0/0.16)]" />
      <span className={`flex size-5 shrink-0 items-center justify-center rounded-full ${dot}`}>
        {icon}
      </span>
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-body font-medium text-white">{text}</span>
        <span className="text-micro text-white/60">悬停显示「撤销」</span>
      </div>
    </div>
  );
}

function OnboardingMock() {
  return (
    <div className="elevation-3 w-72 rounded-xl border border-foreground/10 bg-surface-raised/90 p-3">
      <p className="text-title font-semibold text-letterpress">开始使用 Toskr</p>
      <ul className="mt-2 flex flex-col gap-1.5">
        {[
          ["授权辅助功能", true],
          ["双击 ⇧ Shift 捕获一段文字", true],
          ["按 ⌘⏎ 发回对话", false],
        ].map(([label, done]) => (
          <li key={label as string} className="flex items-center gap-2">
            {done ? (
              <CircleCheck className="size-3.5 text-success" />
            ) : (
              <span className="size-3.5 rounded-full border border-foreground/25" />
            )}
            <span
              className={`text-body ${done ? "text-muted-foreground line-through" : "text-foreground"}`}
            >
              {label as string}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TilePanel() {
  return (
    <div className="flex min-h-full flex-col gap-7 bg-background p-6 text-foreground">
      <Spec title="色板 · 纸白主控件 + 蓝状态色">
        <div className="flex flex-wrap gap-3">
          <Swatch name="paper" className="bg-paper" note="纸白·仅 HUD 气泡身份色（主按钮嫌暖黄已弃用）" />
          <Swatch name="button-primary" className="bg-button-primary" note="主按钮白实体（2026-08-13 定稿）" />
          <Swatch name="primary" className="bg-primary" note="蓝·焦点/选中/开关" />
          <Swatch name="success" className="bg-success" note="=现状勾选绿" />
          <Swatch name="warning" className="bg-warning" note="=现状琥珀" />
          <Swatch name="destructive" className="bg-destructive" />
          <Swatch name="spark 紫" className="bg-violet-500" note="灵感专属" />
        </div>
      </Spec>

      <Spec title="字阶 · 5 档命名刻度">
        <div className="flex flex-col gap-1.5">
          <TypeRow cls="text-micro" px="10/14" use="时间戳 · 计数 · 角标" />
          <TypeRow cls="text-label" px="11/16" use="提示 · 菜单项 · 节标" />
          <TypeRow cls="text-body" px="12/17" use="正文 · 按钮默认" />
          <TypeRow cls="text-title" px="13/18" use="卡片标题 · 行标签" />
          <TypeRow cls="text-heading" px="15/20" use="节题 · wordmark" />
        </div>
      </Spec>

      <Spec title="半径梯队（既有，确认无回归）">
        <div className="flex flex-wrap items-end gap-2">
          {["rounded-sm", "rounded-md", "rounded-lg", "rounded-xl", "rounded-2xl", "rounded-3xl", "rounded-4xl"].map(
            (r) => (
              <div key={r} className="flex flex-col items-center gap-1">
                <span className={`size-12 border border-foreground/20 bg-foreground/5 ${r}`} />
                <span className="text-micro text-muted-foreground">{r.slice(8)}</span>
              </div>
            ),
          )}
        </div>
      </Spec>

      <Spec title="Elevation 三档 · 叠在模拟 vibrancy 上（「不糊」验收点）">
        <div
          className="relative overflow-hidden rounded-xl p-4"
          style={{
            background:
              "radial-gradient(60% 80% at 20% 10%, oklch(0.75 0.18 300 / 0.8), transparent 60%), radial-gradient(50% 70% at 80% 30%, oklch(0.8 0.16 200 / 0.8), transparent 60%), radial-gradient(70% 60% at 50% 90%, oklch(0.82 0.17 60 / 0.8), transparent 60%), oklch(0.6 0.05 260)",
          }}
        >
          <div className="absolute inset-0 backdrop-blur-2xl [background:oklch(0.99_0_0/0.62)] dark:[background:oklch(0.17_0_0/0.56)]" />
          <div className="relative flex flex-wrap gap-4">
            {[
              ["elevation-1", "凹陷 · 输入/进度轨", "surface-inset elevation-1"],
              ["elevation-2", "悬浮 · 卡片/菜单", "bg-surface-raised/95 elevation-2"],
              ["elevation-3", "模态 · 质感件", "bg-surface-raised/95 elevation-3"],
            ].map(([name, use, cls]) => (
              <div
                key={name}
                className={`flex h-20 w-40 flex-col justify-center rounded-lg border border-foreground/10 px-3 ${cls}`}
              >
                <span className="text-body font-medium">{name}</span>
                <span className="text-micro text-muted-foreground">{use}</span>
              </div>
            ))}
          </div>
        </div>
      </Spec>

      <Spec title="按钮 · 白实体主键（2026-08-13 定稿；gloss/纸白暖调/粉底 destructive 均已否决）">
        <div className="flex flex-wrap items-center gap-3">
          <PrimaryButton>
            <Send className="size-3.5" />
            发送到对话
          </PrimaryButton>
          <button
            type="button"
            className="inline-flex h-8 items-center rounded-lg border border-border bg-background px-3 text-body font-medium text-foreground hover:bg-muted"
          >
            次要操作（描边降档）
          </button>
          <button
            type="button"
            className="inline-flex h-8 items-center rounded-lg px-3 text-body font-medium text-destructive hover:bg-destructive/10"
          >
            删除（红字 ghost）
          </button>
          <button
            type="button"
            disabled
            className="inline-flex h-8 items-center rounded-lg border border-(--button-primary-border) bg-button-primary px-3 text-body font-medium text-button-primary-foreground opacity-45"
          >
            禁用态 ·45
          </button>
        </div>
      </Spec>

      <Spec title="Switch · 凹槽轨 + 光泽拇指">
        <div className="flex items-center gap-4">
          <SwitchMock on />
          <SwitchMock on={false} />
          <span className="text-label text-muted-foreground">与进度条同一「光泽件骑在凹槽上」母题</span>
        </div>
      </Spec>

      <Spec title="进度条 · 更新下载">
        <div className="flex items-center gap-2">
          <div className="surface-inset elevation-1 h-1.5 w-40 overflow-hidden rounded-full">
            <div className="glass-sheen-flat h-full w-[62%] rounded-full bg-primary" />
          </div>
          <span className="text-label tabular-nums text-muted-foreground">62%</span>
        </div>
      </Spec>

      <Spec title="卡片三态 · 选中=填色+边框+抬升（左缘条方案已否决）">
        <div className="flex flex-col gap-3">
          <CardMock state="default" />
          <CardMock state="hover" />
          <CardMock state="selected" />
        </div>
      </Spec>

      <Spec title="HUD 气泡 · rim-light 内容层（底为原生 vibrancy，此处模拟）">
        <div className="flex flex-col gap-2">
          <HudMock kind="added" text="已捕获 ×3" />
          <HudMock kind="sent" text="已发送到 Claude" />
          <HudMock kind="warn" text="发送中止：目标未到达前台" />
        </div>
      </Spec>

      <Spec title="Onboarding 卡 · 软玻璃 + letterpress 标题">
        <OnboardingMock />
      </Spec>

      <Spec title="Letterpress wordmark（仅两处使用；不喜欢第一个砍）">
        <span className="text-heading font-semibold text-letterpress">Toskr — 捕获 · 队列 · 发回对话</span>
      </Spec>
    </div>
  );
}

export default function StyleTile() {
  return (
    <div className="min-h-screen bg-zinc-100 font-sans">
      {/* index.css 给 body 设了 overflow:hidden（面板窗口需要）；样张页恢复文档级滚动 */}
      <style>{"body{overflow:auto !important;cursor:auto;} body *{user-select:text;-webkit-user-select:text;}"}</style>
      <header className="border-b border-black/10 bg-white px-6 py-3">
        <p className="text-title font-semibold text-zinc-900">
          Toskr 设计样张 · 阶段二 2.0
          <span className="ml-2 text-label font-normal text-zinc-500">
            dev-only，不进生产包；蓝 accent 仅本页作用域；左浅右深
          </span>
        </p>
      </header>
      <div className="grid grid-cols-2">
        <div>
          <TilePanel />
        </div>
        <div className="dark">
          <TilePanel />
        </div>
      </div>
      <footer className="flex items-center gap-1.5 border-t border-black/10 bg-white px-6 py-3 text-label text-zinc-500">
        <Check className="size-3.5" />
        验收点：① 蓝 accent 观感 ② elevation 在 vibrancy 上不糊 ③ gloss 光泽克制度 ④ letterpress 去留 ⑤ 双主题对称性
      </footer>
    </div>
  );
}
