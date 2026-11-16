/** viewedFilesAtom stays bounded (round 3.1): landing.ts nextViewedFiles. */
import { describe, expect, test } from "bun:test"

import {
  MAX_VIEWED_FILES,
  nextViewedFiles,
  viewedKey,
} from "@workspace/ui/neuve/review-desk/landing"

describe("nextViewedFiles", () => {
  test("marks and unmarks", () => {
    const key = viewedKey("unit", "rev-1", "a.ts")
    const viewed = nextViewedFiles({}, key, true)
    expect(viewed).toEqual({ [key]: true })
    expect(nextViewedFiles(viewed, key, false)).toEqual({})
  })

  test("a unit's other revisions go; other units stay", () => {
    const old = viewedKey("unit", "rev-1", "a.ts")
    const sameRevision = viewedKey("unit", "rev-2", "b.ts")
    const otherUnit = viewedKey("other", "rev-1", "a.ts")
    const next = nextViewedFiles(
      { [old]: true, [sameRevision]: true, [otherUnit]: true },
      viewedKey("unit", "rev-2", "a.ts"),
      true
    )
    expect(Object.keys(next).sort()).toEqual(
      [sameRevision, otherUnit, viewedKey("unit", "rev-2", "a.ts")].sort()
    )
  })

  test("unreadable keys are dropped", () => {
    const key = viewedKey("unit", "snapshot:abc", "a.ts")
    expect(nextViewedFiles({ "unit@rev:a.ts": true }, key, true)).toEqual({
      [key]: true,
    })
  })

  test(`keeps the ${MAX_VIEWED_FILES} most recently marked`, () => {
    let record: Record<string, true> = {}
    for (let unit = 0; unit < MAX_VIEWED_FILES + 20; unit++)
      record = nextViewedFiles(
        record,
        viewedKey(`unit-${unit}`, "rev", "a.ts"),
        true
      )
    const keys = Object.keys(record)
    expect(keys.length).toBe(MAX_VIEWED_FILES)
    expect(keys[0]).toBe(viewedKey("unit-20", "rev", "a.ts"))
    // Marking an old key again makes it the most recent.
    const again = nextViewedFiles(record, keys[0]!, true)
    expect(Object.keys(again).at(-1)).toBe(keys[0])
  })
})
