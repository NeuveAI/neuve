// Why: the readers lane writes Briefed and Explained per section, and a redesigned unit has none of
// its own. The projection decides which stops the dial offers (`deliveryStopsOf`), and the desk
// draws a stop by its own rule (`explainedShows`, and the one-section Briefed). When the two
// disagree, the dial offers a mode that shows nothing new: Explained offered from one section while
// the desk drew only the unit's own, or Briefed offered on a one-section unit while the desk showed
// its Facts. These pin both sides on the projection's own output: one section, every section, some
// sections, an old-shape unit, and that the stops agree with what the desk will draw. They also pin
// that a briefing gap reaches the unit page in Records' words, kept apart for the stops that don't
// show the briefing, and the digest's obligations as Records gives them.
import { describe, expect, test } from "bun:test"

import {
  explainedShows,
  rowExplained,
} from "@workspace/ui/neuve/shared/explained-rule"

import { LANE_FACTS } from "./lane-facts"
import type { LaneFacts } from "./lane-facts"
import { deskData, digestObligationsOf } from "./projection"
import type { HumanWork, PacketContext, Sources } from "./projection"

const HEAD = "a".repeat(40)
const BASE = "b".repeat(40)
const PATH = "apps/neuve-host/tests/projects-shared.test.ts"

type DeskUnit = PacketContext["batch"]["units"][number]

interface Explained {
  before: string
  after: string
  terms: Array<{ term: string; meaning: string }>
  cites: Array<string>
}

const explainedOf = (name: string): Explained => ({
  before: `Before ${name} (h1a2b3c4d).`,
  after: `After ${name}.`,
  terms: [{ term: "sharedWork", meaning: "One run per key." }],
  cites: [],
})

/** A new-shape section, as records-core reads one from the unit's blob. */
const section = (
  key: string,
  line: number,
  content: { briefed?: string | null; explained?: Explained | null } = {}
) => ({
  key,
  title: `${key} in projects-shared.test.ts`,
  parts: { path: PATH, kind: "symbol", name: key },
  where: null,
  renamedFrom: null,
  ownedRanges: [
    { kind: "lines", path: PATH, side: "new", startLine: line, endLine: line },
  ],
  content: {
    facts: {
      text: `${key} in projects-shared.test.ts: 1 line added.`,
      cites: [],
    },
    briefed: content.briefed ?? null,
    explained: content.explained ?? null,
  },
  lane: "agentic-review",
})

const unit = (
  id: string,
  sections: ReadonlyArray<unknown>,
  content: Record<string, unknown> = {}
) =>
  ({
    local: `u.${id}`,
    unitId: id,
    recorded: {
      kind: "unit.recorded@3",
      payload: { title: `${id}.ts: a unit`, ownedRanges: [] },
      attribution: {},
    },
    assessment: undefined,
    checkpoints: [],
    proofCurrency: {},
    content: {
      facts: { text: `${id}.ts: 2 lines added.`, cites: [] },
      ...content,
    },
    sections,
    references: [],
    referenceDetails: {},
    comments: [],
    disposition: undefined,
    judgement: {
      unitId: id,
      cycleId: "cycle-1",
      lane: "agentic-review",
      assessmentEventId: `${id}-a`,
      assessed: true,
      needs: "nothing",
      closed: false,
      closing: [],
      context: [],
      standing: null,
    },
    citations: { cited: [], resolved: 0, unresolved: 0 },
  }) as unknown as DeskUnit

const contextOf = (
  units: ReadonlyArray<DeskUnit>,
  gaps: Array<unknown> = []
) => {
  const batch = {
    local: "b.1",
    batchId: "batch-1",
    recorded: { payload: { title: "Share low-risk reads" } },
    digest: undefined,
    digestCitations: { cited: [], resolved: 0, unresolved: 0 },
    units,
    gaps: gaps.map((gap) => ({ id: (gap as { id: string }).id })),
  }
  return {
    repo: "neuve",
    range: { baseRef: "refs/heads/main", baseOid: BASE, headOid: HEAD },
    packet: {
      kind: "packet.published@2",
      batches: [batch],
      gaps,
      undecoded: [],
    },
    batch,
    newest: true,
  } as unknown as PacketContext
}

const sources: Sources = { mergeBase: BASE, head: HEAD, files: {}, blobs: {} }
const human: HumanWork = {
  viewer: undefined,
  people: {},
  dispositions: [],
  comments: [],
  sequence: 0,
}
const facts: LaneFacts = {
  ...LANE_FACTS,
  noAgentDecision: () => false,
  undecidedSections: () => new Set(),
  excluded: () => undefined,
}

const deskOf = (of: DeskUnit, gaps: Array<unknown> = []) =>
  deskData(contextOf([of], gaps), of, "agentic-review", sources, human, facts)

/** What the desk will draw at Explained, by its own rule, from the projection's output. */
const drawn = (desk: ReturnType<typeof deskOf>) =>
  explainedShows(desk.delivery?.explained, rowExplained(desk.unit.sections))

