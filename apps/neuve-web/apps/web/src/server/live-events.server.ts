import type { AccountStatus } from "@neuve/runtime"

import { subscribeAccounts } from "./accounts.server"
import { Effect, Option } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { Log, ReviewProgress, Worker } from "@neuve/records-core"
import type { StoreLocation } from "@neuve/records-core"
import { readHeldReviews } from "@neuve/harness/held-reviews"
import type { LiveMark } from "@workspace/ui/neuve/states/live-status"

import type { PageChange, PageEvent } from "./live-events"

import {
  NoStore,
  holdRecords,
  readRecords,
  storeLocation,
} from "./records.server"
import { localRecordsChanges, onRecordsChanged } from "./records-changes.server"
import type { RecordsChanges } from "./records-changes.server"

/**
 * Web events (M5 LV1). One server-sent event stream per tab carries Records' mark: the log's
 * position counting only the event kinds a person's screens show (`ReviewProgress.reviewSequence`:
 * packets, dispositions, comments, feedback, stage completions; not agent turns), and a stamp of
 * the review jobs, which change without appending an event (a worker claiming the job, a worker
 * holding it for a missing sign-in). The page reloads its loaders when the mark differs from the
 * one they were loaded at, when the change can concern what they show: each event names the
 * reviews (cycles) whose events moved since the mark before it, whether the jobs did, and the
 * earlier reviews a packet published in one of them takes over (`PageChange`).
 *
 * Nothing is read on a timer. While any tab listens, a change to the store (`RecordsChanges`, or
 * this process's own commit) wakes one shared read; nothing is read while no tab listens. The
 * stream is state, not a log: each event carries an `id`, but the server reads no
 * `Last-Event-ID` and replays nothing. Every connection, first or reconnecting, starts with the
 * current mark, which is all a tab needs to catch up.
 * Account sets follow the first mark.
 */

/** A named heartbeat, so the page notices a connection that went quiet. It reads nothing. */
export const HEARTBEAT_MS = 10_000

const NO_STORE: LiveMark = { sequence: 0, jobs: "" }

/** How many of the newest unfinished review jobs the stamp names. */
const STAMPED_JOBS = 20

const jobsStamp = (location: StoreLocation) =>
  Effect.gen(function* () {
    const open = yield* ReviewProgress.openReviewJobs(STAMPED_JOBS)
    const claim = Option.getOrUndefined(yield* Worker.readClaim)
    // Which jobs the worker holds, by whom and for which sign-in; not when it last rechecked.
    const held = readHeldReviews(location)
      .map((entry) => `${entry.seq}:${entry.pid}:${entry.credential}`)
      .join(",")
    return [
      open.map((job) => `${job.seq}:${job.state}:${job.attempts}`).join(","),
      claim === undefined ? "" : `${claim.pid}@${claim.startedAt}`,
      held,
    ].join("|")
  })

const markOf = (location: StoreLocation) =>
  Effect.all({
    sequence: ReviewProgress.reviewSequence,
    jobs: jobsStamp(location),
  })

/** The packet kinds whose publication can give an earlier review's pages a newer review. */
const PACKET_KINDS = ["packet.published@1", "packet.published@2"] as const

/**
 * The most lineage events of one review read to name the reviews it takes over: one per unit
 * (`publish-sections.ts`), so far more than a review holds. Past it the change names everything,
 * never a partial list.
 */
export const LINEAGE_READ_BOUND = 2_000

/**
 * The earlier reviews whose work a packet published in `cycles` after `after` takes over: each
 * such cycle's `lineage.recorded@1` names, in `from`, the earlier units (and their cycles) its
 * units hold work of. A batch or unit page of one of those reviews is the only other page the
 * publication can change: its "Newer review" link and announcement follow that lineage to the
 * standing packet (`successorOf`, `batchSuccessor` in `desk.server.ts`). The harness appends a
 * publication's lineage in its batches' transactions, before the packet, so the lineage is in the
 * store when the packet moves the mark; the whole lineage is read, not only the range's, so a mark
 * read between the two still names them at the packet. Nothing is read for a cycle that moved
 * without a packet (a decision, a comment, a stage), nor for a change of the jobs alone.
 * `"all"` when a cycle's lineage is past `LINEAGE_READ_BOUND`.
 */
export const takenOverBy = (cycles: ReadonlyArray<string>, after: number) =>
  Effect.gen(function* () {
    const earlier = new Set<string>()
    for (const cycleId of cycles) {
      let published = false
      for (const kind of PACKET_KINDS)
        if (
          !published &&
          (yield* Log.history({ cycleId, kind, afterSeq: after, limit: 1 }))
            .length > 0
        )
          published = true
      if (!published) continue
      const lineage = yield* Log.history({
        cycleId,
        kind: "lineage.recorded@1",
        limit: LINEAGE_READ_BOUND + 1,
      })
      if (lineage.length > LINEAGE_READ_BOUND) return "all" as const
      for (const { event } of lineage)
        if (event.kind === "lineage.recorded@1")
          for (const from of event.payload.from)
            if (from.cycleId !== cycleId) earlier.add(from.cycleId)
    }
    return [...earlier].sort()
  })

