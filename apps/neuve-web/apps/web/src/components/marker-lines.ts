import type { ReviewDeskData } from "@workspace/ui/neuve/types"

/**
 * The lines a dock comment is about: the attached marker's, when the desk
 * data gives them (only for lines the unit owns). Otherwise none, and the
 * comment is on the whole unit (decision 10.102).
 */
export function markerLines(
  data: ReviewDeskData | undefined,
  markerKey: string | undefined
) {
  if (!data || !markerKey) return undefined
  for (const file of data.files)
    for (const anchor of file.markerAnchors)
      if (anchor.markerKey === markerKey && anchor.range)
        return {
          path: file.path,
          side:
            anchor.range.side === "deletions"
              ? ("old" as const)
              : ("new" as const),
          startLine: Math.min(anchor.range.start, anchor.range.end),
          endLine: Math.max(anchor.range.start, anchor.range.end),
        }
  return undefined
}
