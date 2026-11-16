/**
 * A child process for cycle-routes.test.ts. `mock.module` replaces a module
 * for the whole process and is never undone, so Records' faked reads live and
 * die here. It runs the two cycle routes' loaders as the router runs them, a
 * case at a time, and prints what each one threw or returned as one JSON line.
 */
import { mock } from "bun:test"
import { isRedirect } from "@tanstack/react-router"

export const CYCLE = "01JZ0000000000000000000000"
export const RETURN = "http://127.0.0.1:4141/?channel=c1&chat=2#channels"

type Cycle = { batches: Array<{ id: string }> } | undefined

/** What a loader did: the redirect it threw, as the router reads it, or what it returned. */
export type Outcome =
  | { redirect: Record<string, unknown> }
  | { returned: unknown }
  | { threw: string }

export type Results = {
  cycleWithReturn: Outcome
  cycleWithoutReturn: Outcome
  cycleWithoutBatch: Outcome
  deskWithReturn: Outcome
  deskWithoutCycle: Outcome
  search: Array<unknown>
}

type Loader = (context: {
  params: { cycle: string }
  deps: { returnTo?: string }
}) => Promise<unknown>

if (import.meta.main) {
  const published: Cycle = { batches: [{ id: "batch-1" }, { id: "batch-2" }] }
  let cycle: Cycle = published
  mock.module("@/server/review-cycle", () => ({
    loadReviewCycle: () => Promise.resolve(cycle),
  }))
  mock.module("@/server/review-loads", () => ({
    loadOverview: () =>
      Promise.resolve({ status: "ready", data: { firstUnitId: "unit-1" } }),
  }))
  const { Route: CycleRoute } = await import("../../routes/cycles/$cycle/index")
  const { Route: DeskRoute } = await import("../../routes/cycles/$cycle/desk")
  const loaderOf = (route: { options: unknown }) =>
    (route.options as { loader: Loader }).loader

  const run = async (
    route: { options: unknown },
    given: Cycle,
    returnTo?: string
  ): Promise<Outcome> => {
    cycle = given
    try {
      return {
        returned: await loaderOf(route)({
          params: { cycle: CYCLE },
          deps: { returnTo },
        }),
      }
    } catch (thrown) {
      if (isRedirect(thrown))
        return { redirect: thrown.options as Record<string, unknown> }
      return { threw: String(thrown) }
    }
  }
  const validate = (search: Record<string, unknown>) =>
    (
      CycleRoute.options as {
        validateSearch: { parse: (input: unknown) => unknown }
      }
    ).validateSearch.parse(search)

  const results: Results = {
    cycleWithReturn: await run(CycleRoute, published, RETURN),
    cycleWithoutReturn: await run(CycleRoute, published),
    cycleWithoutBatch: await run(CycleRoute, { batches: [] }, RETURN),
    deskWithReturn: await run(DeskRoute, published, RETURN),
    deskWithoutCycle: await run(DeskRoute, undefined, RETURN),
    search: [
      validate({ returnTo: RETURN }),
      validate({ returnTo: 42 }),
      validate({ returnTo: "x".repeat(8193) }),
    ],
  }
  // JSON drops a key whose value is undefined; the parent compares with toEqual, which reads a
  // missing key and an undefined one alike.
  process.stdout.write(`${JSON.stringify(results)}\n`)
  process.exit(0)
}
