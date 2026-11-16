/**
 * A request for changes rests on a comment saying what to change (10.69).
 * The dock sends one only when it has words, or an attached comment marker
 * on a human-required unit; the live desk's empty `defaultAttachment` is no
 * marker (review F4). The same rule disables Send and stops ⌘↵ handing
 * focus on, so a request that can't be sent stays open.
 */
import { expect, test } from "bun:test"
import { createStore } from "jotai"

import { reviewDeskFixture } from "@workspace/ui/fixtures/review-batch.fixtures"
import {
  currentResponsibilityAtom,
  decisionSinkAtom,
  dockAtom,
  draftAtom,
  requestSendableAtom,
  sendChangesAtom,
  startChangesAtom,
} from "@workspace/ui/neuve/review-desk/atoms"
import type { LiveDecision } from "@workspace/ui/neuve/review-desk/atoms"
import type { ReviewDeskData } from "@workspace/ui/neuve/types"

function request(
  lane: "human-required" | "agentic-review",
  attachment: string,
  text = ""
) {
  const store = createStore()
  const unit: ReviewDeskData["unit"] = {
    ...reviewDeskFixture.unit,
    lane,
    responsibility: undefined,
    defaultAttachment: attachment,
  }
  store.set(currentResponsibilityAtom, unit)
  const sent: Array<LiveDecision> = []
  store.set(decisionSinkAtom, async (decision) => {
    sent.push(decision)
  })
  store.set(startChangesAtom, attachment)
  store.set(draftAtom, text)
  return { store, sent }
}

test("a blank request with the live desk's empty marker is not sendable and is not sent", async () => {
  const { store, sent } = request("human-required", "", "   ")
  expect(store.get(requestSendableAtom)).toBe(false)
  await store.set(sendChangesAtom)
  expect(sent).toEqual([])
  expect(store.get(dockAtom)).toBe("composing")
})

test("a blank agentic request is not sent", async () => {
  const { store, sent } = request("agentic-review", "")
  expect(store.get(requestSendableAtom)).toBe(false)
  await store.set(sendChangesAtom)
  expect(sent).toEqual([])
})

test("an attached comment marker on a human-required unit still sends without text", async () => {
  const { store, sent } = request("human-required", "conflict")
  expect(store.get(requestSendableAtom)).toBe(true)
  await store.set(sendChangesAtom)
  expect(sent).toEqual([
    { kind: "request-changes", body: "", attachment: "conflict" },
  ])
})

test("words are sent trimmed, with no marker", async () => {
  const { store, sent } = request("agentic-review", "", " Fix the retry. ")
  expect(store.get(requestSendableAtom)).toBe(true)
  await store.set(sendChangesAtom)
  expect(sent).toEqual([{ kind: "request-changes", body: "Fix the retry." }])
})
