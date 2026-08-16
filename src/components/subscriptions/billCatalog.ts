import type { BillCycle } from "@/store/notesStore";

// ===== 预置服务目录（添加账单的速选数据；纯数据，非组件）=====

export type CatalogCategory =
  | "entertainment"
  | "music"
  | "productivity"
  | "dev"
  | "ai"
  | "cloud"
  | "creditCard";

export interface CatalogService {
  id: string;
  name: string;
  /** favicon 抓取域名；缺省走首字色块。 */
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
};

export const CATALOG_CATEGORIES: CatalogCategory[] = [
  "entertainment",
  "music",
  "productivity",
  "dev",
  "ai",
  "cloud",
  "creditCard",
];

export const BILL_CATALOG: CatalogService[] = [
  // 娱乐
  { id: "netflix", name: "Netflix", domain: "netflix.com", category: "entertainment", defaultCycle: "monthly" },
  { id: "youtube-premium", name: "YouTube Premium", domain: "youtube.com", category: "entertainment", defaultCycle: "monthly" },
  { id: "disney-plus", name: "Disney+", domain: "disneyplus.com", category: "entertainment", defaultCycle: "monthly" },
  { id: "iqiyi", name: "爱奇艺", domain: "iqiyi.com", category: "entertainment", defaultCycle: "monthly" },
  { id: "tencent-video", name: "腾讯视频", domain: "v.qq.com", category: "entertainment", defaultCycle: "monthly" },
  { id: "youku", name: "优酷", domain: "youku.com", category: "entertainment", defaultCycle: "monthly" },
  { id: "bilibili", name: "哔哩哔哩大会员", domain: "bilibili.com", category: "entertainment", defaultCycle: "yearly" },
  { id: "hbo-max", name: "HBO Max", domain: "max.com", category: "entertainment", defaultCycle: "monthly" },
  // 音乐
  { id: "spotify", name: "Spotify", domain: "spotify.com", category: "music", defaultCycle: "monthly" },
  { id: "apple-music", name: "Apple Music", domain: "music.apple.com", category: "music", defaultCycle: "monthly" },
  { id: "qq-music", name: "QQ 音乐豪华绿钻", domain: "y.qq.com", category: "music", defaultCycle: "monthly" },
  { id: "netease-music", name: "网易云音乐黑胶", domain: "music.163.com", category: "music", defaultCycle: "monthly" },
  // 生产力
  { id: "notion", name: "Notion", domain: "notion.so", category: "productivity", defaultCycle: "monthly" },
  { id: "microsoft-365", name: "Microsoft 365", domain: "microsoft.com", category: "productivity", defaultCycle: "yearly" },
  { id: "google-one", name: "Google One", domain: "one.google.com", category: "productivity", defaultCycle: "monthly" },
  { id: "icloud-plus", name: "iCloud+", domain: "icloud.com", category: "productivity", defaultCycle: "monthly" },
  { id: "todoist", name: "Todoist", domain: "todoist.com", category: "productivity", defaultCycle: "yearly" },
  { id: "wps", name: "WPS 超级会员", domain: "wps.cn", category: "productivity", defaultCycle: "yearly" },
  { id: "1password", name: "1Password", domain: "1password.com", category: "productivity", defaultCycle: "yearly" },
  // 开发
  { id: "github-copilot", name: "GitHub Copilot", domain: "github.com", category: "dev", defaultCycle: "monthly" },
  { id: "jetbrains", name: "JetBrains 全家桶", domain: "jetbrains.com", category: "dev", defaultCycle: "yearly" },
  { id: "vercel", name: "Vercel", domain: "vercel.com", category: "dev", defaultCycle: "monthly" },
  { id: "cloudflare", name: "Cloudflare", domain: "cloudflare.com", category: "dev", defaultCycle: "monthly" },
  { id: "setapp", name: "Setapp", domain: "setapp.com", category: "dev", defaultCycle: "monthly" },
  // AI
  { id: "chatgpt-plus", name: "ChatGPT Plus", domain: "openai.com", category: "ai", defaultCycle: "monthly" },
  { id: "claude-pro", name: "Claude Pro", domain: "claude.ai", category: "ai", defaultCycle: "monthly" },
  { id: "midjourney", name: "Midjourney", domain: "midjourney.com", category: "ai", defaultCycle: "monthly" },
  { id: "cursor", name: "Cursor", domain: "cursor.com", category: "ai", defaultCycle: "monthly" },
  { id: "kimi", name: "Kimi 会员", domain: "kimi.moonshot.cn", category: "ai", defaultCycle: "monthly" },
  // 云存储
  { id: "dropbox", name: "Dropbox", domain: "dropbox.com", category: "cloud", defaultCycle: "yearly" },
  { id: "aliyundrive", name: "阿里云盘会员", domain: "alipan.com", category: "cloud", defaultCycle: "yearly" },
  { id: "baidu-pan", name: "百度网盘超级会员", domain: "pan.baidu.com", category: "cloud", defaultCycle: "yearly" },
  { id: "backblaze", name: "Backblaze", domain: "backblaze.com", category: "cloud", defaultCycle: "yearly" },
  // 信用卡（银行速选：无域名意义不大，抓主站 favicon；失败即首字色块）
  { id: "cmb-card", name: "招商银行信用卡", domain: "cmbchina.com", category: "creditCard" },
  { id: "icbc-card", name: "工商银行信用卡", domain: "icbc.com.cn", category: "creditCard" },
  { id: "ccb-card", name: "建设银行信用卡", domain: "ccb.com", category: "creditCard" },
  { id: "boc-card", name: "中国银行信用卡", domain: "boc.cn", category: "creditCard" },
  { id: "abc-card", name: "农业银行信用卡", domain: "abchina.com", category: "creditCard" },
  { id: "comm-card", name: "交通银行信用卡", domain: "bankcomm.com", category: "creditCard" },
  { id: "citic-card", name: "中信银行信用卡", domain: "citicbank.com", category: "creditCard" },
  { id: "pingan-card", name: "平安银行信用卡", domain: "bank.pingan.com", category: "creditCard" },
];
