/** textarea 自适应高度的统一上限（px）——PillInput 与 TaskRow 备注框共用，勿各写一份字面量 */
export const TEXTAREA_MAX_H = 132;

/** 自适应高度（挂在 onChange 里调用），上限 TEXTAREA_MAX_H */
export function autoResizeTextarea(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, TEXTAREA_MAX_H)}px`;
}
