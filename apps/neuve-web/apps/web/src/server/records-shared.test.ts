// Store discovery must share actual Git launches and keep failures retryable.
import { expect, test, spyOn } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { readRecords } from "./records.server"

test("cold store locations share Git discovery and failed discovery is not cached", async () => {
  const root = await mkdtemp(join(tmpdir(), "location-shared-"))
  const other = await mkdtemp(join(tmpdir(), "location-other-"))
  const seen: string[] = []
  const prior = process.env.NEUVE_REPOSITORY
  const spawn = spyOn(Bun, "spawn")
  const calls = () =>
    spawn.mock.calls.filter(
      ([args]) => Array.isArray(args) && args.includes("--git-common-dir")
    ).length
  try {
    process.env.NEUVE_REPOSITORY = root
    const read = () =>
      readRecords("shared-location-test", (location) => {
        seen.push(location.directory)
        return Effect.succeed(location.directory)
      })
    const failed = await Promise.allSettled([read(), read()])
    expect(failed.map((r) => r.status)).toEqual(["rejected", "rejected"])
    for (const result of failed) {
      if (result.status === "rejected")
        expect(result.reason.message).toBe(
          `${root} is not inside a git repository, so it has no Records store.`
        )
    }
    expect(calls()).toBe(1)
    const init = Bun.spawnSync(["git", "-C", root, "init", "--quiet"])
    expect(init.exitCode).toBe(0)
    // There is no store yet, but both calls finish location discovery before that error.
    await Promise.allSettled([read(), read()])
    expect(calls()).toBe(2)
    await Promise.allSettled([read(), read()])
    expect(calls()).toBe(2)
    expect(seen).toEqual(Array(4).fill(join(root, ".git", "neuve")))
    expect(
      Bun.spawnSync(["git", "-C", other, "init", "--quiet"]).exitCode
    ).toBe(0)
    process.env.NEUVE_REPOSITORY = other
    await Promise.allSettled([read(), read()])
    expect(calls()).toBe(3)
    expect(seen.slice(-2)).toEqual(Array(2).fill(join(other, ".git", "neuve")))
  } finally {
    if (prior === undefined) delete process.env.NEUVE_REPOSITORY
    else process.env.NEUVE_REPOSITORY = prior
    spawn.mockRestore()
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(other, { recursive: true, force: true }),
    ])
  }
}, 60000)
