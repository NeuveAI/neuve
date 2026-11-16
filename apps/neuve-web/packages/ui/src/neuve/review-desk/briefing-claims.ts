import type { BriefingSegment } from "@workspace/ui/neuve/types"

/** A sentence ends at . ! or ? before a space and a capital, digit or opening mark. */
const SENTENCE_END = /(?<=[.!?])\s+(?=[A-Z0-9“"‘'([])/

/** A text that ends a sentence, so the phrase after it starts the next. */
const ENDS_SENTENCE = /[.!?]\s+$/

/** A blank line: a paragraph break, which ends a claim too. */
const BLANK_LINE = /\n[^\S\n]*\n\s*/

/**
 * A briefing's claims, one per sentence, each read on its own line. Phrases
 * and chips stay inside their sentence and a phrase is never split, so a
 * claim is a run of segments as `sentenceParts` takes them. A blank line
 * ends a claim too.
 */
export function briefingClaims(
  segments: ReadonlyArray<BriefingSegment>
): Array<Array<BriefingSegment>> {
  const claims: Array<Array<BriefingSegment>> = []
  let current: Array<BriefingSegment> = []
  const close = () => {
    const claim = trimmed(current)
    if (claim.length > 0) claims.push(claim)
    current = []
  }
  segments.forEach((segment, i) => {
    if (segment.kind !== "text") {
      current.push(segment)
      return
    }
    segment.text.split(BLANK_LINE).forEach((paragraph, p) => {
      if (p > 0) close()
      paragraph.split(SENTENCE_END).forEach((piece, k) => {
        if (k > 0) close()
        if (piece) current.push({ kind: "text", text: piece })
      })
    })
    if (ENDS_SENTENCE.test(segment.text) && segments[i + 1]?.kind === "phrase")
      close()
  })
  close()
  return claims
}

/** The claim without the spaces at its ends; empty when it holds only spaces. */
function trimmed(claim: Array<BriefingSegment>): Array<BriefingSegment> {
  const out = claim.map((segment, i) => {
    if (segment.kind !== "text") return segment
    let text = segment.text
    if (i === 0) text = text.trimStart()
    if (i === claim.length - 1) text = text.trimEnd()
    return { kind: "text" as const, text }
  })
  const kept = out.filter((segment) => segment.kind !== "text" || segment.text)
  return kept.some((segment) => segment.kind !== "text" || segment.text.trim())
    ? kept
    : []
}

/** The phrases of a briefing, in order: its links folded into one line. */
export function briefingPhrases(
  segments: ReadonlyArray<BriefingSegment>
): Array<Extract<BriefingSegment, { kind: "phrase" }>> {
  return segments.filter(
    (segment): segment is Extract<BriefingSegment, { kind: "phrase" }> =>
      segment.kind === "phrase"
  )
}

/**
 * A change's "↳" line: its Briefed phrases, then those Explained linked,
 * each once by its words and where it lands.
 */
export function explainedLinks(
  briefed: ReadonlyArray<Extract<BriefingSegment, { kind: "phrase" }>>,
  explained: ReadonlyArray<Extract<BriefingSegment, { kind: "phrase" }>>
): Array<Extract<BriefingSegment, { kind: "phrase" }>> {
  const seen = new Set<string>()
  return [...briefed, ...explained].filter((phrase) => {
    const key = JSON.stringify([phrase.text, phrase.target])
    return !seen.has(key) && !!seen.add(key)
  })
}
