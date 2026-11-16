import { Effect } from "effect"
import { PublishedPackets, ReviewOrigins } from "@neuve/records-core"
import { NoStore, readRecords, repository } from "./records.server"

/** An exact cycle read never falls back to a different repository review. */
export async function reviewCycle(reference: string) {
  try {
    return await readRecords("web.review.cycle", () =>
      Effect.gen(function* () {
        const cycle = yield* ReviewOrigins.cycle(reference)
        if (!cycle) return undefined
        const packet = yield* PublishedPackets.readStanding(reference, {
          repository: repository(),
        })
        const origins = yield* ReviewOrigins.list({ reference })
        return {
          ...cycle,
          batches:
            packet?.batches.map((batch) => ({
              id: batch.batchId,
              title: batch.recorded?.payload.title ?? batch.batchId,
            })) ?? [],
          origins: origins.map(({ origin }) => origin),
        }
      })
    )
  } catch (error) {
    if (error instanceof NoStore) return undefined
    throw error
  }
}
