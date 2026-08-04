import type { Transition } from "motion/react";

/**
 * motion(JS) 动效共享预设——全部来自各组件现存手调值的命名化，纯替换不改手感。
 * CSS 侧的时长/缓动 token 见 index.css 的 --duration-* / --ease-*。
 */

/** 面板呼出、页面横滑：主 spring 手感（原 App.tsx 480/40）。 */
export const springSnappy: Transition = { type: "spring", stiffness: 480, damping: 40 };
/** 任务详情展开（原 TaskRow.tsx 480/42）。 */
export const springDetail: Transition = { type: "spring", stiffness: 480, damping: 42 };
/** 预览层卡片入场（原 PreviewOverlay.tsx 500/38）。 */
export const springModal: Transition = { type: "spring", stiffness: 500, damping: 38 };
/** 收起/退场：短促 tween——spring 的长尾会拖住窗口隐藏时机（原 App.tsx 0.14 easeIn）。 */
export const tweenExit: Transition = { duration: 0.14, ease: "easeIn" };
/** 背板淡入淡出（原 PreviewOverlay.tsx 0.12）。 */
export const tweenFade: Transition = { duration: 0.12 };
/** 菜单/HUD 内容替换等微交互：快速干脆的出场（新增，对应 --ease-standard）。 */
export const tweenMenu: Transition = { duration: 0.12, ease: [0.2, 0.9, 0.3, 1] };
