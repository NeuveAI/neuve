// Why (the owner, 23 October 2026): on a 43-unit review every suggested unit the harness could not
// assess carries a title code built from its path ("apps/neuve-web/…/desk.server.ts (deskLoad): 1
// hunk(s), …"), and the rail showed 43 rows cut off at the same folder. The rail now names such a
// unit by its file and owned lines, but only from structured fields this projection sets: parsing
// the title text in the UI would be a second, fragile authority on its shape. This checks the
// boundary the rail reads (the lane groups of `deskBatchContext`): an unassessed unit gets its
// files and owned spans in order, new side first and old side only when it owns nothing new; a
// unit Records assessed keeps its written title with no `untitled`; and a unit with no record of
// its own has nothing to be named by.
import { expect, test } from "bun:test"

import { deskBatchContext } from "./projection"
import type { PacketContext } from "./projection"

const CITATIONS = { cited: [], resolved: 0, unresolved: 0 }

const lines = (
  path: string,
  side: "old" | "new",
  start: number,
  end: number
) => ({
  kind: "lines" as const,
  path,
  side,
  startLine: start,
  endLine: end,
})

const unit = (
  local: string,
  title: string,
  options: {
    assessed: boolean
    ownedRanges?: ReadonlyArray<unknown>
    recorded?: boolean
  }
) => ({
  local,
  unitId: `01JZ00000000000000000000${local.slice(-2).toUpperCase()}`,
  recorded:
    options.recorded === false
      ? undefined
      : {
          payload: { title, ownedRanges: options.ownedRanges ?? [] },
          attribution: {},
        },
  assessment: undefined,
  content: {},
  references: [],
  referenceDetails: {},
  comments: [],
  disposition: undefined,
  judgement: {
    unitId: local,
    cycleId: null,
    lane: "human-suggested",
    assessmentEventId: options.assessed ? "01JZ0000000000000000000E01" : null,
    assessed: options.assessed,
    needs: "a-disposition",
    closed: false,
    closing: [],
    context: [],
    standing: null,
  },
  citations: CITATIONS,
})

const suggested = (units: ReadonlyArray<ReturnType<typeof unit>>) => {
  const batch = {
    local: "b1",
    batchId: "01JZ0000000000000000000B01",
    recorded: undefined,
    digest: undefined,
    digestCitations: CITATIONS,
    assembled: undefined,
    units,
  } as unknown as PacketContext["batch"]
  const context = deskBatchContext({
    repo: "repo",
    range: {
      baseRef: "refs/heads/main",
      baseOid: "b".repeat(40),
      headOid: "a".repeat(40),
    },
    packet: { batches: [batch], gaps: [], undecoded: [] },
    batch,
  } as unknown as PacketContext)
  return context.elsewhere.find((lane) => lane.lane === "human-suggested")
    ?.units
}

const CODE_TITLE =
  'apps/web/src/server/desk.server.ts (deskLoad): 2 hunk(s), +7 -10 lines, for "Overview reflects decisions, standing re'

test("an unassessed unit is named by its files and owned spans, in order", () => {
  const [row] = suggested([
    unit("b1.u1", CODE_TITLE, {
      assessed: false,
      ownedRanges: [
        lines("apps/web/src/server/desk.server.ts", "new", 223, 229),
        lines("apps/web/src/server/desk.server.ts", "old", 203, 212),
        lines("apps/web/src/server/desk.server.ts", "new", 90, 90),
        // Deletions only in this file: its old-side span is all it owns.
        lines("apps/web/src/server/projection.ts", "old", 40, 44),
        { kind: "whole-nontext", path: "apps/web/public/logo.png" },
      ],
    }),
  ])!
  expect(row.title).toBe(CODE_TITLE)
  expect(row.untitled).toEqual({
    files: [
      {
        path: "apps/web/src/server/desk.server.ts",
        lines: [
          { start: 90, end: 90 },
          { start: 223, end: 229 },
        ],
      },
      {
        path: "apps/web/src/server/projection.ts",
        lines: [{ start: 40, end: 44 }],
      },
      { path: "apps/web/public/logo.png", lines: [] },
    ],
  })
})

test("an assessed unit keeps its written title and no untitled fields", () => {
  const [row] = suggested([
    unit("b1.u2", "Desk loads people once per request", {
      assessed: true,
      ownedRanges: [lines("apps/web/src/server/desk.server.ts", "new", 1, 9)],
    }),
  ])!
  expect(row.title).toBe("Desk loads people once per request")
  expect(row).not.toHaveProperty("untitled")
})

test("a unit with nothing recorded to name it by gets no untitled fields", () => {
  const rows = suggested([
    unit("b1.u3", "b1.u3", { assessed: false, recorded: false }),
    unit("b1.u4", CODE_TITLE, { assessed: false, ownedRanges: [] }),
  ])!
  expect(rows.map((row) => row.untitled)).toEqual([undefined, undefined])
})
