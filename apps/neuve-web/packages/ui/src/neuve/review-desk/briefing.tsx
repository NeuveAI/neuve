import * as React from "react"
import { useAtomValue, useSetAtom } from "jotai"
import { AnimatePresence, motion } from "motion/react"
import {
  ChevronDownIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CornerDownRightIcon,
  InfoIcon,
} from "lucide-react"

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"
import {
  LANE_NAME,
  MovedUpMark,
  NO_AGENT_DECISION,
  excludedWords,
  movedUpLabel,
} from "@workspace/ui/neuve/shared/lane-facts"
import {
  REVIEW_LANDING,
  blockFade,
  revealProps,
  useDeliveryMotion,
  useReaderMotion,
} from "@workspace/ui/neuve/review-desk/delivery/delivery-motion"
import {
  morphTransition,
  timeToReach,
  usePhased,
} from "@workspace/ui/neuve/review-desk/delivery/delivery-choreography"
import {
  PhasedLayer,
  blockProps,
} from "@workspace/ui/neuve/review-desk/delivery/phased-layer"
import {
  BeforeAfter,
  BeforeAfterHeader,
  ExplainedTerms,
  uniqueTerms,
} from "@workspace/ui/neuve/review-desk/delivery/explained-prose"
import {
  briefingClaims,
  briefingPhrases,
  explainedLinks,
} from "@workspace/ui/neuve/review-desk/briefing-claims"
import {
  briefingKind,
  notesApart,
  rowedAt,
  strandedSections,
  undecidedRow,
} from "@workspace/ui/neuve/review-desk/briefing-rows"
import {
  clearReviewLandingAtom,
  landOnReviewAtom,
  provenanceOpenAtom,
  reviewArrivedAtom,
  reviewLandingAtom,
  setProvenanceOpenAtom,
  toggleWhyAtom,
  whyOpenAtom,
} from "@workspace/ui/neuve/review-desk/delivery/delivery-state"
import {
  CheckRows,
  REVIEW_LINK,
  VERDICT_OF,
  checkConclusion,
  reviewCardCarriesCheck,
} from "@workspace/ui/neuve/review-desk/delivery/criteria-card"
import type {
  Check,
  ReviewLink,
} from "@workspace/ui/neuve/review-desk/delivery/criteria-card"
import {
  ReviewActorAvatar,
  ReviewMark,
  VerdictIcon,
  reviewActorShort,
} from "@workspace/ui/neuve/shared/review-mark"
import type { ReviewVerdict } from "@workspace/ui/neuve/shared/review-mark"

import {
  sentenceParts,
  spaceBeforeChip,
} from "@workspace/ui/neuve/shared/briefing-paragraphs"
import { LaneGlyph } from "@workspace/ui/neuve/shared/lane-glyph"
import {
  DigestFeedback,
  UnitFeedback,
} from "@workspace/ui/neuve/review-desk/feedback/feedback-controls"
import {
  CitationChip,
  MARKER_KINDS,
  MarkerKindIcon,
  markerKind,
} from "@workspace/ui/neuve/shared/marker-kind"
import type { MarkerKind } from "@workspace/ui/neuve/shared/marker-kind"
import {
  closeCardAtom,
  closeSheetAtom,
  openCitationAtom,
  openSheetAtom,
} from "@workspace/ui/neuve/review-desk/atoms"
import {
  markerLines,
  markerPinSelector,
} from "@workspace/ui/neuve/review-desk/context-margin"
import {
  landOnAtom,
  litLinesAtom,
} from "@workspace/ui/neuve/review-desk/landing"
import type { LandingTarget } from "@workspace/ui/neuve/review-desk/landing"
import { closeLineAtom } from "@workspace/ui/neuve/review-desk/marker-atoms"
import {
  afterPendingScrolls,
  scrollParent,
  whenScrollSettles,
} from "@workspace/ui/neuve/review-desk/scroll-arrival"
import { linesName } from "@workspace/ui/neuve/citation-name"
import {
  CheckpointBriefing,
  PROOF_LABEL,
  ProofIcon,
  checkpointEntries,
  isCheckpoint,
  proofFamily,
  proofOf,
} from "@workspace/ui/neuve/review-desk/checkpoint-parts"
import type {
  BriefingPhraseTarget,
  BriefingSection,
  BriefingSegment,
  ContextualMarker,
  DiffFile,
  EarlierDecision,
  ExplainedText,
  LineRange,
  ReviewDeskData,
  ReviewLane,
  UnitAttribution,
  UnitExclusion,
  UnitLevelComment,
} from "@workspace/ui/neuve/types"

/** The head line's words per lane; no surface shows a pending state per unit. */
const LANE_HEADING: Record<ReviewLane, { text: string; className: string }> = {
  "human-required": {
    text: LANE_NAME["human-required"],
    className: "text-req-fg",
  },
  "human-suggested": {
    text: `${LANE_NAME["human-suggested"]} · optional`,
    className: "text-sug-fg",
  },
  "agentic-review": {
    text: LANE_NAME["agentic-review"],
    className: "text-agt-fg",
  },
  "static-automation": {
    text: LANE_NAME["static-automation"],
    className: "text-ink-2",
  },
}

const VERDICT: Record<"approved" | "changes-requested", ReviewVerdict> = {
  approved: "approved",
  "changes-requested": "changes_requested",
}

const WHY_BUTTON =
  "ml-auto inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[7px] border-0 bg-transparent px-2.5 text-[12.5px] text-ink-2 shadow-[inset_0_0_0_1px_var(--nv-line)] transition-colors duration-surface-tone ease-standard hover:bg-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus motion-reduce:transition-none"

/**
 * Is the whole element inside its scroller's view, clear of the scroll
 * padding (the dock below)? Then a jump to it doesn't scroll.
 */
function fullyVisible(element: HTMLElement) {
  const scroller = scrollParent(element)
  const view = scroller
    ? scroller.getBoundingClientRect()
    : { top: 0, bottom: window.innerHeight }
  const padding = getComputedStyle(scroller ?? document.documentElement)
  const box = element.getBoundingClientRect()
  return (
    box.top >= view.top + (parseFloat(padding.scrollPaddingTop) || 0) &&
    box.bottom <= view.bottom - (parseFloat(padding.scrollPaddingBottom) || 0)
  )
}

/** Calls `act` once on the next pointer or key press anywhere; a canceller. */
function onNextAction(act: () => void) {
  const options = { once: true, capture: true } as const
  const done = () => {
    cancel()
    act()
  }
  document.addEventListener("pointerdown", done, options)
  document.addEventListener("keydown", done, options)
  function cancel() {
    document.removeEventListener("pointerdown", done, options)
    document.removeEventListener("keydown", done, options)
  }
  return cancel
}

/**
 * The jump to the review line: "the agent's review" behind "Why", and a
 * briefing phrase that describes the recorded review. Briefing owns it so
 * both lead to the same line; the review card renders that line.
 */
