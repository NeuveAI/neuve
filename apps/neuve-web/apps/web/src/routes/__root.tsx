import { AccountStatus } from "@neuve/runtime/status"
import { accountsAtom } from "@workspace/ui/neuve/settings/accounts-atoms"
import * as React from "react"
import {
  HeadContent,
  Scripts,
  createRootRoute,
  useLocation,
  useRouter,
  useRouterState,
} from "@tanstack/react-router"
import { atom, useAtomValue, useSetAtom } from "jotai"
import { buttonVariants } from "@workspace/ui/components/button"

import appCss from "@workspace/ui/globals.css?url"
import { LiveStatusProvider } from "@workspace/ui/neuve/shared/app-header"
import { NeuveLinkProvider } from "@workspace/ui/neuve/shared/nav-link"
import { THEME_INIT_SCRIPT } from "@workspace/ui/neuve/shared/theme"
import {
  EMBED_INIT_SCRIPT,
  useAceBridge,
} from "@workspace/ui/neuve/shared/embedded"

import { NotFoundEmpty } from "@workspace/ui/neuve/states/empty-states"
import {
  RECONNECTING_DETAIL,
  liveMarkAtom,
  liveStatusAtom,
  sameMark,
} from "@workspace/ui/neuve/states/live-status"
import type { LiveMark } from "@workspace/ui/neuve/states/live-status"

import { RouterLink } from "@/components/router-link"
import { RouteError } from "@/components/route-states"
import { loadLiveMark, mergeChanges, pageConcerned } from "@/server/live-events"
import type { PageChange, PageEvent } from "@/server/live-events"
import { codingReturnFrom } from "@/components/coding-return"
import { liveReload } from "@/components/live-reload"

/** The mock pages render fixtures: nothing there follows Records. */
const isMock = (pathname: string) => /^\/mock(?:\/|$)/.test(pathname)
const isCodingRedirect = (pathname: string) => pathname === "/workspace"

export const Route = createRootRoute({
  // Records' mark before any page loader runs (M5 LV1), so a page is never
  // older than the mark it is compared with. A store that cannot be read
  // leaves the pages as they load, with nothing to follow.
  beforeLoad: async ({ location }): Promise<{ live: LiveMark | null }> => {
    if (isMock(location.pathname) || isCodingRedirect(location.pathname))
      return { live: null }
    try {
      return { live: await loadLiveMark() }
    } catch {
      return { live: null }
    }
  },
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "color-scheme", content: "light dark" },
      { title: "Neuve" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      {
        rel: "icon",
        type: "image/svg+xml",
        href: `${import.meta.env.BASE_URL}favicon.svg`,
      },
      {
        rel: "icon",
        sizes: "32x32",
        href: `${import.meta.env.BASE_URL}favicon.ico`,
      },
      {
        rel: "apple-touch-icon",
        href: `${import.meta.env.BASE_URL}apple-touch-icon.png`,
      },
      {
        rel: "manifest",
        href: `${import.meta.env.BASE_URL}manifest.json`,
        crossOrigin: "use-credentials",
      },
    ],
    // Render-blocking: applies a pinned dark theme before first paint, then
    // marks the page embedded when Ace's Review tab frames it (decision 12.16).
    scripts: [{ children: THEME_INIT_SCRIPT }, { children: EMBED_INIT_SCRIPT }],
  }),
  notFoundComponent: NotFound,
  errorComponent: RouteError,
  shellComponent: RootDocument,
})

function NotFound() {
  return <NotFoundEmpty />
}

/**
 * The stream's address (src/routes/api/events.ts), under the app's base:
 * `/` on its own address, `/review/<project>/` when Ace serves it.
 */
const EVENTS_URL = `${import.meta.env.BASE_URL}api/events`
/** Reconnection backoff: from 1s, doubling to 30s, each wait ±20%. */
const BACKOFF = { firstMs: 1_000, maxMs: 30_000, jitter: 0.2 } as const
/**
 * The BFF sends a heartbeat every 10s (live-events.server.ts); three missed
 * ones mean the connection went quiet without closing (a sleeping laptop, a
 * dropped network), and the page reconnects.
 */
const QUIET_MS = 30_000
/** A burst of events reloads the pages once. */
const RELOAD_DEBOUNCE_MS = 250

/**
 * What moved since the pages last reloaded for the stream: every event's
 * change, merged, so a change that concerns the page is not lost to a later
 * one that does not. Cleared when the pages reload, or once the stream's
 * mark is the one they were loaded at.
 */
const liveChangeAtom = atom<PageChange | null>(null)

const backoff = (attempt: number) =>
  Math.min(BACKOFF.maxMs, BACKOFF.firstMs * 2 ** attempt) *
  (1 - BACKOFF.jitter + Math.random() * 2 * BACKOFF.jitter)

/**
 * Follows the BFF's event stream while the page shows Records: "connecting"
 * until the first mark arrives, "live" while marks and heartbeats do, and
 * "reconnecting" from a drop until a mark arrives again. Each drop closes
 * the stream and reconnects with backoff, so a restarted BFF is found again
 * however long it was gone.
 */
