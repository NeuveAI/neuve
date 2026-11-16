import { SharedWork } from "@neuve/records-core/shared-work"
import { sharedWorkEffect } from "@neuve/records-core/shared-work-effect"
import { statSync } from "node:fs"
import { resolve } from "node:path"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import { Cause, Effect, Exit, Layer, ManagedRuntime, Option } from "effect"
import type { FileSystem } from "effect/FileSystem"
import type { SqlClient } from "effect/sql/SqlClient"
import {
  Blobs,
  Computations,
  Store,
  resolveStoreLocation,
} from "@neuve/records-core"
import type { StoreLocation } from "@neuve/records-core"

import { notifyRecordsChanged } from "./records-changes.server"

/**
 * The BFF's one door to Records (M5 RD2, 1.7). Records is a library over one
 * SQLite file (8.3), opened here for one page load or one command and closed
 * after it, as the CLI does; the web events alone hold one connection open
 * while tabs listen (`holdRecords`). Nothing here decides anything: callers
 * run records-core's read model and commands through it.
 */

/** The variable that points the BFF at another repository's Records (RD2). */
export const REPOSITORY_VARIABLE = "NEUVE_REPOSITORY"

/** The repository the BFF reads: the override when set, else the one it started in. */
export function repository(): string {
  const override = process.env[REPOSITORY_VARIABLE]?.trim()
  return resolve(override !== undefined && override !== "" ? override : ".")
}

type Services =
  SqlClient | FileSystem | Blobs.BlobStore | Computations.ComputationStore

/** Records has no store for this repository yet: no review was ever requested here. */
export class NoStore extends Error {
  override readonly name = "NoStore"
}

const failureMessage = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const tagged = error as { _tag: string; message?: unknown }
    if (typeof tagged.message === "string" && tagged.message !== "")
      return tagged.message
    return tagged._tag
  }
  return error instanceof Error ? error.message : String(error)
}

type Mode = "read" | "write" | "create"

/**
 * Where each repository's store lives, resolved once per process: the git common directory does not
 * move while the BFF runs, and the web events read Records after every change.
 */
const locations = new Map<string, StoreLocation>()

const locationWork = new SharedWork<
  StoreLocation,
  Effect.Error<ReturnType<typeof resolveStoreLocation>>
>()

const locate = (at: string) =>
  Effect.suspend(() => {
    const known = locations.get(at)
    if (known !== undefined) return Effect.succeed(known)
    return sharedWorkEffect(locationWork, {
      scope: "store-location",
      key: at,
      run: () =>
        resolveStoreLocation(at).pipe(
          Effect.tap((location) =>
            Effect.sync(() => locations.set(at, location))
          ),
          Effect.match({
            onSuccess: (value) => ({ kind: "succeeded" as const, value }),
            onFailure: (error) => ({ kind: "failed" as const, error }),
          })
        ),
    }).pipe(Effect.map((result) => result.value))
  })

const run = async <TResult>(
  mode: Mode,
  program: (
    location: StoreLocation
  ) => Effect.Effect<TResult, unknown, Services>,
  name: string
): Promise<TResult> => {
  const effect = Effect.gen(function* () {
    const location = yield* locate(repository())
    return yield* Effect.andThen(
      mode === "read" ? Store.prepareForRead : Store.prepareForWrite,
      program(location)
    ).pipe(
      Effect.provide(
        Computations.layer.pipe(
          Layer.provideMerge(Blobs.layer(location)),
          Layer.provideMerge(
            Store.layer(location, { create: mode === "create" })
          )
        )
      )
    )
  }).pipe(
    Effect.provide(BunFileSystem.layer),
    Effect.withSpan(name, { attributes: { "neuve.records.mode": mode } })
  )
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) {
    // Committed: the desk hears its own commands without waiting on the file system.
    if (mode !== "read") notifyRecordsChanged()
    return exit.value
  }
  const failure = Cause.findErrorOption(exit.cause)
  if (Option.isSome(failure)) {
    const error = failure.value as { _tag?: string }
    if (error._tag === "StoreMissing")
      throw new NoStore("Records holds no store for this repository yet")
    throw new Error(failureMessage(failure.value))
  }
  throw new Error(Cause.pretty(exit.cause))
}

