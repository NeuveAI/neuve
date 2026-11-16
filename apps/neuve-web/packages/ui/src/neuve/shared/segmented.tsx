import type { LucideIcon } from "lucide-react"

import {
  ToggleGroup,
  ToggleGroupItem,
} from "@workspace/ui/components/toggle-group"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  /** How many the option holds, shown small after its label. */
  count?: number
  icon?: LucideIcon
  /**
   * Unavailable right now: shown dimmed and aria-disabled, so it stays in
   * the keyboard path (Tab and arrows reach it) but can't be chosen.
   */
  disabled?: boolean
  /** Why it is unavailable: a tooltip on hover and focus, and its description. */
  description?: string
}

/**
 * Segmented control (Stacked/Split). With `onValueChange` every available
 * option is live; without it only the current option is enabled and the
 * others render faithfully but aria-disabled (a mode not designed yet).
 * Unavailable options are aria-disabled rather than disabled, so keyboard
 * users can reach them and read why.
 */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onValueChange,
}: {
  label: string
  options: ReadonlyArray<SegmentedOption<T> | T>
  value: T
  onValueChange?: (value: T) => void
}) {
  const items = options.map((option) =>
    typeof option === "string"
      ? {
          value: option,
          label: option,
          icon: undefined,
          count: undefined,
          disabled: false,
          description: undefined,
        }
      : option
  )
  return (
    <TooltipProvider delayDuration={300}>
      <ToggleGroup
        type="single"
        value={value}
        onValueChange={(next) => {
          // Radix clears the value when the active item is pressed again; a
          // segmented control always has one option on. Unavailable options
          // are focusable but never chosen.
          if (!next || !onValueChange) return
          if (items.find((item) => item.value === next)?.disabled) return
          onValueChange(next as T)
        }}
        aria-label={label}
        spacing={0}
        variant="segment"
        size="segment"
        className="rounded-lg bg-raised p-[3px]"
      >
        {items.map((option) => {
          const ariaDisabled =
            option.disabled || (!onValueChange && option.value !== value)
          const content = (
            <>
              {option.icon && (
                <option.icon aria-hidden="true" className="size-[13px]" />
              )}
              <span>{option.label}</span>
              {option.count !== undefined && (
                // The comma keeps the name "All, 16" apart for assistive tech.
                <span className="font-mono text-[11px] text-ink-muted tabular-nums">
                  <span className="sr-only">, </span>
                  {option.count}
                </span>
              )}
            </>
          )
          const itemProps = {
            value: option.value,
            "aria-disabled": ariaDisabled ? true : undefined,
            "aria-description": option.description,
            "data-unavailable": option.disabled ? "" : undefined,
            // The icon and label dim, not the item: its focus ring (the
            // item's outline) keeps full strength now that it's focusable.
            className:
              "data-unavailable:cursor-not-allowed data-unavailable:*:opacity-50",
          }
          if (!option.description)
            return (
              <ToggleGroupItem key={option.value} {...itemProps}>
                {content}
              </ToggleGroupItem>
            )
          // The toggle item renders the tooltip's trigger (not the other way
          // round), so the item keeps its own data-state (on/off).
          return (
            <Tooltip key={option.value}>
              <ToggleGroupItem asChild {...itemProps}>
                <TooltipTrigger>{content}</TooltipTrigger>
              </ToggleGroupItem>
              <TooltipContent side="top">{option.description}</TooltipContent>
            </Tooltip>
          )
        })}
      </ToggleGroup>
    </TooltipProvider>
  )
}
