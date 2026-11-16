// Why: the owner ruled that a file's changes in one lane of a batch are one unit, so one
// human-required unit can hold changes an agent decided beside one it could not. The readers lane
// writes each decided change's verdict and its "Checked: …" words, and each undecided change's note,
// keyed to the change, in one of two places: the unit's `guided.sectionReviews` and
// `guided.sectionNotes`, or the section's own `review` in the sections blob. Only the projection
// joins those to the desk's rows, so it must read either place (the keyed lists first, each field
// on its own), and read the title-led `guided.notes` for the rest, leaving out a line led by the
// title of a section that has its own note, or saying that note word for word under another lead
// (the readers write both, and a reason must never show twice, nor be lost). It must also
// give a row a suggestion only on human-required work of several changes, only for a change an agent
// decided, and only when the review gave it words: a review written before that shows as before.
// The words are plain: a link reads as its phrase and a bare local ID is read out, so no phrase or
// chip comes from them.
// The unit's own suggestion is the writer's to give: the desk shows it exactly when it is written,
// never hides it for a mixed unit and never makes one up. The header's "No agent decision in this
// run" is `unit.noAgentDecision`, which the projection passes on from the lane facts and never sets
// itself (the facts' own rule, every section undecided, is tested in `desk-new-shape.test.ts`).
import { describe, expect, test } from "bun:test"

import type {
  BriefingSection,
  BriefingSegment,
} from "@workspace/ui/neuve/types"

import { LANE_FACTS } from "./lane-facts"
import type { LaneFacts } from "./lane-facts"
import { deskData } from "./projection"
import type { HumanWork, PacketContext, Sources } from "./projection"

const HEAD = "a".repeat(40)
const BASE = "b".repeat(40)
const PATH = "apps/neuve-web/apps/web/src/server/records.server.ts"

type DeskUnit = PacketContext["batch"]["units"][number]

const IMPORTS = "imports in records.server.ts"
const LOCATE = "locate in records.server.ts"
const OPEN_STORE = "openStore in records.server.ts"

/** What a section's own `review` holds in the sections blob, when given. */
type OwnReview = {
  verdict: "approve" | "request-changes" | "unsure"
  message?: string
  note?: string
}

/** A new-shape section, as records-core reads one from the unit's blob. */
const section = (
  key: string,
  title: string,
  line: number,
  review?: OwnReview
) => ({
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
      endLine: line + 2,
    },
  ],
  content: {
    facts: { text: `${title}: 3 lines added.`, cites: [] },
    briefed: null,
    explained: null,
  },
  lane: "human-required",
  ...(review ? { review } : {}),
})

/** A unit's Guided content as the readers lane writes it. */
type Guided = {
  sectionReviews?: Array<{ section: string; verdict: string; message: string }>
  sectionNotes?: Array<{ section: string; note: string }>
  notes?: Array<string>
  suggestion?: { verdict: string; message: string } | null
  review?: Record<string, unknown> | null
}

