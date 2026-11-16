/*
 * Round 3 shell fixtures (unit switch, dock, batch overview, lineage). They
 * reproduce what the running app showed on 2026-10-06: live lane names, a
 * zero lane, the live judgment cells that collided, recorded limitations,
 * and a registered lineage with human and agent dispositions.
 */
import {
  REVIEW_UNIT_ID,
  REVIEWER,
  batchCounts,
  batchOverviewFixture,
  reviewDeskFixture,
} from "@workspace/ui/fixtures/review-batch.fixtures"
import type {
  BatchOverviewData,
  BatchUnit,
  RegisteredCommitLineage,
  ReviewDeskData,
} from "@workspace/ui/neuve/types"

const LIVE_REVISION = "4fc76f5d30ec8a1f2b6c9d0e7a3b5c1d9e8f7a6b"
const NEXT_REVISION = "b71e5aa9c2d4e6f8a0b1c3d5e7f9a1b2c3d4e5f6"

/**
 * The live batch's units (2026-10-06): one per lane, static empty. They are
 * the units of the registered lineage's earlier revision below.
 */
const LIVE_UNITS: Array<BatchUnit> = [
  {
    id: REVIEW_UNIT_ID,
    title: "Prepared start request and correlated acknowledgment contract",
    lane: "human-required",
  },
  {
    id: "client-retry-identity",
    title: "Client retry identity, notices and projection refresh",
    lane: "human-suggested",
  },
  {
    id: "typed-preparation-failures",
    title: "Typed preparation failures and recovery messages",
    lane: "agentic-review",
  },
]

/** The live overview's shape: one unit per lane, static empty. */
export const liveLaneOverviewFixture: BatchOverviewData = {
  ...batchOverviewFixture,
  revision: LIVE_REVISION,
  // The live lane names, and lines that are raw readiness slugs (never shown).
  ...batchCounts(LIVE_UNITS, {
    "human-required": { name: "Human required", line: "awaiting-human" },
    "human-suggested": { name: "Human suggested", line: "awaiting-human" },
    "agentic-review": { name: "Agentic review", line: "awaiting-human" },
    "static-automation": { name: "Static automation", line: "awaiting-human" },
  }),
  judgment: [
    {
      id: REVIEW_UNIT_ID,
      title: "Prepared start request and correlated acknowledgment contract",
      agentId: "i1",
      files: 2,
      hunks: 3,
      markers: 4,
    },
  ],
  contextualBriefing: {
    segments: [
      {
        kind: "text",
        text: "Revoking now also ends open sessions, reversing a May decision that kept them alive. Check where each rule lives:",
      },
      {
        kind: "cite",
        label: "Session invalidation",
        markerKey: "conflict",
        ariaLabel: "Conflict, Session invalidation",
      },
      {
        kind: "cite",
        label: "Revoke callers",
        markerKey: "graph",
        ariaLabel: "Graph, Revoke callers",
      },
    ],
    markers: reviewDeskFixture.markers,
    limitations: [
      "Submitted-source citation support is unavailable: the schema cites only captured source_evidence ranges.",
      "Schema-version 3 evidence consists of qualified observations: review-obligation coverage is not established.",
      "Retrieval returned four ranked results under a syntax-only profile.",
      "A partial provider failure skipped symbol parsing of one minified file.",
      "Surrounding original patches were retained but their text was not supplied.",
      "Stored records, shared evidence and another unit's disposition do not confer approval.",
    ],
  },
}

/**
 * A contextual briefing with a describing phrase (round 5): the overview has
 * no diff to land in, so the phrase reads as its words, beside the chips.
 */
