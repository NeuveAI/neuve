import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { AccountStore } from "@neuve/runtime";

const root = join(import.meta.dir, "../../..");
const entry = join(root, "apps/neuve-host/src/helper.ts");
const signedIn = [
  {
    name: "claude",
    kind: "claude-subscription",
    signIn: { state: "signed-in", email: "fixture@example.com", plan: "Max" },
    limits: [],
    checkedAt: "2026-11-10T10:00:00Z",
  },
];
const expected = [
  {
    name: "anthropic",
    kind: "anthropic-api-key",
    signIn: { state: "unknown", reason: "not-checked" },
    limits: [],
    checkedAt: "1970-01-01T00:00:00.000Z",
  },
  {
    name: "chatgpt",
    kind: "chatgpt-subscription",
    signIn: { state: "unknown", reason: "not-checked" },
    limits: [],
    checkedAt: "1970-01-01T00:00:00.000Z",
  },
  ...signedIn,
];

async function status(home: string) {
  await mkdir(join(AccountStore.neuveFolder(home), "accounts", "records"), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(
    AccountStore.statusesPath(home),
    JSON.stringify({
      version: 1,
      accounts: signedIn.map((account) => ({ ...account, identity: "claude" })),
    }),
    { mode: 0o600 },
  );
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error("Timed out waiting for helper fixture");
    await Bun.sleep(10);
  }
}

const preload = `
import { mock } from "bun:test";
import { writeFileSync } from "node:fs";
await import(${JSON.stringify(join(root, "apps/neuve-host/tests/fixtures/memory-secrets.ts"))});
mock.module(${JSON.stringify(join(root, "apps/neuve-host/src/tailnet"))}, () => ({
  identity: () => ({login: "owner", tailnet: "fixture.test"}),
  self: async () => ({name: "fixture", dns: "fixture.test", address: "::1", login: "owner"}),
  whois: async () => ({login: "owner", host: "fixture"}),
  watch: () => () => {}, peers: async () => [],
  certificate: async () => {
    const { config } = await import(${JSON.stringify(join(root, "apps/neuve-host/src/config"))});
    const { token } = await import(${JSON.stringify(join(root, "apps/neuve-host/src/auth"))});
    writeFileSync(process.env.FIXTURE_READY, JSON.stringify({port: config.port, home: config.home, token: token()}));
    throw new Error("No fixture TLS");
  },
}));
for (const name of ["directory", "lobby", "peers"]) {
  const path = ${JSON.stringify(join(root, "apps/neuve-host/src"))} + "/" + name;
  const original = await import(path);
  mock.module(path, () => ({...original, watch: () => name === "directory" ? {stop() {}, sync() {}} : () => {}}));
}
const githubPath = ${JSON.stringify(join(root, "apps/neuve-host/src/github"))};
const github = await import(githubPath);
mock.module(githubPath, () => ({...github, login: () => undefined, known: () => undefined}));
const runtime = await import(${JSON.stringify(join(root, "packages/runtime/src/index"))});
const { AccountStore } = runtime;
const originalSource = AccountStore.statusSource;
mock.module("@neuve/runtime", () => ({...runtime, AccountStore: {...AccountStore, statusSource: (home) => {
  writeFileSync(process.env.FIXTURE_READ, home);
  return originalSource(home);
}}}));
`;

