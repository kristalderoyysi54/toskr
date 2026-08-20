/**
 * 消息监听的目标 IM 档案：由用户在设置里「探测并确认」后写入，代码不预置任何具体应用。
 * 仅存本机 localStorage（非敏感，且随机器/安装位置而定，不入云备份）。
 */
export interface ImProfile {
  /** 显示名，兼作 `open -a` 目标与来源标注。 */
  appName: string;
  /** bundle identifier，安装校验与去重用。 */
  bundleId: string;
  /** 主可执行文件绝对路径，Rust 侧据此带调试端口重启目标 IM。 */
  binPath: string;
}

const KEY = "toskr.im-profile.v1";

function valid(value: Partial<ImProfile> | null | undefined): value is ImProfile {
  return (
    !!value &&
    typeof value.appName === "string" &&
    !!value.appName &&
    typeof value.bundleId === "string" &&
    !!value.bundleId &&
    typeof value.binPath === "string" &&
    !!value.binPath
  );
}

export function getImProfile(): ImProfile | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ImProfile>;
    if (valid(parsed)) {
      return { appName: parsed.appName, bundleId: parsed.bundleId, binPath: parsed.binPath };
    }
  } catch {
    // 损坏值当作未配置。
  }
  return null;
}

export function setImProfile(profile: ImProfile | null): void {
  try {
    if (profile) localStorage.setItem(KEY, JSON.stringify(profile));
    else localStorage.removeItem(KEY);
  } catch {
    // localStorage 不可用时静默：监听为增强功能，不阻断主流程。
  }
}
