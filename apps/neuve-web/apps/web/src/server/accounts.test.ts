import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { expect, spyOn, test } from "bun:test"
import { AccountStore, AccountStatus } from "@neuve/runtime"
import { currentAccounts, setAccountStatusSource } from "./accounts.server"
import { eventStream } from "./live-events.server"

async function temporaryRepository(prefix: string) {
  const repository = await mkdtemp(join(tmpdir(), prefix))
  const initialized = Bun.spawnSync(["git", "init", "-q", repository])
  if (initialized.exitCode !== 0) {
    await rm(repository, { recursive: true, force: true })
    throw new Error(initialized.stderr.toString())
  }
  return repository
}

// Existing test processes can inherit HOME without reading the person's account files.
test("the default BFF source is empty in test mode", () => {
  expect(currentAccounts()).toEqual([])
})

// Records' mark leads every connection, before the current account set.
test("a new stream sends the Records mark before accounts", async () => {
  const repository = await temporaryRepository("accounts-mark-first-")
  const previousRepository = process.env.NEUVE_REPOSITORY
  process.env.NEUVE_REPOSITORY = repository
  const current = AccountStatus.array().parse([
    {
      name: "work",
      kind: "claude-subscription",
      signIn: { state: "signed-in", email: "fixture@example.com" },
      limits: [],
      checkedAt: "2026-11-10T10:00:00Z",
    },
  ])
  setAccountStatusSource({
    current: () => current,
    subscribe: (listener) => {
      listener(current)
      return () => {}
    },
  })
  const reader = eventStream(
    new Request("http://localhost/api/events")
  ).body!.getReader()
  const decoder = new TextDecoder()
  try {
    expect(decoder.decode((await reader.read()).value)).toBe(
      'id: 0\nevent: records\ndata: {"sequence":0,"jobs":"","changed":"all"}\n\n'
    )
    expect(decoder.decode((await reader.read()).value)).toBe(
      `event: accounts\ndata: ${JSON.stringify(current)}\n\n`
    )
  } finally {
    await reader.cancel()
    setAccountStatusSource({ current: () => [], subscribe: () => () => {} })
    if (previousRepository === undefined) delete process.env.NEUVE_REPOSITORY
    else process.env.NEUVE_REPOSITORY = previousRepository
    await rm(repository, { recursive: true, force: true })
  }
})

// An aborted request must not acquire a store subscription or a timer.
test("an already disconnected tab holds no account listener", async () => {
  const repository = await temporaryRepository("accounts-aborted-")
  const previousRepository = process.env.NEUVE_REPOSITORY
  process.env.NEUVE_REPOSITORY = repository
  const listeners = new Set<(statuses: readonly AccountStatus[]) => void>()
  setAccountStatusSource({
    current: () => [],
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  })
  const abort = new AbortController()
  abort.abort()
  const response = eventStream(
    new Request("http://localhost/api/events", { signal: abort.signal })
  )
  const reader = response.body!.getReader()
  try {
    expect(listeners.size).toBe(0)
    expect(await reader.read()).toEqual({
      done: true,
      value: undefined,
    })
  } finally {
    await reader.cancel()
    setAccountStatusSource({ current: () => [], subscribe: () => () => {} })
    if (previousRepository === undefined) delete process.env.NEUVE_REPOSITORY
    else process.env.NEUVE_REPOSITORY = previousRepository
    await rm(repository, { recursive: true, force: true })
  }
})

