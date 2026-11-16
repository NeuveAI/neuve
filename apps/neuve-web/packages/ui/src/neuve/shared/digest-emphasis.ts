/**
 * Bold in the batch digest (10.140): the harness may lead a line with
 * `**Label:**`, and the overview shows it bold. Only `**…**` is read; every
 * other Markdown mark stays as written.
 *
 * A pair counts when its words neither start nor end with a space and hold
 * no `**` or line break of their own. Anything else, such as an unmatched,
 * empty or nested pair, reads as its plain characters. Each text runs on its
 * own: a pair never spans a link or a chip.
 */
export interface EmphasisPart {
  text: string
  strong: boolean
}

const PAIR = /\*\*(?=[^\s*])((?:(?!\*\*)[^\n])*?[^\s*])\*\*/g

export function emphasisParts(text: string): Array<EmphasisPart> {
  const parts: Array<EmphasisPart> = []
  let at = 0
  for (const match of text.matchAll(PAIR)) {
    if (match.index > at)
      parts.push({ text: text.slice(at, match.index), strong: false })
    parts.push({ text: match[1]!, strong: true })
    at = match.index + match[0].length
  }
  if (at < text.length) parts.push({ text: text.slice(at), strong: false })
  return parts
}
