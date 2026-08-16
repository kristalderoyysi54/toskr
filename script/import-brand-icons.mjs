#!/usr/bin/env node
// 从 grok brand-icons 项目导入订阅/信用卡品牌图标与目录：
//   node script/import-brand-icons.mjs [源目录]
// 默认源：~/Sites/me/Dev/Ai/grok/brand-icons（含 catalog.json 与 icons/*.png）
// 产物：
//   src/assets/brand-icons/{id}.png            （sips 降采样 128px，展示最大 32px 足够）
//   src/components/subscriptions/billCatalog.generated.ts
// grok 侧新增图标后重跑本脚本即可同步（更新流程见 tasks/todo.md）。

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.resolve(
  process.argv[2] ?? path.join(os.homedir(), "Sites/me/Dev/Ai/grok/brand-icons")
);
const catalogPath = path.join(source, "catalog.json");
if (!fs.existsSync(catalogPath)) {
  console.error(`找不到 ${catalogPath}`);
  process.exit(1);
}
const entries = JSON.parse(fs.readFileSync(catalogPath, "utf8"));

// 细分类映射（grok 目录只有 subscription/credit_card 两档；未列出的订阅归 other）
const FINE_CATEGORY = {
  music: ["spotify", "applemusic", "youtubemusic", "qqmusic", "neteasecloud", "kugou", "kuwo", "tidal", "soundcloud"],
  entertainment: [
    "netflix", "youtube", "disneyplus", "primevideo", "max", "hulu", "appletv",
    "crunchyroll", "paramountplus", "twitch", "bilibili", "iqiyi", "tencentvideo",
    "youku", "mgtv", "douyin", "kuaishou", "xigua", "nintendo", "playstation",
    "xbox", "steam", "audible", "kindle", "wereading", "ximalaya", "nyt", "youdao",
  ],
  ai: [
    "chatgpt", "claude", "gemini", "perplexity", "copilot", "midjourney", "kimi",
    "cursor", "doubao", "tongyi", "wenxin", "grok", "poe", "deepseek",
    "zhipuqingyan", "workbuddy", "qwen", "yuanbao", "namiai", "manus", "jimeng", "kling",
  ],
  productivity: [
    "microsoft365", "notion", "figma", "canva", "slack", "zoom", "grammarly",
    "1password", "duolingo", "linkedin", "dingtalk", "tencentmeeting", "wps",
    "evernote", "todoist", "obsidian", "setapp", "feishu", "processon", "xmind",
  ],
  dev: ["github", "jetbrains", "vercel", "cloudflare", "netlify", "openai", "replit"],
  cloud: [
    "icloud", "onedrive", "googledrive", "googleone", "dropbox", "baidunetdisk",
    "alicloud", "aliyundrive", "quark", "backblaze", "xunlei", "115", "123pan",
  ],
};
const fineCategoryOf = (entry) => {
  if (entry.category === "credit_card") return "creditCard";
  for (const [category, ids] of Object.entries(FINE_CATEGORY)) {
    if (ids.includes(entry.id)) return category;
  }
  return "other";
};

const assetDir = path.join(root, "src/assets/brand-icons");
fs.rmSync(assetDir, { recursive: true, force: true });
fs.mkdirSync(assetDir, { recursive: true });

const out = [];
let missingIcon = 0;
for (const entry of entries) {
  const iconSrc = path.join(source, "icons", `${entry.id}.png`);
  const hasIcon = fs.existsSync(iconSrc);
  if (hasIcon) {
    const iconDst = path.join(assetDir, `${entry.id}.png`);
    fs.copyFileSync(iconSrc, iconDst);
    execFileSync("sips", ["-Z", "128", iconDst], { stdio: "ignore" });
  } else {
    missingIcon += 1;
  }
  // 展示名：国内服务用中文名，国际品牌保留英文原名（辨识度）
  const display = entry.region === "cn" ? (entry.nameZh || entry.name) : entry.name;
  out.push({
    id: entry.id,
    name: display,
    nameAlt: display === entry.name ? entry.nameZh : entry.name,
    domain: entry.website || undefined,
    category: fineCategoryOf(entry),
    defaultCycle: "monthly",
  });
}

const header = `// 由 script/import-brand-icons.mjs 生成，勿手改；源：grok brand-icons 项目
// 重新生成：node script/import-brand-icons.mjs [源目录]
import type { CatalogService } from "@/components/subscriptions/billCatalog";

export const BILL_CATALOG_GENERATED: CatalogService[] = ${JSON.stringify(out, null, 2)};
`;
fs.writeFileSync(
  path.join(root, "src/components/subscriptions/billCatalog.generated.ts"),
  header
);
const sizeKb = fs
  .readdirSync(assetDir)
  .reduce((sum, f) => sum + fs.statSync(path.join(assetDir, f)).size, 0) / 1024;
console.log(
  `导入 ${out.length} 条（缺图标 ${missingIcon}）；资源 ${Math.round(sizeKb)}KB → src/assets/brand-icons`
);
