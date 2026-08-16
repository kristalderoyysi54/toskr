import { useState } from "react";
import { Check, MoreHorizontal, X } from "lucide-react";

import {
  SimpleMenu,
  SimpleMenuItem,
  SimpleMenuSeparator,
} from "@/components/SimpleMenu";
import { brandIconUrl } from "@/components/subscriptions/brandIcons";
import { EmptyState } from "@/components/ui/empty-state";
import { IconButton } from "@/components/ui/icon-button";
import {
  billAvatarInitial,
  billsDueWithinDays,
  cardPaidForCurrentCycle,
  compareBills,
  CYCLE_LABEL,
  formatBillAmount,
  startOfBillDay,
} from "@/lib/bills";
import { useNoteThumb } from "@/lib/media";
import { setPendingUndo, tip } from "@/lib/tip";
import { cn } from "@/lib/utils";
import { useNotesStore, type Bill } from "@/store/notesStore";
import { useUIStore } from "@/store/uiStore";

/** 账单头像：内置品牌图 → favicon 缓存图 → 首字色块。 */
export function BillAvatar({ bill, size = "md" }: { bill: Bill; size?: "md" | "sm" }) {
  const brand = brandIconUrl(bill.catalogId);
  const favicon = useNoteThumb(brand ? undefined : bill.iconFile);
  const icon = brand ?? favicon;
  const cls = size === "md" ? "size-6 rounded-md" : "size-3.5 rounded-sm";
  if (icon) {
    return <img src={icon} alt="" className={cn(cls, "shrink-0 object-cover")} />;
  }
  return (
    <span
      className={cn(
        cls,
        "flex shrink-0 items-center justify-center font-semibold text-white",
        size === "md" ? "text-label" : "text-micro"
      )}
      style={{ backgroundColor: bill.fallbackColor }}
      aria-hidden
    >
      {billAvatarInitial(bill.name)}
    </span>
  );
}

/** 到期徽标文案（账单按天粒度，与任务的时分粒度徽标区分）。 */
export function billDueBadge(bill: Bill, now: number): { text: string; tone: "overdue" | "today" | "later" } {
  const days = Math.round(
    (startOfBillDay(bill.nextDueAt) - startOfBillDay(now)) / 86_400_000
  );
  const d = new Date(bill.nextDueAt);
  const date = `${d.getMonth() + 1}/${d.getDate()}`;
  if (days < 0) return { text: `逾期 ${-days} 天`, tone: "overdue" };
  if (days === 0) return { text: "今天", tone: "today" };
  if (days === 1) return { text: "明天", tone: "today" };
  if (days < 7) return { text: `${days} 天后`, tone: "later" };
  return { text: date, tone: "later" };
}

const STATUS_LABEL: Record<Bill["status"], string> = {
  active: "",
  paused: "已暂停",
  canceled: "已取消",
};