/** Records' mark now, for a page load: what the pages compare with the stream's. */
export async function currentMark(): Promise<LiveMark> {
  try {
    return await readRecords("web.live.mark", markOf)
  } catch (error) {
    if (error instanceof NoStore) return NO_STORE
    throw error
  }
}

/** A mark, and the reviews whose events moved since the mark it was read after. */
export interface MarkRead {
  readonly mark: LiveMark
  /** `"all"` when they cannot be named (`ReviewProgress.changedCycles`), or with no mark before. */
  readonly cycles: ReadonlyArray<string> | "all"
  /** The earlier reviews a packet published in `cycles` takes over (`takenOverBy`); none when absent. */
  readonly takenOver?: ReadonlyArray<string> | "all"
  /**
   * Which connection the mark was read on. Another connection reads another file, perhaps a store
   * replaced, so its positions are not comparable with a mark read on the one before.
   */
  readonly source: number
}

/** Reads the mark for the stream, one read at a time. */
export interface MarkReader {
  /** The mark now, and what moved since `after`, a mark this reader gave. */
  readonly read: (after: LiveMark | undefined) => Promise<MarkRead>
  readonly close: () => Promise<void>
}

/** The stream's reads, over the one connection `holdRecords` keeps open while tabs listen. */
export function heldMarkReader(): MarkReader {
  const held = holdRecords()
  return {
    async read(after) {
      try {
        const read = await held.read("web.live.mark", (location) =>
          // A Linux WAL event can precede the commit's shared-memory publication. The store's
          // BEGIN IMMEDIATE waits for that writer, then holds one snapshot for mark and lineage.
          Effect.flatMap(SqlClient, (sql) => sql.withTransaction(
          Effect.gen(function* () {
            const mark = yield* markOf(location)
            const cycles =
              after === undefined || mark.sequence < after.sequence
                ? ("all" as const)
                : mark.sequence === after.sequence
                  ? []
                  : yield* ReviewProgress.changedCycles(
                      after.sequence,
                      mark.sequence
                    )
            if (cycles === "all" || cycles.length === 0 || after === undefined)
              return { mark, cycles }
            const takenOver = yield* takenOverBy(cycles, after.sequence)
            return { mark, cycles, takenOver }
          })
          ))
        )
        return { ...read, source: held.connection() }
      } catch (error) {
        if (error instanceof NoStore)
          return { mark: NO_STORE, cycles: "all", source: held.connection() }
        throw error
      }
    },
    close: held.close,
  }
}

/**
 * Runs `read` when triggered, one at a time: a trigger during a read causes exactly one more read
 * after it, however many arrive, so no change is lost and none is read twice over.
 */
export function coalesced(read: () => Promise<void>) {
  let running: Promise<void> | undefined
  let triggers = 0
  // The last check for triggers and the end of the run happen in one step, so a trigger between
  // them cannot be dropped.
  const loop = async () => {
    try {
      let seen: number
      do {
        seen = triggers
        await read()
      } while (triggers !== seen)
    } catch {
      // `read` reports its own failures.
    } finally {
      running = undefined
    }
  }
  return {
    trigger() {
      triggers += 1
      if (running === undefined) running = loop()
    },
    /** Settles when no read is running. */
    idle: () => running ?? Promise.resolve(),
  }
}

interface Listener {
  readonly mark: (event: PageEvent) => void
  /** The stream ends; the page reconnects and starts over. */
  readonly end: () => void
}

interface Session {
  readonly latest: () => LiveMark | undefined
  readonly close: () => Promise<void>
}

const moved = (latest: LiveMark | undefined, next: LiveMark) =>
  latest === undefined ||
  latest.sequence !== next.sequence ||
  latest.jobs !== next.jobs

/** The last mark sent, and the connection it was read on. */
interface Sent {
  readonly mark: LiveMark
  readonly source: number
}

/**
 * What moved from the last mark sent to the mark just read: nothing can be named when none was
 * sent, or when the two were read on different connections, even if marks in between were read
 * and not sent because they had not moved.
 */
const changeOf = (sent: Sent | undefined, read: MarkRead): PageChange =>
  sent === undefined ||
  read.cycles === "all" ||
  read.takenOver === "all" ||
  sent.source !== read.source
    ? "all"
    : {
        cycles: read.cycles,
        jobs: sent.mark.jobs !== read.mark.jobs,
        ...(read.takenOver !== undefined && read.takenOver.length > 0
          ? { takenOver: read.takenOver }
          : {}),
      }

