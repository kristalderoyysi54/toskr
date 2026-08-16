import { BILL_CATALOG_GENERATED } from "@/components/subscriptions/billCatalog.generated";
import type { BillCycle } from "@/store/notesStore";

// ===== 预置服务目录（数据由 grok brand-icons 项目经脚本生成；本文件只放类型与标签）=====
// 更新流程：grok 项目里补新服务/图标 → `node script/import-brand-icons.mjs` 重新生成。

export type CatalogCategory =
  | "entertainment"
  | "music"
  | "productivity"
  | "dev"
  | "ai"
  | "cloud"
  | "creditCard"
  | "other";

export interface CatalogService {
  id: string;
  name: string;
  /** 别名（中英文另一侧），搜索时一并匹配。 */
  nameAlt?: string;
  /** favicon 兜底抓取域名（有内置品牌图时用不到）。 */
  domain?: string;
  category: CatalogCategory;
  /** 预填周期建议（表单可改）；creditCard 类忽略（固定每月还款日）。 */
  defaultCycle?: BillCycle;
}

export const CATALOG_CATEGORY_LABEL: Record<CatalogCategory, string> = {
  entertainment: "娱乐",
  music: "音乐",
  productivity: "生产力",
  dev: "开发",
  ai: "AI",
  cloud: "云存储",
  creditCard: "信用卡",
  other: "其他",
};

export const CATALOG_CATEGORIES: CatalogCategory[] = [
  "entertainment",
  "music",
  "ai",
  "productivity",
  "dev",
  "cloud",
  "creditCard",
  "other",
];

export const BILL_CATALOG: CatalogService[] = BILL_CATALOG_GENERATED;
