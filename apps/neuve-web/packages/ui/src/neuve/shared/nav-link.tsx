import * as React from "react"

/**
 * Router-agnostic navigation for UI-package screens.
 *
 * Screens describe *where* a link goes; the host decides *how* to get there.
 * The app injects a TanStack Router `Link` adapter; Storybook uses the plain
 * anchor fallback below.
 *
 * Mode: the app serves real pages at `/`, and fixture-backed sample pages
 * under `/mock`. Every link resolves inside the mode it was rendered in, so
 * a mock page only ever links to mock pages.
 */
export type NeuveDestination =
  /** Every review of the repository, `/` (a page and a filter of it). */
  | {
      to: "reviews"
      page?: number
      filter?: "waiting"
      /** A section of the page, e.g. the list. */
      section?: "reviews"
    }
  | {
      to: "overview"
      /**
       * One batch of a review. Live pages always name it: without it, `/`
       * opens the Reviews page. The `/mock` pages have one batch, so they
       * ignore it.
       */
      batchId?: string
      /** A section of the overview, e.g. the lane bar. */
      section?: "lanes"
    }
  | { to: "unit"; unitId: string }
  /** What a new commit asks of the reviewer (commit lineage). */
  | { to: "changes"; commit: string; fromRevisionId?: string }
  /** Workspace settings (round 4: the Review delivery section). */
  | { to: "settings" }

export type NeuveMode = "live" | "mock"

export type NeuveLinkProps = Omit<
  React.ComponentPropsWithoutRef<"a">,
  "href"
> & {
  destination: NeuveDestination
}

export type NeuveLinkComponent = React.ComponentType<NeuveLinkProps>

const NeuveModeContext = React.createContext<NeuveMode>("live")

/** Pages under `/mock` wrap their tree in mode "mock". */
export function NeuveModeProvider({
  mode,
  children,
}: {
  mode: NeuveMode
  children: React.ReactNode
}) {
  return (
    <NeuveModeContext.Provider value={mode}>
      {children}
    </NeuveModeContext.Provider>
  )
}

export function useNeuveMode(): NeuveMode {
  return React.useContext(NeuveModeContext)
}

export function destinationHref(
  destination: NeuveDestination,
  mode: NeuveMode = "live"
) {
  const base = mode === "mock" ? "/mock" : ""
  switch (destination.to) {
    case "reviews": {
      // The mock pages have no Reviews page: their home is the mock batch.
      if (mode === "mock") return "/mock"
      const query = new URLSearchParams()
      if (destination.filter) query.set("filter", destination.filter)
      if (destination.page && destination.page > 1)
        query.set("page", String(destination.page))
      const search = query.size > 0 ? `?${query}` : ""
      return `/${search}${destination.section ? `#${destination.section}` : ""}`
    }
    case "overview": {
      const page =
        mode === "live" && destination.batchId
          ? `/batch/${destination.batchId}`
          : base || "/"
      return `${page}${destination.section ? `#${destination.section}` : ""}`
    }
    case "unit":
      return `${base}/review/${destination.unitId}`
    case "changes":
      return `${base}/changes/${destination.commit}${mode === "live" && destination.fromRevisionId ? `?${new URLSearchParams({ fromRevisionId: destination.fromRevisionId })}` : ""}`
    case "settings":
      return `${base}/settings`
  }
}

function AnchorLink({ destination, ...props }: NeuveLinkProps) {
  const mode = useNeuveMode()
  return <a href={destinationHref(destination, mode)} {...props} />
}

const NeuveLinkContext = React.createContext<NeuveLinkComponent>(AnchorLink)

export function NeuveLinkProvider({
  component,
  children,
}: {
  component: NeuveLinkComponent
  children: React.ReactNode
}) {
  return (
    <NeuveLinkContext.Provider value={component}>
      {children}
    </NeuveLinkContext.Provider>
  )
}

export function NeuveLink(props: NeuveLinkProps) {
  const Link = React.useContext(NeuveLinkContext)
  return <Link {...props} />
}
