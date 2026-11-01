import { useRef, useState, type Dispatch, type SetStateAction } from "react";

import { box, commitShapes, isMeaningful, type History, type Shape } from "./annotate";
import { editShape, handleAt, isBox, shapeAt, type EditHandle, type Editable } from "./shapeEdit";

/** 框类调整后的最小边长（pt），更小视为误操作不入历史。 */
const MIN_BOX = 6;

/**
 * 截图遮罩与长图 / 钉图标注窗共用：点选已画的图形，拖动移动、拖手柄缩放（箭头拖端点），
 * ⌫ 删除、Esc 取消选中，改颜色 / 粗细作用到选中图形。每次调整是一步历史。
 * 选中项按图形对象引用记：撤销 / 重做换掉列表后自动失效，不会指到别的图形。
 */
export function useShapeEdit({
  history,
  setHistory,
  W,
  H,
  tol,
  canPick,
}: {
  history: History;
  setHistory: Dispatch<SetStateAction<History>>;
  /** 可画范围（pt），移动 / 缩放贴边停住 */
  W: number;
  H: number;
  /** 命中容差（图形坐标系） */
  tol: number;
  /** 当前能点选的图形（有绘图工具时只选同类，免得在框里画箭头变成选中外框） */
  canPick: (s: Shape) => boolean;
}) {
  const [pickedRef, setPickedRef] = useState<Shape | null>(null);
  const [preview, setPreview] = useState<Editable | null>(null);
  const drag = useRef<{ x: number; y: number; orig: Editable; handle: EditHandle | null } | null>(null);

  const index = pickedRef ? history.shapes.indexOf(pickedRef) : -1;
  const picked = index >= 0 && pickedRef?.kind !== "translate" ? (pickedRef as Editable) : null;
  const shapes = picked && preview ? history.shapes.map((s, i) => (i === index ? preview : s)) : history.shapes;

  const finish = (d: NonNullable<typeof drag.current>, x: number, y: number): Editable | null => {
    const next = editShape(d.orig, d.handle, x - d.x, y - d.y, W, H);
    if (next === d.orig || (x === d.x && y === d.y) || !isMeaningful(next)) return null;
    if (isBox(next) && (box(next).w < MIN_BOX || box(next).h < MIN_BOX)) return null;
    return next;
  };

  const replace = (target: Shape, next: Shape | null) => {
    setHistory((h) =>
      commitShapes(h, next ? h.shapes.map((s) => (s === target ? next : s)) : h.shapes.filter((s) => s !== target))
    );
    setPickedRef(next);
  };

  return {
    /** 选中的图形（拖动中为预览） */
    picked: preview ?? picked,
    /** 带拖动预览的图形列表，显示用 */
    shapes,
    clear: () => setPickedRef(null),
    /** 按下：点中选中图形的手柄或某个可选图形则接管拖动，返回 true */
    down(x: number, y: number): boolean {
      const handle = picked ? handleAt(picked, x, y, tol) : null;
      let target: Editable | null = handle ? picked : null;
      if (!target) {
        const i = shapeAt(history.shapes, x, y, tol, canPick);
        target = i === null ? null : (history.shapes[i] as Editable);
      }
      setPickedRef(target);
      if (!target) return false;
      drag.current = { x, y, orig: target, handle };
      return true;
    },
    move(x: number, y: number): boolean {
      const d = drag.current;
      if (!d) return false;
      setPreview(editShape(d.orig, d.handle, x - d.x, y - d.y, W, H));
      return true;
    },
    /** 松手按实际坐标收尾（最后一次 move 的预览可能还没渲染） */
    up(x: number, y: number): boolean {
      const d = drag.current;
      if (!d) return false;
      drag.current = null;
      setPreview(null);
      const next = finish(d, x, y);
      if (next) replace(d.orig, next);
      return true;
    },
    /** 悬停光标：手柄缩放箭头 / 可选图形上移动；都不是返回 null */
    cursor(x: number, y: number): string | null {
      const handle = picked ? handleAt(picked, x, y, tol) : null;
      if (handle) return handle === "start" || handle === "end" ? "crosshair" : `${handle}-resize`;
      return shapeAt(history.shapes, x, y, tol, canPick) !== null ? "move" : null;
    },
    /** ⌫ / Delete 删除选中，Esc 取消选中；处理了返回 true */
    key(e: KeyboardEvent): boolean {
      if (!picked) return false;
      if (e.key === "Backspace" || e.key === "Delete") replace(picked, null);
      else if (e.key === "Escape") setPickedRef(null);
      else return false;
      return true;
    },
    /** 改颜色 / 粗细时同步到选中图形 */
    restyle(patch: { color?: string; size?: number }) {
      if (picked) replace(picked, { ...picked, ...patch } as Shape);
    },
  };
}
