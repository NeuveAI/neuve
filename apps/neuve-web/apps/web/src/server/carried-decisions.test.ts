// Why (12 November 2026, the owner's ruling): a person's earlier decision on a unit whose sections
// are all unchanged carries and closes it, so it never asks for a new decision. Every place the desk
// asks "has a person decided this unit" must agree for a carried decision, a fresh one, and a fresh
// one given after a carried one: the overview's "Needs your decision" and counts, the decided rows,
// the header's batch menu, the rail's meter, the first unit to open. A carried approval Records holds
// back (this review disputes the unit) carries nothing: the unit waits, and the gap that says so is
// the reader's to see. A carried decision is its person's on the unit page too: the dock opens decided
// with Undo (Records lets the person retract it), the review card and the rail's rows say it is theirs,
// and once it no longer stands (undone, or decided again) the unit is theirs to decide like any other.
// These pass hand-built judgements through the seam (`carriedDecisions`); `desk-new-shape.test.ts`
// runs the Undo on a real store.
import { expect, test } from "bun:test"

import { LANE_FACTS } from "./lane-facts"
import type { CarriedDecision, LaneFacts } from "./lane-facts"
import {
  NO_PEOPLE,
  deskData,
  humanDispositions,
  overviewData,
} from "./projection"
import type { HumanWork, PacketContext, Sources } from "./projection"

type Lane = "human-required" | "human-suggested" | "agentic"
type Verdict = "approve" | "request-changes"

const CITATIONS = { cited: [], resolved: 0, unresolved: 0 }
const HEAD = "5fa1ba94d6a0000000000000000000000000000a"
const EARLIER_HEAD = "9c1e77b2000000000000000000000000000000ff"
const BASE = "c0c47cea00000000000000000000000000000000b"
const OWNER = "actor-owner"
const OTHER = "actor-other"
const PATH = "src/sharing/access-policy.ts"

/** A person's disposition as `judge` reads it: current, closing the unit. */
const judged = (eventId: string, actorId: string, verdict: Verdict) => ({
  eventId,
  unitId: "",
  actorId,
  actorKind: "human" as const,
  verdict,
})

/** A `disposition.carried@1` by a person, from the earlier review at `EARLIER_HEAD`. */
const carried = (
  id: string,
  actor: string,
  verdict: Verdict,
  restsOn: ReadonlyArray<string> = []
) =>
  ({
    kind: "disposition.carried@1",
    id,
    actor,
    payload: {
      verdict,
      restsOn,
      lineage: "carried",
      from: {
        review: "01JZ0000000000000000000R01",
        cycle: "01JZ0000000000000000000C01",
        head: EARLIER_HEAD,
        judgement: "01JZ0000000000000000000J01",
        output: "01JZ0000000000000000000L01",
        // Model time saved: 0 on a person's carried decision, never shown.
        savedMs: 0,
      },
    },
  }) as unknown as CarriedDecision

const unit = (
  id: string,
  title: string,
  lane: Lane,
  options: {
    /** The decisions that close it, newest last; the newest stands. */
    decisions?: ReadonlyArray<ReturnType<typeof judged>>
    agent?: Verdict
    comments?: ReadonlyArray<unknown>
  } = {}
) => {
  const disposition = options.agent && {
    kind: "disposition.recorded@2" as const,
    id: `${id}-agent`,
    actor: "agent-reviewer",
    payload: { verdict: options.agent },
  }
  const people = (options.decisions ?? []).map((entry) => ({
    ...entry,
    unitId: id,
  }))
  const agentEntry = disposition && {
    eventId: disposition.id,
    unitId: id,
    actorId: "agent-reviewer",
    actorKind: "agent" as const,
    verdict: options.agent,
  }
  const closing =
    lane === "human-required"
      ? people
      : [...(agentEntry ? [agentEntry] : []), ...people]
  return {
    local: id,
    unitId: id,
    recorded: {
      payload: {
        title,
        ownedRanges: [
          {
            kind: "lines" as const,
            hunkId: "h1",
            path: PATH,
            side: "new" as const,
            startLine: 1,
            endLine: 9,
          },
        ],
      },
      attribution: {},
    },
    assessment: undefined,
    checkpoints: [],
    proofCurrency: {},
    content: {},
    references: [],
    referenceDetails: {},
    comments: options.comments ?? [],
    disposition,
    judgement: {
      unitId: id,
      cycleId: "cycle-1",
      lane,
      assessmentEventId: `${id}-a`,
      assessed: true,
      needs:
        lane === "human-required" ? "a-human-disposition" : "a-disposition",
      closed: closing.length > 0,
      closing,
      context: [],
      // A person's stands over an agent's; the newest among people.
      standing: people.at(-1) ?? agentEntry ?? null,
    },
    citations: CITATIONS,
  }
}

