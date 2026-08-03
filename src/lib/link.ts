/**
 * 常见 TLD 白名单：无 scheme 的裸域名只在顶级域命中时才识别为链接，
 * 避免把 README.md（.md 是真 TLD）、com.apple.Terminal（bundle id）、
 * package.json 之类误判成链接。
 */
const BARE_TLDS = new Set([
  "com", "org", "net", "edu", "gov", "mil", "int",
  "io", "dev", "app", "ai", "me", "co", "cc", "tv", "sh", "im", "so",
  "gg", "gs", "to", "ly", "fm", "am", "run", "link", "site", "tech",
  "xyz", "top", "info", "biz", "pro", "moe", "one", "red", "icu", "art",
  "online", "store", "fun", "live", "news", "vip", "work", "club",
  "blog", "page", "zone", "plus", "space", "world", "today", "cloud",
  "email", "network", "group", "team", "life", "design", "video", "wiki",
  "cn", "hk", "tw", "jp", "kr", "sg", "us", "uk", "de", "fr", "ru", "in",
]);

/**
 * 整段文本就是一个链接时返回可打开的完整 URL，否则 undefined。
 * 浏览器地址栏复制常不带 `https://`（如 `github.com/x`），
 * 对这类裸域名按 TLD 白名单识别并补全 scheme；卡片文本保持原文。
 */
export function detectLink(text: string): string | undefined {
  const t = text.trim();
  if (/^https?:\/\/\S+$/i.test(t)) {
    try {
      new URL(t);
      return t;
    } catch {
      return undefined;
    }
  }
  const m = /^((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+([a-z]{2,24}))(?::\d{1,5})?(?:[/?#]\S*)?$/i.exec(
    t
  );
  if (!m || !BARE_TLDS.has(m[2].toLowerCase())) return undefined;
  const candidate = `https://${t}`;
  try {
    new URL(candidate);
    return candidate;
  } catch {
    return undefined;
  }
}

/** 链接展示信息：域名 + 路径（去掉协议与 www）。 */
export function linkParts(url: string): { host: string; path: string } {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    const path = (u.pathname + u.search).replace(/\/$/, "");
    return { host, path: path === "" ? "/" : path };
  } catch {
    return { host: url, path: "" };
  }
}
