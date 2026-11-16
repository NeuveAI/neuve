// Why (25 October 2026): the Reviews page is the only place left to start a review. When the
// newest review failed it must offer Start again even if no review ever finished (the store's only
// review failed), and it must never ask git whether the branch moved when there is nothing to
// compare with. The page's stories skip the loader, so this pins the decision itself.
import { expect, test } from "bun:test"
import type { ReviewStart } from "@workspace/ui/neuve/states/review-start"

import { nextStart } from "./next-start"

const preview = {
  branch: "stall-retry",
  base: "main",
  headOid: "7068a7b1a8f1c22a68bec344c8e79c4265f63f4b",
  mergeBase: "3eed81014d68f16ce4a083c6194b354504eaf5f5",
  ahead: 1,
  route: "openai/gpt-6.1-sol",
}
const ready: ReviewStart = { status: "ready", preview }
const failed: ReviewStart = {
  status: "ready",
  preview,
  failure: "The run timed out.",
}
const running: ReviewStart = {
  status: "running",
  run: {
    subject: "stall-retry",
    phase: { kind: "working" },
    route: preview.route,
    recorded: [],
  },
}

const asked: Array<[string, string]> = []
const moved = (answer: boolean) => async (reviewed: string, head: string) => {
  asked.push([reviewed, head])
  return answer
}

test("a failed newest review is offered again, even when no review finished", async () => {
  asked.length = 0
  expect(await nextStart(undefined, failed, moved(false))).toBe(failed)
  expect(await nextStart("a".repeat(40), failed, moved(false))).toBe(failed)
  expect(asked).toEqual([])
})

test("a running review is shown; with nothing finished and nothing failed, nothing is offered", async () => {
  asked.length = 0
  expect(await nextStart(undefined, running, moved(true))).toBe(running)
  expect(await nextStart(undefined, ready, moved(true))).toBeUndefined()
  expect(asked).toEqual([])
})

test("new work is offered only once the branch moved past the newest finished review", async () => {
  asked.length = 0
  const reviewed = "b".repeat(40)
  expect(await nextStart(reviewed, ready, moved(true))).toBe(ready)
  expect(await nextStart(reviewed, ready, moved(false))).toBeUndefined()
  expect(asked).toEqual([
    [reviewed, preview.headOid],
    [reviewed, preview.headOid],
  ])
  // Git can't say: nothing is offered.
  expect(
    await nextStart(reviewed, ready, () => Promise.reject(new Error("no git")))
  ).toBeUndefined()
})
