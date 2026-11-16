import * as React from "react"
import { useRouter } from "@tanstack/react-router"

import { createMemoryReviewCommentRepository } from "@workspace/ui/neuve/review-comments/repository"
import type {
  CommentSink,
  DecisionSink,
  UndoSink,
} from "@workspace/ui/neuve/review-desk/atoms"
import type { ReviewDeskData } from "@workspace/ui/neuve/types"

import { markerLines } from "./marker-lines"

import {
  sendDecision,
  sendLineComment,
  withdrawDecision,
} from "@/server/review-commands"

/**
 * The live desk's sinks (M5 §3.3, §6): the dock's decision, its comment and
 * undo, and line comments go to Records through the BFF's commands, as the
 * person git names (ID1). After each one the route's data is read again, so
 * the desk shows what Records holds. Comments live in a memory repository the
 * desk fills from the loaded records, never in browser storage.
 */
export const liveCommentRepository = createMemoryReviewCommentRepository()

export function useLiveDeskSinks(
  unitId: string,
  data: ReviewDeskData | undefined
) {
  const router = useRouter()
  return React.useMemo(() => {
    const refresh = () => router.invalidate()
    const decisionSink: DecisionSink = async (decision) => {
      const anchor = markerLines(data, decision.attachment)
      const receipt = await sendDecision({
        data: {
          unitId,
          kind: decision.kind,
          body: decision.body,
          ...(anchor ? { anchor } : {}),
        },
      })
      await refresh()
      return receipt
    }
    const undoSink: UndoSink = async (receipt) => {
      await withdrawDecision({ data: { dispositionId: receipt.commandId } })
      await refresh()
    }
    const commentSink: CommentSink = async (input) => {
      const { range } = input.anchor
      if (range.endSide !== undefined && range.endSide !== range.side)
        throw new Error("A review comment covers lines on one side of the diff")
      const record = await sendLineComment({
        data: {
          unitId: input.unitId,
          revision: input.revision,
          body: input.body,
          anchor: {
            path: input.anchor.filePath,
            side: range.side === "deletions" ? "old" : "new",
            startLine: Math.min(range.start, range.end),
            endLine: Math.max(range.start, range.end),
          },
          shown: input.anchor,
        },
      })
      await refresh()
      return record
    }
    return { decisionSink, undoSink, commentSink }
  }, [router, unitId, data])
}
