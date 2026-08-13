"use client"

import * as React from "react"
import { Tooltip as TooltipPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function TooltipProvider({
  delayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  )
}

const TooltipPointerContext = React.createContext<
  React.MutableRefObject<boolean> | null
>(null)

/**
 * 提示只允许指针悬停打开：菜单/浮层关闭后焦点程序化回流到触发按钮时，
 * Radix 会以焦点态弹出提示且没有失焦事件让它关闭（现网复现：菜单选完
 * tips 钉死不消失）。键盘与读屏语义由按钮 aria-label 承担，与本策略无关。
 */
function Tooltip({
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  const pointerInside = React.useRef(false)
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen)
  const isControlled = openProp !== undefined
  const open = isControlled ? openProp : uncontrolledOpen
  const handleOpenChange = (next: boolean) => {
    if (next && !pointerInside.current) return
    if (!isControlled) setUncontrolledOpen(next)
    onOpenChange?.(next)
  }
  return (
    <TooltipPointerContext.Provider value={pointerInside}>
      <TooltipPrimitive.Root
        data-slot="tooltip"
        open={open}
        onOpenChange={handleOpenChange}
        {...props}
      />
    </TooltipPointerContext.Provider>
  )
}

function TooltipTrigger({
  onPointerEnter,
  onPointerLeave,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  const pointerInside = React.useContext(TooltipPointerContext)
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      onPointerEnter={(event) => {
        if (pointerInside) pointerInside.current = true
        onPointerEnter?.(event)
      }}
      onPointerLeave={(event) => {
        if (pointerInside) pointerInside.current = false
        onPointerLeave?.(event)
      }}
      {...props}
    />
  )
}

function TooltipContent({
  className,
  sideOffset = 0,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          // pointer-events-none：气泡以 Portal 挂在 body、常悬在触发按钮旁，
          // 若可接收指针，点击会被它截胡——SimpleMenu 的外点关闭判定把它当
          // 「菜单外」，造成「点图标关菜单时闪烁一下又重开/再关」的竞态。
          // 提示气泡永远不该是指针目标。
          "pointer-events-none z-50 inline-flex w-fit max-w-xs origin-(--radix-tooltip-content-transform-origin) items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-xs text-background duration-(--duration-overlay) ease-(--ease-standard) has-data-[slot=kbd]:pr-1.5 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-sm data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px] bg-foreground fill-foreground" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }
