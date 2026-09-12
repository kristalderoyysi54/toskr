/** 长按只负责开菜单；松手产生的 click 必须吃掉，不能再执行短按动作。 */
export function createLongPress(onLongPress: () => void, delay = 450) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let origin: { x: number; y: number } | undefined;
  let suppressClick = false;

  const release = () => {
    clearTimeout(timer);
    timer = undefined;
    origin = undefined;
  };
  const cancel = () => {
    if (origin) suppressClick = true;
    release();
  };
  return {
    start(x: number, y: number) {
      release();
      suppressClick = false;
      origin = { x, y };
      timer = setTimeout(() => {
        suppressClick = true;
        timer = undefined;
        onLongPress();
      }, delay);
    },
    move(x: number, y: number) {
      if (origin && Math.hypot(x - origin.x, y - origin.y) > 8) cancel();
    },
    release,
    cancel,
    consumeClick() {
      const suppressed = suppressClick;
      suppressClick = false;
      return suppressed;
    },
  };
}
