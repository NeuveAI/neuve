/**
 * Who may frame the review app: only a page of its own origin. On its own
 * address that is nothing else; under Ace, whose host serves the app from
 * Ace's origin, it is Ace's Review tab (decision 12.16), and the host sets
 * the same two headers on what it forwards. Without them any site could
 * frame the standalone app (and pick its thin embedded layout with
 * `?embedded=1`).
 *
 * `frame-ancestors` is the policy browsers follow; `X-Frame-Options` covers
 * older ones. A policy a response already carries stays: a second
 * Content-Security-Policy header is enforced alongside it.
 */
export const FRAME_ANCESTORS = "frame-ancestors 'self'"
export const FRAME_OPTIONS = "SAMEORIGIN"

type Fetch<TRest extends Array<unknown>> = (
  request: Request,
  ...rest: TRest
) => Response | Promise<Response>

/** The response with the framing policy, copied first if its headers are immutable. */
export function withFramingPolicy(response: Response): Response {
  let framed = response
  try {
    framed.headers.append("Content-Security-Policy", FRAME_ANCESTORS)
  } catch {
    // Headers of a fetched or redirect response are immutable: copy them.
    framed = new Response(response.body, response)
    framed.headers.append("Content-Security-Policy", FRAME_ANCESTORS)
  }
  if (!framed.headers.has("X-Frame-Options"))
    framed.headers.set("X-Frame-Options", FRAME_OPTIONS)
  return framed
}

/** Wraps a fetch handler so every response carries the framing policy. */
export const frameOnlyFromOwnOrigin =
  <TRest extends Array<unknown>>(fetch: Fetch<TRest>): Fetch<TRest> =>
  async (request, ...rest) =>
    withFramingPolicy(await fetch(request, ...rest))
