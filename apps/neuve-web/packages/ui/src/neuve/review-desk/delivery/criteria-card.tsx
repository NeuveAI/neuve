import * as React from "react"
import { useAtomValue, useSetAtom } from "jotai"
import { AnimatePresence, motion } from "motion/react"

import { REDUCED_TRANSITION } from "@workspace/ui/lib/motion"
import { CheckIcon, CircleDashedIcon, XIcon } from "lucide-react"

import { cn } from "@workspace/ui/lib/utils"
import {
  closeCardAtom,
  dockAtom,
  dockOriginAtom,
  draftAtom,
  openCitationAtom,
  openSheetAtom,
} from "@workspace/ui/neuve/review-desk/atoms"
import {
  EXCERPT,
  useReaderMotion,
} from "@workspace/ui/neuve/review-desk/delivery/delivery-motion"
import {
  openExcerptAtom,
  toggleExcerptAtom,
} from "@workspace/ui/neuve/review-desk/delivery/delivery-state"
import { blockProps } from "@workspace/ui/neuve/review-desk/delivery/phased-layer"
import {
  PROOF_ORDER,
  ProofIcon,
  StateLabel,
  proofFamily,
} from "@workspace/ui/neuve/review-desk/checkpoint-parts"
import { Disclosure } from "@workspace/ui/neuve/shared/disclosure"
import { ReviewMark, VerdictIcon } from "@workspace/ui/neuve/shared/review-mark"
import type { ReviewVerdict } from "@workspace/ui/neuve/shared/review-mark"
import {
  FAMILY_STYLE,
  MARKER_KINDS,
  MarkerKindIcon,
  markerFamily,
} from "@workspace/ui/neuve/shared/marker-kind"
import type {
  DeliveryCheckpoint,
  DeliveryCriterion,
  DeliveryCriterionStatus,
  DeliveryEvidence,
  DeliveryPayload,
  DeliverySuggestion,
} from "@workspace/ui/neuve/shared/delivery"
import type {
  CheckpointProof,
  ContextualMarker,
  ReviewDeskData,
  Reviewer,
} from "@workspace/ui/neuve/types"

export type Check = NonNullable<DeliveryPayload["check"]>

/** "!" for a row outside the ticket: for the reader's judgement. */
function ExclaimIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={3}
      strokeLinecap="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M12 8v5M12 16.5v.01" />
    </svg>
  )
}

/**
 * How each status looks. A "Done when" row gets a filled mark; a scope row
 * a ring in the same colour, since a scope is weaker evidence than a
 * checklist (Verdicts.dc.html, S2).
 */
const STATUS: Record<
  DeliveryCriterionStatus,
  {
    text: string
    fill: string
    ring: string
    icon: React.ComponentType<{ className?: string; strokeWidth?: number }>
  }
> = {
  met: {
    text: "text-agt-fg",
    fill: "bg-agt-tint text-agt-fg",
    ring: "shadow-[inset_0_0_0_1.5px_var(--nv-agt)] text-agt-fg",
    icon: CheckIcon,
  },
  "not-met": {
    text: "text-req-fg",
    fill: "bg-req-tint text-req",
    ring: "shadow-[inset_0_0_0_1.5px_var(--nv-req)] text-req",
    icon: XIcon,
  },
  "no-evidence": {
    text: "text-sug-ink",
    fill: "bg-sug-tint text-sug",
    ring: "shadow-[inset_0_0_0_1.5px_var(--nv-sug)] text-sug",
    icon: CircleDashedIcon,
  },
  outside: {
    // Blast radius rows sit under their own heading and carry no status.
    text: "text-ink-muted",
    fill: "bg-sug-tint text-sug",
    ring: "bg-sug-tint text-sug",
    icon: ExclaimIcon,
  },
}

type Basis = NonNullable<Check["basis"]>

const COVERED_LABELS: Record<DeliveryCriterionStatus, string> = {
  met: "Covered",
  "not-met": "Not covered",
  "no-evidence": "No evidence",
  outside: "",
}

