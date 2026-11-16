import type { ReferenceStance, ReferenceTie } from "@workspace/ui/neuve/types"

/**
 * How a context reference bears on the change, as one word that leads its
 * reason ("Supports. The adapter maps…"). An unresolved stance never reads
 * as support: Records means its direction is not settled.
 */
export const STANCE_LABEL: Record<ReferenceStance, string> = {
  supports: "Supports",
  contradicts: "Contradicts",
  background: "Background",
  unresolved: "Unclear fit",
}

/** The harness's grade in the words the owner's feedback grades with. */
export const GRADE_LABEL: Record<NonNullable<ReferenceTie["grade"]>, string> = {
  necessary: "Necessary",
  useful: "Useful",
}

/** A path as a compact label: the file name, then its folder. */
export function pathParts(path: string): { name: string; folder: string } {
  const at = path.lastIndexOf("/")
  return at < 0
    ? { name: path, folder: "" }
    : { name: path.slice(at + 1), folder: path.slice(0, at) }
}

/**
 * Lines without the indentation they all share, so deeply nested code reads
 * from the left edge. Relative indentation stays; blank lines neither count
 * nor change.
 */
export function withoutSharedIndent(
  lines: ReadonlyArray<string>
): Array<string> {
  const widths = lines
    .filter((line) => line.trim() !== "")
    .map((line) => /^[ \t]*/.exec(line)?.[0].length ?? 0)
  const shared = widths.length > 0 ? Math.min(...widths) : 0
  return lines.map((line) => (line.trim() === "" ? line : line.slice(shared)))
}
