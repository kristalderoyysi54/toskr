/** 长截屏选区边框：窗口比选区每边大 4pt、鼠标穿透，边框画在选区外不会被截进去。 */
export default function LongFrameView() {
  return <div className="pointer-events-none fixed inset-0.5 rounded-sm border-2 border-primary" />;
}
