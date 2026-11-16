// For the web events' tests: a writer of a small reviewed cycle whose disposition moves Records'
// mark, and the real store watch with what a test needs to wait on it. Run as a script
// (`bun records-changes.fixture.ts <repository>`), it appends from its own process, as the CLI or
// the worker does, creating the store when there is none, and prints the cycle's ID.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import { Effect } from "effect"
import {
  Log,
  Store,
  mintUlid,
  resolveStoreLocation,
  sha256Hex,
} from "@neuve/records-core"
import type { StoreLocation } from "@neuve/records-core"

import { localRecordsChanges } from "./records-changes.server"
import type { RecordsChanges } from "./records-changes.server"
import { storeLocation } from "./records.server"

const actor = sha256Hex("neuve-actor/1\u0000test\u0000session")
const headOid = "a".repeat(40)
const range = { baseRef: "refs/heads/main", baseOid: "b".repeat(40), headOid }

/** One cycle, one batch, one unit and an agent's approval, which counts in the mark. */
export const reviewedCycle = (cycleId: string = mintUlid()) => {
  const event = (
    kind: string,
    idempotencyKey: string,
    attribution: unknown,
    payload: unknown
  ) => ({
    id: mintUlid(),
    kind,
    idempotencyKey,
    actor,
    occurredAt: new Date().toISOString(),
    attribution,
    payload,
  })
  const batchId = mintUlid()
  const unitId = mintUlid()
  return [
    event("cycle.opened@1", `cycle:${cycleId}`, { cycleId, range }, {}),
    event(
      "batch.recorded@1",
      `batch:${batchId}`,
      { cycleId, batchId },
      { title: "Batch", focus: "Focus" }
    ),
    event(
      "unit.recorded@1",
      `unit:${unitId}`,
      { cycleId, batchId, unitIds: [unitId] },
      {
        title: "Unit",
        ownedRanges: [{ path: "src/a.ts", startLine: 1, endLine: 9 }],
      }
    ),
    event(
      "disposition.recorded@1",
      `disposition:${unitId}`,
      { cycleId, unitIds: [unitId] },
      { verdict: "approve", reviewedHeadOid: headOid }
    ),
  ]
}

/** Folders a test creates to flush the watch, each one once (`recordingWatch`). */
const FLUSHES = 32
const flushFolder = (index: number) => `flush-${index}`

/**
 * The desk's store watch (`localRecordsChanges`) as a test follows it: every change counted, the
 * watcher's process, so a test can end it as a crash would, and `flush`. A flush is a change the
 * watch must report and that a test can tell apart from any other: it creates a folder the watch
 * was told to follow, and the watch reports one change after proving its watches live again, with
 * its count of live watches raised (`Store.watchChanges`). Events arrive in order, so every change
 * raised before a flush has been reported when it is. The store folder must exist to flush.
 */
export const recordingWatch = () => {
  let watch: Store.StoreWatch | undefined
  let location: StoreLocation | undefined
  let changes = 0
  let flushes = 0
  /** The changes counted when the last flush was reported. */
  let flushed = 0
  let flushing: { readonly armings: number; done: () => void } | undefined
  const waiting: Array<{ readonly after: number; readonly done: () => void }> =
    []
  const flushPaths = Array.from(
    { length: FLUSHES },
    (_, index) => `${flushFolder(index)}/marker`
  )
  const inner = localRecordsChanges(
    async () => {
      location = await storeLocation()
      return location
    },
    // records-core's watch, also following the flush folders, kept for the test.
    (at, changed, options) =>
      (watch = Store.watchChanges(at, changed, {
        also: [...(options?.also ?? []), ...flushPaths],
      }))
  )
  const port: RecordsChanges = {
    subscribe: (changed, failed, signal) =>
      inner.subscribe(
        () => {
          changes += 1
          changed()
          const current = watch
          if (
            flushing !== undefined &&
            current !== undefined &&
            current.armings >= flushing.armings
          ) {
            const { done } = flushing
            flushing = undefined
            done()
          }
          for (const entry of waiting.splice(0))
            if (changes > entry.after) entry.done()
            else waiting.push(entry)
        },
        failed,
        signal
      ),
  }
  return {
    changes: port,
    /** The running watcher's process. */
    pid: () => watch?.pid,
    /** How many changes the watch has reported. */
    count: () => changes,
    /** The next change the watch reports after the `after`th. */
    next(after: number = changes) {
      return new Promise<void>((done) => waiting.push({ after, done }))
    },
    /** Flushes the watch, and says how many other changes it reported since the last flush. */
    async flush(): Promise<number> {
      if (watch === undefined || location === undefined)
        throw new Error("Nothing is watching")
      if (flushes >= FLUSHES) throw new Error("No folder left to flush with")
      const seen = Promise.withResolvers<void>()
      flushing = { armings: watch.armings + 1, done: seen.resolve }
      mkdirSync(join(location.directory, flushFolder(flushes)))
      flushes += 1
      await seen.promise
      const others = changes - flushed - 1
      flushed = changes
      return others
    },
  }
}

if (import.meta.main) {
  const repository = process.argv.at(-1) ?? "."
  const cycleId = mintUlid()
  await Effect.runPromise(
    Effect.gen(function* () {
      const location = yield* resolveStoreLocation(repository)
      yield* Effect.andThen(
        Store.prepareForWrite,
        Log.append(reviewedCycle(cycleId))
      ).pipe(Effect.provide(Store.layer(location, { create: true })))
    }).pipe(Effect.provide(BunFileSystem.layer))
  )
  console.log(cycleId)
}
