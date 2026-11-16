import { Effect, Option } from "effect"
import { JobQueue } from "@neuve/records-core"
import { gitHuman, requestReview, settingsRoute } from "@neuve/harness/request"

import { createRecords, repository } from "./records.server"

/**
 * A review request made from the web app (M5 ST1, ID1), for "Start a review"
 * to relay. It is the CLI's request with two inputs fixed: the requester is
 * always the person git names in the repository, never the caller's agent
 * session, and the route is the one the user's settings name, as the CLI
 * freezes without `--route` (10.85). Range, configuration, run key and cycle
 * rules stay in the harness. `@neuve/harness` is loaded from its own package
 * (vite.config.ts), so what the request freezes, the stack tools' parser
 * among it, is what the CLI freezes: `review-request.test.ts` checks the two
 * run keys are equal.
 *
 * It runs on Bun only: the harness reads git with `Bun.spawn`.
 */
export class RequesterUnknown extends Error {
  override readonly name = "RequesterUnknown"
}

export const requestFromWeb = (range: string) => {
  const at = repository()
  return createRecords("web.review.request", (location) =>
    Effect.gen(function* () {
      const human = yield* gitHuman(at)
      if (Option.isNone(human))
        return yield* Effect.fail(
          new RequesterUnknown(
            "git names no email here (git config user.email), so Neuve cannot record who asked for the review"
          )
        )
      return yield* requestReview({
        location,
        repository: at,
        range,
        requester: human.value,
        route: settingsRoute(),
      })
    }).pipe(Effect.provide(JobQueue.layer))
  )
}