/**
 * The words for each basis: the ticket's own "Done when" says done; a
 * ticket's scope, or a scope the harness gathered from code and history,
 * says covered (round-4.md, "Scope fallback (S2)" and "Scope is always
 * gathered").
 */
const BASIS: Record<
  Basis,
  {
    heading: string
    labels: Record<DeliveryCriterionStatus, string>
    open: string
    all: string
  }
> = {
  "done-when": {
    heading: "Done when",
    labels: {
      met: "Done",
      "not-met": "Not done",
      "no-evidence": "No evidence",
      outside: "",
    },
    open: "not done",
    all: "everything is done",
  },
  scope: {
    heading: "Scope",
    labels: COVERED_LABELS,
    open: "not covered",
    all: "everything is covered",
  },
  gathered: {
    heading: "Gathered scope",
    labels: COVERED_LABELS,
    open: "not covered",
    all: "everything is covered",
  },
}

/** Fills for a ticket's "Done when"; rings for any scope (weaker evidence). */
function ringed(basis: Basis) {
  return basis !== "done-when"
}

function basisOf(check: Pick<Check, "basis">): Basis {
  return check.basis ?? "done-when"
}

/**
 * The check's region name: "Done when: <title>", "Scope: <title>" or
 * "Gathered scope: <intent>".
 */
export function checkHeading(check: Check) {
  return `${BASIS[basisOf(check)].heading}: ${check.ticket.title}`
}

const PIN =
  "inline-flex h-[22px] max-w-full min-w-0 items-center gap-[5px] rounded-md pr-2 pl-1.5 font-mono text-[11px] whitespace-nowrap"
const PIN_INTERACTIVE =
  "cursor-pointer border-0 transition-colors duration-surface-tone ease-standard focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus motion-reduce:transition-none"

/** The ticket's own rows (not the blast radius rows). */
export function doneCriteria(criteria: ReadonlyArray<DeliveryCriterion>) {
  return criteria.filter((criterion) => criterion.status !== "outside")
}

/**
 * The check's conclusion, computed from the ticket's rows (never carried by
 * the payload): "2 of 3 not done" (not done or without evidence), or
 * "everything is done"; for a scope, "2 of 3 not covered" or "everything is
 * covered". Blast radius rows don't count. Undefined without rows.
 */
export function checkConclusion(
  check: Pick<Check, "basis" | "criteria">
): string | undefined {
  const rows = doneCriteria(check.criteria)
  if (rows.length === 0) return undefined
  const words = BASIS[basisOf(check)]
  const open = rows.filter((criterion) => criterion.status !== "met").length
  return open === 0 ? words.all : `${open} of ${rows.length} ${words.open}`
}

/** A row's status mark; it arrives with its row's block. */
function Mark({
  status,
  basis,
}: {
  status: DeliveryCriterionStatus
  basis: Basis
}) {
  const look = STATUS[status]
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-[22px] items-center justify-center rounded-full",
        ringed(basis) ? look.ring : look.fill
      )}
    >
      <look.icon className="size-3" strokeWidth={3} />
    </span>
  )
}

function EvidencePin({
  evidence,
  excerptId,
  open,
  onToggle,
  marker,
  targetClassName = "text-faint",
}: {
  evidence: DeliveryEvidence
  excerptId: string
  open: boolean
  onToggle: () => void
  marker: ContextualMarker | undefined
  /** The target's tone: a checkpoint's lines are what the pin says, so they read in full contrast. */
  targetClassName?: string
}) {
  const openCitation = useSetAtom(openCitationAtom)
  const openSheet = useSetAtom(openSheetAtom)
  const closeCard = useSetAtom(closeCardAtom)
  const family = FAMILY_STYLE[markerFamily(evidence.kind)]
  const content = (
    <>
      <MarkerKindIcon kind={evidence.kind} className={family.icon} />
      {evidence.label || MARKER_KINDS[evidence.kind].label}
      {evidence.target && (
        <span className={cn("min-w-0 truncate", targetClassName)}>
          {evidence.target}
        </span>
      )}
    </>
  )
  // Guided shows no diff: a source pin opens only its cited lines; a pin
  // with a marker opens that marker's source sheet.
  if (evidence.excerpt?.length)
    return (
      <button
        type="button"
        aria-expanded={open}
        aria-controls={excerptId}
        onClick={onToggle}
        className={cn(PIN, PIN_INTERACTIVE, family.tint, family.hover)}
      >
        {content}
      </button>
    )
  if (marker)
    return (
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={() => {
          openCitation(marker.key)
          openSheet()
          closeCard()
        }}
        className={cn(PIN, PIN_INTERACTIVE, family.tint, family.hover)}
      >
        {content}
      </button>
    )
  return <span className={cn(PIN, family.tint)}>{content}</span>
}

