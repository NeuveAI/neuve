import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"
import type { SavedFeedback } from "@workspace/ui/neuve/types"

import { recordFeedback } from "./feedback.server"

/*
 * The desk's feedback command (M5 S7, 10.100): a server function over
 * feedback.server.ts; the desk load carries the read. It is a POST behind
 * the CSRF middleware in src/start.ts (ID2), recorded as the person git
 * names in the repository. Records' append rules check the target and the answer again;
 * a refusal comes back as an error the control announces.
 */

const Id = z.string().min(1).max(64)
const Note = z.string().trim().min(1).max(4_000).optional()
const Grade = z.enum(["necessary", "useful", "irrelevant", "misleading"])
const YesNo = z.enum(["yes", "no"])
const common = { target: Id, harnessCallVisible: z.boolean(), note: Note }

/** What the browser may send: strict, so an unknown field is refused. */
export const Submission = z.discriminatedUnion("on", [
  z.strictObject({
    on: z.literal("unit"),
    ...common,
    complexity: z.enum(["low", "high"]).optional(),
    easeOfValidation: z.enum(["easy", "hard"]).optional(),
    lane: z
      .enum([
        "human-required",
        "human-suggested",
        "agentic-review",
        "static-automation",
      ])
      .optional(),
    verdict: z.enum(["approve", "request-changes"]).optional(),
  }),
  z.strictObject({
    on: z.literal("finding"),
    ...common,
    judged: z.enum(["valid", "invalid", "unsure"]).optional(),
  }),
  z.strictObject({
    on: z.literal("reference"),
    ...common,
    grade: Grade.optional(),
    between: Grade.optional(),
    // The note's rubric (10.107): each row optional; an unanswered row is
    // left out, never sent as yes. The check row is asked only when the
    // reference has a check.
    saysWhy: YesNo.optional(),
    tiedToLines: YesNo.optional(),
    checkActionable: YesNo.optional(),
    accurate: YesNo.optional(),
    length: z.enum(["too-short", "right", "too-long"]).optional(),
    // No harness's grade: the browser cannot set it. The BFF fills it from
    // the published packet when the call was visible (feedback.server.ts).
  }),
  z.strictObject({
    on: z.literal("digest"),
    ...common,
    accurate: YesNo.optional(),
    complete: YesNo.optional(),
    misleadingClaim: z.enum(["none", "some"]).optional(),
    neutralBeforeVerdict: YesNo.optional(),
  }),
])

export const sendFeedback = createServerFn({ method: "POST" })
  .validator(Submission)
  .handler(({ data }): Promise<SavedFeedback> => recordFeedback(data))
