/**
 * The unlinked line (round-4.md, "Scope is always gathered", step 3) shows
 * for a gathered scope the harness reports as unlinked, and for no other
 * basis, even when the flag is set (review N1, desk-unlinked-1).
 */
import { describe, expect, test } from "bun:test"

import { unlinkedGatheredDeliveryPayload } from "@workspace/ui/fixtures/delivery.fixtures"
import { showsUnlinked } from "@workspace/ui/neuve/review-desk/delivery/criteria-card"

const check = unlinkedGatheredDeliveryPayload.check!

describe("showsUnlinked", () => {
  test("a gathered scope reported unlinked shows the line", () => {
    expect(showsUnlinked(check)).toBe(true)
  })

  test("a gathered scope without the flag shows nothing", () => {
    expect(showsUnlinked({ ...check, unlinked: undefined })).toBe(false)
  })

  test("the flag on a ticket's Done when shows nothing", () => {
    expect(showsUnlinked({ ...check, basis: "done-when" })).toBe(false)
    // Done when is the default basis.
    expect(showsUnlinked({ ...check, basis: undefined })).toBe(false)
  })

  test("the flag on a ticket's scope shows nothing", () => {
    expect(showsUnlinked({ ...check, basis: "scope" })).toBe(false)
  })
})
