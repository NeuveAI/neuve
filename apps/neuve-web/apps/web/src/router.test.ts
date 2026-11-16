import { afterEach, expect, test } from "bun:test"
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"

import { validateChangesSearch } from "./components/commit-id"

const originalGlobals = ["document", "window", "self"].map((key) => ({
  key,
  descriptor: Object.getOwnPropertyDescriptor(globalThis, key),
}))

afterEach(() => {
  for (const { key, descriptor } of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
})

const scenarios = [
  { name: "update failure", updateError: new Error("route update failed") },
  { name: "missing transition API", available: false },
  { name: "typed transition opt-out", types: false },
  { name: "function overload", typed: false },
  { name: "disabled transition", enabled: false },
] satisfies Array<{
  name: string
  updateError?: Error
  available?: boolean
  types?: false
  typed?: boolean
  enabled?: boolean
}>

for (const scenario of scenarios) {
  test(`view transition: ${scenario.name}`, async () => {
    const {
      updateError,
      available = true,
      typed = true,
      enabled = true,
    } = scenario
    const types = scenario.types ?? ["forward"]
    let updates = 0
    type Update = () => Promise<void>
    const calls: Array<Update | { update: Update; types: Array<string> }> = []
    let transition:
      | Pick<ViewTransition, "ready" | "finished" | "updateCallbackDone">
      | undefined
    const documentFixture = available
      ? {
          startViewTransition(
            params: Update | { update: Update; types: Array<string> }
          ) {
            calls.push(params)
            const updateCallbackDone = Promise.resolve().then(
              typeof params === "function" ? params : params.update
            )
            const ready = updateCallbackDone.then(() => undefined)
            const finished = updateCallbackDone.then(() => undefined)
            // As in browsers (CSS View Transitions 1, "call the update
            // callback"): when the update fails, ready and finished are marked
            // as handled and only updateCallbackDone reports the failure.
            ready.catch(() => {})
            finished.catch(() => {})
            transition = { updateCallbackDone, ready, finished }
            return transition
          },
        }
      : {}
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: documentFixture,
    })
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { CSS: { supports: () => typed } },
    })
    Object.defineProperty(globalThis, "self", { configurable: true, value: {} })
    const router = createRouter({
      routeTree: createRootRoute(),
      history: createMemoryHistory({ initialEntries: ["/"] }),
      isServer: false,
      defaultViewTransition: enabled ? { types: () => types } : false,
    })
    const update = async () => {
      updates++
      if (updateError) throw updateError
    }
    const result = router.startViewTransition(update)
    if (transition) expect(result).toBe(transition.updateCallbackDone)
    if (updateError) {
      await expect(result).rejects.toBe(updateError)
    } else {
      await result
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(updates).toBe(1)
    expect(router.shouldViewTransition).toBeUndefined()
    expect(calls).toHaveLength(
      available && enabled && (!typed || types !== false) ? 1 : 0
    )
    for (const call of calls) {
      if (typed && typeof call !== "function" && types !== false)
        expect(call.types).toEqual(types)
      else expect(call).toBe(update)
    }
  })
}

const FULL = "4fc76f5d30ecb4a5fb7aae205093112389bf96a1"

for (const [name, query, expected] of [
  [
    "an invalid previous revision is dropped",
    "?fromRevisionId=nothex",
    undefined,
  ],
  ["a valid previous revision is kept", `?fromRevisionId=${FULL}`, FULL],
] as const) {
  test(`changes search: ${name}`, () => {
    // TanStack merges the raw search under the validated one, so the
    // validator must overwrite the key rather than omit it (review F1).
    const root = createRootRoute()
    const changes = createRoute({
      getParentRoute: () => root,
      path: "/changes/$commit",
      validateSearch: validateChangesSearch,
      loaderDeps: ({ search }) => ({ fromRevisionId: search.fromRevisionId }),
    })
    const router = createRouter({
      routeTree: root.addChildren([changes]),
      history: createMemoryHistory({
        initialEntries: [`/changes/${FULL}${query}`],
      }),
      isServer: true,
    })
    const match = router
      .matchRoutes(router.state.location)
      .find((candidate) => candidate.routeId === "/changes/$commit")
    expect(match?.search.fromRevisionId).toBe(expected)
    expect(
      (match?.loaderDeps as { fromRevisionId?: string } | undefined)
        ?.fromRevisionId
    ).toBe(expected)
  })
}
