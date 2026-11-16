// Why: the readers lane now writes each section's Briefed, and the unit's lead, as sentences whose
// phrases link the hunk where a claim can be seen, and leaves the marker to the desk: a phrase over
// lines that carry an unmet checkpoint, a conflict or a same-batch reference must be followed by that
// pin's chip, or the reader never sees that the claim rests on a missing proof or another unit's
// change. Only the projection can tell, because only it holds both the citation's lines and the
// margin's anchors. These run a packet built as a redesigned one is through `deskData`, with the
// citations resolved as Records resolves them from its commit 6c10cb3b (a hunk of a section that
// holds one hunk to that section's lines; a hunk of a section with several stays `not-published`),
// and pin: the unit's own Briefed leads and is never said again as a row; each phrase gets the chip
// of the first pin over its lines (by line, a tie by kind), never a proven checkpoint's and none
// where nothing is over it; an unresolved phrase reads as its words; Explained shows no brackets and
// hands its resolving phrases to the change's "↳" line, after the Briefed ones and never twice.
// A hunk split between sections resolves to several ranges, and a pin on any of them on the
// phrase's side counts. Old reviews (`packet.published@1`) go through the same projection, so one
// case pins that their reference phrases chip and their Explained loses its brackets too.
// A marker's chip is shown once per briefing: after the first phrase over it across the lead and the
// rows the desk draws, counted per thing the person acts on (a checkpoint on several lines has a pin
// per line, and a phrase over any of them counts as its one checkpoint's), while a phrase citing the
// marker itself keeps its chip; a row no agent decided
// draws its "No agent decision" line, so its phrases take no chip. No link markup ever shows: a `[`
// that opens no complete link (the readers' cut, "… are [delegated…") reads without the bracket, a
// link the parser cannot read or cut just after its phrase reads as its words, in the lead, the
// rows, Explained and the overview digest; code's brackets and a running "[x]" stay. Phrase-level cites (`h<hex>@<start>-<end>`) come
// resolved as the hunk narrowed to those lines; each phrase lands on its own lines and only the one
// over a pin carries its chip.
import { describe, expect, test } from "bun:test"

import { phraseLinks } from "@neuve/records-schema"

import {
  briefingPhrases,
  explainedLinks,
} from "@workspace/ui/neuve/review-desk/briefing-claims"
import type {
  BriefingPhraseTarget,
  BriefingSegment,
} from "@workspace/ui/neuve/types"

import { LANE_FACTS } from "./lane-facts"
import type { LaneFacts } from "./lane-facts"
import { deskData, overviewData, withoutLocalIds } from "./projection"
import type { HumanWork, PacketContext, Sources } from "./projection"

const HEAD = "a".repeat(40)
const BASE = "b".repeat(40)
const PATH = "apps/neuve-host/src/projects.ts"
const UNIT = "01JZ0000000000000000000U01"
const OTHER = "01JZ0000000000000000000U02"
const SAME_BATCH = "01JZ0000000000000000000R01"
const CONFLICT = "01JZ0000000000000000000R02"

type DeskUnit = PacketContext["batch"]["units"][number]

/** Hunk IDs as the harness mints them; D1 and D2 share one section. */
const H = {
  A: "h1a2b3c4d",
  B: "h2b3c4d5e",
  C: "h3c4d5e6f",
  D1: "h4d5e6f70",
  D2: "h5e6f7081",
} as const

/** Each section's owned new-side lines and the hunks its code Facts cite. */
const SECTIONS = [
  { key: "probeCache", start: 10, end: 14, hunks: [H.A] },
  { key: "locate", start: 30, end: 34, hunks: [H.B] },
  { key: "checkout", start: 50, end: 54, hunks: [H.C] },
  { key: "cleanup", start: 70, end: 80, hunks: [H.D1, H.D2] },
] as const

type Key = (typeof SECTIONS)[number]["key"]

interface Explained {
  before: string
  after: string
  terms: Array<{ term: string; meaning: string }>
  cites: Array<string>
}

const ownedOf = (section: (typeof SECTIONS)[number]) => ({
  kind: "lines",
  path: PATH,
  side: "new",
  startLine: section.start,
  endLine: section.end,
})

/** A section as records-core reads one from the unit's blob, its content as the readers write it. */
const sectionOf = (
  section: (typeof SECTIONS)[number],
  content: { briefed?: string; explained?: Explained } = {}
) => ({
  key: section.key,
  title: `${section.key} in projects.ts`,
  parts: { path: PATH, kind: "symbol", name: section.key },
  where: null,
  renamedFrom: null,
  ownedRanges: [ownedOf(section)],
  content: {
    facts: {
      text: `${section.key} in projects.ts: ${section.end - section.start + 1} lines changed.`,
      cites: [...section.hunks],
    },
    briefed: content.briefed ?? null,
    explained: content.explained ?? null,
  },
  lane: "human-required",
})

