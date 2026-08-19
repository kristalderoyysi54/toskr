"use client"

import * as React from "react"
import { ScrollArea as ScrollAreaPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function ScrollArea({
  className,
  viewportClassName,
  children,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root> & {
  /** 视口内容层的类。横向留白要走这里而不是 Root：Root 的 padding 在视口外，
   *  视口 size-full 贴满 content-box，列表项就贴死裁切边界，ring/投影被切平。
   *  卡片列表按 Root px-2.5 + 内容层 px-1 拆分（合计仍 14px，视觉不变）。
   *  传入时内容会包进一层 overflow-x:clip 的 div：视口的 overflow-x:hidden
   *  挡不住程序化横滚（文本拖选出边界、内联编辑 caret 移动都会滚），任何
   *  子孙超宽几像素就会把 scrollLeft 顶出去且无法复位——整列卡片偶发左移、
   *  右侧露白。clip 不能设在视口自身（与纵向 scroll 同元素时会降级为
   *  hidden），放在带 padding 的内容层上：横向 scrollWidth 不再超出，
   *  scrollLeft 恒 0，ring 的 4px 余量也保住。 */
  viewportClassName?: string
}) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        // [&>div]:!block：Radix 视口内层默认 display:table，长 URL 等不可断词
        // 内容会把整列撑宽导致横向溢出（break-words 失效）；强制 block 恢复宽度约束
        className="size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 [&>div]:!block [&>div]:!min-w-0"
      >
        {viewportClassName ? (
          <div className={cn("overflow-x-clip", viewportClassName)}>
            {children}
          </div>
        ) : (
          children
        )}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      data-slot="scroll-area-scrollbar"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        "flex touch-none p-px transition-colors select-none data-horizontal:h-2.5 data-horizontal:flex-col data-horizontal:border-t data-horizontal:border-t-transparent data-vertical:h-full data-vertical:w-2.5 data-vertical:border-l data-vertical:border-l-transparent",
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-slot="scroll-area-thumb"
        className="relative flex-1 rounded-full bg-border"
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  )
}

export { ScrollArea, ScrollBar }
