/**
 * A child process for cycle-routes.test.ts. `mock.module` replaces a module
 * for the whole process and is never undone, so Records' faked reads live and
 * die here. It runs the two cycle routes' loaders as the router runs them, a
 * case at a time, and prints what each one threw or returned as one JSON line.
 * The home load and the cycle's desk entry are the faked reads; which unit
 * the entry chooses runs on Records' shape in `reviews.test.ts`.
 */
import { mock } from "bun:test"
import { isNotFound, isRedirect } from "@tanstack/react-router"

export const CYCLE = "01JZ0000000000000000000000"
export const RETURN = "http://127.0.0.1:4141/?channel=c1&chat=2#channels"

/** What a loader did: the redirect it threw, as the router reads it, or what it returned. */
export type Outcome =
  | { redirect: Record<string, unknown> }
  | { returned: unknown }
  | { notFound: true }
  | { threw: string }

export type Results = {
  cycle: Outcome
  /** What the cycle's address asked the home load for. */
  cycleAsked: unknown
  cycleMalformed: Outcome
  cycleUnknown: Outcome
  deskWithReturn: Outcome
  deskWithoutReturn: Outcome
  deskWithoutUnit: Outcome
  search: Array<unknown>
}

type Loader = (context: {
  params: { cycle: string }
  deps: { returnTo?: string }
}) => Promise<unknown>

if (import.meta.main) {
  let entry: string | undefined = "unit-3"
  let asked: unknown
  let listed: Array<unknown> = [{ id: CYCLE }]
  mock.module("@/server/review-cycle", () => ({
    loadCycleEntry: () => Promise.resolve(entry),
  }))
  mock.module("@/server/home-load", () => ({
    loadHome: (input: unknown) => {
      asked = input
      return Promise.resolve({ status: "ready", data: { reviews: listed } })
    },
  }))
  const { Route: CycleRoute } = await import("../../routes/cycles/$cycle/index")
  const { Route: DeskRoute } = await import("../../routes/cycles/$cycle/desk")
  const loaderOf = (route: { options: unknown }) =>
    (route.options as { loader: Loader }).loader

  const run = async (
    route: { options: unknown },
    unit: string | undefined,
    returnTo?: string,
    cycle = CYCLE
  ): Promise<Outcome> => {
    entry = unit
    try {
      return {
        returned: await loaderOf(route)({
          params: { cycle },
          deps: { returnTo },
        }),
      }
    } catch (thrown) {
      if (isRedirect(thrown))
        return { redirect: thrown.options as Record<string, unknown> }
      if (isNotFound(thrown)) return { notFound: true }
      return { threw: String(thrown) }
    }
  }
  const validate = (search: Record<string, unknown>) =>
    (
      CycleRoute.options as {
        validateSearch: { parse: (input: unknown) => unknown }
      }
    ).validateSearch.parse(search)

  const cycle = await run(CycleRoute, "unit-3", RETURN)
  const cycleAsked = asked
  listed = []
  const cycleUnknown = await run(CycleRoute, undefined, RETURN)
  listed = [{ id: CYCLE }]
  const results: Results = {
    cycle,
    cycleAsked,
    cycleUnknown,
    cycleMalformed: await run(CycleRoute, undefined, RETURN, "not-a-cycle"),
    deskWithReturn: await run(DeskRoute, "unit-3", RETURN),
    deskWithoutReturn: await run(DeskRoute, "unit-3"),
    deskWithoutUnit: await run(DeskRoute, undefined, RETURN),
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
