import { SimpleMenu, SimpleMenuItem, SimpleMenuLabel, SimpleMenuSeparator } from "@/components/SimpleMenu";
import { Button } from "@/components/ui/button";
// 单测把本组件当普通函数直接调用（无 React 调度器），不能调 useT；语言切换靠父组件 useT 重渲染
import { t } from "@/lib/i18n";
import { isCommonPromptSnippet, replaceCommonPromptSnippet } from "@/lib/promptTemplates";
import type { PromptSnippet } from "@/store/notesStore";

export function PromptTemplateCommonAction({ snippet, snippets, onChange }: {
  snippet: PromptSnippet;
  snippets: PromptSnippet[];
  onChange: (snippets: PromptSnippet[]) => void;
}) {
  const current = snippets.find((item) => item.id === snippet.id);
  const common = isCommonPromptSnippet(current ?? snippet);
  const setCommon = (isCommon: boolean) => {
    if (!current || isCommonPromptSnippet(current) === isCommon) return;
    onChange(snippets.map((item) => item.id === snippet.id ? { ...item, isCommon } : item));
  };

  if (!common) {
    return (
      <Button size="xs" aria-label={t("将“{label}”设为常用", { label: snippet.label })} disabled={!current} onClick={() => setCommon(true)}>
        {t("设为常用")}
      </Button>
    );
  }

  const candidates = snippets.filter((item) => item.id !== snippet.id && !isCommonPromptSnippet(item));
  return (
    <SimpleMenu
      menuAriaLabel={t("替换“{label}”常用模板", { label: snippet.label })}
      menuClassName="w-64 max-h-72 overflow-y-auto"
      trigger={({ open, toggle, controls }) => (
        <Button
          size="xs"
          aria-label={t("替换“{label}”常用模板", { label: snippet.label })}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={controls}
          disabled={!current}
          onClick={toggle}
        >
          {t("替换常用")}
        </Button>
      )}
    >
      {(close) => (
        <>
          <SimpleMenuLabel>{t("替换后，原模板保留在其他模板")}</SimpleMenuLabel>
          {candidates.length === 0 && (
            <SimpleMenuItem disabled onClick={() => {}}>{t("先新增模板再替换")}</SimpleMenuItem>
          )}
          {candidates.map((candidate) => (
            <SimpleMenuItem
              key={candidate.id}
              title={candidate.text}
              onClick={() => {
                close();
                const next = replaceCommonPromptSnippet(snippets, snippet.id, candidate.id);
                if (next !== snippets) onChange(next);
              }}
            >
              <span className="break-words">{t("替换为 {label}", { label: candidate.label })}</span>
            </SimpleMenuItem>
          ))}
          <SimpleMenuSeparator />
          <SimpleMenuItem onClick={() => { close(); setCommon(false); }}>
            {t("移出常用")}
          </SimpleMenuItem>
        </>
      )}
    </SimpleMenu>
  );
}