// A synchronous source emission must produce one initial event and one shared subscription.
test("the pushed stream sends current and changed accounts and releases the last tab's source listener", async () => {
  const repository = await temporaryRepository("accounts-bff-")
  const previousRepository = process.env.NEUVE_REPOSITORY
  process.env.NEUVE_REPOSITORY = repository
  let current = AccountStatus.array().parse([
    {
      name: "work",
      kind: "claude-subscription",
      signIn: { state: "signed-in", email: "fixture@example.com" },
      limits: [],
      checkedAt: "2026-11-10T10:00:00Z",
    },
  ])
  const listeners = new Set<(statuses: readonly AccountStatus[]) => void>()
  setAccountStatusSource({
    current: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      listener(current)
      return () => {
        listeners.delete(listener)
      }
    },
  })
  const first = new AbortController()
  const second = new AbortController()
  const reader = eventStream(
    new Request("http://localhost/api/events", { signal: first.signal })
  ).body!.getReader()
  const other = eventStream(
    new Request("http://localhost/api/events", { signal: second.signal })
  ).body!.getReader()
  const decoder = new TextDecoder()
  async function accountEvent(stream: typeof reader) {
    for (;;) {
      const { value, done } = await stream.read()
      if (done) throw new Error("Missing accounts event")
      const event = decoder.decode(value)
      if (event.startsWith("event: accounts\n"))
        return JSON.parse(event.split("data: ")[1]!)
    }
  }
  try {
    expect(await accountEvent(reader)).toEqual(current)
    expect(await accountEvent(other)).toEqual(current)
    expect(currentAccounts()).toEqual(current)
    expect(listeners.size).toBe(1)
    current = []
    for (const listener of listeners) listener(current)
    expect(await accountEvent(reader)).toEqual([])
    expect(await accountEvent(other)).toEqual([])
    first.abort()
    expect(listeners.size).toBe(1)
    second.abort()
    expect(listeners.size).toBe(0)
  } finally {
    first.abort()
    second.abort()
    await reader.cancel()
    await other.cancel()
    setAccountStatusSource({ current: () => [], subscribe: () => () => {} })
    if (previousRepository === undefined) delete process.env.NEUVE_REPOSITORY
    else process.env.NEUVE_REPOSITORY = previousRepository
    await rm(repository, { recursive: true, force: true })
  }
})

for (const scenario of ["duplicate", "new-tab retry", "current-read retry"]) {
  // A controlled notification proves per-tab delivery and event-driven recovery without OS watch timing.
  test(`account streams handle ${scenario} without repeating a set`, async () => {
    const repository = await temporaryRepository("accounts-delivery-")
    const previousRepository = process.env.NEUVE_REPOSITORY
    process.env.NEUVE_REPOSITORY = repository
    const signedIn = AccountStatus.array().parse([
      {
        name: "work",
        kind: "claude-subscription",
        signIn: { state: "signed-in", email: "fixture@example.com" },
        limits: [],
        checkedAt: "2026-11-10T10:00:00Z",
      },
    ])
    let broken = scenario !== "duplicate"
    let current = signedIn
    let acquisitions = 0
    const sourceListeners = new Set<
      (statuses: readonly AccountStatus[]) => void
    >()
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    setAccountStatusSource({
      current: () => {
        if (broken)
          throw new AccountStore.StoreError({
            message: "Fixture malformed status.",
          })
        return current
      },
      subscribe: (listener) => {
        acquisitions++
        if (broken)
          throw new AccountStore.StoreError({
            message: "Fixture malformed status.",
          })
        sourceListeners.add(listener)
        listener(current)
        return () => {
          sourceListeners.delete(listener)
        }
      },
    })
    const tabs: {
      abort: AbortController
      events: unknown[]
      ready: Promise<void>
      drained: Promise<void>
    }[] = []
    function open() {
      const abort = new AbortController()
      const reader = eventStream(
        new Request("http://localhost/api/events", { signal: abort.signal })
      ).body!.getReader()
      const events: unknown[] = []
      const { promise: ready, resolve } = Promise.withResolvers<void>()
      const drained = (async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read()
            if (done) return
            const event = new TextDecoder().decode(value)
            if (event.startsWith("event: accounts\n")) {
              events.push(JSON.parse(event.split("data: ")[1]!))
              resolve()
            }
          }
        } finally {
          reader.releaseLock()
        }
      })()
      const tab = { abort, events, ready, drained }
      tabs.push(tab)
      return tab
    }
    try {
      const first = open()
      await first.ready
      current = scenario === "duplicate" ? [] : signedIn
      broken = false
      const second = scenario === "current-read retry" ? undefined : open()
      if (second) await second.ready
      if (!second) expect(currentAccounts()).toEqual(signedIn)
      const delivered = current
      for (const listener of sourceListeners) {
        listener(current)
        listener([...current])
      }
      current = scenario === "duplicate" ? signedIn : []
      for (const listener of sourceListeners) listener(current)
      for (const tab of tabs) tab.abort.abort()
      await Promise.all(tabs.map((tab) => tab.drained))
      expect(first.events).toEqual([
        scenario === "duplicate" ? signedIn : [],
        delivered,
        current,
      ])
      if (second) expect(second.events).toEqual([delivered, current])
      expect(acquisitions).toBe(scenario === "duplicate" ? 1 : 2)
      expect(sourceListeners.size).toBe(0)
      expect(warn.mock.calls).toHaveLength(scenario === "duplicate" ? 0 : 1)
    } finally {
      for (const tab of tabs) tab.abort.abort()
      await Promise.all(tabs.map((tab) => tab.drained))
      setAccountStatusSource({ current: () => [], subscribe: () => () => {} })
      warn.mockRestore()
      if (previousRepository === undefined) delete process.env.NEUVE_REPOSITORY
      else process.env.NEUVE_REPOSITORY = previousRepository
      await rm(repository, { recursive: true, force: true })
    }
  })
}

