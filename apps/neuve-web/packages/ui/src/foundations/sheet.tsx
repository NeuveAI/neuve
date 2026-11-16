import type * as React from "react"

import { cn } from "@workspace/ui/lib/utils"

/** A Foundations sheet: the page, its title and one line on what it shows. */
export function Sheet({
  title,
  lede,
  children,
}: {
  title: string
  lede: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="min-h-svh bg-paper px-8 py-10 font-sans text-sm text-ink">
      <header className="mb-8 flex max-w-[760px] flex-col gap-1.5">
        <h1 className="m-0 text-xl font-semibold tracking-[-0.01em]">
          {title}
        </h1>
        <p className="m-0 text-ink-muted">{lede}</p>
      </header>
      <div className="flex flex-col gap-10">{children}</div>
    </div>
  )
}

/** A titled group of rows. */
export function Group({
  label,
  note,
  children,
  className,
}: {
  label: string
  note?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <section aria-label={label} className="flex flex-col gap-3">
      <div className="flex items-baseline gap-3">
        <h2 className="m-0 label-mono">{label}</h2>
        {note && <span className="text-xs text-faint">{note}</span>}
      </div>
      <div className={cn("flex flex-col", className)}>{children}</div>
    </section>
  )
}

/** A token or class name, as code reads it. */
export function Name({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <code
      className={cn("font-mono text-[11.5px] break-all text-ink-2", className)}
    >
      {children}
    </code>
  )
}

/** The paper a component story sits on. */
export function StoryFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-svh bg-paper p-8 font-sans text-sm text-ink">
      {children}
    </div>
  )
}
