// Why: the web events replaced a one-second read of Records' mark with push, and a push that loses
// a change, reads without one, names the wrong review, or hangs after a failure would leave a
// person reading a stale review with nothing to tell them. These check the stream at its boundary,
// the SSE response the page reads: first with a fake watch and reader, where each trigger is under
// the test's control, then on real stores with the desk's watch (records-core's), where the writer
// is this process or another one. The page's side, whether a change reloads the page on screen, is
// a pure function checked for each route shape.
//
// Removed with the interim watcher: the retry loop that wrote the held review jobs again until the
// re-armed watch on harness/ reported it, and `proveLive`, which touched the database until the
// watch said anything; records-core's watch is live when it says so.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import {
  Blobs,
  Log,
  canonicalJson,
  mintUlid,
  sha256Hex,
} from "@neuve/records-core"
import { heldReviewsPath } from "@neuve/harness/held-reviews"
import type {
  LiveChange,
  LiveMark,
} from "@workspace/ui/neuve/states/live-status"

import { currentMark, heldMarkReader, liveEvents } from "./live-events.server"
import type { MarkRead, MarkReader } from "./live-events.server"
import { mergeChanges, pageConcerned } from "./live-events"
import type { PageChange, PageEvent } from "./live-events"
import { localRecordsChanges } from "./records-changes.server"
import type { RecordsChanges } from "./records-changes.server"
import { createRecords, storeLocation } from "./records.server"
import { recordingWatch, reviewedCycle } from "./records-changes.fixture"

const FIXTURE = join(import.meta.dir, "records-changes.fixture.ts")

let root = ""
const prior = process.env.NEUVE_REPOSITORY
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "neuve-web-live-"))
})
afterAll(async () => {
  if (prior === undefined) delete process.env.NEUVE_REPOSITORY
  else process.env.NEUVE_REPOSITORY = prior
  await rm(root, { recursive: true, force: true })
})

/** The frames of one stream, read in order as the page's EventSource would. */
const frames = (response: Response) => {
  const body = response.body
  if (body === null) throw new Error("The stream has no body")
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const next = async (): Promise<{ event: string; data: string } | null> => {
    for (;;) {
      const end = buffer.indexOf("\n\n")
      if (end >= 0) {
        const frame = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const field = (name: string) =>
          frame
            .split("\n")
            .find((line) => line.startsWith(`${name}: `))
            ?.slice(name.length + 2) ?? ""
        return { event: field("event"), data: field("data") }
      }
      const chunk = await reader.read()
      if (chunk.done) return null
      buffer += decoder.decode(chunk.value, { stream: true })
    }
  }
  return {
    next,
    async mark(): Promise<PageEvent> {
      for (;;) {
        const frame = await next()
        if (frame === null) throw new Error("The stream closed")
        if (frame.event === "records")
          return JSON.parse(frame.data) as PageEvent
      }
    },
    close: () => reader.cancel(),
  }
}

const open = (live: ReturnType<typeof liveEvents>) =>
  frames(live.eventStream(new Request("http://localhost/api/events")))

/** A watch the test fires by hand. */
const fakeChanges = () => {
  const subscriptions: Array<{
    changed: () => void
    failed: (error: Error) => void
  }> = []
  let disarmed = 0
  const changes: RecordsChanges = {
    subscribe: (changed, failed) => {
      subscriptions.push({ changed, failed })
      return Promise.resolve(async () => {
        disarmed += 1
      })
    },
  }
  return {
    changes,
    last: () => {
      const subscription = subscriptions.at(-1)
      if (subscription === undefined) throw new Error("Nothing subscribed")
      return subscription
    },
    subscriptions: () => subscriptions.length,
    disarmed: () => disarmed,
  }
}

/**
 * A reader of a mark the test sets, and of the cycles it says moved since the last one;
 * `hold` keeps the next read open until released.
 */