/**
 * The batch's cited IDs as Records at 6c10cb3b resolves them (`resolverFor`'s `ownResolution`): a
 * hunk every citing section cites alone resolves to that section's file and owned ranges; a hunk of
 * a section whose Facts cite several stays `not-published`, with its reason.
 */
const citations = () => {
  const cited = SECTIONS.flatMap((section) =>
    section.hunks.map((id) =>
      section.hunks.length > 1
        ? {
            id,
            stops: ["facts", "briefed", "explained"],
            resolution: undefined,
            unresolved: "not-published",
            detail: `hunk ${id} is in a section of ${PATH} that holds several hunks (its Facts cite ${section.hunks.length}); the packet keeps the section's lines without saying which are this hunk's`,
          }
        : {
            id,
            stops: ["facts", "briefed", "explained"],
            resolution: {
              kind: "hunk",
              path: PATH,
              ranges: [
                {
                  side: "new",
                  startLine: section.start,
                  endLine: section.end,
                },
              ],
            },
            unresolved: undefined,
            detail: undefined,
          }
    )
  )
  return {
    cited,
    resolved: cited.filter((id) => id.resolution).length,
    unresolved: cited.filter((id) => !id.resolution).length,
  }
}

/** A checkpoint as Records reads it, anchored on owned lines (11.17). */
const checkpoint = (
  number: number,
  proof: string,
  startLine: number,
  endLine: number
) => ({
  number,
  requirement: `Requirement ${number} holds.`,
  proof,
  note: proof === "missing" ? "No test run or other proof is recorded." : "",
  kinds: [],
  records: [],
  anchors: [{ path: PATH, side: "new", startLine, endLine }],
  sources: [],
  cites: [],
})

/** A reference event on this unit's lines, as Records holds one. */
const reference = (
  id: string,
  markerKind: "same-batch" | "conflict",
  line: number
) => ({
  id,
  kind: "context.referenced@2",
  attribution: {
    cycleId: "cycle-1",
    unitIds: markerKind === "same-batch" ? [UNIT, OTHER] : [UNIT],
  },
  payload: {
    markerKind,
    source: { kind: "code", locator: `${PATH}:${line}` },
    summary:
      markerKind === "same-batch"
        ? "Checkout, changed in this range, calls locate, which this change also changes."
        : "The ticket asks for the old lookup.",
    anchor: { path: PATH, side: "new", startLine: line, endLine: line },
    stance: markerKind === "same-batch" ? "background" : "contradicts",
    origin: markerKind === "same-batch" ? "same-batch" : "committed",
    provenance: { kind: "git", revision: HEAD, path: PATH, startLine: line },
  },
})

const unit = (
  options: {
    briefed?: string
    content?: Partial<Record<Key, { briefed?: string; explained?: Explained }>>
    references?: ReadonlyArray<ReturnType<typeof reference>>
    sections?: ReadonlyArray<(typeof SECTIONS)[number]>
    explained?: Explained
  } = {}
) => {
  const sections = options.sections ?? SECTIONS
  return {
    local: "b1.u1",
    unitId: UNIT,
    recorded: {
      kind: "unit.recorded@3",
      payload: {
        title: "projects.ts: probe the cache",
        ownedRanges: sections.map(ownedOf),
      },
      attribution: {},
    },
    assessment: undefined,
    // A missing proof on probeCache's lines; a proven one on locate's.
    checkpoints: [
      checkpoint(1, "missing", 11, 12),
      checkpoint(2, "proven", 31, 31),
    ],
    proofCurrency: {},
    content: {
      facts: { text: "projects.ts: 32 lines changed.", cites: [] },
      ...(options.briefed ? { briefed: { text: options.briefed } } : {}),
      ...(options.explained ? { explained: options.explained } : {}),
    },
    sections: sections.map((section) =>
      sectionOf(section, options.content?.[section.key])
    ),
    // Code's same-batch reference on locate's lines (readers' 3.5).
    references: [
      reference(SAME_BATCH, "same-batch", 33),
      ...(options.references ?? []),
    ],
    referenceDetails: {},
    comments: [],
    disposition: undefined,
    lineage: undefined,
    carriedDecisions: [],
    judgement: {
      unitId: UNIT,
      cycleId: "cycle-1",
      lane: "human-required",
      assessmentEventId: "assessment-1",
      assessed: true,
      needs: "nothing",
      closed: false,
      closing: [],
      context: [],
      standing: null,
    },
    citations: citations(),
  } as unknown as DeskUnit
}

const contextOf = (
  of: DeskUnit,
  kind: "packet.published@1" | "packet.published@2" = "packet.published@2"
) => {
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
    packet: {
      kind,
      batches: [batch],
      gaps: [],
      undecoded: [],
    },
    batch,
    newest: true,
  } as unknown as PacketContext
}

