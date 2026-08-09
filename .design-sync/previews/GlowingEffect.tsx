import { useEffect, useRef } from "react";
import { GlowingEffect } from "toskr";

/** 鼠标追踪描边光晕：静息态整体淡出，挂载后合成并派发几帧 pointermove
 *  （落点取容器左缘中点，出中心死区、入 proximity 命中带）把组件推入
 *  「追随」态，movementDuration 调快到 0.2s 让弧线在截图前就位。
 *  事件监听挂在 document.body（见 glowing-effect.tsx handleMove 的注册目标），
 *  派发也落在 body 上以确保命中。 */
export const HoverGlow = () => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const timers = [60, 260, 460].map((delay) =>
      setTimeout(() => {
        const r = el.getBoundingClientRect();
        document.body.dispatchEvent(
          new PointerEvent("pointermove", {
            bubbles: true,
            clientX: r.left + 2,
            clientY: r.top + r.height / 2,
          })
        );
      }, delay)
    );
    return () => timers.forEach(clearTimeout);
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        position: "relative",
        width: 320,
        height: 180,
        borderRadius: 14,
        border: "1px solid rgba(0,0,0,0.1)",
        overflow: "hidden",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#fff",
      }}
    >
      <GlowingEffect
        spread={24}
        proximity={40}
        disabled={false}
        movementDuration={0.2}
      />
      <span style={{ fontSize: 14, color: "#374151" }}>指针悬停时描边发光</span>
    </div>
  );
};