const pinKey = (evidence: DeliveryEvidence) =>
  evidence.markerKey ??
  `${evidence.kind}:${evidence.label}:${evidence.target ?? ""}`

/**
 * A row's pins: its evidence, then the reading's cites it doesn't already
 * show. The reading most often cites the lines the row does, so each set of
 * lines is pinned once, under the row's words.
 */
function rowPins(criterion: DeliveryCriterion): Array<DeliveryEvidence> {
  const shown = new Set(criterion.evidence.map(pinKey))
  const extra = (criterion.reading?.cites ?? []).filter((cite) => {
    const key = pinKey(cite)
    if (shown.has(key)) return false
    shown.add(key)
    return true
  })
  return [...criterion.evidence, ...extra]
}

function CriterionRow({
  criterion,
  basis,
  markers,
  group,
}: {
  criterion: DeliveryCriterion
  basis: Basis
  markers: Record<string, ContextualMarker>
  /** Rows that move as one block with their heading (the blast radius). */
  group?: string
}) {
  const openExcerpt = useAtomValue(openExcerptAtom)
  const toggleExcerpt = useSetAtom(toggleExcerptAtom)
  const id = React.useId()
  const look = STATUS[criterion.status]
  // Only the unmet ones sit under their item (11.23); the rest are the foot's.
  const unmet = (criterion.checkpoints ?? []).filter((c) => c.unmet)
  const label = BASIS[basis].labels[criterion.status]
  const pins = rowPins(criterion)
  const openIndex = pins.findIndex(
    (_, i) => openExcerpt === `${criterion.id}:${i}`
  )
  const excerpt = openIndex >= 0 ? pins[openIndex]?.excerpt : undefined
  const block = blockProps(group)
  return (
    <li
      {...block}
      className="grid grid-cols-[28px_minmax(0,1fr)] gap-x-3 gap-y-1 border-t border-line-2 py-3.5 first:border-t-0"
    >
      <Mark status={criterion.status} basis={basis} />
      <p className="m-0 text-sm leading-[22px] font-semibold">
        {criterion.criterion}
        {label && (
          <span
            className={cn("ml-2 font-mono text-[11px] font-medium", look.text)}
          >
            {label}
          </span>
        )}
        {/* No proof is recorded for the item's file: the checkpoints' word. */}
        {criterion.proofState === "missing" && (
          <StateLabel
            proof="missing"
            className="ml-2 align-middle leading-4 font-medium"
          />
        )}
      </p>
      <p className="col-start-2 m-0 max-w-[720px] text-[13.5px] leading-5 text-ink-2">
        {criterion.does}
      </p>
      {/* The agent's words, as its review card says them; never a status. */}
      {criterion.reading && (
        <p
          data-reading=""
          className="col-start-2 m-0 max-w-[720px] text-[13.5px] leading-5 text-ink-2"
        >
          {criterion.reading.text}
        </p>
      )}
      <span className="col-start-2 flex flex-wrap gap-1.5 pt-1">
        {pins.map((evidence, i) => (
          <EvidencePin
            key={i}
            evidence={evidence}
            excerptId={`${id}-excerpt-${i}`}
            open={openIndex === i}
            onToggle={() => toggleExcerpt(`${criterion.id}:${i}`)}
            marker={
              evidence.markerKey ? markers[evidence.markerKey] : undefined
            }
          />
        ))}
      </span>
      <Excerpt
        lines={excerpt}
        motionKey={openIndex}
        id={`${id}-excerpt-${openIndex}`}
        className="col-start-2"
      />
      {unmet.length > 0 && (
        <div className="col-start-2 flex flex-col gap-1.5 pt-2">
          <h3 id={`${id}-unmet`} className="m-0 label-mono text-ink-muted">
            {unmet.length} unmet{" "}
            {unmet.length === 1 ? "checkpoint" : "checkpoints"}
          </h3>
          <CheckpointList
            checkpoints={unmet}
            markers={markers}
            labelledBy={`${id}-unmet`}
          />
        </div>
      )}
    </li>
  )
}

