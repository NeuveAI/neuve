import { useSetAtom } from "jotai"

import { landOnAtom } from "@workspace/ui/neuve/review-desk/landing"
import {
  LINE_CHIP_BUTTON,
  rangeAria,
  rangeLabel,
} from "@workspace/ui/neuve/review-desk/delivery/flow-card"
import type { DeliveryTerm } from "@workspace/ui/neuve/shared/delivery"
import { blockProps } from "@workspace/ui/neuve/review-desk/delivery/phased-layer"

/**
 * Language terms (Explained only): at most three constructs from the owned
 * lines, each with a line chip that lands on it. Not a primer: only what
 * this unit uses.
 */
export function TermsCard({
  terms,
  unitId,
  languageName,
}: {
  terms: ReadonlyArray<DeliveryTerm>
  unitId: string
  /** The provider's display name for the unit's language; never derived. */
  languageName?: string
}) {
  const landOn = useSetAtom(landOnAtom)
  const block = blockProps()
  const title = languageName
    ? `${languageName} in this unit`
    : "Terms in this unit"
  return (
    <section
      aria-label={title}
      className="flex flex-col gap-2.5 rounded-xl bg-surface px-[18px] py-4 shadow-[0_0_0_1px_var(--nv-line)]"
    >
      <h2 {...block} className="m-0 label-mono text-ink-muted">
        {title}
      </h2>
      <dl className="m-0 flex flex-col gap-2.5">
        {terms.map((term) => (
          <div key={term.term} {...block} className="flex flex-col gap-1">
            <dt className="flex items-start justify-between gap-2.5">
              <span className="inline-flex min-h-[22px] max-w-full items-center rounded-[5px] bg-raised px-[7px] font-mono text-xs wrap-anywhere text-syn-kw">
                {term.term}
              </span>
              <button
                type="button"
                className={LINE_CHIP_BUTTON}
                aria-label={`Land on ${rangeAria(term.range)}`}
                onClick={() =>
                  landOn({
                    unitId,
                    filePath: term.filePath,
                    range: term.range,
                  })
                }
              >
                {rangeLabel(term.range)}
                <span aria-hidden="true">↓</span>
              </button>
            </dt>
            <dd className="m-0 text-[13px] leading-[19px] text-ink-2">
              {term.explanation}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
