import { Button } from "toskr";

const Row = ({ children }: { children: React.ReactNode }) => (
  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>{children}</div>
);

export const Variants = () => (
  <Row>
    <Button>检查更新</Button>
    <Button variant="secondary">立即备份</Button>
    <Button variant="ghost">恢复默认</Button>
    <Button variant="destructive">清空全部</Button>
    <Button variant="link">查看日志</Button>
  </Row>
);

export const Sizes = () => (
  <Row>
    <Button size="xs">迷你 xs</Button>
    <Button size="sm">小 sm</Button>
    <Button>默认</Button>
    <Button size="lg">大 lg</Button>
  </Row>
);

export const IconSizes = () => (
  <Row>
    <Button size="icon-xs" aria-label="添加">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M12 5v14M5 12h14" />
      </svg>
    </Button>
    <Button size="icon-sm" aria-label="添加">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M12 5v14M5 12h14" />
      </svg>
    </Button>
    <Button size="icon" aria-label="添加">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M12 5v14M5 12h14" />
      </svg>
    </Button>
  </Row>
);

export const States = () => (
  <Row>
    <Button disabled>处理中…</Button>
    <Button variant="destructive" disabled>
      清空全部
    </Button>
    <Button asChild>
      <a href="#top">以链接渲染</a>
    </Button>
  </Row>
);
