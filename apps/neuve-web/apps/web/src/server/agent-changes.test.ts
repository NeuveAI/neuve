// Why (15 November 2026, the clean-account run): a test change had three confirmed defects and the
// agent's review requested changes, but the unit landed human-suggested. The decision panel counts
// only human-required units as waiting on a person, so it said "Nothing here needs your decision"
// over an agent's request for changes. The readers lane now makes such a unit human-required for new
// reviews; this is the desk's guard for any packet, an older build's included. The projection names
// every unit an agent requested changes on (its disposition, its guided review or suggestion, or any
// `guided.sectionReviews` entry) that no person has decided, and the panel shows those instead of an
// all-decided outcome while nothing waits on you. The count that waits on you is unchanged. Each
// case goes from the packet's unit through `overviewData` to the rendered panel.
import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import {
  DecisionPanel,
  agentChangesShown,
} from "@workspace/ui/neuve/batch-overview/decision-panel"

import { overviewData } from "./projection"
import type { OverviewPeople, PacketContext } from "./projection"

type PacketUnit = PacketContext["batch"]["units"][number]
type Lane = "human-required" | "human-suggested" | "agentic"

const HEAD = "a".repeat(40)
const OWNER = "owner-actor"
const CITATIONS = { cited: [], resolved: 0, unresolved: 0 }

/** Where an agent's request for changes is written on the unit, or none. */
type Source =
  | "disposition"
  | "guided review"
  | "guided suggestion"
  | "section review"
  | "blob section"
  | "none"

const guidedFor = (source: Source) => ({
  rows: [],
  review:
    source === "guided review"
      ? {
          source: "lane-review",
          verdict: "request-changes",
          message: "Three defects in the test.",
          uncited: false,
        }
      : null,
  suggestion:
    source === "guided suggestion"
      ? { verdict: "request-changes", message: "Three defects in the test." }
      : null,
  ...(source === "section review"
    ? {
        sectionReviews: [
          { section: "a", verdict: "approve", message: "Checked: a." },
          { section: "b", verdict: "request-changes", message: "Defect: b." },
        ],
      }
    : {}),
})

/**
 * The unit's sections as records-core reads them from its blob; with the
 * "blob section" source, section b's own review requests changes there.
 */
const sectionsFor = (source: Source) =>
  source === "blob section"
    ? ["a", "b"].map((key, index) => ({
        key,
        title: `${key} in records.ts`,
        parts: { path: "records.ts", kind: "symbol", name: key },
        where: null,
        renamedFrom: null,
        ownedRanges: [
          {
            kind: "lines",
            path: "records.ts",
            side: "new",
            startLine: 1 + index * 10,
            endLine: 3 + index * 10,
          },
        ],
        content: { facts: null, briefed: null, explained: null },
        lane: "human-suggested",
        review:
          key === "b"
            ? { verdict: "request-changes", message: "Defect: b." }
            : { verdict: "approve", message: "Checked: a." },
      }))
    : undefined

/** A person's decision standing on the unit, as records-core's judgement reads it. */
const personStanding = (unitId: string) => ({
  eventId: `${unitId}-person`,
  unitId,
  actorId: OWNER,
  actorKind: "human",
  verdict: "approve",
  beforeAssessment: false,
})

/** A packet unit in `lane` with an agent's request for changes from `source`. */
const unit = (
  unitId: string,
  lane: Lane,
  source: Source,
  decidedByPerson = false,
  agent = "agent-actor"
) =>
  ({
    local: unitId,
    unitId,
    recorded: { payload: { title: unitId, ownedRanges: [] } },
    assessment: undefined,
    content: { guided: guidedFor(source) },
    ...(sectionsFor(source) ? { sections: sectionsFor(source) } : {}),
    references: [],
    referenceDetails: {},
    comments: [],
    disposition:
      source === "disposition"
        ? {
            id: `${unitId}-agent`,
            kind: "disposition.recorded@2",
            actor: agent,
            payload: {
              verdict: "request-changes",
              reviewedHeadOid: HEAD,
              restsOn: [],
              proof: [],
            },
          }
        : undefined,
    carriedDecisions: [],
    judgement: {
      unitId,
      cycleId: "cycle-1",
      lane,
      closed: decidedByPerson,
      closing: decidedByPerson ? [personStanding(unitId)] : [],
      context: [],
      standing: decidedByPerson ? personStanding(unitId) : null,
    },
    citations: CITATIONS,
    checkpoints: [],
    proofCurrency: {},
  }) as unknown as PacketUnit

