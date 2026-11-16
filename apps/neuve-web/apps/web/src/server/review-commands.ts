import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"
import { ReviewCommentAnchorSchema } from "@workspace/ui/neuve/review-comments/record"

import {
  recordDecision,
  recordLineComment,
  retractDecision,
} from "./desk.server"

/*
 * The desk's commands (M5 §1.3, ID1): the dock's decision, its comment and
 * undo, and a line comment, each recorded in Records as the person git names
 * in the repository, never as an agent session. They are POST server
 * functions behind the CSRF middleware in src/start.ts (ID2). Refusals from
 * Records' rules come back as errors the dock shows in its error line.
 */

const UnitId = z.string().min(1).max(64)
const Body = z.string().trim().min(1).max(20_000)

const Anchor = z.strictObject({
  path: z.string().min(1).max(4_096),
  side: z.enum(["old", "new"]),
  startLine: z.int().min(1),
  endLine: z.int().min(1),
})

export const sendDecision = createServerFn({ method: "POST" })
  .validator(
    z.strictObject({
      unitId: UnitId,
      kind: z.enum(["approve", "request-changes", "comment"]),
      body: z.string().max(20_000),
      /** The attached marker's lines; without them the comment is on the whole unit. */
      anchor: Anchor.optional(),
    })
  )
  .handler(({ data }) =>
    recordDecision({
      unitId: data.unitId,
      kind: data.kind,
      body: data.body.trim(),
      anchor: data.anchor,
    })
  )

export const withdrawDecision = createServerFn({ method: "POST" })
  .validator(z.strictObject({ dispositionId: z.string().min(1).max(64) }))
  .handler(({ data }) => retractDecision(data))

export const sendLineComment = createServerFn({ method: "POST" })
  .validator(
    z.strictObject({
      unitId: UnitId,
      revision: z.string().min(1).max(64),
      body: Body,
      anchor: Anchor,
      shown: ReviewCommentAnchorSchema,
    })
  )
  .handler(({ data }) => recordLineComment(data))
