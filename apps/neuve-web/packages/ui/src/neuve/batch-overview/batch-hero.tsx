import { Fragment, useId } from "react"
import type { ReactNode } from "react"
import { useSetAtom } from "jotai"
import {
  closeCardAtom,
  openCitationAtom,
  openSheetAtom,
} from "@workspace/ui/neuve/review-desk/atoms"
import { StateLabel } from "@workspace/ui/neuve/review-desk/checkpoint-parts"
import {
  GitBranchIcon,
  GitCommitHorizontalIcon,
  LayersIcon,
  LoaderCircleIcon,
  TicketIcon,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

import {
  briefingParagraphs,
  sentenceParts,
  spaceBeforeChip,
} from "@workspace/ui/neuve/shared/briefing-paragraphs"
import { cn } from "@workspace/ui/lib/utils"
import { Disclosure } from "@workspace/ui/neuve/shared/disclosure"
import { emphasisParts } from "@workspace/ui/neuve/shared/digest-emphasis"
import {
  CitationChip,
  markerKind,
} from "@workspace/ui/neuve/shared/marker-kind"
import type { MarkerKind } from "@workspace/ui/neuve/shared/marker-kind"
import {
  DecisionPanel,
  isSettled,
} from "@workspace/ui/neuve/batch-overview/decision-panel"
import { NeuveLink } from "@workspace/ui/neuve/shared/nav-link"
import { NewWorkNotice } from "@workspace/ui/neuve/batch-overview/new-work-notice"
import { usePendingItem } from "@workspace/ui/neuve/shared/batch-arrivals"
import type { PendingItem } from "@workspace/ui/neuve/shared/batch-arrivals"
import type { StartReviewHandler } from "@workspace/ui/neuve/states/start-review"
import type { ReviewStart } from "@workspace/ui/neuve/states/review-start"
import type {
  BatchOverviewData,
  BriefingSegment,
  ContextualMarker,
  DigestObligation,
} from "@workspace/ui/neuve/types"

const ICON = "size-[15px] shrink-0"
const ICON_STROKE = 1.75

function Meta({
  icon: Icon,
  children,
  mono = true,
  iconClassName,
}: {
  icon: LucideIcon
  children: ReactNode
  mono?: boolean
  iconClassName?: string
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Icon
        aria-hidden="true"
        className={cn(ICON, iconClassName)}
        strokeWidth={ICON_STROKE}
      />
      <span className={mono ? "font-mono text-[12.5px]" : undefined}>
        {children}
      </span>
    </span>
  )
}

/**
 * The batches still to come: "Reviewing 2 more batches" with the turning
 * mark, or "2 batches not reviewed" once the review stopped without them.
 */
function PendingMeta({
  item,
  still = false,
}: {
  item: PendingItem
  /** The invisible copy: its mark does not turn. */
  still?: boolean
}) {
  const batches = item.pending === 1 ? "batch" : "batches"
  return item.stopped ? (
    // The review stopped with these unpublished: nothing is running.
    <span>{`${item.pending} ${batches} not reviewed`}</span>
  ) : (
    <Meta
      icon={LoaderCircleIcon}
      mono={false}
      iconClassName={still ? undefined : "motion-safe:animate-pending-spin"}
    >
      {`Reviewing ${item.pending} more ${batches}`}
    </Meta>
  )
}

/** A citation's kind; a citation whose marker is missing reads as unavailable. */
function citationKind(marker: ContextualMarker | undefined): MarkerKind {
  return marker ? markerKind(marker) : "unavailable"
}

/**
 * A unit named in the digest, as a link that opens it. Its spaces collapse
 * (the digest's paragraphs keep the harness's own) so a line it wraps at
 * ends its underline at the last word, and each line keeps its own box.
 */
const UNIT_LINK =
  "box-decoration-clone whitespace-normal text-ink underline decoration-line-strong underline-offset-[3px] transition-colors duration-surface-tone ease-standard hover:text-ink hover:decoration-ink motion-reduce:transition-none"

const DIGEST_HEADING = "m-0 text-[13px] leading-5 font-semibold text-ink"
const DIGEST_TEXT = "flex flex-col gap-2 text-[17px] leading-[27px] text-ink-2"

/** Digest words with their `**…**` pairs bold (digest-emphasis.ts). */
function Emphasized({ text }: { text: string }) {
  return emphasisParts(text).map((part, index) =>
    part.strong ? (
      <strong key={index} className="font-semibold text-ink">
        {part.text}
      </strong>
    ) : (
      <Fragment key={index}>{part.text}</Fragment>
    )
  )
}

/**
 * One part of the digest, its paragraphs as the harness wrote them. Phrases
 * and chips stay inside their paragraph (briefing-paragraphs.ts).
 */
function DigestText({
  segments,
  markers,
}: {
  segments: ReadonlyArray<BriefingSegment>
  markers: Record<string, ContextualMarker>
}) {
  const openCitation = useSetAtom(openCitationAtom)
  const openSheet = useSetAtom(openSheetAtom)
  const closeCard = useSetAtom(closeCardAtom)
  return (
    <div className={DIGEST_TEXT}>
      {briefingParagraphs(segments).map((run, index) => (
        <p key={index} className="m-0 whitespace-pre-wrap">
          {sentenceParts(run).map(({ segment, glued }, i, parts) => {
            if (segment.kind === "phrase" && segment.target.kind === "unit")
              // A phrase that names a unit opens it.
              return (
                <NeuveLink
                  key={i}
                  destination={{ to: "unit", unitId: segment.target.unitId }}
                  className={UNIT_LINK}
                >
                  <Emphasized text={segment.text} />
                </NeuveLink>
              )
            if (segment.kind !== "cite")
              // The overview has no diff to land in: any other phrase
              // reads as its words.
              return (
                <span key={i}>
                  <Emphasized text={segment.text} />
                </span>
              )
            const chip = (
              // In the briefing a chip shows only its kind icon (round 5),
              // as on the desk; its name and its tooltip say the kind and
              // the target. It opens the source sheet: there is no diff
              // here to light.
              <CitationChip
                data-source-trigger
                kind={citationKind(markers[segment.markerKey])}
                label={segment.label}
                lands={false}
                iconOnly
                aria-label={segment.ariaLabel}
                onClick={() => {
                  openCitation(segment.markerKey)
                  openSheet()
                  closeCard()
                }}
              />
            )
            return (
              <Fragment key={i}>
                {spaceBeforeChip(parts[i - 1]?.segment) && " "}
                {glued ? (
                  // The punctuation after a chip stays on its line.
                  <span data-chip-glue="" className="whitespace-nowrap">
                    {chip}
                    {glued}
                  </span>
                ) : (
                  chip
                )}
              </Fragment>
            )
          })}
        </p>
      ))}
    </div>
  )
}

/** A short section of the digest: its heading, then its words. */
function DigestSection({
  heading,
  children,
}: {
  heading: string
  children: ReactNode
}) {
  const id = useId()
  return (
    <section aria-labelledby={id} className="flex flex-col gap-1.5">
      <h2 id={id} className={DIGEST_HEADING}>
        {heading}
      </h2>
      {children}
    </section>
  )
}

/**
 * A ticket item's words for a status, as the Guided card says them
 * (criteria-card.tsx): a "Done when" item is done, a scope covered.
 */
const OBLIGATION_WORDS = {
  "done-when": {
    met: "Done",
    "not-met": "Not done",
    "no-evidence": "No evidence",
  },
  scope: {
    met: "Covered",
    "not-met": "Not covered",
    "no-evidence": "No evidence",
  },
  gathered: {
    met: "Covered",
    "not-met": "Not covered",
    "no-evidence": "No evidence",
  },
} as const

const UNIT_STATUS_ORDER = [
  "met",
  "not-met",
  "no-evidence",
  "not-required",
] as const

function overallWords(obligation: DigestObligation) {
  const words = OBLIGATION_WORDS[obligation.basis]
  const overall = obligation.overall
  if (!overall) return undefined
  return overall.kind === "partly"
    ? `${words.met} on ${overall.met} of ${overall.of} units`
    : words[overall.kind]
}

/**
 * Each ticket item across the batch's units (10.87): its words and its
 * status over the units that need it, then its units by their own status,
 * each a link to the unit.
 */
function Obligations({
  obligations,
}: {
  obligations: ReadonlyArray<DigestObligation>
}) {
  return (
    <ul className="m-0 mt-1 flex list-none flex-col gap-3 p-0">
      {obligations.map((obligation, index) => {
        const words = OBLIGATION_WORDS[obligation.basis]
        const overall = overallWords(obligation)
        const groups = UNIT_STATUS_ORDER.flatMap((status) => {
          const units = obligation.units.filter(
            (unit) => unit.status === status
          )
          return units.length > 0 ? [{ status, units }] : []
        })
        return (
          <li key={index} className="flex flex-col gap-0.5">
            <p className="m-0 text-[15px] leading-[22px] text-pretty text-ink-2">
              <span className="text-ink">{obligation.text}</span>
              {overall && (
                <span className="text-ink-muted">{` · ${overall}`}</span>
              )}
            </p>
            {groups.length > 0 && (
              <p className="m-0 text-[13px] leading-5 text-pretty text-ink-muted">
                {groups.map(({ status, units }, i) => (
                  <Fragment key={status}>
                    {i > 0 && <span aria-hidden="true">{" · "}</span>}
                    {`${status === "not-required" ? "Not required" : words[status]}: `}
                    {units.map((unit, j) => (
                      <Fragment key={unit.unitId}>
                        {j > 0 && ", "}
                        <NeuveLink
                          destination={{ to: "unit", unitId: unit.unitId }}
                          className={UNIT_LINK}
                        >
                          {unit.title}
                          {/* The digest names no lane: a title that left
                          its lane words out says them to screen readers. */}
                          {unit.laneWords && (
                            <span className="sr-only">{` (${unit.laneWords})`}</span>
                          )}
                        </NeuveLink>
                        {/* As the unit page's row says it: no proof is recorded. */}
                        {unit.proofState === "missing" && (
                          <StateLabel
                            proof="missing"
                            className="ml-1.5 align-middle leading-4"
                          />
                        )}
                      </Fragment>
                    ))}
                  </Fragment>
                ))}
              </p>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * Hero: a notice when the branch has moved past this review, the batch title
 * and provenance (with the batches still being reviewed, while there are
 * any, or not reviewed, once the review stopped without them), the decision panel, and the batch digest in short sections (what it
 * removes, disables or narrows, when it does; what changed; what to check),
 * which fold away once nothing waits on you.
 */
export function BatchHero({
  data,
  start,
  onStartReview,
}: {
  data: BatchOverviewData
  /** What "Start a review" would review now (live overview). */
  start?: ReviewStart
  onStartReview?: StartReviewHandler
}) {
  const settled = isSettled(data)
  const contextual = data.contextualBriefing
  const item = usePendingItem(data.batches)
  const briefing = (
    <div className="flex flex-col gap-5">
      {contextual?.removed?.length ? (
        <DigestSection heading="Removed, disabled or narrowed">
          <DigestText
            segments={contextual.removed}
            markers={contextual.markers}
          />
        </DigestSection>
      ) : null}
      {/* The digest's words when it has any; else the plain briefing (a
          batch can arrive with limitations and no digest); else nothing. */}
      {contextual?.segments.length ? (
        <DigestSection heading="What changed">
          <DigestText
            segments={contextual.segments}
            markers={contextual.markers}
          />
        </DigestSection>
      ) : data.briefing.trim() ? (
        <DigestSection heading="What changed">
          <p className="m-0 text-[17px] leading-[27px] whitespace-pre-wrap text-ink-2">
            <Emphasized text={data.briefing} />
          </p>
        </DigestSection>
      ) : null}
      {contextual?.toCheck?.length || contextual?.obligations?.length ? (
        <DigestSection heading="What to check">
          {contextual.toCheck?.length ? (
            <DigestText
              segments={contextual.toCheck}
              markers={contextual.markers}
            />
          ) : null}
          {contextual.obligations?.length ? (
            <Obligations obligations={contextual.obligations} />
          ) : null}
        </DigestSection>
      ) : null}
      {contextual?.limitations.length ? (
        <Disclosure
          label="Limitations"
          count={contextual.limitations.length}
          className="-ml-2.5"
        >
          <ul className="m-0 flex list-disc flex-col gap-1.5 pl-4 text-[13px] leading-5 text-ink-2 marker:text-faint">
            {contextual.limitations.map((text, index) => (
              <li key={index} className="whitespace-pre-wrap">
                {text}
              </li>
            ))}
          </ul>
        </Disclosure>
      ) : null}
    </div>
  )
  return (
    <section className="flex max-w-[760px] flex-col gap-5">
      <NewWorkNotice
        start={start}
        revision={data.revision}
        onStartReview={onStartReview}
      />
      <h1 className="m-0 text-[40px] leading-[46px] font-semibold tracking-[-0.03em] text-balance max-[600px]:text-[30px] max-[600px]:leading-[36px]">
        {data.title}
      </h1>
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-[13px] text-ink-muted">
        {data.ticket && <Meta icon={TicketIcon}>{data.ticket}</Meta>}
        <Meta icon={GitBranchIcon}>{data.branch}</Meta>
        <Meta icon={GitCommitHorizontalIcon}>
          <span title={data.revision}>{data.revision.slice(0, 12)}</span>
        </Meta>
        <Meta icon={LayersIcon} mono={false}>
          {data.unitCount} {data.unitCount === 1 ? "unit" : "units"}
        </Meta>
        {/* Last, so nothing else moves when it changes or goes. The new
            batch itself is announced by the header. */}
        {item.held && (
          // One cell: what it says now over an invisible copy of what it
          // first said, so its box never narrows or goes while the screen
          // lives (the row would rewrap and move what is below it).
          <span className="inline-grid">
            {item.shown && (
              <span className="flex [grid-area:1/1]">
                <PendingMeta item={item.shown} />
              </span>
            )}
            <span aria-hidden="true" className="invisible flex [grid-area:1/1]">
              <PendingMeta item={item.held} still />
            </span>
          </span>
        )}
      </div>
      <DecisionPanel data={data} />
      {settled ? (
        <Disclosure
          label="Briefing"
          className="-ml-2.5"
          contentClassName="pt-1 pr-0 pb-2 pl-2.5"
        >
          {briefing}
        </Disclosure>
      ) : (
        briefing
      )}
    </section>
  )
}
