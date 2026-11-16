/**
 * Briefing paragraphs (round 5): in the "paragraphs" layout phrases and
 * chips stay inside their paragraph, so a linked sentence is one sentence.
 */
import { describe, expect, test } from "bun:test"

import { citationName } from "@workspace/ui/neuve/citation-name"
import {
  briefingParagraphs,
  sentenceParts,
  spaceBeforeChip,
} from "@workspace/ui/neuve/shared/briefing-paragraphs"
import type { BriefingSegment } from "@workspace/ui/neuve/types"

const cite = (markerKey: string): BriefingSegment => ({
  kind: "cite",
  label: "Source",
  markerKey,
  ariaLabel: "Source, line 1",
})

describe("briefingParagraphs", () => {
  test("a phrased briefing keeps a sentence in one paragraph", () => {
    const segments: Array<BriefingSegment> = [
      { kind: "text", text: "It now " },
      {
        kind: "phrase",
        text: "retries",
        target: { kind: "marker", markerKey: "retry" },
      },
      { kind: "text", text: " " },
      cite("retry"),
      { kind: "text", text: ". The wait ignores cancellation." },
    ]
    expect(briefingParagraphs(segments)).toEqual([segments])
  })

  test("a phrased briefing breaks paragraphs at blank lines only", () => {
    const paragraphs = briefingParagraphs([
      { kind: "text", text: "First " },
      {
        kind: "phrase",
        text: "claim",
        target: { kind: "review" },
      },
      { kind: "text", text: ".\n\nSecond paragraph " },
      cite("doc"),
      { kind: "text", text: "." },
    ])
    expect(paragraphs).toHaveLength(2)
    expect(paragraphs[0]?.map((s) => s.kind)).toEqual([
      "text",
      "phrase",
      "text",
    ])
    expect(paragraphs[1]?.[0]).toEqual({
      kind: "text",
      text: "Second paragraph ",
    })
    expect(paragraphs[1]?.map((s) => s.kind)).toEqual(["text", "cite", "text"])
  })

  test("a briefing without phrases keeps one paragraph per text, chips at its end", () => {
    const paragraphs = briefingParagraphs([
      cite("lead"),
      { kind: "text", text: "First." },
      cite("a"),
      cite("b"),
      { kind: "text", text: "Second." },
    ])
    expect(paragraphs.map((run) => run.map((s) => s.kind))).toEqual([
      ["cite"],
      ["text", "cite", "cite"],
      ["text"],
    ])
  })
})

describe("spaceBeforeChip", () => {
  test("a chip after a word or a chip gets a space; after a space it does not", () => {
    expect(spaceBeforeChip(undefined)).toBe(false)
    expect(spaceBeforeChip({ kind: "text", text: "lives:" })).toBe(true)
    expect(spaceBeforeChip({ kind: "text", text: "sleeps " })).toBe(false)
    expect(spaceBeforeChip(cite("a"))).toBe(true)
  })
})

describe("sentenceParts", () => {
  test("a chip keeps the closing punctuation after it; the next text loses it", () => {
    const parts = sentenceParts([
      { kind: "text", text: "It now retries " },
      cite("retry"),
      { kind: "text", text: ". The wait ignores cancellation " },
      cite("doc"),
      { kind: "text", text: "." },
    ])
    expect(parts).toEqual([
      { segment: { kind: "text", text: "It now retries " } },
      { segment: cite("retry"), glued: "." },
      { segment: { kind: "text", text: " The wait ignores cancellation " } },
      { segment: cite("doc"), glued: "." },
    ])
  })

  test("a chip before a word or another chip glues nothing", () => {
    const parts = sentenceParts([
      cite("a"),
      cite("b"),
      { kind: "text", text: " and more" },
    ])
    expect(parts.map((part) => part.glued)).toEqual([
      undefined,
      undefined,
      undefined,
    ])
  })
})

describe("citationName", () => {
  test("a known kind and its target; an unknown kind claims none", () => {
    expect(citationName("source", "lines 29–36")).toBe("Source, lines 29–36")
    expect(citationName("batch", "line 23")).toBe("Same batch, line 23")
    expect(citationName(undefined, "Revoke callers")).toBe("Revoke callers")
  })
})
