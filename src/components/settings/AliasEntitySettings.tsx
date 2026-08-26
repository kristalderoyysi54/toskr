import { ask } from "@tauri-apps/plugin-dialog";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Switch } from "@/components/ui/switch";
import {
  ALIAS_PRESET_CATEGORIES,
  aliasOriginalTextIssue,
  allocateAliasPlaceholder,
  applyAliasEntities,
  categoryLabelOf,
  isValidAliasCategoryCode,
  restoreAliases,
  type AliasEntity,
} from "@/lib/delivery/aliasEntities";
import { cn } from "@/lib/utils";
import type { Settings } from "@/store/notesStore";

const CUSTOM_CODE = "__custom__";

const inputClass =
  "mt-1 h-9 w-full rounded-lg border border-border bg-transparent px-2 text-body text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background";

function newEntityId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `alias-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** 「可逆化名」设置卡：词典 CRUD + 本地预演 + 捕获自动恢复开关。 */
export function AliasEntitySettings({
  settings,
  patch,
}: {
  settings: Settings;
  patch: (patch: Partial<Settings>) => void;
}) {
  const [formOpen, setFormOpen] = useState(false);
  const [draftText, setDraftText] = useState("");
  const [selectedCode, setSelectedCode] = useState(ALIAS_PRESET_CATEGORIES[0].code);
  const [customCode, setCustomCode] = useState("");
  const [customLabel, setCustomLabel] = useState("");
  const [formIssue, setFormIssue] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [rehearsalText, setRehearsalText] = useState("");

  const categories = useMemo(
    () => [...ALIAS_PRESET_CATEGORIES, ...settings.aliasCustomCategories],
    [settings.aliasCustomCategories]
  );
  const customSelected = selectedCode === CUSTOM_CODE;
  const effectiveCode = customSelected ? customCode : selectedCode;
  const codeValid = customSelected
    ? isValidAliasCategoryCode(customCode) &&
      !categories.some((category) => category.code === customCode)
    : true;
  const previewPlaceholder =
    effectiveCode && codeValid
      ? allocateAliasPlaceholder(effectiveCode, settings.aliasNextNumberByCategory)
          .placeholder
      : null;
  const rehearsal = useMemo(
    () =>
      rehearsalText
        ? applyAliasEntities(rehearsalText, settings.aliasEntities)
        : null,
    [rehearsalText, settings.aliasEntities]
  );
  // 往返闭环演示：化名后再本机恢复，应与原文一致（即「AI 返回后可恢复」的可视化验证）
  const rehearsalRestored = useMemo(
    () =>
      rehearsal ? restoreAliases(rehearsal.text, settings.aliasEntities) : null,
    [rehearsal, settings.aliasEntities]
  );

  const resetForm = () => {
    setFormOpen(false);
    setDraftText("");
    setSelectedCode(ALIAS_PRESET_CATEGORIES[0].code);
    setCustomCode("");
    setCustomLabel("");
    setFormIssue(null);
  };

  const addEntity = () => {
    const textIssue = aliasOriginalTextIssue(draftText, settings.aliasEntities);
    if (textIssue) {
      setFormIssue(textIssue);
      return;
    }
    if (customSelected && !codeValid) {
      setFormIssue("类别码需为大写字母开头的英文码，且不与既有/保留类别重复");
      return;
    }
    const allocated = allocateAliasPlaceholder(
      effectiveCode,
      settings.aliasNextNumberByCategory
    );
    const now = Date.now();
    const entity: AliasEntity = {
      id: newEntityId(),
      category: effectiveCode,
      originalText: draftText,
      placeholder: allocated.placeholder,
      createdAtMs: now,
      updatedAtMs: now,
    };
    patch({
      aliasEntities: [...settings.aliasEntities, entity],
      aliasNextNumberByCategory: allocated.nextCounters,
      ...(customSelected
        ? {
            aliasCustomCategories: [
              ...settings.aliasCustomCategories,
              { code: customCode, label: customLabel.trim() || customCode },
            ],
          }
        : {}),
    });
    resetForm();
  };

  const saveEdit = (entity: AliasEntity) => {
    if (editingText === entity.originalText) {
      setEditingId(null);
      return;
    }
    const issue = aliasOriginalTextIssue(
      editingText,
      settings.aliasEntities,
      entity.id
    );
    if (issue) {
      setFormIssue(issue);
      return;
    }
    patch({
      aliasEntities: settings.aliasEntities.map((item) =>
        item.id === entity.id
          ? { ...item, originalText: editingText, updatedAtMs: Date.now() }
          : item
      ),
    });
    setEditingId(null);
    setFormIssue(null);
  };

  const removeEntity = async (entity: AliasEntity) => {
    const confirmed = await ask(
      `删除后 ${entity.placeholder} 将无法再恢复为「${entity.originalText}」，编号也不会复用。确定删除？`,
      { title: "删除词典条目", kind: "warning" }
    );
    if (!confirmed) return;
    patch({
      aliasEntities: settings.aliasEntities.filter((item) => item.id !== entity.id),
    });
  };

  return (
    <div className="mb-4">
      <p className="mb-1.5 text-body font-medium text-muted-foreground">可逆化名</p>
      <div className="divide-y divide-border/50 rounded-xl border border-border/60 bg-card">
        <div className="flex items-center justify-between gap-4 px-3.5 py-2.5">
          <div className="min-w-0">
            <p className="text-title">启用可逆化名</p>
            <p className="mt-0.5 text-label text-muted-foreground">
              发送前自动把词典原文替换为稳定占位符（如 张三 → [USER_01]）；捕获回复时在本机恢复
            </p>
          </div>
          <div className="shrink-0">
            <Switch
              aria-label="启用可逆化名"
              checked={settings.aliasEntitiesEnabled}
              onCheckedChange={(aliasEntitiesEnabled) =>
                patch({ aliasEntitiesEnabled })}
            />
          </div>
        </div>

        {settings.aliasEntitiesEnabled && (
          <>
            <div className="px-3.5 py-2.5">
              <p className="text-title">实体词典</p>
              <p className="mt-0.5 text-label text-muted-foreground">
                词典原文随本地数据文件加密保存，并包含在完整备份中（备份为明文）；删除条目不回收占位符编号
              </p>

              {settings.aliasEntities.length === 0 ? (
                <p className="mt-2 text-body text-muted-foreground">
                  暂无词典条目。添加后，发送内容里出现的原文会自动替换为占位符。
                </p>
              ) : (
                <ul className="mt-2 space-y-1" aria-label="化名词典条目">
                  {settings.aliasEntities.map((entity) => (
                    <li
                      key={entity.id}
                      className="flex items-center gap-2 rounded-lg bg-muted/40 px-2 py-1.5"
                    >
                      <span className="shrink-0 rounded-sm bg-background/70 px-1 py-0.5 text-micro text-muted-foreground">
                        {categoryLabelOf(entity.category, settings.aliasCustomCategories)}
                      </span>
                      {editingId === entity.id ? (
                        <input
                          aria-label={`编辑 ${entity.originalText} 的原文`}
                          value={editingText}
                          maxLength={120}
                          autoFocus
                          onChange={(event) => setEditingText(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") saveEdit(entity);
                            if (event.key === "Escape") setEditingId(null);
                          }}
                          onBlur={() => saveEdit(entity)}
                          className="h-7 min-w-0 flex-1 rounded-md border border-border bg-transparent px-1.5 text-body outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                        />
                      ) : (
                        <span
                          className="min-w-0 flex-1 truncate text-body"
                          title={entity.originalText}
                        >
                          {entity.originalText}
                        </span>
                      )}
                      <code className="shrink-0 text-micro text-muted-foreground">
                        {entity.placeholder}
                      </code>
                      <IconButton
                        label="编辑原文"
                        size="xs"
                        onClick={() => {
                          setEditingId(entity.id);
                          setEditingText(entity.originalText);
                          setFormIssue(null);
                        }}
                      >
                        <Pencil className="size-3" />
                      </IconButton>
                      <IconButton
                        label="删除条目"
                        size="xs"
                        tone="danger"
                        onClick={() => void removeEntity(entity)}
                      >
                        <Trash2 className="size-3" />
                      </IconButton>
                    </li>
                  ))}
                </ul>
              )}

              {formOpen ? (
                <div className="mt-2 rounded-lg border border-border/60 p-2">
                  <label className="block text-label text-muted-foreground">
                    原文（精确匹配，区分大小写）
                    <input
                      aria-label="词典原文"
                      value={draftText}
                      maxLength={120}
                      autoFocus
                      placeholder="如：张三 / 商户 12345 / SO-2026-001"
                      onChange={(event) => {
                        setDraftText(event.target.value);
                        setFormIssue(null);
                      }}
                      className={inputClass}
                    />
                  </label>
                  <p className="mt-2 text-label text-muted-foreground">类别</p>
                  <div
                    className="mt-1 flex flex-wrap gap-1"
                    role="radiogroup"
                    aria-label="化名类别"
                  >
                    {categories.map((category) => (
                      <button
                        key={category.code}
                        type="button"
                        role="radio"
                        aria-checked={selectedCode === category.code}
                        onClick={() => setSelectedCode(category.code)}
                        className={cn(
                          "rounded-md px-2 py-1 text-label outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                          selectedCode === category.code
                            ? "bg-primary/10 text-foreground"
                            : "bg-muted/40 text-muted-foreground hover:text-foreground"
                        )}
                      >
                        {category.label}
                      </button>
                    ))}
                    <button
                      type="button"
                      role="radio"
                      aria-checked={customSelected}
                      onClick={() => setSelectedCode(CUSTOM_CODE)}
                      className={cn(
                        "rounded-md px-2 py-1 text-label outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                        customSelected
                          ? "bg-primary/10 text-foreground"
                          : "bg-muted/40 text-muted-foreground hover:text-foreground"
                      )}
                    >
                      + 自定义类别
                    </button>
                  </div>
                  {customSelected && (
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <label className="block text-label text-muted-foreground">
                        类别码（英文大写）
                        <input
                          aria-label="自定义类别码"
                          value={customCode}
                          maxLength={16}
                          placeholder="如 VENDOR"
                          onChange={(event) => {
                            setCustomCode(event.target.value.toUpperCase());
                            setFormIssue(null);
                          }}
                          className={inputClass}
                        />
                      </label>
                      <label className="block text-label text-muted-foreground">
                        显示名（可选）
                        <input
                          aria-label="自定义类别显示名"
                          value={customLabel}
                          maxLength={16}
                          placeholder="如 供应商"
                          onChange={(event) => setCustomLabel(event.target.value)}
                          className={inputClass}
                        />
                      </label>
                    </div>
                  )}
                  <p className="mt-2 text-label text-muted-foreground" aria-live="polite">
                    {previewPlaceholder
                      ? `将分配占位符：${previewPlaceholder}`
                      : "填写合法类别码后显示将分配的占位符"}
                  </p>
                  {formIssue && (
                    <p role="alert" className="mt-1 text-label text-warning">
                      {formIssue}
                    </p>
                  )}
                  <div className="mt-2 flex gap-1.5">
                    <Button type="button" size="xs" variant="secondary" onClick={addEntity}>
                      添加
                    </Button>
                    <Button type="button" size="xs" variant="ghost" onClick={resetForm}>
                      取消
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  className="mt-2"
                  onClick={() => setFormOpen(true)}
                >
                  <Plus className="size-3" /> 新增条目
                </Button>
              )}
              {!formOpen && formIssue && (
                <p role="alert" className="mt-1 text-label text-warning">
                  {formIssue}
                </p>
              )}
            </div>

            <div className="px-3.5 py-2.5">
              <p className="text-title">本地预演（发出 → 收回 完整闭环）</p>
              <label className="mt-0.5 block text-label text-muted-foreground">
                输入示例文字，查看「发出前化名 → 捕获回复时恢复」的往返效果
                <input
                  aria-label="化名预演输入"
                  value={rehearsalText}
                  maxLength={400}
                  placeholder="粘贴一句包含词典原文的示例文字"
                  onChange={(event) => setRehearsalText(event.target.value)}
                  className={inputClass}
                />
              </label>
              {rehearsal && (
                <div className="mt-2 space-y-1.5">
                  <div>
                    <p className="text-micro text-muted-foreground">
                      ① 发出前 · 已自动化名（AI 只看到占位符，替换 {rehearsal.replacedCount} 处）
                    </p>
                    <pre className="mt-0.5 overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-2 text-micro">
                      {rehearsal.text}
                    </pre>
                  </div>
                  <div>
                    <p className="text-micro text-muted-foreground">
                      ② 捕获回复时 · 本机自动恢复
                    </p>
                    <pre className="mt-0.5 overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-2 text-micro">
                      {rehearsalRestored?.text ?? rehearsal.text}
                    </pre>
                    {rehearsalRestored?.text === rehearsalText && (
                      <p className="mt-0.5 text-micro text-success">
                        与原文一致，可逆闭环验证通过
                      </p>
                    )}
                  </div>
                </div>
              )}
              <p className="mt-1.5 text-label text-muted-foreground">
                本地预演，不会发送、不会访问剪贴板
              </p>
            </div>

            <div className="flex items-center justify-between gap-4 px-3.5 py-2.5">
              <div className="min-w-0">
                <p className="text-title">捕获时自动恢复化名</p>
                <p className="mt-0.5 text-label text-muted-foreground">
                  划词捕获的新卡片自动把已知占位符还原为原文；关闭后可在卡片上手动恢复
                </p>
              </div>
              <div className="shrink-0">
                <Switch
                  aria-label="捕获时自动恢复化名"
                  checked={settings.aliasAutoRestoreOnCapture}
                  onCheckedChange={(aliasAutoRestoreOnCapture) =>
                    patch({ aliasAutoRestoreOnCapture })}
                />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
