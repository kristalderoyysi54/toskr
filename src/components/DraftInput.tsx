import { useState } from "react";

import { PillInput } from "@/components/ui/pill-input";
import { enrichLinkMeta } from "@/lib/actions";
import { tip } from "@/lib/tip";
import { useNotesStore } from "@/store/notesStore";

/** 常驻底部的思考/Prompt 缓冲输入框：Enter 提交，Shift+Enter 换行。 */
export function DraftInput() {
  const [value, setValue] = useState("");

  const submit = () => {
    const text = value.trim();
    if (!text) return;
    const { result, id } = useNotesStore.getState().addNote(text);
    if (result === "duplicate") {
      tip("duplicate", "");
    }
    if (result === "added" && id) void enrichLinkMeta(id);
    setValue("");
  };

  return (
    <div className="px-3 pb-3 pt-1.5">
      <PillInput
        multiline
        value={value}
        onChange={setValue}
        onSubmit={submit}
        placeholder="添加笔记或提示词…"
      />
    </div>
  );
}
