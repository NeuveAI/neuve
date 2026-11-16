/* ─────────────────────────────────────────────────────────
 * ANIMATION STORYBOARD — Commit lineage (Cycle.dc.html "What changed")
 *
 *    0ms   view fades in (card 220ms, emphasized decelerate)
 *    0ms   row hover / open: tone shift (surfaceTone 120ms, CSS)
 *    0ms   row opens: chevron turns 0 → 180° (chevron 200ms, standard);
 *          the detail rises, y -4 → 0, opacity 0 → 1
 *          (detail 240ms, emphasized decelerate)
 *  close   the detail fades (cardExit 160ms, accelerate)
 *
 * Reduced motion: opacity-only 150ms; the chevron snaps.
 * ───────────────────────────────────────────────────────── */

import { Provider, atom, useAtomValue, useSetAtom } from "jotai"
import { useHydrateAtoms } from "jotai/utils"
import {
  AnimatePresence,
  MotionConfig,
  motion,
  useReducedMotion,
} from "motion/react"
import { ArrowLeftIcon, ArrowRightIcon, ChevronDownIcon } from "lucide-react"

import {
  EASE,
  REDUCED_TRANSITION,
  TIMING,
  ms,
  OFFSET,
} from "@workspace/ui/lib/motion"
import { cn } from "@workspace/ui/lib/utils"
import {
  agentByIdAtom,
  agentsHydration,
} from "@workspace/ui/neuve/agents/atoms"
import { AppHeader } from "@workspace/ui/neuve/shared/app-header"
import { Disclosure } from "@workspace/ui/neuve/shared/disclosure"
import { HighlightedCode } from "@workspace/ui/neuve/shared/highlighted-code"
import { regionTransition } from "@workspace/ui/neuve/shared/view-transitions"
import { LaneGlyph } from "@workspace/ui/neuve/shared/lane-glyph"
import { NeuveLink } from "@workspace/ui/neuve/shared/nav-link"
import { PersonAvatar } from "@workspace/ui/neuve/shared/person-avatar"
import { ReviewMark, VerdictIcon } from "@workspace/ui/neuve/shared/review-mark"
import type {
  ReviewActor,
  ReviewVerdict,
} from "@workspace/ui/neuve/shared/review-mark"
import type { NeuveDestination } from "@workspace/ui/neuve/shared/nav-link"
import type {
  AgentRegistry,
  CommitLineage,
  LineageEntry,
  LineageReview,
  RegisteredCommitLineage,
  LineageAuthor,
  RegisteredRevisionView,
  ReviewLane,
  Reviewer,
} from "@workspace/ui/neuve/types"

const DETAIL = {
  offsetY: -OFFSET.card,
  enter: { duration: ms(TIMING.detail), ease: EASE.emphasizedDecelerate },
  exit: { duration: ms(TIMING.cardExit), ease: EASE.emphasizedAccelerate },
} as const

/** The lineage row whose detail is open (one at a time). */
export const lineageOpenAtom = atom<string | null>("renewed")

/**
 * A recorded verdict as the review mark at 16px with its words ("You
 * approved", "R1 requested changes"): the same mark as the rail and the
 * review card (changes/round-4.md § Review identity). It renders without
 * provenance, so nothing in it takes focus inside the row's button or
 * summary, and its avatar stays decorative beside the visible name.
 *
 * `muted` dims the words of a carried row; the avatar and the icon keep
 * their colour, since identity and verdict never change with state.
 */
function LineageVerdict({
  actor,
  verdict,
  muted = false,
}: {
  actor: ReviewActor | { kind: "unregistered-agent"; id: string }
  verdict: ReviewVerdict
  muted?: boolean
}) {
  // The verb in regular weight even inside a semibold summary; the name
  // stays bold, as in the mark everywhere else.
  const words = cn("font-normal", muted ? "text-ink-muted" : "text-ink")
  if (actor.kind === "unregistered-agent")
    // An agent id the registry does not hold: the words name it, and no
    // avatar is drawn for an identity the branch never registered.
    return (
      <span
        data-review-mark=""
        data-verdict={verdict}
        className={cn(
          "inline-flex items-center gap-[7px] text-[13.5px] leading-5 whitespace-nowrap",
          words
        )}
      >
        <VerdictIcon verdict={verdict} />
        <span>
          <b className="font-semibold">{actor.id}</b>{" "}
          {verdict === "approved" ? "approved" : "requested changes"}
        </span>
      </span>
    )
  return (
    <ReviewMark
      size={16}
      actor={actor}
      verdict={verdict}
      className={cn("shrink-0", words)}
    />
  )
}