const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n")
const sources: Sources = {
  mergeBase: BASE,
  head: HEAD,
  files: {
    [PATH]: {
      path: PATH,
      oldPath: PATH,
      newPath: PATH,
      binary: false,
      oldContents: lines,
      newContents: lines,
      hunks: [],
    },
  },
  blobs: {},
}
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

const deskOf = (
  of: DeskUnit,
  kind?: "packet.published@1" | "packet.published@2"
) => deskData(contextOf(of, kind), of, "human-required", sources, human, facts)

const at = (section: (typeof SECTIONS)[number]): BriefingPhraseTarget => ({
  kind: "lines",
  filePath: PATH,
  range: { start: section.start, end: section.end, side: "additions" },
})

const [PROBE, LOCATE, CHECKOUT] = SECTIONS

const checkpointChip = {
  kind: "cite",
  label: "Checkpoint",
  markerKey: `checkpoint:${UNIT}:1`,
  ariaLabel: "Checkpoint, Requirement 1 holds.",
} satisfies BriefingSegment
const sameBatchChip = {
  kind: "cite",
  label: "Same batch",
  markerKey: SAME_BATCH,
  // The marker's own title, as its pin names it: the source's path.
  ariaLabel: `Same batch, ${PATH}`,
} satisfies BriefingSegment

/** The unit lead as the readers write it: one paragraph, hunk-linked phrases. */
const LEAD = `Opening a project [now probes the cache first](${H.A}) and [locating one reuses the shared lookup](${H.B}). [Checkout keeps its old retry](${H.C}), and [stale entries are dropped](${H.D1}).`

/** The chips a briefing carries, by marker key. */
const chips = (segments: ReadonlyArray<BriefingSegment>) =>
  segments.flatMap((segment) =>
    segment.kind === "cite" ? [segment.markerKey] : []
  )