const fakeReader = () => {
  let mark: LiveMark = { sequence: 1, jobs: "" }
  let cycles: MarkRead["cycles"] = []
  let source = 1
  let reads = 0
  let closes = 0
  let gate: Promise<void> | undefined
  const reader: MarkReader = {
    async read() {
      reads += 1
      const value = { mark, cycles, source }
      await gate
      return value
    },
    close: async () => {
      closes += 1
    },
  }
  return {
    reader,
    set: (next: LiveMark, moved: MarkRead["cycles"] = [], on = source) => {
      mark = next
      cycles = moved
      source = on
    },
    hold: () => {
      const release = Promise.withResolvers<void>()
      gate = release.promise
      return () => {
        gate = undefined
        release.resolve()
      }
    },
    reads: () => reads,
    closes: () => closes,
  }
}

/** Lets settled promises run their callbacks; it waits for no event. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

test("nothing is read without a change: the stream's only timer is the heartbeat, which reads nothing", async () => {
  const timers: Array<() => void> = []
  const realInterval = globalThis.setInterval
  const realClear = globalThis.clearInterval
  globalThis.setInterval = ((callback: () => void) => {
    timers.push(callback)
    return 0
  }) as unknown as typeof setInterval
  globalThis.clearInterval = () => {}
  try {
    const watch = fakeChanges()
    const marks = fakeReader()
    const live = liveEvents({
      changes: watch.changes,
      reader: () => marks.reader,
      local: () => () => {},
    })
    const stream = open(live)
    expect(await stream.mark()).toEqual({
      sequence: 1,
      jobs: "",
      changed: "all",
    })
    expect(marks.reads()).toBe(1)
    expect(timers).toHaveLength(1)
    for (const timer of timers) timer()
    expect((await stream.next())?.event).toBe("heartbeat")
    await settle()
    expect(marks.reads()).toBe(1)
    // A change that moves nothing a person sees is read and sends nothing.
    watch.last().changed()
    marks.set({ sequence: 2, jobs: "" })
    watch.last().changed()
    expect(await stream.mark()).toMatchObject({ sequence: 2, jobs: "" })
    expect(marks.reads()).toBe(3)
    await stream.close()
  } finally {
    globalThis.setInterval = realInterval
    globalThis.clearInterval = realClear
  }
})

test("a change during a read is read once more after it, however many arrive", async () => {
  const watch = fakeChanges()
  const marks = fakeReader()
  const live = liveEvents({
    changes: watch.changes,
    reader: () => marks.reader,
    local: () => () => {},
  })
  const stream = open(live)
  expect((await stream.mark()).sequence).toBe(1)
  const release = marks.hold()
  watch.last().changed()
  // The read in flight has the old mark; the change lands while it runs.
  marks.set({ sequence: 2, jobs: "" })
  watch.last().changed()
  watch.last().changed()
  watch.last().changed()
  release()
  expect(await stream.mark()).toMatchObject({ sequence: 2, jobs: "" })
  await settle()
  expect(marks.reads()).toBe(3)
  await stream.close()
})

test("a failed watch ends every stream and forgets the mark; a reconnect arms and reads again", async () => {
  const watch = fakeChanges()
  const marks = fakeReader()
  const live = liveEvents({
    changes: watch.changes,
    reader: () => marks.reader,
    local: () => () => {},
  })
  const first = open(live)
  const second = open(live)
  expect((await first.mark()).sequence).toBe(1)
  expect((await second.mark()).sequence).toBe(1)
  expect(marks.reads()).toBe(1)
  watch.last().failed(new Error("watcher exited"))
  expect(await first.next()).toBeNull()
  expect(await second.next()).toBeNull()
  await settle()
  expect(watch.disarmed()).toBe(1)
  expect(marks.closes()).toBe(1)
  const again = open(live)
  expect((await again.mark()).sequence).toBe(1)
  expect(watch.subscriptions()).toBe(2)
  expect(marks.reads()).toBe(2)
  await again.close()
  await settle()
  expect(watch.disarmed()).toBe(2)
})

test("a read that fails ends the streams too, so the page shows it is reconnecting", async () => {
  const watch = fakeChanges()
  const live = liveEvents({
    changes: watch.changes,
    reader: () => ({
      read: () => Promise.reject(new Error("database is locked")),
      close: async () => {},
    }),
    local: () => () => {},
  })
  const stream = open(live)
  expect(await stream.next()).toBeNull()
})

test("closing a stream whose watch never arms does not wait on it, and gives the arm up", async () => {
  const signals: Array<AbortSignal | undefined> = []
  let readerClosed = Promise.withResolvers<void>()
  const live = liveEvents({
    changes: {
      // A watch that never says it is armed.
      subscribe: (_changed, _failed, signal) => {
        signals.push(signal)
        return new Promise(() => {})
      },
    },
    reader: () => ({
      read: () =>
        Promise.resolve({
          mark: { sequence: 1, jobs: "" },
          cycles: "all",
          source: 1,
        }),
      close: async () => readerClosed.resolve(),
    }),
    local: () => () => {},
  })
  const first = open(live)
  await first.close()
  // Had closing waited on the arm, the session would never reach its reader.
  await readerClosed.promise
  expect(signals[0]?.aborted).toBe(true)
  readerClosed = Promise.withResolvers<void>()
  const second = open(live)
  expect(signals).toHaveLength(2)
  expect(signals[1]?.aborted).toBe(false)
  await second.close()
  await readerClosed.promise
})

test("each mark says what moved since the last one: the cycles, the jobs, or all of it", async () => {
  const watch = fakeChanges()
  const marks = fakeReader()
  const live = liveEvents({
    changes: watch.changes,
    reader: () => marks.reader,
    local: () => () => {},
  })
  const stream = open(live)
  // The first mark of a connection can name nothing: the page was loaded at some other mark.
  expect((await stream.mark()).changed).toBe("all")
  const cycle = mintUlid()
  marks.set({ sequence: 2, jobs: "" }, [cycle])
  watch.last().changed()
  expect((await stream.mark()).changed).toEqual({
    cycles: [cycle],
    jobs: false,
  })
  // Only the jobs moved: no cycle is named.
  marks.set({ sequence: 2, jobs: "7:active:1" }, [])
  watch.last().changed()
  expect((await stream.mark()).changed).toEqual({ cycles: [], jobs: true })
  // A tab that joins gets the latest mark, naming nothing.
  const joined = open(live)
  expect(await joined.mark()).toEqual({
    sequence: 2,
    jobs: "7:active:1",
    changed: "all",
  })
  // The reader could not name the cycles.
  marks.set({ sequence: 900, jobs: "7:active:1" }, "all")
  watch.last().changed()
  expect((await stream.mark()).changed).toBe("all")
  expect((await joined.mark()).changed).toBe("all")
  await stream.close()
  await joined.close()
})

test("a mark read on another connection than the last one sent names nothing, even after reads in between sent nothing", async () => {
  const watch = fakeChanges()
  const marks = fakeReader()
  const live = liveEvents({
    changes: watch.changes,
    reader: () => marks.reader,
    local: () => () => {},
  })
  const stream = open(live)
  expect((await stream.mark()).changed).toBe("all")
  // Another connection (a store replaced), with the same mark: nothing to send.
  marks.set({ sequence: 1, jobs: "" }, [], 2)
  watch.last().changed()
  await settle()
  expect(marks.reads()).toBe(2)
  // The next mark moved on it, and the reader names a cycle counted from the last mark sent.
  marks.set({ sequence: 5, jobs: "" }, [mintUlid()], 2)
  watch.last().changed()
  expect((await stream.mark()).changed).toBe("all")
  // After it, the same connection names what moved again.
  const cycle = mintUlid()
  marks.set({ sequence: 6, jobs: "" }, [cycle], 2)
  watch.last().changed()
  expect((await stream.mark()).changed).toEqual({
    cycles: [cycle],
    jobs: false,
  })
  await stream.close()
})

test("the page reloads only for a change that can concern what it shows", () => {
  const shown = mintUlid()
  const other = mintUlid()
  const of = (cycles: ReadonlyArray<string>, jobs = false): LiveChange => ({
    cycles,
    jobs,
  })
  const batch = (pending?: number) => ({
    routeId: "/batch/$batchId",
    params: { batchId: mintUlid() },
    loaderData: {
      status: "ready",
      data: { batches: pending === undefined ? {} : { pending } },
      cycleId: shown,
    },
  })
  const unit = (pending?: number) => ({
    routeId: "/review/$unitId",
    params: { unitId: mintUlid() },
    loaderData: {
      load: {
        status: "ready",
        data: { batches: pending === undefined ? {} : { pending } },
      },
      cycleId: shown,
    },
  })
  const reviews = { routeId: "/", params: {}, loaderData: { kind: "list" } }
  const cyclePage = {
    routeId: "/cycles/$cycle/",
    params: { cycle: shown },
    loaderData: { cycle: undefined },
  }
  for (const page of [
    reviews,
    cyclePage,
    batch(),
    unit(),
    batch(1),
    unit(1),
    undefined,
  ]) {
    // Nothing named, or the page's own review: always.
    expect(pageConcerned("all", page)).toBe(true)
    expect(pageConcerned(of([other, shown]), page)).toBe(true)
  }
  // The Reviews list and the start page concern every review and the jobs.
  expect(pageConcerned(of([other]), reviews)).toBe(true)
  expect(pageConcerned(of([], true), reviews)).toBe(true)
  // A review's own page shows it running: its cycle or the jobs.
  expect(pageConcerned(of([other]), cyclePage)).toBe(false)
  expect(pageConcerned(of([], true), cyclePage)).toBe(true)
  // A batch or unit page: another review never; the jobs only while batches are to come.
  for (const page of [batch(), unit()]) {
    expect(pageConcerned(of([other]), page)).toBe(false)
    expect(pageConcerned(of([other], true), page)).toBe(false)
  }
  for (const page of [batch(1), unit(1)]) {
    expect(pageConcerned(of([other]), page)).toBe(false)
    expect(pageConcerned(of([], true), page)).toBe(true)
  }
  // A page whose loader data names no review (nothing opened, the unknown unit): in doubt, reload.
  for (const loaderData of [
    { status: "empty", reason: "no-batch" },
    { load: { status: "empty", reason: "no-batch" } },
    undefined,
  ])
    expect(
      pageConcerned(of([other]), {
        routeId: "/review/$unitId",
        params: { unitId: mintUlid() },
        loaderData,
      })
    ).toBe(true)
  // Any other page, too.
  expect(pageConcerned(of([other]), { routeId: "/settings", params: {} })).toBe(
    true
  )
  // Changes merged across events keep every cycle and the jobs; "all" absorbs them.
  expect(mergeChanges(null, of([other]))).toEqual(of([other]))
  expect(mergeChanges(of([other], true), of([shown, other]))).toEqual(
    of([other, shown], true)
  )
  expect(mergeChanges(of([other]), "all")).toBe("all")
  expect(mergeChanges("all", of([other]))).toBe("all")
})

/** A git repository under the test's folder, which the BFF reads as its own. */
const repository = async (name: string) => {
  const path = join(root, name)
  const init = Bun.spawnSync(["git", "init", "-q", path])
  if (init.exitCode !== 0) throw new Error("git init failed")
  process.env.NEUVE_REPOSITORY = path
  return path
}

