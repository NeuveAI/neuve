// Why: the overview's and the desk's header say a review stopped short (batches unpublished, no run
// of it going or queued) from Records' answer (`ReviewProgress.cycleRunGoing`, tested in
// records-core). A wrong "stopped" tells a person the review is over while it still runs, so the
// projection must claim it only on a definite no, and say nothing when Records cannot tell. This
// runs the overview's read on a real store holding a new-shape review with a batch still to come,
// for each of the three answers. The tests of the composed read this replaced (open jobs, their
// requests, the bound on how many it looked through) went with it.
import { afterAll, expect, test } from "bun:test"
import { Effect } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { Log, sha256Hex } from "@neuve/records-core"
import {
  contentLayer,
  storeContent,
} from "../../../../../../packages/records-core/tests/new-shape-support"
import { newShapeReview } from "../../../../../../packages/records-core/tests/review-fixtures"
import {
  agent,
  envelope,
  freshLocation,
  removeTemporaryDirectories,
  runOn,
} from "../../../../../../packages/records-core/tests/support"

import { overviewOf, overviewRead } from "./desk.server"

afterAll(removeTemporaryDirectories)

const range = {
  baseRef: "refs/heads/main",
  baseOid: "b".repeat(40),
  headOid: "a".repeat(40),
}

type Run = "going" | "ended" | "no request"

/** The overview of a review with one batch published and one to come, its run as `run` says. */
const overviewWith = async (run: Run) => {
  const location = freshLocation()
  const fixture = newShapeReview()
  const second = [fixture.events.second.id, fixture.events.gaps.second.id]
  const request = envelope(
    "review.requested@1",
    `request:${fixture.cycleId}`,
    agent,
    { cycleId: fixture.cycleId, range },
    {
      runKey: sha256Hex(fixture.runId),
      generation: 0,
      pipeline: { version: 1, config: {} },
    }
  )
  const read = await runOn(
    location,
    Effect.gen(function* () {
      yield* storeContent(fixture)
      yield* Log.append([
        ...fixture.all.filter((event) => !second.includes(event.id)),
        // Appending a request enqueues its run's job.
        ...(run === "no request" ? [] : [request]),
      ])
      if (run === "ended") {
        const sql = yield* SqlClient
        yield* sql`UPDATE jobs SET state = 'completed' WHERE event_id = ${request.id}`
      }
      return yield* overviewRead(undefined, {
        people: false,
        viewer: undefined,
      })
    }).pipe(Effect.provide(contentLayer(location))) as Effect.Effect<
      Effect.Success<ReturnType<typeof overviewRead>>,
      unknown,
      never
    >
  )
  if (!read) throw new Error("expected the first batch")
  return overviewOf(read, "acme/docs-app")
}

test("a review with a batch to come says it stopped only when Records says no run of it is going", async () => {
  const [going, ended, unknown] = await Promise.all([
    overviewWith("going"),
    overviewWith("ended"),
    overviewWith("no request"),
  ])
  for (const overview of [going, ended, unknown])
    expect(overview.batches?.pending).toBe(1)
  // Its run's job is open: still being reviewed.
  expect(going.batches).not.toHaveProperty("stopped")
  // Its run ended with the batch unpublished: a definite no.
  expect(ended.batches?.stopped).toBe(true)
  // Records holds no request of it, so it cannot tell: nothing is said.
  expect(unknown.batches).not.toHaveProperty("stopped")
})
