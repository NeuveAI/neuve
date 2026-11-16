/**
 * Briefing claims: the merged briefing reads one claim per line. The split
 * is input handling at the sentence edges the harness writes (a sentence
 * that ends right before a phrase, a phrase that opens one, abbreviations
 * and versions), and a wrong cut would break a linked phrase or a sentence.
 */
import { describe, expect, test } from "bun:test"

import {
  briefingClaims,
  briefingPhrases,
} from "@workspace/ui/neuve/review-desk/briefing-claims"
import type { BriefingSegment } from "@workspace/ui/neuve/types"

const phrase = (
  text: string
): Extract<BriefingSegment, { kind: "phrase" }> => ({
  kind: "phrase",
  text,
  target: { kind: "marker", markerKey: text },
})
const text = (value: string): BriefingSegment => ({ kind: "text", text: value })
const cite: BriefingSegment = {
  kind: "cite",
  label: "Source",
  markerKey: "m",
  ariaLabel: "Source, line 1",
}

/** A claim as plain text, its phrases in brackets. */
const read = (claims: Array<Array<BriefingSegment>>) =>
  claims.map((claim) =>
    claim
      .map((s) =>
        s.kind === "phrase" ? `[${s.text}]` : s.kind === "cite" ? "{c}" : s.text
      )
      .join("")
  )

describe("briefingClaims", () => {
  test("a sentence ending right before a phrase closes its claim", () => {
    const claims = briefingClaims([
      text("The "),
      phrase("holder now creates each model on demand"),
      text(". "),
      phrase("Both adapters count queued work"),
      text(" and keep it, while "),
      phrase("cached workers keep the holder"),
      text(". The "),
      phrase("direct lifecycle tests"),
      text(" cover single calls."),
    ])
    expect(read(claims)).toEqual([
      "The [holder now creates each model on demand].",
      "[Both adapters count queued work] and keep it, while [cached workers keep the holder].",
      "The [direct lifecycle tests] cover single calls.",
    ])
  })

  test("a semicolon, an abbreviation or a version never splits a claim", () => {
    const claims = briefingClaims([
      text("Its "),
      phrase("allowlist"),
      text("; cleanup must align with the deadline, e.g. on v1.2 retries."),
    ])
    expect(claims).toHaveLength(1)
  })

  test("a chip stays with the sentence it follows", () => {
    const claims = briefingClaims([
      text("It retries "),
      cite,
      text(". The wait ignores cancellation."),
    ])
    expect(read(claims)).toEqual([
      "It retries {c}.",
      "The wait ignores cancellation.",
    ])
  })

  test("a blank line ends a claim and empty claims are dropped", () => {
    const claims = briefingClaims([
      phrase("First"),
      text(" change\n\n  \n\nSecond change. "),
    ])
    expect(read(claims)).toEqual(["[First] change", "Second change."])
  })

  test("no segments, no claims", () => {
    expect(briefingClaims([])).toEqual([])
  })
})

describe("briefingPhrases", () => {
  test("keeps the phrases in order and nothing else", () => {
    const one = phrase("one")
    const two = phrase("two")
    expect(briefingPhrases([text("a "), one, cite, text(" b "), two])).toEqual([
      one,
      two,
    ])
  })
})