describe("Explained per section: the stops and the desk agree", () => {
  test("one section: its Explained is the unit's, and Explained is offered", () => {
    const desk = deskOf(
      unit("one", [
        section("imports", 1, { explained: explainedOf("imports") }),
      ])
    )
    expect(desk.delivery?.stops).toContain("explained")
    expect(desk.delivery?.explained).toEqual({
      before: "Before imports.",
      after: "After imports.",
      terms: [{ term: "sharedWork", meaning: "One run per key." }],
    })
    expect(drawn(desk)).toBe("unit")
  })

  test("every section explained: rows, with no Explained of the unit's own", () => {
    const desk = deskOf(
      unit("all", [
        section("imports", 1, { explained: explainedOf("imports") }),
        section("cold", 12, { explained: explainedOf("cold") }),
      ])
    )
    expect(desk.delivery?.stops).toContain("explained")
    expect(desk.delivery).not.toHaveProperty("explained")
    expect(desk.unit.sections?.map((row) => row.explained?.after)).toEqual([
      "After imports.",
      "After cold.",
    ])
    expect(drawn(desk)).toBe("rows")
  })

  test("some sections explained and some not: Explained is not offered, and the desk draws none", () => {
    const desk = deskOf(
      unit("some", [
        section("imports", 1, { explained: explainedOf("imports") }),
        section("cold", 12),
      ])
    )
    expect(desk.delivery?.stops).not.toContain("explained")
    expect(desk.delivery).not.toHaveProperty("explained")
    expect(drawn(desk)).toBeUndefined()
  })

  test("an old-shape unit: only its own Explained counts, as before", () => {
    // Assembled sections, no key: the desk's rows are its Briefed split by
    // title and carry no Explained, so a section's alone must offer none.
    const assembled = (id: string) => ({
      id,
      title: `${id} in projects.ts`,
      ownedRanges: [],
      content: {
        facts: { text: `${id}: 1 line added.`, cites: [] },
        briefed: null,
        explained: explainedOf(id),
      },
    })
    const old = (content: Record<string, unknown>) =>
      ({
        ...unit("old", [assembled("a"), assembled("b")], content),
        recorded: {
          kind: "unit.recorded@2",
          payload: { title: "old.ts", ownedRanges: [] },
          attribution: {},
        },
      }) as unknown as DeskUnit
    const without = deskOf(old({}))
    expect(without.delivery?.stops).not.toContain("explained")
    expect(drawn(without)).toBeUndefined()
    const own = deskOf(old({ explained: explainedOf("unit") }))
    expect(own.delivery?.stops).toContain("explained")
    expect(own.delivery?.explained?.after).toBe("After unit.")
    expect(drawn(own)).toBe("unit")
  })

  test("one section's Briefed is the unit's Briefed, as the stops offer it", () => {
    const claim = "Two cold checkouts now share one probe."
    const desk = deskOf(
      unit("brief", [section("cold", 12, { briefed: claim })])
    )
    expect(desk.delivery?.stops).toContain("briefed")
    expect(desk.unit.briefing).toEqual([{ kind: "text", text: claim }])
  })
})

describe("a briefing gap on the unit page", () => {
  test("Records' words lead the briefing and are kept apart for Facts and Explained", () => {
    const detail =
      "The briefing of one.ts couldn't be written in this run, so it shows what code wrote."
    const desk = deskOf(unit("one", [section("imports", 1)]), [
      {
        id: "gap-1",
        kind: "gap.disclosed@1",
        attribution: { unitIds: ["one"] },
        payload: { kind: "briefing-failed", detail },
      },
    ])
    expect(desk.unit.briefingNotes).toEqual([detail])
    expect(desk.unit.briefing[0]).toEqual({ kind: "text", text: detail })
  })

  test("a unit with no gap carries no notes apart", () => {
    expect(
      deskOf(unit("one", [section("imports", 1)])).unit
    ).not.toHaveProperty("briefingNotes")
  })
})

describe("the digest's obligations across units", () => {
  test("statuses in code's words, units by handle, an unknown overall or unit left out", () => {
    const a = unit("a", [])
    const b = unit("b", [])
    const obligations = digestObligationsOf({
      units: [a, b],
      digest: {
        digest: "",
        obligations: [
          {
            row: "b1.r1",
            text: "Cold checkouts share one probe (h1a2b3c4d)",
            basis: "done-when",
            overall: "met on 1 of 2 units",
            units: [
              { unit: "u.a", status: "met", required: true },
              { unit: "u.b", status: "met", required: false },
              { unit: "u.gone", status: "met", required: true },
            ],
          },
          {
            row: "b1.r2",
            text: "A failed probe is retried",
            overall: "partly",
            units: [{ unit: "u.b", status: "not-met", required: true }],
          },
        ],
      },
    })
    expect(obligations).toEqual([
      {
        text: "Cold checkouts share one probe",
        basis: "done-when",
        overall: { kind: "partly", met: 1, of: 2 },
        units: [
          { unitId: "a", title: "a.ts: a unit", status: "met" },
          { unitId: "b", title: "b.ts: a unit", status: "not-required" },
        ],
      },
      {
        text: "A failed probe is retried",
        basis: "gathered",
        units: [{ unitId: "b", title: "b.ts: a unit", status: "not-met" }],
      },
    ])
  })

  test("a digest without obligations gives none", () => {
    expect(
      digestObligationsOf({
        units: [],
        digest: { digest: "Reads share one run." },
      })
    ).toEqual([])
  })
})