type Unit = ReturnType<typeof unit>

const contextOf = (
  units: ReadonlyArray<Unit>,
  gaps: ReadonlyArray<unknown> = []
) => {
  const batch = {
    local: "b1",
    batchId: "batch-1",
    recorded: { payload: { title: "Share links expire on a schedule" } },
    digest: { digest: "Share links now expire on a schedule." },
    digestCitations: CITATIONS,
    assembled: undefined,
    units,
  }
  return {
    repo: "acme/docs-app",
    range: { baseRef: "refs/heads/main", baseOid: BASE, headOid: HEAD },
    packet: { batches: [batch], gaps, undecoded: [] },
    batch,
    newest: true,
  } as unknown as PacketContext
}

/** The seam's answers: the carried decisions on each unit, by its ID. */
const factsOf = (
  byUnit: Readonly<Record<string, ReadonlyArray<CarriedDecision>>>
): LaneFacts => ({
  ...LANE_FACTS,
  carriedDecisions: (u) => byUnit[u.unitId] ?? [],
})

const people: HumanWork["people"] = {
  [OWNER]: { actor: OWNER, name: "Vinicius Dallacqua", initials: "VD" },
  [OTHER]: { actor: OTHER, name: "Rosa Amaral", initials: "RA" },
}
const viewer = people[OWNER]

const SOURCES: Sources = {
  mergeBase: BASE,
  head: HEAD,
  blobs: {},
  files: {
    [PATH]: {
      path: PATH,
      oldPath: PATH,
      newPath: PATH,
      binary: false,
      oldContents: "",
      newContents: Array.from({ length: 9 }, (_, i) => `line ${i + 1}`).join(
        "\n"
      ),
      hunks: [
        {
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: 9,
          text: "@@ -0,0 +1,9 @@\n",
          added: 9,
          deleted: 0,
          changed: [{ side: "new", startLine: 1, lineCount: 9 }],
        },
      ],
    },
  },
}

const human = (dispositions: HumanWork["dispositions"] = []): HumanWork => ({
  viewer,
  people,
  dispositions,
  comments: [],
  sequence: 0,
})

/** Every place the desk and the overview ask whether a person decided, for one context. */
const asked = (context: PacketContext, facts: LaneFacts, open: Unit) => {
  // People's current decisions as the loads read them beside the packet.
  const work = human(humanDispositions(context.batch.units))
  const overview = overviewData(context, work, facts)
  const desk = deskData(
    context,
    open as unknown as PacketContext["batch"]["units"][number],
    open.judgement.lane === "agentic" ? "agentic-review" : open.judgement.lane,
    SOURCES,
    work,
    facts
  )
  return { overview, desk }
}

const expiry = () =>
  unit("u-expiry", "Expired links refuse new sessions", "human-required")
const schedule = () =>
  unit("u-schedule", "Changes to src/sharing/schedule.ts", "human-required")

