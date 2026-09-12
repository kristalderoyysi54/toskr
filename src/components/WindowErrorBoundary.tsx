import { Component, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

/** 窗口故障只提供重载，不清空持久化数据，也不展示可能含原文的异常。 */
export class WindowErrorBoundary extends Component<
  { children: ReactNode; onFailure?: () => void },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    this.props.onFailure?.();
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="flex min-h-full flex-col items-center justify-center gap-3 bg-background p-4 text-body text-foreground">
        <p>当前窗口加载失败，请重新加载。</p>
        <p className="text-label text-muted-foreground">已保存的数据会保留；尚未保存的编辑可能丢失。</p>
        <Button onClick={() => window.location.reload()}>重新加载窗口</Button>
      </div>
    );
  }
}
