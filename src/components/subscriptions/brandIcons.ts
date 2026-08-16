// 内置品牌图标（App Store 官方 artwork，128px；由 script/import-brand-icons.mjs 同步）
// Vite 构建期打包为资源 URL，按目录条目 id 查找。
const modules = import.meta.glob("@/assets/brand-icons/*.png", {
  eager: true,
  import: "default",
  query: "?url",
}) as Record<string, string>;

const byId = new Map<string, string>();
for (const [file, url] of Object.entries(modules)) {
  const id = file.split("/").pop()!.replace(/\.png$/, "");
  byId.set(id, url);
}

/** 目录条目 id → 内置图标 URL；无则 undefined（回退 favicon/首字色块）。 */
export function brandIconUrl(catalogId: string | undefined): string | undefined {
  return catalogId ? byId.get(catalogId) : undefined;
}
