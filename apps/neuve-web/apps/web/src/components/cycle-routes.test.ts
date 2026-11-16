/**
 * The cycle addresses Ace's review cards open (contract section 5):
 * `/cycles/<cycle>` and `/cycles/<cycle>/desk` redirect to the cycle's first
 * batch and the unit it starts at, and keep the coding workspace's
 * `returnTo` on the way, so "Return to channel" survives a review opened in
 * its own tab. The loaders run as the router runs them, with Records' reads
 * replaced: a published cycle, one with no batch yet, and an unknown one.
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
  test("opens the cycle's first batch, keeping returnTo", () => {
    expect(results.cycleWithReturn).toMatchObject({
      redirect: {
        to: "/batch/$batchId",
        params: { batchId: "batch-1" },
        search: { returnTo: RETURN },
        replace: true,
      },
    })
  })

  test("without returnTo, the redirect carries none", () => {
    expect(results.cycleWithoutReturn).toMatchObject({
      redirect: { to: "/batch/$batchId" },
    })
    const redirect =
      "redirect" in results.cycleWithoutReturn
        ? results.cycleWithoutReturn.redirect
        : undefined
    expect(redirect?.search).toEqual({ returnTo: undefined })
  })

  test("a cycle with no batch yet stays on its own page", () => {
    expect(results.cycleWithoutBatch).toEqual({
      returned: { cycle: { batches: [] } },
    })
  })
})

describe("/cycles/<cycle>/desk", () => {
  test("opens the unit the first batch starts at, keeping returnTo", () => {
    expect(results.deskWithReturn).toMatchObject({
      redirect: {
        to: "/review/$unitId",
        params: { unitId: "unit-1" },
        search: { returnTo: RETURN },
      },
    })
  })

  test("with no batch to open, goes to the cycle's page, keeping returnTo", () => {
    expect(results.deskWithoutCycle).toMatchObject({
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
