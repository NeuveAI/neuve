// Why: these fields decide what a person is told needs them. A unit no agent decided must read as
// human-required work with no suggested review, named by its file and lines; a rise in review lane
// is shown only when the earlier lane was lower; batches still to publish must reach the overview
// and the Reviews page without ever counting as waiting on a person, and the header says a review
// stopped short only when no run of it is going or queued; and what a batch removes,
// disables or narrows leads its briefing and a unit's facts and findings. The records behind these
// are not built yet, so the projection reads them through one seam (`lane-facts.ts`); these tests
// pass synthetic answers at the projection's boundary.
import { expect, test } from "bun:test"
import type { ReviewList } from "@neuve/records-core"
import type { ReviewLane } from "@workspace/ui/neuve/types"

import { LANE_FACTS } from "./lane-facts"
import type { LaneFacts } from "./lane-facts"
import {
  deskBatchContext,
  deskData,
  overviewData,
  reviewBatches,
} from "./projection"
import type { HumanWork, PacketContext, Sources } from "./projection"
import { NO_STANDING, summaryOf } from "./reviews.server"

type Lane =
  "human-required" | "human-suggested" | "agentic" | "static-automation"

const CITATIONS = { cited: [], resolved: 0, unresolved: 0 }
const HEAD = "5fa1ba94d6a0000000000000000000000000000a"
const BASE = "c0c47cea00000000000000000000000000000000b"

const lines = (path: string, start: number, end: number) => ({
  kind: "lines" as const,
  hunkId: `h${start}`,
  path,
  side: "new" as const,
  startLine: start,
  endLine: end,
})

const comment = (id: string, path: string, line: number) => ({
  kind: "comment.recorded@2" as const,
  id,
  actor: "agent-finder",
  occurredAt: "2026-11-12T09:00:00.000Z",
  payload: {
    body: `Finding ${id}`,
    anchor: { path, side: "new", startLine: line, endLine: line },
  },
})

const unit = (
  id: string,
  title: string,
  lane: Lane,
  options: {
    path: string
    ranges?: ReadonlyArray<ReturnType<typeof lines>>
    verdict?: "approve" | "request-changes"
    sections?: ReadonlyArray<{ id: string; title: string }>
    comments?: ReadonlyArray<ReturnType<typeof comment>>
  }
) => {
  const disposition = options.verdict && {
    kind: "disposition.recorded@2" as const,
    id: `${id}-d`,
    actor: "agent-reviewer",
    payload: { verdict: options.verdict },
  }
  return {
    local: id,
    unitId: id,
    recorded: {
      payload: {
        title,
        ownedRanges: options.ranges ?? [lines(options.path, 1, 9)],
      },
      attribution: {},
    },
    assessment: undefined,
    checkpoints: [],
    proofCurrency: {},
    content: options.sections
      ? {
          briefed: {
            text: [
              "Lead.",
              ...options.sections.map((s) => `${s.title}: the claim.`),
            ].join("\n\n"),
          },
        }
      : {},
    ...(options.sections
      ? {
          sections: options.sections.map((section) => ({
            ...section,
            ownedRanges: [],
          })),
        }
      : {}),
    references: [],
    referenceDetails: {},
    comments: options.comments ?? [],
    disposition,
    judgement: {
      unitId: id,
      cycleId: "cycle-1",
      lane,
      assessmentEventId: `${id}-a`,
      // Records holds an assessment for every unit: the one no agent
      // decided too (its sections say so), as the records design has it.
      assessed: true,
      needs: "a-disposition",
      closed: false,
      closing: [],
      context: [],
      standing: disposition
        ? {
            eventId: disposition.id,
            actorId: "agent-reviewer",
            actorKind: "agent",
            verdict: options.verdict,
          }
        : null,
    },
    citations: CITATIONS,
  }
}

// The shared scenario's first batch, "Share links expire on a schedule".
const expiry = unit(
  "u-expiry",
  "Expired links refuse new sessions",
  "human-required",
  {
    path: "src/sharing/expiry.ts",
    comments: [
      comment("c-1", "src/sharing/expiry.ts", 2),
      comment("c-2", "src/sharing/expiry.ts", 3),
    ],
    sections: [
      { id: "s-refuse", title: "Refuse new sessions" },
      { id: "s-never", title: "Drop links that never expire" },
    ],
  }
)
const admins = unit(
  "u-admins",
  "Admins can extend an expired link",
  "human-required",
  { path: "src/sharing/access-policy.ts" }
)
const SCHEDULE_TITLE = "src/sharing/schedule.ts: 2 hunk(s), +40 -3 lines"
const schedule = unit("u-schedule", SCHEDULE_TITLE, "human-required", {
  path: "src/sharing/schedule.ts",
  // An agent's disposition Records holds anyway: the desk must not show it
  // as a suggested review on a unit no agent decided.
  verdict: "approve",
  ranges: [
    lines("src/sharing/schedule.ts", 71, 90),
    lines("src/sharing/schedule.ts", 12, 48),
  ],
})
const timeZone = unit(
  "u-time-zone",
  "Expiry dates accept a time zone",
  "human-suggested",
  { path: "src/sharing/expiry.ts", verdict: "approve" }
)
const timeLeft = unit(
  "u-time-left",
  "Link list shows time left",
  "human-suggested",
  {
    path: "src/ui/link-list.tsx",
    verdict: "request-changes",
    sections: [
      { id: "s-count", title: "Count down the time left" },
      { id: "s-format", title: "Format it per locale" },
    ],
  }
)
const rename = unit("u-rename", "Rename the expiry constants", "agentic", {
  path: "src/sharing/expiry.ts",
  verdict: "approve",
})

const batch = {
  local: "b1",
  batchId: "batch-1",
  recorded: { payload: { title: "Share links expire on a schedule" } },
  digest: { digest: "Share links now expire on a schedule." },
  digestCitations: CITATIONS,
  assembled: undefined,
  units: [expiry, admins, schedule, timeZone, timeLeft, rename],
}

const context = {
  repo: "acme/docs-app",
  range: { baseRef: "refs/heads/main", baseOid: BASE, headOid: HEAD },
  packet: { batches: [batch], gaps: [], undecoded: [] },
  batch,
  newest: true,
} as unknown as PacketContext

/** The seam's answers for this scenario. */
const facts: LaneFacts = {
  // Also answered for a human-suggested unit, which the projection must drop:
  // the mark belongs to human-required work only.
  noAgentDecision: (u) => ["u-schedule", "u-time-left"].includes(u.unitId),
  // Code wrote its title, as for any unit no agent decided.
  titledByCode: (u) => u.unitId === "u-schedule",
  undecidedSections: (u) =>
    new Set(
      u.unitId === "u-expiry"
        ? ["s-never"]
        : u.unitId === "u-time-left"
          ? ["s-count"]
          : []
    ),
  raisedFrom: (u) =>
    (
      ({
        // Rose from agentic review: a rise.
        "u-expiry": "agentic-review",
        // Was in the same lane: no rise.
        "u-admins": "human-required",
        // Was in a higher lane: a fall, never shown as a rise.
        "u-time-zone": "human-required",
        // Rose from static automation.
        "u-rename": "static-automation",
      }) as Partial<Record<string, ReviewLane>>
    )[u.unitId],
  pendingBatches: () => 2,
  listedPendingBatches: () => 2,
  removedSegments: () => [
    {
      text: "Links with no expiry date no longer stay open for ever: they now expire after 30 days (b1.f2).",
      unitId: "u-expiry",
    },
    { text: "`ShareLink.neverExpires` is removed.", unitId: "u-expiry" },
  ],
  // The second of each list removes something.
  removalFirst: (_u, list) => [
    ...list.filter((entry) => entry.id === "s-never" || entry.id === "c-2"),
    ...list.filter((entry) => entry.id !== "s-never" && entry.id !== "c-2"),
  ],
  carriedDecisions: () => [],
  excluded: () => undefined,
}

