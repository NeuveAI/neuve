import { describe, expect, test } from "bun:test"

import { cn } from "../../src/lib/utils"

describe("cn merges the motion utilities", () => {
  test("a later duration, delay, ease or loop replaces an earlier one", () => {
    expect(cn("duration-120", "duration-surface-tone")).toBe(
      "duration-surface-tone"
    )
    expect(cn("duration-surface-tone", "duration-spring-snappy")).toBe(
      "duration-spring-snappy"
    )
    expect(cn("delay-150", "delay-switch-wait")).toBe("delay-switch-wait")
    expect(cn("ease-out", "ease-standard")).toBe("ease-standard")
    expect(cn("ease-standard", "ease-spring-gentle")).toBe("ease-spring-gentle")
    expect(cn("animate-spin", "animate-working-spin")).toBe(
      "animate-working-spin"
    )
  })

  test("a whole tone transition can be overridden", () => {
    expect(
      cn(
        "transition-colors duration-surface-tone ease-standard",
        "duration-chevron ease-ios-out"
      )
    ).toBe("transition-colors duration-chevron ease-ios-out")
  })

  test("other classes merge as before", () => {
    expect(cn("px-2 text-ink", "px-3", undefined)).toBe("text-ink px-3")
  })
})