/**
 * The streams of one BFF. The first listener starts `changes`, and only once the watch is live
 * reads the mark, so the read covers whatever was written before, and every write after it is
 * reported. Each change runs the coalesced read, and a new mark goes to every listener with what
 * moved since the last one; a listener that joins gets the latest mark with `"all"`, since it was
 * loaded at some other mark. The last listener stops the watch. A watch or a read that fails ends
 * every stream and forgets the mark: the pages show "reconnecting" and reconnect, and the new
 * connection watches and reads again.
 */
export function liveEvents(options: {
  readonly changes: RecordsChanges
  readonly reader: () => MarkReader
  /** This process's own commits (`records.server.ts`). */
  readonly local?: (changed: () => void) => () => void
  /**
   * The account sets each tab follows (`accounts.server.ts`), sent after the tab's first mark;
   * absent, a stream carries Records' marks only.
   */
  readonly accounts?: (
    listener: (statuses: readonly AccountStatus[]) => void
  ) => () => void
}) {
  const listeners = new Set<Listener>()
  let session: Session | undefined

  const fail = (error: unknown) => {
    console.warn("[live] following Records failed:", error)
    const ending = session
    session = undefined
    void ending?.close()
    const open = [...listeners]
    listeners.clear()
    for (const listener of open) listener.end()
  }

  const start = (): Session => {
    let closed = false
    let sent: Sent | undefined
    let stopWatch: (() => Promise<void>) | undefined
    let offLocal = () => {}
    const reader = options.reader()
    const reads = coalesced(async () => {
      try {
        const next = await reader.read(sent?.mark)
        if (closed || !moved(sent?.mark, next.mark)) return
        const event = { ...next.mark, changed: changeOf(sent, next) }
        sent = { mark: next.mark, source: next.source }
        for (const listener of listeners) listener.mark(event)
      } catch (error) {
        if (!closed) fail(error)
      }
    })
    // Closing gives up a watch still starting; one that goes live anyway is stopped at once.
    const abandon = new AbortController()
    void options.changes
      .subscribe(
        reads.trigger,
        (error) => {
          if (!closed) fail(error)
        },
        abandon.signal
      )
      .then(
        async (stop) => {
          if (closed) return stop()
          stopWatch = stop
          offLocal = (options.local ?? onRecordsChanged)(reads.trigger)
          reads.trigger()
        },
        (error: unknown) => {
          if (!closed) fail(error)
        }
      )
    return {
      latest: () => sent?.mark,
      // Never waits on a watch that is not live yet: closing must not hang on one that never is.
      async close() {
        closed = true
        abandon.abort()
        offLocal()
        await stopWatch?.()
        await reads.idle()
        await reader.close()
      },
    }
  }

  function subscribe(listener: Listener): () => void {
    listeners.add(listener)
    if (session === undefined) session = start()
    else {
      const latest = session.latest()
      if (latest !== undefined) listener.mark({ ...latest, changed: "all" })
    }
    return () => {
      if (!listeners.delete(listener) || listeners.size > 0) return
      const ending = session
      session = undefined
      void ending?.close()
    }
  }

  const encoder = new TextEncoder()

  /** The event stream for one tab: the current mark, each change, and a heartbeat. */
  function eventStream(request: Request): Response {
    let stop = () => {}
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (request.signal.aborted) {
          controller.close()
          return
        }
        let open = true
        const send = (text: string) => {
          if (!open) return
          try {
            controller.enqueue(encoder.encode(text))
          } catch {
            stop()
          }
        }
        let firstMarkSent = false
        let waitingAccounts: string | undefined
        const stopAccounts =
          options.accounts?.((accounts) => {
            if (!open) return
            const event = `event: accounts\ndata: ${JSON.stringify(accounts)}\n\n`
            if (firstMarkSent) send(event)
            else waitingAccounts = event
          }) ?? (() => {})
        const unsubscribe = subscribe({
          mark: (event) => {
            send(
              `id: ${event.sequence}\nevent: records\ndata: ${JSON.stringify(event)}\n\n`
            )
            firstMarkSent = true
            if (waitingAccounts !== undefined) {
              send(waitingAccounts)
              waitingAccounts = undefined
            }
          },
          end: () => stop(),
        })
        // A transport keepalive: it reads nothing.
        const heartbeat = setInterval(
          () => send("event: heartbeat\ndata: \n\n"),
          HEARTBEAT_MS
        )
        stop = () => {
          if (!open) return
          open = false
          waitingAccounts = undefined
          clearInterval(heartbeat)
          unsubscribe()
          stopAccounts()
          try {
            controller.close()
          } catch {
            // Already closed by the client.
          }
        }
        request.signal.addEventListener("abort", () => stop(), { once: true })
      },
      cancel() {
        stop()
      },
    })
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    })
  }

  return { eventStream }
}

const live = liveEvents({
  changes: localRecordsChanges(storeLocation),
  reader: () => heldMarkReader(),
  accounts: subscribeAccounts,
})

/** The event stream for one tab (`src/routes/api/events.ts`). */
export const eventStream = live.eventStream
