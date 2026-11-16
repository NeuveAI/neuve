// Why: "Start a review" requests the range this preview names (ST2, 10.103), so a wrong base or
// merge base would review other work than the overview showed, and a branch with nothing to review
// must be refused before anything is recorded. This builds a repository with a remote: main pushed
// and then ahead of origin/main, a feature branch ahead of main, a branch with nothing ahead, and a
// detached head; and a second repository with no remote, where main has nothing to compare with.
// The preview reads the route from the user's settings, so it runs in a Bun process of its own with
// the test's home, as review-request.test.ts runs the BFF's request: the owner's settings, sign-in
// and git config never reach it.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { branchPreview } from "./start-review.server"

const WEB = join(import.meta.dir, "..", "..")
const PREVIEW = join(import.meta.dir, "start-review.server.ts")

/** Each test starts a Bun process and setup runs many git commands: slow on a busy machine. */
const TEST_MS = 30_000

let directory = ""
let repository = ""
let home = ""

const environment = () => ({
  PATH: process.env["PATH"] ?? "",
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  TMPDIR: process.env["TMPDIR"] ?? tmpdir(),
})

const git = async (at: string, ...args: Array<string>) => {
  const child = Bun.spawn(["git", "-C", at, ...args], {
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

/** The preview of the branch checked out in `at`, from the BFF's own code in a process of its own. */
const branchPreviewIn = async (
  at = repository
): Promise<Awaited<ReturnType<typeof branchPreview>>> => {
  const script = `const { branchPreview } = await import(${JSON.stringify(PREVIEW)});
console.log(JSON.stringify(await branchPreview()));`
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
    cwd: WEB,
    env: { ...environment(), NEUVE_REPOSITORY: at },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`the preview failed: ${err}`)
  return JSON.parse(out)
}

const commit = async (at: string, file: string) => {
  await writeFile(join(at, file), `export const value = "${file}"\n`)
  await git(at, "add", file)
  await git(at, "commit", "-q", "-m", file)
  return git(at, "rev-parse", "HEAD")
}

const initRepository = async (at: string) => {
  await mkdir(at, { recursive: true })
  await git(at, "init", "-q", "-b", "main")
  await git(at, "config", "user.email", "reviewer@example.test")
  await git(at, "config", "user.name", "Test Reviewer")
}

let pushed = ""
let forkPoint = ""

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "neuve-web-start-"))
  home = join(directory, "home")
  await mkdir(join(home, ".config"), { recursive: true })
  repository = join(directory, "repo")
  const remote = join(directory, "remote.git")
  await initRepository(repository)
  await git(directory, "init", "-q", "--bare", "-b", "main", remote)
  await commit(repository, "a.ts")
  pushed = await commit(repository, "b.ts")
  await git(repository, "remote", "add", "origin", remote)
  await git(repository, "push", "-q", "-u", "origin", "main")
  await git(repository, "remote", "set-head", "origin", "main")
  // A feature branch leaves main at the pushed commit...
  forkPoint = pushed
  await git(repository, "checkout", "-q", "-b", "feature")
  await commit(repository, "c.ts")
  await commit(repository, "d.ts")
  // ...and main moves on with work not yet on origin/main.
  await git(repository, "checkout", "-q", "main")
  await commit(repository, "e.ts")
  await commit(repository, "f.ts")
}, TEST_MS)

afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})

test(
  "on main, the work not yet on origin/main is previewed (10.103)",
  async () => {
    await git(repository, "checkout", "-q", "main")
    expect(await branchPreviewIn()).toMatchObject({
      status: "ready",
      preview: {
        branch: "main",
        base: "origin/main",
        headOid: await git(repository, "rev-parse", "HEAD"),
        mergeBase: pushed,
        ahead: 2,
      },
    })
  },
  TEST_MS
)

test(
  "a feature branch previews its head against its base's merge base",
  async () => {
    await git(repository, "checkout", "-q", "feature")
    const preview = await branchPreviewIn()
    expect(preview).toMatchObject({
      status: "ready",
      preview: {
        branch: "feature",
        base: "main",
        headOid: await git(repository, "rev-parse", "HEAD"),
        mergeBase: forkPoint,
        ahead: 2,
      },
    })
    // The route the request freezes is shown before the press.
    expect(preview.status === "ready" && preview.preview.route).toMatch(
      /^\w+\//
    )
  },
  TEST_MS
)

test(
  "a branch with nothing ahead, and main with nothing unpushed, are refused",
  async () => {
    await git(repository, "checkout", "-q", "-b", "empty", "main")
    expect(await branchPreviewIn()).toEqual({
      status: "refused",
      message:
        "empty has nothing ahead of main. Commit to it or check out another branch.",
    })
    await git(repository, "checkout", "-q", "main")
    await git(repository, "push", "-q", "origin", "main")
    expect(await branchPreviewIn()).toEqual({
      status: "refused",
      message:
        "main has nothing ahead of origin/main. Commit to it or check out another branch.",
    })
  },
  TEST_MS
)

test(
  "a detached head, and main with no remote-tracking copy, are refused",
  async () => {
    await git(repository, "checkout", "-q", "--detach", "feature")
    expect(await branchPreviewIn()).toMatchObject({
      status: "refused",
      message: expect.stringContaining("HEAD is detached"),
    })
    const local = join(directory, "local")
    await initRepository(local)
    await commit(local, "a.ts")
    expect(await branchPreviewIn(local)).toMatchObject({
      status: "refused",
      message: expect.stringContaining("main has no remote-tracking copy"),
    })
  },
  TEST_MS
)

test(
  "an origin/HEAD naming a branch the remote no longer has is ignored",
  async () => {
    await git(repository, "checkout", "-q", "main")
    await commit(repository, "g.ts")
    await git(
      repository,
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/trunk"
    )
    expect(await branchPreviewIn()).toMatchObject({
      status: "ready",
      preview: { branch: "main", base: "origin/main", ahead: 1 },
    })
  },
  TEST_MS
)
