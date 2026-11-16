// Why: a client closing the connection (a reload, a navigation, a closed tab) printed an unhandled
// 500 with a whole AbortError to the server log, because Start stops the work by throwing the
// signal's reason and its h3 layer logs any plain error it is handed. The boundary is the server
// entry's wrapper around a handler built with Start's own `requestHandler`, the same h3 layer that
// logged it. These check that an abort still stops the work, ends without a rejection or a log, and
// that a genuine failure still logs and answers 500.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import type { Mock } from "bun:test"
import { requestHandler } from "@tanstack/react-start/server"

import {
  CLIENT_CLOSED_STATUS,
  ClientClosed,
  endQuietlyOnClientClose,
  withClientClosedSignal,
} from "./client-closed"

let consoleError: Mock<typeof console.error>

beforeEach(() => {
  consoleError = spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => {
  consoleError.mockRestore()
})

/** Work that runs until the request's signal aborts, then stops the way Start does. */
const untilAborted = (request: Request) =>
  new Promise<Response>((_, reject) => {
    request.signal.addEventListener(
      "abort",
      () => reject(request.signal.reason),
      { once: true }
    )
  })

test("a client that closes mid-request stops the work and ends with no log", async () => {
  let seen: Request | undefined
  const fetch = endQuietlyOnClientClose(
    requestHandler((request: Request) => {
      seen = request
      return untilAborted(request)
    })
  )
  const client = new AbortController()
  const pending = fetch(
    new Request("http://127.0.0.1/batch", { signal: client.signal }),
    undefined
  )
  client.abort()
  const response = await pending

  expect(seen?.signal.aborted).toBe(true)
  expect(seen?.signal.reason).toBeInstanceOf(ClientClosed)
  expect(response.status).toBe(CLIENT_CLOSED_STATUS)
  expect(consoleError).not.toHaveBeenCalled()
})

test("without the wrapper the same abort logs an unhandled 500, as the server log showed", async () => {
  const fetch = requestHandler(untilAborted)
  const client = new AbortController()
  const pending = fetch(
    new Request("http://127.0.0.1/batch", { signal: client.signal }),
    undefined
  )
  client.abort()
  const response = await pending

  expect(response.status).toBe(500)
  expect(consoleError).toHaveBeenCalledTimes(1)
})

test("a genuine failure still logs and answers 500", async () => {
  const fetch = endQuietlyOnClientClose(
    requestHandler(async (_request: Request): Promise<Response> => {
      throw new Error("Records could not be read")
    })
  )
  const response = await fetch(new Request("http://127.0.0.1/batch"), undefined)

  expect(response.status).toBe(500)
  expect(consoleError).toHaveBeenCalledTimes(1)
})

test("a request that already closed arrives aborted", () => {
  const client = new AbortController()
  client.abort()
  const request = withClientClosedSignal(
    new Request("http://127.0.0.1/", { signal: client.signal })
  )

  expect(request.signal.reason).toBeInstanceOf(ClientClosed)
})

test("the request keeps its method, headers and body", async () => {
  const request = withClientClosedSignal(
    new Request("http://127.0.0.1/_serverFn/record", {
      method: "POST",
      headers: { "content-type": "application/json", "x-tsr-serverFn": "true" },
      body: JSON.stringify({ disposition: "approve" }),
    })
  )

  expect(request.method).toBe("POST")
  expect(request.url).toBe("http://127.0.0.1/_serverFn/record")
  expect(request.headers.get("x-tsr-serverFn")).toBe("true")
  expect(await request.json()).toEqual({ disposition: "approve" })
  expect(request.signal.aborted).toBe(false)
})
