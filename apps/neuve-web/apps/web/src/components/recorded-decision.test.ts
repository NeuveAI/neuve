// Why (10.102): Records cannot withdraw a comment, so a comment must never come back on reload as a
// decided dock with an Undo that does nothing; that dock also blocked adding another whole-unit
// comment. Only the reader's current disposition reopens the dock decided.
import { expect, test } from "bun:test"
import { realPacketDeskFixtures } from "@workspace/ui/fixtures/real-packet.fixtures"
import type { ReviewDeskData } from "@workspace/ui/neuve/types"

import { recordedDecision } from "./recorded-decision"

const desk = Object.values(realPacketDeskFixtures).find(
  (data) => data.unit.lane === "human-required"
) as ReviewDeskData

test("the dock is at rest after a reload when the reader's only recorded item is a comment", () => {
  // A whole-unit comment is in Records; no disposition of the reader's is current.
  const onlyComment = recordedDecision({ status: "ready", data: desk })
  expect(onlyComment).toEqual({})
})

test("the reader's current disposition reopens the dock decided, with its receipt for Undo", () => {
  const decided = recordedDecision({
    status: "ready",
    data: {
      ...desk,
      currentDecision: { commandId: "01DISPOSITION", decision: "approve" },
    },
  })
  expect(decided).toEqual({
    decisionReceipt: { commandId: "01DISPOSITION", kind: "disposition" },
    initialState: { dock: "approved" },
  })
})
