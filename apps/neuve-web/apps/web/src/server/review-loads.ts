import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"
import type { CommitLineageLoad, ReviewsLoad } from "@workspace/ui/neuve/types"

import { deskLoad, overviewLoad } from "./desk.server"
import { feedbackOn } from "./feedback.server"
import { reviewsLoad } from "./reviews.server"
import type { LiveDeskLoad, LiveOverviewLoad } from "./desk.server"

/*
 * Page loads for the live routes (M5 RD4): server functions that run only on
 * the server and read Records through records-core, returning the same
 * shapes the screens already take. `/` lists the repository's reviews,
 * `/batch/<id>` any batch of a standing packet,
 * `/review/<unit>` a unit (RD3).
 */

/** An ID from the address; one Records does not hold opens the empty state. */
const Id = z.string().min(1).max(64)

/** `/`: the repository's reviews, a page and a filter of them. */
export const loadReviews = createServerFn({ method: "GET" })
  .validator(
    z.strictObject({
      page: z.number().int().min(1).max(10_000),
      filter: z.enum(["all", "waiting"]),
    })
  )
  .handler(({ data }): Promise<ReviewsLoad> => reviewsLoad(data))

/*
 * `stay` is set by a route's loader when it reloads the page the reader is
 * already on (a live reload): a batch or unit a newer review replaced then
 * keeps its page, read from the packet it was in, and says so. Entering a
 * page never sets it.
 */

export const loadOverview = createServerFn({ method: "GET" })
  .validator(
    z.strictObject({ batchId: Id.optional(), stay: z.boolean().optional() })
  )
  .handler(({ data }): Promise<LiveOverviewLoad> =>
    overviewLoad(data.batchId, { stay: data.stay ?? false })
  )

export const loadDesk = createServerFn({ method: "GET" })
  .validator(z.strictObject({ unitId: Id, stay: z.boolean().optional() }))
  .handler(({ data }): Promise<LiveDeskLoad> =>
    deskLoad(data.unitId, { feedback: feedbackOn(), stay: data.stay ?? false })
  )

/**
 * The lineage page stays empty in M5: which agents and sessions work on a
 * branch is not defined for the desk yet (proposal open point 8).
 */
export const loadCommit = (): CommitLineageLoad => ({
  status: "empty",
  reason: "no-batch",
})