function useReviewJump(unitId: string) {
  const readerMode = useReaderMotion()
  const landOnReview = useSetAtom(landOnReviewAtom)
  const reviewArrived = useSetAtom(reviewArrivedAtom)
  const clearLanding = useSetAtom(clearReviewLandingAtom)
  const setProvenanceOpen = useSetAtom(setProvenanceOpenAtom)
  const lineRef = React.useRef<HTMLDivElement | null>(null)
  const markRef = React.useRef<HTMLButtonElement>(null)
  const cancelJump = React.useRef<(() => void) | undefined>(undefined)
  const jumpNonce = React.useRef<number | undefined>(undefined)
  // The line owns its jump: unmounting (another unit) cancels the pending
  // arrival and ends the tint, so coming back never replays it. A ref
  // callback, so no effect is needed.
  const lineCallback = React.useCallback(
    (element: HTMLDivElement | null) => {
      lineRef.current = element
      return () => {
        cancelJump.current?.()
        cancelJump.current = undefined
        if (jumpNonce.current !== undefined) clearLanding(jumpNonce.current)
        lineRef.current = null
      }
    },
    [clearLanding]
  )
  const go = () => {
    const line = lineRef.current
    if (!line) return
    cancelJump.current?.()
    const reduced = readerMode === "reduced"
    const nonce = landOnReview({ unitId, reduced })
    jumpNonce.current = nonce
    const arrive = () => {
      // The card now shows another unit (a host that swaps the unit
      // without remounting): this jump is stale, never land on its mark.
      if (line.dataset.unitId !== unitId) return clearLanding(nonce)
      reviewArrived(nonce)
      // Only once arrived: the tooltip closes when its trigger scrolls.
      // Focus lands on the mark, then the provenance is opened
      // explicitly: the press on the link has already dismissed it
      // (pointer-down outside, then the trigger's blur), and those
      // closes were reported before this click handler or scroll end ran.
      const target = markRef.current ?? line
      target.focus({ preventScroll: true })
      if (markRef.current) setProvenanceOpen({ unitId, open: true })
      cancelJump.current = reduced
        ? onNextAction(() => clearLanding(nonce))
        : undefined
    }
    // The jump starts on the next frame, as a diff landing does: the
    // press's own scroll (focusing a link behind the dock) is reported
    // then. Reported after the provenance opened, it would close it; after
    // a smooth scroll began, its scrollend would pass for the arrival.
    cancelJump.current = afterPendingScrolls(() => {
      if (fullyVisible(line)) return arrive()
      line.scrollIntoView({
        block: "start",
        behavior: reduced ? "auto" : "smooth",
      })
      cancelJump.current = whenScrollSettles(line, arrive)
    })
  }
  return { lineCallback, markRef, go }
}

type ReviewJump = ReturnType<typeof useReviewJump>

/**
 * The one review card (Option A, round 4.2; Verdicts.dc.html): the review
 * mark (the agent's avatar, the verdict icon, "R1 approved"), then the
 * agent's reason and its evidence. Provenance ("R1 · reviewer agent ·
 * agentic review · a3f9c2e") is a tooltip on the avatar, never a
 * subheading. On a human-suggested unit at Guided the card also carries the
 * ticket's rows behind "Why · n of m not done"; the Guided layer adds no
 * other card, so the review is said once in the column.
 *
 * The review line (the mark and the reason) is where an unlinked gathered
 * scope's "the agent's review" leads: it scrolls into view (unless already
 * fully visible), focus lands on the mark so its provenance shows, and the
 * line tints like a diff landing (delivery-motion.ts storyboard).
 */
function ReviewCard({
  unit,
  attribution,
  markers,
  guidedCheck,
  jump,
}: {
  unit: ReviewDeskData["unit"]
  attribution: UnitAttribution & { outcome: "approved" | "changes-requested" }
  markers: Record<string, ContextualMarker>
  /** The Guided check, present only while the unit is at Guided. */
  guidedCheck: Check | undefined
  jump: ReviewJump
}) {
  const mode = useDeliveryMotion()
  const readerMode = useReaderMotion()
  const phased = usePhased()
  // "Why" comes and goes with Guided like a block: in from the arrivals' start.
  const why = blockFade(
    mode,
    timeToReach(morphTransition(phased.morph), phased.contentStart)
  )
  const open = useAtomValue(whyOpenAtom)[unit.id] ?? false
  const toggleWhy = useSetAtom(toggleWhyAtom)
  const id = React.useId()
  const verdict = VERDICT[attribution.outcome]
  const reviewer = attribution.reviewer
  const check = reviewCardCarriesCheck(unit) ? guidedCheck : undefined
  const conclusion = check ? checkConclusion(check) : undefined
  const landing = useAtomValue(reviewLandingAtom)
  const clearLanding = useSetAtom(clearReviewLandingAtom)
  const provenanceOpen = useAtomValue(provenanceOpenAtom)[unit.id] ?? false
  const setProvenanceOpen = useSetAtom(setProvenanceOpenAtom)
  const landed = landing?.unitId === unit.id ? landing : undefined
  const review: ReviewLink = { reviewer: reviewer?.short, onGo: jump.go }
  // A person's decision stands on the unit: their review, in the agent's place.
  const person = attribution.person
  return (
    <section
      aria-label={person ? "The review" : "The agent’s review"}
      className="flex flex-col gap-2 rounded-xl bg-surface px-4 py-3.5 shadow-[0_0_0_1px_var(--nv-line)]"
    >
      {/* The review line: what "the agent's review" leads to. It lands
      60px down, as a diff landing does: room for the provenance tooltip
      above the mark. */}
      <div
        ref={jump.lineCallback}
        data-review-line=""
        data-unit-id={unit.id}
        data-landed={landed?.tint}
        data-arrived={landed?.arrived ? "" : undefined}
        // The focus target only when there is no mark to focus.
        tabIndex={reviewer || person ? undefined : -1}
        className="relative isolate flex scroll-mt-15 flex-col gap-2 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus focus-visible:outline-solid"
      >
        {landed?.arrived && (
          <motion.span
            key={landed.nonce}
            aria-hidden="true"
            className="pointer-events-none absolute -inset-x-2 -inset-y-1.5 -z-10 rounded-lg bg-land"
            initial={{ opacity: 1 }}
            animate={{
              opacity: landed.tint === "fade" ? REVIEW_LANDING.opacity : 1,
            }}
            transition={
              landed.tint === "fade" ? REVIEW_LANDING.fade : { duration: 0 }
            }
            onAnimationComplete={() => {
              if (landed.tint === "fade") clearLanding(landed.nonce)
            }}
          />
        )}
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
          {person ? (
            <ReviewMark
              verdict={verdict}
              actor={person.actor}
              provenance={attribution.meta}
              {...(person.carried ? { carried: person.carried } : {})}
              triggerRef={jump.markRef}
              provenanceOpen={provenanceOpen}
              onProvenanceOpenChange={(shown) =>
                setProvenanceOpen({ unitId: unit.id, open: shown })
              }
            />
          ) : reviewer ? (
            <ReviewMark
              verdict={verdict}
              actor={{ kind: "agent", agent: reviewer }}
              provenance={`${reviewer.short} · ${reviewer.role} agent · ${attribution.meta}`}
              triggerRef={jump.markRef}
              provenanceOpen={provenanceOpen}
              onProvenanceOpenChange={(shown) =>
                setProvenanceOpen({ unitId: unit.id, open: shown })
              }
            />
          ) : (
            // No recorded reviewer: the recorded words, never an invented actor.
            <span className="inline-flex items-center gap-[7px] text-[13.5px] leading-5 font-semibold text-ink">
              <VerdictIcon verdict={verdict} />
              {attribution.headline}
            </span>
          )}
          <AnimatePresence initial={false}>
            {check && (
              <motion.span
                key="why"
                className="ml-auto"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1, transition: why.in }}
                exit={{ opacity: 0, transition: why.out }}
              >
                <button
                  type="button"
                  aria-expanded={open}
                  aria-controls={id}
                  onClick={() => toggleWhy(unit.id)}
                  className={WHY_BUTTON}
                >
                  Why{conclusion && ` · ${conclusion}`}
                  <ChevronDownIcon
                    aria-hidden="true"
                    className={cn(
                      "size-3.5 transition-transform duration-chevron ease-standard motion-reduce:transition-none",
                      open && "rotate-180"
                    )}
                  />
                </button>
              </motion.span>
            )}
          </AnimatePresence>
        </div>
        {attribution.summary && (
          <p className="m-0 text-[13.5px] leading-5 text-ink-2">
            {attribution.summary}
          </p>
        )}
      </div>
      {attribution.evidence && (
        <span className="flex flex-wrap gap-1.5">
          {attribution.evidence.map((item) => (
            <span
              key={item}
              className="rounded-[5px] bg-raised px-[7px] py-px font-mono text-[11px] text-ink-2"
            >
              {item}
            </span>
          ))}
        </span>
      )}
      {attribution.waiting && (
        <span className="flex items-center gap-2 text-[12.5px] text-ink-muted">
          <span className="size-2 rounded-full bg-brand" />
          {attribution.waiting}
        </span>
      )}
      <div id={id}>
        <AnimatePresence initial={false}>
          {check && open && (
            <motion.div
              key="why"
              {...revealProps(readerMode)}
              className="mt-1 flex flex-col border-t border-line-2"
            >
              <CheckRows check={check} markers={markers} review={review} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  )
}

