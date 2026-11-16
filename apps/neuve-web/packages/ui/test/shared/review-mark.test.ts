import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
/**
 * The review mark's accessible names: the viewer is "You" once, never
 * "You, You" when their display name is already "You" (as every fixture
 * and the live BFF send it).
 */
import { describe, expect, test } from "bun:test"

import {
  ReviewMark,
  reviewActorLabel,
  reviewActorShort,
} from "@workspace/ui/neuve/shared/review-mark"

const you = (name: string) =>
  ({ kind: "person", person: { name, initials: "VD" }, isYou: true }) as const

describe("reviewActorLabel", () => {
  test("a viewer named You is plain You", () => {
    expect(reviewActorLabel(you("You"))).toBe("You")
  })

  test("a viewer with no name is plain You", () => {
    expect(reviewActorLabel(you(""))).toBe("You")
  })

  test("a viewer with their own name keeps it after You", () => {
    expect(reviewActorLabel(you("Vinicius"))).toBe("You, Vinicius")
  })

  test("another person is their name", () => {
    expect(
      reviewActorLabel({
        kind: "person",
        person: { name: "maya", initials: "MA" },
      })
    ).toBe("maya")
  })

  test("an agent is its short id and role", () => {
    expect(
      reviewActorLabel({
        kind: "agent",
        agent: { short: "R1", name: "Reviewer 1", role: "reviewer" },
      })
    ).toBe("R1, reviewer agent")
  })
})

describe("reviewActorShort", () => {
  test("the viewer's words read You", () => {
    expect(reviewActorShort(you("Vinicius"))).toBe("You")
  })
})

// Why (12.35): the overview must say when a review is carried, including compact accessible text.
test("a carried review mark is visibly attributed instead of looking fresh", () => {
  const html = renderToStaticMarkup(
    createElement(ReviewMark, {
      verdict: "approved",
      actor: {
        kind: "agent",
        agent: { short: "R1", name: "Reviewer", role: "reviewer" },
      },
      carried: "Review earlier, head abc, judgement def",
    })
  )
  expect(html).toContain("Carried")
  expect(html).toContain("approved")
})
