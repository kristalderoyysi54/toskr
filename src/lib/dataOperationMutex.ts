let owner: symbol | null = null;

/** 单 WebView 数据事务互斥；claim 与赋值之间没有 await，因此在 JS 事件循环中原子。 */
export async function withDataOperationMutex<T>(
  label: string,
  operation: () => Promise<T>
): Promise<T> {
  if (owner) throw new Error(`已有数据操作进行中，无法同时${label}`);
  const token = Symbol(label);
  owner = token;
  try {
    return await operation();
  } finally {
    if (owner === token) owner = null;
  }
}

export function hasDataOperationOwner(): boolean {
  return owner !== null;
}
