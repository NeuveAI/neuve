// Why: on a unit no agent decided, the Lane review's reasons for being unsure reach the packet as
// `content.guided.notes`, one `<section title>: <reason>` per undecided section, and they are the
// only words that tell a person why no agent could decide it. The projection is the one place that
// knows the unit's sections and its own title, so it decides when the leading title goes (one
// section, or the unit's own title, matched exactly) and reads local IDs out. On a unit only partly
// undecided, a note belongs with its section's own "No agent decision" line, placed by its exact
// leading title and never by a guess. A decided unit, or one outside human-required work, must carry
// no notes: there is no "No agent decision" line for them to sit under.
import { describe, expect, test } from "bun:test"

import { LANE_FACTS } from "./lane-facts"
import type { LaneFacts } from "./lane-facts"
import { deskData } from "./projection"
import type { HumanWork, PacketContext, Sources } from "./projection"

const HEAD = "a".repeat(40)
const BASE = "b".repeat(40)
const PATH = "apps/neuve-host/src/projects.ts"

type DeskUnit = PacketContext["batch"]["units"][number]

/** A new-shape section, as records-core reads one from the unit's blob. */
const section = (key: string, title: string, line: number) => ({
  key,
  title,
  parts: { path: PATH, kind: "symbol", name: key },
  where: null,
  renamedFrom: null,
  ownedRanges: [
    {
      kind: "lines",
      path: PATH,
      side: "new",
      startLine: line,
      endLine: line + 4,
    },
  ],
  content: {
    facts: { text: `${title}: 5 lines added.`, cites: [] },
    briefed: null,
    explained: null,
  },
  lane: "human-required",
  undecided: { reason: "unsure" },
})

/** A unit as the owner's redesigned review records one, with its notes. */
const unit = (
  id: string,
  title: string,
  sections: ReadonlyArray<ReturnType<typeof section>>,
  notes: ReadonlyArray<string> | undefined
) =>
  ({
    local: id,
    unitId: id,
    recorded: {
      payload: { title, ownedRanges: sections.flatMap((s) => s.ownedRanges) },
      attribution: {},
    },
    assessment: undefined,
    checkpoints: [],
    proofCurrency: {},
    content: {
      facts: { text: `${title}: 5 lines added.`, cites: [] },
      guided: {
        rows: [],
        review: null,
        suggestion: null,
        ...(notes ? { notes: [...notes] } : {}),
      },
    },
    sections,
    references: [],
    referenceDetails: {},
    comments: [],
    disposition: undefined,
    judgement: {
      unitId: id,
      cycleId: "cycle-1",
      lane: "human-required",
      assessmentEventId: `${id}-a`,
      assessed: true,
      needs: "a-disposition",
      closed: false,
      closing: [],
      context: [],
      standing: null,
    },
    citations: { cited: [], resolved: 0, unresolved: 0 },
  }) as unknown as DeskUnit

const CHECKOUT = "checkout in projects.ts"
const PROBE = "probe in projects.ts"

const one = unit(
  "u-checkout",
  "projects.ts (human required): checkout",
  [section("checkout", CHECKOUT, 69)],
  [
    `${CHECKOUT}: Whether a failed probe (h1a2b3c4d) releases the checkout lock is not in the owned lines.`,
  ]
)
const two = unit(
  "u-checkout-probe",
  "projects.ts (human required): checkout and 1 more",
  [section("checkout", CHECKOUT, 69), section("probe", PROBE, 90)],
  [
    `${CHECKOUT}: Whether a failed probe releases the checkout lock is not in the owned lines.`,
    `${PROBE}: The probe's retry bound comes from a caller outside this change.`,
  ]
)
/** An old-shape unit with no sections whose note names the unit itself. */
const UNIT_TITLE = "neuve-graph: line 1"
const graph = unit(
  "u-graph",
  UNIT_TITLE,
  [],
  [`${UNIT_TITLE}: The submodule moves to a commit this review cannot read.`]
)

const batch = {
  local: "b1",
  batchId: "batch-1",
  recorded: { payload: { title: "Share low-risk reads" } },
  digest: { digest: "Reads share one run." },
  digestCitations: { cited: [], resolved: 0, unresolved: 0 },
  assembled: undefined,
  units: [one, two, graph],
}

const context = {
  repo: "neuve",
  range: { baseRef: "refs/heads/main", baseOid: BASE, headOid: HEAD },
  packet: { batches: [batch], gaps: [], undecoded: [] },
  batch,
  newest: true,
} as unknown as PacketContext

const sources: Sources = { mergeBase: BASE, head: HEAD, files: {}, blobs: {} }
const human: HumanWork = {
  viewer: undefined,
  people: {},
  dispositions: [],
  comments: [],
  sequence: 0,
}

/** The seam's answer: no agent decided the units `undecided` names. */
const factsFor = (undecided: ReadonlyArray<string>): LaneFacts => ({
  ...LANE_FACTS,
  noAgentDecision: (u) => undecided.includes(u.unitId),
  undecidedSections: () => new Set(),
  excluded: () => undefined,
})
const ALL_UNDECIDED = factsFor(["u-checkout", "u-checkout-probe", "u-graph"])

