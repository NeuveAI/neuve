import { expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { RouteProvider } from "@neuve/harness";
import {
  AccountName,
  AccountStatus,
  AccountStore,
  RuntimeRegistry,
  signInCommand,
  type RuntimeShape,
} from "@neuve/runtime";
import * as RecordsCli from "../src/records-cli.ts";
import {
  authRuntimes,
  runAuthCli,
  claudeLoginOptions,
} from "../src/auth-cli.ts";

const fakeRuntime = (calls: string[], signedIn = false): RuntimeShape => ({
  kind: "claude-code",
  capabilities: () =>
    Effect.succeed({
      ownsLoop: true,
      toolEndsTurn: true,
      resumeInTurn: true,
      perMessageUsage: true,
      resume: true,
      fork: true,
      interrupt: false,
      modelSwitchInSession: false,
      structuredOutput: true,
      steering: false,
      approvals: false,
      perRequestTelemetry: false,
      ownTools: false,
      byteExactCapture: false,
      nativeToolServer: false,
      statusProbe: true,
      internalRetries: false,
    }),
  continuation: (account) => ({ runtime: account.runtime, key: account.name }),
  openSession: () => Effect.die("status must not open a session"),
  signOut: () =>
    Effect.sync(() => {
      calls.push("signOut");
    }),
  probe: (account) =>
    Effect.sync(() => {
      calls.push(`probe:${account.name}`);
      return {
        signIn: signedIn
          ? { state: "signed-in" as const }
          : {
              state: "not-signed-in" as const,
              hint: {
                kind: "command" as const,
                command: "claude auth login" as const,
                ...(account.credential.kind === "claude-config-folder" &&
                account.credential.folder !== undefined
                  ? {
                      environment: {
                        CLAUDE_CONFIG_DIR: account.credential.folder,
                      },
                    }
                  : {}),
              },
            },
        limits: [],
        checkedAt: new Date().toISOString(),
      };
    }),
});

// A named Codex account must reach the ChatGPT sign-in command before a Codex installation is needed.
test("add chatgpt with Codex creates a named sign-in and reports its login command", async () => {
  const home = scratch();
  try {
    const args = ["add", "chatgpt", "work", "--runtime", "codex"];
    expect(await capture(() => runAuthCli(args, { home }))).toEqual({
      value: 0,
      out: "neuve auth login work\n",
    });
    const account = AccountStore.readAccounts(home).find(
      ({ account }) => account.name === "work",
    )?.account;
    expect(account).toMatchObject({
      runtime: "codex",
      kind: "chatgpt-subscription",
      credential: { kind: "neuve-sign-in" },
    });
    expect(
      await capture(() => runAuthCli(["login", "work", "--print"], { home })),
    ).toEqual({ value: 0, out: "neuve auth login work\n" });
    const status = await capture(() =>
      runAuthCli(["status", "work", "--check"], { home }),
    );
    expect(status.out).toContain("not-signed-in\n  neuve auth login work");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
const scratch = () => mkdtempSync(join(tmpdir(), "auth-accounts-cli-"));
async function capture<A>(run: () => Promise<A>) {
  const out: string[] = [];
  const writer = spyOn(RecordsCli, "write").mockImplementation((text) => {
    out.push(text.endsWith("\n") ? text : `${text}\n`);
    return Promise.resolve(text.length);
  });
  try {
    return { value: await run(), out: out.join("") };
  } finally {
    writer.mockRestore();
  }
}

// A removal blocked at sign-out can otherwise look like a startup failure.
test("auth remove reports a failed Codex account sign-out and names the file to fix", async () => {
  await withBrokenSignIn("codex", async (home, file) => {
    const error: unknown = await capture(() =>
      runAuthCli(["remove", "work"], { home }),
    ).catch((error: unknown) => error);
    expect(error).toHaveProperty(
      "message",
      expect.stringContaining(`Could not sign out of work. ${file}`),
    );
    expect(error).toHaveProperty(
      "message",
      expect.stringContaining("Run neuve auth remove work again."),
    );
    expect(existsSync(file)).toBe(true);
  });
});

// Named accounts can use different sign-in files, so the path tells the person which one to fix.
test("auth status --check names unusable ChatGPT sign-in files with either runtime", async () => {
  for (const runtime of ["pi", "codex"] as const)
    await withBrokenSignIn(runtime, async (home, file) => {
      const { out } = await capture(() =>
        runAuthCli(["status", "work", "--check"], { home }),
      );
      expect(out).toContain(
        `unknown: check-failed\n  Remove ${file}, then sign in again.`,
      );
    });
});

async function withBrokenSignIn(
  runtime: "pi" | "codex",
  run: (home: string, file: string) => Promise<void>,
) {
  const home = scratch();
  try {
    const args = ["add", "chatgpt", "work"];
    if (runtime === "codex") args.push("--runtime", "codex");
    await capture(() => runAuthCli(args, { home }));
    const account = AccountStore.readAccounts(home).find(
      (entry) => entry.account.name === "work",
    )?.account;
    if (
      account?.credential.kind !== "neuve-sign-in" ||
      !account.credential.folder
    )
      throw new Error("Expected a sign-in folder for work.");
    const file = RouteProvider.OpenAiAuth.authFilePath(
      account.credential.folder,
    );
    writeFileSync(file, "{", { mode: 0o600 });
    await run(home, file);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// Reason: add must create an empty private folder and print a shell-safe command, never credentials.
test("add claude creates an empty 0700 folder and prints the exact login command", async () => {
  const home = scratch();
  try {
    const result = await capture(() =>
      runAuthCli(["add", "claude", "work"], { home }),
    );
    expect(result.value).toBe(0);
    const account = AccountStore.readAccounts(home).find(
      (entry) => entry.account.name === "work",
    )?.account;
    if (
      account?.credential.kind !== "claude-config-folder" ||
      account.credential.folder === undefined
    )
      throw new Error("expected account folder");
    expect(readdirSync(account.credential.folder)).toEqual([]);
    expect(statSync(account.credential.folder).mode & 0o777).toBe(0o700);
    expect(result.out).toBe(
      `CLAUDE_CONFIG_DIR='${account.credential.folder}' claude auth login\n`,
    );
    expect(
      signInCommand({
        kind: "command",
        command: "claude auth login",
        environment: { CLAUDE_CONFIG_DIR: "/scratch/it's a folder/$x`" },
      }),
    ).toBe(
      "CLAUDE_CONFIG_DIR='/scratch/it'\\''s a folder/$x`' claude auth login",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// Reason: list --check must only probe, and saved status reads must start no runtime work.
test("list --check only probes and ordinary list reads saved snapshots", async () => {
  const home = scratch();
  const calls: string[] = [];
  try {
    const runtimes = [fakeRuntime(calls)];
    const result = await capture(async () => {
      await runAuthCli(["add", "claude", "work"], { home, runtimes });
      return runAuthCli(["list", "--check", "--json"], { home, runtimes });
    });
    expect(result.value).toBe(0);
    expect(calls.sort()).toEqual(["probe:claude", "probe:work"]);
    calls.length = 0;
    const saved = await capture(() =>
      runAuthCli(["status", "work", "--json"], { home, runtimes }),
    );
    expect(JSON.parse(saved.out).name).toBe("work");
    expect(calls).toEqual([]);
    const unavailable = await capture(() =>
      runAuthCli(["status", "work", "--check", "--json"], {
        home,
        runtimes: [],
      }),
    );
    expect(JSON.parse(unavailable.out).signIn).toEqual({
      state: "runtime-unavailable",
      reason: "not-registered",
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// Reason: default CLI checks must reach pi's local probe for both default and added accounts.
test("default runtimes check ChatGPT sign-in locally through the store directory", async () => {
  const home = scratch();
  const authDirectory = scratch();
  const previous = process.env.NEUVE_OPENAI_AUTH_DIR;
  process.env.NEUVE_OPENAI_AUTH_DIR = authDirectory;
  try {
    const defaultStatus = await capture(() =>
      runAuthCli(["status", "chatgpt", "--check", "--json"], { home }),
    );
    expect(defaultStatus.value).toBe(0);
    expect(AccountStatus.parse(JSON.parse(defaultStatus.out)).signIn).toEqual({
      state: "not-signed-in",
      hint: {
        kind: "command",
        command: "neuve auth login",
        account: AccountName.parse("chatgpt"),
      },
    });
    const added = await capture(() =>
      runAuthCli(["add", "chatgpt", "work"], { home }),
    );
    expect(added.value).toBe(0);
    const account = AccountStore.readAccounts(home).find(
      (entry) => entry.account.name === "work",
    )?.account;
    if (
      account?.credential.kind !== "neuve-sign-in" ||
      account.credential.folder === undefined
    )
      throw new Error("expected separate ChatGPT folder");
    expect(account.credential.folder).not.toBe(authDirectory);
    expect(readdirSync(account.credential.folder)).toEqual([]);
    const namedStatus = await capture(() =>
      runAuthCli(["status", "work", "--check", "--json"], { home }),
    );
    expect(namedStatus.value).toBe(0);
    expect(AccountStatus.parse(JSON.parse(namedStatus.out)).signIn).toEqual({
      state: "not-signed-in",
      hint: {
        kind: "command",
        command: "neuve auth login",
        account: AccountName.parse("work"),
      },
    });
  } finally {
    if (previous === undefined) delete process.env.NEUVE_OPENAI_AUTH_DIR;
    else process.env.NEUVE_OPENAI_AUTH_DIR = previous;
    rmSync(home, { recursive: true, force: true });
    rmSync(authDirectory, { recursive: true, force: true });
  }
});

// Reason: both runtimes must be registered without starting Claude, and its working folder must use the CLI home.
// Reason: the registry is built for pi runs too, so Claude's private working folder appears only at its first
// session or probe (packages/harness/tests/runtimes.test.ts checks 0700 there), never at build or capabilities.
test("default auth registry exposes capabilities and leaves its home untouched until Claude is used", async () => {
  const home = scratch();
  const executables = scratch();
  const previousPath = process.env.PATH;
  // Reason: Bun's default lookup retains its startup PATH, so pass this test's PATH explicitly.
  const which = Bun.which;
  const lookup = spyOn(Bun, "which").mockImplementation((command, options) =>
    which(command, { PATH: process.env.PATH ?? "", ...options }),
  );
  try {
    // Reason: capabilities only looks up Claude, so a temporary PATH stub avoids an installed executable.
    const stub = join(executables, "claude");
    writeFileSync(stub, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    chmodSync(stub, 0o755);
    process.env.PATH = `${executables}${previousPath === undefined ? "" : `:${previousPath}`}`;
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AccountStore.make(home);
          return yield* Effect.gen(function* () {
            const registry = yield* RuntimeRegistry;
            return {
              claude: (yield* registry.capabilities(
                AccountName.parse("claude"),
              )).ownsLoop,
              chatgpt: (yield* registry.capabilities(
                AccountName.parse("chatgpt"),
              )).ownsLoop,
            };
          }).pipe(
            Effect.provide(authRuntimes({ directory: store.directory, home })),
          );
        }),
      ),
    );
    expect(result).toEqual({ claude: true, chatgpt: false });
    const cwd = join(
      home,
      "Library",
      "Application Support",
      "Neuve",
      "claude-code",
      "work",
    );
    expect(existsSync(cwd)).toBe(false);
  } finally {
    lookup.mockRestore();
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(executables, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

// Reason: Claude's interactive flow owns its bytes; Neuve inherits streams and sees only the final probe.
test("login runs a fake Claude with inherited streams and its own config folder", async () => {
  const home = scratch();
  const calls: string[] = [];
  const oldPath = process.env.PATH;
  const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  try {
    const fake = join(home, "claude");
    const seen = join(home, "seen.json");
    writeFileSync(
      fake,
      `#!${process.execPath}\nawait Bun.write(${JSON.stringify(seen)}, JSON.stringify({ argv: process.argv.slice(2), folder: process.env.CLAUDE_CONFIG_DIR }));\nconsole.log("CLAUDE-PRIVATE-MARKER");\n`,
      { mode: 0o700 },
    );
    chmodSync(fake, 0o700);
    const runtimes = [fakeRuntime(calls)];
    await capture(() =>
      runAuthCli(["add", "claude", "work"], { home, runtimes }),
    );
    const account = AccountStore.readAccounts(home).find(
      (entry) => entry.account.name === "work",
    )?.account;
    if (
      account?.credential.kind !== "claude-config-folder" ||
      account.credential.folder === undefined
    )
      throw new Error("expected folder");
    const hint = {
      kind: "command" as const,
      command: "claude auth login" as const,
      environment: { CLAUDE_CONFIG_DIR: account.credential.folder },
    };
    expect(claudeLoginOptions(hint).stdio).toEqual([
      "inherit",
      "inherit",
      "inherit",
    ]);
    process.env.PATH = `${home}:${oldPath}`;
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    const result = await capture(() =>
      runAuthCli(["login", "work"], { home, runtimes }),
    );
    expect(result.value).toBe(1); // The fake's next probe still reports signed out.
    expect(JSON.parse(readFileSync(seen, "utf8"))).toEqual({
      argv: ["auth", "login"],
      folder: account.credential.folder,
    });
    expect(result.out).not.toContain("CLAUDE-PRIVATE-MARKER");
    expect(calls).toEqual(["probe:work", "probe:work"]);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (tty === undefined) Reflect.deleteProperty(process.stdin, "isTTY");
    else Object.defineProperty(process.stdin, "isTTY", tty);
    rmSync(home, { recursive: true, force: true });
  }
});

// Reason: command-only and already-signed-in paths must never start a sign-in process.
test("login --print prints its hint and signed-in accounts exit successfully", async () => {
  const home = scratch();
  try {
    await capture(() => runAuthCli(["add", "claude", "work"], { home }));
    const printed = await capture(() =>
      runAuthCli(["login", "work", "--print"], {
        home,
        runtimes: [fakeRuntime([])],
      }),
    );
    expect(printed.out).toContain("claude auth login");
    expect(printed.value).toBe(0);
    const signed = await capture(() =>
      runAuthCli(["login", "work"], {
        home,
        runtimes: [fakeRuntime([], true)],
      }),
    );
    expect(signed.value).toBe(0);
    expect(signed.out).toContain("signed-in");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// Reason: the done-when's one command. The path a person sets for the codex account is stored,
// is what the next check uses, and is shown; input that is not a program path, or an account that
// does not find its own program, is refused without writing anything.
test("auth program sets the codex account's program, then shows the check that used it", async () => {
  const home = scratch();
  try {
    const seen: Array<string | undefined> = [];
    const codex: RuntimeShape = {
      ...fakeRuntime([], true),
      kind: "codex",
      probe: (account) =>
        Effect.sync(() => {
          const path = AccountStore.programPath(home, account.name);
          seen.push(path);
          return {
            signIn: { state: "signed-in" as const },
            limits: [],
            checkedAt: new Date().toISOString(),
            ...(path === undefined
              ? {}
              : {
                  program: { path, version: "0.171.0", found: "set" as const },
                }),
            models: [
              {
                id: "main",
                displayName: "Main",
                description: "",
                supportsEffort: true,
                supportedEffortLevels: ["low" as const, "high" as const],
              },
            ],
          };
        }),
    };
    const runtimes = [codex, fakeRuntime([], true)];
    const set = await capture(() =>
      runAuthCli(["program", "codex", "/opt/codex/bin/codex"], {
        home,
        runtimes,
      }),
    );
    expect(set.value).toBe(0);
    expect(seen).toEqual(["/opt/codex/bin/codex"]);
    expect(set.out).toBe(
      "codex  chatgpt-subscription  signed-in\n  program /opt/codex/bin/codex (0.171.0), the path set for this account\n  models main (low, high)\n",
    );
    const unset = await capture(() =>
      runAuthCli(["program", "codex", "--unset"], { home, runtimes }),
    );
    expect(unset.value).toBe(0);
    expect(
      AccountStore.programPath(home, AccountName.parse("codex")),
    ).toBeUndefined();
    for (const args of [
      ["program", "claude", "/opt/x"],
      ["program", "codex"],
      ["program", "codex", "/opt/x", "--unset"],
      // An empty path would resolve to the current folder.
      ["program", "codex", ""],
    ])
      await expect(
        capture(() => runAuthCli(args, { home, runtimes })),
      ).rejects.toThrow();
    expect(existsSync(AccountStore.programsPath(home))).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// Reason: `--find` is the one step that looks for Codex. It must report each program it asked and
// why each was skipped, store the first that answered as Codex and say so only once it is saved,
// and store nothing when none answered. Discovery itself is faked: no program is run.
test("auth program --find reports what it asked, stores what answered, and stores nothing otherwise", async () => {
  const home = scratch();
  try {
    const codex: RuntimeShape = { ...fakeRuntime([], true), kind: "codex" };
    const runtimes = [codex, fakeRuntime([], true)];
    const stranger = { path: "/usr/local/bin/codex", found: "path" as const };
    const app = { path: "/opt/apps/Codex/bin/codex", found: "app" as const };
    const found = await capture(() =>
      runAuthCli(["program", "codex", "--find"], {
        home,
        runtimes,
        findCodex: () =>
          Effect.succeed({
            tried: [
              { candidate: stranger, kind: "unrecognized" as const },
              { candidate: app, kind: "codex" as const, version: "0.171.0" },
            ],
            found: {
              candidate: app,
              kind: "codex" as const,
              version: "0.171.0",
            },
            skippedApps: [
              {
                app: "/opt/apps/Other.app",
                why: "a layout this Neuve does not know",
              },
            ],
            appsLookedFor: true,
          }),
      }),
    );
    expect(found.value).toBe(0);
    expect(found.out.split("\n").slice(0, 6)).toEqual([
      "Looked for Codex:",
      "  /usr/local/bin/codex (on the PATH): did not answer as Codex, skipped",
      "  /opt/apps/Codex/bin/codex (in an installed app): Codex 0.171.0",
      "  /opt/apps/Other.app: a layout this Neuve does not know, skipped",
      "Stored /opt/apps/Codex/bin/codex as codex's program.",
      "codex  chatgpt-subscription  signed-in",
    ]);
    expect(AccountStore.programPath(home, AccountName.parse("codex"))).toBe(
      app.path,
    );
    AccountStore.setProgramPath(home, AccountName.parse("codex"), undefined);
    const none = await capture(() =>
      runAuthCli(["program", "codex", "--find"], {
        home,
        runtimes,
        findCodex: () =>
          Effect.succeed({
            tried: [{ candidate: stranger, kind: "unrecognized" as const }],
            found: undefined,
            skippedApps: [],
            appsLookedFor: false,
          }),
      }),
    );
    expect(none.value).toBe(1);
    expect(none.out).toContain("Found no Codex; nothing was stored.");
    // Off macOS no app is looked for, and the report says so.
    expect(none.out).toContain("No installed app was looked for");
    expect(
      AccountStore.programPath(home, AccountName.parse("codex")),
    ).toBeUndefined();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