test("a carried approval closes the unit: decided, never waiting, with the carried mark", () => {
  const event = carried("e-carried", OWNER, "approve")
  const admins = unit(
    "u-admins",
    "Admins can extend an expired link",
    "human-required",
    { decisions: [judged(event.id, OWNER, "approve")] }
  )
  const context = contextOf([expiry(), admins, schedule()])
  const { overview, desk } = asked(
    context,
    factsOf({ "u-admins": [event] }),
    admins
  )
  // Off "Needs your decision" everywhere, and counted alike.
  expect(overview.needYou).toBe(2)
  expect(overview.judgment.map((row) => row.id)).toEqual([
    "u-expiry",
    "u-schedule",
  ])
  expect(overview.batches?.all[0]?.needYou).toBe(2)
  // The rail: out of "Needs your decision" and its meter, into "Decided".
  expect(desk.humanRequiredTotal).toBe(2)
  expect(desk.railUnits.map((row) => row.id)).toEqual([
    "u-expiry",
    "u-schedule",
  ])
  expect(desk.humanDecidedUnitIds).toEqual([])
  // The head counts it among the batch's three human-required units.
  expect(desk.unit.position).toEqual({ index: 2, of: 3 })
  // The reader's own carried decision opens the dock decided, with Undo on it.
  expect(desk.currentDecision).toEqual({
    commandId: "e-carried",
    decision: "approve",
  })
  expect(overview.firstUnitId).toBe("u-expiry")
  // Under "Decided" as the person's review, with the earlier review's head.
  const review = {
    actor: {
      kind: "person",
      person: { id: OWNER, name: "Vinicius Dallacqua", initials: "VD" },
      isYou: true,
    },
    verdict: "approved",
    carried: "Earlier review, head 9c1e77b",
  } as const
  expect(overview.decided).toEqual([
    { id: "u-admins", title: "Admins can extend an expired link", review },
  ])
  expect(overview.units?.find((row) => row.id === "u-admins")?.review).toEqual(
    review
  )
  // The rail's "Decided" row says whose it is, and no other row does.
  expect(desk.carriedUnits?.map((row) => row.id)).toEqual(["u-admins"])
  expect(desk.carriedUnits?.[0]?.carriedReview).toEqual(review)
  for (const row of desk.railUnits)
    expect(row).not.toHaveProperty("carriedReview")
  // No ID a person can't use, and never the model time saved.
  expect(JSON.stringify(overview)).not.toContain("01JZ")
})

test("a carried request for changes reads as that person's own, with the comments it rests on", () => {
  const event = carried("e-carried", OTHER, "request-changes", [
    "c-carried",
    "c-unplaced",
  ])
  const comment = {
    kind: "comment.carried@1",
    id: "c-carried",
    actor: OTHER,
    occurredAt: "2026-11-01T09:00:00.000Z",
    payload: {
      body: "Extending an expired link must log who did it.",
      anchor: { path: PATH, side: "new", startLine: 2, endLine: 3 },
      from: { head: EARLIER_HEAD },
    },
  }
  const unplaced = {
    ...comment,
    id: "c-unplaced",
    payload: {
      body: "And say so in the audit view.",
      from: { head: EARLIER_HEAD },
    },
  }
  const admins = unit(
    "u-admins",
    "Admins can extend an expired link",
    "human-required",
    {
      decisions: [judged(event.id, OTHER, "request-changes")],
      comments: [comment, unplaced],
    }
  )
  const context = contextOf([expiry(), admins])
  const facts = factsOf({ "u-admins": [event] })
  const { overview, desk } = asked(context, facts, admins)
  expect(overview.needYou).toBe(1)
  expect(desk.humanRequiredTotal).toBe(1)
  expect(desk.carriedUnits?.map((row) => row.id)).toEqual(["u-admins"])
  expect(overview.decided?.[0]?.review).toMatchObject({
    actor: { kind: "person", person: { name: "Rosa Amaral" }, isYou: false },
    verdict: "changes_requested",
    carried: "Earlier review, head 9c1e77b",
  })
  // Its comment is the person's, on its lines; one whose lines can't be
  // placed is on the whole unit.
  const record = desk.commentRecords?.find((r) => r.id === "c-carried")
  expect(record?.author).toEqual({
    id: OTHER,
    name: "Rosa Amaral",
    initials: "RA",
  })
  expect(record?.anchor.range).toEqual({ start: 2, end: 3, side: "additions" })
  // The one with no lines is on the whole unit, as theirs, carried, with the
  // request it rests on; shown once, never among the line comments too.
  expect(desk.unit.comments).toEqual([
    {
      id: "c-unplaced",
      author: {
        kind: "person",
        person: { id: OTHER, name: "Rosa Amaral", initials: "RA" },
        isYou: false,
      },
      body: "And say so in the audit view.",
      carried: "Earlier review, head 9c1e77b",
      verdict: "changes_requested",
    },
  ])
  expect(desk.commentRecords?.map((r) => r.id)).toEqual(["c-carried"])
  // Another person's carried decision is not the reader's to undo.
  expect(desk).not.toHaveProperty("currentDecision")
})