/** A pin's cited lines, opened under it; Guided shows no diff. */
function Excerpt({
  lines,
  motionKey,
  id,
  className,
}: {
  lines: ReadonlyArray<string> | undefined
  motionKey: number | string
  id: string
  className?: string
}) {
  const readerMode = useReaderMotion()
  return (
    <AnimatePresence initial={false}>
      {lines && (
        <motion.pre
          key={motionKey}
          id={id}
          initial={
            readerMode === "full"
              ? { opacity: 0, y: EXCERPT.offsetY }
              : { opacity: 0 }
          }
          animate={{
            opacity: 1,
            y: 0,
            transition:
              readerMode === "full" ? EXCERPT.enter : REDUCED_TRANSITION,
          }}
          exit={{
            opacity: 0,
            transition:
              readerMode === "full" ? EXCERPT.exit : REDUCED_TRANSITION,
          }}
          className={cn(
            "m-0 mt-1 overflow-x-auto rounded-lg bg-paper py-1.5 font-mono text-xs leading-[22px] shadow-[inset_0_0_0_1px_var(--nv-line-2)]",
            className
          )}
        >
          {lines.map((line, i) => (
            <span key={i} className="block px-3">
              {line}
            </span>
          ))}
        </motion.pre>
      )}
    </AnimatePresence>
  )
}

/* ── Checkpoints (11.23) ────────────────────────────────── */

/** The excerpt key of a checkpoint's lines pin; numbers are the unit's own. */
const checkpointExcerpt = (checkpoint: Pick<DeliveryCheckpoint, "number">) =>
  `checkpoint:${checkpoint.number}`

/**
 * One checkpoint: its state (icon and word), where it sits (a pin that
 * opens its lines, or the unit as a whole), what it asks for and why it
 * stands as it does, in Records' words.
 */
function CheckpointItem({
  checkpoint,
  markers,
}: {
  checkpoint: DeliveryCheckpoint
  markers: Record<string, ContextualMarker>
}) {
  const openExcerpt = useAtomValue(openExcerptAtom)
  const toggleExcerpt = useSetAtom(toggleExcerptAtom)
  const id = React.useId()
  const key = checkpointExcerpt(checkpoint)
  const open = openExcerpt === key
  const lines = checkpoint.lines
  return (
    <li className="flex flex-col gap-[3px] border-t border-line-2 px-3 py-2.5 first:border-t-0">
      <p className="m-0 flex flex-wrap items-center justify-between gap-x-2.5 gap-y-1">
        <StateLabel proof={checkpoint.proof} className="leading-4" />
        {lines ? (
          <EvidencePin
            evidence={lines}
            excerptId={`${id}-excerpt`}
            open={open}
            onToggle={() => toggleExcerpt(key)}
            marker={lines.markerKey ? markers[lines.markerKey] : undefined}
            targetClassName="text-ink-muted"
          />
        ) : (
          <span className="font-mono text-[11px] leading-4 text-ink-muted">
            This unit as a whole
          </span>
        )}
      </p>
      <p className="m-0 text-[13px] leading-[19px] wrap-anywhere text-ink">
        {checkpoint.requirement}
      </p>
      {checkpoint.note && (
        <p className="m-0 text-[12px] leading-[17px] text-ink-muted">
          {checkpoint.note}
        </p>
      )}
      <Excerpt
        lines={open && lines?.excerpt?.length ? lines.excerpt : undefined}
        motionKey={key}
        id={`${id}-excerpt`}
      />
    </li>
  )
}

