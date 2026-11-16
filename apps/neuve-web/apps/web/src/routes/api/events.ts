import { createFileRoute } from "@tanstack/react-router"

import { eventStream } from "@/server/live-events.server"

/**
 * The web events (M5 LV1): one server-sent event stream per tab, carrying
 * Records' mark (`src/server/live-events.server.ts`). It only reads, and a
 * page on another origin cannot read it: EventSource follows CORS, and this
 * answers with no CORS headers.
 */
export const Route = createFileRoute("/api/events")({
  server: {
    handlers: {
      GET: ({ request }) => eventStream(request),
    },
  },
})