test("a decision given after a carried one stands instead, with no mark, and nothing moves", () => {
  const event = carried("e-carried", OWNER, "approve")
  const admins = unit(
    "u-admins",
    "Admins can extend an expired link",
    "human-required",
    {
      // Records keeps the carried one as history; the fresh one is newer.
      decisions: [judged("e-fresh", OWNER, "request-changes")],
    }
  )
  const context = contextOf([expiry(), admins])
  const { overview, desk } = asked(
    context,
    factsOf({ "u-admins": [event] }),
    admins
  )
  expect(overview.needYou).toBe(1)
  expect(overview.batches?.all[0]?.needYou).toBe(1)
  // It arrived with a carried decision and a person's decision still stands
  // on it, so it stays in the rail's "Decided" group and out of the meter:
  // a reader who decides it again sees nothing move. Its row shows their
  // fresh review, unmarked, and the dock offers its undo.
  expect(desk.humanRequiredTotal).toBe(1)
  expect(desk.humanDecidedUnitIds).toEqual([])
  expect(desk.carriedUnits?.map((row) => row.id)).toEqual(["u-admins"])
  expect(desk.carriedUnits?.[0]?.carriedReview).toEqual({
    actor: {
      kind: "person",
      person: { id: OWNER, name: "Vinicius Dallacqua", initials: "VD" },
      isYou: true,
    },
    verdict: "changes_requested",
  })
  expect(desk.currentDecision).toEqual({
    commandId: "e-fresh",
    decision: "request-changes",
  })
  expect(overview.decided?.[0]?.review).toEqual({
    actor: {
      kind: "person",
      person: { id: OWNER, name: "Vinicius Dallacqua", initials: "VD" },
      isYou: true,
    },
    verdict: "changes_requested",
  })
  // A fresh decision on a unit nothing was carried onto stays under "Needs
  // your decision", counted by the meter; the overview reads the same.
  const fresh = asked(context, factsOf({}), admins)
  expect(fresh.overview.decided).toEqual(overview.decided)
  expect(fresh.desk.humanRequiredTotal).toBe(2)
  expect(fresh.desk.humanDecidedUnitIds).toEqual(["u-admins"])
  expect(fresh.desk).not.toHaveProperty("carriedUnits")
  expect(fresh.desk.currentDecision).toEqual(desk.currentDecision)
})