/** Appends a reviewed cycle from another Bun process, as the CLI or the worker does; its cycle. */
const appendElsewhere = async (path: string) => {
  const child = Bun.spawn([process.execPath, "--no-env-file", FIXTURE, path], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code !== 0) throw new Error(`The writer failed: ${stderr}`)
  return stdout.trim()
}

/** Appends a reviewed cycle through the BFF's own door, creating the store when there is none. */
const appendHere = async () => {
  const cycleId = mintUlid()
  await createRecords("live-events-test", () =>
    Log.append(reviewedCycle(cycleId))
  )
  return cycleId
}

const realLive = (reader: () => MarkReader = () => heldMarkReader()) =>
  liveEvents({ changes: localRecordsChanges(storeLocation), reader })

test("an append from another process reaches the stream as one new mark, naming its cycle", async () => {
  const path = await repository("other-process")
  await appendElsewhere(path)
  const stream = open(realLive())
  const before = await stream.mark()
  expect(before.sequence).toBeGreaterThan(0)
  expect(before.changed).toBe("all")
  const cycle = await appendElsewhere(path)
  const after = await stream.mark()
  expect(after.sequence).toBeGreaterThan(before.sequence)
  expect(after.changed).toEqual({ cycles: [cycle], jobs: false })
  // The next mark is the next append's, so nothing was sent twice in between.
  const own = await appendHere()
  const next = await stream.mark()
  expect(next.sequence).toBeGreaterThan(after.sequence)
  expect(next.changed).toEqual({ cycles: [own], jobs: false })
  await stream.close()
}, 30_000)