/** The shared-store unit: imports, locate and openStore, as the owner's redesigned review records one. */
const unit = (
  guided: Guided,
  reviews: Partial<Record<"imports" | "locate" | "open-store", OwnReview>> = {},
  keys: ReadonlyArray<"imports" | "locate" | "open-store"> = [
    "imports",
    "locate",
    "open-store",
  ]
) => {
  const all = {
    imports: section("imports", IMPORTS, 3, reviews.imports),
    locate: section("locate", LOCATE, 7, reviews.locate),
    "open-store": section("open-store", OPEN_STORE, 14, reviews["open-store"]),
  }
  const sections = keys.map((key) => all[key])
  return {
    local: "b1.u1",
    unitId: "u-shared",
    recorded: {
      kind: "unit.recorded@3",
      payload: {
        title: "records.server.ts: imports and 2 more",
        ownedRanges: sections.flatMap((s) => s.ownedRanges),
      },
      attribution: {},
    },
    assessment: undefined,
    checkpoints: [],
    proofCurrency: {},
    content: {
      facts: { text: "records.server.ts: 9 lines added.", cites: [] },
      guided: {
        rows: [
          {
            row: "b1.r3",
            text: "Concurrent callers locating one folder run one Git discovery",
            status: "met",
            does: "The Lane review found this met for this file.",
            evidence: [],
          },
        ],
        review: null,
        suggestion: null,
        ...guided,
      },
    },
    sections,
    references: [],
    referenceDetails: {},
    comments: [],
    disposition: undefined,
    lineage: undefined,
    carriedDecisions: [],
    judgement: {
      unitId: "u-shared",
      cycleId: "cycle-1",
      lane: "human-required",
      assessmentEventId: "u-shared-a",
      assessed: true,
      needs: "a-disposition",
      closed: false,
      closing: [],
      context: [],
      standing: null,
    },
    citations: { cited: [], resolved: 0, unresolved: 0 },
  } as unknown as DeskUnit
}