test("a carried decision the person undid leaves the unit waiting on them everywhere", () => {
  // Why: Records keeps the retracted carried decision among the unit's carried copies, so a desk
  // keyed on the copies alone left the unit in "Decided" with no mark and out of the meter while
  // the overview counted it as needing a decision.
  const event = carried("e-carried", OWNER, "approve")
  // After the retraction Records' judgement holds no person's decision on it.
  const admins = unit(
    "u-admins",
    "Admins can extend an expired link",
    "human-required"
  )
  const context = contextOf([expiry(), admins])
  const { overview, desk } = asked(
    context,
    factsOf({ "u-admins": [event] }),
    admins
  )
  expect(overview.needYou).toBe(2)
  expect(overview.judgment.map((row) => row.id)).toContain("u-admins")
  expect(overview).not.toHaveProperty("decided")
  expect(desk.railUnits.map((row) => row.id)).toEqual(["u-expiry", "u-admins"])
  expect(desk.humanRequiredTotal).toBe(2)
  expect(desk.humanDecidedUnitIds).toEqual([])
  expect(desk).not.toHaveProperty("carriedUnits")
  expect(desk).not.toHaveProperty("currentDecision")
})

test("without people's work the overview counts and shows no person's decision", () => {
  // Why: the fixture generator reads the batch as the review published it
  // (`people: false`); a person's decision Records holds must not reach it.
  const event = carried("e-carried", OWNER, "approve")
  const admins = unit(
    "u-admins",
    "Admins can extend an expired link",
    "human-required",
    { decisions: [judged(event.id, OWNER, "approve")] }
  )
  const timeZone = unit(
    "u-time-zone",
    "Expiry dates accept a time zone",
    "human-suggested",
    {
      agent: "request-changes",
      decisions: [judged("e-fresh", OTHER, "approve")],
    }
  )
  const context = contextOf([expiry(), admins, timeZone])
  const overview = overviewData(
    context,
    NO_PEOPLE,
    factsOf({ "u-admins": [event] })
  )
  expect(overview.needYou).toBe(2)
  expect(overview.batches?.all[0]?.needYou).toBe(2)
  expect(overview).not.toHaveProperty("decided")
  for (const row of overview.units ?? [])
    expect(row.review?.actor.kind).not.toBe("person")
  // The agent's review stands in a person's place.
  expect(
    overview.units?.find((row) => row.id === "u-time-zone")?.review
  ).toMatchObject({ actor: { kind: "agent" }, verdict: "changes_requested" })
})

test("a carried approval on human-suggested work shows as the person's review over the agent's", () => {
  const event = carried("e-carried", OWNER, "approve")
  const timeZone = unit(
    "u-time-zone",
    "Expiry dates accept a time zone",
    "human-suggested",
    {
      agent: "request-changes",
      decisions: [judged(event.id, OWNER, "approve")],
    }
  )
  const context = contextOf([expiry(), timeZone])
  const { overview, desk } = asked(
    context,
    factsOf({ "u-time-zone": [event] }),
    timeZone
  )
  // The unit page says it too: the review card is the person's, carried,
  // never "Agent requested changes", and the rail's row shows their mark.
  const theirs = {
    kind: "person",
    person: { id: OWNER, name: "Vinicius Dallacqua", initials: "VD" },
    isYou: true,
  } as const
  expect(desk.unit.attribution).toEqual({
    headline: "You approved",
    meta: "Earlier review, head 9c1e77b",
    outcome: "approved",
    person: { actor: theirs, carried: "Earlier review, head 9c1e77b" },
  })
  const railRow = desk.elsewhere
    .find((lane) => lane.lane === "human-suggested")
    ?.units?.find((entry) => entry.id === "u-time-zone")
  expect(railRow?.personReview).toEqual({
    actor: theirs,
    verdict: "approved",
    carried: "Earlier review, head 9c1e77b",
  })
  expect(railRow).not.toHaveProperty("review")
  expect(desk.currentDecision).toEqual({
    commandId: "e-carried",
    decision: "approve",
  })
  expect(
    overview.units?.find((row) => row.id === "u-time-zone")?.review
  ).toEqual({
    actor: {
      kind: "person",
      person: { id: OWNER, name: "Vinicius Dallacqua", initials: "VD" },
      isYou: true,
    },
    verdict: "approved",
    carried: "Earlier review, head 9c1e77b",
  })
  // Human-required work alone counts as needing you on the overview.
  expect(overview.needYou).toBe(1)
})

