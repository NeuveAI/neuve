/**
 * The batch overview on a redesigned review, built like the owner's batch
 * of 14 November (`desk-evidence/owner-batch/show.json`): the digest the
 * readers lane's briefing step writes, with links to units, code's
 * verification and each ticket item across units; code's digest for the
 * generated batch; and code's digest when the briefing's digest failed.
 * Shaped as the BFF's projection gives them; controlled UI data.
 */
import {
  agentRegistryFixture,
  batchCounts,
} from "@workspace/ui/fixtures/review-batch.fixtures"
import {
  LANES_REVISION,
  R1,
} from "@workspace/ui/fixtures/lanes-scenario.fixtures"
import {
  REDESIGNED_BATCH_TITLE,
  REDESIGNED_BATCH_UNITS,
  REDESIGNED_UNITS,
} from "@workspace/ui/fixtures/redesigned-desk.fixtures"
import type {
  BatchOverviewData,
  BatchUnit,
  BriefingSegment,
  DigestObligation,
  JudgmentUnit,
  OverviewUnit,
  ReviewLane,
} from "@workspace/ui/neuve/types"

const { CHECKOUT, LOCATE, PROBE, PACKAGE, PROJECTS_TEST, RECORDS_TEST } =
  REDESIGNED_UNITS

/** The overview's lane names and lines. */
const LANES: Record<ReviewLane, { name: string; line: string }> = {
  "human-required": {
    name: "Human-required",
    line: "Only you can decide these.",
  },
  "human-suggested": {
    name: "Human-suggested",
    line: "Agent approved. Applies unless you step in.",
  },
  "agentic-review": {
    name: "Agentic review",
    line: "2 approved · 0 sent back to the implementer.",
  },
  "static-automation": {
    name: "Static automation",
    line: "Generated code. All passed.",
  },
}

const agentReview = {
  actor: { kind: "agent" as const, agent: R1 },
  verdict: "approved" as const,
}

const NO_AGENT_DECISION = new Set<string>([CHECKOUT.id, LOCATE.id])

/** A unit as the overview lists it: an agent's review outside human-required work. */
const listed = (unit: BatchUnit & { lane: ReviewLane }): OverviewUnit => ({
  id: unit.id,
  title: unit.title,
  lane: unit.lane,
  ...(NO_AGENT_DECISION.has(unit.id) ? { noAgentDecision: true as const } : {}),
  ...(unit.lane === "human-required" ? {} : { review: agentReview }),
})

const judged = (unit: BatchUnit): JudgmentUnit => ({
  id: unit.id,
  title: unit.title,
  ...(NO_AGENT_DECISION.has(unit.id) ? { noAgentDecision: true as const } : {}),
  files: 1,
  hunks: 1,
  markers: 0,
})

/** "Share low-risk reads", its units as the overview has them. */
function lowRiskReads(
  contextualBriefing: BatchOverviewData["contextualBriefing"],
  briefing: string
): BatchOverviewData {
  const units = REDESIGNED_BATCH_UNITS
  return {
    repo: "neuve",
    title: REDESIGNED_BATCH_TITLE,
    ticket: "",
    branch: "main~6..main",
    revision: LANES_REVISION,
    briefing,
    contextualBriefing,
    ...batchCounts(units, LANES),
    units: units.flatMap((unit) =>
      unit.lane ? [listed({ ...unit, lane: unit.lane })] : []
    ),
    judgment: units
      .filter((unit) => unit.lane === "human-required")
      .map(judged),
    agents: agentRegistryFixture,
  }
}

const unitPhrase = (text: string, unit: { id: string }): BriefingSegment => ({
  kind: "phrase",
  text,
  target: { kind: "unit", unitId: unit.id },
})

/** The model's digest: what changed, its phrases linking to the units. */
const MODEL_DIGEST: Array<BriefingSegment> = [
  { kind: "text", text: "Cold reads now share one run per key. " },
  unitPhrase("Checkouts of one folder", CHECKOUT),
  {
    kind: "text",
    text: " share one Git probe and cache only a probe that found a head, and ",
  },
  unitPhrase("locating a folder's store", LOCATE),
  {
    kind: "text",
    text: " shares one discovery and no longer caches a failed one. The tests run two cold callers together and count the probes.",
  },
]

/** Code's verification, from the batch's checkpoint proof states (11.16). */
const CODE_VERIFICATION =
  "Of 5 checkpoints, 1 has thin proof and 4 have none: nothing names what proves that workspace dependencies resolve in every affected build."

/**
 * Each ticket item across the batch's units, as code writes it (10.87). A
 * unit of a file with more than one unit keeps its lane words for screen
 * readers, as the projection gives them: the digest names no lane.
 */
export const MODEL_DIGEST_OBLIGATIONS: Array<DigestObligation> = [
  {
    text: "Concurrent cold checkouts of one folder run one Git probe",
    basis: "done-when",
    overall: { kind: "partly", met: 2, of: 3 },
    units: [
      {
        unitId: CHECKOUT.id,
        title: CHECKOUT.title,
        laneWords: "human required",
        status: "met",
      },
      {
        unitId: PROBE.id,
        title: PROBE.title,
        laneWords: "human required",
        status: "no-evidence",
      },
      { unitId: PACKAGE.id, title: PACKAGE.title, status: "not-required" },
      { unitId: PROJECTS_TEST.id, title: PROJECTS_TEST.title, status: "met" },
    ],
  },
  {
    text: "A failed discovery is not cached; the next caller retries",
    basis: "done-when",
    overall: { kind: "not-met" },
    units: [
      {
        unitId: LOCATE.id,
        title: LOCATE.title,
        laneWords: "human required",
        status: "no-evidence",
      },
      {
        unitId: PROBE.id,
        title: PROBE.title,
        laneWords: "human required",
        status: "not-met",
      },
      { unitId: RECORDS_TEST.id, title: RECORDS_TEST.title, status: "met" },
    ],
  },
]

