import * as React from "react"
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  MoreHorizontalIcon,
} from "lucide-react"
import { Slot } from "radix-ui"

import { cn } from "@workspace/ui/lib/utils"

/*
 * shadcn's Pagination (radix-nova), on Neuve's tokens: a nav of pages with
 * Previous and Next, the current page outlined. Links take `asChild` so a
 * screen can pass its router-agnostic link; a page that can't be reached
 * (Previous on the first page) renders as a disabled span, not a link.
 */

function Pagination({ className, ...props }: React.ComponentProps<"nav">) {
  return (
    <nav
      aria-label="Pages"
      data-slot="pagination"
      className={cn("flex", className)}
      {...props}
    />
  )
}

function PaginationContent({
  className,
  ...props
}: React.ComponentProps<"ul">) {
  return (
    <ul
      data-slot="pagination-content"
      className={cn(
        "m-0 flex list-none flex-row items-center gap-1 p-0",
        className
      )}
      {...props}
    />
  )
}

function PaginationItem(props: React.ComponentProps<"li">) {
  return <li data-slot="pagination-item" {...props} />
}

const linkClass =
  "inline-flex h-9 min-w-9 items-center justify-center gap-1 rounded-lg px-2.5 text-sm font-medium text-ink tabular-nums no-underline transition-colors duration-surface-tone ease-standard hover:bg-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus focus-visible:outline-solid motion-reduce:transition-none"

type PaginationLinkProps = {
  isActive?: boolean
  asChild?: boolean
} & React.ComponentProps<"a">

function PaginationLink({
  className,
  isActive,
  asChild = false,
  ...props
}: PaginationLinkProps) {
  const Comp = asChild ? Slot.Root : "a"
  return (
    <Comp
      aria-current={isActive ? "page" : undefined}
      data-slot="pagination-link"
      data-active={isActive}
      className={cn(
        linkClass,
        isActive &&
          "bg-surface shadow-[0_0_0_1px_var(--nv-line)] hover:bg-surface",
        className
      )}
      {...props}
    />
  )
}

/** A page step that can't be taken: shown, dimmed, and not a link. */
function PaginationDisabled({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      aria-disabled="true"
      data-slot="pagination-disabled"
      className={cn(
        linkClass,
        "cursor-default text-faint hover:bg-transparent hover:text-faint",
        className
      )}
      {...props}
    />
  )
}

function PreviousContent({ label = "Previous" }: { label?: string }) {
  return (
    <>
      <ChevronLeftIcon
        aria-hidden="true"
        className="size-[15px]"
        strokeWidth={1.75}
      />
      <span data-slot="pagination-label">{label}</span>
    </>
  )
}

function NextContent({ label = "Next" }: { label?: string }) {
  return (
    <>
      <span data-slot="pagination-label">{label}</span>
      <ChevronRightIcon
        aria-hidden="true"
        className="size-[15px]"
        strokeWidth={1.75}
      />
    </>
  )
}

function PaginationEllipsis({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      aria-hidden="true"
      data-slot="pagination-ellipsis"
      className={cn(
        "flex size-9 items-center justify-center text-ink-muted",
        className
      )}
      {...props}
    >
      <MoreHorizontalIcon className="size-4" strokeWidth={1.75} />
    </span>
  )
}

/**
 * The pages to show around `page` of `count`: the first, the last, the current
 * one and its neighbours, with a gap (null) wherever pages are skipped.
 */
function pageWindow(page: number, count: number): Array<number | null> {
  const shown: Array<number | null> = []
  for (let n = 1; n <= count; n += 1) {
    if (n === 1 || n === count || Math.abs(n - page) <= 1) shown.push(n)
    else if (shown.at(-1) !== null) shown.push(null)
  }
  return shown
}

export {
  Pagination,
  PaginationContent,
  PaginationDisabled,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  NextContent as PaginationNextContent,
  PreviousContent as PaginationPreviousContent,
  pageWindow,
}
