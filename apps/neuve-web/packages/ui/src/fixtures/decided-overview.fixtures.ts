/*
 * The batch overview through the batch's states (23 October 2026): nothing
 * decided, some decided, all approved, changes requested, and the branch
 * moved past the reviewed head. A decided unit leaves "Needs your decision"
 * and the counts and shows under "Decided" with the review that stands.
 * Built from the acme batch at a real review's volume of unmet checkpoints,
 * so every number still comes from its units.
 */
import {
  RATE_LIMIT_UNIT_ID,
  REVIEWER,
  SESSIONS_UNIT_ID,
  agentChangesOf,
  overviewUnitsFixture,
  realVolumeOverviewFixture,
} from "@workspace/ui/fixtures/review-batch.fixtures"
import { startPreviewFixture } from "@workspace/ui/fixtures/review-start.fixtures"
import type { ReviewStart } from "@workspace/ui/neuve/states/review-start"
import type {
  BatchOverviewData,
  DecidedUnit,
  LineageReviewActor,
  OverviewUnit,
} from "@workspace/ui/neuve/types"

const YOU: LineageReviewActor = {
  kind: "person",
  person: REVIEWER,
  isYou: true,
}

/** Another person on the batch, whose decision also takes a unit off the list. */
const ANA: LineageReviewActor = {
  kind: "person",
  person: { id: "reviewer-ana", name: "Ana Lima", initials: "AL" },
  isYou: false,
}

type Decision = [LineageReviewActor, DecidedUnit["review"]["verdict"]]

/** `units` with their agent reviews' verdicts set by unit ID; other units as they are. */
function withAgentVerdicts(
  units: ReadonlyArray<OverviewUnit>,
  verdicts: (unit: OverviewUnit) => DecidedUnit["review"]["verdict"] | undefined
): Array<OverviewUnit> {
  return units.map((unit) => {
    const verdict = verdicts(unit)
    return unit.review?.actor.kind === "agent" && verdict
      ? { ...unit, review: { ...unit.review, verdict } }
      : unit
  })
}

/**
 * The overview once the human-required units in judgment order have these
 * decisions (null: still waiting), everything else derived from them. With
 * `agentsApproved`, every agent's review on the other lanes approved, so a
 * settled batch can show its outcome.
 */
function withDecisions(
  decisions: ReadonlyArray<Decision | null>,
  { agentsApproved = false }: { agentsApproved?: boolean } = {}
): BatchOverviewData {
  const base = realVolumeOverviewFixture
  const decided: Array<DecidedUnit> = []
  const reviews = new Map<string, DecidedUnit["review"]>()
  base.judgment.forEach((unit, i) => {
    const decision = decisions[i]
    if (!decision) return
    const review = { actor: decision[0], verdict: decision[1] }
    reviews.set(unit.id, review)
    decided.push({ id: unit.id, title: unit.title, review })
  })
  const judgment = base.judgment.filter((unit) => !reviews.has(unit.id))
  const units = withAgentVerdicts(overviewUnitsFixture, () =>
    agentsApproved ? "approved" : undefined
  ).map((unit) => {
    const review = reviews.get(unit.id)
    return review ? { ...unit, review } : unit
  })
  return {
    ...base,
    needYou: judgment.length,
    firstUnitId: (judgment[0] ?? base.judgment[0])!.id,
    judgment,
    ...(decided.length > 0 ? { decided } : {}),
    units,
    ...agentChangesOf(units),
  }
}

/** Every unit listed by lane, none decided yet. */
export const waitingOverviewFixture = withDecisions([null, null, null, null])

/** Two of the four human-required units decided by you: two still need you. */
export const someDecidedOverviewFixture = withDecisions([
  null,
  null,
  [YOU, "changes_requested"],
  [YOU, "approved"],
])

/** Every human-required unit approved, one by another person; every agent approved too. */
export const allApprovedOverviewFixture = withDecisions(
  [
    [YOU, "approved"],
    [YOU, "approved"],
    [ANA, "approved"],
    [YOU, "approved"],
  ],
  { agentsApproved: true }
)

/** Every human-required unit decided, two with changes requested; every agent approved. */
export const allDecidedOverviewFixture = withDecisions(
  [
    [YOU, "changes_requested"],
    [YOU, "approved"],
    [ANA, "changes_requested"],
    [YOU, "approved"],
  ],
  { agentsApproved: true }
)

const approvedUnits = withAgentVerdicts(
  allApprovedOverviewFixture.units!,
  (unit) =>
    unit.id === RATE_LIMIT_UNIT_ID || unit.id === SESSIONS_UNIT_ID
      ? "changes_requested"
      : undefined
)
/**
 * Every human-required unit approved, while two agents requested changes on
 * a unit each no person has decided: R1 on a human-suggested unit, R2 on an
 * agentic one. The panel names both, never an all-approved outcome.
 */
export const agentChangesOverviewFixture: BatchOverviewData = {
  ...allApprovedOverviewFixture,
  units: approvedUnits,
  ...agentChangesOf(approvedUnits),
}

const suggestedUnits = withAgentVerdicts(
  overviewUnitsFixture.filter((unit) => unit.lane !== "human-required"),
  (unit) => (unit.id === RATE_LIMIT_UNIT_ID ? "changes_requested" : "approved")
)
/**
 * No human-required unit, and the agent requested changes on one
 * human-suggested unit no person has decided (the clean-account run): the
 * panel names it, never "Nothing here needs your decision".
 */
export const agentChangesOnlyOverviewFixture: BatchOverviewData = {
  ...realVolumeOverviewFixture,
  unitCount: suggestedUnits.length,
  needYou: 0,
  firstUnitId: suggestedUnits[0]!.id,
  lanes: realVolumeOverviewFixture.lanes.map((lane) =>
    lane.lane === "human-required" ? { ...lane, count: 0 } : lane
  ),
  judgment: [],
  units: suggestedUnits,
  ...agentChangesOf(suggestedUnits),
}

/** Every human-required unit decided, one with changes requested. */
export const oneRequestedOverviewFixture = withDecisions([
  [YOU, "changes_requested"],
  [YOU, "approved"],
  [ANA, "approved"],
  [YOU, "approved"],
])

/** The branch now points past the head the batch reviewed (a3f9c2e). */
export const branchMovedStartFixture: ReviewStart =
  startPreviewFixture.status === "ready"
    ? {
        status: "ready",
        preview: {
          ...startPreviewFixture.preview,
          branch: realVolumeOverviewFixture.branch,
          headOid: "9c41d07e5b2a4f6c8d1e3a7b9c0d2e4f6a8b0c1d",
        },
      }
    : startPreviewFixture

/** A review of the moved branch, requested from the overview, running. */
export const branchMovedRunningFixture: ReviewStart = {
  status: "running",
  run: {
    subject: realVolumeOverviewFixture.branch,
    phase: { kind: "working" },
    route: "openai/gpt-6.1-sol",
    recorded: ["precompute"],
  },
}