function CheckpointList({
  checkpoints,
  markers,
  labelledBy,
}: {
  checkpoints: ReadonlyArray<DeliveryCheckpoint>
  markers: Record<string, ContextualMarker>
  labelledBy: string
}) {
  return (
    <ol
      aria-labelledby={labelledBy}
      className="m-0 max-w-[720px] list-none rounded-[10px] bg-paper p-0 shadow-[inset_0_0_0_1px_var(--nv-line-2)]"
    >
      {checkpoints.map((checkpoint) => (
        <CheckpointItem
          key={checkpoint.number}
          checkpoint={checkpoint}
          markers={markers}
        />
      ))}
    </ol>
  )
}

/** Every checkpoint the card does not show under its item, by item. */
function otherCheckpoints(check: Pick<Check, "criteria" | "checkpoints">) {
  const groups = doneCriteria(check.criteria).flatMap((criterion) => {
    const rest = (criterion.checkpoints ?? []).filter((c) => !c.unmet)
    return rest.length === 0
      ? []
      : [{ id: criterion.id, title: criterion.criterion, checkpoints: rest }]
  })
  const unattached = check.checkpoints ?? []
  return unattached.length === 0
    ? groups
    : [
        ...groups,
        {
          id: "unattached",
          // "Above" only when the card shows items above it.
          title:
            doneCriteria(check.criteria).length > 0
              ? "Not tied to an item above"
              : "Not tied to a scope item",
          checkpoints: unattached,
        },
      ]
}

/** How many checkpoints sit under the items, all unmet. */
function shownUnmet(check: Pick<Check, "criteria">) {
  return doneCriteria(check.criteria).reduce(
    (sum, criterion) =>
      sum + (criterion.checkpoints ?? []).filter((c) => c.unmet).length,
    0
  )
}

/**
 * "2 unmet checkpoints" for the suggested review's line: every unmet
 * checkpoint of the unit, Records' rule. Undefined when none is.
 */
export function checkpointsUnmet(
  check: Pick<Check, "criteria" | "checkpoints">
): string | undefined {
  const count = [
    ...doneCriteria(check.criteria).flatMap((c) => c.checkpoints ?? []),
    ...(check.checkpoints ?? []),
  ].filter((checkpoint) => checkpoint.unmet).length
  if (count === 0) return undefined
  return `${count} unmet ${count === 1 ? "checkpoint" : "checkpoints"}`
}

const TALLY_WORD: Record<CheckpointProof, string> = {
  missing: "missing",
  "out-of-date": "out of date",
  conflicting: "conflicting",
  thin: "thin",
  proven: "proven",
}

/**
 * The card's foot (11.23): one count row for every checkpoint not shown
 * under its item, "3 other checkpoints · 1 thin · 2 proven", a native
 * disclosure that opens them grouped by item, with those that rest on no
 * item last. Hidden when there are none.
 */
