// Why (10.109, the merged briefing of 25 October): the desk shows a joined unit's changes as rows,
// each with its own claim. Assemble writes the briefing as a lead, then a paragraph per section that
// opens with its title; the projection splits it only when every paragraph matches the packet's
// sections in order, since a wrong split would give a change another change's claim. Any other shape
// (a unit assembled before sections, an edited briefing, a title that does not match) stays whole.
import { describe, expect, test } from "bun:test"

import { briefingBySection, joinedBriefing } from "./projection"
import type { SectionContent } from "./projection"

const sections = [
  { id: "b1.s1", title: "Lazy model processes" },
  { id: "b1.s3", title: "Encoder call accounting" },
]
const text = [
  "The holder creates processes on demand.",
  "Lazy model processes: The [holder now creates each model](h1). Tests cover one call.",
  "Encoder call accounting: The [encoder obtains a client](h2): per call.",
].join("\n\n")

describe("briefingBySection", () => {
  test("splits the lead and each section's claim, the title taken off", () => {
    expect(briefingBySection(text, sections)).toEqual({
      lead: "The holder creates processes on demand.",
      sections: [
        {
          id: "b1.s1",
          title: "Lazy model processes",
          text: "The [holder now creates each model](h1). Tests cover one call.",
        },
        {
          id: "b1.s3",
          title: "Encoder call accounting",
          text: "The [encoder obtains a client](h2): per call.",
        },
      ],
    })
  })

  test("stays whole when a paragraph does not open with its section's title", () => {
    expect(briefingBySection(text, [...sections].reverse())).toBeUndefined()
  })

  test("stays whole when the paragraphs and sections do not pair up", () => {
    expect(
      briefingBySection(text, [...sections, { id: "b1.s4", title: "More" }])
    ).toBeUndefined()
    expect(briefingBySection("Only a lead.", sections)).toBeUndefined()
  })

  test("one section is the unit itself: no rows", () => {
    expect(
      briefingBySection("Lazy model processes: claim", [sections[0]])
    ).toBeUndefined()
  })

  test("a title with its own colon or regex characters matches only as written", () => {
    const odd = [
      { id: "s1", title: "Retry: backoff (x2)" },
      { id: "s2", title: "Paths like a.*b+" },
    ]
    const split = briefingBySection(
      "Lead.\n\nRetry: backoff (x2): waits twice.\n\nPaths like a.*b+: match.",
      odd
    )
    expect(split?.sections.map((section) => section.text)).toEqual([
      "waits twice.",
      "match.",
    ])
    // Only the title's first words before its own colon: not a match.
    expect(
      briefingBySection(
        "Lead.\n\nRetry: waits.\n\nPaths like a.*b+: match.",
        odd
      )
    ).toBeUndefined()
    // A regex-like title is literal text: "aXb" does not match "a.*b+".
    expect(
      briefingBySection(
        "Lead.\n\nRetry: backoff (x2): w.\n\nPaths like aXb: m.",
        odd
      )
    ).toBeUndefined()
  })

  test("two sections with one title pair by order", () => {
    const twins = [
      { id: "s1", title: "Cleanup" },
      { id: "s2", title: "Cleanup" },
    ]
    expect(
      briefingBySection(
        "Lead.\n\nCleanup: first.\n\nCleanup: second.",
        twins
      )?.sections.map((section) => `${section.id} ${section.text}`)
    ).toEqual(["s1 first.", "s2 second."])
  })

  test("empty text or a missing section stays whole", () => {
    expect(briefingBySection("", sections)).toBeUndefined()
    expect(
      briefingBySection("Lead.\n\nLazy model processes: claim.\n\n", sections)
    ).toBeUndefined()
  })

  test("CRLF line endings split as LF and never reach a claim", () => {
    const split = briefingBySection(text.replaceAll("\n", "\r\n"), sections)
    expect(split?.lead).toBe("The holder creates processes on demand.")
    expect(
      split?.sections.every((section) => !section.text.includes("\r"))
    ).toBe(true)
  })
})

const content = (
  claim: string | null,
  explained: SectionContent["explained"] = null
): SectionContent => ({
  facts: { text: `Facts of ${claim ?? "nothing"}.`, cites: [] },
  briefed: claim,
  explained,
})

describe("joinedBriefing", () => {
  test("each change's own content, when the packet keeps it for every change", () => {
    const explained = { before: "b", after: "a", terms: [], cites: [] }
    const kept = [
      { ...sections[0], content: content("Own claim one.", explained) },
      { ...sections[1], content: content(null) },
    ]
    const joined = joinedBriefing(text, kept)
    expect(joined?.lead).toBe("The holder creates processes on demand.")
    // A change without Briefed reads its Facts, as Assemble writes the unit's.
    expect(joined?.sections.map((section) => section.claim)).toEqual([
      "Own claim one.",
      "Facts of nothing.",
    ])
    expect(joined?.sections[0]?.content?.explained).toEqual(explained)
  })

  test("an older packet, or one change without content, falls back to the split by title", () => {
    const partly = [
      { ...sections[0], content: content("Own claim one.") },
      sections[1],
    ]
    const joined = joinedBriefing(text, partly)
    expect(joined?.sections.map((section) => section.claim)).toEqual([
      "The [holder now creates each model](h1). Tests cover one call.",
      "The [encoder obtains a client](h2): per call.",
    ])
    expect(joined?.sections.every((section) => !section.content)).toBe(true)
  })

  test("one section is the unit itself: no rows", () => {
    const one = [{ ...sections[0], content: content("Claim.") }]
    expect(joinedBriefing("Lead.", one)).toBeUndefined()
  })
})