describe("the unit lead and its cited phrases", () => {
  test("the unit's Briefed leads, each phrase followed by the chip of the pin over its lines", () => {
    const desk = deskOf(
      unit({
        briefed: LEAD,
        content: {
          probeCache: {
            briefed: `Opening a project [now probes the cache first](${H.A}).`,
          },
          locate: {
            briefed: `Locating a project [reuses the shared lookup](${H.B}).`,
          },
        },
      })
    )
    // Exactly the lead, in order: the probeCache phrase (a missing checkpoint on 11-12) then its
    // chip; the locate phrase (a proven checkpoint on 31, which never chips, and the same-batch
    // reference on 33) then the same-batch chip; the checkout phrase with nothing over it and no
    // chip; the cleanup phrase, whose hunk Records leaves `not-published`, as its words.
    expect(desk.unit.briefing).toStrictEqual([
      { kind: "text", text: "Opening a project " },
      { kind: "phrase", text: "now probes the cache first", target: at(PROBE) },
      checkpointChip,
      { kind: "text", text: " and " },
      {
        kind: "phrase",
        text: "locating one reuses the shared lookup",
        target: at(LOCATE),
      },
      sameBatchChip,
      { kind: "text", text: ". " },
      {
        kind: "phrase",
        text: "Checkout keeps its old retry",
        target: at(CHECKOUT),
      },
      { kind: "text", text: ", and stale entries are dropped." },
    ])
    // Rows carry each change's own Briefed. Their phrases are over the same pins the lead has
    // already shown, so they stay plain links: each chip is shown once.
    const rows = desk.unit.sections ?? []
    expect(rows.map((row) => row.id)).toEqual([
      "probeCache",
      "locate",
      "checkout",
      "cleanup",
    ])
    expect(rows[0].briefing.find((s) => s.kind === "phrase")).toMatchObject({
      text: "now probes the cache first",
    })
    expect(chips(rows[0].briefing)).toEqual([])
    expect(chips(rows[1].briefing)).toEqual([])
    expect(desk.delivery?.stops).toContain("briefed")
  })

  test("a Briefed of the unit that repeats a change's is said once: the lead, and that row claims its Facts", () => {
    const first = `Opening a project [now probes the cache first](${H.A}).`
    const desk = deskOf(
      unit({
        briefed: first,
        content: {
          probeCache: { briefed: first },
          locate: {
            briefed: `Locating a project [reuses the shared lookup](${H.B}).`,
          },
        },
      })
    )
    expect(desk.unit.briefing.map((segment) => segment.kind)).toEqual([
      "text",
      "phrase",
      "cite",
      "text",
    ])
    const [probe, locate] = desk.unit.sections ?? []
    expect(probe.briefing).toStrictEqual([
      { kind: "text", text: "probeCache in projects.ts: 5 lines changed." },
    ])
    expect(locate.briefing.find((s) => s.kind === "phrase")).toMatchObject({
      text: "reuses the shared lookup",
    })
  })

  test("without a Briefed of the unit's own, the lead and rows are as before", () => {
    const desk = deskOf(
      unit({
        content: {
          probeCache: {
            briefed: `Opening a project [now probes the cache first](${H.A}).`,
          },
        },
      })
    )
    // The rows say each change's own; the lead is what the unit's Facts say beyond them.
    expect(desk.unit.briefing).toStrictEqual([
      { kind: "text", text: "projects.ts: 32 lines changed." },
    ])
    expect(desk.unit.sections?.[0]?.briefing.at(1)).toMatchObject({
      kind: "phrase",
      text: "now probes the cache first",
    })
  })

  test("the first pin over a phrase's lines: by line, a tie going to a checkpoint before a conflict", () => {
    const probe = `Opening a project [now probes the cache first](${H.A}).`
    const firstOf = (line: number, phrase = probe) =>
      chips(
        deskOf(
          unit({
            briefed: phrase,
            references: [reference(CONFLICT, "conflict", line)],
          })
        ).unit.briefing
      )
    // A conflict on line 10 comes before the checkpoint's 11-12.
    expect(firstOf(10)).toEqual([CONFLICT])
    // On the checkpoint's first line, the checkpoint.
    expect(firstOf(11)).toEqual([checkpointChip.markerKey])
    // Past the phrase's lines, nothing counts: checkout's 50-54 carry no pin, a conflict on 57
    // gives no chip, and one on its last line does.
    const checkout = `Checkout [keeps its old retry](${H.C}).`
    expect(firstOf(57, checkout)).toEqual([])
    expect(firstOf(54, checkout)).toEqual([CONFLICT])
  })

  test("a phrase that cites a reference is followed by that marker's chip", () => {
    const of = unit({ briefed: "Code [calls locate from checkout](sb1)." })
    const cited = of.citations.cited as Array<unknown>
    cited.push({
      id: "sb1",
      stops: ["briefed"],
      resolution: { kind: "reference", eventId: SAME_BATCH, detail: undefined },
      unresolved: undefined,
      detail: undefined,
    })
    expect(deskOf(of).unit.briefing).toStrictEqual([
      { kind: "text", text: "Code " },
      {
        kind: "phrase",
        text: "calls locate from checkout",
        target: { kind: "marker", markerKey: SAME_BATCH },
      },
      sameBatchChip,
      { kind: "text", text: "." },
    ])
  })

  test("a hunk split between sections: a pin over any of its ranges on its side chips, and it lands on its first", () => {
    // Records resolves a hunk every citing section cites alone to all of those sections' lines
    // (`ownResolution` at 6c10cb3b): here checkout's 50-54, then a second range.
    const split = (
      second: { side: string; startLine: number; endLine: number },
      conflict?: ReturnType<typeof reference>
    ) => {
      const of = unit({
        briefed: `Checkout [keeps its old retry](${H.C}).`,
        ...(conflict ? { references: [conflict] } : {}),
      })
      const cited = of.citations.cited.find((id) => id.id === H.C)!
      Object.assign(cited, {
        resolution: {
          kind: "hunk",
          path: PATH,
          ranges: [{ side: "new", startLine: 50, endLine: 54 }, second],
        },
      })
      return deskOf(of).unit.briefing
    }
    // The second range is locate's 30-34: its same-batch reference on 33 chips (the proven
    // checkpoint on 31 never does), and the phrase still lands on checkout's lines.
    expect(split({ side: "new", startLine: 30, endLine: 34 })).toStrictEqual([
      { kind: "text", text: "Checkout " },
      { kind: "phrase", text: "keeps its old retry", target: at(CHECKOUT) },
      sameBatchChip,
      { kind: "text", text: "." },
    ])
    // A range on the other side is not the phrase's: a conflict on its old line 32 gives no chip.
    const onOld = reference(CONFLICT, "conflict", 32)
    const oldConflict = {
      ...onOld,
      payload: {
        ...onOld.payload,
        anchor: { ...onOld.payload.anchor, side: "old" },
      },
    }
    expect(
      chips(split({ side: "old", startLine: 30, endLine: 34 }, oldConflict))
    ).toEqual([])
  })
})