test("a store created after the first tab listens is picked up when it appears", async () => {
  const path = await repository("no-store-yet")
  const stream = open(realLive())
  expect(await stream.mark()).toEqual({
    sequence: 0,
    jobs: "",
    changed: "all",
  })
  const cycle = await appendElsewhere(path)
  // The new store may be read once before its first append commits: an empty store's mark, sent
  // only when it differs.
  let mark = await stream.mark()
  if (mark.sequence === 0) mark = await stream.mark()
  expect(mark.sequence).toBeGreaterThan(0)
  // Read on the connection that first saw the store, it names nothing; read after that empty
  // store's mark, it names the cycle.
  expect(["all", JSON.stringify({ cycles: [cycle], jobs: false })]).toContain(
    mark.changed === "all" ? "all" : JSON.stringify(mark.changed)
  )
  await stream.close()
}, 30_000)

test("the BFF's own append reaches the stream with no file-system event", async () => {
  await repository("own-append")
  await appendHere()
  const silent: RecordsChanges = {
    subscribe: () => Promise.resolve(async () => {}),
  }
  const live = liveEvents({ changes: silent, reader: () => heldMarkReader() })
  const stream = open(live)
  const before = await stream.mark()
  const cycle = await appendHere()
  const after = await stream.mark()
  expect(after.sequence).toBeGreaterThan(before.sequence)
  expect(after.changed).toEqual({ cycles: [cycle], jobs: false })
  await stream.close()
}, 30_000)

