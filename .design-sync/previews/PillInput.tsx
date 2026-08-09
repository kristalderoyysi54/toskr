import { useState } from "react";
import { IconButton, PillInput } from "toskr";

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div style={{ width: 380 }}>{children}</div>
);

const LightbulbIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3a6 6 0 0 0-4 10.5c.6.6 1 1.4 1 2.5h6c0-1.1.4-1.9 1-2.5A6 6 0 0 0 12 3Z" />
    <path d="M9 18h6" />
    <path d="M10 21h4" />
  </svg>
);

/** 单行默认态：真实草稿文字使提交钮显现。 */
export const Default = () => {
  const [value, setValue] = useState("周五前把设计稿发给团队确认");
  return (
    <Frame>
      <PillInput
        value={value}
        onChange={setValue}
        onSubmit={() => {}}
        placeholder="记下待办，回车保存…"
      />
    </Frame>
  );
};

/** 灵感模式：multiline 自适应高度 + 紫色壳。 */
export const Spark = () => {
  const [value, setValue] = useState(
    "灵感：捕获瞬间给卡片加一个轻微高亮闪动，给用户即时反馈"
  );
  return (
    <Frame>
      <PillInput
        multiline
        tone="spark"
        value={value}
        onChange={setValue}
        onSubmit={() => {}}
        placeholder="记录闪念灵感，回车保存…"
      />
    </Frame>
  );
};

/** 禁用态：AI 请求在途时输入与提交同步锁定、壳降不透明度。 */
export const Disabled = () => {
  const [value] = useState("下午3点提醒我开会");
  return (
    <Frame>
      <PillInput
        value={value}
        onChange={() => {}}
        onSubmit={() => {}}
        disabled
        placeholder="AI 解析中…"
      />
    </Frame>
  );
};

/** 左槽：闪念模式切换钮（真实 TaskQuickAdd 用法），与文字、提交钮并排。 */
export const WithLeftSlot = () => {
  const [value, setValue] = useState("整理一下上周的会议纪要");
  const [spark, setSpark] = useState(true);
  return (
    <Frame>
      <PillInput
        value={value}
        onChange={setValue}
        onSubmit={() => {}}
        tone={spark ? "spark" : "default"}
        placeholder={spark ? "记录闪念灵感，回车保存…" : "记下待办，回车保存…"}
        leftSlot={
          <IconButton
            label={spark ? "闪念模式：回车存为灵感（点击退出）" : "点击进入闪念模式"}
            size="2xs"
            pressed={spark}
            onClick={() => setSpark((s) => !s)}
          >
            <LightbulbIcon />
          </IconButton>
        }
      />
    </Frame>
  );
};