/**
 * Status words with no verdict ("Assessment pending", "passed"): the rail's
 * muted mono result, never a chip, so a chip never means status here and
 * verdict elsewhere.
 */
function LineageStatus({ text }: { text: string }) {
  return (
    <span
      data-lineage-status=""
      className="shrink-0 font-mono text-[10.5px] whitespace-nowrap text-ink-muted"
    >
      {text}
    </span>
  )
}

/** The viewer's verdicts draw the desk's reviewer, whatever the entry says. */
function reviewActor(review: LineageReview, reviewer: Reviewer): ReviewActor {
  if (review.actor.kind === "person" && review.actor.isYou)
    return { kind: "person", person: reviewer, isYou: true }
  return review.actor
}

const RELATION_LABEL: Record<LineageEntry["relation"], string> = {
  renewed: "Renewed signal",
  corrected: "Corrected",
  regrouped: "Regrouped",
  carried: "Carried forward",
}

const LINEAGE_GRID =
  "grid grid-cols-[minmax(0,1fr)_148px_minmax(0,1fr)] items-center gap-4 max-[760px]:grid-cols-[minmax(0,1fr)]"

function RelationArrow({ entry }: { entry: LineageEntry }) {
  const renewed = entry.relation === "renewed"
  const carried = entry.relation === "carried"
  const stroke = renewed
    ? "var(--nv-req)"
    : carried
      ? "var(--nv-faint)"
      : "var(--nv-ink-2)"
  return (
    <span
      className={cn(
        "flex items-center justify-center gap-2 text-xs max-[760px]:justify-start",
        renewed && "font-semibold text-req-fg",
        carried && "text-ink-muted",
        !renewed && !carried && "text-ink-2"
      )}
    >
      <svg
        width="34"
        height="10"
        viewBox="0 0 34 10"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M1 5h30"
          stroke={stroke}
          strokeWidth="1.4"
          strokeDasharray={carried ? "3 3" : undefined}
        />
        <path d="M27 1.5 31 5l-4 3.5" stroke={stroke} strokeWidth="1.4" />
      </svg>
      {RELATION_LABEL[entry.relation]}
    </span>
  )
}

function RenewedDetail({
  renewed,
}: {
  renewed: NonNullable<LineageEntry["renewed"]>
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-3">
        <div className="min-w-0 flex-[1_1_380px] overflow-hidden rounded-[10px] bg-surface shadow-[0_0_0_1px_var(--nv-line)]">
          <div className="flex h-9 items-center gap-2 border-b border-line-2 px-3">
            <span className="font-mono text-xs">{renewed.approved.file}</span>
            <span className="flex-auto" />
            <span className="font-mono text-[10.5px] text-ink-muted">
              {renewed.approved.note}
            </span>
          </div>
          <div className="grid grid-cols-[40px_minmax(0,1fr)] bg-req-tint py-1 font-mono text-[12.5px] leading-6 whitespace-pre-wrap">
            <span className="pr-2.5 text-right text-ln">
              {renewed.approved.line}
            </span>
            <span className="wrap-anywhere">
              <HighlightedCode code={renewed.approved.text} />
            </span>
          </div>
        </div>
        <div className="min-w-0 flex-[1_1_380px] overflow-hidden rounded-[10px] bg-surface shadow-[0_0_0_1px_var(--nv-line)]">
          <div className="flex h-9 items-center gap-2 border-b border-line-2 px-3">
            <span className="font-mono text-xs">{renewed.changed.file}</span>
            <span className="flex-auto" />
            <span className="font-mono text-[10.5px] text-req-fg">
              {renewed.changed.note}
            </span>
          </div>
          <div className="grid grid-cols-[40px_16px_minmax(0,1fr)] bg-del-bg font-mono text-[12.5px] leading-6 whitespace-pre-wrap">
            <span className="pr-2.5 text-right text-del-ln">
              {renewed.changed.line}
            </span>
            <span className="text-del-fg">−</span>
            <span className="wrap-anywhere">
              <HighlightedCode code={renewed.changed.removed} />
            </span>
          </div>
          <div className="grid grid-cols-[40px_16px_minmax(0,1fr)] bg-add-bg font-mono text-[12.5px] leading-6 whitespace-pre-wrap">
            <span className="pr-2.5 text-right text-add-ln">
              {renewed.changed.line}
            </span>
            <span className="text-add-fg">+</span>
            <span className="wrap-anywhere">
              <HighlightedCode code={renewed.changed.added} />
            </span>
          </div>
        </div>
      </div>
      <p className="m-0 max-w-[680px] text-[13.5px] leading-[21px] text-ink-2">
        {renewed.why}
      </p>
      <span className="font-mono text-[11px] text-ink-muted">
        {renewed.evidence}
      </span>
    </div>
  )
}

