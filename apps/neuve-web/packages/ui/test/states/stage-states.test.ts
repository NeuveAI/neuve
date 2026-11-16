// Why: the stage list is the only sign of progress a person has before the first batch arrives, and
// it is read from nothing but the names of stages with a recorded completion. Every stage records
// its work in parts, Link's fill records before any finder, and Find, Verify and Link overlap, so
// the rule must never show a stage done that still works, nor a stage working that has nothing to
// do yet. The orders these cases use are the ones measured over 250 real runs (review-start.ts).
import { expect, test } from "bun:test"

import {
  REVIEW_STAGES,
  stageStates,
} from "@workspace/ui/neuve/states/review-start"
import type { RunningReview } from "@workspace/ui/neuve/states/review-start"

const run = (
  recorded: RunningReview["recorded"],
  phase: RunningReview["phase"] = { kind: "working" }
): RunningReview => ({
  subject: "feature",
  route: "openai/sol",
  phase,
  recorded,
})

const states = (review: RunningReview) =>
  Object.fromEntries(
    stageStates(review).map(({ stage, state }) => [stage, state])
  )

test("before any completion Precompute works, and before a worker none does", () => {
  expect(states(run([]))).toEqual({
    precompute: "current",
    frame: "pending",
    map: "pending",
    find: "pending",
    verify: "pending",
    link: "pending",
    publish: "pending",
  })
  expect(Object.values(states(run([], { kind: "queued" })))).toEqual(
    Array(REVIEW_STAGES.length).fill("pending")
  )
})

test("a recorded Precompute still works: one completion is one of its parts", () => {
  const shown = states(run(["precompute"]))
  expect(shown.precompute).toBe("current")
  expect(shown.frame).toBe("pending")
})

test("Link's fill before any finder: Map is done and only Find works", () => {
  expect(states(run(["precompute", "frame", "map", "link"]))).toEqual({
    precompute: "done",
    frame: "done",
    map: "done",
    find: "current",
    verify: "pending",
    link: "pending",
    publish: "pending",
  })
})

test("Find and Verify recorded: Find, Verify and Link all work", () => {
  expect(
    states(run(["precompute", "frame", "map", "link", "find", "verify"]))
  ).toEqual({
    precompute: "done",
    frame: "done",
    map: "done",
    find: "current",
    verify: "current",
    link: "current",
    publish: "pending",
  })
})

test("a recorded Publish, with nothing verified: what came before is done and Publish works", () => {
  expect(
    states(run(["precompute", "frame", "map", "link", "find", "publish"]))
  ).toEqual({
    precompute: "done",
    frame: "done",
    map: "done",
    find: "done",
    verify: "done",
    link: "done",
    publish: "current",
  })
})

test("everything recorded: Publish is never shown done before the batch opens", () => {
  const shown = states(run([...REVIEW_STAGES]))
  expect(shown.link).toBe("done")
  expect(shown.publish).toBe("current")
})
