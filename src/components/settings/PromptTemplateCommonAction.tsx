import { SimpleMenu, SimpleMenuItem, SimpleMenuLabel, SimpleMenuSeparator } from "@/components/SimpleMenu";
import { Button } from "@/components/ui/button";
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
      <Button size="xs" aria-label={`将“${snippet.label}”设为常用`} disabled={!current} onClick={() => setCommon(true)}>
        设为常用
      </Button>
    );
  }

  const candidates = snippets.filter((item) => item.id !== snippet.id && !isCommonPromptSnippet(item));
  return (
    <SimpleMenu
      menuAriaLabel={`替换“${snippet.label}”常用模板`}
      menuClassName="w-64 max-h-72 overflow-y-auto"
      trigger={({ open, toggle, controls }) => (
        <Button
          size="xs"
          aria-label={`替换“${snippet.label}”常用模板`}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={controls}
          disabled={!current}
          onClick={toggle}
        >
          替换常用
        </Button>
      )}
    >
      {(close) => (
        <>
          <SimpleMenuLabel>替换后，原模板保留在其他模板</SimpleMenuLabel>
          {candidates.length === 0 && (
            <SimpleMenuItem disabled onClick={() => {}}>先新增模板再替换</SimpleMenuItem>
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
              <span className="break-words">替换为 {candidate.label}</span>
            </SimpleMenuItem>
          ))}
          <SimpleMenuSeparator />
          <SimpleMenuItem onClick={() => { close(); setCommon(false); }}>
            移出常用
          </SimpleMenuItem>
        </>
      )}
    </SimpleMenu>
  );
}
