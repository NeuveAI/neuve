import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"

import { movedPast } from "./branch-moved.server"
import { repository } from "./records.server"

const Oid = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)

/** Whether `head` has moved past the batch's reviewed head (branch-moved.server.ts). */
export const loadMovedPast = createServerFn({ method: "GET" })
  .validator(z.strictObject({ reviewed: Oid, head: Oid }))
  .handler(({ data }) => movedPast(repository(), data.reviewed, data.head))