for (const mode of ["helper", "cli-serve", "cli-help"]) {
  // Most people run the packaged entry; real sockets prove its HOME selection and peer isolation.
  test(`packaged ${mode} uses its own home and reads accounts only for a gateway`, async () => {
    const home = await mkdtemp(join(tmpdir(), "ca-helper-"));
    const adopted = join(home, "adopted");
    const person = mode === "helper" ? adopted : home;
    const hostHome = join(home, "host");
    const ready = join(home, "ready.json");
    const read = join(home, "store-read");
    let local: WebSocket | undefined;
    let peer: WebSocket | undefined;
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      await mkdir(adopted);
      await status(person);
      // A controlled shell proves adoption and cannot load the person's shell profiles.
      const shell = join(home, "login-shell");
      await writeFile(
        shell,
        '#!/bin/sh\nprintf __ace_env__\nHOME="$FIXTURE_ADOPTED" /usr/bin/env -0\n',
        { mode: 0o700 },
      );
      const setup = join(home, "preload.ts");
      await writeFile(setup, preload);
      child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "--preload",
          setup,
          "--define",
          'ACE_IDENTIFIER="dev.ace.desktop.dev"',
          "--define",
          "ACE_PROFILE=undefined",
          "--define",
          'ACE_VERSION="0.0.0-fixture"',
          entry,
          ...(mode === "cli-help"
            ? ["--help"]
            : mode === "cli-serve"
              ? ["serve", "--port", "0"]
              : []),
        ],
        {
          argv0: mode === "helper" ? "Ace Helper" : "ace",
          cwd: root,
          env: {
            NODE_ENV: "production",
            HOME: home,
            SHELL: shell,
            PATH: process.env.PATH,
            TMPDIR: process.env.TMPDIR,
            BUN_TMPDIR: process.env.BUN_TMPDIR,
            BUN_RUNTIME_TRANSPILER_CACHE_PATH:
              process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH,
            ACE_PORT: "0",
            ACE_WEB_PORT: "0",
            ACE_USER: "owner",
            ACE_HOME: hostHome,
            ACE_CONFIG_HOME: join(home, "settings"),
            FIXTURE_ADOPTED: adopted,
            FIXTURE_READY: ready,
            FIXTURE_READ: read,
          },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 20_000,
        },
      );
      const stdout = new Response(child.stdout).text();
      const stderr = new Response(child.stderr).text();
      if (mode === "cli-help") {
        expect(await child.exited).toBe(0);
        expect(await stdout).toContain("ace serve");
        expect(await stderr).toBe("");
        expect(existsSync(read)).toBe(false);
        expect(existsSync(ready)).toBe(false);
        return;
      }
      await until(() => existsSync(ready) || child?.exitCode !== null);
      if (!existsSync(ready))
        throw new Error(
          `Helper exited: ${await stderr}\n${await stdout}\n${await readFile(join(hostHome, "helper.log"), "utf8").catch(() => "")}`,
        );
      const info = z
        .object({
          port: z.number().int().positive(),
          home: z.string(),
          token: z.string(),
        })
        .parse(JSON.parse(await readFile(ready, "utf8")));
      expect(info.home).toBe(hostHome);
      expect(await readFile(read, "utf8")).toBe(person);
      const frames: unknown[] = [];
      const peerFrames: unknown[] = [];
      local = new WebSocket(`ws://127.0.0.1:${info.port}/ws`, [
        "ace",
        `ace-token.${info.token}`,
      ]);
      local.addEventListener("message", (event) =>
        frames.push(JSON.parse(String(event.data))),
      );
      peer = new WebSocket(`ws://[::1]:${info.port}/ws`);
      peer.addEventListener("message", (event) =>
        peerFrames.push(JSON.parse(String(event.data))),
      );
      const accountFrames = () =>
        frames.filter(
          (frame) =>
            typeof frame === "object" && frame !== null && "accounts" in frame,
        );
      await until(
        () => accountFrames().length > 0 && peer?.readyState === WebSocket.OPEN,
      );
      expect(accountFrames()).toEqual([{ accounts: expected }]);
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
            typeof frame === "object" && frame !== null && "accounts" in frame,
        ),
      ).toEqual([]);
      local.close();
      peer.close();
      child.kill("SIGTERM");
      expect(await child.exited).toBe(0);
      await Promise.all([stdout, stderr]);
      console.log(
        JSON.stringify({
          mode,
          accountHome: person,
          localAccounts: accountFrames(),
          peerAccounts: peerFrames.filter(
            (frame) =>
              typeof frame === "object" &&
              frame !== null &&
              "accounts" in frame,
          ),
          hostLog: await readFile(join(hostHome, "logs", "host.jsonl"), "utf8"),
        }),
      );
    } finally {
      local?.close();
      peer?.close();
      if (child) {
        if (child.exitCode === null) child.kill("SIGKILL");
        await child.exited;
      }
      await rm(home, { recursive: true, force: true });
    }
  }, 25_000);
}

for (const mode of [
  "first-use",
  "configured",
  "configured-no-home",
  "no-home",
  "test-mode",
]) {
  // The packaged fallback must stay lazy and must never override a configured environment or test isolation.
  test(`account HOME boundary preserves ${mode}`, async () => {
    const home = await mkdtemp(join(tmpdir(), "ca-home-"));
    try {
      await status(home);
      const code = `
        const {config} = await import("./apps/neuve-host/src/host-config");
        const accounts = await import("./apps/neuve-host/src/accounts");
        if (${JSON.stringify(mode)} === "configured") config.environment = {HOME: process.env.FIXTURE_HOME};
        if (${JSON.stringify(mode)} === "configured-no-home") config.environment = {};
        if (${JSON.stringify(mode)} === "first-use") process.env.HOME = process.env.FIXTURE_HOME;
        console.log(JSON.stringify(accounts.frame()));
      `;
      const child = Bun.spawn(
        [process.execPath, "--no-env-file", "--eval", code],
        {
          cwd: root,
          env: {
            ...(mode === "no-home"
              ? {}
              : {
                  HOME:
                    mode === "first-use" || mode === "configured"
                      ? join(home, "empty")
                      : home,
                }),
            FIXTURE_HOME: home,
            NODE_ENV: mode === "test-mode" ? "test" : "production",
            TMPDIR: process.env.TMPDIR,
            BUN_TMPDIR: process.env.BUN_TMPDIR,
            BUN_RUNTIME_TRANSPILER_CACHE_PATH:
              process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH,
          },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 10_000,
        },
      );
      try {
        const [stdout, stderr, exit] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(stderr).toBe("");
        expect(exit).toBe(0);
        expect(JSON.parse(stdout)).toEqual({
          accounts:
            mode === "first-use" || mode === "configured" ? expected : [],
        });
      } finally {
        if (child.exitCode === null) child.kill("SIGKILL");
        await child.exited;
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 15_000);
}
