// Why: the store watch wakes the web events on every write to the database or its WAL, so a read
// that itself wrote either file would wake the stream again, for ever. This measures, at the desk's
// own watch (`localRecordsChanges` over records-core's `Store.watchChanges`), which reads raise
// changes on this machine: a page load's connection (opened and closed per read) does, the stream's
// held connection does not, and neither does it while the store file waits to be initialized (an
// interrupted first creation leaves that state). A flush the watch must report, and can tell apart,
// closes each measurement (`recordingWatch`); events arrive in order, so every change the reads
// raised has arrived by then, and no sleep stands in for it. It also checks the desk's side of the
// port: the held review jobs' file is followed, and a watch given up before it is live rejects.
//
// Removed with the interim watcher, since records-core's own tests now cover its mechanics: that a
// folder whose mode changes keeps its watch, that a dead watcher process is reported (the stream's
// side of it stays in live-events.test.ts), and that a watch whose repository folder is gone fails
// to start.
import { afterAll, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Log, Store } from "@neuve/records-core"
import { heldReviewsPath } from "@neuve/harness/held-reviews"

import { currentMark, heldMarkReader } from "./live-events.server"
import { localRecordsChanges } from "./records-changes.server"
import { createRecords, storeLocation } from "./records.server"
import { recordingWatch, reviewedCycle } from "./records-changes.fixture"

const FIXTURE = join(import.meta.dir, "records-changes.fixture.ts")

const prior = process.env.NEUVE_REPOSITORY
const folders: Array<string> = []
afterAll(async () => {
  if (prior === undefined) delete process.env.NEUVE_REPOSITORY
  else process.env.NEUVE_REPOSITORY = prior
  await Promise.all(
    folders.map((folder) => rm(folder, { recursive: true, force: true }))
  )
})

/** A git repository the BFF reads as its own, with no store yet. */
const repository = async (name: string) => {
  const root = await mkdtemp(join(tmpdir(), `neuve-web-${name}-`))
  folders.push(root)
  if (Bun.spawnSync(["git", "init", "-q", root]).exitCode !== 0)
    throw new Error("git init failed")
  process.env.NEUVE_REPOSITORY = root
  return root
}

/** The desk's watch on the store, live, with what it reported. */
const watching = async () => {
  const recording = recordingWatch()
  const failures: Array<Error> = []
  const stop = await recording.changes.subscribe(
    () => {},
    (error) => failures.push(error)
  )
  // Whatever the start raised is not part of a measurement.
  await recording.flush()
  return { ...recording, failures, stop }
}

test("the stream's held connection reads without raising changes; a connection per read raises them", async () => {
  await repository("watch")
  await createRecords("records-changes-test", () => Log.append(reviewedCycle()))
  const watch = await watching()

  const reader = heldMarkReader()
  const first = await reader.read(undefined)
  // Opening the connection writes the WAL; that is once per stream, not per read.
  await watch.flush()
  for (let read = 0; read < 20; read += 1)
    expect((await reader.read(first.mark)).mark).toEqual(first.mark)
  expect(await watch.flush()).toBe(0)
  await reader.close()
  await watch.flush()

  expect(await currentMark()).toEqual(first.mark)
  const pageLoad = await watch.flush()
  console.info(`[measured] one page load's read raised ${pageLoad} changes`)
  expect(pageLoad).toBeGreaterThan(0)
  await watch.stop()
  expect(watch.failures).toEqual([])
}, 30_000)

test("a store file that waits to be initialized is read without raising changes, and picked up once it is", async () => {
  const root = await repository("uninitialized")
  const location = await storeLocation()
  // What a first creation interrupted between creating the file and initializing it leaves.
  mkdirSync(location.directory, { recursive: true })
  writeFileSync(location.database, new Uint8Array(0))
  const watch = await watching()

  const reader = heldMarkReader()
  const empty = { sequence: 0, jobs: "" }
  expect((await reader.read(undefined)).mark).toEqual(empty)
  // Opening the connection writes the file once.
  await watch.flush()
  for (let read = 0; read < 20; read += 1)
    expect((await reader.read(empty)).mark).toEqual(empty)
  // Closing a connection per read would have raised changes here, and each would wake a read.
  expect(await watch.flush()).toBe(0)

  const writer = Bun.spawn([process.execPath, "--no-env-file", FIXTURE, root], {
    stdout: "ignore",
    stderr: "pipe",
  })
  const [code, stderr] = await Promise.all([
    writer.exited,
    new Response(writer.stderr).text(),
  ])
  if (code !== 0) throw new Error(`The writer failed: ${stderr}`)
  expect(await watch.flush()).toBeGreaterThan(0)
  expect((await reader.read(empty)).mark.sequence).toBeGreaterThan(0)
  await reader.close()
  await watch.stop()
  expect(watch.failures).toEqual([])
}, 30_000)

test("a write to the held review jobs' file is reported, as the database's are", async () => {
  await repository("held-jobs")
  await createRecords("records-changes-test", () => Log.append(reviewedCycle()))
  mkdirSync(join((await storeLocation()).directory, "harness"))
  const watch = await watching()
  const before = watch.count()
  const reported = watch.next(before)
  writeFileSync(heldReviewsPath(await storeLocation()), "[]\n")
  await reported
  expect(watch.count()).toBeGreaterThan(before)
  await watch.stop()
}, 30_000)

test("a watch given up before it is live rejects once its watcher has ended", async () => {
  await repository("given-up")
  const abandon = new AbortController()
  abandon.abort()
  // records-core's watch, noting when its close (which resolves once the child has exited) is done.
  let exited = false
  const changes = localRecordsChanges(storeLocation, (at, changed, options) => {
    const watch = Store.watchChanges(at, changed, options)
    return Object.assign(Object.create(watch) as Store.StoreWatch, {
      close: async () => {
        await watch.close()
        exited = true
      },
    })
  })
  const subscribing = changes.subscribe(
    () => {},
    () => {},
    abandon.signal
  )
  const exitedAtRejection = subscribing.then(
    () => undefined,
    (error: unknown) => ({ error, exited })
  )
  const rejected = await exitedAtRejection
  expect(String(rejected?.error)).toContain("given up")
  expect(rejected?.exited).toBe(true)
})
