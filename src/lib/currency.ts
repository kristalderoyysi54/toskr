import { api } from "@/lib/tauri";

// ===== 汇率缓存与换算（USD 基准；每日抓取一次，localStorage 缓存）=====

/** 货币符号 → ISO 代码（与添加表单的 CURRENCY_OPTIONS 对齐）。 */
export const SYMBOL_TO_CODE: Record<string, string> = {
  "¥": "CNY",
  "US$": "USD",
  $: "USD",
  "€": "EUR",
  "£": "GBP",
  HK$: "HKD",
  "JP¥": "JPY",
};

export interface FxCache {
  /** 抓取时间（本地缓存时间戳，非行情时间）。 */
  fetchedAt: number;
  /** code → 每 1 USD 兑换量。 */
  rates: Record<string, number>;
}

const FX_KEY = "toskr-fx-rates";
const FX_TTL_MS = 24 * 60 * 60 * 1000;

export function cachedFx(): FxCache | null {
  try {
    const raw = localStorage.getItem(FX_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as FxCache;
    if (
      typeof parsed?.fetchedAt !== "number" ||
      !parsed.rates ||
      typeof parsed.rates !== "object"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

let inflight: Promise<FxCache | null> | null = null;

/** 取汇率：缓存 24h 内直接用；过期重抓，抓失败回退过期缓存（好过没有）。 */
export function ensureFx(): Promise<FxCache | null> {
  const hit = cachedFx();
  if (hit && Date.now() - hit.fetchedAt < FX_TTL_MS) return Promise.resolve(hit);
  if (!inflight) {
    inflight = api
      .fetchExchangeRates()
      .then((rates) => {
        const fx: FxCache = { fetchedAt: Date.now(), rates };
        localStorage.setItem(FX_KEY, JSON.stringify(fx));
        return fx;
      })
      .catch(() => hit)
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** 金额乘数：某币种 → 主货币。undefined 币种视为主货币（乘数 1）。 */
export type CurrencyConverter = (currency: string | undefined) => number;

/**
 * 构造换算器；主货币代码未知或无汇率时返回 null（调用方回退分列显示）。
 * 未知符号按 1:1 近似（自定义符号无从换算，宁可保守显示）。
 */
export function makeConverter(
  primarySymbol: string,
  fx: FxCache | null
): CurrencyConverter | null {
  if (!fx) return null;
  const primaryCode = SYMBOL_TO_CODE[primarySymbol];
  const primaryRate = primaryCode ? fx.rates[primaryCode] : undefined;
  if (!primaryRate || !Number.isFinite(primaryRate) || primaryRate <= 0) return null;
  return (currency) => {
    if (!currency || currency === primarySymbol) return 1;
    const code = SYMBOL_TO_CODE[currency];
    const rate = code ? fx.rates[code] : undefined;
    if (!rate || !Number.isFinite(rate) || rate <= 0) return 1;
    return primaryRate / rate;
  };
}
