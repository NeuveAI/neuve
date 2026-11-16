import handler, { createServerEntry } from "@tanstack/react-start/server-entry"

import { endQuietlyOnClientClose } from "@/server/client-closed"
import { frameOnlyFromOwnOrigin } from "@/server/framing"

/**
 * The server entry: Start's own handler, except that a client closing the
 * connection ends its request quietly instead of logging an unhandled 500
 * (`src/server/client-closed.ts`), and that only a page of the app's own
 * origin may frame what it answers (`src/server/framing.ts`).
 */
export default createServerEntry({
  fetch: frameOnlyFromOwnOrigin(endQuietlyOnClientClose(handler.fetch)),
})
