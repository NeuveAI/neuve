import { Link } from "@tanstack/react-router"

import { useNeuveMode } from "@workspace/ui/neuve/shared/nav-link"
import type { NeuveLinkProps } from "@workspace/ui/neuve/shared/nav-link"

/**
 * Adapts UI-package destinations onto typed TanStack Router links, inside
 * the current mode: pages under `/mock` link to `/mock` pages, real pages to
 * real pages.
 */
export function RouterLink({ destination, ...props }: NeuveLinkProps) {
  const mock = useNeuveMode() === "mock"
  switch (destination.to) {
    case "reviews":
      // The mock pages have no Reviews page: their home is the mock batch.
      if (mock) return <Link to="/mock" hash={destination.section} {...props} />
      return (
        <Link
          to="/"
          search={{
            page:
              destination.page && destination.page > 1
                ? destination.page
                : undefined,
            filter: destination.filter,
          }}
          hash={destination.section}
          // Only the page and filter on screen are current: the default loose
          // match would mark every page whose query is a subset of this one.
          activeOptions={{
            exact: true,
            includeSearch: true,
            explicitUndefined: true,
          }}
          {...props}
        />
      )
    case "overview":
      if (!mock && destination.batchId)
        return (
          <Link
            to="/batch/$batchId"
            params={{ batchId: destination.batchId }}
            hash={destination.section}
            {...props}
          />
        )
      return (
        <Link to={mock ? "/mock" : "/"} hash={destination.section} {...props} />
      )
    case "changes":
      if (!mock)
        return (
          <Link
            to="/changes/$commit"
            params={{ commit: destination.commit }}
            search={{ fromRevisionId: destination.fromRevisionId }}
            {...props}
          />
        )
      return (
        <Link
          to="/mock/changes/$commit"
          params={{ commit: destination.commit }}
          {...props}
        />
      )
    case "settings":
      return <Link to={mock ? "/mock/settings" : "/settings"} {...props} />
    case "unit":
      return (
        <Link
          to={mock ? "/mock/review/$unitId" : "/review/$unitId"}
          params={{ unitId: destination.unitId }}
          {...props}
        />
      )
  }
}
