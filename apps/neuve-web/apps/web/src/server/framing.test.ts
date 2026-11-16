// Why: the standalone review server sent no anti-framing headers, so any site could frame the
// app (and choose its embedded layout with ?embedded=1). The boundary is the server entry's
// wrapper around a handler built with Start's own `requestHandler`. These check that every kind of
// response it answers carries `frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN`, that an
// immutable redirect is copied rather than thrown on, that a streamed body still streams, and that
// a policy a response already has is kept.
import { expect, test } from "bun:test"
import { requestHandler } from "@tanstack/react-start/server"

import {
  FRAME_ANCESTORS,
  FRAME_OPTIONS,
  frameOnlyFromOwnOrigin,
  withFramingPolicy,
} from "./framing"

const request = new Request("http://127.0.0.1:3000/review/unit")

const policyOf = (response: Response) => ({
  csp: response.headers.get("Content-Security-Policy"),
  frame: response.headers.get("X-Frame-Options"),
})

test("a page answered by Start carries the framing policy", async () => {
  const fetch = frameOnlyFromOwnOrigin(
    requestHandler(
      () =>
        new Response("<!doctype html><p>desk</p>", {
          headers: { "Content-Type": "text/html" },
        })
    )
  )
  const response = await fetch(request, undefined)
  expect(policyOf(response)).toEqual({
    csp: FRAME_ANCESTORS,
    frame: FRAME_OPTIONS,
  })
  expect(await response.text()).toBe("<!doctype html><p>desk</p>")
})

/** Headers that refuse changes, as a fetched or redirect Response's do on Node (undici). */
class ImmutableHeaders extends Headers {
  override append(): void {
    throw new TypeError("immutable")
  }
  override set(): void {
    throw new TypeError("immutable")
  }
}

test("an immutable redirect is copied with its status and location", () => {
  const redirect = Response.redirect("http://127.0.0.1:3000/batch/b1", 307)
  Object.defineProperty(redirect, "headers", {
    value: new ImmutableHeaders(redirect.headers),
  })
  expect(() => redirect.headers.set("X", "y")).toThrow()
  const response = withFramingPolicy(redirect)
  expect(response.status).toBe(307)
  expect(response.headers.get("Location")).toBe(
    "http://127.0.0.1:3000/batch/b1"
  )
  expect(policyOf(response)).toEqual({
    csp: FRAME_ANCESTORS,
    frame: FRAME_OPTIONS,
  })
})

test("a streamed answer (the event stream) still streams", async () => {
  const encoder = new TextEncoder()
  let push: (chunk: string) => void = () => {}
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (chunk) => controller.enqueue(encoder.encode(chunk))
    },
  })
  const response = await frameOnlyFromOwnOrigin(
    () =>
      new Response(body, { headers: { "Content-Type": "text/event-stream" } })
  )(request)
  expect(policyOf(response).frame).toBe(FRAME_OPTIONS)
  const reader = response.body!.getReader()
  push("event: records\n\n")
  const { value } = await reader.read()
  expect(new TextDecoder().decode(value)).toBe("event: records\n\n")
  await reader.cancel()
})

test("a policy the response already has is kept", () => {
  const response = withFramingPolicy(
    new Response(null, {
      headers: {
        "Content-Security-Policy": "object-src 'none'",
        "X-Frame-Options": "DENY",
      },
    })
  )
  expect(policyOf(response)).toEqual({
    csp: `object-src 'none', ${FRAME_ANCESTORS}`,
    frame: "DENY",
  })
})