/** The held reader, counting reads, with a way to wait until none is running. */
const countingReader = () => {
  const reader = heldMarkReader()
  let reads = 0
  let running = 0
  let quiet = Promise.withResolvers<void>()
  return {
    reader: (): MarkReader => ({
      async read(after) {
        reads += 1
        running += 1
        try {
          return await reader.read(after)
        } finally {
          running -= 1
          if (running === 0) quiet.resolve()
        }
      },
      close: reader.close,
    }),
    reads: () => reads,
    async idle() {
      for (;;) {
        if (running > 0) {
          await quiet.promise
          quiet = Promise.withResolvers<void>()
        }
        // A trailing read starts right after the last one ends.
        await settle()
        if (running === 0) return
      }
    },
  }
}

test("the reads page loads wake raise no changes of their own, so they stop", async () => {
  const path = await repository("page-loads")
  await appendElsewhere(path)
  const watch = recordingWatch()
  const counting = countingReader()
  const stream = open(
    liveEvents({ changes: watch.changes, reader: counting.reader })
  )
  const before = await stream.mark()
  await watch.flush()
  await counting.idle()
  const start = counting.reads()
  const loads = 10
  for (let load = 0; load < loads; load += 1)
    expect(await currentMark()).toEqual({
      sequence: before.sequence,
      jobs: before.jobs,
    })
  // Each page load opens and closes its own connection, which the watch reports and the stream reads.
  const raised = await watch.flush()
  expect(raised).toBeGreaterThan(0)
  await counting.idle()
  const woken = counting.reads()
  // Those reads raised nothing: the next flush is the only change, and only it wakes a read.
  expect(await watch.flush()).toBe(0)
  await counting.idle()
  expect(counting.reads() - woken).toBeLessThanOrEqual(1)
  console.info(
    `[measured] ${loads} page loads raised ${raised} changes and woke ${woken - start} stream reads; the reads after them raised none`
  )
  await stream.close()
}, 30_000)