const storeStreamFixture = String.raw`
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
const { AccountStore } = await import("./packages/runtime/src/index");
const { currentAccounts } = await import("./apps/neuve-web/apps/web/src/server/accounts.server");
const { eventStream } = await import("./apps/neuve-web/apps/web/src/server/live-events.server");
const path = AccountStore.statusesPath(process.env.HOME);
const initialBad = process.env.INITIAL_BAD === "1";
const initial = initialBad ? [] : AccountStore.readStatuses(process.env.HOME);
const aborts = [];
const readers = [];
function open() {
  const abort = new AbortController(); aborts.push(abort);
  const reader = eventStream(new Request("http://localhost/api/events", {signal: abort.signal})).body.getReader();
  readers.push(reader); return reader;
}
async function accountEvent(reader) {
  for (;;) {
    const {value, done} = await reader.read();
    assert.equal(done, false);
    const event = new TextDecoder().decode(value);
    if (event.startsWith("event: accounts\n")) return JSON.parse(event.split("data: ")[1]);
  }
}
function write(accounts) {writeFileSync(path, JSON.stringify({version: 1, accounts}), {mode: 0o600})}
try {
  assert.deepEqual(currentAccounts(), initial);
  const first = open();
  assert.deepEqual(await accountEvent(first), initial);
  if (!initialBad) {
    const second = open();
    assert.deepEqual(await accountEvent(second), initial);
    write([]);
    const expected = AccountStore.readStatuses(process.env.HOME);
    // Read after writing: this assertion does not depend on macOS watch delivery.
    assert.deepEqual(currentAccounts(), expected);
    writeFileSync(path, "{", {mode: 0o600});
    assert.deepEqual(currentAccounts(), expected);
    assert.deepEqual(currentAccounts(), expected);
    write([{name: "claude", identity: "claude", kind: "claude-subscription", signIn: {state: "unknown", reason: "check-failed"}, limits: [], checkedAt: "2026-11-10T11:00:00Z"}]);
  } else {
    assert.deepEqual(currentAccounts(), []);
    write([{name: "claude", identity: "claude", kind: "claude-subscription", signIn: {state: "signed-in", email: "repaired@example.com"}, limits: [], checkedAt: "2026-11-10T11:00:00Z"}]);
    const repaired = AccountStore.readStatuses(process.env.HOME);
    const second = open();
    assert.deepEqual(await accountEvent(second), repaired);
    aborts[0].abort();
    const pending = [];
    for (;;) {
      const {value, done} = await first.read();
      if (done) break;
      const event = new TextDecoder().decode(value);
      if (event.startsWith("event: accounts\n")) pending.push(JSON.parse(event.split("data: ")[1]));
    }
    assert.deepEqual(pending, [repaired], "the existing tab receives the repaired set when the second tab opens");
  }
  const recovered = AccountStore.readStatuses(process.env.HOME);
  assert.deepEqual(currentAccounts(), recovered);
  const reconnected = open();
  assert.deepEqual(await accountEvent(reconnected), recovered);
  // Closing and draining proves no second initial event was queued for this tab.
  aborts.at(-1).abort();
  for (;;) {
    const {value, done} = await reconnected.read();
    if (done) break;
    assert.ok(!new TextDecoder().decode(value).startsWith("event: accounts\n"));
  }
  console.log("STORE_STREAM_OK");
} finally {
  for (const abort of aborts) abort.abort();
  for (const reader of readers) await reader.cancel();
}
`