test("a carried approval held back leaves the unit waiting, and the gap that says so is shown", () => {
  const admins = unit(
    "u-admins",
    "Admins can extend an expired link",
    "human-required"
  )
  const detail =
    "Your earlier approval of Admins can extend an expired link wasn't carried, because this review disputes it."
  const gap = {
    kind: "gap.disclosed@1",
    id: "g-held",
    attribution: { unitIds: ["u-admins"] },
    payload: { kind: "earlier-approval-not-carried", detail },
  }
  const other = {
    kind: "gap.disclosed@1",
    id: "g-other",
    attribution: { unitIds: ["u-expiry"] },
    payload: { kind: "unit-reading", detail: "Something about expiry." },
  }
  const context = contextOf([expiry(), admins], [gap, other])
  const { overview, desk } = asked(context, factsOf({}), admins)
  expect(overview.needYou).toBe(2)
  expect(overview.judgment.map((row) => row.id)).toContain("u-admins")
  expect(overview).not.toHaveProperty("decided")
  expect(desk.humanDecidedUnitIds).toEqual([])
  // Where the overview says the batch's limitations, in Records' words; a
  // unit's other gaps stay with the unit as before.
  expect(overview.contextualBriefing?.limitations).toContain(detail)
  expect(overview.contextualBriefing?.limitations).not.toContain(
    "Something about expiry."
  )
  // And first on the unit's own page.
  expect(desk.unit.briefing[0]).toEqual({ kind: "text", text: detail })
})

test("every note Records writes about a unit reaches its page, never why no agent decided it", () => {
  // Why: the unit page once showed two kinds of gap only, so what the publisher withheld, cut or
  // could not carry (in its own words) reached no page; the undecided kinds' cause is never shown.
  const admins = unit(
    "u-admins",
    "Admins can extend an expired link",
    "human-required"
  )
  const gap = (
    id: string,
    kind: string,
    detail: string,
    unitIds: string[]
  ) => ({
    kind: "gap.disclosed@1",
    id,
    attribution: { unitIds },
    payload: { kind, detail },
  })
  const gaps = [
    gap("g1", "later-decision-not-carried", "A person decides it again.", [
      "u-admins",
    ]),
    gap("g2", "comment-withheld", "A finding wasn't shown.", ["u-admins"]),
    gap("g3", "undecided-failed", "Why it went undecided.", ["u-admins"]),
    gap("g4", "comment-withheld", "Another unit's.", ["u-expiry"]),
    gap("g5", "run-gap", "The run's own.", []),
  ]
  // A review in the new shape (`packet.published@2`): today's shows only
  // what it showed before (`desk-new-shape.test.ts`).
  const base = contextOf([expiry(), admins], gaps)
  const batch = { ...base.batch, gaps: [] }
  const context = {
    ...base,
    batch,
    packet: {
      ...base.packet,
      kind: "packet.published@2",
      batches: [batch],
      counts: { pending: { batches: 0 } },
    },
  } as unknown as PacketContext
  const { overview, desk } = asked(context, factsOf({}), admins)
  expect(desk.unit.briefing[0]).toEqual({
    kind: "text",
    text: "A person decides it again. A finding wasn't shown.",
  })
  const page = JSON.stringify(desk)
  for (const text of [
    "Why it went undecided.",
    "Another unit's.",
    "The run's own.",
  ])
    expect(page).not.toContain(text)
  // The overview keeps a unit's notes with the unit; the run's own are the batch's.
  expect(overview.contextualBriefing?.limitations).toEqual(["The run's own."])
})

