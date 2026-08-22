/**
 * 鼠标追踪描边光晕（基于 Aceternity UI「Glowing Effect」改造，MIT）。
 * 原理：after 伪元素铺一层四色渐变，双层 mask（padding-box 透明层 ∩
 * border-box 锥形弧）后只剩边框环上的发光弧；--start 弧心角度由 motion
 * 的 animate() 驱动，--twin 控制对称第二弧的透明度。
 *
 * 状态机（2026-08 用户定稿）：
 * - 常态：右上 + 左下对角双弧常亮（「」括角缘饰），角度按面板宽高比
 *   实算落在真正的对角上；
 * - 指针贴边（入 proximity 且出中心死区）：对角弧淡出其一，另一弧
 *   贝塞尔平滑追随指针方位（原版行为）；
 * - 指针离开窗口 / 窗口失焦 / 退回中心死区：线性动效归位对角双弧，
 *   归位取转角更短的一侧（双弧 180° 对称，两个落点视觉等价）。
 *
 * 与 Aceternity 原版的窗口适配：光环画在容器边缘内侧（after:inset-0）
 * 而非外扩——窗口外没有可绘制区域，宿主 overflow-hidden 也会裁掉外扩。
 */
import { memo, useCallback, useEffect, useRef, type CSSProperties } from "react";
import { animate, useReducedMotion } from "motion/react";

import { cn } from "@/lib/utils";

type AnimControls = ReturnType<typeof animate>;

type GlowingEffectProps = {
  blur?: number;
  /** 中心死区半径系数（0-1，×min(宽,高)/2）：指针靠近中心时回到常态。 */
  inactiveZone?: number;
  /** 容器外多少 px 内仍算「命中」。 */
  proximity?: number;
  /** 弧长的一半（度）。 */
  spread?: number;
  className?: string;
  disabled?: boolean;
  /** 追随动画时长（秒）。 */
  movementDuration?: number;
  borderWidth?: number;
};

/** 失焦归位动画时长（秒，线性）。 */
const IDLE_RETURN_S = 0.8;