function OtherCheckpoints({
  check,
  markers,
}: {
  check: Check
  markers: Record<string, ContextualMarker>
}) {
  const id = React.useId()
  const groups = otherCheckpoints(check)
  const all = groups.flatMap((group) => group.checkpoints)
  if (all.length === 0) return null
  const tally = PROOF_ORDER.flatMap((proof) => {
    const count = all.filter((c) => c.proof === proof).length
    return count === 0 ? [] : [{ proof, count }]
  })
  // "Other" only when checkpoints show under the items above.
  const noun = `${all.length === 1 ? "checkpoint" : "checkpoints"}`
  const label =
    shownUnmet(check) > 0
      ? `${all.length} other ${noun}`
      : `${all.length} ${noun}`
  return (
    <div
      {...blockProps()}
      data-checkpoints-foot=""
      className="border-t border-line-2 pt-1.5 pb-1"
    >
      <Disclosure
        className="-ml-2.5"
        summaryClassName="h-auto min-h-10 py-1.5"
        contentClassName="flex flex-col gap-1.5 pt-1 pr-0 pb-2"
        label={
          <span className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 whitespace-normal">
            <span>{label}</span>
            <span className="sr-only">, </span>
            <span className="inline-flex flex-wrap items-center">
              {tally.map(({ proof, count }, i) => {
                const style = FAMILY_STYLE[proofFamily(proof)]
                return (
                  <React.Fragment key={proof}>
                    {i > 0 && (
                      <>
                        <span
                          aria-hidden="true"
                          className="mx-1.5 text-ink-muted"
                        >
                          ·
                        </span>
                        <span className="sr-only">, </span>
                      </>
                    )}
                    <span
                      className={cn(
                        "inline-flex items-center gap-[5px] font-mono text-[11px] leading-4 whitespace-nowrap",
                        style.label
                      )}
                    >
                      <ProofIcon proof={proof} className={style.icon} />
                      {count} {TALLY_WORD[proof]}
                    </span>
                  </React.Fragment>
                )
              })}
            </span>
          </span>
        }
      >
        {groups.map((group) => (
          <React.Fragment key={group.id}>
            <h3
              id={`${id}-${group.id}`}
              className="m-0 pt-1 text-[12.5px] leading-[18px] font-semibold text-ink-2"
            >
              {group.title}
            </h3>
            <CheckpointList
              checkpoints={group.checkpoints}
              markers={markers}
              labelledBy={`${id}-${group.id}`}
            />
          </React.Fragment>
        ))}
      </Disclosure>
    </div>
  )
}

/** A suggested decision as its review mark says it. */
export const VERDICT_OF: Record<DeliverySuggestion["decision"], ReviewVerdict> =
  {
    request_changes: "changes_requested",
    approve: "approved",
  }

/**
 * The suggested disposition, shown to people as the "Suggested review"
 * (human-required only). It arrives last, after the reasons behind it.
 * Its state is the review mark (round 4.2): unsent, "Suggested · request
 * changes" in a dashed edge with no avatar (no provenance line); once the
 * reader sends it (directly or through the composer), "You requested
 * changes" with their avatar, and the message as sent. Undo makes it a
 * suggestion again. The card itself is plain: the mark carries the one
 * "not committed" edge. On a unit whose changes each say their own
 * suggestion on their rows, the agent's words are already there: the card
 * keeps its mark, and the line saying it was carried when it was, and
 * leaves the words out.
 */