/**
 * The briefing step's digest of "Share low-risk reads": the model's words
 * linking to its units, code's verification under "What to check", each
 * ticket item across units, and the model's one uncertainty.
 */
export const modelDigestOverviewFixture = lowRiskReads(
  {
    segments: MODEL_DIGEST,
    toCheck: [{ kind: "text", text: CODE_VERIFICATION }],
    obligations: MODEL_DIGEST_OBLIGATIONS,
    markers: {},
    limitations: [
      "Whether StoreNotFound reaches callers that expect a path isn't shown by this batch.",
    ],
  },
  "Cold reads now share one run per key."
)

/**
 * The same digest where the units with no evidence have no proof recorded
 * for their file: each says Missing after its link, as its unit page's row
 * does. The overall status stays the digest's.
 */
export const MISSING_PROOF_OBLIGATIONS: Array<DigestObligation> =
  MODEL_DIGEST_OBLIGATIONS.map((obligation) => ({
    ...obligation,
    units: obligation.units.map((unit) =>
      unit.status === "no-evidence"
        ? { ...unit, proofState: "missing" as const }
        : unit
    ),
  }))

export const missingProofOverviewFixture = lowRiskReads(
  {
    segments: MODEL_DIGEST,
    toCheck: [{ kind: "text", text: CODE_VERIFICATION }],
    obligations: MISSING_PROOF_OBLIGATIONS,
    markers: {},
    limitations: [
      "Whether StoreNotFound reaches callers that expect a path isn't shown by this batch.",
    ],
  },
  "Cold reads now share one run per key."
)

/** Unit phrases long enough to wrap in a narrow digest. */
export const WRAPPING_DIGEST_LINKS = [
  "no longer repeat a probe that failed or found no head for the same folder",
  "keeps the pending work for one folder that every waiting caller shares",
]

/**
 * The model's digest with unit links that wrap onto a second line: each
 * line of a link is underlined up to its last word, never past it.
 */
export const wrappingLinksOverviewFixture = lowRiskReads(
  {
    segments: [
      {
        kind: "text",
        text: "Cold reads now share one run per key. Checkouts ",
      },
      unitPhrase(WRAPPING_DIGEST_LINKS[0]!, CHECKOUT),
      { kind: "text", text: ", and locating a store " },
      unitPhrase(WRAPPING_DIGEST_LINKS[1]!, LOCATE),
      { kind: "text", text: " until it settles." },
    ],
    markers: {},
    limitations: [],
  },
  "Cold reads now share one run per key."
)

/** Code's line under a digest it put together itself. */
export const CODE_DIGEST_LIMITATION =
  "This briefing was put together by code from each unit's facts."

/** What Records says when the briefing's digest failed; the readers lane writes the words. */
export const DIGEST_GAP_NOTE =
  "The batch digest couldn't be written in this run, so code's is shown."

const CODE_DIGEST_TEXT =
  '7 units in 5 files for "Share low-risk reads". checkout in projects.ts: 11 lines added and 6 removed. locate in records.server.ts: 20 lines added and 7 removed. "cold checkouts share Git probes, cache commits, and recheck empty folders" in projects-shared.test.ts: 53 lines added.'

/**
 * A digest gap: the briefing's digest of "Share low-risk reads" failed, so
 * the overview shows code's digest with its limitation and the gap's line.
 */
export const digestGapOverviewFixture = lowRiskReads(
  {
    segments: [{ kind: "text", text: CODE_DIGEST_TEXT }],
    markers: {},
    limitations: [CODE_DIGEST_LIMITATION, DIGEST_GAP_NOTE],
  },
  CODE_DIGEST_TEXT
)

const LOCKFILE = {
  id: "01M7C5G7NR000D79S1ZJCY4X9Z",
  title: "bun.lock: lines 95, 155 and 256",
}

const GENERATED_DIGEST =
  '1 unit in 1 file for "Lockfiles and generated files". bun.lock at line 95: 1 line added. bun.lock at line 155: 1 line added. bun.lock at line 256: 1 line added.'

/**
 * The generated batch: no model call, so code's digest and its limitation.
 * Its one unit is a lockfile no agent read.
 */
export const generatedDigestOverviewFixture: BatchOverviewData = (() => {
  const unit: BatchUnit = { ...LOCKFILE, lane: "static-automation" }
  return {
    repo: "neuve",
    title: "Lockfiles and generated files",
    ticket: "",
    branch: "main~6..main",
    revision: LANES_REVISION,
    briefing: GENERATED_DIGEST,
    contextualBriefing: {
      segments: [{ kind: "text", text: GENERATED_DIGEST }],
      markers: {},
      limitations: [CODE_DIGEST_LIMITATION],
    },
    ...batchCounts([unit], LANES),
    notRead: 1,
    units: [{ ...unit, excluded: { reason: "lockfile" } }],
    judgment: [],
    agents: agentRegistryFixture,
  }
})()
