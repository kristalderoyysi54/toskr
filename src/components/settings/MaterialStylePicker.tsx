import { useId, type CSSProperties } from "react";

import { normalizeMaterialStyle } from "@/lib/materialStyle";
import type { VibrancyMaterial } from "@/store/notesStore";

const MATERIAL_STYLES = [
  { value: "hud", label: "通透", description: "轻薄透色" },
  { value: "sidebar", label: "柔和", description: "细腻磨砂" },
  { value: "under-window", label: "厚重", description: "哑光陶瓷" },
] as const;

export function MaterialStylePicker({
  value,
  panelOpacity,
  cardOpacity,
  onChange,
}: {
  value: VibrancyMaterial;
  panelOpacity: number;
  cardOpacity: number;
  onChange: (value: ReturnType<typeof normalizeMaterialStyle>) => void;
}) {
  const id = useId();
  const selected = normalizeMaterialStyle(value);

  return (
    <div
      data-settings-search="毛玻璃风格"
      className="scroll-m-5 rounded-lg px-3.5 py-3 transition-shadow data-[settings-search-active=true]:ring-2 data-[settings-search-active=true]:ring-inset data-[settings-search-active=true]:ring-primary/40"
    >
      <fieldset className="min-w-0" aria-describedby={`${id}-hint`}>
        <legend className="text-title">毛玻璃风格</legend>
        <p id={`${id}-hint`} className="mt-0.5 text-label text-muted-foreground">
          卡片与面板一起变化；降低卡片不透明度，更容易透出背景。
        </p>
        <div className="mt-3 grid min-w-0 grid-cols-3 gap-2">
          {MATERIAL_STYLES.map((style) => (
            <label key={style.value} className="min-w-0 cursor-pointer">
              <input
                type="radio"
                name={`${id}-material`}
                value={style.value}
                checked={selected === style.value}
                onChange={() => onChange(style.value)}
                aria-labelledby={`${id}-${style.value}-label`}
                aria-describedby={`${id}-${style.value}-description`}
                className="peer sr-only"
              />
              <span className="block min-w-0 rounded-lg border border-border/70 p-1.5 transition-colors hover:border-foreground/30 peer-checked:border-primary/70 peer-checked:bg-primary/5 peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background">
                <span
                  data-material={style.value}
                  aria-hidden="true"
                  className="material-sample-backdrop relative block h-24 overflow-hidden rounded-md"
                  style={{
                    "--panel-alpha": panelOpacity,
                    "--card-alpha": `${Math.round(cardOpacity * 100)}%`,
                  } as CSSProperties}
                >
                  <span className="panel-surface absolute inset-0 block p-2">
                    <span className="material-card block h-full overflow-hidden rounded-md px-2 py-2">
                      <span className="block truncate text-micro font-medium text-foreground">灵感片段</span>
                      <span className="mt-2 block h-1 w-full rounded-full bg-foreground/20" />
                      <span className="mt-1.5 block h-1 w-3/4 rounded-full bg-foreground/15" />
                      <span className="mt-1.5 block h-1 w-1/2 rounded-full bg-foreground/10" />
                    </span>
                  </span>
                </span>
                <span id={`${id}-${style.value}-label`} className="mt-2 block text-center text-body font-medium">
                  {style.label}
                </span>
                <span id={`${id}-${style.value}-description`} className="mt-0.5 block text-center text-micro text-muted-foreground">
                  {style.description}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
}
