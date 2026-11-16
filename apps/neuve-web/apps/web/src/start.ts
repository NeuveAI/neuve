import { createCsrfMiddleware, createStart } from "@tanstack/react-start"

/**
 * Writes only from the desk's own page (M5 ID2). The BFF listens on loopback
 * with no sign-in (6.6), and its server functions record a person's
 * dispositions and comments, so every server function call must come from a
 * page on this origin: `Sec-Fetch-Site: same-origin`, or, from a client that
 * sends no fetch metadata, an `Origin` (then a `Referer`) equal to the
 * server's own. Anything else, and a call with none of the three, is refused
 * with 403 before the handler runs.
 *
 * Start applies the same check by default only while no `start.ts` exists;
 * declaring it here keeps it when this file gains anything else. Page
 * requests are left out: navigations are cross-site by nature, and they only
 * read. `csrf.test.ts` posts to a command cross-site and sees it refused.
 */
export const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
  secFetchSite: "same-origin",
  referer: true,
  allowRequestsWithoutOriginCheck: false,
})

export const startInstance = createStart(() => ({
  requestMiddleware: [csrfMiddleware],
}))
