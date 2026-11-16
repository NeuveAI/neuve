// Why: a review's run key names everything the run is frozen with, so a request from the desk that
// froze anything differently from `neuve review` would start a second review of the same range
// instead of joining the first, and the two would never share cached work (S2 review, item 1). The
// two paths differ in who passes what: the web app passes the route from the user's settings and the
// git human, the CLI resolves both itself. This requests one range both ways, with the route and the
// stack tools set only in the settings file (stack tools on freeze the parser's identity into the
// key), and checks both requests froze the same configuration and run key. Each path runs in its
// own Bun process, as the CLI and the BFF do, with the test's home. It runs no review: with no
// sign-in in that home, no worker is started.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { Identity, Log, Store, storeLocationIn } from "@neuve/records-core"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"

import { writeInstallation } from "../../../../../neuve-cli/src/installation"

const ROOT = join(import.meta.dir, "../../../../../..")
const CLI = join(ROOT, "apps/neuve-cli/src/cli.ts")
const WEB = join(import.meta.dir, "..", "..")
const REQUEST = join(import.meta.dir, "review-request.server.ts")

let directory = ""
let repository = ""
let home = ""

/** Every process the test starts sees only the test's home, never the owner's settings, sign-in or git config. */
const environment = () => ({
  PATH: process.env["PATH"] ?? "",
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  TMPDIR: process.env["TMPDIR"] ?? tmpdir(),
})

const git = async (...args: Array<string>) => {
  const child = Bun.spawn(["git", "-C", repository, ...args], {
    env: environment(),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, code] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed`)
  return out.trim()
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "neuve-web-request-"))
  repository = join(directory, "repo")
  home = join(directory, "home")
  await mkdir(join(home, ".config"), { recursive: true })
  await mkdir(repository, { recursive: true })
  await git("init", "-q", "-b", "main")
  await git("config", "user.email", "reviewer@example.test")
  await git("config", "user.name", "Test Reviewer")
  await writeFile(join(repository, "a.ts"), "export const a = 1\n")
  await git("add", "a.ts")
  await git("commit", "-q", "-m", "base")
  await writeFile(
    join(repository, "a.ts"),
    "export const a = 2\nexport const b = 3\n"
  )
  await git("commit", "-q", "-am", "head")
  // The CLI half of the test runs `neuve review`, which refuses a repository until setup has run
  // there; the desk's own request path doesn't ask. Record it with setup's own writer.
  await writeInstallation(repository, {
    cliBinary: process.execPath,
    graphBinary: "/nonexistent/entire-graph",
  })
  // Settings only in the file: the OpenAI route and the stack tools on.
  const settings = join(home, "Library", "Application Support", "Neuve")
  await mkdir(settings, { recursive: true })
  await writeFile(
    join(settings, "settings.json"),
    JSON.stringify({
      version: 1,
      review: { route: "openai" },
      stack: { tools: true },
    })
  )
}, 30_000)

afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})

const run = async (
  command: Array<string>,
  cwd: string,
  env: Record<string, string>
) => {
  const child = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { out, err, code }
}

/** The repository's own store, named directly: resolving it here would run git with the owner's config. */
const requested = () =>
  Effect.andThen(
    Store.prepareForRead,
    Log.history({ kind: "review.requested@1", limit: 10 })
  ).pipe(
    Effect.provide(
      Store.layer(storeLocationIn(join(repository, ".git")), { create: false })
    ),
    Effect.provide(BunFileSystem.layer),
    Effect.runPromise
  )

test("the web app and the CLI freeze the same run key for one range and settings, stack tools on", async () => {
  const cli = await run(
    [
      process.execPath,
      "--no-env-file",
      CLI,
      "review",
      "HEAD~1..HEAD",
      "--detach",
      "--repo",
      repository,
    ],
    ROOT,
    environment()
  )
  expect({ code: cli.code, err: cli.err }).toEqual({ code: 0, err: "" })
  expect(cli.out).toContain("the job waits for a worker that has it")

  // The BFF's path, in a process of its own started from the web app.
  const script = `const { requestFromWeb } = await import(${JSON.stringify(REQUEST)});
const request = await requestFromWeb("HEAD~1..HEAD");
console.log(JSON.stringify({ id: request.events.at(-1).id, actor: request.actor, openedCycle: request.openedCycle }));`
  const bff = await run(
    [process.execPath, "--no-env-file", "-e", script],
    WEB,
    { ...environment(), NEUVE_REPOSITORY: repository }
  )
  expect({ code: bff.code, err: bff.err }).toEqual({ code: 0, err: "" })
  const web = JSON.parse(bff.out) as {
    id: string
    actor: string
    openedCycle: boolean
  }

  const events = await requested()
  expect(events).toHaveLength(2)
  const [fromCli, fromWeb] = events.map((stored) =>
    stored.event.kind === "review.requested@1" ? stored.event : undefined
  )
  expect(fromWeb?.id).toBe(web.id)
  // The route and the stack tools came from the settings file on both paths.
  expect(fromCli?.payload.pipeline.config).toMatchObject({
    route: { provider: "openai" },
    stack: { tools: true },
  })
  expect(fromWeb?.payload.pipeline).toEqual(fromCli!.payload.pipeline)
  expect(fromWeb?.payload.runKey).toBe(fromCli!.payload.runKey)
  // One cycle and one job: the desk's request joined the CLI's.
  expect(fromWeb?.attribution.cycleId).toBe(fromCli!.attribution.cycleId)
  expect(web.openedCycle).toBe(false)
  // Attributed to the person git names, never to a session (ID1).
  const person = Identity.humanFingerprint("reviewer@example.test")
  expect(fromWeb?.actor).toBe(person)
  expect(web.actor).toBe(person)
}, 60_000)
