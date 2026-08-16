import { useEffect, useMemo, useState } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { ChevronLeft, Plus, Search, X } from "lucide-react";

import {
  BILL_CATALOG,
  CATALOG_CATEGORIES,
  CATALOG_CATEGORY_LABEL,
  type CatalogCategory,
  type CatalogService,
} from "@/components/subscriptions/billCatalog";
import { Button } from "@/components/ui/button";
import { floatingSurface } from "@/components/ui/floating-surface";
import { IconButton } from "@/components/ui/icon-button";
import { Segmented } from "@/components/ui/segmented";
import {
  billAvatarInitial,
  billFallbackColor,
  CYCLE_LABEL,
  nextMonthlyDueAt,
  startOfBillDay,
} from "@/lib/bills";
import { api } from "@/lib/tauri";
import { tip } from "@/lib/tip";
import { cn } from "@/lib/utils";
import {
  BILL_REMINDER_OFFSET_OPTIONS,
  useNotesStore,
  type Bill,
  type BillCycle,
  type BillKind,
  type ReminderOffsetDays,
} from "@/store/notesStore";

/** 货币速选（符号即存储值；不做汇率，仅展示前缀）。 */
const CURRENCY_OPTIONS = [
  { symbol: "¥", label: "¥ CNY" },
  { symbol: "US$", label: "US$ USD" },
  { symbol: "€", label: "€ EUR" },
  { symbol: "£", label: "£ GBP" },
  { symbol: "HK$", label: "HK$ HKD" },
  { symbol: "JP¥", label: "JP¥ JPY" },
];

/** 订阅可选类别（信用卡走 kind，不在此列）；catalog 类别之外给「其他」。 */
const BILL_CATEGORY_OPTIONS: { value: string; label: string }[] = [
  ...CATALOG_CATEGORIES.filter((c) => c !== "creditCard").map((c) => ({
    value: c,
    label: CATALOG_CATEGORY_LABEL[c],
  })),
  { value: "other", label: "其他" },
];

const OFFSET_LABEL: Record<ReminderOffsetDays, string> = {
  7: "提前 7 天",
  3: "提前 3 天",
  1: "提前 1 天",
  0: "当天",
};

const CYCLE_OPTIONS = (Object.keys(CYCLE_LABEL) as BillCycle[]).map((value) => ({
  value,
  label: CYCLE_LABEL[value],
}));

function toDateInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fromDateInput(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

interface FormState {
  kind: BillKind;
  name: string;
  amount: string;
  currency: string;
  category: string;
  payMethod: string;
  cycle: BillCycle;
  /** 订阅：下次续费日（date input）。 */
  dueDate: string;
  /** 订阅开始日期（纯记录）。 */
  startDate: string;
  /** 信用卡：每月还款日 1-31。 */
  repayDay: string;
  offsets: ReminderOffsetDays[];
  note: string;
  catalog?: CatalogService;
}

/**
 * 添加/编辑账单：全屏覆盖流程（仿最近发送抽屉外壳）。
 * 新建两步：pick（分类胶囊 + 服务网格 + 搜索 + 自定义）→ confirm（表单）；
 * 编辑直接进 confirm。favicon 异步回填不阻塞提交（先建记录后补图标）。
 */
export function AddBillFlow({
  open,
  edit,
  onOpenChange,
}: {
  open: boolean;
  edit?: Bill;
  onOpenChange: (open: boolean) => void;
}) {
  const defaultOffsets = useNotesStore((s) => s.settings.billDefaultReminderOffsets);
  const defaultCurrency = useNotesStore((s) => s.settings.currencySymbol);
  const [step, setStep] = useState<"pick" | "confirm">("pick");
  const [category, setCategory] = useState<CatalogCategory | "all">("all");
  const [query, setQuery] = useState("");
  const [form, setForm] = useState<FormState | null>(null);

  // 打开时按模式复位（编辑=直达表单；新建=目录起步）
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setCategory("all");
    if (edit) {
      setStep("confirm");
      setForm({
        kind: edit.kind,
        name: edit.name,
        amount: edit.amount != null ? String(edit.amount) : "",
        currency: edit.currency ?? defaultCurrency,
        category: edit.category ?? "other",
        payMethod: edit.payMethod ?? "",
        cycle: edit.cycle,
        dueDate: toDateInput(edit.nextDueAt),
        startDate: edit.startedAt != null ? toDateInput(edit.startedAt) : "",
        repayDay: String(new Date(edit.nextDueAt).getDate()),
        offsets: [...edit.reminderOffsets],
        note: edit.note ?? "",
      });
    } else {
      setStep("pick");
      setForm(null);
    }
  }, [open, edit]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return BILL_CATALOG.filter(
      (s) =>
        (category === "all" || s.category === category) &&
        (!q || s.name.toLowerCase().includes(q) || s.id.includes(q))
    );
  }, [category, query]);

  const startConfirm = (catalog?: CatalogService, kind?: BillKind) => {
    const resolvedKind: BillKind =
      kind ?? (catalog?.category === "creditCard" ? "creditCard" : "subscription");
    setForm({
      kind: resolvedKind,
      name: catalog?.name ?? "",
      amount: "",
      currency: defaultCurrency,
      category:
        catalog && catalog.category !== "creditCard" ? catalog.category : "other",
      payMethod: "",
      cycle: catalog?.defaultCycle ?? "monthly",
      dueDate: toDateInput(startOfBillDay(Date.now())),
      startDate: toDateInput(startOfBillDay(Date.now())),
      repayDay: "10",
      offsets: [...defaultOffsets],
      note: "",
      catalog,
    });
    setStep("confirm");
  };

  const submit = () => {
    if (!form) return;
    const name = form.name.trim();
    if (!name) {
      tip("warn", "请填写名称");
      return;
    }
    const amount = form.amount.trim() === "" ? null : Number(form.amount);
    if (amount !== null && (!Number.isFinite(amount) || amount < 0)) {
      tip("warn", "金额无效");
      return;
    }
    if (form.kind === "subscription" && amount === null) {
      tip("warn", "订阅需要填写每期金额");
      return;
    }
    let nextDueAt: number;
    if (form.kind === "creditCard") {
      const day = Number(form.repayDay);
      if (!Number.isInteger(day) || day < 1 || day > 31) {
        tip("warn", "还款日需为 1-31");
        return;
      }
      nextDueAt = nextMonthlyDueAt(day, Date.now());
    } else {
      const parsed = fromDateInput(form.dueDate);
      if (parsed === null) {
        tip("warn", "请选择下次续费日期");
        return;
      }
      nextDueAt = parsed;
    }
    const store = useNotesStore.getState();
    const shared = {
      kind: form.kind,
      name,
      amount,
      currency: form.currency || undefined,
      category: form.kind === "creditCard" ? undefined : form.category || undefined,
      payMethod: form.payMethod.trim() || undefined,
      cycle: form.kind === "creditCard" ? ("monthly" as BillCycle) : form.cycle,
      startedAt:
        form.kind === "subscription" && form.startDate
          ? (fromDateInput(form.startDate) ?? undefined)
          : undefined,
      nextDueAt,
      reminderOffsets: form.offsets,
      note: form.note.trim() || undefined,
    };
    if (edit) {
      store.updateBill(edit.id, shared);
      tip("ok", `已更新「${name}」`);
    } else {
      const id = store.addBill({
        ...shared,
        fallbackColor: billFallbackColor(name),
        catalogId: form.catalog?.id,
      });
      const domain = form.catalog?.domain;
      if (domain) {
        // 异步补图标：失败静默回退首字色块，不打扰添加主流程
        void api
          .fetchFavicon(domain)
          .then((file) => useNotesStore.getState().updateBill(id, { iconFile: file }))
          .catch(() => {});
      }
      tip("added", `已添加「${name}」`);
    }
    onOpenChange(false);
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-background/55 backdrop-blur-sm data-open:animate-in data-open:fade-in-0 duration-100 motion-reduce:!animate-none" />
        <DialogPrimitive.Content
          className={cn(
            "fixed inset-2 z-50 flex flex-col overflow-hidden rounded-2xl p-3 outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:slide-in-from-bottom-2 motion-reduce:!animate-none",
            floatingSurface(3)
          )}
        >
          <header className="flex items-center gap-1 border-b border-border/70 pb-2">
            {step === "confirm" && !edit && (
              <IconButton label="返回服务目录" size="sm" onClick={() => setStep("pick")}>
                <ChevronLeft />
              </IconButton>
            )}
            <DialogPrimitive.Title className="min-w-0 flex-1 truncate text-title font-semibold">
              {edit ? "编辑订阅" : step === "pick" ? "添加订阅" : "确认信息"}
            </DialogPrimitive.Title>
            <DialogPrimitive.Description className="sr-only">
              记录订阅服务或信用卡还款日，到期前自动提醒。
            </DialogPrimitive.Description>
            <DialogPrimitive.Close asChild>
              <IconButton label="关闭" size="sm">
                <X />
              </IconButton>
            </DialogPrimitive.Close>
          </header>

          {step === "pick" ? (
            <>
              {/* 分类胶囊：全部 + 各类；横向滚动不换行 */}
              <div className="mt-2 flex gap-1 overflow-x-auto pb-0.5 [&::-webkit-scrollbar]:hidden">
                {(["all", ...CATALOG_CATEGORIES] as const).map((c) => (
                  <button
                    key={c}
                    onClick={() => setCategory(c)}
                    className={cn(
                      "shrink-0 rounded-full px-2 py-0.5 text-label transition-colors",
                      category === c
                        ? "bg-primary text-primary-foreground"
                        : "bg-black/5 text-muted-foreground hover:text-foreground dark:bg-white/10"
                    )}
                  >
                    {c === "all" ? "全部" : CATALOG_CATEGORY_LABEL[c]}
                  </button>
                ))}
              </div>
              <div className="relative mt-2">
                <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索服务…"
                  className="w-full rounded-lg border border-border bg-transparent py-1.5 pl-7 pr-2 text-body outline-none focus:border-primary/50"
                  aria-label="搜索预置服务"
                />
              </div>
              <div className="mt-2 min-h-0 flex-1 overflow-y-auto pr-0.5">
                {matches.length ? (
                  <div className="grid grid-cols-3 gap-1.5 pb-2">
                    {matches.map((s) => (
                      <button
                        key={s.id}
                        onClick={() => startConfirm(s)}
                        className="flex flex-col items-center gap-1.5 rounded-xl bg-black/5 px-1 py-2.5 outline-none transition-colors hover:bg-black/10 focus-visible:ring-2 focus-visible:ring-ring dark:bg-white/5 dark:hover:bg-white/10"
                      >
                        <span
                          className="flex size-8 items-center justify-center rounded-lg text-title font-semibold text-white"
                          style={{ backgroundColor: billFallbackColor(s.name) }}
                          aria-hidden
                        >
                          {billAvatarInitial(s.name)}
                        </span>
                        <span className="w-full truncate px-0.5 text-center text-micro">
                          {s.name}
                        </span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="py-8 text-center text-label text-muted-foreground">
                    没有匹配的服务，用下方自定义添加
                  </p>
                )}
              </div>
              <div className="flex gap-1.5 border-t border-border/50 px-0.5 pb-0.5 pt-2">
                <Button size="sm" className="flex-1" onClick={() => startConfirm(undefined, "subscription")}>
                  <Plus /> 自定义订阅
                </Button>
                <Button size="sm" className="flex-1" onClick={() => startConfirm(undefined, "creditCard")}>
                  <Plus /> 自定义信用卡
                </Button>
              </div>
            </>
          ) : (
            form && (
              // px/pb 留 2px 余量：按钮描边与焦点环不被滚动容器裁掉（用户反馈的左/底遮挡）
              <div className="mt-2 flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-0.5 pb-0.5">
                {!edit && (
                  <Segmented
                    ariaLabel="账单类型"
                    value={form.kind}
                    options={[
                      { value: "subscription", label: "订阅" },
                      { value: "creditCard", label: "信用卡" },
                    ]}
                    onChange={(kind) => setForm({ ...form, kind })}
                    className="self-start"
                  />
                )}
                <Field label="名称">
                  <input
                    autoFocus={!form.name}
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder={form.kind === "creditCard" ? "如 招商银行信用卡" : "如 Netflix"}
                    className="w-full rounded-md border border-border bg-transparent px-1.5 py-1 text-body outline-none focus:border-primary/50"
                  />
                </Field>
                <Field label={form.kind === "creditCard" ? "金额（可留空，每期可改）" : "每期金额"}>
                  <div className="flex gap-1.5">
                    {/* 货币下拉与金额同排（面板窄，省一行；符号即存储值） */}
                    <select
                      value={form.currency}
                      onChange={(e) => setForm({ ...form, currency: e.target.value })}
                      aria-label="货币"
                      className="rounded-md border border-border bg-transparent px-1 py-1 text-body outline-none focus:border-primary/50"
                    >
                      {(CURRENCY_OPTIONS.some((o) => o.symbol === form.currency)
                        ? CURRENCY_OPTIONS
                        : [{ symbol: form.currency, label: form.currency }, ...CURRENCY_OPTIONS]
                      ).map((o) => (
                        <option key={o.symbol} value={o.symbol}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={form.amount}
                      onChange={(e) => setForm({ ...form, amount: e.target.value })}
                      placeholder={form.kind === "creditCard" ? "留空 = 只提醒还款日" : "68"}
                      className="min-w-0 flex-1 rounded-md border border-border bg-transparent px-1.5 py-1 text-body tabular-nums outline-none focus:border-primary/50"
                    />
                  </div>
                </Field>
                {form.kind === "subscription" && (
                  <Field label="类别">
                    <select
                      value={form.category}
                      onChange={(e) => setForm({ ...form, category: e.target.value })}
                      className="w-full rounded-md border border-border bg-transparent px-1 py-1 text-body outline-none focus:border-primary/50"
                    >
                      {BILL_CATEGORY_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                {form.kind === "subscription" ? (
                  <>
                    <Field label="周期">
                      <Segmented
                        size="xs"
                        ariaLabel="续费周期"
                        value={form.cycle}
                        options={CYCLE_OPTIONS}
                        onChange={(cycle) => setForm({ ...form, cycle })}
                      />
                    </Field>
                    <Field label="下次续费日">
                      <input
                        type="date"
                        value={form.dueDate}
                        onChange={(e) => setForm({ ...form, dueDate: e.target.value })}
                        className="rounded-md border border-border bg-transparent px-1.5 py-1 text-body outline-none focus:border-primary/50"
                      />
                    </Field>
                    <Field label="开始日期（可选，纯记录）">
                      <input
                        type="date"
                        value={form.startDate}
                        onChange={(e) => setForm({ ...form, startDate: e.target.value })}
                        className="rounded-md border border-border bg-transparent px-1.5 py-1 text-body outline-none focus:border-primary/50"
                      />
                    </Field>
                  </>
                ) : (
                  <Field label="每月还款日">
                    <div className="flex items-center gap-1.5">
                      <input
                        type="number"
                        min="1"
                        max="31"
                        value={form.repayDay}
                        onChange={(e) => setForm({ ...form, repayDay: e.target.value })}
                        className="w-14 rounded-md border border-border bg-transparent px-1.5 py-1 text-body tabular-nums outline-none focus:border-primary/50"
                        aria-label="每月还款日（1-31）"
                      />
                      <span className="text-label text-muted-foreground">
                        日（短月自动顺延到月末）
                      </span>
                    </div>
                  </Field>
                )}
                <Field label="到期提醒">
                  <div className="flex flex-wrap gap-1">
                    {BILL_REMINDER_OFFSET_OPTIONS.map((offset) => {
                      const on = form.offsets.includes(offset);
                      return (
                        <button
                          key={offset}
                          role="checkbox"
                          aria-checked={on}
                          onClick={() =>
                            setForm({
                              ...form,
                              offsets: on
                                ? form.offsets.filter((o) => o !== offset)
                                : [...form.offsets, offset],
                            })
                          }
                          className={cn(
                            "rounded-full px-2 py-0.5 text-label transition-colors",
                            on
                              ? "bg-primary text-primary-foreground"
                              : "bg-black/5 text-muted-foreground hover:text-foreground dark:bg-white/10"
                          )}
                        >
                          {OFFSET_LABEL[offset]}
                        </button>
                      );
                    })}
                  </div>
                </Field>
                <Field label="支付方式（可选）">
                  <input
                    value={form.payMethod}
                    onChange={(e) => setForm({ ...form, payMethod: e.target.value })}
                    placeholder="如 支付宝 / 微信 / 招行卡尾号 1234"
                    className="w-full rounded-md border border-border bg-transparent px-1.5 py-1 text-body outline-none focus:border-primary/50"
                  />
                </Field>
                <Field label="备注（可选）">
                  <input
                    value={form.note}
                    onChange={(e) => setForm({ ...form, note: e.target.value })}
                    className="w-full rounded-md border border-border bg-transparent px-1.5 py-1 text-body outline-none focus:border-primary/50"
                  />
                </Field>
                <div className="mt-auto border-t border-border/50 pt-2">
                  <Button size="sm" className="w-full" onClick={submit}>
                    {edit ? "保存修改" : "添加"}
                  </Button>
                </div>
              </div>
            )
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-micro text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
