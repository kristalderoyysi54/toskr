"use client"

import * as React from "react"
import { Switch as SwitchPrimitive } from "radix-ui"

import { focusRing } from "@/components/ui/focus-ring"
import { cn } from "@/lib/utils"

function Switch({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: "sm" | "default"
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        "peer group/switch relative inline-flex shrink-0 items-center rounded-full border border-transparent transition-all outline-none after:absolute after:-inset-x-3 after:-inset-y-2",
        focusRing,
        "aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-[size=default]:h-[18px] data-[size=default]:w-8 data-[size=sm]:h-[14px] data-[size=sm]:w-6 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 data-checked:bg-primary data-checked:border-transparent data-unchecked:bg-(--switch-track-off) data-unchecked:border-(--switch-track-off-border) data-disabled:cursor-not-allowed data-disabled:opacity-45 shadow-[inset_0_1px_2px_oklch(0_0_0/0.18)] dark:shadow-[inset_0_1px_2px_oklch(0_0_0/0.45)]",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        // duration-base(180ms) + ease-pop 过冲：thumb 位移带一点 spring physicality
        className="pointer-events-none block rounded-full bg-background ring-0 transition-transform duration-(--duration-base) ease-(--ease-pop) motion-reduce:transition-none group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3 group-data-[size=default]/switch:data-checked:translate-x-[calc(100%-2px)] group-data-[size=sm]/switch:data-checked:translate-x-[calc(100%-2px)] dark:data-checked:bg-primary-foreground group-data-[size=default]/switch:data-unchecked:translate-x-0 group-data-[size=sm]/switch:data-unchecked:translate-x-0 dark:data-unchecked:bg-foreground glass-sheen shadow-[0_1px_2px_oklch(0_0_0/0.3),0_1px_1px_oklch(0_0_0/0.1)]"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