test("comments that name no lines show once: on the change they name, else on the whole unit", () => {
  // Why: a comment with no lines, an agent's or a person's, reached no page (the unit page dropped
  // every unanchored comment), so a finding the overview links to could be missing from its unit.
  const agentComment = (id: string, payload: object) => ({
    kind: "comment.recorded@3",
    id,
    actor: "agent-reviewer",
    occurredAt: "2026-11-01T09:00:00.000Z",
    payload: { body: `Finding ${id} (h47dffd0a).`, ...payload },
  })
  const admins = unit(
    "u-admins",
    "Admins can extend an expired link",
    "human-required",
    {
      agent: "request-changes",
      comments: [
        agentComment("c-section", { section: "k-two" }),
        agentComment("c-whole", {}),
        agentComment("c-lines", {
          anchor: { path: PATH, side: "new", startLine: 2, endLine: 2 },
        }),
        agentComment("c-elsewhere", {
          anchor: {
            path: "src/not-in-diff.ts",
            side: "new",
            startLine: 1,
            endLine: 1,
          },
        }),
      ],
    }
  )
  // Two changes, so the unit's page has a row for each.
  const section = (key: string, title: string, line: number) => ({
    key,
    title,
    where: { startLine: line, endLine: line },
    parts: { path: PATH, side: "new" },
    ownedRanges: [
      {
        kind: "lines",
        path: PATH,
        side: "new",
        startLine: line,
        endLine: line,
      },
    ],
  })
  const withSections = {
    ...admins,
    recorded: { ...admins.recorded, kind: "unit.recorded@3" },
    sections: [section("k-two", "Second", 5), section("k-one", "First", 1)],
  } as unknown as Unit
  const context = contextOf([expiry(), withSections])
  const human_ = human()
  const desk = deskData(
    context,
    withSections as unknown as PacketContext["batch"]["units"][number],
    "human-required",
    SOURCES,
    {
      ...human_,
      comments: [
        {
          kind: "comment.recorded@2",
          id: "p-whole",
          actor: OWNER,
          occurredAt: "2026-11-02T09:00:00.000Z",
          payload: { body: "Looks right to me." },
        } as unknown as HumanWork["comments"][number],
      ],
    },
    factsOf({})
  )
  const agent = {
    kind: "agent" as const,
    agent: expect.objectContaining({ short: "R1" }),
  }
  // In line order, the named change's row carries its comment.
  expect(desk.unit.sections?.map((row) => [row.id, row.comments])).toEqual([
    ["k-one", undefined],
    ["k-two", [{ id: "c-section", author: agent, body: "Finding c-section." }]],
  ])
  expect(desk.unit.comments).toEqual([
    { id: "c-whole", author: agent, body: "Finding c-whole." },
    { id: "c-elsewhere", author: agent, body: "Finding c-elsewhere." },
    {
      id: "p-whole",
      author: {
        kind: "person",
        person: { id: OWNER, name: "Vinicius Dallacqua", initials: "VD" },
        isYou: true,
      },
      body: "Looks right to me.",
    },
  ])
  expect(desk.commentRecords?.map((record) => record.id)).toEqual(["c-lines"])
})

test("a whole-unit comment the person's own fresh request for changes rests on carries its mark", () => {
  // Why: the person's fresh disposition is not in the packet, so the mark of the request a comment
  // rests on reached only the agent's and a carried one; a fresh request's comment had none.
  const admins = unit(
    "u-admins",
    "Admins can extend an expired link",
    "human-required",
    {
      decisions: [judged("e-fresh", OWNER, "request-changes")],
    }
  )
  const context = contextOf([expiry(), admins])
  const comment = (id: string) =>
    ({
      kind: "comment.recorded@2",
      id,
      actor: OWNER,
      occurredAt: "2026-11-02T09:00:00.000Z",
      payload: { body: `Comment ${id}.` },
    }) as unknown as HumanWork["comments"][number]
  const desk = deskData(
    context,
    admins as unknown as PacketContext["batch"]["units"][number],
    "human-required",
    SOURCES,
    {
      ...human(humanDispositions(context.batch.units)),
      comments: [comment("p-rests"), comment("p-plain")],
      standing: { verdict: "request-changes", restsOn: ["p-rests"] },
    },
    factsOf({})
  )
  expect(desk.unit.comments?.map((entry) => [entry.id, entry.verdict])).toEqual(
    [
      ["p-rests", "changes_requested"],
      ["p-plain", undefined],
    ]
  )
})

