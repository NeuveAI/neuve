import globalsCss from "@workspace/ui/styles/globals.css?raw"

import type { Sources } from "@workspace/ui/foundations/inventory"

export { globalsCss }

/**
 * The component and app source the Foundations stories read, as text
 * (Vite raw imports): packages/ui/src and apps/web/src (not its server),
 * without stories, tests, fixtures, the story kit and its story-state shims,
 * or these stories themselves.
 */
const raw = import.meta.glob<string>(
  [
    "../**/*.{ts,tsx}",
    "!../**/*.stories.tsx",
    "!../**/*.test.{ts,tsx}",
    "!../fixtures/**",
    "!../foundations/**",
    "!../neuve/story-kit/**",
    "!../neuve/**/story-state.tsx",
    "../../../../apps/web/src/**/*.{ts,tsx}",
    "!../../../../apps/web/src/**/*.test.{ts,tsx}",
    "!../../../../apps/web/src/server/**",
    "!../../../../apps/web/src/routeTree.gen.ts",
  ],
  { query: "?raw", import: "default", eager: true }
)

/** Keyed packages/ui/src/… and apps/web/src/…, as the tests key them. */
export const codeSources: Sources = Object.fromEntries(
  Object.entries(raw).map(([path, source]) => [
    path.startsWith("../../../../")
      ? path.slice("../../../../".length)
      : `packages/ui/src/${path.slice(3)}`,
    source,
  ])
)
