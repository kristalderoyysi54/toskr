import {
  IconButton,
  Kbd,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "toskr";

const CopyIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="11" height="11" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

/** 图标钮的 Radix 提示气泡：深底白字 + 箭头，内嵌 Kbd 快捷键提示。 */
export const Open = () => (
  <div style={{ display: "flex", justifyContent: "center", paddingTop: 60 }}>
    <TooltipProvider delayDuration={0}>
      <Tooltip defaultOpen>
        <TooltipTrigger asChild>
          <IconButton label="复制内容" withTitle={false} surface>
            <CopyIcon />
          </IconButton>
        </TooltipTrigger>
        <TooltipContent>
          复制内容
          <Kbd inline>⌘C</Kbd>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  </div>
);
