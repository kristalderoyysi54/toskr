import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Download, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { floatingSurface } from "@/components/ui/floating-surface";
import { ProgressBar } from "@/components/ui/progress-bar";
import { springModal, tweenFade } from "@/lib/motion";
import { installPendingUpdate } from "@/lib/updater";
import { cn } from "@/lib/utils";
import { useUIStore } from "@/store/uiStore";

/**
 * 面板内更新对话框（头部「更新」按钮 / 更新气泡点击唤起）：
 * 版本对比 + 更新内容 + 一键下载安装（完成后自动重启）。
 * 背景高斯模糊压暗，聚焦对话框本身。下载中不可取消（updater 无中断 API）。
 */
export function UpdateDialog() {
  const open = useUIStore((s) => s.updateDialogOpen);
  const meta = useUIStore((s) => s.updateAvail);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState(0);

  const close = () => {
    if (downloading) return;
    useUIStore.getState().setUpdateDialogOpen(false);
  };

  const start = async () => {
    setDownloading(true);
    setProgress(0);
    const ok = await installPendingUpdate(setProgress);
    // 成功路径应用会自动重启；走到这里即失败（HUD 已弹具体原因）
    if (!ok) setDownloading(false);
  };

  return (
    <AnimatePresence>
      {open && meta && (
        <motion.div
          key="update-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={tweenFade}
          className="absolute inset-0 z-50 flex items-center justify-center bg-black/30 p-4 backdrop-blur-md"
          onClick={close}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="软件更新"
            initial={{ opacity: 0, scale: 0.94, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={springModal}
            className={cn(
              "w-full max-w-[320px] rounded-xl p-4",
              floatingSurface(3)
            )}
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-title font-semibold">软件更新</p>
            <p className="mt-0.5 text-label text-primary">发现新版本可用</p>

            <div className="mt-3 flex items-center gap-2 font-mono text-body tabular-nums">
              <span className="text-muted-foreground">v{meta.current}</span>
              <ArrowRight className="size-3.5 text-muted-foreground" />
              <span className="font-semibold text-primary">v{meta.version}</span>
            </div>

            <p className="mt-3 text-label font-medium text-muted-foreground">更新内容</p>
            <div className="mt-1 max-h-36 overflow-y-auto whitespace-pre-wrap text-body leading-relaxed text-foreground/80">
              {meta.notes.trim() || "常规改进与问题修复。"}
            </div>

            {downloading && (
              <div className="mt-3">
                <div className="flex items-center justify-between text-micro tabular-nums text-muted-foreground">
                  <span>下载中…</span>
                  <span>{progress}% · 完成后自动重启</span>
                </div>
                <ProgressBar value={progress} tactile className="mt-1 w-full" />
              </div>
            )}

            <div className="mt-4 flex items-center justify-end gap-2">
              <Button size="xs" onClick={close} disabled={downloading}>
                取消
              </Button>
              <Button size="xs" onClick={() => void start()} disabled={downloading}>
                {downloading ? (
                  <>
                    <RefreshCw className="size-3 animate-spin" /> 下载中…
                  </>
                ) : (
                  <>
                    <Download className="size-3" /> 立即下载
                  </>
                )}
              </Button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