function SuggestedDisposition({
  suggestion,
  conclusion,
  unmet,
  reviewer,
  saidOnRows,
}: {
  suggestion: DeliverySuggestion
  /** Computed from the rows (checkConclusion). */
  conclusion: string | undefined
  /** "2 unmet checkpoints" (checkpointsUnmet); the agent's words above stay as they are. */
  unmet: string | undefined
  reviewer: Reviewer | undefined
  /** The unit's rows say each change's suggestion in the agent's words. */
  saidOnRows: boolean
}) {
  const dock = useAtomValue(dockAtom)
  const origin = useAtomValue(dockOriginAtom)
  const draft = useAtomValue(draftAtom)
  const verdict = VERDICT_OF[suggestion.decision]
  const sent =
    origin === "suggestion" &&
    dock ===
      (suggestion.decision === "approve" ? "approved" : "changes-requested")
  // The reader's own words once they sent them. Before that, the carried
  // line, always, then the agent's words, unless the rows already say them.
  const message =
    sent && suggestion.decision === "request_changes" && draft.trim()
      ? draft
      : [suggestion.carried, saidOnRows ? undefined : suggestion.message]
          .filter((part) => part !== undefined)
          .join("\n\n")
  return (
    <section
      aria-label="Suggested review"
      data-sent={sent ? "" : undefined}
      {...blockProps()}
      className="mt-1 flex flex-col gap-2 rounded-xl bg-surface px-4 py-3.5 shadow-[0_0_0_1px_var(--nv-line)]"
    >
      <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1">
        {!sent ? (
          <ReviewMark sent={false} verdict={verdict} />
        ) : reviewer ? (
          <ReviewMark
            verdict={verdict}
            actor={{
              kind: "person",
              person: { name: reviewer.name, initials: reviewer.initials },
              isYou: true,
            }}
          />
        ) : (
          // The reader isn't known here: the words without an avatar.
          <span
            data-review-mark=""
            data-verdict={verdict}
            data-sent="true"
            className="inline-flex items-center gap-[7px] text-[13.5px] leading-5 text-ink"
          >
            <VerdictIcon verdict={verdict} />
            <span>
              <b className="font-semibold">You</b>{" "}
              {verdict === "approved" ? "approved" : "requested changes"}
            </span>
          </span>
        )}
        {conclusion && (
          <span className="text-[13.5px] text-ink-2">· {conclusion}</span>
        )}
        {unmet && <span className="text-[13.5px] text-ink-2">· {unmet}</span>}
      </p>
      {message && (
        <p className="m-0 text-[13.5px] leading-5 whitespace-pre-line text-ink-2">
          {message}
        </p>
      )}
    </section>
  )
}

/**
 * Human-suggested units whose agent recorded a review (Option A, round 4.2):
 * the briefing's review card is the one place that review is said, and at
 * Guided it carries the ticket's rows behind "Why". The Guided layer adds no
 * card of its own for them.
 */
export function reviewCardCarriesCheck(unit: ReviewDeskData["unit"]): boolean {
  const outcome = unit.attribution?.outcome
  return (
    unit.lane === "human-suggested" &&
    (outcome === "approved" || outcome === "changes-requested")
  )
}

/**
 * A gathered scope with no ticket, doc, recorded decision or earlier review
 * linked to the change (round-4.md, "Scope is always gathered", step 3;
 * decided 2026-10-14). The harness reports it; the desk never infers it
 * from the rows, and no other basis shows it.
 */
export function showsUnlinked(check: Pick<Check, "basis" | "unlinked">) {
  return basisOf(check) === "gathered" && check.unlinked === true
}

/** The approved line, everywhere but the agent's review card. */
const UNLINKED =
  "No ticket or doc is linked to this change, so this briefing and any suggested review come from the code and its history alone."

/**
 * Inside the agent's review card (user, 2026-10-14): the review the line
 * speaks of is named, and links to its review line.
 */
const UNLINKED_REVIEW = {
  before: "No ticket or doc is linked to this change, so this briefing and ",
  link: "the agent’s review",
  after: " come from the code and its history alone.",
} as const

/**
 * The agent's review card passes this to its rows: the reviewer's short
 * name (for the link's accessible name) and the jump to the review line.
 */
export interface ReviewLink {
  /** "R1": absent when no reviewer is recorded. */
  reviewer: string | undefined
  onGo: () => void
}

/** Inline, in the sentence: ink with an underline; the ring on focus. */
export const REVIEW_LINK =
  "cursor-pointer rounded-[3px] text-ink underline decoration-ink-muted underline-offset-[3px] transition-colors duration-surface-tone ease-standard hover:decoration-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus focus-visible:outline-solid motion-reduce:transition-none"

/**
 * The check's heading: "Done when" (or "Scope" when the ticket has no
 * "Done when"), then the ticket's title. The id is secondary: ids are
 * opaque to people. An unlinked gathered scope says so under its intent;
 * in the agent's review card, the line names that review and links to it.
 */