export const contextualBriefingWithPhraseFixture: BatchOverviewData = {
  ...liveLaneOverviewFixture,
  contextualBriefing: {
    ...liveLaneOverviewFixture.contextualBriefing!,
    segments: [
      { kind: "text", text: "Revoking now also " },
      {
        kind: "phrase",
        text: "ends open sessions",
        target: { kind: "marker", markerKey: "conflict" },
      },
      {
        kind: "text",
        text: ", reversing a May decision that kept them alive. Check where each rule lives:",
      },
      ...liveLaneOverviewFixture.contextualBriefing!.segments.filter(
        (segment) => segment.kind === "cite"
      ),
    ],
  },
}

/**
 * The batch digest in its two sections: what changed, with a phrase that
 * names a unit linking to it, and what to check.
 */
export const digestSectionsOverviewFixture: BatchOverviewData = {
  ...contextualBriefingWithPhraseFixture,
  contextualBriefing: {
    ...contextualBriefingWithPhraseFixture.contextualBriefing!,
    segments: [
      ...contextualBriefingWithPhraseFixture.contextualBriefing!.segments,
      { kind: "text", text: "\n\nThe " },
      {
        kind: "phrase",
        text: "start request contract",
        target: { kind: "unit", unitId: REVIEW_UNIT_ID },
      },
      {
        kind: "text",
        text: " now carries a correlation id the acknowledgment must echo.",
      },
    ],
    toCheck: [
      {
        kind: "text",
        text: "Contract tests cover a matching acknowledgment and a stale one. Nothing yet exercises a dropped acknowledgment, so the retry path is unproven.",
      },
    ],
  },
  checkpoints: { [REVIEW_UNIT_ID]: { total: 3, unmet: 1 } },
}

/**
 * A digest whose lines lead with bold labels (10.140): an opening sentence,
 * then one line per label, a phrase that names a unit inside one of them.
 */
export const boldDigestOverviewFixture: BatchOverviewData = {
  ...digestSectionsOverviewFixture,
  contextualBriefing: {
    ...digestSectionsOverviewFixture.contextualBriefing!,
    segments: [
      {
        kind: "text",
        text: "Revoking a share link now ends the sessions it opened.\n\n**Identity:** sessions are found by the link that opened them, not by the viewer.\n**Stability:** the ",
      },
      {
        kind: "phrase",
        text: "start request contract",
        target: { kind: "unit", unitId: REVIEW_UNIT_ID },
      },
      {
        kind: "text",
        text: " keeps its shape; the acknowledgment now echoes a correlation id.",
      },
    ],
    toCheck: [
      {
        kind: "text",
        text: "Contract tests cover a matching acknowledgment and a stale one.\n**Missing proof:** nothing exercises a dropped acknowledgment, so the retry path is unproven.",
      },
    ],
  },
}

/**
 * Every other human-required unit is already decided, so after deciding
 * this one the dock offers "Back to batch".
 */
export const lastUndecidedDeskFixture: ReviewDeskData = {
  ...reviewDeskFixture,
  humanDecidedUnitIds: reviewDeskFixture.railUnits
    .map((unit) => unit.id)
    .filter((id) => id !== reviewDeskFixture.unit.id),
}

/** The other human-required units are open: the dock offers "Next unit". */
export const nextUndecidedDeskFixture: ReviewDeskData = {
  ...reviewDeskFixture,
  humanDecidedUnitIds: [],
}

