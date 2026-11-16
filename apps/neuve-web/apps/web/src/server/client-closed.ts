/**
 * A client that goes away is not a server error. srvx aborts a request's
 * signal when its connection closes (a reload, a navigation, a closed tab),
 * and TanStack Start then stops the request's work by throwing the signal's
 * reason. srvx's reason is a plain `AbortError`, which Start's h3 layer
 * answers as an unhandled 500 and prints whole to the server log.
 *
 * `endQuietlyOnClientClose` gives Start the same request with its own signal,
 * aborted at the same moment with `ClientClosed`: the work still stops at
 * every point it did, and h3 reads the reason as an HTTP error it was handed
 * (status 499, the client closed the request), which it answers without
 * logging. Any other failure is untouched and logs as before.
 */

/** The 499 status: the client closed the request before the answer. */
export const CLIENT_CLOSED_STATUS = 499

/**
 * Why a request's work stopped: its client closed the connection. h3 knows
 * its own HTTP errors by shape (an `Error` named `HTTPError`, the check that
 * lets one h3 copy recognise another's), so this carries the fields its
 * error response reads and nothing else.
 */
export class ClientClosed extends Error {
  override readonly name = "HTTPError"
  readonly status = CLIENT_CLOSED_STATUS
  readonly statusText = "Client Closed Request"
  readonly headers = undefined
  readonly unhandled = false

  constructor() {
    super("The client closed the request")
  }

  toJSON() {
    return {
      status: this.status,
      statusText: this.statusText,
      message: this.message,
    }
  }
}

type Fetch<TRest extends Array<unknown>> = (
  request: Request,
  ...rest: TRest
) => Response | Promise<Response>

/** The request again, with a signal that aborts with `ClientClosed` when the client's does. */
export function withClientClosedSignal(request: Request): Request {
  const controller = new AbortController()
  const close = () => controller.abort(new ClientClosed())
  if (request.signal.aborted) close()
  else request.signal.addEventListener("abort", close, { once: true })
  const body = request.body
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
    // A streamed request body (a server function's payload) is sent as it arrives.
    ...(body === null ? {} : { duplex: "half" }),
    signal: controller.signal,
  })
}

/** Wraps a fetch handler so a client that closes the connection ends its request quietly. */
export const endQuietlyOnClientClose =
  <TRest extends Array<unknown>>(fetch: Fetch<TRest>): Fetch<TRest> =>
  (request, ...rest) =>
    fetch(withClientClosedSignal(request), ...rest)