const notesOf = (
  of: DeskUnit,
  facts: LaneFacts = ALL_UNDECIDED,
  lane: "human-required" | "human-suggested" = "human-required"
) => deskData(context, of, lane, sources, human, facts).unit

describe("a unit's notes on why no agent decided it", () => {
  test("one section: its title leaves the note, and local IDs are read out", () => {
    expect(notesOf(one).undecidedNotes).toEqual([
      "Whether a failed probe releases the checkout lock is not in the owned lines.",
    ])
  })

  test("several sections: each note keeps its section's title, in order", () => {
    expect(notesOf(two).undecidedNotes).toEqual([
      `${CHECKOUT}: Whether a failed probe releases the checkout lock is not in the owned lines.`,
      `${PROBE}: The probe's retry bound comes from a caller outside this change.`,
    ])
  })

  test("a note led by the unit's own title drops it", () => {
    expect(notesOf(graph).undecidedNotes).toEqual([
      "The submodule moves to a commit this review cannot read.",
    ])
  })

  test("only the exact published title is dropped", () => {
    // A different case, or no space after the colon, is not the title.
    const near = unit(
      "u-checkout",
      "projects.ts (human required): checkout",
      [section("checkout", CHECKOUT, 69)],
      [
        "Checkout in projects.ts: The lock is held across the probe.",
        `${CHECKOUT}:the lock is held across the probe.`,
      ]
    )
    expect(notesOf(near).undecidedNotes).toEqual([
      "Checkout in projects.ts: The lock is held across the probe.",
      `${CHECKOUT}:the lock is held across the probe.`,
    ])
  })

  test("a decided unit, or one outside human-required work, carries none", () => {
    // The packet holds notes on it anyway: the desk must not show them.
    expect(notesOf(one, factsFor([]))).not.toHaveProperty("undecidedNotes")
    expect(notesOf(one, ALL_UNDECIDED, "human-suggested")).not.toHaveProperty(
      "undecidedNotes"
    )
  })

  test("partly undecided: a note goes to the one undecided section it names, without its title", () => {
    const partly = unit(
      "u-partly",
      "projects.ts (human required): checkout and 2 more",
      [
        section("checkout", CHECKOUT, 69),
        section("probe", PROBE, 90),
        section("imports", "imports in projects.ts", 1),
      ],
      [
        `${PROBE}: The probe's retry bound comes from a caller outside this change.`,
        // Names a section an agent decided: not that row's, so the unit's, whole.
        `${CHECKOUT}: The lock is held across the probe.`,
        // Names no section: the unit's, whole.
        "The change reads a setting this review cannot see.",
      ]
    )
    const facts: LaneFacts = {
      ...factsFor([]),
      undecidedSections: (u) =>
        new Set(u.unitId === "u-partly" ? ["probe"] : []),
    }
    const desk = notesOf(partly, facts)
    const rows = Object.fromEntries(
      (desk.sections ?? []).map((row) => [row.id, row.undecidedNotes])
    )
    expect(rows).toEqual({
      checkout: undefined,
      probe: [
        "The probe's retry bound comes from a caller outside this change.",
      ],
      imports: undefined,
    })
    expect(desk.undecidedNotes).toEqual([
      `${CHECKOUT}: The lock is held across the probe.`,
      "The change reads a setting this review cannot see.",
    ])
    // Outside human-required work the same answers place nothing.
    const suggested = notesOf(partly, facts, "human-suggested")
    expect(suggested).not.toHaveProperty("undecidedNotes")
    for (const row of suggested.sections ?? [])
      expect(row).not.toHaveProperty("undecidedNotes")
  })

  test("partly undecided: a title two undecided sections share is not guessed at", () => {
    const twins = unit(
      "u-twins",
      "projects-shared.test.ts: imports and 1 more",
      [
        section("imports-a", "imports in projects-shared.test.ts", 1),
        section("imports-b", "imports in projects-shared.test.ts", 40),
        section("probe", PROBE, 90),
      ],
      ["imports in projects-shared.test.ts: A helper's source is not read."]
    )
    const facts: LaneFacts = {
      ...factsFor([]),
      undecidedSections: () => new Set(["imports-a", "imports-b"]),
    }
    const desk = notesOf(twins, facts)
    for (const row of desk.sections ?? [])
      expect(row).not.toHaveProperty("undecidedNotes")
    expect(desk.undecidedNotes).toEqual([
      "imports in projects-shared.test.ts: A helper's source is not read.",
    ])
  })

  test("a unit no agent decided with no notes, or empty ones, carries none", () => {
    const bare = unit("u-checkout", "projects.ts", [], undefined)
    expect(notesOf(bare)).not.toHaveProperty("undecidedNotes")
    const empty = unit("u-checkout", "projects.ts", [], [])
    expect(notesOf(empty)).not.toHaveProperty("undecidedNotes")
  })
})
