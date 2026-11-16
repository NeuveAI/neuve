/**
 * What the briefing draws at a stop. The projection offers Explained by the
 * same rule (`explainedShows`), so a wrong answer here offers a stop that
 * shows nothing new, or draws Explained the dial doesn't offer. The rows
 * rule decides whether a change's "No agent decision" line and its notes
 * show at all: a change whose row isn't drawn loses both, so the header
 * must carry it, its title leading its line, with notes or without; a
 * decided change's suggestion likewise.
 */
import { describe, expect, test } from "bun:test"

import {
  briefingKind,
  notesApart,
  rowedAt,
  strandedSections,
} from "@workspace/ui/neuve/review-desk/briefing-rows"
import type { BriefingSection, ExplainedText } from "@workspace/ui/neuve/types"

const EXPLAINED: ExplainedText = {
  before: "Before.",
  after: "After.",
  terms: [],
}
const FACTS = [{ kind: "text" as const, text: "1 line added." }]

const change = (
  id: string,
  extra: Partial<BriefingSection> = {}
): BriefingSection => ({
  id,
  title: `${id} in projects.ts`,
  briefing: [],
  ...extra,
})

const AT_EXPLAINED = { factsOnly: false, atExplained: true }

describe("briefingKind at Explained", () => {
  test("every change explained shows Explained, with no unit Explained", () => {
    const sections = [
      change("a", { explained: EXPLAINED }),
      change("b", { explained: EXPLAINED }),
    ]
    expect(briefingKind(AT_EXPLAINED, undefined, sections)).toBe("explained")
  })

  test("some changes explained shows the claims, not an empty Explained", () => {
    const sections = [change("a", { explained: EXPLAINED }), change("b")]
    expect(briefingKind(AT_EXPLAINED, undefined, sections)).toBe("claims")
  })

  test("a unit of one change shows its Explained as the unit's", () => {
    expect(briefingKind(AT_EXPLAINED, EXPLAINED, undefined)).toBe("explained")
    expect(briefingKind(AT_EXPLAINED, undefined, undefined)).toBe("claims")
  })
})

describe("the rows at Facts, and the notes they would lose", () => {
  const undecided = change("probe", {
    noAgentDecision: true,
    undecidedNotes: ["The retry bound is outside this change."],
  })

  test("an undecided change whose content didn't read keeps its row, its line in place of Facts", () => {
    const sections = [change("checkout", { facts: FACTS }), undecided]
    expect(rowedAt("facts", sections, false)).toBe(true)
    expect(strandedSections(sections, true, false)).toEqual([])
  })

  test("a decided change with no Facts: no rows, and the undecided change goes to the header by its title, with its one note", () => {
    const sections = [change("checkout"), undecided]
    const rowed = rowedAt("facts", sections, false)
    expect(rowed).toBe(false)
    expect(strandedSections(sections, rowed, false)).toEqual([
      {
        id: "probe",
        title: "probe in projects.ts",
        notes: ["The retry bound is outside this change."],
      },
    ])
  })

  test("an undecided change with no notes still goes to the header by its title, so its line shows", () => {
    const sections = [
      change("checkout"),
      change("probe", { noAgentDecision: true }),
    ]
    const rowed = rowedAt("facts", sections, false)
    expect(rowed).toBe(false)
    expect(strandedSections(sections, rowed, false)).toEqual([
      { id: "probe", title: "probe in projects.ts", notes: [] },
    ])
  })

  test("at Explained without rows, the same change goes to the header", () => {
    const sections = [change("checkout", { explained: EXPLAINED }), undecided]
    const rowed = rowedAt("explained", sections, false)
    expect(rowed).toBe(false)
    expect(strandedSections(sections, rowed, false)).toHaveLength(1)
  })

  test("a decided change with a suggestion goes to the header with it, by its title; one without stays out", () => {
    const suggestion = {
      decision: "request_changes" as const,
      message: [{ kind: "text" as const, text: "Checked: the lock is held." }],
    }
    const sections = [
      change("checkout", { suggestion }),
      change("locate", { explained: EXPLAINED }),
      undecided,
    ]
    const rowed = rowedAt("facts", sections, false)
    expect(rowed).toBe(false)
    expect(strandedSections(sections, rowed, false)).toEqual([
      {
        id: "checkout",
        title: "checkout in projects.ts",
        notes: [],
        suggestion,
      },
      {
        id: "probe",
        title: "probe in projects.ts",
        notes: ["The retry bound is outside this change."],
      },
    ])
    expect(strandedSections(sections, true, false)).toEqual([])
  })

  test("a unit no agent decided has its one line and its notes in the header already", () => {
    const sections = [change("checkout"), undecided]
    expect(strandedSections(sections, false, true)).toEqual([])
    // Not even a change with a suggestion written for it: nothing was
    // decided, so the header says the line and each reason once.
    const suggestion = {
      decision: "approve" as const,
      message: [{ kind: "text" as const, text: "Checked: the lock is held." }],
    }
    expect(
      strandedSections(
        [change("checkout", { suggestion }), undecided],
        false,
        true
      )
    ).toEqual([])
  })
})

describe("Records' notes apart from the briefing", () => {
  test("at Facts, and at Explained on a unit of one change, where the briefing isn't text", () => {
    expect(notesApart("facts", undefined)).toBe(true)
    expect(notesApart("explained", undefined)).toBe(true)
    // A joined unit's lead carries them at Explained, and the claims always.
    expect(notesApart("explained", [change("a"), change("b")])).toBe(false)
    expect(notesApart("claims", undefined)).toBe(false)
  })
})