function CheckHeading({
  check,
  review,
}: {
  check: Check
  review: ReviewLink | undefined
}) {
  return (
    <div {...blockProps()} className="flex flex-col gap-1 pt-3.5 pb-2">
      <h2 className="m-0 label-mono text-ink-muted">
        {BASIS[basisOf(check)].heading}
      </h2>
      <p className="m-0 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-[15px] font-semibold">{check.ticket.title}</span>
        {/* A gathered scope has no ticket, so no id. */}
        {check.ticket.id && (
          <span className="font-mono text-[11.5px] text-ink-muted">
            {check.ticket.id}
          </span>
        )}
      </p>
      {showsUnlinked(check) && (
        <p
          data-unlinked=""
          className="m-0 max-w-[720px] text-[13.5px] leading-5 text-pretty text-ink-muted"
        >
          {review ? (
            <>
              {UNLINKED_REVIEW.before}
              <button
                type="button"
                onClick={review.onGo}
                className={REVIEW_LINK}
              >
                {UNLINKED_REVIEW.link}
                <span className="sr-only">
                  {review.reviewer
                    ? ` (${review.reviewer}, go to review)`
                    : " (go to review)"}
                </span>
              </button>
              {UNLINKED_REVIEW.after}
            </>
          ) : (
            UNLINKED
          )}
        </p>
      )}
    </div>
  )
}

/** The ticket's rows, then the blast radius rows under their own heading. */
export function CheckRows({
  check,
  markers,
  review,
}: {
  check: Check
  markers: Record<string, ContextualMarker>
  /** Only from the agent's review card: the line links to its review. */
  review?: ReviewLink
}) {
  const basis = basisOf(check)
  const done = doneCriteria(check.criteria)
  const radius = check.criteria.filter(
    (criterion) => criterion.status === "outside"
  )
  return (
    <>
      <CheckHeading check={check} review={review} />
      <ol className="m-0 list-none p-0">
        {done.map((criterion) => (
          <CriterionRow
            key={criterion.id}
            criterion={criterion}
            basis={basis}
            markers={markers}
          />
        ))}
      </ol>
      {radius.length > 0 && (
        <>
          <h3
            {...blockProps("radius")}
            className="m-0 border-t border-line-2 pt-4 pb-0.5 label-mono text-ink-muted"
          >
            Blast radius
          </h3>
          <ul className="m-0 list-none p-0">
            {radius.map((criterion) => (
              <CriterionRow
                key={criterion.id}
                criterion={criterion}
                basis={basis}
                markers={markers}
                group="radius"
              />
            ))}
          </ul>
        </>
      )}
      <OtherCheckpoints check={check} markers={markers} />
    </>
  )
}

/**
 * Guided: the change checked against its ticket. "Done when" over the
 * ticket's title, one row per thing the ticket asks for (Done, Not done, No
 * evidence), then the blast radius rows the margin found beyond the ticket,
 * without a status. Each row says what the change does and cites its
 * evidence as marker pins. Per lane: human-required ends in the suggested
 * review; human-suggested is an FYI led by the agent's review; agentic and
 * static show the rows as reasons only.
 */
export function CriteriaCard({
  check,
  unit,
  markers,
  reviewer,
}: {
  check: Check
  unit: ReviewDeskData["unit"]
  markers: Record<string, ContextualMarker>
  /** The reader, for the sent review's avatar; without it, no avatar. */
  reviewer?: Reviewer
}) {
  if (reviewCardCarriesCheck(unit)) return null
  const suggestion =
    unit.lane === "human-required" && check.criteria.length > 0
      ? check.suggestion
      : undefined
  return (
    <section
      aria-label={checkHeading(check)}
      className="flex flex-col rounded-xl bg-surface px-5 pt-1.5 pb-[18px] shadow-[0_0_0_1px_var(--nv-line)]"
    >
      <div className="flex flex-col">
        <CheckRows check={check} markers={markers} />
      </div>
      {suggestion && (
        <SuggestedDisposition
          suggestion={suggestion}
          conclusion={checkConclusion(check)}
          unmet={checkpointsUnmet(check)}
          reviewer={reviewer}
          saidOnRows={!!unit.sections?.some((section) => section.suggestion)}
        />
      )}
    </section>
  )
}