const contextOf = (of: DeskUnit) => {
  const batch = {
    local: "b1",
    batchId: "batch-1",
    recorded: { payload: { title: "Share low-risk reads" } },
    digest: undefined,
    digestCitations: { cited: [], resolved: 0, unresolved: 0 },
    units: [of],
    gaps: [],
  }
  return {
    repo: "neuve",
    range: { baseRef: "refs/heads/main", baseOid: BASE, headOid: HEAD },
    packet: { batches: [batch], gaps: [], undecoded: [] },
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

/** The seam's answer: the sections `undecided` names were not decided; `all`, none was. */
const factsFor = (
  undecided: ReadonlyArray<string>,
  all = false
): LaneFacts => ({
  ...LANE_FACTS,
  noAgentDecision: () => all,
  undecidedSections: () => new Set(all ? [] : undecided),
  excluded: () => undefined,
})
const MIXED = factsFor(["imports"])
const DECIDED = factsFor([])

const deskOf = (
  of: DeskUnit,
  facts: LaneFacts = MIXED,
  lane:
    "human-required" | "human-suggested" | "agentic-review" = "human-required"
) => deskData(contextOf(of), of, lane, sources, human, facts)

const rowsOf = (desk: ReturnType<typeof deskOf>) =>
  Object.fromEntries((desk.unit.sections ?? []).map((row) => [row.id, row]))

/** The readers' words, with a phrase link and a local ID left in: the cleaner's guard. */
const LOCATE_WORDS =
  "Checked: [a folder with no repository now throws](h1a2b3c4d@7-8) StoreNotFound, and its callers are not changed (h1a2b3c4d)."
/** The same words as the desk reads them: the link that lands nowhere here reads as its words. */
const LOCATE_READ: Array<BriefingSegment> = [
  {
    kind: "text",
    text: "Checked: a folder with no repository now throws StoreNotFound, and its callers are not changed.",
  },
]
const OPEN_STORE_WORDS =
  "Checked: openStore keeps one store per path, and every later caller gets that store."
const IMPORTS_NOTE =
  "Whether the package is a dependency of this app (h1a2b3c4d) is not in the owned lines."
const IMPORTS_NOTE_READ =
  "Whether the package is a dependency of this app is not in the owned lines."

const KEYED: Guided = {
  sectionReviews: [
    { section: "locate", verdict: "request-changes", message: LOCATE_WORDS },
    { section: "open-store", verdict: "approve", message: OPEN_STORE_WORDS },
  ],
  sectionNotes: [{ section: "imports", note: IMPORTS_NOTE }],
  // Kept during the change: the same note, title-led.
  notes: [`${IMPORTS}: ${IMPORTS_NOTE}`],
}

/** What the mixed unit's rows carry, whichever place the review was written in. */
const MIXED_ROWS: Record<
  string,
  Pick<BriefingSection, "noAgentDecision" | "undecidedNotes" | "suggestion">
> = {
  imports: { noAgentDecision: true, undecidedNotes: [IMPORTS_NOTE_READ] },
  locate: {
    suggestion: { decision: "request_changes", message: LOCATE_READ },
  },
  "open-store": {
    suggestion: {
      decision: "approve",
      message: [{ kind: "text", text: OPEN_STORE_WORDS }],
    },
  },
}

const carried = (desk: ReturnType<typeof deskOf>) =>
  Object.fromEntries(
    Object.entries(rowsOf(desk)).map(([id, row]) => [
      id,
      {
        ...(row.noAgentDecision
          ? { noAgentDecision: row.noAgentDecision }
          : {}),
        ...(row.undecidedNotes ? { undecidedNotes: row.undecidedNotes } : {}),
        ...(row.suggestion ? { suggestion: row.suggestion } : {}),
      },
    ])
  )

describe("each section's own verdict, words and note", () => {
  test("from the unit's keyed lists: each on its row, and the title-led note is not said again", () => {
    const desk = deskOf(unit(KEYED))
    expect(carried(desk)).toEqual(MIXED_ROWS)
    expect(desk.unit).not.toHaveProperty("undecidedNotes")
  })

  test("from each section's own review in the sections blob, alike", () => {
    const desk = deskOf(
      unit(
        { notes: [`${IMPORTS}: ${IMPORTS_NOTE}`] },
        {
          imports: { verdict: "unsure", note: IMPORTS_NOTE },
          locate: { verdict: "request-changes", message: LOCATE_WORDS },
          "open-store": { verdict: "approve", message: OPEN_STORE_WORDS },
        }
      )
    )
    expect(carried(desk)).toEqual(MIXED_ROWS)
    expect(desk.unit).not.toHaveProperty("undecidedNotes")
  })

  test("the keyed lists come first, each field on its own", () => {
    const desk = deskOf(
      unit(
        {
          sectionReviews: [
            {
              section: "locate",
              verdict: "request-changes",
              message: LOCATE_WORDS,
            },
          ],
          sectionNotes: [{ section: "imports", note: IMPORTS_NOTE }],
        },
        {
          imports: { verdict: "unsure", note: "An older note." },
          locate: { verdict: "approve", message: "Checked: something else." },
          // No keyed entry: its own review's words.
          "open-store": { verdict: "approve", message: OPEN_STORE_WORDS },
        }
      )
    )
    expect(carried(desk)).toEqual(MIXED_ROWS)
  })

  test("sectionNotes and guided.notes both written: each reason shows once, and none is lost", () => {
    const desk = deskOf(
      unit({
        ...KEYED,
        notes: [
          `${IMPORTS}: ${IMPORTS_NOTE}`,
          // The same section's reason in other words: its own note says it.
          `${IMPORTS}: The package's place in this app's build is not read.`,
          // Names no section: the unit's, under its header.
          "The change reads a setting this review cannot see.",
        ],
      })
    )
    expect(rowsOf(desk).imports.undecidedNotes).toEqual([IMPORTS_NOTE_READ])
    expect(desk.unit.undecidedNotes).toEqual([
      "The change reads a setting this review cannot see.",
    ])
    // A section with no note of its own keeps its title-led line, on its row.
    const two = deskOf(
      unit({
        sectionNotes: [{ section: "imports", note: IMPORTS_NOTE }],
        notes: [
          `${IMPORTS}: ${IMPORTS_NOTE}`,
          `${LOCATE}: The callers are outside this change.`,
        ],
      }),
      factsFor(["imports", "locate"])
    )
    expect(rowsOf(two).imports.undecidedNotes).toEqual([IMPORTS_NOTE_READ])
    expect(rowsOf(two).locate.undecidedNotes).toEqual([
      "The callers are outside this change.",
    ])
    expect(two.unit).not.toHaveProperty("undecidedNotes")
  })

  test("with no note of its own, the title-led guided.notes are the fallback", () => {
    const desk = deskOf(
      unit({
        sectionReviews: KEYED.sectionReviews!,
        notes: [`${IMPORTS}: ${IMPORTS_NOTE}`],
      })
    )
    expect(rowsOf(desk).imports.undecidedNotes).toEqual([IMPORTS_NOTE_READ])
    expect(desk.unit).not.toHaveProperty("undecidedNotes")
  })

  test("a unit no agent decided: each keyed note under the header, led by its section's title, and no row suggests", () => {
    const desk = deskOf(
      unit({
        sectionNotes: [
          { section: "imports", note: IMPORTS_NOTE },
          { section: "locate", note: "The callers are outside this change." },
        ],
        notes: [`${IMPORTS}: ${IMPORTS_NOTE}`],
        // Written anyway: nothing was decided, so no row shows it.
        sectionReviews: KEYED.sectionReviews!,
      }),
      factsFor([], true)
    )
    expect(desk.unit.noAgentDecision).toBe(true)
    expect(desk.unit.undecidedNotes).toEqual([
      `${IMPORTS}: ${IMPORTS_NOTE_READ}`,
      `${LOCATE}: The callers are outside this change.`,
    ])
    for (const row of desk.unit.sections ?? [])
      expect(row).not.toHaveProperty("suggestion")
  })

  test("a single-change unit no agent decided shows its reason once, though guided.notes leads it with a place", () => {
    // The owner's graph unit: the readers wrote the section's note and the
    // same reason in guided.notes, led by "neuve-graph at line 1" rather
    // than the section's title.
    const desk = deskOf(
      unit(
        {
          sectionNotes: [{ section: "imports", note: IMPORTS_NOTE }],
          notes: [
            `neuve-graph at line 1: ${IMPORTS_NOTE}`,
            // Another reason, led by a place: still the unit's, kept.
            "neuve-graph at line 1: The callers are outside this change.",
          ],
        },
        {},
        ["imports"]
      ),
      factsFor([], true)
    )
    expect(desk.unit.noAgentDecision).toBe(true)
    expect(desk.unit.undecidedNotes).toEqual([
      IMPORTS_NOTE_READ,
      "neuve-graph at line 1: The callers are outside this change.",
    ])
    for (const row of desk.unit.sections ?? [])
      expect(row).not.toHaveProperty("undecidedNotes")
  })

  test("a review written before sections had words of their own shows as before", () => {
    const desk = deskOf(
      unit(
        { notes: [`${IMPORTS}: ${IMPORTS_NOTE}`] },
        {
          imports: { verdict: "unsure" },
          locate: { verdict: "request-changes" },
          "open-store": { verdict: "approve" },
        }
      )
    )
    for (const row of desk.unit.sections ?? [])
      expect(row).not.toHaveProperty("suggestion")
    expect(rowsOf(desk).imports.undecidedNotes).toEqual([IMPORTS_NOTE_READ])
  })

  test("an unsure verdict, or one with no words, suggests nothing", () => {
    const desk = deskOf(
      unit({
        sectionReviews: [
          { section: "locate", verdict: "unsure", message: LOCATE_WORDS },
          { section: "open-store", verdict: "approve", message: "  " },
        ],
      }),
      DECIDED
    )
    for (const row of desk.unit.sections ?? [])
      expect(row).not.toHaveProperty("suggestion")
  })

  test("a section the desk marks undecided gets no suggestion, even when one is written for it", () => {
    const desk = deskOf(
      unit({
        sectionReviews: [
          { section: "imports", verdict: "approve", message: OPEN_STORE_WORDS },
        ],
      })
    )
    expect(rowsOf(desk).imports).not.toHaveProperty("suggestion")
  })

  test("only human-required work of several changes: decided whole elsewhere, or one change, carries none", () => {
    for (const lane of ["human-suggested", "agentic-review"] as const) {
      const desk = deskOf(unit(KEYED), DECIDED, lane)
      for (const row of desk.unit.sections ?? [])
        expect(row).not.toHaveProperty("suggestion")
    }
    const one = deskOf(
      unit({ sectionReviews: KEYED.sectionReviews! }, {}, ["locate"]),
      DECIDED
    )
    for (const row of one.unit.sections ?? [])
      expect(row).not.toHaveProperty("suggestion")
  })
})

describe("the unit's own suggestion and the header's line", () => {
  test("a mixed unit with no suggestion written offers none, while its rows suggest", () => {
    const desk = deskOf(unit({ ...KEYED, suggestion: null }))
    expect(desk.delivery?.check).toBeDefined()
    expect(desk.delivery?.check).not.toHaveProperty("suggestion")
    expect(rowsOf(desk).locate.suggestion?.decision).toBe("request_changes")
  })

  test("a mixed unit's written suggestion is shown as written, never hidden", () => {
    const desk = deskOf(
      unit({
        ...KEYED,
        suggestion: { verdict: "request-changes", message: OPEN_STORE_WORDS },
      })
    )
    expect(desk.delivery?.check?.suggestion).toEqual({
      decision: "request_changes",
      message: OPEN_STORE_WORDS,
    })
  })

  test("the projection passes the lane facts' no-agent-decision flag through, and sets none of its own", () => {
    expect(deskOf(unit(KEYED), MIXED).unit).not.toHaveProperty(
      "noAgentDecision"
    )
    expect(deskOf(unit(KEYED), DECIDED).unit).not.toHaveProperty(
      "noAgentDecision"
    )
    expect(deskOf(unit(KEYED), factsFor([], true)).unit.noAgentDecision).toBe(
      true
    )
  })

  test("a carried suggestion keeps its carried line apart from the agent's words, and names no review id or head", () => {
    const review =
      "a0b164a8c881a691ce8fe738809c3afc3da65139b2b4f4b6bb7c7ddac19d34dc"
    const desk = deskOf(
      unit({
        sectionReviews: KEYED.sectionReviews!,
        review: {
          source: "carried",
          carried: {
            review,
            cycle: "cycle-0",
            head: `9c1e77b${"0".repeat(33)}`,
            judgement: "judgement-0",
            output: "output-0",
            savedMs: 0,
          },
          verdict: "request-changes",
          message: OPEN_STORE_WORDS,
          uncited: false,
        },
        suggestion: { verdict: "request-changes", message: OPEN_STORE_WORDS },
      })
    )
    expect(desk.delivery?.check?.suggestion).toEqual({
      decision: "request_changes",
      message: OPEN_STORE_WORDS,
      carried: "Carried from an earlier review.",
    })
    // The owner's text carries no codes: neither the review's id nor its head.
    const line = desk.delivery?.check?.suggestion?.carried ?? ""
    expect(line).not.toContain(review.slice(0, 7))
    expect(line).not.toContain("9c1e77b")
    // Its rows still say each decided change's own suggestion.
    expect(rowsOf(desk).locate.suggestion?.decision).toBe("request_changes")
    // Not carried: no carried line.
    const fresh = deskOf(
      unit({
        ...KEYED,
        suggestion: { verdict: "request-changes", message: OPEN_STORE_WORDS },
      })
    )
    expect(fresh.delivery?.check?.suggestion).not.toHaveProperty("carried")
  })

  test("a fully decided unit keeps its suggestion, and each row its own", () => {
    const desk = deskOf(
      unit({
        sectionReviews: [
          {
            section: "imports",
            verdict: "approve",
            message: "Checked: the import resolves.",
          },
          ...KEYED.sectionReviews!,
        ],
        suggestion: { verdict: "request-changes", message: LOCATE_WORDS },
      }),
      DECIDED
    )
    expect(desk.delivery?.check?.suggestion?.decision).toBe("request_changes")
    expect(
      (desk.unit.sections ?? []).map((row) => row.suggestion?.decision)
    ).toEqual(["approve", "request_changes", "approve"])
  })
})