for (const initiallyMalformed of [false, true]) {
  // A child with no competing watches proves real SSE delivery and safe reads against private files.
  test(`the BFF uses temporary HOME and contains ${initiallyMalformed ? "initial" : "changed"} malformed status files`, async () => {
    const home = await temporaryRepository("accounts-store-bff-")
    await mkdir(join(AccountStore.neuveFolder(home), "accounts", "records"), {
      recursive: true,
      mode: 0o700,
    })
    await writeFile(
      AccountStore.statusesPath(home),
      initiallyMalformed
        ? "{"
        : JSON.stringify({
            version: 1,
            accounts: [
              {
                name: "claude",
                identity: "claude",
                kind: "claude-subscription",
                signIn: { state: "signed-in", email: "fixture@example.com" },
                limits: [],
                checkedAt: "2026-11-10T10:00:00Z",
              },
            ],
          }),
      { mode: 0o600 }
    )
    const child = Bun.spawn(
      [process.execPath, "--no-env-file", "--eval", storeStreamFixture],
      {
        cwd: join(import.meta.dir, "../../../../../.."),
        env: {
          PATH: process.env.PATH,
          HOME: home,
          TMPDIR: process.env.TMPDIR,
          BUN_TMPDIR: process.env.BUN_TMPDIR,
          BUN_RUNTIME_TRANSPILER_CACHE_PATH:
            process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH,
          NODE_ENV: "production",
          NEUVE_REPOSITORY: home,
          INITIAL_BAD: initiallyMalformed ? "1" : "0",
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    )
    const stdout = new Response(child.stdout).text()
    const stderr = new Response(child.stderr).text()
    try {
      const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000)
      let code: number
      try {
        code = await child.exited
      } finally {
        clearTimeout(timeout)
      }
      const output = await stdout
      const errors = await stderr
      expect({
        code,
        output,
        errors: errors.replaceAll(home, "<temporary-home>"),
      }).toMatchObject({ code: 0, output: "STORE_STREAM_OK\n" })
      expect(errors).toContain(
        `${AccountStore.statusesPath(home)} is not valid JSON.`
      )
      expect(errors.match(/\[accounts\]/g)?.length).toBe(1)
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL")
      await child.exited
      await Promise.all([stdout, stderr])
      await rm(home, { recursive: true, force: true })
    }
  }, 15_000)
}

// Why: Settings must retain StoreError's existing refusal wording and recover after a folder repair.
test("Settings contains a real folder refusal and reports its exact problem", async () => {
  const home = mkdtempSync(join(tmpdir(), "settings-folder-refusal-"))
  const folder = AccountStore.neuveFolder(home)
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  chmodSync(folder, 0o775)
  const warn = spyOn(console, "warn").mockImplementation(() => {})
  const message = `${folder} is writable by other users. Neuve needs it writable only by you.`
  try {
    setAccountStatusSource(AccountStore.statusSource(home))
    expect(currentAccounts()).toEqual([])
    expect(warn.mock.calls).toEqual([["[accounts]", message]])
    chmodSync(folder, 0o755)
    expect(currentAccounts().length).toBeGreaterThan(0)
    setAccountStatusSource({ current: () => [], subscribe: () => () => {} })
  } finally {
    warn.mockRestore()
    chmodSync(folder, 0o755)
    rmSync(home, { recursive: true, force: true })
  }
})