describe("an old review (packet.published@1)", () => {
  // A reference the assembled batch indexes, resolved as Records' `asReference` resolves one: a
  // ledger entry cited becomes the reference it was projected into, `via` that entry.
  const indexed = (id: string, via: string | undefined) => ({
    id,
    stops: ["briefed", "explained"],
    resolution: {
      kind: "reference",
      eventId: SAME_BATCH,
      detail: {
        local: "b1.r1",
        grade: "direct",
        why: "Checkout calls locate.",
        beforeYouDecide: "Read checkout with this change.",
        locator: `${PATH}:33`,
        entries: ["p1.e2"],
        anchors: [
          { hunk: H.B, path: PATH, side: "new", startLine: 33, endLine: 33 },
        ],
      },
      via,
    },
    unresolved: undefined,
    detail: undefined,
  })

  test("a phrase citing a ledger entry is followed by its reference's chip, and Explained reads without brackets", () => {
    const of = {
      ...unit({
        briefed:
          "Code [calls locate from checkout](p1.e2), as [the ticket asks](b1.r9).",
        explained: {
          before: "Checkout looked the project up itself.",
          after:
            "Checkout [calls locate](b1.r1) (b1.r1) and reuses its lookup.",
          terms: [
            { term: "locate", meaning: "Finds [the project's store](b1.r1)." },
          ],
          cites: ["b1.r1"],
        },
      }),
      recorded: {
        kind: "unit.recorded@2",
        payload: {
          title: "projects.ts: share the lookup",
          ownedRanges: SECTIONS.map(ownedOf),
        },
        attribution: {},
      },
      // Assemble's unit: no new-shape sections, no checkpoints.
      sections: [],
      checkpoints: [],
      citations: {
        cited: [
          indexed("p1.e2", "p1.e2"),
          indexed("b1.r1", undefined),
          {
            id: "b1.r9",
            stops: ["briefed"],
            resolution: undefined,
            unresolved: "unknown",
            detail: "reference b1.r9 is not in the assembled batch",
          },
        ],
        resolved: 2,
        unresolved: 1,
      },
    } as unknown as DeskUnit
    const desk = deskOf(of, "packet.published@1")
    expect(desk.unit.briefing).toStrictEqual([
      { kind: "text", text: "Code " },
      {
        kind: "phrase",
        text: "calls locate from checkout",
        target: { kind: "marker", markerKey: SAME_BATCH },
      },
      sameBatchChip,
      { kind: "text", text: ", as the ticket asks." },
    ])
    expect(desk.delivery?.explained).toStrictEqual({
      before: "Checkout looked the project up itself.",
      after: "Checkout calls locate and reuses its lookup.",
      terms: [{ term: "locate", meaning: "Finds the project's store." }],
      links: [
        {
          kind: "phrase",
          text: "calls locate",
          target: { kind: "marker", markerKey: SAME_BATCH },
        },
      ],
    })
  })
})