test("a unit's hunk count is one rule on the overview, the rail and the unit page", () => {
  // Why: the rail counted any unit but the open one as one hunk (git was read for the open unit
  // alone) and the overview counted files, so "1 hunk" in a list became "2 hunks" once opened.
  const OTHER_PATH = "src/sharing/expiry.ts"
  const twoHunks = [
    { oldStart: 1, oldLines: 1, newStart: 1, newLines: 2 },
    { oldStart: 20, oldLines: 1, newStart: 21, newLines: 2 },
  ]
  const expiryUnit = {
    ...expiry(),
    recorded: {
      payload: {
        title: "Expired links refuse new sessions",
        ownedRanges: [
          {
            kind: "lines",
            path: OTHER_PATH,
            side: "new",
            startLine: 1,
            endLine: 2,
          },
          {
            kind: "lines",
            path: OTHER_PATH,
            side: "new",
            startLine: 21,
            endLine: 22,
          },
        ],
      },
      attribution: {},
    },
  } as unknown as Unit
  const admins = unit(
    "u-admins",
    "Admins can extend an expired link",
    "human-required"
  )
  const hunks = { [OTHER_PATH]: twoHunks, [PATH]: SOURCES.files[PATH]!.hunks }
  const context = { ...contextOf([expiryUnit, admins]), hunks } as PacketContext
  const overview = overviewData(context, human(), factsOf({}))
  const onAdmins = deskData(
    context,
    admins as unknown as PacketContext["batch"]["units"][number],
    "human-required",
    { ...SOURCES, hunks },
    human(),
    factsOf({})
  )
  const onExpiry = deskData(
    context,
    expiryUnit as unknown as PacketContext["batch"]["units"][number],
    "human-required",
    { ...SOURCES, files: {}, hunks },
    human(),
    factsOf({})
  )
  expect(overview.judgment.find((row) => row.id === "u-expiry")?.hunks).toBe(2)
  expect(
    onAdmins.railUnits.find((row) => row.id === "u-expiry")?.hunkCount
  ).toBe(2)
  expect(onExpiry.unit.hunkCount).toBe(2)
  expect(onExpiry.unit.stats).toContain("2 hunks")
})

test("every rail card carries the disposition the meter counts, whichever unit is open", () => {
  // Why (NEU-445): a rail card showed its tag only while open, from the open
  // unit's dock. The tag now comes from the disposition standing on each
  // unit, the one the meter counts, so a person's decision, theirs or
  // another's, is on its card whether it is open or not.
  const admins = unit(
    "u-admins",
    "Admins can extend an expired link",
    "human-required",
    { decisions: [judged("e-mine", OWNER, "approve")] }
  )
  const shared = unit(
    "u-schedule",
    "Changes to src/sharing/schedule.ts",
    "human-required",
    { decisions: [judged("e-theirs", OTHER, "request-changes")] }
  )
  const context = contextOf([expiry(), admins, shared])
  for (const open of [expiry(), admins]) {
    const { desk } = asked(context, factsOf({}), open)
    expect(
      desk.railUnits.map((row) => [row.id, row.disposition ?? null])
    ).toEqual([
      ["u-expiry", null],
      ["u-admins", "approve"],
      ["u-schedule", "request-changes"],
    ])
    expect(
      desk.railUnits.filter((row) => row.disposition).map((row) => row.id)
    ).toEqual(desk.humanDecidedUnitIds ?? [])
  }
})
