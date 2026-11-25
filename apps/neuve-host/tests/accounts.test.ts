import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore, AccountStatus } from "@neuve/runtime";
import { parseHostFrame } from "../src/host-frame";
import { accountFixtures as coding } from "../../app/src/accounts.fixtures";
import { accountFixtures as desk } from "../../neuve-web/packages/ui/src/fixtures/accounts.fixtures";

test("the app trusts the frame's shape, so any invalid account rejects the whole frame", () => {
  const accounts = desk.signedIn;
  expect(parseHostFrame(JSON.stringify({ accounts }))).toEqual({ accounts });
  for (const invalid of [
    { ...accounts[0], signIn: { state: "invented" } },
    { ...accounts[0], futureField: true },
    null,
  ]) {
    expect(() =>
      parseHostFrame(JSON.stringify({ accounts: [...accounts, invalid] })),
    ).toThrow();
    expect(() =>
      parseHostFrame(JSON.stringify({ accounts: [invalid] })),
    ).toThrow();
  }
  for (const accounts of [null, {}, "invalid"]) {
    expect(() => parseHostFrame(JSON.stringify({ accounts }))).toThrow();
  }
  expect(() => parseHostFrame('{"unrecognized":true}')).toThrow();
});

test("every coding and desk fixture stays a real snapshot as the contract moves", () => {
  for (const fixtures of [coding, desk])
    for (const accounts of Object.values(fixtures)) {
      expect(AccountStatus.array().parse(accounts)).toEqual(accounts);
    }
});

// Socket opens and broadcasts both build this frame, including when store reads fail.
test("host frames retain the last good set and warn once per failed read period", async () => {
  const accounts = await import("../src/accounts");
  let broken = true;
  const error = new AccountStore.StoreError({
    message: "Fixture status is malformed.",
  });
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  let stop = () => {};
  try {
    accounts.setAccountStatusSource({
      current: () => {
        if (broken) throw error;
        return desk.signedIn;
      },
      subscribe: (listener) => {
        if (broken) throw error;
        listener(desk.signedIn);
        return () => {};
      },
    });
    stop = accounts.onChange(() => {});
    expect(accounts.frame()).toEqual({ accounts: [] });
    expect(accounts.frame()).toEqual({ accounts: [] });
    expect(warn.mock.calls).toEqual([["[accounts]", error.message]]);
    broken = false;
    expect(accounts.frame()).toEqual({ accounts: desk.signedIn });
    broken = true;
    expect(accounts.frame()).toEqual({ accounts: desk.signedIn });
    expect(accounts.frame()).toEqual({ accounts: desk.signedIn });
    expect(warn.mock.calls).toHaveLength(2);
  } finally {
    stop();
    accounts.setAccountStatusSource({
      current: () => [],
      subscribe: () => () => {},
    });
    warn.mockRestore();
  }
});

const socketSignedIn = [
  {
    name: "work",
    kind: "claude-subscription",
    signIn: { state: "signed-in", email: "fixture@example.com", plan: "Max" },
    limits: [],
    checkedAt: "2026-11-10T10:00:00Z",
  },
];

