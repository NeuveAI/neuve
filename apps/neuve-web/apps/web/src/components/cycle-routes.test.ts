/**
 * The cycle addresses Ace's review cards open (contract section 5):
 * `/cycles/<cycle>` is the home list scoped to that review, so a person sees
 * every batch and the whole cycle's lanes, never only its first batch
 * (NEU-434); `/cycles/<cycle>/desk` opens the unit the cycle's desk entry
 * chooses across all its batches. Both keep the coding workspace's
 * `returnTo`, so "Return to channel" survives a review opened in its own
 * tab. The loaders run as the router runs them, with the BFF's reads
 * replaced: a cycle with a unit to open, one with none, and a malformed one.
 * The replacement is a module mock, which Bun never undoes in a process, so
 * the loaders run in a child process (`fixtures/cycle-route-loaders.ts`) and
 * this file reads what each one did.
 */
import { beforeAll, describe, expect, test } from "bun:test"
import { join } from "node:path"

import { CYCLE, RETURN } from "./fixtures/cycle-route-loaders"
import type { Results } from "./fixtures/cycle-route-loaders"

let results: Results

beforeAll(async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "fixtures/cycle-route-loaders.ts"),
    ],
    { stdout: "pipe", stderr: "pipe" }
  )
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(exitCode, stderr).toBe(0)
  const line = stdout.split("\n").find((each) => each.startsWith("{"))
  results = JSON.parse(line ?? "{}") as Results
  // A cold child loads the web app's modules: about 20 s of disk wait was measured on a busy machine.
}, 120_000)

describe("/cycles/<cycle>", () => {
  test("is the home list scoped to the cycle, not a redirect to its first batch", () => {
    expect(results.cycle).toEqual({
      returned: { status: "ready", data: { reviews: [] } },
    })
    expect(results.cycleAsked).toEqual({
      data: { page: 1, filter: "all", cycle: CYCLE },
    })
  })

  test("a malformed cycle is not found", () => {
    expect(results.cycleMalformed).toEqual({ notFound: true })
  })
})

describe("/cycles/<cycle>/desk", () => {
  test("opens the unit the cycle's desk entry chooses, keeping returnTo", () => {
    expect(results.deskWithReturn).toMatchObject({
      redirect: {
        to: "/review/$unitId",
        params: { unitId: "unit-3" },
        search: { returnTo: RETURN },
        replace: true,
      },
    })
  })

  test("without returnTo, the redirect carries none", () => {
    const redirect =
      "redirect" in results.deskWithoutReturn
        ? results.deskWithoutReturn.redirect
        : undefined
    expect(redirect?.search).toEqual({ returnTo: undefined })
  })

  test("with no unit to open, goes to the cycle's address, keeping returnTo", () => {
    expect(results.deskWithoutUnit).toMatchObject({
      redirect: {
        to: "/cycles/$cycle",
        params: { cycle: CYCLE },
        search: { returnTo: RETURN },
      },
    })
  })
})

describe("the search they accept", () => {
  test("keeps returnTo and drops what is malformed or too long", () => {
    expect(results.search).toEqual([
      { returnTo: RETURN },
      { returnTo: undefined },
      { returnTo: undefined },
    ])
  })
})