test("a watcher process that dies ends the stream, and a reconnect watches and reads again", async () => {
  const path = await repository("watcher-dies")
  await appendElsewhere(path)
  const watch = recordingWatch()
  const live = liveEvents({
    changes: watch.changes,
    reader: () => heldMarkReader(),
  })
  const stream = open(live)
  const before = await stream.mark()
  const pid = watch.pid()
  if (pid === undefined) throw new Error("No watcher started")
  // The test started this watcher; ending it is the crash the stream must survive.
  process.kill(pid, "SIGKILL")
  expect(await stream.next()).toBeNull()
  const again = open(live)
  expect(await again.mark()).toEqual({ ...before, changed: "all" })
  expect(watch.pid()).not.toBe(pid)
  const cycle = await appendElsewhere(path)
  const after = await again.mark()
  expect(after.sequence).toBeGreaterThan(before.sequence)
  expect(after.changed).toEqual({ cycles: [cycle], jobs: false })
  await again.close()
}, 30_000)

test("a store moved aside and created again is followed to the new file, naming nothing", async () => {
  const path = await repository("store-replaced")
  await appendElsewhere(path)
  await appendElsewhere(path)
  const location = await storeLocation()
  const stream = open(realLive())
  const old = await stream.mark()
  renameSync(location.directory, `${location.directory}.old`)
  await appendElsewhere(path)
  // The first mark of the replacement names nothing: its positions are another file's.
  let mark = await stream.mark()
  expect(mark.changed).toBe("all")
  // The replacement holds one cycle, the old store two: only a reader of the new file sees fewer.
  while (mark.sequence === 0) mark = await stream.mark()
  expect(mark.sequence).toBeLessThan(old.sequence)
  await stream.close()
}, 30_000)

/**
 * Replaces the store of the repository at `path` with the one at `other`, in one step as the watch
 * sees it: both renames in one turn, so no read can find no store between them.
 */
const swapStore = async (other: string) => {
  const location = await storeLocation()
  renameSync(location.directory, `${location.directory}.old`)
  renameSync(join(other, ".git", "neuve"), location.directory)
}

test("a store replaced in one step names nothing in the next mark, whether it moved or not", async () => {
  for (const extra of [1, 0]) {
    const path = await repository(`swapped-${extra}`)
    await appendElsewhere(path)
    // The replacement: as many cycles, so the same mark, or one more.
    const other = join(root, `replacement-${extra}`)
    if (Bun.spawnSync(["git", "init", "-q", other]).exitCode !== 0)
      throw new Error("git init failed")
    await appendElsewhere(other)
    for (let more = 0; more < extra; more += 1) await appendElsewhere(other)
    process.env.NEUVE_REPOSITORY = path
    const watch = recordingWatch()
    const counting = countingReader()
    const stream = open(
      liveEvents({ changes: watch.changes, reader: counting.reader })
    )
    const before = await stream.mark()
    await swapStore(other)
    // The swap is reported once the watches on the new folder are live; its read finishes.
    await watch.flush()
    await counting.idle()
    if (extra > 0) {
      const moved = await stream.mark()
      expect(moved.sequence).toBeGreaterThan(before.sequence)
      expect(moved.changed).toBe("all")
    }
    // With the same mark nothing was sent, so the next append, the first mark sent on the new
    // file, names nothing either: a page of a review only the old store held reloads. Once a mark
    // of the new file was sent, the next append is named again.
    const cycle = await appendElsewhere(path)
    expect((await stream.mark()).changed).toEqual(
      extra === 0 ? "all" : { cycles: [cycle], jobs: false }
    )
    await stream.close()
  }
}, 60_000)

