// Why: a new-shape unit (`unit.recorded@3`) keeps the lines it owns in its sections blob, and
// records-core refuses a line comment on it, alone or in a request for changes, when the command
// runs with no blob store ("the lines unit ... owns could not be read"). The desk records a
// person's comments through its own write path (`recordLineComment`, `recordDecision`, over
// `writeRecords`), so this proves on a real temporary store, seeded with the records lane's
// fixtures, that the path gives the commands the blob store: a line comment and a line-anchored
// request for changes on a new-shape unit are recorded with their lines, and an old-shape unit's
// line comments are decided as before.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { Log } from "@neuve/records-core"
import type { ReviewCommentRecord } from "@workspace/ui/neuve/review-comments/record"
import { storeContent } from "../../../../../../packages/records-core/tests/new-shape-support"
import {
  newShapeReview,
  reviewEvents,
} from "../../../../../../packages/records-core/tests/review-fixtures"

import { recordDecision, recordLineComment } from "./desk.server"
import { createRecords, readRecords } from "./records.server"

const prior = process.env.NEUVE_REPOSITORY
let root = ""
const fresh = newShapeReview()
const old = reviewEvents()

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "neuve-web-line-comments-"))
  for (const args of [
    ["init", "-q", root],
    ["-C", root, "config", "user.email", "reviewer@example.com"],
    ["-C", root, "config", "user.name", "Reviewer"],
  ])
    if (Bun.spawnSync(["git", ...args]).exitCode !== 0)
      throw new Error(`git ${args.join(" ")} failed`)
  process.env.NEUVE_REPOSITORY = root
  await createRecords("desk-line-comments-test", () =>
    Effect.gen(function* () {
      yield* storeContent(fresh)
      yield* Log.append([...fresh.all, ...old.structure])
    })
  )
})
afterAll(async () => {
  if (prior === undefined) delete process.env.NEUVE_REPOSITORY
  else process.env.NEUVE_REPOSITORY = prior
  await rm(root, { recursive: true, force: true })
})

/** What the composer showed; the desk echoes it back and Records never sees it. */
const shown = (path: string, line: number): ReviewCommentRecord["anchor"] => ({
  filePath: path,
  range: { start: line, side: "additions", end: line },
  hunk: { index: 0, header: "@@ -1 +1 @@" },
  lines: [{ side: "additions", lineNumber: line, text: "x" }],
})

const stored = (id: string) =>
  readRecords("desk-line-comments-test", () =>
    Effect.map(Log.get(id), (found) =>
      found._tag === "Some" ? found.value.event : undefined
    )
  )

/** A line the large new-shape unit owns: its sections blob says new side, line 1. */
const owned = {
  path: "src/large.ts",
  side: "new" as const,
  startLine: 1,
  endLine: 1,
}

test("a line comment on a new-shape unit is recorded on its lines", async () => {
  const record = await recordLineComment({
    unitId: fresh.units.large,
    revision: "a".repeat(40),
    body: "Check this line.",
    anchor: owned,
    shown: shown(owned.path, 1),
  })
  expect(await stored(record.id)).toMatchObject({
    kind: "comment.recorded@2",
    attribution: { unitIds: [fresh.units.large] },
    payload: { body: "Check this line.", anchor: owned },
  })
}, 30_000)

test("a request for changes anchored to lines of a new-shape unit is recorded, with its comment on them", async () => {
  const done = await recordDecision({
    unitId: fresh.units.large,
    kind: "request-changes",
    body: "Two attempts is too few here.",
    anchor: owned,
  })
  const disposition = await stored(done.commandId)
  expect(disposition).toMatchObject({
    attribution: { unitIds: [fresh.units.large] },
    payload: { verdict: "request-changes" },
  })
  const comments = await readRecords("desk-line-comments-test", () =>
    Log.history({
      unitId: fresh.units.large,
      kind: "comment.recorded@2",
      limit: 100,
    })
  )
  expect(comments.map((entry) => entry.event.payload)).toContainEqual({
    body: "Two attempts is too few here.",
    anchor: owned,
  })
}, 30_000)

test("an old-shape unit's line comments are decided as before: inside its lines recorded, outside refused", async () => {
  // Unit two owns src/b.ts, new side, lines 5 to 30.
  const unitId = old.units[1]
  const inside = {
    path: "src/b.ts",
    side: "new" as const,
    startLine: 9,
    endLine: 10,
  }
  const record = await recordLineComment({
    unitId,
    revision: "a".repeat(40),
    body: "And this one.",
    anchor: inside,
    shown: shown(inside.path, 9),
  })
  expect(await stored(record.id)).toMatchObject({
    kind: "comment.recorded@2",
    payload: { body: "And this one.", anchor: inside },
  })
  await expect(
    recordLineComment({
      unitId,
      revision: "a".repeat(40),
      body: "Not mine.",
      anchor: { ...inside, startLine: 40, endLine: 40 },
      shown: shown(inside.path, 40),
    })
  ).rejects.toThrow("is not a line unit")
}, 30_000)