/** Where this repository's store lives, whether or not it exists yet; the web events watch it. */
export const storeLocation = async (): Promise<StoreLocation> => {
  const exit = await Effect.runPromiseExit(
    locate(repository()).pipe(Effect.provide(BunFileSystem.layer))
  )
  if (Exit.isSuccess(exit)) return exit.value
  const failure = Cause.findErrorOption(exit.cause)
  throw new Error(
    Option.isSome(failure)
      ? failureMessage(failure.value)
      : Cause.pretty(exit.cause)
  )
}

const inodeOf = (path: string) => {
  try {
    return statSync(path).ino
  } catch {
    return undefined
  }
}

const tagOf = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) return undefined
  const failure = Cause.findErrorOption(exit.cause)
  if (Option.isNone(failure)) return undefined
  const tag = (failure.value as { _tag?: unknown })._tag
  return typeof tag === "string" ? tag : undefined
}

const failureOf = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) return new Error("Not a failure")
  const failure = Cause.findErrorOption(exit.cause)
  return new Error(
    Option.isSome(failure)
      ? failureMessage(failure.value)
      : Cause.pretty(exit.cause)
  )
}

const connect = (location: StoreLocation) =>
  ManagedRuntime.make(
    Store.layer(location, { create: false }).pipe(
      Layer.provideMerge(BunFileSystem.layer)
    )
  )

/** What a held connection serves: the store's SQL and the file system. */
type HeldServices = SqlClient | FileSystem

/**
 * One connection held open across reads, for a reader that follows Records
 * while it changes (the web events). Opening and closing a connection per read
 * writes the database and its WAL whenever it is the last connection (SQLite
 * checkpoints at close), so a reader woken by the store watch would wake
 * itself, in a loop (`records-changes.test.ts` measures it). A held
 * connection's reads write neither file. That holds while the store waits to
 * be initialized too (another process created the file and has not migrated
 * it yet, or was stopped between the two): the connection stays open and the
 * next read checks again. A store that is replaced (moved aside and created
 * again) is a new file, and the connection follows it. Throws `NoStore` while
 * there is no store, or no initialized one.
 */
export function holdRecords() {
  let held:
    | {
        readonly runtime: ReturnType<typeof connect>
        readonly inode: number
        prepared: boolean
      }
    | undefined
  let connections = 0
  const close = async () => {
    const was = held
    held = undefined
    await was?.runtime.dispose()
  }
  const read = async <TResult>(
    name: string,
    program: (
      location: StoreLocation
    ) => Effect.Effect<TResult, unknown, HeldServices>
  ): Promise<TResult> => {
    const location = await storeLocation()
    const inode = inodeOf(location.database)
    if (held !== undefined && held.inode !== inode) await close()
    if (inode === undefined)
      throw new NoStore("Records holds no store for this repository yet")
    if (held === undefined) connections += 1
    const current = (held ??= {
      runtime: connect(location),
      inode,
      prepared: false,
    })
    const exit = await current.runtime.runPromiseExit(
      Effect.andThen(
        current.prepared ? Effect.void : Store.prepareForRead,
        Effect.suspend(() => program(location))
      ).pipe(
        Effect.withSpan(name, { attributes: { "neuve.records.mode": "held" } })
      )
    )
    if (Exit.isSuccess(exit)) {
      current.prepared = true
      return exit.value
    }
    const tag = tagOf(exit)
    // Waiting for initialization keeps the connection: closing it would write the store.
    if (tag === "StoreNotInitialized")
      throw new NoStore("Records' store for this repository is not ready yet")
    await close()
    if (tag === "StoreMissing")
      throw new NoStore("Records holds no store for this repository yet")
    throw failureOf(exit)
  }
  return {
    read,
    close,
    /** Counts the connections opened so far: it moves when the store file was replaced or reopened. */
    connection: () => connections,
  }
}

/** Runs a read over this repository's Records. Throws `NoStore` when there is none. */
export const readRecords = <TResult>(
  name: string,
  program: (
    location: StoreLocation
  ) => Effect.Effect<TResult, unknown, Services>
) => run("read", program, name)

/** Runs a command over this repository's Records; the store must already exist. */
export const writeRecords = <TResult>(
  name: string,
  program: (
    location: StoreLocation
  ) => Effect.Effect<TResult, unknown, Services>
) => run("write", program, name)

/** Runs a command that may create this repository's store, as a first review request does. */
export const createRecords = <TResult>(
  name: string,
  program: (
    location: StoreLocation
  ) => Effect.Effect<TResult, unknown, Services>
) => run("create", program, name)