const gatewayFixture = `
import { mock } from "bun:test";
import { createInterface } from "node:readline";
await import("./apps/neuve-host/tests/fixtures/memory-secrets.ts");
mock.module("./apps/neuve-host/src/tailnet", () => ({
  identity: () => ({login: "owner", tailnet: "fixture.test"}),
  self: async () => ({name: "fixture", dns: "fixture.test", address: "::1", login: "owner"}),
  whois: async () => ({login: "owner", host: "fixture"}),
  watch: () => () => {}, peers: async () => [],
  certificate: async () => {throw new Error("No fixture TLS")},
}));
for (const name of ["directory", "lobby", "peers"]) {
  const path = "./apps/neuve-host/src/" + name;
  const original = await import(path);
  mock.module(path, () => ({...original, watch: () => name === "directory" ? {stop() {}, sync() {}} : () => {}}));
}
const github = await import("./apps/neuve-host/src/github");
mock.module("./apps/neuve-host/src/github", () => ({...github, login: () => undefined, known: () => undefined}));
const { setAccountStatusSource } = await import("./apps/neuve-host/src/accounts");
const { AccountStatus } = await import("./packages/runtime/src/status");
let current = AccountStatus.array().parse([{name: "work", kind: "claude-subscription", signIn: {state: "signed-in", email: "fixture@example.com", plan: "Max"}, limits: [], checkedAt: "2026-11-10T10:00:00Z"}]);
const initial = current;
let broken = process.env.ACCOUNTS_SCENARIO === "current-read retry";
const { AccountStore } = await import("./packages/runtime/src/index");
const listeners = new Set();
const fixtureSource = {current: () => {if (broken) throw new AccountStore.StoreError({message: "Fixture malformed status."}); return current}, subscribe: (listener) => { if (broken) throw new AccountStore.StoreError({message: "Fixture malformed status."}); listeners.add(listener); listener(current); return () => listeners.delete(listener) }};
setAccountStatusSource(fixtureSource);
const { configureRuntime } = await import("./apps/neuve-host/src/runtime-hooks");
const finishCheck = Promise.withResolvers();
let checks = 0;
configureRuntime({ checkAccounts: async () => {
  checks++;
  await finishCheck.promise;
  current = [];
  for (const listener of listeners) listener(current);
} });
const { startHost } = await import("./apps/neuve-host/src/host");
const host = await startHost({config: {home: process.env.ACE_HOME, lanes: process.env.ACCOUNTS_LANES, user: "owner", port: 0, worker: [process.execPath, "apps/neuve-host/tests/worker.ts"], environment: {PATH: process.env.PATH, TMPDIR: process.env.TMPDIR}}, models: () => []});
console.log("ACCOUNTS_READY " + JSON.stringify({port: host.port, token: host.token}));
try {
  for await (const line of createInterface({input: process.stdin})) {
    if (line === "stop") break;
    if (line === "change" || line === "set-current") current = [];
    if (line === "repair") {broken = false; (await import("./apps/neuve-host/src/accounts")).frame()}
    if (line === "restore") current = initial;
    if (line === "expect-no-check" && checks !== 0) throw new Error("Plain settings checked accounts");
    if (line === "finish-check") {
      if (checks !== 1) throw new Error("Fresh settings must start one account check");
      finishCheck.resolve();
    }
    if (["change", "notify", "restore"].includes(line)) for (const listener of listeners) {listener(current); listener([...current])}
    console.log("ACCOUNTS_DONE " + line);
  }
} finally {await host.close()}
`;

