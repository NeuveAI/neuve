import type { BriefingSegment } from "@workspace/ui/neuve/types"

/**
 * The paragraphs of the batch digest on the batch overview. Phrases and chips
 * stay inline inside their paragraph, so a sentence that links a phrase reads
 * as one sentence. (The desk's briefing reads one claim per line instead:
 * briefing-claims.ts.)
 *
 * - A briefing with phrase links breaks paragraphs only at blank lines in
 *   its text.
 * - A briefing without phrases keeps its earlier shape: each text segment
 *   starts a paragraph, and the chips after it stay at its end.
 *
 * Empty paragraphs are dropped.
 */
export function briefingParagraphs(
  segments: ReadonlyArray<BriefingSegment>
): Array<Array<BriefingSegment>> {
  const phrased = segments.some((segment) => segment.kind === "phrase")
  const paragraphs: Array<Array<BriefingSegment>> = [[]]
  const current = () => paragraphs[paragraphs.length - 1]!
  for (const segment of segments) {
    if (segment.kind !== "text") {
      current().push(segment)
      continue
    }
    if (!phrased) {
      paragraphs.push([segment])
      continue
    }
    segment.text.split(/\n[^\S\n]*\n\s*/).forEach((text, i) => {
      if (i > 0) paragraphs.push([])
      if (text) current().push({ kind: "text", text })
    })
  }
  return paragraphs.filter((paragraph) =>
    paragraph.some(
      (segment) => segment.kind !== "text" || segment.text.trim() !== ""
    )
  )
}

/**
 * Whether a chip needs a space before it: inline chips sit in the sentence,
 * so one that follows a word or another chip is set apart by a space.
 */
export function spaceBeforeChip(previous: BriefingSegment | undefined) {
  if (!previous) return false
  if (previous.kind === "cite") return true
  return !/\s$/.test(previous.text)
}

/** Punctuation that closes a clause; after a chip it stays on the chip's line. */
const CLOSING_PUNCTUATION = /^[.,;:!?…)\]’”]+/

/**
 * One segment of a sentence, ready to render. A chip carries the closing
 * punctuation that follows it (`glued`), so the two never wrap apart, and
 * that punctuation is taken off the next text (a "." never starts a line).
 */
export interface SentencePart {
  segment: BriefingSegment
  glued?: string
}

export function sentenceParts(
  run: ReadonlyArray<BriefingSegment>
): Array<SentencePart> {
  const parts: Array<SentencePart> = []
  let carried = 0
  run.forEach((segment, i) => {
    if (segment.kind === "text") {
      const text = segment.text.slice(carried)
      carried = 0
      if (text) parts.push({ segment: { kind: "text", text } })
      return
    }
    carried = 0
    const next = run[i + 1]
    const glued =
      segment.kind === "cite" && next?.kind === "text"
        ? CLOSING_PUNCTUATION.exec(next.text)?.[0]
        : undefined
    if (glued) carried = glued.length
    parts.push(glued ? { segment, glued } : { segment })
  })
  return parts
}