test("held review jobs are followed when harness/ appears after the watch started, naming no cycle", async () => {
  await repository("harness-later")
  await appendHere()
  const location = await storeLocation()
  expect(existsSync(join(location.directory, "harness"))).toBe(false)
  const watch = recordingWatch()
  const stream = open(
    liveEvents({ changes: watch.changes, reader: () => heldMarkReader() })
  )
  const before = await stream.mark()
  mkdirSync(join(location.directory, "harness"))
  // Reported after the folder's event, once every watch is live again, the new one on harness/
  // among them.
  await watch.flush()
  writeFileSync(
    heldReviewsPath(location),
    JSON.stringify([
      {
        seq: 1,
        pid: 7,
        at: new Date().toISOString(),
        provider: "anthropic",
        route: "anthropic",
        credential: "sign-in",
      },
    ])
  )
  const mark = await stream.mark()
  expect(mark.sequence).toBe(before.sequence)
  expect(mark.jobs.endsWith("1:7:sign-in")).toBe(true)
  expect(mark.changed).toEqual({ cycles: [], jobs: true })
  await stream.close()
}, 30_000)

/**
 * One review's events as a publication appends them: a cycle on `head`, a batch with one
 * human-suggested unit, its lineage from `from` when it holds work of an earlier unit, and an
 * agent's disposition, then (`packet`) its packet of record naming the unit in a stored manifest.
 */
const publication = (
  head: string,
  from?: { unitId: string; cycleId: string }
) => {
  const cycleId = mintUlid()
  const batchId = mintUlid()
  const unitId = mintUlid()
  const runId = mintUlid()
  const headOid = head.padEnd(40, "0")
  const range = { baseRef: "refs/heads/main", baseOid: "b".repeat(40), headOid }
  const on = { cycleId, unitIds: [unitId] }
  const event = (
    kind: string,
    key: string,
    attribution: unknown,
    payload: unknown
  ) => ({
    id: mintUlid(),
    kind,
    idempotencyKey: `${key}:${cycleId}`,
    actor: LIVE_ACTOR,
    occurredAt: new Date().toISOString(),
    attribution,
    payload,
  })
  const unit = [
    event(
      "unit.recorded@2",
      `unit:${unitId}`,
      { cycleId, batchId, unitIds: [unitId] },
      {
        title: "Unit",
        ownedRanges: [
          {
            kind: "lines",
            path: "src/a.ts",
            side: "new",
            startLine: 1,
            endLine: 9,
          },
        ],
        grouping: { gapLines: 20 },
      }
    ),
    event("assessment.recorded@1", `assessment:${unitId}`, on, {
      lane: "human-suggested",
      complexity: "low",
      easeOfValidation: "easy",
      rationale: "As the test asks.",
    }),
    ...(from
      ? [
          event(
            "lineage.recorded@1",
            `lineage:${unitId}`,
            { cycleId, unitIds: [unitId, from.unitId] },
            {
              from: [
                {
                  ...from,
                  relation: "changed",
                  unchanged: 0,
                  changed: 1,
                  lane: "human-suggested",
                },
              ],
            }
          ),
        ]
      : []),
  ]
  // The batch's own transaction: its records and an agent's decision, which moves the mark.
  const batch = [
    event("cycle.opened@1", `cycle:${cycleId}`, { cycleId, range }, {}),
    event(
      "batch.recorded@1",
      `batch:${batchId}`,
      { cycleId, batchId },
      {
        title: `Review of ${head}`,
        focus: "Focus",
      }
    ),
    ...unit,
    event("disposition.recorded@1", `disposition:${unitId}`, on, {
      verdict: "request-changes",
      reviewedHeadOid: headOid,
    }),
  ]
  const manifest = canonicalJson({
    batches: [
      {
        batch: "b1",
        batchId,
        units: [
          {
            unit: "b1.u1",
            unitId,
            events: unit.map(({ kind, id }) => ({ kind, id })),
          },
        ],
        events: [],
      },
    ],
  })
  const packet = (hash: string) => ({
    ...event(
      "packet.published@1",
      `packet:${runId}`,
      { cycleId, range, runId },
      {
        complete: true,
        counts: {
          batches: 1,
          units: 1,
          contextReferences: 0,
          assessments: 1,
          deliveries: 0,
          dispositions: 1,
          comments: 0,
          gaps: 0,
        },
      }
    ),
    refs: [{ ref: `blob:${hash}`, role: "manifest" }],
  })
  // A later decision in the review, after its packet.
  const decided = () =>
    event("disposition.recorded@1", `later:${mintUlid()}`, on, {
      verdict: "approve",
      reviewedHeadOid: headOid,
    })
  return { cycleId, unitId, batch, manifest, packet, decided }
}

