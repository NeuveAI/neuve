// Why: a Guided row can be met only with recorded proof (11.1, 11.16). The readers lane marks a
// row whose file has no proof record (`proofState: "missing"`) and writes the agent's reading of
// the changed code against it, on Records' loose row. The projection is the one place that carries
// them to the desk, and the desk derives neither: if the mark is lost, every such row reads as an
// unexplained "No evidence"; if the reading keeps its local IDs, or its cites are merged into
// `evidence` or left unresolved, the reader sees bare IDs or pins the agent didn't cite. These pin
// the boundary: both fields pass, the text without local IDs, the cites resolved as `evidence` is
// and kept apart from it; an older row, or a field the desk doesn't know, gives nothing; and the
// overview says Missing for a unit exactly where that unit's row for the item is Missing.
import { describe, expect, test } from "bun:test"

import { LANE_FACTS } from "./lane-facts"
import type { LaneFacts } from "./lane-facts"
import { deskData, digestObligationsOf } from "./projection"
import type { HumanWork, PacketContext, Sources } from "./projection"

const HEAD = "a".repeat(40)
const BASE = "b".repeat(40)
const PATH = "apps/neuve-host/src/projects.ts"

type DeskUnit = PacketContext["batch"]["units"][number]

const hunk = (id: string, startLine: number, endLine: number) => ({
  id,
  stops: ["guided"],
  resolution: {
    kind: "hunk",
    path: PATH,
    ranges: [{ side: "new", startLine, endLine }],
  },
  unresolved: undefined,
  detail: undefined,
})

const ROW = {
  row: "D1",
  text: "Low-risk reads use the shared-work helper (S13.1).",
  basis: "scope",
  required: true,
  status: "no-evidence",
  does: "No test run or other proof is recorded for this condition, so it can't be shown met.",
  evidence: ["h1a2b3c4d"],
}

const unit = (id: string, rows: ReadonlyArray<Record<string, unknown>>) =>
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
      guided: { basis: "scope", rows },
    },
    sections: [],
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
      needs: "nothing",
      closed: false,
      closing: [],
      context: [],
      standing: null,
    },
    citations: {
      cited: [hunk("h1a2b3c4d", 3, 4), hunk("h5e6f7a8b", 9, 9)],
      resolved: 2,
      unresolved: 0,
    },
  }) as unknown as DeskUnit

const contextOf = (units: ReadonlyArray<DeskUnit>) => {
  const batch = {
    local: "b.1",
    batchId: "batch-1",
    recorded: { payload: { title: "Share low-risk reads" } },
    digest: undefined,
    digestCitations: { cited: [], resolved: 0, unresolved: 0 },
    units,
    gaps: [],
  }
  return {
    repo: "neuve",
    range: { baseRef: "refs/heads/main", baseOid: BASE, headOid: HEAD },
    packet: {
      kind: "packet.published@2",
      batches: [batch],
      gaps: [],
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

const criteriaOf = (rows: ReadonlyArray<Record<string, unknown>>) => {
  const of = unit("probe", rows)
  return (
    deskData(contextOf([of]), of, "human-required", sources, human, facts)
      .delivery?.check?.criteria ?? []
  )
}

/** Each pin's target; `toEqual` would let an extra pin with none pass unseen. */
const targets = (pins: ReadonlyArray<{ target?: string }> | undefined) =>
  pins?.map((pin) => pin.target ?? "no target")

describe("a Guided row's proof state and reading", () => {
  test("both reach the desk: the text without local IDs, the cites resolved apart from evidence", () => {
    const [criterion] = criteriaOf([
      {
        ...ROW,
        proofState: "missing",
        reading: {
          text: "Cold probes now run inside SharedWork (h5e6f7a8b, S13.1); the cache keeps only committed checkouts.",
          // One the row's evidence also cites, one of its own, and one that resolves to nothing.
          cites: ["h5e6f7a8b", "h1a2b3c4d", "hdeadbeef0"],
        },
      },
    ])
    expect(criterion.status).toBe("no-evidence")
    expect(criterion.proofState).toBe("missing")
    expect(criterion.reading?.text).toBe(
      "Cold probes now run inside SharedWork; the cache keeps only committed checkouts."
    )
    // Resolved as evidence is: the reading's own order, an unresolved ID dropped.
    expect(targets(criterion.reading?.cites)).toEqual(["line 9", "lines 3–4"])
    expect(criterion.reading?.cites[0]).toMatchObject({
      kind: "source",
      label: "Source",
      markerKey: "hunk:h5e6f7a8b",
    })
    expect(targets(criterion.evidence)).toEqual(["lines 3–4"])
  })

  test("an older row gives neither; nor does a proof state the desk doesn't know, or a reading with no words", () => {
    const [older, unknown, empty] = criteriaOf([
      ROW,
      { ...ROW, row: "D2", proofState: "thin", reading: "Reads well." },
      {
        ...ROW,
        row: "D3",
        reading: { text: " (h1a2b3c4d) ", cites: ["h1a2b3c4d"] },
      },
    ])
    for (const criterion of [older, unknown, empty]) {
      expect(criterion).not.toHaveProperty("proofState")
      expect(criterion).not.toHaveProperty("reading")
      expect(targets(criterion.evidence)).toEqual(["lines 3–4"])
    }
  })

  test("the overview says Missing for a unit where its row for the item is Missing", () => {
    const missing = unit("a", [{ ...ROW, proofState: "missing" }])
    const proven = unit("b", [ROW])
    const obligations = digestObligationsOf({
      units: [missing, proven],
      digest: {
        digest: "",
        obligations: [
          {
            row: "D1",
            text: "Low-risk reads use the shared-work helper",
            basis: "scope",
            overall: "no-evidence",
            units: [
              { unit: "u.a", status: "no-evidence", required: true },
              { unit: "u.b", status: "no-evidence", required: true },
            ],
          },
          {
            // Another item: unit a's Missing row is D1, not this one.
            row: "D2",
            text: "One run per key",
            basis: "scope",
            overall: "no-evidence",
            units: [{ unit: "u.a", status: "no-evidence", required: true }],
          },
        ],
      },
    })
    // Strict: a `proofState: undefined` on the units without Missing would pass `toEqual`.
    expect(obligations.map((obligation) => obligation.units)).toStrictEqual([
      [
        {
          unitId: "a",
          title: "a.ts: a unit",
          status: "no-evidence",
          proofState: "missing",
        },
        { unitId: "b", title: "b.ts: a unit", status: "no-evidence" },
      ],
      [{ unitId: "a", title: "a.ts: a unit", status: "no-evidence" }],
    ])
  })
})
