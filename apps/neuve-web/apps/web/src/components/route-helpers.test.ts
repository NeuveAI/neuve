import { expect, test } from "bun:test"

import { errorDetail } from "./error-detail"
import { validateChangesSearch } from "./commit-id"
import { deskUnitFromPath } from "./pending-unit"

const A = "4fc76f5d30ecb4a5fb7aae205093112389bf96a1"
test("changes search: a full id is kept", () => {
  expect(validateChangesSearch({ fromRevisionId: A })).toEqual({
    fromRevisionId: A,
  })
})

test("changes search: an invalid id is explicitly undefined", () => {
  const search = validateChangesSearch({ fromRevisionId: "nothex" })
  expect(Object.hasOwn(search, "fromRevisionId")).toBe(true)
  expect(search.fromRevisionId).toBeUndefined()
  expect(
    validateChangesSearch({ fromRevisionId: 7 }).fromRevisionId
  ).toBeUndefined()
})

test("error detail: named errors keep their name", () => {
  class SchemaError extends Error {
    override name = "SchemaError"
  }
  expect(errorDetail(new SchemaError("bad id"))).toBe("SchemaError: bad id")
  expect(errorDetail(new Error("plain"))).toBe("plain")
  expect(errorDetail(new Error(""))).toBeUndefined()
  expect(errorDetail("text")).toBe("text")
  expect(errorDetail({ message: "x" })).toBeUndefined()
})

test("desk path: unit ids from live and mock desks", () => {
  expect(deskUnitFromPath("/review/abc-1")).toBe("abc-1")
  expect(deskUnitFromPath("/mock/review/abc-1")).toBe("abc-1")
  expect(deskUnitFromPath("/review/a%20b")).toBe("a b")
  expect(deskUnitFromPath("/review/%E0%A4%A")).toBeNull()
  expect(deskUnitFromPath("/")).toBeNull()
  expect(deskUnitFromPath("/changes/4fc76f5")).toBeNull()
})
