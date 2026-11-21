/**
 * Why (NEU-445): a rail card drew its disposition tag only while it was the
 * open one, so the rail hid which units were decided. A card now shows the
 * disposition standing on its unit, open or not, in the same word: the open
 * card's dock opens on that disposition (`decidedDock`), and only what the
 * dock alone knows stays on the open card.
 */
import { describe, expect, test } from "bun:test"

import { decidedDock } from "@workspace/ui/neuve/review-desk/atoms"
import { railCardChip } from "@workspace/ui/neuve/review-desk/unit-rail"

const word = (chip: ReturnType<typeof railCardChip>) => chip?.text ?? null

describe("railCardChip", () => {
  test("a card that is not open shows the disposition standing on its unit", () => {
    expect(word(railCardChip({ disposition: "approve" }))).toBe("approved")
    expect(word(railCardChip({ disposition: "request-changes" }))).toBe(
      "changes requested"
    )
  })

  test("a card says the same word open as not", () => {
    for (const disposition of ["approve", "request-changes"] as const) {
      const open = {
        dock: decidedDock(disposition, "human-required"),
        signal: undefined,
      }
      expect(word(railCardChip({ disposition }, open))).toBe(
        word(railCardChip({ disposition }))
      )
      // Another person's decision: the reader's dock is at rest.
      expect(
        word(railCardChip({ disposition }, { dock: "rest", signal: undefined }))
      ).toBe(word(railCardChip({ disposition })))
    }
  })

  test("a card with no disposition has no tag", () => {
    expect(railCardChip({})).toBeNull()
  })

  test("what only the open dock knows stays on the open card", () => {
    expect(
      word(railCardChip({}, { dock: "commented", signal: undefined }))
    ).toBe("commented")
    expect(word(railCardChip({}, { dock: "rest", signal: "conflict" }))).toBe(
      "conflict"
    )
    expect(railCardChip({})).toBeNull()
  })
})