for (const scenario of [
  "push",
  "store",
  "duplicate",
  "initialMalformed",
  "current-read retry",
]) {
  // Real sockets prove deduplication and acquisition recovery; private files prove HOME wiring without watch timing.
  test(
    scenario === "store"
      ? "new local sockets read the current private store and peers receive none"
      : scenario === "push"
        ? "Settings Refresh checks accounts in the background and only local sockets receive the update"
        : `local account sockets handle ${scenario}, suppress identical sets and keep identities from peers`,
    async () => {
      const store = scenario === "store" || scenario === "initialMalformed";
      const home = await mkdtemp(join(tmpdir(), "ca-accounts-"));
      const person = join(home, "person");
      if (store) {
        await mkdir(
          join(AccountStore.neuveFolder(person), "accounts", "records"),
          { recursive: true, mode: 0o700 },
        );
        await writeFile(
          AccountStore.statusesPath(person),
          scenario === "initialMalformed"
            ? "{"
            : JSON.stringify({
                version: 1,
                accounts: [
                  {
                    name: "claude",
                    identity: "claude",
                    kind: "claude-subscription",
                    signIn: {
                      state: "signed-in",
                      email: "fixture@example.com",
                      plan: "Max",
                    },
                    limits: [],
                    checkedAt: "2026-11-10T10:00:00Z",
                  },
                ],
              }),
          { mode: 0o600 },
        );
      }
      const fixture = store
        ? gatewayFixture
            .replace("setAccountStatusSource(fixtureSource);", "")
            .replace(
              "environment: {PATH:",
              "environment: {HOME: process.env.HOME, PATH:",
            )
        : gatewayFixture;
      await mkdir(join(home, "h"));
      await mkdir(join(home, "l"));
      const child = Bun.spawn(
        [process.execPath, "--no-env-file", "--eval", fixture],
        {
          cwd: join(import.meta.dir, "../../.."),
          env: {
            NODE_ENV: "production",
            HOME: person,
            PATH: process.env.PATH,
            TMPDIR: process.env.TMPDIR,
            BUN_TMPDIR: process.env.BUN_TMPDIR,
            BUN_RUNTIME_TRANSPILER_CACHE_PATH:
              process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH,
            ACE_HOME: join(home, "h"),
            ACCOUNTS_LANES: join(home, "l"),
            ACCOUNTS_SCENARIO: scenario,
            ACE_CONFIG_HOME: join(home, "settings"),
            ACE_USER: "owner",
          },
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const deadline = setTimeout(() => child.kill("SIGKILL"), 20_000);
      const stderr = new Response(child.stderr).text();
      const frames: unknown[] = [];
      const peerFrames: unknown[] = [];
      let local: WebSocket | undefined;
      let peer: WebSocket | undefined;
      let reconnected: WebSocket | undefined;
      const output = child.stdout.getReader();
      async function ready() {
        let text = "";
        for (;;) {
          const { value, done } = await output.read();
          if (done) throw new Error(`Fixture stopped: ${await stderr}`);
          text += new TextDecoder().decode(value);
          const match = /ACCOUNTS_READY (.+)\n/.exec(text);
          if (match)
            return JSON.parse(match[1]!) as { port: number; token: string };
        }
      }
      async function command(line: string) {
        child.stdin.write(line + "\n");
        let text = "";
        for (;;) {
          const { value, done } = await output.read();
          if (done) throw new Error(`Fixture stopped: ${await stderr}`);
          text += new TextDecoder().decode(value);
          if (text.includes("ACCOUNTS_DONE " + line + "\n")) return;
        }
      }
      async function until(check: () => boolean) {
        const end = Date.now() + 10_000;
        while (!check()) {
          if (Date.now() > end) throw new Error("Missing fixture frame");
          await Bun.sleep(10);
        }
      }
      try {
        const { port, token } = await ready();
        local = new WebSocket(`ws://127.0.0.1:${port}/ws`, [
          "ace",
          `ace-token.${token}`,
        ]);
        local.addEventListener("message", (event) =>
          frames.push(JSON.parse(String(event.data))),
        );
        peer = new WebSocket(`ws://[::1]:${port}/ws`);
        peer.addEventListener("message", (event) =>
          peerFrames.push(JSON.parse(String(event.data))),
        );
        await until(
          () =>
            peer?.readyState === WebSocket.OPEN &&
            frames.some(
              (frame) =>
                typeof frame === "object" &&
                frame !== null &&
                "accounts" in frame,
            ),
        );
        expect(
          frames.filter(
            (frame) =>
              typeof frame === "object" &&
              frame !== null &&
              "accounts" in frame,
          ),
        ).toEqual(
          scenario === "initialMalformed" || scenario === "current-read retry"
            ? [{ accounts: [] }]
            : store
              ? [{ accounts: AccountStore.readStatuses(person) }]
              : [
                  {
                    accounts: [
                      {
                        name: "work",
                        kind: "claude-subscription",
                        signIn: {
                          state: "signed-in",
                          email: "fixture@example.com",
                          plan: "Max",
                        },
                        limits: [],
                        checkedAt: "2026-11-10T10:00:00Z",
                      },
                    ],
                  },
                ],
        );
        if (
          store ||
          scenario === "duplicate" ||
          scenario === "current-read retry"
        ) {
          if (scenario === "duplicate") await command("set-current");
          if (scenario === "current-read retry") await command("repair");
          if (store)
            await writeFile(
              AccountStore.statusesPath(person),
              JSON.stringify({ version: 1, accounts: [] }),
              { mode: 0o600 },
            );
          // A fresh socket reads after the write even if the OS drops the watch notification.
          const changed: unknown[] = [];
          reconnected = new WebSocket(`ws://127.0.0.1:${port}/ws`, [
            "ace",
            `ace-token.${token}`,
          ]);
          reconnected.addEventListener("message", (event) =>
            changed.push(JSON.parse(String(event.data))),
          );
          await until(() =>
            changed.some(
              (frame) =>
                typeof frame === "object" &&
                frame !== null &&
                "accounts" in frame,
            ),
          );
          expect(
            changed.filter(
              (frame) =>
                typeof frame === "object" &&
                frame !== null &&
                "accounts" in frame,
            ),
          ).toEqual([
            {
              accounts: store
                ? AccountStore.readStatuses(person)
                : scenario === "duplicate"
                  ? []
                  : socketSignedIn,
            },
          ]);
          if (scenario === "duplicate") {
            await command("notify");
            await command("restore");
            await until(
              () =>
                changed.filter(
                  (frame) =>
                    typeof frame === "object" &&
                    frame !== null &&
                    "accounts" in frame,
                ).length >= 2,
            );
            expect(
              changed.filter(
                (frame) =>
                  typeof frame === "object" &&
                  frame !== null &&
                  "accounts" in frame,
              ),
            ).toEqual([{ accounts: [] }, { accounts: socketSignedIn }]);
            expect(
              frames.filter(
                (frame) =>
                  typeof frame === "object" &&
                  frame !== null &&
                  "accounts" in frame,
              ),
            ).toEqual([
              { accounts: socketSignedIn },
              { accounts: [] },
              { accounts: socketSignedIn },
            ]);
          }
          if (
            scenario === "initialMalformed" ||
            scenario === "current-read retry"
          ) {
            await until(
              () =>
                frames.filter(
                  (frame) =>
                    typeof frame === "object" &&
                    frame !== null &&
                    "accounts" in frame,
                ).length >= 2,
            );
            expect(
              frames.filter(
                (frame) =>
                  typeof frame === "object" &&
                  frame !== null &&
                  "accounts" in frame,
              ),
            ).toEqual([
              { accounts: [] },
              {
                accounts: store
                  ? AccountStore.readStatuses(person)
                  : socketSignedIn,
              },
            ]);
          }
          if (scenario === "current-read retry") {
            await command("change");
            await until(() =>
              changed.some(
                (frame) => JSON.stringify(frame) === '{"accounts":[]}',
              ),
            );
            expect(
              frames.filter(
                (frame) =>
                  typeof frame === "object" &&
                  frame !== null &&
                  "accounts" in frame,
              ),
            ).toEqual([
              { accounts: [] },
              { accounts: socketSignedIn },
              { accounts: [] },
            ]);
            expect(
              changed.filter(
                (frame) =>
                  typeof frame === "object" &&
                  frame !== null &&
                  "accounts" in frame,
              ),
            ).toEqual([{ accounts: socketSignedIn }, { accounts: [] }]);
          }
        } else {
          const reply = (id: number) =>
            frames.find(
              (frame) =>
                typeof frame === "object" &&
                frame !== null &&
                "id" in frame &&
                frame.id === id,
            );
          local.send(JSON.stringify({ id: 1, op: "settings" }));
          await until(() => reply(1) !== undefined);
          expect(reply(1)).toMatchObject({ ok: true });
          await command("expect-no-check");
          local.send(JSON.stringify({ id: 2, op: "settings", fresh: true }));
          await until(() => reply(2) !== undefined);
          expect(reply(2)).toMatchObject({ ok: true });
          await command("finish-check");
          await until(() =>
            frames.some((frame) => JSON.stringify(frame) === '{"accounts":[]}'),
          );
        }
        // A request/response barrier on the same peer proves it processed the broadcast turn.
        peer.send(JSON.stringify({ id: 1, op: "hello" }));
        await until(() =>
          peerFrames.some(
            (frame) =>
              typeof frame === "object" && frame !== null && "id" in frame,
          ),
        );
        expect(
          peerFrames.filter(
            (frame) =>
              typeof frame === "object" &&
              frame !== null &&
              "accounts" in frame,
          ),
        ).toEqual([]);
      } finally {
        local?.close();
        reconnected?.close();
        peer?.close();
        if (child.exitCode === null) {
          try {
            child.stdin.write("stop\n");
            child.stdin.end();
          } catch {}
        }
        const stopped = await Promise.race([
          child.exited,
          Bun.sleep(5_000).then(() => undefined),
        ]);
        if (stopped === undefined) child.kill("SIGKILL");
        await child.exited;
        clearTimeout(deadline);
        await output.cancel();
        await stderr;
        await rm(home, { recursive: true, force: true });
      }
    },
    25_000,
  );
}

// Why: Settings must retain StoreError's existing refusal wording and recover after a folder repair.
test("Settings contains a real folder refusal and reports its exact problem", async () => {
  const home = mkdtempSync(join(tmpdir(), "settings-folder-refusal-"));
  const folder = AccountStore.neuveFolder(home);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  chmodSync(folder, 0o775);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const message = `${folder} is writable by other users. Neuve needs it writable only by you.`;
  try {
    const accounts = await import("../src/accounts");
    accounts.setAccountStatusSource(AccountStore.statusSource(home));
    expect(accounts.frame()).toEqual({ accounts: [] });
    expect(warn.mock.calls).toEqual([["[accounts]", message]]);
    chmodSync(folder, 0o755);
    expect(accounts.frame().accounts.length).toBeGreaterThan(0);
    accounts.setAccountStatusSource({
      current: () => [],
      subscribe: () => () => {},
    });
  } finally {
    warn.mockRestore();
    chmodSync(folder, 0o755);
    rmSync(home, { recursive: true, force: true });
  }
});
