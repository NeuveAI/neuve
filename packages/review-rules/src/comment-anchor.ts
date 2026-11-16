import type {
  ReviewCommentAnchor,
  SubmittedBranchReview,
} from "@neuve/records-schema";

/**
 * Whether an anchor's lines are exactly the canonical lines of one of the
 * unit's owned text hunks in the displayed file, in submission order.
 */
export function matchesOwnedSourceAnchor(
  anchor: ReviewCommentAnchor,
  unit: { readonly hunkIds: readonly string[] },
  submission: SubmittedBranchReview,
): boolean {
  // The displayed file contains this unit's owned hunks, in pinned submission order.
  const hunks = submission.hunks.filter(
    (hunk) =>
      unit.hunkIds.includes(hunk.hunkId) &&
      hunk.path === anchor.filePath &&
      hunk.kind === "text",
  );
  const hunk = hunks[anchor.hunk.index];
  if (!hunk) return false;
  const [header, ...lines] = hunk.text.split("\n");
  if (header !== anchor.hunk.header) return false;
  const coordinates = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(
    header ?? "",
  );
  if (!coordinates) return false;
  let oldLine = Number(coordinates[1]);
  let newLine = Number(coordinates[2]);
  const canonical: ReviewCommentAnchor["lines"][number][] = [];
  for (const line of lines) {
    if (line.startsWith("-"))
      canonical.push({
        side: "deletions",
        lineNumber: oldLine++,
        text: line.slice(1),
      });
    else if (line.startsWith("+"))
      canonical.push({
        side: "additions",
        lineNumber: newLine++,
        text: line.slice(1),
      });
    else if (line.startsWith(" ")) {
      canonical.push(
        { side: "deletions", lineNumber: oldLine++, text: line.slice(1) },
        { side: "additions", lineNumber: newLine++, text: line.slice(1) },
      );
    }
  }
  let position = -1;
  for (const selected of anchor.lines) {
    const next = canonical.findIndex(
      (line, index) =>
        index > position &&
        line.side === selected.side &&
        line.lineNumber === selected.lineNumber &&
        line.text === selected.text,
    );
    if (next < 0) return false;
    position = next;
  }
  const first = anchor.lines[0];
  const last = anchor.lines.at(-1);
  return (
    first !== undefined &&
    last !== undefined &&
    anchor.range.start === first.lineNumber &&
    anchor.range.side === first.side &&
    anchor.range.end === last.lineNumber &&
    (anchor.range.endSide ?? anchor.range.side) === last.side
  );
}