const people: OverviewPeople = {
  viewer: { actor: OWNER, name: "Owner", initials: "OW" },
  people: { [OWNER]: { actor: OWNER, name: "Owner", initials: "OW" } },
  dispositions: [],
}

const overviewOf = (units: ReadonlyArray<PacketUnit>) => {
  const batch = {
    local: "b1",
    batchId: "batch-1",
    recorded: { payload: { title: "Batch", focus: "Focus" } },
    digest: undefined,
    digestCitations: CITATIONS,
    units,
  }
  const context = {
    repo: "repo",
    range: {
      baseRef: "refs/heads/main",
      baseOid: "b".repeat(40),
      headOid: HEAD,
    },
    packet: { batches: [batch], gaps: [], undecoded: [] },
    batch,
  } as unknown as PacketContext
  return overviewData(context, people)
}

/**
 * The decision panel's words, as the page renders it. Under a minimal
 * window: in a full run another test defines one for a moment, and motion,
 * loaded then, goes on reading it (its waiting squares read reduced motion).
 */
const panelOf = (data: ReturnType<typeof overviewOf>) => {
  const before = Object.getOwnPropertyDescriptor(globalThis, "window")
  const ignore = () => {}
  const media = {
    matches: false,
    addEventListener: ignore,
    removeEventListener: ignore,
  }
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      addEventListener: ignore,
      removeEventListener: ignore,
      matchMedia: () => media,
    },
  })
  try {
    return renderToStaticMarkup(createElement(DecisionPanel, { data }))
  } finally {
    if (before) Object.defineProperty(globalThis, "window", before)
    else Reflect.deleteProperty(globalThis, "window")
  }
}

/**
 * A human-required unit under the readers lane's rule (15 November 2026): a
 * confirmed defect beside a claim no agent could settle leaves every section
 * undecided, so there is no unit verdict and no agent disposition, the guided
 * review and suggestion are null, the reason is a section note and a titled
 * note, and the defect is a comment.
 */
const undecidedRequired = (unitId: string) => {
  const base = unit(unitId, "human-required", "none") as unknown as Record<
    string,
    unknown
  >
  return {
    ...base,
    content: {
      guided: {
        rows: [],
        review: null,
        suggestion: null,
        sectionNotes: [
          { section: "b", note: "Whether callers retry is not in the lines." },
        ],
        notes: ["b in records.ts: Whether callers retry is not in the lines."],
      },
    },
    comments: [
      {
        id: `${unitId}-defect`,
        kind: "comment.recorded@2",
        actor: "agent-actor",
        payload: { body: "The empty list throws." },
      },
    ],
  } as unknown as PacketUnit
}

const SOURCES: ReadonlyArray<Exclude<Source, "none">> = [
  "disposition",
  "guided review",
  "guided suggestion",
  "section review",
  "blob section",
]

