/** 与 Rust 侧 is_image_file_path 一致的扩展名白名单（image crate 可解码集合）。 */
const IMAGE_FILE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
]);

/** 拖拽/粘贴的本地路径里筛出可导入的图片文件（大小写不敏感）。 */
export function imageFilePaths(paths: readonly string[]): string[] {
  return paths.filter((path) => {
    const name = path.split("/").pop() ?? "";
    const dot = name.lastIndexOf(".");
    if (dot <= 0) return false;
    return IMAGE_FILE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
  });
}
