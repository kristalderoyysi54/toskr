/** 整段文本就是一个 http(s) 链接时返回该 URL，否则 undefined。 */
export function detectLink(text: string): string | undefined {
  const t = text.trim();
  if (!/^https?:\/\/\S+$/i.test(t)) return undefined;
  try {
    new URL(t);
    return t;
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
