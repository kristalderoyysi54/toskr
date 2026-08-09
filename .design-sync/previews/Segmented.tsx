import { Segmented } from "toskr";
import { useState } from "react";

/** 设置页三段（HotkeySection「触发键（双击）」原样式）：size 默认 sm。 */
export const TriggerKey = () => {
  const [value, setValue] = useState("shift");
  return (
    <Segmented
      value={value}
      onChange={setValue}
      ariaLabel="触发键（双击）"
      options={[
        { value: "shift", label: "⇧ Shift" },
        { value: "control", label: "⌃ Ctrl" },
        { value: "option", label: "⌥ Opt" },
      ]}
    />
  );
};

const PriorityLabel = ({ text, dotClassName }: { text: string; dotClassName: string }) => (
  <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
    <span className={dotClassName} style={{ display: "inline-block", width: 6, height: 6, borderRadius: 9999 }} />
    {text}
  </span>
);

/** 任务优先级 picker（TaskRow 色条同款配色）：size xs 密集态，label 传自定义 ReactNode。 */
export const PriorityPicker = () => {
  const [value, setValue] = useState("mid");
  return (
    <Segmented
      size="xs"
      value={value}
      onChange={setValue}
      ariaLabel="优先级"
      options={[
        { value: "high", label: <PriorityLabel text="高" dotClassName="bg-destructive" /> },
        { value: "mid", label: <PriorityLabel text="中" dotClassName="bg-amber-500" /> },
        { value: "low", label: <PriorityLabel text="低" dotClassName="bg-teal-500" /> },
      ]}
    />
  );
};

/** 到期提醒快捷档（SettingsView 编辑态原样式）：4 个选项测试非三段场景。 */
export const DueDatePreset = () => {
  const [value, setValue] = useState("relative");
  return (
    <Segmented
      value={value}
      onChange={setValue}
      ariaLabel="到期档位"
      options={[
        { value: "relative", label: "多久后" },
        { value: "today", label: "今天" },
        { value: "tomorrow", label: "明天" },
        { value: "weekday", label: "下个周几" },
      ]}
    />
  );
};
