// Why: the desk's server functions record a person's approvals and comments with no sign-in (6.6),
// so the CSRF middleware in src/start.ts and Vite's host allowlist are the only things that keep a
// page on another site from recording one in the owner's name (M5 ID2). This starts the web app's
// dev server, as `bun run dev` does, and posts to the disposition command the way another site, a
// script with no fetch metadata, and a rebinding host would, and checks each is refused before the
// handler runs. A same-origin post gets past the middleware (its empty payload then fails
// validation), so the refusals come from the boundary and not from a broken route. The server
// reads a temporary repository with no Records store, so nothing can be recorded either way, and
// runs with a temporary home, so the owner's settings, sign-in and git config never reach it.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const WEB = join(import.meta.dir, "..", "..")
/** Vite's own entry, run by Bun directly (as `bun run dev` runs it, without the bin lookup). */
const VITE = join(
  dirname(Bun.resolveSync("vite/package.json", WEB)),
  "bin",
  "vite.js"
)
/** A port nothing listens on: the system picks it, then it is released for Vite. */
const freePort = () => {
  const probe = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  })
  const port = probe.port
  probe.stop(true)
  return port
}
const PORT = freePort()
const ORIGIN = `http://127.0.0.1:${PORT}`

let directory = ""
let server: ReturnType<typeof Bun.spawn> | undefined
let command = ""

/** The tail of one of the dev server's logs, kept beside the temporary repository. */
const log = async (name: string) =>
  (
    await Bun.file(join(directory, name))
      .text()
      .catch(() => "")
  ).slice(-2_000)

const logs = async () =>
  `--- vite.log ---\n${await log("vite.log")}\n--- vite.err.log ---\n${await log("vite.err.log")}`

/** Runs a test and, when it fails, adds the dev server's logs to the failure. */
const withLogs = (body: () => Promise<void>) => async () => {
  try {
    await body()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${message}\n${await logs()}`, { cause: error })
  }
}

/** How long the dev server may take to answer at all, and each test at most. */
const READY_MS = 120_000
const TEST_MS = 30_000

const exited = () =>
  server?.exitCode !== null && server?.exitCode !== undefined
    ? new Error(`the dev server exited with code ${server.exitCode}`)
    : undefined

/** Waits for the dev server to serve the commands' client module (slow under a busy machine). */
const ready = async (until: number) => {
  while (Date.now() < until) {
    const gone = exited()
    if (gone) throw gone
    try {
      const response = await fetch(`${ORIGIN}/src/server/review-commands.ts`, {
        signal: AbortSignal.timeout(10_000),
      })
      if (response.ok) return response.text()
    } catch {
      // Not listening yet, or still transforming.
    }
    await Bun.sleep(250)
  }
  throw new Error(
    `the dev server did not serve the client module in time\n${await logs()}`
  )
}

/**
 * Waits until a same-origin post reaches the command: the server function's route is compiled and
 * answers past the middleware (its empty payload then fails validation). A refusal (403) or no
 * answer means not ready yet, so the tests below never meet a server still compiling the route.
 */
const commandReady = async (until: number) => {
  let last = "no answer"
  while (Date.now() < until) {
    const gone = exited()
    if (gone) throw gone
    try {
      const response = await fetch(command, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Sec-Fetch-Site": "same-origin",
        },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(10_000),
      })
      last = `status ${response.status}`
      if (response.status !== 403) return
    } catch (error) {
      last = error instanceof Error ? error.message : String(error)
    }
    await Bun.sleep(250)
  }
  throw new Error(
    `the command never answered past the boundary (${last})\n${await logs()}`
  )
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "neuve-web-csrf-"))
  const home = join(directory, "home")
  await mkdir(join(home, ".config"), { recursive: true })
  const environment = {
    PATH: process.env["PATH"] ?? "",
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    TMPDIR: process.env["TMPDIR"] ?? tmpdir(),
  }
  const init = Bun.spawn(["git", "init", "-q", directory], { env: environment })
  await init.exited
  server = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--bun",
      VITE,
      "dev",
      "--port",
      String(PORT),
      "--host",
      "127.0.0.1",
      "--strictPort",
    ],
    {
      cwd: WEB,
      stdin: "ignore",
      env: { ...environment, NEUVE_REPOSITORY: directory },
      // Kept so a server that never answers says why in the failure.
      stdout: Bun.file(join(directory, "vite.log")),
      stderr: Bun.file(join(directory, "vite.err.log")),
    }
  )
  const until = Date.now() + READY_MS
  // The client's module names the command's server-function ID.
  const module = await ready(until)
  const id = /sendDecision = .*?createClientRpc\("([^"]+)"\)/.exec(module)?.[1]
  if (id === undefined)
    throw new Error(`no server-function ID for sendDecision\n${await logs()}`)
  command = `${ORIGIN}/_serverFn/${id}`
  await commandReady(until)
}, READY_MS + 30_000)

// The limit ends a hang only: a dev server stopping on a busy machine is not one.
afterAll(async () => {
  server?.kill()
  await server?.exited
  await rm(directory, { recursive: true, force: true })
}, 30_000)

const post = (headers: Record<string, string>) =>
  fetch(command, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(TEST_MS - 5_000),
  })

test(
  "a cross-site post to a desk command is refused",
  withLogs(async () => {
    const response = await post({
      "Sec-Fetch-Site": "cross-site",
      Origin: "https://elsewhere.example",
    })
    expect(response.status).toBe(403)
  }),
  TEST_MS
)

test(
  "a post from another origin without fetch metadata is refused",
  withLogs(async () => {
    expect((await post({ Origin: "https://elsewhere.example" })).status).toBe(
      403
    )
    expect(
      (await post({ Referer: "https://elsewhere.example/page" })).status
    ).toBe(403)
  }),
  TEST_MS
)

test(
  "a post with no origin at all is refused",
  withLogs(async () => {
    expect((await post({})).status).toBe(403)
  }),
  TEST_MS
)

test(
  "a host name other than the loopback names is refused",
  withLogs(async () => {
    const response = await fetch(`${ORIGIN}/`, {
      headers: { Host: "rebound.example" },
      signal: AbortSignal.timeout(TEST_MS - 5_000),
    })
    expect(response.status).toBe(403)
  }),
  TEST_MS
)

test(
  "a same-origin post passes the boundary",
  withLogs(async () => {
    const response = await post({ "Sec-Fetch-Site": "same-origin" })
    expect(response.status).not.toBe(403)
  }),
  TEST_MS
)
