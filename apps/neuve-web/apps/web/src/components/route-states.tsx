import { useRouter } from "@tanstack/react-router"
import type { ErrorComponentProps } from "@tanstack/react-router"

import { UnknownUnitEmpty } from "@workspace/ui/neuve/states/empty-states"
import { ErrorPage } from "@workspace/ui/neuve/states/error-page"
import type { UnknownUnitData } from "@workspace/ui/neuve/types"

import { errorDetail } from "./error-detail"

/**
 * Pending timing shared by every page route: a fast load never flashes a
 * skeleton (pendingMs), and a skeleton that does show stays long enough to
 * read as intentional (pendingMinMs).
 */
export const PENDING = { pendingMs: 150, pendingMinMs: 400 } as const

/**
 * Route error: a plain sentence, Retry (reloads the route's data), and the
 * technical message folded into "Details" (never the page's main text).
 */
export function RouteError({ error, reset }: ErrorComponentProps) {
  const router = useRouter()
  return (
    <ErrorPage
      detail={errorDetail(error)}
      onRetry={() => {
        reset()
        void router.invalidate()
      }}
    />
  )
}

function isUnknownUnit(data: unknown): data is UnknownUnitData {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { reason?: unknown }).reason === "unknown-unit"
  )
}

/** A unit id that is not in this revision: empty state (b). */
export function UnitNotFound({ data }: { data?: unknown }) {
  if (isUnknownUnit(data)) {
    return <UnknownUnitEmpty unitId={data.unitId} batch={data.batch} />
  }
  return <UnknownUnitEmpty unitId="" />
}