export const GlowingEffect = memo(function GlowingEffect({
  blur = 0,
  inactiveZone = 0.7,
  proximity = 0,
  spread = 20,
  className,
  movementDuration = 2,
  borderWidth = 1,
  disabled = false,
}: GlowingEffectProps) {
  const reduceMotion = useReducedMotion();
  const containerRef = useRef<HTMLDivElement>(null);
  const lastPosition = useRef({ x: 0, y: 0 });
  const animationFrameRef = useRef<number>(0);
  const modeRef = useRef<"idle" | "follow">("idle");
  const startAnim = useRef<AnimControls | null>(null);
  const twinAnim = useRef<AnimControls | null>(null);

  /** 归位常态：--start 转到右上角方位（转角短侧），--twin 淡入到 1。 */
  const toIdle = useCallback((immediate = false) => {
    const el = containerRef.current;
    if (!el) return;
    modeRef.current = "idle";
    startAnim.current?.stop();
    twinAnim.current?.stop();
    const { width, height } = el.getBoundingClientRect();
    // 右上角相对中心的方位角（conic 坐标：0°=正上，顺时针）
    const corner = (180 * Math.atan2(width * 0.5, height * 0.5)) / Math.PI;
    const cur = parseFloat(el.style.getPropertyValue("--start")) || 0;
    // 双弧 180° 对称：归到 corner 或 corner+180 视觉等价，取模 180 最短转角
    const diff = ((((corner - cur + 90) % 180) + 180) % 180) - 90;
    if (immediate) {
      el.style.setProperty("--start", String(corner));
      el.style.setProperty("--twin", "1");
      return;
    }
    const twinCur = parseFloat(el.style.getPropertyValue("--twin")) || 0;
    startAnim.current = animate(cur, cur + diff, {
      duration: IDLE_RETURN_S,
      ease: "linear",
      onUpdate: (v) => el.style.setProperty("--start", String(v)),
    });
    twinAnim.current = animate(twinCur, 1, {
      duration: IDLE_RETURN_S,
      ease: "linear",
      onUpdate: (v) => el.style.setProperty("--twin", String(v)),
    });
  }, []);

  /** 进入追随态：对称弧淡出，只留追随弧。 */
  const toFollow = useCallback((el: HTMLElement) => {
    modeRef.current = "follow";
    twinAnim.current?.stop();
    const twinCur = parseFloat(el.style.getPropertyValue("--twin")) || 0;
    twinAnim.current = animate(twinCur, 0, {
      duration: 0.3,
      ease: "linear",
      onUpdate: (v) => el.style.setProperty("--twin", String(v)),
    });
  }, []);

  const handleMove = useCallback(
    (e?: { x: number; y: number }) => {
      if (!containerRef.current) return;
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      animationFrameRef.current = requestAnimationFrame(() => {
        const element = containerRef.current;
        if (!element) return;

        const { left, top, width, height } = element.getBoundingClientRect();
        const mouseX = e?.x ?? lastPosition.current.x;
        const mouseY = e?.y ?? lastPosition.current.y;
        if (e) {
          lastPosition.current = { x: mouseX, y: mouseY };
        }

        const center = [left + width * 0.5, top + height * 0.5];
        const distanceFromCenter = Math.hypot(
          mouseX - center[0],
          mouseY - center[1]
        );
        const inactiveRadius = 0.5 * Math.min(width, height) * inactiveZone;
        const isActive =
          distanceFromCenter >= inactiveRadius &&
          mouseX > left - proximity &&
          mouseX < left + width + proximity &&
          mouseY > top - proximity &&
          mouseY < top + height + proximity;

        if (!isActive) {
          if (modeRef.current !== "idle") toIdle();
          return;
        }
        if (modeRef.current !== "follow") toFollow(element);

        const currentAngle =
          parseFloat(element.style.getPropertyValue("--start")) || 0;
        const targetAngle =
          (180 * Math.atan2(mouseY - center[1], mouseX - center[0])) / Math.PI +
          90;
        const angleDiff = ((targetAngle - currentAngle + 180) % 360) - 180;
        startAnim.current?.stop();
        startAnim.current = animate(currentAngle, currentAngle + angleDiff, {
          duration: movementDuration,
          ease: [0.16, 1, 0.3, 1],
          onUpdate: (value) => {
            element.style.setProperty("--start", String(value));
          },
        });
      });
    },
    [inactiveZone, proximity, movementDuration, toIdle, toFollow]
  );

  useEffect(() => {
    if (disabled) return;
    // 首帧按真实宽高比落好对角双弧
    toIdle(true);
    // 减弱动态效果下保留静态双弧信息，不再监听指针或驱动逐帧动画。
    if (reduceMotion) return;
    const handleScroll = () => handleMove();
    const handlePointerMove = (e: PointerEvent) => handleMove(e);
    // 指针离开窗口 / 窗口失焦：线性归位（独立窗口出界后收不到 move 事件）
    const handleAway = () => {
      if (modeRef.current !== "idle") toIdle();
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    document.body.addEventListener("pointermove", handlePointerMove, {
      passive: true,
    });
    document.documentElement.addEventListener("pointerleave", handleAway);
    window.addEventListener("blur", handleAway);
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      startAnim.current?.stop();
      twinAnim.current?.stop();
      window.removeEventListener("scroll", handleScroll);
      document.body.removeEventListener("pointermove", handlePointerMove);
      document.documentElement.removeEventListener("pointerleave", handleAway);
      window.removeEventListener("blur", handleAway);
    };
  }, [handleMove, disabled, reduceMotion, toIdle]);

  if (disabled) return null;

  return (
    <div
      ref={containerRef}
      style={
        {
          "--blur": `${blur}px`,
          "--spread": spread,
          "--start": "0",
          "--twin": "1",
          "--glowingeffect-border-width": `${borderWidth}px`,
          "--repeating-conic-gradient-times": "5",
          // token-exception: Aceternity 原版四色光晕渐变（装饰层，非语义色）
          "--gradient": `radial-gradient(circle, #dd7bbb 10%, #dd7bbb00 20%),
            radial-gradient(circle at 40% 40%, #d79f1e 5%, #d79f1e00 15%),
            radial-gradient(circle at 60% 60%, #5a922c 10%, #5a922c00 20%),
            radial-gradient(circle at 40% 60%, #4c7894 10%, #4c789400 20%),
            repeating-conic-gradient(
              from 236.84deg at 50% 50%,
              #dd7bbb 0%,
              #d79f1e calc(25% / var(--repeating-conic-gradient-times)),
              #5a922c calc(50% / var(--repeating-conic-gradient-times)),
              #4c7894 calc(75% / var(--repeating-conic-gradient-times)),
              #dd7bbb calc(100% / var(--repeating-conic-gradient-times))
            )`,
          // 双弧遮罩：主弧心在 --start，第二弧固定 +180°（透明度 --twin）。
          // 追随态 twin=0 即单弧；常态 twin=1 即对角「」双弧
          "--glow-mask": `linear-gradient(#0000, #0000), conic-gradient(
            from calc((var(--start) - var(--spread)) * 1deg),
            #00000000 0deg,
            #fff calc(var(--spread) * 1deg),
            #00000000 calc(var(--spread) * 2deg),
            #00000000 180deg,
            rgb(255 255 255 / var(--twin)) calc(180deg + var(--spread) * 1deg),
            #00000000 calc(180deg + var(--spread) * 2deg)
          )`,
        } as CSSProperties
      }
      className={cn(
        "pointer-events-none absolute inset-0 rounded-[inherit]",
        blur > 0 && "blur-[var(--blur)]",
        className
      )}
    >
      <div
        className={cn(
          "glow rounded-[inherit]",
          'after:content-[""] after:absolute after:inset-0 after:rounded-[inherit]',
          "after:[border:var(--glowingeffect-border-width)_solid_transparent]",
          "after:[background:var(--gradient)] after:[background-attachment:fixed]",
          "after:[mask-clip:padding-box,border-box]",
          "after:[mask-composite:intersect]",
          "after:[mask-image:var(--glow-mask)]"
        )}
      />
    </div>
  );
});