function useLiveRecords(enabled: boolean) {
  const setStatus = useSetAtom(liveStatusAtom)
  const setMark = useSetAtom(liveMarkAtom)
  const setChange = useSetAtom(liveChangeAtom)
  const setAccounts = useSetAtom(accountsAtom)
  // Effect: subscribes to the BFF's event stream, an external system, while the page shows Records.
  React.useEffect(() => {
    if (!enabled) {
      setStatus(null)
      return
    }
    let source: EventSource | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    let quiet: ReturnType<typeof setTimeout> | undefined
    let attempt = 0
    let disposed = false

    const drop = () => {
      clearTimeout(quiet)
      source?.close()
      source = undefined
      if (disposed) return
      setStatus({ kind: "reconnecting", detail: RECONNECTING_DETAIL })
      clearTimeout(retry)
      retry = setTimeout(connect, backoff(attempt))
      attempt += 1
    }
    const listen = () => {
      clearTimeout(quiet)
      quiet = setTimeout(drop, QUIET_MS)
    }
    function connect() {
      const stream = new EventSource(EVENTS_URL)
      source = stream
      listen()
      stream.addEventListener("records", (event) => {
        attempt = 0
        listen()
        const live = JSON.parse(event.data) as PageEvent
        setChange((earlier) => mergeChanges(earlier, live.changed))
        setMark(live)
        setStatus({ kind: "live" })
      })
      stream.addEventListener("accounts", (event) => {
        listen()
        try {
          const parsed = AccountStatus.array().safeParse(JSON.parse(event.data))
          if (parsed.success) setAccounts(parsed.data)
        } catch {
          // Keep the last full set when the event is not JSON.
        }
      })
      stream.addEventListener("heartbeat", listen)
      stream.addEventListener("error", drop)
    }
    // The network is back, or the person returned to the tab: reconnect now
    // rather than at the end of the backoff, unless the stream is live.
    const resume = () => {
      if (source !== undefined && source.readyState !== EventSource.CLOSED)
        return
      source?.close()
      clearTimeout(retry)
      attempt = 0
      connect()
    }
    const visible = () => {
      if (document.visibilityState === "visible") resume()
    }

    setStatus({ kind: "connecting" })
    connect()
    window.addEventListener("online", resume)
    document.addEventListener("visibilitychange", visible)
    return () => {
      disposed = true
      clearTimeout(retry)
      clearTimeout(quiet)
      source?.close()
      window.removeEventListener("online", resume)
      document.removeEventListener("visibilitychange", visible)
    }
  }, [enabled, setChange, setMark, setStatus, setAccounts])
}

/**
 * Reloads the pages' data when the stream's mark differs from the one they
 * were loaded at and what moved can concern the page on screen
 * (`pageConcerned`). The first mark of a connection names nothing, so it
 * reloads whenever it differs.
 */
function useReloadOnMark(loaded: LiveMark | null) {
  const router = useRouter()
  const mark = useAtomValue(liveMarkAtom)
  const change = useAtomValue(liveChangeAtom)
  const setChange = useSetAtom(liveChangeAtom)
  // A newer mark during the wait restarts it.
  // Effect: the router's loader data is an external cache; reload it when Records moved past it.
  React.useEffect(() => {
    if (mark === null || loaded === null) return
    if (sameMark(mark, loaded)) {
      setChange(null)
      return
    }
    if (change === null || !pageConcerned(change, router.state.matches.at(-1)))
      return
    const timer = setTimeout(() => {
      setChange(null)
      // Marked as the live reload: a page a newer review replaced stays.
      void liveReload(() => router.invalidate())
    }, RELOAD_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [mark, change, loaded, router, setChange])
}

const codingReturnAtom = atom<string | null>(null)
const RETURN_KEY = "neuve:coding-return"

function CodingReturnLink() {
  const search = useLocation({ select: (location) => location.searchStr })
  const target = useAtomValue(codingReturnAtom)
  const setTarget = useSetAtom(codingReturnAtom)
  React.useEffect(() => {
    let stored: unknown
    try {
      stored = sessionStorage.getItem(RETURN_KEY)
    } catch {}
    const next = codingReturnFrom(search, stored)
    try {
      if (next) sessionStorage.setItem(RETURN_KEY, next)
      else sessionStorage.removeItem(RETURN_KEY)
    } catch {}
    setTarget(next ?? null)
  }, [search, setTarget])
  if (!target) return null
  return (
    // Embedded, Ace's own tabs are the way back: the link gives way.
    <nav
      aria-label="Coding workspace"
      className="border-b border-line px-5 py-1 embedded:hidden"
    >
      <a
        href={target}
        className={buttonVariants({ variant: "quiet", size: "compact" })}
      >
        {new URL(target).hash === "#channels"
          ? "Return to channel"
          : "Return to Ace"}
      </a>
    </nav>
  )
}

function RootDocument({ children }: { children: React.ReactNode }) {
  const live = Route.useRouteContext({ select: (context) => context.live })
  const mock = useLocation({
    select: (location) =>
      isMock(location.pathname) || isCodingRedirect(location.pathname),
  })
  useLiveRecords(!mock)
  useReloadOnMark(live)
  // Embedded in Ace's Review tab: each settled route, the title and a spare
  // Escape go to Ace. On the app's own address it does nothing.
  useAceBridge(
    useRouterState({ select: (state) => state.resolvedLocation?.href })
  )
  const status = useAtomValue(liveStatusAtom)
  return (
    // The theme class is set by THEME_INIT_SCRIPT before hydration.
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <LiveStatusProvider status={status}>
          <NeuveLinkProvider component={RouterLink}>
            {!mock && <CodingReturnLink />}
            {children}
          </NeuveLinkProvider>
        </LiveStatusProvider>
        <Scripts />
      </body>
    </html>
  )
}