test("a unit no agent decided is human-required work with no review, named by its file and lines", () => {
  const data = overviewData(context, undefined, facts)
  const row = data.judgment.find((entry) => entry.id === "u-schedule")
  expect(row).toMatchObject({ title: SCHEDULE_TITLE, noAgentDecision: true })
  expect(row?.untitled).toEqual({
    files: [
      {
        path: "src/sharing/schedule.ts",
        lines: [
          { start: 12, end: 48 },
          { start: 71, end: 90 },
        ],
      },
    ],
  })
  const listed = (data.units ?? []).find((entry) => entry.id === "u-schedule")
  expect(listed).toMatchObject({
    lane: "human-required",
    noAgentDecision: true,
  })
  expect(listed).not.toHaveProperty("review")
  // Units an agent decided keep their written titles and say nothing of it.
  for (const other of (data.units ?? []).filter(
    (entry) => entry.id !== "u-schedule"
  )) {
    expect(other).not.toHaveProperty("noAgentDecision")
    expect(other).not.toHaveProperty("untitled")
  }

  const desk = deskData(
    context,
    schedule as unknown as PacketContext["batch"]["units"][number],
    "human-required",
    { mergeBase: BASE, head: HEAD, files: {}, blobs: {} },
    {
      viewer: undefined,
      people: {},
      dispositions: [],
      comments: [],
      sequence: 0,
    },
    facts
  )
  expect(desk.unit.noAgentDecision).toBe(true)
  expect(desk.unit).not.toHaveProperty("attribution")

  // The same answers for a human-suggested unit, unit-level and per section,
  // are dropped: it keeps its agent's review and says nothing of a decision.
  const suggested = deskData(
    context,
    timeLeft as unknown as PacketContext["batch"]["units"][number],
    "human-suggested",
    { mergeBase: BASE, head: HEAD, files: {}, blobs: {} },
    {
      viewer: undefined,
      people: {},
      dispositions: [],
      comments: [],
      sequence: 0,
    },
    facts
  )
  expect(suggested.unit).not.toHaveProperty("noAgentDecision")
  expect(suggested.unit.sections?.map((section) => section.id)).toEqual([
    "s-count",
    "s-format",
  ])
  for (const section of suggested.unit.sections ?? [])
    expect(section).not.toHaveProperty("noAgentDecision")
  expect(suggested.unit.attribution?.outcome).toBe("changes-requested")
  expect(
    (data.units ?? []).find((entry) => entry.id === "u-time-left")
  ).not.toHaveProperty("noAgentDecision")
  expect(
    desk.railUnits.find((entry) => entry.id === "u-schedule")
  ).toMatchObject({
    noAgentDecision: true,
    untitled: { files: [{ path: "src/sharing/schedule.ts" }] },
  })
})

test("a rise in review lane is shown only when the earlier lane was lower", () => {
  const data = overviewData(context, undefined, facts)
  const raised = Object.fromEntries(
    (data.units ?? []).map((entry) => [entry.id, entry.raisedFrom])
  )
  expect(raised).toEqual({
    "u-expiry": "agentic-review",
    "u-admins": undefined,
    "u-schedule": undefined,
    "u-time-zone": undefined,
    "u-time-left": undefined,
    "u-rename": "static-automation",
  })
  expect(
    data.judgment.find((entry) => entry.id === "u-expiry")?.raisedFrom
  ).toBe("agentic-review")
  const rail = deskBatchContext(context, facts).elsewhere
  expect(
    rail.flatMap((group) =>
      (group.units ?? []).map((entry) => [entry.id, entry.raisedFrom])
    )
  ).toEqual([
    ["u-time-zone", undefined],
    ["u-time-left", undefined],
    ["u-rename", "static-automation"],
  ])
  // The rail names the human-suggested group in full.
  expect(rail.map((group) => group.label)).toEqual([
    "Human-suggested",
    "Agentic review",
    "Static automation",
  ])
})