/**
 * Who decided a unit outside the human-required lane, and how: the agent's
 * review card, or the checks that passed (Lanes.dc.html).
 */
function Attribution({
  unit,
  attribution,
  markers,
  guidedCheck,
  reviewJump,
}: {
  unit: ReviewDeskData["unit"]
  attribution: UnitAttribution
  markers: Record<string, ContextualMarker>
  guidedCheck: Check | undefined
  reviewJump: ReviewJump
}) {
  const outcome = attribution.outcome
  return (
    <div className="flex flex-col gap-[18px] pt-1.5">
      {outcome !== "passed" && (
        <ReviewCard
          unit={unit}
          attribution={{ ...attribution, outcome }}
          markers={markers}
          guidedCheck={guidedCheck}
          jump={reviewJump}
        />
      )}
      {attribution.checks && (
        <ul className="m-0 flex list-none flex-col rounded-xl bg-surface p-0 shadow-[0_0_0_1px_var(--nv-line)]">
          {attribution.checks.map((check, i) => {
            const Icon =
              check.tone === "passed"
                ? CircleCheckIcon
                : check.tone === "blocking"
                  ? CircleAlertIcon
                  : InfoIcon
            return (
              <li
                key={check.title}
                className={cn(
                  "grid grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-2.5 px-3.5 py-[11px]",
                  i > 0 && "border-t border-line-2"
                )}
              >
                <Icon
                  aria-hidden="true"
                  strokeWidth={1.75}
                  className={cn(
                    "size-[15px]",
                    check.tone === "passed" && "text-agt",
                    check.tone === "blocking" && "text-req",
                    check.tone === "note" && "text-ink-muted"
                  )}
                />
                <span className="flex flex-col gap-0.5">
                  <span className="text-[13.5px]">{check.title}</span>
                  {check.detail && (
                    <span className="font-mono text-[11px] text-ink-muted">
                      {check.detail}
                    </span>
                  )}
                </span>
                <span
                  className={cn(
                    "font-mono text-[11px]",
                    check.tone === "blocking" ? "text-req-fg" : "text-ink-muted"
                  )}
                >
                  {check.meta}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/**
 * A native check's status icon follows its marker kind when the marker is
 * known (a failed or unusable check is amber, like its pin); otherwise the
 * recorded check tone.
 */
function NativeCheckIcon({
  kind,
  tone,
}: {
  kind: MarkerKind | undefined
  tone: "blocking" | "note" | "passed"
}) {
  if (kind === "failed" || kind === "unavailable")
    return (
      <MarkerKindIcon
        kind={kind}
        strokeWidth={1.75}
        className="size-[15px] text-sug"
      />
    )
  if (kind === "test" || tone === "passed")
    return (
      <CircleCheckIcon aria-hidden="true" className="size-[15px] text-agt" />
    )
  if (tone === "blocking")
    return (
      <CircleAlertIcon aria-hidden="true" className="size-[15px] text-req" />
    )
  return <InfoIcon aria-hidden="true" className="size-[15px] text-ink-muted" />
}

/** Where a cited marker sits in the diff: its file and the lines it is about. */
function landingFor(
  unitId: string,
  files: ReadonlyArray<DiffFile>,
  markerKey: string
): Omit<LandingTarget, "nonce"> | undefined {
  for (const file of files) {
    const anchor = file.markerAnchors.find((a) => a.markerKey === markerKey)
    if (anchor)
      return { unitId, filePath: file.path, range: markerLines(anchor) }
  }
  return undefined
}

/** Briefing text: phrases and chips sit inline in it. */
const PROSE = "m-0 text-[15px] leading-[22px] text-ink-2 text-pretty"

/**
 * Said where an agent's briefing would begin when no agent decided the unit
 * (or one change of a joined unit) in this run: the plain line, muted, no
 * icon, no colour, no tooltip. Under it, why, when the agent said. Led by
 * its change's title in the header, when that change's row isn't drawn.
 */
function NoAgentDecision({
  title,
  notes = [],
}: {
  /** The change it is said of, away from its row. */
  title?: string | undefined
  /** Why no agent could decide it: one sentence, or a list of them. */
  notes?: ReadonlyArray<string> | undefined
}) {
  const line = (
    <p className={UNDECIDED_LINE}>
      {title === undefined
        ? NO_AGENT_DECISION
        : `${title}: ${NO_AGENT_DECISION}`}
    </p>
  )
  if (notes.length === 0) return line
  return (
    <div className="flex flex-col gap-0.5">
      {line}
      <UndecidedNotes notes={notes} />
    </div>
  )
}

/** "No agent decision" and the notes under it: secondary text, one size. */
const UNDECIDED_LINE =
  "m-0 max-w-[760px] text-[14px] leading-[22px] text-ink-muted text-pretty"

/** Why no agent could decide: one note is a sentence, several a plain list. */
function UndecidedNotes({ notes }: { notes: ReadonlyArray<string> }) {
  return notes.length === 1 ? (
    <p data-undecided-note="" className={UNDECIDED_LINE}>
      {notes[0]}
    </p>
  ) : (
    <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
      {notes.map((note, i) => (
        <li key={i} data-undecided-note="" className={UNDECIDED_LINE}>
          {note}
        </li>
      ))}
    </ul>
  )
}

/**
 * What an agent suggests for one change it decided, on a human-required
 * unit of several: the Guided card's unsent mark ("Suggested · approve"),
 * and under it the agent's words for that change. It sits where an
 * undecided change says "No agent decision", at every stop. Led by its
 * change's title in the header, when that change's row isn't drawn.
 */
function SectionSuggestion({
  decision,
  title,
  children,
}: {
  decision: NonNullable<BriefingSection["suggestion"]>["decision"]
  /** The change it is said of, away from its row. */
  title?: string | undefined
  /** The agent's words for the change. */
  children: React.ReactNode
}) {
  return (
    <div data-section-suggestion={decision} className="flex flex-col gap-1.5">
      <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1">
        {title !== undefined && (
          <span className="text-[14px] leading-[22px] text-ink-muted">
            {title}:
          </span>
        )}
        <ReviewMark sent={false} verdict={VERDICT_OF[decision]} />
      </p>
      <p className="m-0 max-w-[760px] text-[13.5px] leading-5 text-pretty text-ink-2">
        {children}
      </p>
    </div>
  )
}

/**
 * A unit no agent read (a lockfile or a generated file): the plain state
 * where an agent's briefing would begin, and under it the rule that marked
 * it, quiet. Facts (written by code) and the diff stay as they are.
 */
function NotRead({ excluded }: { excluded: UnitExclusion }) {
  const words = excludedWords(excluded)
  return (
    <div data-not-read="" className="flex flex-col gap-0.5">
      <p className="m-0 text-[14px] leading-[22px] text-ink-2">{words.state}</p>
      <p className="m-0 text-[12.5px] leading-[18px] text-ink-muted">
        {words.rule}
      </p>
    </div>
  )
}

/**
 * A person's decision on an earlier version of this changed unit, one quiet
 * line each: who, the verdict, and the earlier review. It closes nothing.
 */
function EarlierDecisions({
  decisions,
}: {
  decisions: ReadonlyArray<EarlierDecision>
}) {
  return (
    <ul
      aria-label="Decisions on earlier versions"
      className="m-0 flex list-none flex-col gap-1 p-0"
    >
      {decisions.map((decision) => (
        <li
          key={`${decision.actor.person.id}:${decision.verdict}:${decision.review}`}
          data-earlier-decision=""
          className="flex flex-wrap items-center gap-x-[7px] text-[13px] leading-5 text-ink-muted"
        >
          <VerdictIcon verdict={decision.verdict} />
          <span>
            {reviewActorShort(decision.actor)}{" "}
            {decision.verdict === "approved"
              ? "approved"
              : "requested changes on"}{" "}
            an earlier version
          </span>
          <span aria-hidden="true">·</span>
          <span className="font-mono text-[11.5px]">{decision.review}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * Comments that name no lines: on the whole unit under its briefing, or on
 * one change's row. Each says its author, the review mark of a request for
 * changes that rests on it, and the earlier review it was carried from.
 */
function WholeComments({
  comments,
  label,
}: {
  comments: ReadonlyArray<UnitLevelComment>
  label: string
}) {
  return (
    <ul aria-label={label} className="m-0 flex list-none flex-col gap-2.5 p-0">
      {comments.map((comment) => (
        <li
          key={comment.id}
          data-unit-comment={comment.id}
          className="flex max-w-[760px] flex-col gap-1"
        >
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {/* The author, and the review mark of a request that rests on
            the comment: its avatar and icon, its words for screen readers
            (the review card above says them). */}
            <span className="inline-flex items-center gap-[7px] text-[13px] leading-5 font-semibold text-ink">
              {comment.verdict ? (
                <ReviewMark
                  compact
                  size={16}
                  verdict={comment.verdict}
                  actor={comment.author}
                  {...(comment.carried ? { carried: comment.carried } : {})}
                />
              ) : (
                <ReviewActorAvatar actor={comment.author} size={16} />
              )}
              <span aria-hidden={comment.verdict ? true : undefined}>
                {reviewActorShort(comment.author)}
              </span>
            </span>
            {comment.carried && (
              <span className="font-mono text-[11px] text-ink-muted">
                {!comment.verdict && (
                  <span className="sr-only">Carried · </span>
                )}
                {comment.carried}
              </span>
            )}
          </span>
          <p className="m-0 text-[14px] leading-[21px] text-pretty whitespace-pre-line text-ink-2">
            {comment.body}
          </p>
        </li>
      ))}
    </ul>
  )
}

/**
 * The raised mark in the unit's head line, beside the lane name: focusable,
 * so its words show as a tooltip on keyboard focus as on pointer hover.
 */
function HeadRaisedMark({ from }: { from: ReviewLane }) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            role="img"
            aria-label={movedUpLabel(from)}
            className="-m-1 inline-flex rounded-sm p-1 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus"
          >
            <MovedUpMark from={from} named={false} />
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="start">
          {movedUpLabel(from)}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/**
 * A joined unit's change: its title beside what the stop says of it, at
 * desk width; stacked in a narrow briefing (a container query).
 */
const ROW =
  "grid grid-cols-1 gap-y-1.5 @min-[40rem]:grid-cols-[minmax(0,224px)_minmax(0,1fr)] @min-[40rem]:gap-x-8"

/** A phrase link reads as the review link does, and each wrapped piece keeps its ring. */
const PHRASE_LINK = cn(REVIEW_LINK, "box-decoration-clone")

/**
 * Where a phrase leads, or undefined when this view has nothing to land on
 * (the phrase then reads as plain text, never as a dead link): its href,
 * the destination said to screen readers, and the lines it lights.
 */
function phraseDestination(
  target: BriefingPhraseTarget,
  unitId: string,
  files: ReadonlyArray<DiffFile> | undefined,
  markers: Record<string, ContextualMarker>,
  hasReview: boolean
):
  | {
      href: string
      where: string
      lit?: { filePath: string; range: LineRange }
    }
  | undefined {
  // Without files (an embedding that does not pass them) a landing is still
  // requested; the landing contract drops it when nobody renders the file.
  const rendered = (filePath: string) =>
    files === undefined || files.some((file) => file.path === filePath)
  switch (target.kind) {
    case "lines": {
      if (!rendered(target.filePath)) return undefined
      const { start, end } = target.range
      return {
        href: `#${encodeURIComponent(target.filePath)}:${start === end ? start : `${start}-${end}`}`,
        where: linesName(target.range),
        lit: { filePath: target.filePath, range: target.range },
      }
    }
    case "file":
      if (!rendered(target.filePath)) return undefined
      return {
        href: `#${encodeURIComponent(target.filePath)}`,
        where: target.filePath,
      }
    case "marker": {
      const landing = landingFor(unitId, files ?? [], target.markerKey)
      const marker = markers[target.markerKey]
      if (!landing && !marker) return undefined
      const kind = marker ? MARKER_KINDS[markerKind(marker)].label : undefined
      const where = [kind, landing?.range && linesName(landing.range)]
        .filter(Boolean)
        .join(", ")
      return {
        href: `#${encodeURIComponent(target.markerKey)}`,
        where,
        lit: landing?.range && {
          filePath: landing.filePath,
          range: landing.range,
        },
      }
    }
    case "review":
      return hasReview
        ? { href: "#review", where: "the agent’s review" }
        : undefined
    case "unit":
      // Only the batch digest links units; a unit's briefing never does.
      return undefined
  }
}

/**
 * A phrase of the briefing that describes part of the change, linked to it
 * (round 5, option B). An anchor rather than a button: a phrase is
 * navigation to a place on this screen (link semantics, activated with
 * Enter), and an inline anchor wraps with the sentence where a button would
 * not. Activation is handled in place and the browser does not navigate;
 * a modified click is left to the browser. Real hover or keyboard focus
 * lights the lines it describes, as a pointed-at marker pin does.
 */
function BriefingPhrase({
  text,
  destination,
  unitId,
  onActivate,
}: {
  text: string
  destination: NonNullable<ReturnType<typeof phraseDestination>>
  unitId: string
  onActivate: (element: HTMLElement) => void
}) {
  const lights = useLightsLines(unitId, destination.lit)
  return (
    <a
      {...lights}
      href={destination.href}
      data-phrase-link=""
      data-briefing-link=""
      className={PHRASE_LINK}
      onClick={(event) => {
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return
        event.preventDefault()
        onActivate(event.currentTarget)
      }}
    >
      {text}
      <span className="sr-only"> ({destination.where})</span>
    </a>
  )
}

/**
 * Real hover or keyboard focus on a briefing reference (a phrase or a
 * citation chip) lights the lines it describes, as a pointed-at marker pin
 * does (round 5b: one treatment for every entry point). Leaving, blur or
 * unmount puts them out.
 */
function useLightsLines(
  unitId: string,
  lit: { filePath: string; range: LineRange } | undefined
) {
  const owner = React.useId()
  const setLit = useSetAtom(litLinesAtom)
  const light = () => {
    if (lit) setLit({ unitId, ...lit, phrase: owner })
  }
  const unlight = React.useCallback(
    () => setLit((current) => (current?.phrase === owner ? null : current)),
    [setLit, owner]
  )
  // A ref callback, so no effect is needed: a reference that unmounts while
  // pointed at (the Facts crossfade, another unit) puts its lines out.
  const ref = React.useCallback(
    (element: HTMLElement | null) => {
      if (!element) return
      return unlight
    },
    [unlight]
  )
  return {
    ref,
    onPointerEnter: (event: React.PointerEvent) => {
      if (event.pointerType === "mouse") light()
    },
    onPointerLeave: unlight,
    onFocus: (event: React.FocusEvent) => {
      // Focus left on the reference by a click is not a request; only
      // keyboard focus (focus-visible) lights its lines.
      if ((event.currentTarget as HTMLElement).matches(":focus-visible"))
        light()
    },
    onBlur: unlight,
  }
}

/**
 * A citation chip in the briefing: its kind icon only (round 5), and its
 * cited lines light on real hover or keyboard focus (round 5b), as a
 * phrase's do. A checkpoint's chip shows its state as its margin pin does:
 * that state's icon and family, and its word in the name ("…, missing").
 */
function BriefingChip({
  unitId,
  lit,
  marker,
  ...chip
}: React.ComponentProps<typeof CitationChip> & {
  unitId: string
  lit: { filePath: string; range: LineRange } | undefined
  /** The cited marker, when this view has it. */
  marker: ContextualMarker | undefined
}) {
  const lights = useLightsLines(unitId, lit)
  const proof = marker && isCheckpoint(marker) ? proofOf(marker) : undefined
  return (
    <CitationChip
      {...chip}
      {...lights}
      {...(proof
        ? {
            state: {
              family: proofFamily(proof),
              icon: (className: string) => (
                <ProofIcon proof={proof} className={className} />
              ),
            },
            "aria-label": `${chip["aria-label"]}, ${PROOF_LABEL[proof].toLowerCase()}`,
            "data-proof": proof,
          }
        : {})}
      iconOnly
      data-briefing-link=""
    />
  )
}

/**
 * A block that comes and goes with the stop: under the phased choreography
 * when the dial is on (`params`), else simply shown or not.
 */
function Presence({
  show,
  name,
  params,
  children,
}: {
  show: boolean
  name: string
  params: ReturnType<typeof usePhased> | undefined
  children: React.ReactNode
}) {
  if (!params) return show ? children : null
  return (
    <AnimatePresence initial={false}>
      {show && (
        <PhasedLayer key={name} name={name} params={params}>
          {children}
        </PhasedLayer>
      )}
    </AnimatePresence>
  )
}

/**
 * Unit heading + contextual briefing. Citation chips carry the cited
 * marker's kind icon; they land on its lines in the diff (below the sticky
 * file header) and open its card in the margin (L2), or open the source
 * sheet — the briefing never carries the source text itself.
 *
 * Round 5 (option B): phrases that describe part of the change link to it
 * and land there as a chip does, and in the paragraph the chips show only
 * their kind icon (round-5.md).
 */
export function Briefing({
  unit,
  revision,
  markers = {},
  files,
  delivery,
}: {
  unit: ReviewDeskData["unit"]
  /** The reviewed revision, whose diff orders the checkpoints' lines. */
  revision: string
  /** The desk's markers, for each citation's kind. */
  markers?: Record<string, ContextualMarker>
  /**
   * The files the diff renders, to land a citation on its lines. A citation
   * into any other file opens its source sheet.
   */
  files?: ReadonlyArray<DiffFile>
  /**
   * Review delivery (round 4): the glyph after the title (round 6, B), and
   * what each stop says of the change. One briefing across the dial (the
   * owner's approval of 25 October): a joined unit's changes are rows whose
   * titles stay put while the stop changes what each says; Facts gives its
   * sentence, Briefed and Guided its claims, Explained its Before beside its
   * After.
   */
  delivery?: {
    /** Sits after the title, in its line (DeliveryTitleGlyph). */
    glyph: React.ReactNode
    facts: ReadonlyArray<BriefingSegment>
    factsOnly: boolean
    /** Whether the unit is at Explained. */
    atExplained: boolean
    /**
     * The unit's own Explained (or its one change's), at any stop. A joined
     * unit whose every change has its own shows those as rows instead.
     */
    explained?: ExplainedText
    /** Whether the unit is at Guided. */
    guided: boolean
    /**
     * The Guided check while the unit is at Guided, else undefined. The
     * review card of a human-suggested unit carries it behind "Why".
     */
    guidedCheck: Check | undefined
  }
}) {
  const phased = usePhased()
  const openCitation = useSetAtom(openCitationAtom)
  const openSheet = useSetAtom(openSheetAtom)
  const closeCard = useSetAtom(closeCardAtom)
  const closeLine = useSetAtom(closeLineAtom)
  const closeSheet = useSetAtom(closeSheetAtom)
  const landOn = useSetAtom(landOnAtom)
  const reviewJump = useReviewJump(unit.id)
  const hasReview = !!unit.attribution && unit.attribution.outcome !== "passed"
  /**
   * A citation lands on its marker's lines in the diff and opens its card,
   * or opens the source sheet. A phrase that describes a marker does the
   * same.
   */
  const cite = (markerKey: string, sourceSheet: boolean, from: HTMLElement) => {
    closeLine()
    const target = sourceSheet
      ? undefined
      : landingFor(unit.id, files ?? [], markerKey)
    // Without files to land in (an embedding that does not pass them), the
    // pin is brought into view if it is rendered.
    const pin =
      sourceSheet || files
        ? null
        : from
            .closest("main")
            ?.querySelector<HTMLElement>(markerPinSelector(markerKey))
    openCitation(markerKey)
    if (target) landOn(target)
    else if (pin) pin.scrollIntoView({ behavior: "instant", block: "center" })
    else {
      // A source-sheet citation, or a file the diff does not render: open
      // the source instead of landing.
      openSheet()
      closeCard()
    }
  }
  /** A phrase lands where it points, as a citation chip lands. */
  const followPhrase = (target: BriefingPhraseTarget, from: HTMLElement) => {
    if (target.kind === "marker") return cite(target.markerKey, false, from)
    if (target.kind === "review") return reviewJump.go()
    if (target.kind === "unit") return
    // Lines or a file: no card belongs to them, so an open one closes.
    closeLine()
    closeCard()
    closeSheet()
    landOn({
      unitId: unit.id,
      filePath: target.filePath,
      range: target.kind === "lines" ? target.range : undefined,
    })
  }
  /** Undefined for a marker this view does not have: no kind is claimed. */
  const kindOf = (markerKey: string): MarkerKind | undefined => {
    const marker = markers[markerKey]
    return marker ? markerKind(marker) : undefined
  }
  const heading =
    unit.lane === "agentic-review" &&
    unit.attribution &&
    unit.attribution.outcome !== "passed"
      ? "Agentic review · decided by the agent"
      : unit.lane === "static-automation" &&
          unit.attribution?.outcome === "passed" &&
          unit.attribution.checks?.some((check) => check.tone === "passed")
        ? "Static automation · checked by tools"
        : unit.lane && unit.excluded
          ? // No agent read it, so it asks for nothing: the lane alone,
            // never "optional" beside "not read".
            LANE_NAME[unit.lane]
          : unit.lane
            ? LANE_HEADING[unit.lane].text
            : unit.responsibility.kind === "unresolved"
              ? "Assessment unresolved"
              : "Assessment pending"

  const sections =
    unit.sections && unit.sections.length > 1 ? unit.sections : undefined
  const kind = briefingKind(delivery, delivery?.explained, sections)
  // Rows when every change has this stop's own text (at Facts, or its "No
  // agent decision" line); else the unit's text once.
  const rows = rowedAt(kind, sections, !!unit.noAgentDecision)
    ? sections
    : undefined
  const rowed = rows !== undefined
  // A change no agent decided, when its row isn't drawn, says so under the
  // header instead: its title, its line, then its notes. A decided change
  // whose row isn't drawn says its suggestion there, led by its title.
  const stranded = strandedSections(sections, rowed, !!unit.noAgentDecision)
  const unitNotes = unit.undecidedNotes ?? []
  // What Records wrote about the unit, where the briefing it leads isn't
  // shown as text.
  const recordsNotes =
    unit.briefingNotes?.length && notesApart(kind, sections)
      ? unit.briefingNotes
      : []
  // Nothing to say at this stop: no digest and no rubric under it.
  const said =
    kind === "explained" ||
    (kind === "facts"
      ? rowed || delivery!.facts.length > 0
      : sections !== undefined || unit.briefing.length > 0)

  /** One segment, inline in its sentence: text, a phrase link or a chip. */
  const inline = (
    segment: BriefingSegment,
    key: number,
    previous: BriefingSegment | undefined,
    glued?: string
  ) => {
    if (segment.kind === "text") return <span key={key}>{segment.text}</span>
    if (segment.kind === "phrase") {
      const destination = phraseDestination(
        segment.target,
        unit.id,
        files,
        markers,
        hasReview
      )
      if (!destination) return <span key={key}>{segment.text}</span>
      return (
        <BriefingPhrase
          key={key}
          text={segment.text}
          destination={destination}
          unitId={unit.id}
          onActivate={(element) => followPhrase(segment.target, element)}
        />
      )
    }
    const target =
      segment.presentation === "source-sheet"
        ? undefined
        : landingFor(unit.id, files ?? [], segment.markerKey)
    const chip = (
      // In the briefing a chip shows only its kind icon (round 5); its name
      // and its tooltip say the kind and the target.
      <BriefingChip
        unitId={unit.id}
        lit={
          target?.range
            ? { filePath: target.filePath, range: target.range }
            : undefined
        }
        kind={kindOf(segment.markerKey)}
        marker={markers[segment.markerKey]}
        label={segment.label}
        lands={
          segment.presentation !== "source-sheet" &&
          (files === undefined || !!target)
        }
        aria-label={segment.ariaLabel}
        onClick={(event) =>
          cite(
            segment.markerKey,
            segment.presentation === "source-sheet",
            event.currentTarget
          )
        }
      />
    )
    return (
      <React.Fragment key={key}>
        {spaceBeforeChip(previous) && " "}
        {glued ? (
          // The punctuation after a chip stays on its line.
          <span data-chip-glue="" className="whitespace-nowrap">
            {chip}
            {glued}
          </span>
        ) : (
          chip
        )}
      </React.Fragment>
    )
  }
  const sentence = (run: ReadonlyArray<BriefingSegment>) => {
    const parts = sentenceParts(run)
    return parts.map((part, i) =>
      inline(part.segment, i, parts[i - 1]?.segment, part.glued)
    )
  }

  /** Claims, one per line; a single claim reads as a sentence. */
  const claims = (segments: ReadonlyArray<BriefingSegment>) => {
    const runs = briefingClaims(segments)
    if (runs.length <= 1)
      return (
        <p {...blockProps()} className={cn(PROSE, "max-w-[820px]")}>
          {sentence(runs[0] ?? [])}
        </p>
      )
    return (
      <ul className="m-0 flex max-w-[820px] list-none flex-col gap-[5px] p-0">
        {runs.map((run, i) => (
          <li
            key={i}
            {...blockProps()}
            className={cn(
              PROSE,
              "relative pl-4 before:absolute before:top-[9px] before:left-[3px] before:size-1 before:rounded-full before:bg-faint"
            )}
          >
            {sentence(run)}
          </li>
        ))}
      </ul>
    )
  }

  /**
   * A change's links, folded into one line under its Before and After: its
   * Briefed phrases, then the ones Explained linked (`explained`), each
   * phrase once by its words and where it lands. Phrases only, as the old
   * Explained showed them: their chips are in the Briefed lead and the margin.
   */
  const links = (
    segments: ReadonlyArray<BriefingSegment>,
    explained: ExplainedText["links"] = []
  ) => {
    const phrases = explainedLinks(briefingPhrases(segments), explained)
    if (phrases.length === 0) return null
    return (
      <p
        {...blockProps()}
        className="m-0 mt-2.5 flex items-start gap-2 text-[13px] leading-5 text-ink-muted"
      >
        <CornerDownRightIcon
          aria-hidden="true"
          className="mt-[3px] size-[13px] shrink-0 text-faint"
        />
        <span className="min-w-0">
          {phrases.map((phrase, i) => (
            <React.Fragment key={i}>
              {i > 0 && <span aria-hidden="true"> · </span>}
              {inline(phrase, i, undefined)}
            </React.Fragment>
          ))}
        </span>
      </p>
    )
  }

  const explainedOf = (
    text: ExplainedText,
    segments: ReadonlyArray<BriefingSegment>,
    labels: "always" | "narrow"
  ) => (
    <div className="flex flex-col">
      <BeforeAfter text={text} labels={labels} />
      {links(segments, text.links)}
    </div>
  )

  /**
   * What this stop says of one change of a joined unit. One change no agent
   * decided says so at every stop, with why: in its claim's place, or
   * before its Facts (code's, still true) and its Explained. One an agent
   * decided, on a human-required unit, says what it suggests in that same
   * place, before its claim, its Facts or its Explained: each row's state
   * reads down one line of the column.
   */
  const sectionBody = (section: BriefingSection) => {
    const undecided = undecidedRow(section, !!unit.noAgentDecision)
    // A change an agent decided says what it suggests in the same place.
    const state = undecided ? (
      <NoAgentDecision notes={section.undecidedNotes} />
    ) : (
      section.suggestion && (
        <SectionSuggestion decision={section.suggestion.decision}>
          {sentence(section.suggestion.message)}
        </SectionSuggestion>
      )
    )
    if (kind !== "facts" && kind !== "explained")
      return undecided ? (
        state
      ) : state ? (
        <div className="flex flex-col gap-2.5">
          {state}
          {claims(section.briefing)}
        </div>
      ) : (
        claims(section.briefing)
      )
    // At Facts, a change whose content didn't read has only its line.
    const shown =
      kind === "facts"
        ? section.facts && (
            <p {...blockProps()} className={cn(PROSE, "max-w-[760px]")}>
              {sentence(section.facts)}
            </p>
          )
        : explainedOf(section.explained!, section.briefing, "narrow")
    return state ? (
      <div className="flex flex-col gap-2.5">
        {state}
        {shown}
      </div>
    ) : (
      shown
    )
  }

  /** What this stop says of the unit when it has no rows. */
  const unitBody =
    kind === "facts" ? (
      <p {...blockProps()} className={cn(PROSE, "max-w-[760px]")}>
        {sentence(delivery!.facts)}
      </p>
    ) : kind === "explained" ? (
      // A joined unit whose every change has its own draws rows instead,
      // and has no Explained of the unit's own to draw here.
      delivery?.explained &&
      explainedOf(
        delivery.explained,
        sections
          ? sections.flatMap((section) => section.briefing)
          : unit.briefing,
        "always"
      )
    ) : (
      claims(unit.briefing)
    )

  /** Under the phased choreography when the dial is on: out, then in. */
  const inLayer = (name: string, content: React.ReactNode) =>
    delivery ? (
      <AnimatePresence initial={false}>
        <PhasedLayer key={kind} name={name} params={phased}>
          {content}
        </PhasedLayer>
      </AnimatePresence>
    ) : (
      content
    )

  const terms =
    kind === "explained"
      ? rows
        ? uniqueTerms(rows.map((section) => section.explained!))
        : delivery!.explained!.terms
      : []

  const body = rows ? (
    <div className="flex flex-col">
      <Presence
        show={kind === "explained"}
        name="before-after"
        params={delivery && phased}
      >
        <div className={cn(ROW, "pb-1")}>
          <span aria-hidden="true" />
          <BeforeAfterHeader />
        </div>
      </Presence>
      {rows.map((section, i) => (
        <section
          key={section.id}
          aria-label={section.title}
          className={cn(ROW, "py-3.5", i > 0 && "border-t border-line-2")}
        >
          <h2 className="m-0 text-[14px] leading-[22px] font-semibold text-pretty text-ink">
            {section.title}
          </h2>
          <div className="flex min-w-0 flex-col gap-2.5">
            {inLayer(kind, sectionBody(section))}
            {section.comments && (
              <WholeComments
                comments={section.comments}
                label={`Comments on ${section.title}`}
              />
            )}
          </div>
        </section>
      ))}
    </div>
  ) : (
    <div className="flex min-w-0 flex-col">{inLayer(kind, unitBody)}</div>
  )

  return (
    <div className="@container relative flex max-w-[1240px] flex-col gap-3 px-8 pt-7 pb-5 narrow:px-4 narrow:pt-5">
      <div className="flex items-center gap-2">
        {unit.lane ? (
          <LaneGlyph lane={unit.lane} />
        ) : (
          <InfoIcon aria-hidden="true" className="size-4 text-ink-2" />
        )}
        <span
          className={cn(
            "label-mono",
            unit.lane ? LANE_HEADING[unit.lane].className : "text-ink-2"
          )}
        >
          {heading}
          {unit.lane === "human-required" &&
            ` · ${unit.position.index} of ${unit.position.of}`}
        </span>
        {unit.raisedFrom && <HeadRaisedMark from={unit.raisedFrom} />}
        <UnitFeedback />
      </div>
      {/* The title's line: the h1 runs inline so the glyph follows its last
      word, and the dial, when it opens in flow, is a block of this line. */}
      <div className="leading-[34px]">
        <h1 className="m-0 inline text-[28px] leading-[34px] font-semibold tracking-[-0.025em]">
          {unit.title}
        </h1>
        {delivery?.glyph}
      </div>
      {unit.responsibility?.kind === "unresolved" && (
        <details className="max-w-[660px] rounded-xl border border-line bg-surface p-3 text-sm">
          <summary className="cursor-pointer font-medium">
            Reported gaps · {unit.responsibility.gaps.length}
          </summary>
          <p className="mt-3 text-ink-2">
            The assigned reviewer retained this assessment as unresolved.
            Support and applicability have not been established.
          </p>
          <ol className="flex list-decimal flex-col gap-4 pl-5">
            {unit.responsibility.gaps.map((gap) => (
              <li key={gap.markerKey} className="wrap-anywhere">
                <p className="font-medium">{gap.requirement}</p>
                <p className="text-ink-2">
                  Reported observation: {gap.reportedObservation}
                </p>
                <p className="text-ink-2">
                  Investigation requested: {gap.investigation}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    openCitation(gap.markerKey)
                    openSheet()
                    closeCard()
                  }}
                  className="mt-2 rounded border border-line bg-raised px-2 py-1 text-left text-xs text-ink hover:bg-raised-2"
                  aria-label={`Inspect reported gap ${gap.requirement}`}
                >
                  {gap.referenceLabel} · {gap.availability}
                </button>
              </li>
            ))}
          </ol>
        </details>
      )}
      {/* No agent decided the unit: one plain line where its briefing
      begins, and under it why, at every stop. Facts (written by code) and
      the diff stay as they are. On a unit only partly undecided, a note
      that names none of its changes is here, the rest on their rows; while
      the rows aren't drawn, each undecided change is here too: its title
      leads its line, and its notes follow; each decided change says its
      suggestion here then, led by its title. */}
      {unit.noAgentDecision ? (
        <NoAgentDecision notes={unit.undecidedNotes} />
      ) : unitNotes.length > 0 || stranded.length > 0 ? (
        <div
          className={cn(
            "flex flex-col",
            stranded.some((section) => section.suggestion)
              ? "gap-2.5"
              : "gap-0.5"
          )}
        >
          {unitNotes.length > 0 && <UndecidedNotes notes={unitNotes} />}
          {stranded.map((section) =>
            section.suggestion ? (
              <SectionSuggestion
                key={section.id}
                title={section.title}
                decision={section.suggestion.decision}
              >
                {sentence(section.suggestion.message)}
              </SectionSuggestion>
            ) : (
              <NoAgentDecision
                key={section.id}
                title={section.title}
                notes={section.notes}
              />
            )
          )}
        </div>
      ) : null}
      {unit.excluded && <NotRead excluded={unit.excluded} />}
      {unit.earlierDecisions && (
        <EarlierDecisions decisions={unit.earlierDecisions} />
      )}
      {sections && unit.briefing.length > 0 && (
        // A joined unit's lead: what its changes do together. Facts says
        // only each change's sentence, so the lead leaves there.
        <Presence
          show={kind !== "facts"}
          name="lead"
          params={delivery && phased}
        >
          <p className={cn(PROSE, "max-w-[760px] leading-6")}>
            {sentence(unit.briefing)}
          </p>
        </Presence>
      )}
      {/* What Records wrote about the unit (a briefing that failed or was
      cut, lines that didn't read), where the briefing it leads with isn't
      shown as text: never a stop without it. */}
      <Presence
        show={recordsNotes.length > 0}
        name="records-notes"
        params={delivery && phased}
      >
        <p className={cn(PROSE, "max-w-[760px]")}>{recordsNotes.join(" ")}</p>
      </Presence>
      {said && body}
      {said && kind !== "explained" && (
        // The rubric under the digest on screen: Facts' sentences, or the
        // claims Briefed and Guided share. Explained's is under the layers.
        <DigestFeedback
          content={kind === "facts" ? "facts" : "briefed"}
          harnessCallVisible={
            unit.attribution !== undefined ||
            !!delivery?.guidedCheck?.suggestion ||
            !!sections?.some((section) => section.suggestion)
          }
          className="-mt-1.5 -ml-2"
        />
      )}
      {/* Leaving, the terms keep their last words while they fade. */}
      <Presence
        show={terms.length > 0}
        name="terms"
        params={delivery && phased}
      >
        <div className={cn(rowed && ROW, "pt-1")}>
          {rowed && <span aria-hidden="true" />}
          <ExplainedTerms terms={terms} />
        </div>
      </Presence>
      {/* Checkpoints anchored to lines are pins in the margin; one that
      reaches no owned line is shown here (11.17). Guided shows no diff, and
      its check against the ticket already says what each item lacks, so it
      has no list (10.140): only while that check is there to show. */}
      {!(delivery?.guided && delivery.guidedCheck) && (
        <CheckpointBriefing
          entries={checkpointEntries(markers, files, revision)}
        />
      )}
      {unit.attribution && (
        <Attribution
          unit={unit}
          attribution={unit.attribution}
          markers={markers}
          guidedCheck={delivery?.guidedCheck}
          reviewJump={reviewJump}
        />
      )}
      {/* Comments that name no lines, after the review they may rest on. */}
      {unit.comments && (
        <WholeComments comments={unit.comments} label="Comments on this unit" />
      )}
      {unit.nativeChecks?.length ? (
        <ul className="m-0 flex list-none flex-col rounded-xl bg-surface p-0 shadow-[0_0_0_1px_var(--nv-line)]">
          {unit.nativeChecks.map((check, index) => (
            <li
              key={check.id}
              className={cn(
                "grid grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-2.5 px-3.5 py-[11px]",
                index > 0 && "border-t border-line-2"
              )}
            >
              <NativeCheckIcon
                kind={kindOf(check.markerKey)}
                tone={check.tone}
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-[13.5px] wrap-anywhere">
                  {check.title}
                </span>
                <span className="font-mono text-[11px] text-ink-muted">
                  {check.detail}
                </span>
              </span>
              <CitationChip
                kind={kindOf(check.markerKey)}
                label={check.meta}
                lands={false}
                onClick={() => {
                  closeLine()
                  openCitation(check.markerKey)
                  openSheet()
                  closeCard()
                }}
                aria-label={`Open native evidence ${check.title}`}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
