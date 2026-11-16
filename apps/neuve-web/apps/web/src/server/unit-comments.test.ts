// Why (10.102): a comment from the dock is on the whole unit unless the composer showed a marker
// attached whose lines the unit owns. The desk once pinned every dock comment to the unit's first
// changed lines, so whole-unit comments read back as line comments. This checks the two seams the
// desk relies on here: the marker's lines reach the command only when the projection marked them
// owned. That comments with no lines come back on the whole unit, not among the line comments, is
// `carried-decisions.test.ts`'s.
import { expect, test } from "bun:test"
import type { ReviewDeskData } from "@workspace/ui/neuve/types"

import { markerLines } from "../components/marker-lines"

const desk = {
  files: [
    {
      path: "src/a.ts",
      markerAnchors: [
        {
          markerKey: "owned",
          side: "additions",
          lineNumber: 12,
          range: { start: 12, end: 14, side: "additions" },
        },
        { markerKey: "elsewhere", side: "additions", lineNumber: 40 },
      ],
    },
  ],
} as unknown as ReviewDeskData

test("a marker's lines go with a dock comment only when the unit owns them", () => {
  expect(markerLines(desk, "owned")).toEqual({
    path: "src/a.ts",
    side: "new",
    startLine: 12,
    endLine: 14,
  })
  expect(markerLines(desk, "elsewhere")).toBeUndefined()
  expect(markerLines(desk, undefined)).toBeUndefined()
})