describe("an agent's request for changes no person has decided", () => {
  for (const source of SOURCES)
    test(`from the ${source}: on a human-suggested unit, never "nothing needs you"`, () => {
      const data = overviewOf([
        unit("flagged", "human-suggested", source),
        unit("clean", "agentic", "none"),
      ])
      // The count that waits on you is the human-required one, as before.
      expect(data.needYou).toBe(0)
      expect(
        data.agentChanges?.map(({ id, title }) => ({ id, title }))
      ).toEqual([{ id: "flagged", title: "flagged" }])
      const panel = panelOf(data)
      expect(panel).not.toContain("Nothing here needs your decision")
      expect(panel).toContain("An agent requested changes on 1 unit")
      expect(panel).toContain(
        'aria-label="flagged, changes requested by an agent"'
      )
      expect(panel).toContain('href="/review/flagged"')
    })

  // Why: one reader for a section's verdict, the desk's: the keyed list
  // stands over the section's own review, so the guard never disagrees with
  // the section rows the desk shows.
  test("a keyed approval stands over the blob section's request, as on the desk", () => {
    const flagged = unit("flagged", "human-suggested", "blob section")
    const keyed = {
      ...flagged,
      content: {
        guided: {
          ...guidedFor("none"),
          sectionReviews: [
            { section: "b", verdict: "approve", message: "Checked: b." },
          ],
        },
      },
    } as unknown as PacketUnit
    expect(overviewOf([keyed]).agentChanges).toBeUndefined()
  })

  test("one agent on several units is an agent; two are agents", () => {
    const one = overviewOf([
      unit("first", "agentic", "disposition", false, "agent-1"),
      unit("second", "human-suggested", "disposition", false, "agent-1"),
    ])
    expect(one.agentChanges?.map((each) => each.agentId)).toEqual([
      "agent-1",
      "agent-1",
    ])
    expect(panelOf(one)).toContain("An agent requested changes on 2 units")
    const two = overviewOf([
      unit("first", "agentic", "disposition", false, "agent-1"),
      unit("second", "human-suggested", "disposition", false, "agent-2"),
    ])
    expect(panelOf(two)).toContain("Agents requested changes on 2 units")
  })

  // Why: a unit flagged only through its guided review, suggestion or a
  // section's verdict names no agent, so two agents could read as one.
  test("while any unit's agent is unknown, the words count no agents", () => {
    const data = overviewOf([
      unit("first", "agentic", "disposition", false, "agent-1"),
      unit("second", "human-suggested", "guided review"),
    ])
    expect(data.agentChanges?.map((each) => each.agentId)).toEqual([
      "agent-1",
      undefined,
    ])
    const panel = panelOf(data)
    expect(panel).toContain("Changes were requested on 2 units")
    expect(panel).not.toMatch(/An agent requested|Agents requested/)
  })

  test("once a person has decided it, the all-decided state returns", () => {
    const data = overviewOf([
      unit("flagged", "human-suggested", "disposition", true),
      unit("clean", "agentic", "none"),
    ])
    expect(data.agentChanges).toBeUndefined()
    const panel = panelOf(data)
    expect(panel).toContain("Nothing here needs your decision")
    expect(panel).not.toContain("requested changes on")
  })

  test("beside human-required units all decided, it replaces the outcome", () => {
    const data = overviewOf([
      unit("required", "human-required", "none", true),
      unit("flagged", "agentic", "guided review"),
    ])
    expect(data.needYou).toBe(0)
    expect(data.agentChanges).toEqual([{ id: "flagged", title: "flagged" }])
    const panel = panelOf(data)
    expect(panel).not.toContain("approved")
    expect(panel).toContain("An agent requested changes on 1 unit")
  })

  test("while a unit waits on you, the panel is as before", () => {
    const data = overviewOf([
      unit("required", "human-required", "guided suggestion"),
      unit("flagged", "human-suggested", "disposition"),
    ])
    expect(data.needYou).toBe(1)
    // Both are named in the data; the panel shows only what waits on you.
    expect(data.agentChanges?.map((each) => each.id)).toEqual([
      "required",
      "flagged",
    ])
    expect(agentChangesShown(data)).toEqual([])
    const panel = panelOf(data)
    expect(panel).toContain("1 needs your decision")
    expect(panel).not.toContain("requested changes on")
  })

  // Why: the readers lane's undecided unit carries no request for changes the
  // guard reads, so the count that waits on you alone must keep "nothing
  // needs you" away.
  test("an undecided human-required unit waits on you without the guard", () => {
    const data = overviewOf([
      undecidedRequired("undecided"),
      unit("clean", "human-suggested", "none"),
    ])
    expect(data.needYou).toBe(1)
    expect(data.judgment.map((each) => each.id)).toEqual(["undecided"])
    expect(data.agentChanges).toBeUndefined()
    const panel = panelOf(data)
    expect(panel).toContain("1 needs your decision")
    expect(panel).not.toContain("Nothing here needs your decision")
    expect(panel).toContain('aria-label="undecided, waiting on you"')
  })

  test("an agent's approval everywhere names nothing", () => {
    const data = overviewOf([
      unit("clean", "human-suggested", "none"),
      unit("other", "agentic", "none"),
    ])
    expect(data.agentChanges).toBeUndefined()
    expect(panelOf(data)).toContain("Nothing here needs your decision")
  })
})
