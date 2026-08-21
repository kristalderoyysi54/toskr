import { KeyboardOff, ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { api } from "@/lib/tauri";
import { resetInputMonitoringAndReopen } from "@/lib/permissionRecovery";
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
      <div role="alert" className="mx-3 mb-2 rounded-xl border border-destructive/30 bg-destructive/10 p-3">
        <div className="flex items-center gap-1.5 text-body font-medium text-destructive">
          <KeyboardOff className="size-3.5" />
          键盘事件被系统拦截
        </div>
        <p className="mt-1 text-label leading-relaxed text-muted-foreground">
          监听已创建但收不到按键——通常是「输入监控」授权条目未对当前签名生效
          （<b>即使开关已打开</b>也会如此）。点「一键重置授权」自动删除旧条目，
          在打开的设置里重新勾选/添加 Toskr，再点「重启」即可恢复。
        </p>
        <div className="mt-2 flex gap-1.5">
          <Button size="xs" onClick={() => void resetInputMonitoringAndReopen()}>
            一键重置授权
          </Button>
          <Button
            size="xs"
            variant="outline"
            onClick={() => api.openPrivacySettings("input-monitoring")}
          >
            打开输入监控设置
          </Button>
          <Button size="xs" variant="outline" onClick={() => api.restartApp()}>
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
    <div role="alert" className="mx-3 mb-2 rounded-xl border border-warning/30 bg-warning/10 p-3">
      <div className="flex items-center gap-1.5 text-body font-medium text-warning">
        <ShieldAlert className="size-3.5" />
        需要「辅助功能」权限
      </div>
      <p className="mt-1 text-label leading-relaxed text-muted-foreground">
        Toskr 依赖辅助功能权限监听双击 ⇧ Shift 并读取选中文本。请在系统设置中勾选
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