test("batches still to publish reach the overview and the Reviews page, never as waiting on a person", () => {
  const data = overviewData(context, undefined, facts)
  expect(data.batches?.pending).toBe(2)
  // The three published human-required units, nothing of the two batches to come.
  expect(data.needYou).toBe(3)
  expect(data.batches?.all).toEqual([
    expect.objectContaining({ id: "batch-1", unitCount: 6, needYou: 3 }),
  ])
  // With nothing pending the field is left out.
  expect(overviewData(context).batches).not.toHaveProperty("pending")
  // A load that did not read the review's runs says nothing of a stop.
  expect(data.batches).not.toHaveProperty("stopped")

  const listed: ReviewList.ListedReview = {
    cycleId: "cycle-1",
    range: { baseRef: "refs/heads/main", baseOid: BASE, headOid: HEAD },
    runId: "run-1",
    // Its newest run ended with batches unpublished.
    state: "timed-out",
    at: "2026-11-12T09:00:00.000Z",
    batches: [
      {
        batchId: "batch-1",
        title: "Share links expire on a schedule",
        units: batch.units.map((u) => ({
          unitId: u.unitId,
          lane: u.judgement.lane,
        })),
      },
    ],
    manifestIssue: undefined,
  }
  const summary = summaryOf(listed, NO_STANDING, new Set(), undefined, facts)
  // The state is the listing's; the pending count says the rest.
  expect(summary.pendingBatches).toBe(2)
  expect(summary.state).toBe("timed-out")
  expect(summary.gate).toHaveLength(5)
  expect(summary.batches).toEqual([
    expect.objectContaining({ id: "batch-1", needYou: 5 }),
  ])
  const failed = summaryOf(
    { ...listed, state: "failed" },
    NO_STANDING,
    new Set(),
    undefined,
    facts
  )
  expect(failed.state).toBe("failed")
  expect(failed.pendingBatches).toBe(2)
  const whole = summaryOf(listed, NO_STANDING, new Set(), undefined, LANE_FACTS)
  expect(whole.state).toBe("timed-out")
  expect(whole).not.toHaveProperty("pendingBatches")
})

test("a review with batches pending stopped short only when no run of it is going or queued", () => {
  const stopped = { ...context, runGoing: false } as PacketContext
  const going = { ...context, runGoing: true } as PacketContext
  expect(overviewData(stopped, undefined, facts).batches).toMatchObject({
    pending: 2,
    stopped: true,
  })
  const still = overviewData(going, undefined, facts).batches
  expect(still?.pending).toBe(2)
  expect(still).not.toHaveProperty("stopped")
  // A whole review never reads as stopped, whatever its runs.
  expect(overviewData(stopped).batches).not.toHaveProperty("stopped")
  // The desk's header reads the same batches.
  expect(reviewBatches(stopped, facts)).toMatchObject({
    pending: 2,
    stopped: true,
  })
})

test("what the batch removes leads its briefing, and a unit's facts and findings", () => {
  const data = overviewData(context, undefined, facts)
  expect(data.contextualBriefing?.removed).toEqual([
    {
      kind: "phrase",
      text: "Links with no expiry date no longer stay open for ever: they now expire after 30 days.",
      target: { kind: "unit", unitId: "u-expiry" },
    },
    { kind: "text", text: " " },
    {
      kind: "phrase",
      text: "`ShareLink.neverExpires` is removed.",
      target: { kind: "unit", unitId: "u-expiry" },
    },
  ])
  expect(data.briefing).toBe(
    "Links with no expiry date no longer stay open for ever: they now expire after 30 days. `ShareLink.neverExpires` is removed. Share links now expire on a schedule."
  )
  expect(overviewData(context).contextualBriefing).not.toHaveProperty("removed")

  const file = ["a", "b", "c", "d"].join("\n") + "\n"
  const sources: Sources = {
    mergeBase: BASE,
    head: HEAD,
    blobs: {},
    files: {
      "src/sharing/expiry.ts": {
        path: "src/sharing/expiry.ts",
        oldPath: "src/sharing/expiry.ts",
        newPath: "src/sharing/expiry.ts",
        binary: false,
        oldContents: file,
        newContents: file,
        hunks: [],
      },
    },
  }
  const human: HumanWork = {
    viewer: undefined,
    people: {},
    dispositions: [],
    comments: [],
    sequence: 0,
  }
  const desk = deskData(
    context,
    expiry as unknown as PacketContext["batch"]["units"][number],
    "human-required",
    sources,
    human,
    facts
  )
  expect(desk.unit.raisedFrom).toBe("agentic-review")
  expect(desk.unit).not.toHaveProperty("noAgentDecision")
  // Only the section no agent decided says so, as the unit's other one was decided.
  expect(
    desk.unit.sections?.map((section) => [section.id, section.noAgentDecision])
  ).toEqual([
    ["s-never", true],
    ["s-refuse", undefined],
  ])
  expect(desk.commentRecords?.map((record) => record.id)).toEqual([
    "c-2",
    "c-1",
  ])
})
