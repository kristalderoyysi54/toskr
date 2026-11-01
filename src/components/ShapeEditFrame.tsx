import { editHandles, shapeBounds, type Editable } from "@/lib/screenshot/shapeEdit";

/** 选中图形的虚线外框与手柄（箭头 / 直线只显示两端手柄）。z = 图形坐标到屏上 pt 的倍率。 */
export function ShapeEditFrame({ shape, z = 1 }: { shape: Editable; z?: number }) {
  const b = shapeBounds(shape);
  return (
    <>
      {b && shape.kind !== "arrow" && shape.kind !== "line" && (
        <div
          className="pointer-events-none absolute border border-dashed border-white outline outline-1 outline-black/40"
          style={{ left: b.x * z - 2, top: b.y * z - 2, width: b.w * z + 4, height: b.h * z + 4 }}
        />
      )}
      {editHandles(shape).map((h) => (
        <div
          key={h.id}
          className="pointer-events-none absolute size-2.5 rounded-full border border-primary bg-white shadow-sm"
          style={{ left: h.x * z - 5, top: h.y * z - 5 }}
        />
      ))}
    </>
  );
}
