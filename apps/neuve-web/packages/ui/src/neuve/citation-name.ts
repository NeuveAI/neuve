import type { LineRange, MarkerTone } from "@workspace/ui/neuve/types"

/**
 * A citation chip's name (round 5, round-5.md): in the briefing the chip
 * shows only its kind icon, so its accessible name and its tooltip say the
 * kind and the target, "Source, lines 29–36". The target is the lines the
 * chip lands on, or the source's title when the chip only opens its sheet
 * ("Ticket, SHR-212"). Pure, so the BFF and the fixtures name chips the same
 * way the desk reads them.
 */

/** Each marker kind's label, as its pin says it (marker-kind.tsx). */
export const MARKER_KIND_LABEL = {
  conflict: "Conflict",
  decision: "Decision",
  failed: "Failed",
  gap: "Gap",
  unavailable: "Unavailable",
  comment: "Comment",
  draft: "Draft",
  batch: "Same batch",
  signal: "Signal",
  test: "Test",
  source: "Source",
  graph: "Graph",
  history: "History",
  doc: "Doc",
  checkpoint: "Checkpoint",
} as const satisfies Record<MarkerTone | "draft", string>

/** "line 34" or "lines 29–36". */
export function linesName(range: Pick<LineRange, "start" | "end">): string {
  return range.start === range.end
    ? `line ${range.start}`
    : `lines ${range.start}–${range.end}`
}

/**
 * "Kind, target": the chip's accessible name and its tooltip. A citation
 * whose marker kind is unknown never claims one: its name is the target
 * alone, as its chip is neutral.
 */
export function citationName(
  kind: MarkerTone | undefined,
  target: string
): string {
  return kind ? `${MARKER_KIND_LABEL[kind]}, ${target}` : target
}