/** A registered revision pair, as `/changes/<sha>` shows it live. */
export const registeredLineageFixture: RegisteredCommitLineage = {
  kind: "registered",
  repo: "neuve",
  branch: "codex/demo-prepared-start-review",
  from: LIVE_REVISION,
  to: NEXT_REVISION,
  cycle: null,
  before: {
    revisionId: LIVE_REVISION,
    sourceAvailable: true,
    limitations: [
      "Sibling responsibility remains read-only and does not expand either decision.",
    ],
    units: [
      {
        id: REVIEW_UNIT_ID,
        title: "Prepared start request and correlated acknowledgment contract",
        lane: "human-required",
        hunkIds: ["h-1", "h-2", "h-3"],
        result: "Human approved",
        deskAvailable: false,
        needsYou: false,
        dispositions: [
          {
            id: "cmd-7f2a",
            author: { kind: "human", id: REVIEWER.id, viewer: true },
            decision: "approve",
            rationale: "Approved by human reviewer",
            current: true,
            retracted: false,
          },
        ],
      },
      {
        id: "client-retry-identity",
        title: "Client retry identity, notices and projection refresh",
        lane: "human-suggested",
        hunkIds: ["h-4", "h-5"],
        result: "Human approved",
        deskAvailable: false,
        needsYou: false,
        dispositions: [
          {
            id: "cmd-5d10",
            author: { kind: "agent", id: "r1", viewer: false },
            decision: "approve",
            rationale: "Retry identity is retained across reloads.",
            current: true,
            retracted: false,
          },
          {
            id: "cmd-5d11",
            author: { kind: "human", id: REVIEWER.id, viewer: true },
            decision: "approve",
            rationale: "Human reviewer agreed with this unit disposition",
            current: true,
            retracted: false,
          },
        ],
      },
      {
        id: "typed-preparation-failures",
        title: "Typed preparation failures and recovery messages",
        lane: "agentic-review",
        hunkIds: ["h-6"],
        result: "Agent approved",
        deskAvailable: false,
        needsYou: false,
        dispositions: [
          {
            id: "cmd-91c0",
            author: { kind: "agent", id: "r1", viewer: false },
            decision: "approve",
            rationale: "Recovery messages match the typed reasons.",
            current: true,
            retracted: false,
          },
        ],
      },
    ],
  },
  after: {
    revisionId: NEXT_REVISION,
    sourceAvailable: true,
    limitations: [],
    units: [
      {
        id: "start-request-v2",
        title: "Prepared start request and correlated acknowledgment contract",
        lane: "human-required",
        hunkIds: ["h-11", "h-12"],
        result: "Decision pending",
        deskAvailable: true,
        needsYou: true,
        dispositions: [],
      },
      {
        id: "audit-v2",
        title: "Audit event for revocation",
        lane: "human-required",
        hunkIds: ["h-13"],
        result: "Human requested changes",
        deskAvailable: true,
        needsYou: false,
        dispositions: [
          {
            id: "cmd-6e20",
            author: { kind: "human", id: "maya", viewer: false },
            decision: "request-changes",
            rationale: "Record the actor on revoke.",
            current: true,
            retracted: false,
          },
        ],
      },
      {
        id: "typed-preparation-failures-v2",
        title: "Typed preparation failures and recovery messages",
        lane: "agentic-review",
        hunkIds: ["h-16"],
        result: "Agent requested changes",
        deskAvailable: true,
        needsYou: false,
        dispositions: [
          {
            id: "cmd-a41e",
            author: { kind: "agent", id: "r1", viewer: false },
            decision: "request-changes",
            rationale: "The timeout reason still maps to the generic message.",
            current: true,
            retracted: false,
          },
        ],
      },
      {
        id: "pending-assessment",
        title: "Records feed reconnect backoff",
        responsibility: {
          kind: "provisional-unassessed",
          historicalProjection: "agentic-review",
        },
        hunkIds: ["h-18"],
        result: "Assessment pending",
        deskAvailable: true,
        needsYou: false,
        dispositions: [],
      },
    ],
  },
  relations: {
    kind: "recorded",
    records: [
      {
        id: "rel-1",
        relation: "corrected",
        author: { kind: "agent", id: "i1", viewer: false },
        rationale:
          "The acknowledgment now compares the revision before registering.",
        before: [{ unitId: REVIEW_UNIT_ID, hunkIds: ["h-1", "h-2"] }],
        after: [{ unitId: "start-request-v2", hunkIds: ["h-11"] }],
        comments: [],
        evidence: [],
      },
    ],
    unlinkedBeforeUnitIds: ["client-retry-identity"],
    unlinkedAfterUnitIds: [],
  },
}