function LineageRow({
  entry,
  reviewer,
}: {
  entry: LineageEntry
  reviewer: Reviewer
}) {
  const openId = useAtomValue(lineageOpenAtom)
  const setOpen = useSetAtom(lineageOpenAtom)
  const reduce = useReducedMotion()
  const open = openId === entry.id
  const carried = entry.relation === "carried"
  const detailId = `lineage-${entry.id}`
  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailId}
        onClick={() => setOpen(open ? null : entry.id)}
        className={cn(
          "w-full rounded-xl border-0 px-4 py-3.5 text-left transition-colors duration-surface-tone ease-standard hover:bg-raised motion-reduce:transition-none",
          open ? "bg-raised" : "bg-transparent"
        )}
      >
        <span className={LINEAGE_GRID}>
          {/* A carried row is dimmed by the muted text token, never by
              opacity, so its words and verdict keep their contrast. */}
          <span className="flex min-w-0 flex-col gap-1">
            {entry.before.map((unit) => (
              <span
                key={unit.title}
                className="flex min-w-0 items-center gap-2.5"
              >
                <span
                  className={cn(
                    "truncate text-[13.5px] font-medium",
                    carried ? "text-ink-muted" : "text-ink"
                  )}
                >
                  {unit.title}
                </span>
                {unit.review ? (
                  <LineageVerdict
                    actor={reviewActor(unit.review, reviewer)}
                    verdict={unit.review.verdict}
                    muted={carried}
                  />
                ) : (
                  <LineageStatus text={unit.result} />
                )}
              </span>
            ))}
          </span>
          <RelationArrow entry={entry} />
          <span className="flex min-w-0 items-center gap-2.5">
            {entry.needsYou && (
              <LaneGlyph lane="human-required" className="shrink-0" />
            )}
            <span className="flex min-w-0 flex-auto flex-col gap-0.5">
              <span
                className={cn(
                  "truncate text-sm",
                  carried
                    ? "font-normal text-ink-muted"
                    : "font-semibold text-ink"
                )}
              >
                {entry.after}
              </span>
              <span className="text-xs text-ink-muted">{entry.afterNote}</span>
            </span>
            <ChevronDownIcon
              aria-hidden="true"
              className={cn(
                "size-[15px] shrink-0 text-faint transition-transform duration-chevron ease-standard motion-reduce:transition-none",
                open && "rotate-180"
              )}
            />
          </span>
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="detail"
            id={detailId}
            initial={
              reduce ? { opacity: 0 } : { opacity: 0, y: DETAIL.offsetY }
            }
            animate={{ opacity: 1, y: 0 }}
            exit={{
              opacity: 0,
              transition: reduce ? REDUCED_TRANSITION : DETAIL.exit,
            }}
            transition={reduce ? REDUCED_TRANSITION : DETAIL.enter}
            className="px-4 pt-1 pb-4"
          >
            {entry.renewed && <RenewedDetail renewed={entry.renewed} />}
            {!entry.renewed && (
              <div className="flex max-w-[680px] flex-col gap-2">
                {entry.quote && (
                  <div className="flex items-start gap-2.5">
                    <PersonAvatar person={reviewer} size={20} label="You" />
                    <span className="text-[13px] leading-5 text-ink-2">
                      {entry.quote}
                    </span>
                  </div>
                )}
                {entry.note && (
                  <span className="text-[13px] leading-5 text-ink-2">
                    {entry.note}
                  </span>
                )}
              </div>
            )}
            {entry.needsYou && entry.unitId && (
              <div className="pt-3">
                <NeuveLink
                  destination={{ to: "unit", unitId: entry.unitId }}
                  className="inline-flex h-[34px] items-center gap-2 rounded-lg bg-ink px-3 text-[13px] font-medium text-paper no-underline transition-colors duration-surface-tone ease-standard hover:bg-ink/90 hover:text-paper motion-reduce:transition-none"
                >
                  Open unit
                  <ArrowRightIcon aria-hidden="true" className="size-3.5" />
                </NeuveLink>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export interface LineageScreenProps {
  lineage: CommitLineage | RegisteredCommitLineage
  agents: AgentRegistry
  /** Where "Back to <commit>" returns (the unit under review). */
  back: NeuveDestination
  /**
   * The person viewing (the desk's reviewer): their avatar on their own
   * verdicts and on quoted comments.
   */
  reviewer: Reviewer
  initialOpen?: string | null
}

type RegisteredUnit = RegisteredRevisionView["units"][number]

const LANE_NAME: Record<ReviewLane, string> = {
  "human-required": "Human-required",
  "human-suggested": "Human-suggested",
  "agentic-review": "Agentic review",
  "static-automation": "Static automation",
}

/**
 * The registered author as a review-mark actor (`LineageAuthor`): an agent
 * from the branch's registry by id, the viewer as the desk's reviewer, any
 * other person named by id with initials taken from it (as the live BFF
 * names comment authors).
 */
function authorActor(
  author: LineageAuthor,
  agents: Record<string, ReviewActorAgent | undefined>,
  reviewer: Reviewer
): ReviewActor | { kind: "unregistered-agent"; id: string } {
  if (author.kind === "agent") {
    const agent = agents[author.id]
    return agent
      ? { kind: "agent", agent }
      : { kind: "unregistered-agent", id: author.id }
  }
  if (author.viewer) return { kind: "person", person: reviewer, isYou: true }
  return {
    kind: "person",
    person: {
      name: author.id,
      initials: author.id.slice(0, 2).toUpperCase(),
    },
  }
}

type ReviewActorAgent = Extract<ReviewActor, { kind: "agent" }>["agent"]

/**
 * The viewer when a load comes without the desk's reviewer: the viewer
 * author's id, the words "You" and initials taken from the id (the rule for
 * any registered person), or the person marked as you in the fixture
 * lineage. Loads from the BFF and the mock carry the reviewer.
 */
export function lineageViewer(
  lineage: CommitLineage | RegisteredCommitLineage
): Reviewer {
  if ("kind" in lineage) {
    const authors = [
      ...(lineage.before?.units ?? []),
      ...lineage.after.units,
    ].flatMap((unit) => unit.dispositions.map((d) => d.author))
    if (lineage.relations.kind === "recorded")
      authors.push(...lineage.relations.records.map((r) => r.author))
    const viewer = authors.find((author) => author.viewer)
    if (viewer)
      return {
        id: viewer.id,
        name: "You",
        initials: viewer.id.slice(0, 2).toUpperCase(),
      }
  } else {
    for (const entry of lineage.entries)
      for (const unit of entry.before)
        if (unit.review?.actor.kind === "person" && unit.review.actor.isYou)
          return unit.review.actor.person
  }
  return { id: "", name: "You", initials: "Y" }
}

/** The full attribution in the opened row: kind and id. */
function authorDetail(author: LineageAuthor) {
  return author.viewer ? `You (${author.id})` : `${author.kind}: ${author.id}`
}

/**
 * The unit's verdict, from its current disposition, not from result prose:
 * "You approved", "R1 approved", "maya requested changes". It shows the
 * recorded decision, whatever the unit's lane is now; Agree is an approval
 * (user decision D1). With no current disposition the recorded status
 * (pending, passed) shows as muted words.
 */
function RegisteredResult({
  unit,
  reviewer,
}: {
  unit: RegisteredUnit
  reviewer: Reviewer
}) {
  const agents = useAtomValue(agentByIdAtom)
  const current = [...unit.dispositions]
    .reverse()
    .find((disposition) => disposition.current && !disposition.retracted)
  if (!current) return <LineageStatus text={unit.result} />
  return (
    <LineageVerdict
      actor={authorActor(current.author, agents, reviewer)}
      verdict={
        current.decision === "request-changes"
          ? "changes_requested"
          : "approved"
      }
    />
  )
}

function RegisteredUnitRow({
  unit,
  reviewer,
}: {
  unit: RegisteredUnit
  reviewer: Reviewer
}) {
  return (
    <li className="border-b border-line-2 last:border-b-0">
      <Disclosure
        chevron="end"
        label={unit.title}
        leading={
          unit.lane ? (
            <>
              <LaneGlyph lane={unit.lane} className="shrink-0" />
              <span className="sr-only">{LANE_NAME[unit.lane]}:</span>
            </>
          ) : (
            <>
              <span
                aria-hidden="true"
                className="size-2.5 shrink-0 rounded-full border border-dashed border-faint"
              />
              <span className="sr-only">Assessment pending:</span>
            </>
          )
        }
        trailing={<RegisteredResult unit={unit} reviewer={reviewer} />}
        summaryClassName="h-auto min-h-12 py-3 text-[13px] font-semibold text-ink"
        contentClassName="flex flex-col gap-2 pb-3 pl-[34px] text-xs text-ink-muted"
      >
        {unit.deskAvailable && unit.needsYou && (
          <NeuveLink
            destination={{ to: "unit", unitId: unit.id }}
            className="inline-flex h-[34px] items-center gap-2 self-start rounded-lg bg-ink px-3 text-[13px] font-medium text-paper no-underline transition-colors duration-surface-tone ease-standard hover:bg-ink/90 hover:text-paper motion-reduce:transition-none"
          >
            Review unit
            <ArrowRightIcon aria-hidden="true" className="size-3.5" />
          </NeuveLink>
        )}
        {!unit.lane && (
          <span>
            {unit.responsibility.kind === "unresolved"
              ? "Assessment unresolved"
              : "Assessment pending"}
          </span>
        )}
        <span className="font-mono wrap-anywhere">
          {unit.hunkIds.length} {unit.hunkIds.length === 1 ? "hunk" : "hunks"} ·{" "}
          {unit.hunkIds.join(", ")}
        </span>
        {unit.dispositions.length === 0 ? (
          <span>No recorded disposition.</span>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {unit.dispositions.map((disposition) => (
              <li key={disposition.id} className="wrap-anywhere">
                <span className="text-ink-2">
                  {authorDetail(disposition.author)} · {disposition.decision} ·{" "}
                  {disposition.retracted
                    ? "Retracted"
                    : disposition.current
                      ? "Current assessment"
                      : "Historical assessment"}
                </span>
                <p className="m-0">{disposition.rationale}</p>
                <span className="font-mono text-[11px] text-faint">
                  {disposition.id}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Disclosure>
    </li>
  )
}

/**
 * One revision's registered units as a single divided list: lane glyph,
 * title, verdict mark or status and a chevron; the row opens to its hunks
 * and recorded decisions.
 */
function RegisteredUnits({
  revision,
  reviewer,
}: {
  revision: RegisteredRevisionView
  reviewer: Reviewer
}) {
  return (
    <section
      className="flex min-w-0 flex-col gap-2"
      aria-label={`Registered units of ${revision.revisionId}`}
    >
      <h2 className="m-0 font-mono text-xs text-ink-muted">
        {revision.revisionId.slice(0, 8)} · registered review
      </h2>
      <p className="m-0 text-xs text-ink-muted">
        {revision.sourceAvailable
          ? "Pinned submitted source retained"
          : "Submitted source unavailable"}
      </p>
      {revision.limitations.length > 0 && (
        <Disclosure
          label="Recorded limitations"
          count={revision.limitations.length}
          className="-ml-2.5"
        >
          <ul className="m-0 flex list-disc flex-col gap-1.5 pl-4 text-xs leading-[18px] text-ink-2">
            {revision.limitations.map((text, index) => (
              <li key={index}>{text}</li>
            ))}
          </ul>
        </Disclosure>
      )}
      <ul className="m-0 flex list-none flex-col p-0">
        {revision.units.map((unit) => (
          <RegisteredUnitRow key={unit.id} unit={unit} reviewer={reviewer} />
        ))}
      </ul>
    </section>
  )
}

function RegisteredLineage({
  lineage,
  back,
  reviewer,
}: {
  lineage: RegisteredCommitLineage
  back: NeuveDestination
  reviewer: Reviewer
}) {
  const unitTitle = (unitId: string, revisionId: string | null) =>
    [lineage.before, lineage.after]
      .find((revision) => revision?.revisionId === revisionId)
      ?.units.find((unit) => unit.id === unitId)?.title ?? "Referenced unit"
  return (
    <div className="min-h-svh bg-paper font-sans text-sm text-ink">
      <AppHeader
        repo={lineage.repo}
        branch={lineage.branch}
        commit={lineage.to.slice(0, 12)}
      />
      <main
        {...regionTransition("lineage", 1)}
        className="mx-auto box-border flex max-w-[1080px] content-fade flex-col gap-7 px-6 pt-8 pb-24"
      >
        <div className="flex flex-col gap-2">
          <NeuveLink
            destination={back}
            className="inline-flex h-[30px] items-center gap-1.5 self-start rounded-lg py-0 pr-2.5 pl-1.5 text-[12.5px] text-ink-muted no-underline hover:bg-raised"
          >
            <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
            Back to your review
          </NeuveLink>
          <h1 className="m-0 text-[30px] leading-9 font-semibold tracking-[-0.03em]">
            What {lineage.to.slice(0, 8)} asks of you
          </h1>
          <p className="m-0 text-[13px] text-ink-muted">
            Cycle attribution unknown · recorded decisions stay with their own
            revision.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-6 max-[760px]:grid-cols-1">
          {lineage.before ? (
            <RegisteredUnits revision={lineage.before} reviewer={reviewer} />
          ) : (
            <section>
              <h2 className="m-0 text-sm font-semibold">
                Previous review unavailable
              </h2>
              <p className="text-[13px] text-ink-muted">
                {lineage.from
                  ? `The requested previous revision ${lineage.from} is not registered.`
                  : "No previous revision was selected. Comparison remains unknown."}
              </p>
            </section>
          )}
          <RegisteredUnits revision={lineage.after} reviewer={reviewer} />
        </div>
        <section
          className="flex flex-col gap-3"
          aria-label="Recorded unit relationships"
        >
          <h2 className="m-0 text-lg font-semibold">Unit relationships</h2>
          {lineage.relations.kind === "unknown" ? (
            <p className="m-0 text-[13px] text-ink-muted">
              Relationship unknown. No authored relation connects these selected
              revisions.
            </p>
          ) : (
            <>
              <ul className="m-0 flex list-none flex-col p-0">
                {lineage.relations.records.map((record) => (
                  <li
                    key={record.id}
                    className="border-b border-line-2 last:border-b-0"
                  >
                    <Disclosure
                      chevron="end"
                      label={`Authored ${record.relation} claim · ${record.author.viewer ? "You" : record.author.id}`}
                      summaryClassName="h-auto min-h-12 py-3 text-[13.5px] font-medium text-ink"
                      contentClassName="flex flex-col gap-2 pb-3 pl-2.5"
                    >
                      <p className="m-0 text-[13px] text-ink-2">
                        {record.rationale}
                      </p>
                      <p className="m-0 text-xs text-ink-muted">
                        An attributed claim; it does not independently confirm
                        continuity or approve new work.
                      </p>
                      <div className={LINEAGE_GRID}>
                        <ul className="pl-4 font-mono text-xs wrap-anywhere">
                          {record.before.map((reference) => (
                            <li key={reference.unitId}>
                              {unitTitle(reference.unitId, lineage.from)}
                              <p className="m-0">Unit {reference.unitId}</p>
                              <p>{reference.hunkIds.join(", ")}</p>
                            </li>
                          ))}
                        </ul>
                        <span className="text-xs text-ink-muted">
                          Authored {record.relation}
                        </span>
                        <ul className="pl-4 font-mono text-xs wrap-anywhere">
                          {record.after.map((reference) => (
                            <li key={reference.unitId}>
                              {unitTitle(reference.unitId, lineage.to)}
                              <p className="m-0">Unit {reference.unitId}</p>
                              <p>{reference.hunkIds.join(", ")}</p>
                            </li>
                          ))}
                        </ul>
                      </div>
                      <ul className="pl-4 text-xs wrap-anywhere">
                        {record.comments.map((reference) => (
                          <li key={reference.commandId}>
                            Cited comment for{" "}
                            {unitTitle(reference.unitId, reference.revisionId)}{" "}
                            · comment {reference.commandId} · unit{" "}
                            {reference.unitId} · revision {reference.revisionId}
                          </li>
                        ))}
                        {record.evidence.map((reference) => (
                          <li key={JSON.stringify(reference)}>
                            Cited evidence for{" "}
                            {unitTitle(reference.unitId, reference.revisionId)}{" "}
                            · evidence {reference.evidenceId} · unit{" "}
                            {reference.unitId} · revision {reference.revisionId}{" "}
                            · {reference.validity}
                          </li>
                        ))}
                      </ul>
                    </Disclosure>
                  </li>
                ))}
              </ul>
              {(lineage.relations.unlinkedBeforeUnitIds.length > 0 ||
                lineage.relations.unlinkedAfterUnitIds.length > 0) && (
                <p className="m-0 text-xs text-ink-muted">
                  No authored link recorded for{" "}
                  {lineage.relations.unlinkedBeforeUnitIds.length} previous and{" "}
                  {lineage.relations.unlinkedAfterUnitIds.length} target units.
                  Their relationship remains unknown.
                </p>
              )}
            </>
          )}
        </section>
      </main>
    </div>
  )
}

function Lineage({
  lineage,
  agents,
  back,
  reviewer,
  initialOpen = "renewed",
}: LineageScreenProps) {
  useHydrateAtoms([...agentsHydration(agents), [lineageOpenAtom, initialOpen]])
  if ("kind" in lineage)
    return (
      <RegisteredLineage lineage={lineage} back={back} reviewer={reviewer} />
    )
  return (
    <div className="min-h-svh bg-paper font-sans text-sm text-ink">
      <AppHeader
        repo={lineage.repo}
        branch={lineage.branch}
        commit={`${lineage.to} · cycle ${lineage.cycle}`}
      />
      <main
        {...regionTransition("lineage", 1)}
        className="mx-auto box-border flex max-w-[1080px] content-fade flex-col gap-7 px-6 pt-8 pb-24"
      >
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex flex-[1_1_420px] flex-col gap-2">
            <NeuveLink
              destination={back}
              className="inline-flex h-[30px] items-center gap-1.5 self-start rounded-lg py-0 pr-2.5 pl-1.5 text-[12.5px] text-ink-muted no-underline transition-colors duration-surface-tone ease-standard hover:bg-raised hover:text-ink motion-reduce:transition-none"
            >
              <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
              Back to {lineage.from}
            </NeuveLink>
            <h1 className="m-0 text-[30px] leading-9 font-semibold tracking-[-0.03em]">
              What {lineage.to} asks of you
            </h1>
          </div>
          <div className="flex items-center gap-3.5 text-[13px] text-ink-2">
            <span className="inline-flex items-center gap-1.5">
              <LaneGlyph lane="human-required" />
              {lineage.needYou} need you
            </span>
            <span className="inline-flex items-center gap-1.5 text-ink-muted">
              <svg width="18" height="8" viewBox="0 0 18 8" aria-hidden="true">
                <path
                  d="M1 4h16"
                  stroke="var(--nv-faint)"
                  strokeWidth="1.4"
                  strokeDasharray="3 3"
                />
              </svg>
              {lineage.carried} carried forward
            </span>
          </div>
        </div>
        <section
          aria-label={`Units of ${lineage.from} and ${lineage.to}`}
          className="flex flex-col gap-1"
        >
          <div className={cn(LINEAGE_GRID, "px-4 pb-1.5")} aria-hidden="true">
            <span className="label-mono">{lineage.from} · your review</span>
            <span />
            <span className="label-mono">{lineage.to}</span>
          </div>
          {lineage.entries.map((entry) => (
            <LineageRow key={entry.id} entry={entry} reviewer={reviewer} />
          ))}
        </section>
      </main>
    </div>
  )
}

/**
 * Commit lineage: how the units you reviewed on one commit relate to the
 * next — renewed signals, corrections that answer your comments, regrouped
 * hunks (earlier approvals stay with the hunks they covered), and units
 * carried forward with no decision needed.
 */
export function LineageScreen(props: LineageScreenProps) {
  return (
    <Provider>
      <MotionConfig reducedMotion="user">
        <Lineage {...props} />
      </MotionConfig>
    </Provider>
  )
}
