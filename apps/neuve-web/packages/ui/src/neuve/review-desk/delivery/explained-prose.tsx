import { cn } from "@workspace/ui/lib/utils"
import { blockProps } from "@workspace/ui/neuve/review-desk/delivery/phased-layer"
import type { ExplainedText } from "@workspace/ui/neuve/types"

/** The Explained stop as the harness writes it (10.60): two paragraphs and up to three terms. */
export type ExplainedProseContent = ExplainedText

const LABEL = "label-mono text-[10px] text-ink-muted"

/**
 * The columns Before and After share in the briefing: After is the wider,
 * since it says what the change does now. A container query, so the
 * briefing's width decides, never the window's.
 */
export const BEFORE_AFTER_COLUMNS =
  "grid grid-cols-1 gap-y-2.5 @min-[40rem]:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] @min-[40rem]:gap-x-7"

/**
 * The labels over Before and After, once over all of a joined unit's rows
 * at desk width. Its rows then show no labels of their own.
 */
export function BeforeAfterHeader({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "hidden @min-[40rem]:grid @min-[40rem]:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] @min-[40rem]:gap-x-7",
        className
      )}
    >
      <span className={LABEL}>Before</span>
      <span className={LABEL}>After</span>
    </div>
  )
}

/**
 * One change's Before beside its After (Explained, merged briefing). Before
 * is quieter: it is what the code no longer does. Each paragraph carries
 * its label for screen readers; on screen the label shows over it at phone
 * width, or always when `labels` is "always" (a unit with one change, which
 * has no header row).
 */
export function BeforeAfter({
  text,
  labels = "narrow",
}: {
  text: Pick<ExplainedText, "before" | "after">
  labels?: "always" | "narrow"
}) {
  const rows = [
    { label: "Before", text: text.before, tone: "text-ink-muted" },
    { label: "After", text: text.after, tone: "text-ink-2" },
  ]
  return (
    <div className={BEFORE_AFTER_COLUMNS}>
      {rows.map((row) => (
        <div
          key={row.label}
          {...blockProps()}
          className="flex min-w-0 flex-col gap-0.5"
        >
          <span
            className={cn(LABEL, labels === "narrow" && "@min-[40rem]:sr-only")}
          >
            {row.label}
          </span>
          <p
            className={cn(
              "m-0 text-[14px] leading-[21px] text-pretty",
              row.tone
            )}
          >
            {row.text}
          </p>
        </div>
      ))}
    </div>
  )
}

const TERM =
  "inline-flex min-h-[22px] max-w-full items-center rounded-[5px] bg-raised px-[7px] font-mono text-xs wrap-anywhere text-syn-kw"

/**
 * The terms of a unit's changes at Explained, once each, in as many columns
 * as the briefing's width holds.
 */
export function ExplainedTerms({
  terms,
  className,
}: {
  terms: ExplainedText["terms"]
  className?: string
}) {
  if (terms.length === 0) return null
  return (
    <dl
      className={cn(
        "m-0 grid grid-cols-[repeat(auto-fill,minmax(min(250px,100%),1fr))] gap-x-7 gap-y-3",
        className
      )}
    >
      {terms.map((term) => (
        <div
          key={term.term}
          {...blockProps()}
          className="flex min-w-0 flex-col items-start gap-1"
        >
          <dt className={TERM}>{term.term}</dt>
          <dd className="m-0 text-[13px] leading-[19px] text-ink-2">
            {term.meaning}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** Each term once, first use first. */
export function uniqueTerms(
  texts: ReadonlyArray<ExplainedText>
): ExplainedText["terms"] {
  const seen = new Set<string>()
  return texts
    .flatMap((text) => text.terms)
    .filter((term) => !seen.has(term.term) && !!seen.add(term.term))
}