const LIVE_ACTOR = sha256Hex("neuve-actor/1\u0000test\u0000live-events")

/** Appends events through the BFF's own door, as one transaction. */
const appendAll = (events: ReadonlyArray<unknown>) =>
  createRecords("live-events-test", () => Log.append(events))

/** Appends a publication's packet, its manifest stored first, as one transaction. */
const publish = (review: ReturnType<typeof publication>) =>
  createRecords("live-events-test", () =>
    Effect.gen(function* () {
      const blobs = yield* Blobs.BlobStore
      const held = yield* blobs.put({
        bytes: new TextEncoder().encode(review.manifest),
        mediaType: "application/json",
        retention: "durable",
      })
      yield* Log.append([review.packet(held.blob.hash)] as Parameters<
        typeof Log.append
      >[0])
    })
  )

/** A batch or unit page of `cycleId`'s review, its batches all published. */
const pageOf = (cycleId: string) => [
  {
    routeId: "/batch/$batchId",
    params: { batchId: mintUlid() },
    loaderData: { status: "ready", data: { batches: {} }, cycleId },
  },
  {
    routeId: "/review/$unitId",
    params: { unitId: mintUlid() },
    loaderData: { load: { status: "ready", data: { batches: {} } }, cycleId },
  },
]

// Why: a later head of a branch is another review, so a page of the older one never reloaded for
// it and never showed "Newer review" until reloaded by hand (found on the first real reviews).
// The first mark after the later review's packet must name the older review, and nothing about
// another review, or a later review's events without a packet, may reload the older page.
test("an open page of an older review is told by the first mark after a later review publishes, and by nothing else", async () => {
  await repository("taken-over")
  const older = publication("1111111")
  const other = publication("2222222")
  for (const review of [older, other]) {
    await appendAll(review.batch)
    await publish(review)
  }
  const stream = open(realLive())
  expect((await stream.mark()).changed).toBe("all")
  const concerns = (change: PageChange, cycleId: string) =>
    pageOf(cycleId).map((page) => pageConcerned(change, page))

  // Another review's decision: its own pages, never the older review's.
  await appendAll([other.decided()])
  const decision = (await stream.mark()).changed
  expect(decision).toEqual({ cycles: [other.cycleId], jobs: false })
  expect(concerns(decision, older.cycleId)).toEqual([false, false])
  expect(concerns(decision, other.cycleId)).toEqual([true, true])

  // The later head's review of the older one's work: its batch lands first, with its lineage
  // and a decision but no packet yet, so nothing can open there and the older page stays.
  const later = publication("3333333", {
    unitId: older.unitId,
    cycleId: older.cycleId,
  })
  await appendAll(later.batch)
  const batch = (await stream.mark()).changed
  expect(batch).toEqual({ cycles: [later.cycleId], jobs: false })
  expect(concerns(batch, older.cycleId)).toEqual([false, false])

  // Its packet: the first mark after it names the older review, so its open pages reload and
  // find the newer review; the other review's pages do not.
  await publish(later)
  const published = (await stream.mark()).changed
  expect(published).toEqual({
    cycles: [later.cycleId],
    jobs: false,
    takenOver: [older.cycleId],
  })
  expect(concerns(published, older.cycleId)).toEqual([true, true])
  expect(concerns(published, other.cycleId)).toEqual([false, false])

  // A decision in the later review after it: no packet, so the older page stays as it is.
  await appendAll([later.decided()])
  const after = (await stream.mark()).changed
  expect(after).toEqual({ cycles: [later.cycleId], jobs: false })
  expect(concerns(after, older.cycleId)).toEqual([false, false])

  // Merged across events, as the page keeps them until it reloads, the older review stays named.
  expect(
    pageConcerned(mergeChanges(published, after), pageOf(older.cycleId)[0])
  ).toBe(true)
  await stream.close()
}, 30_000)