/** 单条账单行：头像 + 名称/周期金额 + 到期徽标 + 悬停操作。 */
export function BillRow({
  bill,
  now,
  onEdit,
}: {
  bill: Bill;
  now: number;
  onEdit: (bill: Bill) => void;
}) {
  const globalCurrency = useNotesStore((s) => s.settings.currencySymbol);
  const currency = bill.currency ?? globalCurrency;
  const flash = useUIStore((s) => s.flashId === `bill:${bill.id}`);
  const [paying, setPaying] = useState(false);
  const [payAmount, setPayAmount] = useState("");
  const badge = billDueBadge(bill, now);
  const inactive = bill.status !== "active";
  // 信用卡本期已还：状态徽标转绿、隐藏「标记已还」按钮直到下期
  const paidThisCycle = cardPaidForCurrentCycle(bill, now);

  const setStatus = (status: Bill["status"], label: string) => {
    useNotesStore.getState().updateBill(bill.id, { status });
    tip("ok", label);
  };

  const remove = () => {
    useNotesStore.getState().deleteBill(bill.id);
    setPendingUndo(() => {
      useNotesStore.getState().undo();
    });
    tip("info", `已删除「${bill.name}」`, true);
  };

  const confirmPaid = () => {
    const amount = Number(payAmount);
    if (!Number.isFinite(amount) || amount < 0) {
      tip("warn", "金额无效");
      return;
    }
    useNotesStore.getState().markBillPaid(bill.id, amount);
    setPaying(false);
    tip("ok", `「${bill.name}」本期已还 ${currency}${formatBillAmount(amount)}`);
  };

  return (
    <div
      className={cn(
        "group rounded-lg px-1.5 py-1.5 transition-colors hover:bg-black/5 dark:hover:bg-white/10",
        flash && "ring-2 ring-primary/60"
      )}
      data-bill-id={bill.id}
    >
      <div className="flex items-center gap-2">
        <BillAvatar bill={bill} />
        <div className="min-w-0 flex-1">
          <p className={cn("truncate text-body font-medium", inactive && "text-muted-foreground line-through decoration-muted-foreground/50")}>
            {bill.name}
          </p>
          <p className="truncate text-micro text-muted-foreground">
            {bill.kind === "creditCard"
              ? `每月 ${new Date(bill.nextDueAt).getDate()} 日还款`
              : CYCLE_LABEL[bill.cycle]}
            {bill.amount != null &&
              bill.amount !== 0 &&
              ` · ${currency}${formatBillAmount(bill.amount)}`}
            {bill.payMethod && ` · ${bill.payMethod}`}
            {inactive && ` · ${STATUS_LABEL[bill.status]}`}
          </p>
        </div>
        {bill.kind === "creditCard" && !inactive && !paying && !paidThisCycle && (
          <IconButton
            label="标记已还"
            size="xs"
            reveal="hover-focus"
            onClick={() => {
              setPayAmount(bill.amount != null ? String(bill.amount) : "");
              setPaying(true);
            }}
          >
            <Check />
          </IconButton>
        )}
        <SimpleMenu
          className="flex"
          trigger={({ toggle, controls, open }) => (
            <IconButton
              label={`「${bill.name}」更多操作`}
              size="xs"
              reveal="hover-focus"
              aria-expanded={open}
              aria-controls={controls}
              onClick={toggle}
            >
              <MoreHorizontal />
            </IconButton>
          )}
        >
          {(close) => (
            <>
              <SimpleMenuItem
                onClick={() => {
                  close();
                  onEdit(bill);
                }}
              >
                编辑
              </SimpleMenuItem>
              {bill.status === "active" ? (
                <>
                  <SimpleMenuItem
                    onClick={() => {
                      close();
                      setStatus("paused", `已暂停「${bill.name}」`);
                    }}
                  >
                    暂停（不再提醒）
                  </SimpleMenuItem>
                  <SimpleMenuItem
                    onClick={() => {
                      close();
                      setStatus("canceled", `已标记取消「${bill.name}」`);
                    }}
                  >
                    标记已取消
                  </SimpleMenuItem>
                </>
              ) : (
                <SimpleMenuItem
                  onClick={() => {
                    close();
                    setStatus("active", `已恢复「${bill.name}」`);
                  }}
                >
                  恢复启用
                </SimpleMenuItem>
              )}
              <SimpleMenuSeparator />
              <SimpleMenuItem
                destructive
                onClick={() => {
                  close();
                  remove();
                }}
              >
                删除
              </SimpleMenuItem>
            </>
          )}
        </SimpleMenu>
        {/* 徽标恒为行尾元素：各行操作按钮数量不同（订阅 1 / 信用卡 2），
            放按钮之前会导致日期列参差不齐 */}
        {!inactive &&
          (paidThisCycle ? (
            <span className="shrink-0 rounded-sm bg-success/10 px-1 py-px text-right text-micro tabular-nums text-success">
              已还 · 下期 {new Date(bill.nextDueAt).getMonth() + 1}/
              {new Date(bill.nextDueAt).getDate()}
            </span>
          ) : (
            <span
              className={cn(
                "shrink-0 rounded-sm px-1 py-px text-right text-micro tabular-nums",
                badge.tone === "overdue" && "bg-destructive/10 text-destructive",
                badge.tone === "today" && "bg-amber-500/15 text-amber-600 dark:text-amber-400",
                badge.tone === "later" && "text-muted-foreground"
              )}
            >
              {badge.text}
            </span>
          ))}
      </div>
      {paying && (
        <div className="mt-1.5 flex items-center gap-1.5 pl-8">
          <span className="text-micro text-muted-foreground">本期实付</span>
          <input
            autoFocus
            type="number"
            min="0"
            step="0.01"
            value={payAmount}
            onChange={(e) => setPayAmount(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") confirmPaid();
              if (e.key === "Escape") setPaying(false);
            }}
            className="w-20 rounded-md border border-border bg-transparent px-1.5 py-0.5 text-body tabular-nums outline-none focus:border-primary/50"
            aria-label="本期实付金额"
          />
          <IconButton label="确认已还" size="xs" onClick={confirmPaid}>
            <Check />
          </IconButton>
          <IconButton label="取消" size="xs" onClick={() => setPaying(false)}>
            <X />
          </IconButton>
        </div>
      )}
    </div>
  );
}

/** 账单列表：「即将到期 / 全部」两段切换。 */
export function BillList({
  bills,
  now,
  filter,
  onEdit,
}: {
  bills: Bill[];
  now: number;
  filter: "upcoming" | "all";
  onEdit: (bill: Bill) => void;
}) {
  const list =
    filter === "upcoming"
      ? billsDueWithinDays(bills, now, 7)
      : [...bills].sort(compareBills);
  if (!list.length) {
    return (
      <EmptyState
        variant="inline"
        title={filter === "upcoming" ? "未来 7 天没有到期账单" : "还没有账单"}
      />
    );
  }
  // 归类区分（用户指定 2026-08-16）：订阅与信用卡还款分组展示，组内保持原序
  const subs = list.filter((b) => b.kind === "subscription");
  const cards = list.filter((b) => b.kind === "creditCard");
  const showHeaders = subs.length > 0 && cards.length > 0;
  const group = (label: string, items: Bill[]) =>
    items.length > 0 && (
      <div>
        {showHeaders && (
          <p className="px-1.5 pb-0.5 pt-1 text-micro font-medium text-muted-foreground">
            {label}
          </p>
        )}
        <div className="flex flex-col gap-0.5">
          {items.map((bill) => (
            <BillRow key={bill.id} bill={bill} now={now} onEdit={onEdit} />
          ))}
        </div>
      </div>
    );
  return (
    <div className="flex flex-col gap-0.5">
      {group("订阅", subs)}
      {group("信用卡还款", cards)}
    </div>
  );
}
