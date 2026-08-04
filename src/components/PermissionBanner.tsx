import { KeyboardOff, ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { api } from "@/lib/tauri";
import { useUIStore } from "@/store/uiStore";

/**
 * 权限引导横幅（纯展示）：状态由 App 级常驻守护写入 uiStore。
 * 两类问题分开引导：
 * 1. 辅助功能未授权 / 监听未创建
 * 2. 监听已创建却收不到键盘事件（Sequoia 输入监控权限被扣的特征）
 */
export function PermissionBanner() {
  const axOk = useUIStore((s) => s.permissionAx);
  const installed = useUIStore((s) => s.permissionInstalled);
  const receiving = useUIStore((s) => s.permissionReceiving);
  const stuck = useUIStore((s) => s.eventsStuck);

  if (axOk && installed && receiving) return null;

  // 情形 2：输入监控被扣（tap 建了但事件流不来）
  if (axOk && installed && stuck) {
    return (
      <div className="mx-3 mb-2 rounded-xl border border-orange-500/30 bg-orange-500/10 p-3">
        <div className="flex items-center gap-1.5 text-[12px] font-medium text-orange-600 dark:text-orange-400">
          <KeyboardOff className="size-3.5" />
          键盘事件被系统拦截
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          监听已创建但收不到按键——通常是「输入监控」权限未对当前签名生效。请在系统设置
          → 隐私与安全性 → <b>输入监控</b> 中删除旧的 Toskr 条目并重新添加/勾选，
          然后点击下方重启。
        </p>
        <div className="mt-2 flex gap-1.5">
          <Button
            size="xs"
            variant="outline"
            onClick={() => api.openPrivacySettings("input-monitoring")}
          >
            打开输入监控设置
          </Button>
          <Button size="xs" onClick={() => api.restartApp()}>
            重启 Toskr
          </Button>
        </div>
      </div>
    );
  }

  // 情形 2 观察期（<12s）：不打扰
  if (axOk && installed) return null;

  // 情形 1：辅助功能未授权 / 监听未创建
  return (
    <div className="mx-3 mb-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3">
      <div className="flex items-center gap-1.5 text-[12px] font-medium text-amber-600 dark:text-amber-400">
        <ShieldAlert className="size-3.5" />
        需要「辅助功能」权限
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
        Toskr 依赖辅助功能权限监听双击 ⇧ 并读取选中文本。请在系统设置中勾选
        Toskr（若列表已有旧条目请先删除再重新添加），授权后几秒内自动生效。
      </p>
      <div className="mt-2 flex gap-1.5">
        <Button
          size="xs"
          variant="outline"
          onClick={() => api.openPrivacySettings("accessibility")}
        >
          打开辅助功能设置
        </Button>
      </div>
    </div>
  );
}