describe("links in Explained", () => {
  const explained = (after: string): Explained => ({
    before: "Every open read the project from disk.",
    after,
    terms: [
      { term: "probeCache", meaning: `Reads [the cached project](${H.A}).` },
    ],
    cites: [H.A],
  })
  const AFTER = `Each open [checks the cache first](${H.A}) and reads disk only on a miss; [old entries expire](${H.D2}), and it [now probes the cache first](${H.A}) (${H.A}).`

  test('a row\'s Before and After read as plain words, and its resolving phrases join the "↳" line once', () => {
    const desk = deskOf(
      unit({
        content: {
          probeCache: {
            briefed: `Opening a project [now probes the cache first](${H.A}).`,
            explained: explained(AFTER),
          },
          locate: { explained: explained("Locate reuses the lookup.") },
          checkout: { explained: explained("Checkout is unchanged.") },
          cleanup: { explained: explained("Cleanup drops stale entries.") },
        },
      })
    )
    const row = desk.unit.sections![0]
    expect(row.explained?.after).toBe(
      "Each open checks the cache first and reads disk only on a miss; old entries expire, and it now probes the cache first."
    )
    expect(row.explained?.terms).toStrictEqual([
      { term: "probeCache", meaning: "Reads the cached project." },
    ])
    for (const text of [
      row.explained!.before,
      row.explained!.after,
      row.explained!.terms[0].meaning,
    ])
      expect(text).not.toMatch(/[[\]]|\(h[0-9a-f]/)
    // Explained's phrases that land, without the unresolved one.
    expect(row.explained?.links).toStrictEqual([
      { kind: "phrase", text: "checks the cache first", target: at(PROBE) },
      { kind: "phrase", text: "now probes the cache first", target: at(PROBE) },
    ])
    // The "↳" line: the Briefed phrase, then Explained's new one; the repeat is dropped.
    expect(
      explainedLinks(briefingPhrases(row.briefing), row.explained!.links!)
    ).toStrictEqual([
      { kind: "phrase", text: "now probes the cache first", target: at(PROBE) },
      { kind: "phrase", text: "checks the cache first", target: at(PROBE) },
    ])
    // A row whose Explained links nothing has no `links`.
    expect(desk.unit.sections![1].explained).not.toHaveProperty("links")
  })

  test("a one-change unit's Explained reaches the desk's delivery with its links", () => {
    const desk = deskOf(
      unit({
        sections: [PROBE],
        content: { probeCache: { explained: explained(AFTER) } },
      })
    )
    expect(desk.delivery?.stops).toContain("explained")
    expect(desk.delivery?.explained?.after).toBe(
      "Each open checks the cache first and reads disk only on a miss; old entries expire, and it now probes the cache first."
    )
    expect(
      explainedLinks(
        briefingPhrases(desk.unit.briefing),
        desk.delivery!.explained!.links!
      ).map((phrase) => phrase.text)
    ).toStrictEqual(["checks the cache first", "now probes the cache first"])
  })
})

describe("one chip per marker in a briefing", () => {
  test("three phrases over one checkpoint give one chip, after the first; a reference phrase keeps its own", () => {
    const of = unit({
      briefed: `Opening a project [now probes the cache first](${H.A}) and [reads disk only on a miss](${H.A}); [locating one reuses the shared lookup](${H.B}).`,
      content: {
        probeCache: { briefed: `It [checks the cache](${H.A}).` },
        locate: { briefed: `Code [calls locate from checkout](sb1).` },
      },
    })
    const cited = of.citations.cited as Array<unknown>
    cited.push({
      id: "sb1",
      stops: ["briefed"],
      resolution: { kind: "reference", eventId: SAME_BATCH, detail: undefined },
      unresolved: undefined,
      detail: undefined,
    })
    const desk = deskOf(of)
    // In reading order, the lead first: the first phrase over probeCache's lines carries the
    // missing checkpoint's chip, the second is a plain link; the locate phrase carries the
    // same-batch chip.
    expect(desk.unit.briefing).toStrictEqual([
      { kind: "text", text: "Opening a project " },
      { kind: "phrase", text: "now probes the cache first", target: at(PROBE) },
      checkpointChip,
      { kind: "text", text: " and " },
      { kind: "phrase", text: "reads disk only on a miss", target: at(PROBE) },
      { kind: "text", text: "; " },
      {
        kind: "phrase",
        text: "locating one reuses the shared lookup",
        target: at(LOCATE),
      },
      sameBatchChip,
      { kind: "text", text: "." },
    ])
    const [probe, locate] = desk.unit.sections ?? []
    // The third phrase over the checkpoint, in its row: a plain link.
    expect(probe.briefing).toStrictEqual([
      { kind: "text", text: "It " },
      { kind: "phrase", text: "checks the cache", target: at(PROBE) },
      { kind: "text", text: "." },
    ])
    // A phrase citing the same-batch reference itself keeps its chip, though the lead showed it.
    expect(locate.briefing).toStrictEqual([
      { kind: "text", text: "Code " },
      {
        kind: "phrase",
        text: "calls locate from checkout",
        target: { kind: "marker", markerKey: SAME_BATCH },
      },
      sameBatchChip,
      { kind: "text", text: "." },
    ])
  })

  test("a chip the lead does not show follows the first row phrase over its pin", () => {
    const desk = deskOf(
      unit({
        briefed: `Checkout [keeps its old retry](${H.C}).`,
        content: {
          probeCache: { briefed: `It [checks the cache](${H.A}).` },
          locate: { briefed: `And [probes first](${H.A}).` },
        },
      })
    )
    expect(chips(desk.unit.briefing)).toEqual([])
    const [probe, locate] = desk.unit.sections ?? []
    expect(chips(probe.briefing)).toEqual([checkpointChip.markerKey])
    expect(chips(locate.briefing)).toEqual([])
  })

  test("two phrases over a checkpoint's two lines give one chip, after the first, whichever line it is over", () => {
    // Checkpoint 1 on probeCache's lines and on checkout's: a pin per line, one checkpoint.
    const twoLines = (options: Parameters<typeof unit>[0]) => {
      const of = unit(options)
      const [first] = of.checkpoints
      ;(of as unknown as { checkpoints: Array<unknown> }).checkpoints = [
        {
          ...first,
          anchors: [
            { path: PATH, side: "new", startLine: 11, endLine: 12 },
            { path: PATH, side: "new", startLine: 51, endLine: 52 },
          ],
        },
      ]
      return of
    }
    const second = `checkpoint:${UNIT}:1:2`
    const lead = deskOf(
      twoLines({
        briefed: `Opening a project [now probes the cache first](${H.A}) and [checkout keeps its old retry](${H.C}).`,
      })
    )
    // The margin draws both pins, so the checkout phrase is over one of its own.
    expect(Object.keys(lead.markers)).toContain(second)
    expect(lead.unit.briefing).toStrictEqual([
      { kind: "text", text: "Opening a project " },
      { kind: "phrase", text: "now probes the cache first", target: at(PROBE) },
      checkpointChip,
      { kind: "text", text: " and " },
      {
        kind: "phrase",
        text: "checkout keeps its old retry",
        target: at(CHECKOUT),
      },
      { kind: "text", text: "." },
    ])
    // The other way round, across the lead and a row: the chip follows the first phrase, over the
    // second line, and the row's phrase over the first line stays a plain link.
    const across = deskOf(
      twoLines({
        briefed: `Checkout [keeps its old retry](${H.C}).`,
        content: { probeCache: { briefed: `It [checks the cache](${H.A}).` } },
      })
    )
    expect(chips(across.unit.briefing)).toEqual([second])
    const [probe] = across.unit.sections ?? []
    expect(probe.briefing).toStrictEqual([
      { kind: "text", text: "It " },
      { kind: "phrase", text: "checks the cache", target: at(PROBE) },
      { kind: "text", text: "." },
    ])
  })

  test('a row no agent decided draws its "No agent decision" line, so it takes no chip from a drawn row', () => {
    const of = unit({
      briefed: `Checkout [keeps its old retry](${H.C}).`,
      content: {
        // No agent decided probeCache: at Briefed its row shows its line, not this claim.
        probeCache: { briefed: `It [checks the cache](${H.A}).` },
        locate: { briefed: `And [probes first](${H.A}).` },
      },
    })
    const desk = deskData(contextOf(of), of, "human-required", sources, human, {
      ...facts,
      undecidedSections: () => new Set(["probeCache"]),
    })
    const [probe, locate] = desk.unit.sections ?? []
    expect(probe.noAgentDecision).toBe(true)
    // Its phrases stay for the stops that draw them (Explained's "↳" line).
    expect(briefingPhrases(probe.briefing)).toStrictEqual([
      { kind: "phrase", text: "checks the cache", target: at(PROBE) },
    ])
    // The drawn row's phrase is the first over the missing checkpoint: it carries the chip.
    expect(locate.briefing).toStrictEqual([
      { kind: "text", text: "And " },
      { kind: "phrase", text: "probes first", target: at(PROBE) },
      checkpointChip,
      { kind: "text", text: "." },
    ])
  })
})

describe("no link markup", () => {
  test("a [ that opens no complete link reads without the bracket, in the lead, a row and Explained", () => {
    const desk = deskOf(
      unit({
        // The readers' cut, as the second release showed it.
        briefed: `Checkout [keeps its old retry](${H.C}). The same-key requirements are [delegated…`,
        content: {
          // A stray [ before a complete link: the link is its own last [ on.
          probeCache: {
            briefed: `Opening a [cut and [now probes the cache first](${H.A}).`,
            explained: {
              before: "Every open read a string[] from disk.",
              after: `Each open [checks the cache first](${H.A}) and [reads disk…`,
              terms: [
                { term: "probeCache", meaning: "Reads [the cached](h1a2" },
              ],
              cites: [H.A],
            },
          },
          // A link cut inside its target reads as its phrase.
          locate: { briefed: "Locating [reuses the shared lookup](h2b3c4" },
        },
      })
    )
    expect(desk.unit.briefing).toStrictEqual([
      { kind: "text", text: "Checkout " },
      { kind: "phrase", text: "keeps its old retry", target: at(CHECKOUT) },
      { kind: "text", text: ". The same-key requirements are delegated…" },
    ])
    const [probe, locate] = desk.unit.sections ?? []
    expect(probe.briefing).toStrictEqual([
      { kind: "text", text: "Opening a cut and " },
      { kind: "phrase", text: "now probes the cache first", target: at(PROBE) },
      checkpointChip,
      { kind: "text", text: "." },
    ])
    expect(locate.briefing).toStrictEqual([
      { kind: "text", text: "Locating reuses the shared lookup" },
    ])
    // Explained: no bracket, no cut target; a bracketed word with no target is not markup.
    expect(probe.explained).toMatchObject({
      before: "Every open read a string[] from disk.",
      after: "Each open checks the cache first and reads disk…",
      terms: [{ term: "probeCache", meaning: "Reads the cached" }],
    })
  })

  test("a link the parser cannot read, or cut just after its phrase, reads as its words; code's brackets stay", () => {
    const lead = (briefed: string) =>
      deskOf(unit({ briefed }))
        .unit.briefing.map((s) => (s.kind === "cite" ? "" : s.text))
        .join("")
    const long = "a long phrase ".repeat(15).trim()
    // A phrase over 200 characters, an ID over 160, an empty phrase, a space in the ID.
    expect(lead(`Opening [${long}](${H.A}) works.`)).toBe(
      `Opening ${long} works.`
    )
    expect(lead(`Opening [reads the path](h${"a".repeat(160)}) works.`)).toBe(
      "Opening reads the path works."
    )
    expect(lead("Opening [](h1a2b3c4d) a project.")).toBe("Opening a project.")
    expect(lead("Locating [reuses the lookup](h2b3 c4d5) now.")).toBe(
      "Locating reuses the lookup now."
    )
    // Cut just after the phrase: at the text's end, or before "…", also ahead of a link.
    expect(lead("Opening a project [now probes]")).toBe(
      "Opening a project now probes"
    )
    expect(
      lead(`Keys are [delegated]… and [checkout keeps its retry](${H.C}).`)
    ).toBe("Keys are delegated… and checkout keeps its retry.")
    // Kept: a bracketed word in running text, ahead of a link or not; code's brackets, at the
    // end too.
    expect(lead(`Tick [x] when [checkout keeps its retry](${H.C}).`)).toBe(
      "Tick [x] when checkout keeps its retry."
    )
    expect(lead(`Tick [x] [checkout keeps its retry](${H.C}).`)).toBe(
      "Tick [x] checkout keeps its retry."
    )
    expect(lead("It reads a string[] and calls handlers[key](a, b).")).toBe(
      "It reads a string[] and calls handlers[key](a, b)."
    )
    expect(lead("It reads entries[i]")).toBe("It reads entries[i]")
    // The words around a link the parser cannot read stay one run of text, and Explained reads
    // the same way.
    expect(
      deskOf(unit({ briefed: "Locating [reuses the lookup](h2b3 c4d5)." })).unit
        .briefing
    ).toStrictEqual([{ kind: "text", text: "Locating reuses the lookup." }])
    const desk = deskOf(
      unit({
        content: {
          probeCache: {
            explained: {
              before: "Every open read [the disk](h1 a2).",
              after: "Each open [checks the cache]",
              terms: [],
              cites: [],
            },
          },
        },
      })
    )
    expect(desk.unit.sections?.[0]?.explained).toMatchObject({
      before: "Every open read the disk.",
      after: "Each open checks the cache",
    })
  })

  test("the overview digest reads a cut link without its bracket", () => {
    const context = contextOf(unit())
    Object.assign(context.batch, {
      digest: {
        digest: `Checkout [keeps its old retry](${H.C}) and [repeat work…`,
        verification: "Of 2 checkpoints, [one has",
        limitations: [],
        uncertainty: [],
      },
    })
    // The test packet has no publishing counts: nothing is pending.
    const overview = overviewData(context, undefined, {
      ...facts,
      pendingBatches: () => 0,
    })
    const text = (segments: ReadonlyArray<BriefingSegment> = []) =>
      segments.map((s) => (s.kind === "cite" ? "" : s.text)).join("")
    expect(text(overview.contextualBriefing?.segments)).toBe(
      "Checkout keeps its old retry and repeat work…"
    )
    expect(text(overview.contextualBriefing?.toCheck)).toBe(
      "Of 2 checkpoints, one has"
    )
  })
})

describe("phrase-level cites (h<hex>@<start>-<end>)", () => {
  // Records resolves a phrase-level cite as the hunk's own resolution, its ranges narrowed to the
  // cited lines on the hunk's new side; a single line is `@<line>`.
  const LEAD_AT = `Opening a project [reads the path first](${H.A}@10) and [probes the cache](${H.A}@12-14).`
  const narrowed = (id: string, startLine: number, endLine: number) => ({
    id,
    stops: ["briefed"],
    resolution: {
      kind: "hunk",
      path: PATH,
      ranges: [{ side: "new", startLine, endLine }],
    },
    unresolved: undefined,
    detail: undefined,
  })

  test("the id parses as a link, and withoutLocalIds leaves it", () => {
    expect(phraseLinks(LEAD_AT)).toStrictEqual([
      { phrase: "reads the path first", id: `${H.A}@10` },
      { phrase: "probes the cache", id: `${H.A}@12-14` },
    ])
    expect(withoutLocalIds(LEAD_AT)).toBe(LEAD_AT)
  })

  test("two phrases on one hunk land on their own lines; only the one over the checkpoint chips", () => {
    const of = unit({ briefed: LEAD_AT })
    const cited = of.citations.cited as Array<unknown>
    cited.push(narrowed(`${H.A}@10`, 10, 10), narrowed(`${H.A}@12-14`, 12, 14))
    // The missing checkpoint is on 11-12: over the second cite's lines only.
    expect(deskOf(of).unit.briefing).toStrictEqual([
      { kind: "text", text: "Opening a project " },
      {
        kind: "phrase",
        text: "reads the path first",
        target: {
          kind: "lines",
          filePath: PATH,
          range: { start: 10, end: 10, side: "additions" },
        },
      },
      { kind: "text", text: " and " },
      {
        kind: "phrase",
        text: "probes the cache",
        target: {
          kind: "lines",
          filePath: PATH,
          range: { start: 12, end: 14, side: "additions" },
        },
      },
      checkpointChip,
      { kind: "text", text: "." },
    ])
  })
})
