import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Account,
  AccountRejected,
  AccountName,
  DEFAULT_ACCOUNTS,
  SignInRequired,
  TurnLimit,
  signInCommand,
  type SignInHint,
} from "@neuve/runtime";
import { Effect, Exit } from "effect";
import { applicationFolders, inApps } from "../src/program.ts";
import {
  discoverCodex,
  makeRuntime,
  type CodexRuntimeConfig,
} from "../src/runtime.ts";
import { codex, RELEASE_AGENT, SILENT } from "./codex-fake.ts";

const account = DEFAULT_ACCOUNTS.find((a) => a.name === "codex")!;
const folders: string[] = [];
const scratchFolder = () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "codex-runtime-")));
  folders.push(folder);
  return folder;
};
afterEach(() => {
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});
/** An executable file: what is in it never runs, since the fake process service stands in. */
const file = (folder: string, name = "codex") => {
  mkdirSync(folder, { recursive: true });
  const path = join(folder, name);
  writeFileSync(path, "#!/bin/sh\n");
  chmodSync(path, 0o755);
  return path;
};
const models = (cursor?: string) =>
  cursor === undefined
    ? {
        data: [
          {
            id: "other",
            displayName: "Other",
            description: "second",
            isDefault: false,
            hidden: false,
            supportedReasoningEfforts: [
              { reasoningEffort: "low" },
              { reasoningEffort: "ultra" },
            ],
          },
          {
            id: "secret",
            displayName: "Hidden",
            hidden: true,
            isDefault: false,
          },
        ],
        nextCursor: "page-2",
      }
    : {
        data: [
          {
            id: "main",
            displayName: "Main",
            description: "default",
            isDefault: true,
            hidden: false,
            supportedReasoningEfforts: [
              { reasoningEffort: "medium" },
              { reasoningEffort: "high" },
            ],
          },
        ],
        nextCursor: null,
      };
/** Each program answers as Codex unless it is in `strangers`; a signed-in account with two pages of models. */
const fakeWith = (strangers: ReadonlyArray<string> = [], signedOut = false) => {
  const fake = codex((message, process) => {
    if (strangers.includes(process.program)) {
      if (message.method === "initialize")
        process.io.emit("this is not codex\n");
      return SILENT;
    }
    if (message.method === "model/list")
      return models((message.params as { cursor?: string }).cursor);
    if (message.method === "account/rateLimits/read")
      return {
        rateLimits: {
          primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: null },
          secondary: null,
        },
      };
    if (message.method === "account/read" && signedOut)
      return { account: null, requiresOpenaiAuth: true };
    return undefined;
  });
  return fake;
};
const probe = (
  fake: ReturnType<typeof codex>,
  config: CodexRuntimeConfig,
  which: Account = account,
) =>
  Effect.runPromise(
    makeRuntime({ environment: { PATH: "" }, apps: () => [], ...config }).pipe(
      Effect.flatMap((runtime) => runtime.probe(which)),
      Effect.provide(fake.layer),
    ),
  );

// Neuve's sign-in owns the status check and uses a separate home even when Codex reports signed out.
test("Neuve's sign-in probes the catalogue without a Codex login", async () => {
  const home = scratchFolder();
  const program = file(home);
  const fake = fakeWith([], true);
  const named = Account.parse({
    name: "work",
    kind: "chatgpt-subscription",
    runtime: "codex",
    credential: { kind: "neuve-sign-in", folder: join(home, "sign-in") },
  });
  const options: CodexRuntimeConfig = {
    home,
    environment: {
      PATH: "",
      CODEX_HOME: join(home, ".codex"),
      NEUVE_CODEX_ACCESS_TOKEN: "ambient-value",
    },
    programPath: () => program,
    neuveSignIn: {
      accessToken: () =>
        Effect.succeed({
          token: "opaque.fixture.probe",
          expiresAt: Date.now() + 3_600_000,
        }),
      signOut: () => Effect.void,
    },
  };
  const result = await probe(fake, options, named);
  expect(result.signIn).toEqual({
    state: "signed-in",
    credentialSource: "neuve-sign-in",
  });
  expect(result.models?.map(({ id }) => id)).toEqual(["main", "other"]);
  expect(result.limits).toEqual([]);
  const child = fake.current();
  expect(child.env.NEUVE_CODEX_ACCESS_TOKEN).toBeUndefined();
  const managedHome = child.env.CODEX_HOME;
  if (managedHome === undefined)
    throw new Error("expected a Neuve-owned Codex home");
  expect(managedHome).toStartWith(home);
  expect(child.env.CODEX_HOME).not.toBe(join(home, ".codex"));
  expect(child.env.CODEX_HOME).not.toBe(join(home, "sign-in"));
  const keys = await Effect.runPromise(
    makeRuntime(options).pipe(
      Effect.map((runtime) => [
        runtime.continuation(named).key,
        runtime.continuation(account).key,
      ]),
      Effect.provide(fake.layer),
    ),
  );
  expect(keys).toEqual([managedHome, "default"]);
  expect(child.io.written.map(({ method }) => method)).toEqual([
    "initialize",
    "initialized",
    "model/list",
    "model/list",
  ]);
  const policy = {
    systemPrompt: "",
    tools: [],
    approvalPolicy: "allow" as const,
    turnLimit: TurnLimit.parse(1),
    folder: home,
  };
  const open = (config: CodexRuntimeConfig) =>
    Effect.runPromise(
      Effect.scoped(
        makeRuntime(config).pipe(
          Effect.flatMap((runtime) =>
            runtime.openSession(named, policy, { kind: "new" }),
          ),
          Effect.map((session) => session.nativeSessionId),
          Effect.provide(fake.layer),
        ),
      ),
    );
  expect(await open(options)).toBe("thread-1");
  const session = fake.current();
  expect(session.env.CODEX_HOME).toBe(child.env.CODEX_HOME);
  expect(session.env.NEUVE_CODEX_ACCESS_TOKEN).toBe("opaque.fixture.probe");
  expect(session.commandEnvironment().NEUVE_CODEX_ACCESS_TOKEN).toBeUndefined();
  expect(session.args).not.toContain("--listen");
  expect(session.args).toEqual(
    expect.arrayContaining([
      'model_provider="openai_chatgpt_plan"',
      'model_providers.openai_chatgpt_plan.name="ChatGPT plan"',
      'model_providers.openai_chatgpt_plan.base_url="https://api.openai.com/v1"',
      'model_providers.openai_chatgpt_plan.env_key="NEUVE_CODEX_ACCESS_TOKEN"',
      'model_providers.openai_chatgpt_plan.wire_api="responses"',
      "model_providers.openai_chatgpt_plan.requires_openai_auth=false",
      "model_providers.openai_chatgpt_plan.supports_websockets=false",
    ]),
  );
  expect(
    session.io.written.some(({ method }) => method === "account/read"),
  ).toBe(false);

  const hint = {
    kind: "command",
    command: "neuve auth login",
    account: named.name,
  } as const;
  for (const error of [
    new SignInRequired({ account: named.name, hint }),
    new AccountRejected({ account: named.name, hint, reason: "other" }),
  ]) {
    await expect(
      open({
        ...options,
        neuveSignIn: {
          accessToken: () => Effect.fail(error),
          signOut: () => Effect.void,
        },
      }),
    ).rejects.toMatchObject({ _tag: error._tag, hint });
  }
});

// Why: the account's states table (the hand-over's first table). Each state is detected from what
// the candidates answer, in the probe's order, and carries its fix; none is an error.
describe("the account's states", () => {
  test("not installed: nothing to ask, no program started, and the fix names the install and the setting", async () => {
    const fake = fakeWith();
    const status = await probe(fake, {});
    expect(fake.processes).toHaveLength(0);
    expect(status.signIn).toMatchObject({
      state: "runtime-unavailable",
      reason: "not-installed",
      program: "Codex",
    });
    const fix = (status.signIn as { fix: string }).fix;
    expect(fix).toContain("npm install -g @openai/codex");
    expect(fix).toContain("neuve auth program codex <path>");
  });

  test("a check asks only the PATH's first codex: never a later one, never an app", async () => {
    const root = scratchFolder();
    const stranger = file(join(root, "npm"));
    const later = file(join(root, "later"));
    const app = file(join(root, "app"));
    const fake = fakeWith([stranger]);
    const status = await probe(fake, {
      environment: { PATH: `${join(root, "npm")}:${join(root, "later")}` },
      apps: () => [app],
    });
    expect(fake.processes.map((p) => p.program)).toEqual([stranger]);
    expect(status.signIn).toMatchObject({
      state: "runtime-unavailable",
      reason: "unrecognized-program",
    });
    expect((status.signIn as { fix: string }).fix).toContain(
      "neuve auth program codex --find",
    );
    expect(later).toBeString();
  });

  // Why: setup runs discovery on every setup, so a path already stored (by an earlier setup or the
  // person) must be asked first and stop the search, and doctor must start only what run time would.
  test("discovery asks a stored path first and stops there; scan: false asks only that", async () => {
    const root = scratchFolder();
    const stranger = file(join(root, "npm"));
    const app = file(join(root, "app"));
    const fake = fakeWith([stranger]);
    const found = await Effect.runPromise(
      discoverCodex({
        environment: { PATH: join(root, "npm") },
        apps: () => [app],
        setting: app,
      }).pipe(Effect.provide(fake.layer)),
    );
    expect(found.tried.map((t) => [t.candidate.found, t.kind])).toEqual([
      ["set", "codex"],
    ]);
    expect(fake.processes.map((p) => p.program)).toEqual([app]);
    const gone = join(root, "gone", "codex");
    const checked = await Effect.runPromise(
      discoverCodex({
        environment: { PATH: join(root, "npm") },
        apps: () => {
          throw new Error("doctor must not look in the apps");
        },
        setting: gone,
        scan: false,
      }).pipe(Effect.provide(fakeWith([stranger]).layer)),
    );
    expect(checked.tried.map((t) => [t.candidate.path, t.kind])).toEqual([
      [gone, "missing"],
    ]);
    expect(checked.appsLookedFor).toBe(false);
  });

  test("discovery asks every PATH codex, then the apps, and returns the first that answers as Codex", async () => {
    const root = scratchFolder();
    const stranger = file(join(root, "npm"));
    const app = file(join(root, "app"));
    const fake = fakeWith([stranger]);
    const found = await Effect.runPromise(
      discoverCodex({
        environment: { PATH: join(root, "npm") },
        apps: () => [app],
      }).pipe(Effect.provide(fake.layer)),
    );
    expect(found.tried.map((t) => [t.candidate.found, t.kind])).toEqual([
      ["path", "unrecognized"],
      ["app", "codex"],
    ]);
    expect(found.found).toMatchObject({
      candidate: { path: app, found: "app" },
      version: "0.171.0-alpha.13",
    });
    // The candidates were asked nothing of a session: no token, and the person's additions off.
    for (const p of fake.processes) {
      expect(p.env.NEUVE_CODEX_TOOL_TOKEN).toBeUndefined();
      expect(p.clean).toBe(true);
    }
  });

  test("only files that do not answer as Codex: the account says so, naming each", async () => {
    const root = scratchFolder();
    const stranger = file(join(root, "npm"));
    const status = await probe(fakeWith([stranger]), {
      environment: { PATH: join(root, "npm") },
    });
    expect(status.signIn).toMatchObject({
      state: "runtime-unavailable",
      reason: "unrecognized-program",
    });
    expect((status.signIn as { fix: string }).fix).toContain(
      `Found ${stranger}, which did not answer as Codex`,
    );
  });

  test("a version marked broken: the account says which, with the release this Neuve was built for", async () => {
    const root = scratchFolder();
    const program = file(root);
    const status = await probe(fakeWith(), {
      programPath: () => program,
      broken: [RELEASE_AGENT.split(/[/ ]/)[1]!],
    });
    expect(status.signIn).toMatchObject({
      state: "runtime-unavailable",
      reason: "unsupported-version",
    });
    expect((status.signIn as { fix: string }).fix).toContain(
      "0.171.0-alpha.13",
    );
  });

  test("signed out: Codex's own sign-in, with the account's home when it names one", async () => {
    const root = scratchFolder();
    const program = file(root);
    const named = AccountName.parse("second");
    const status = await probe(
      fakeWith([], true),
      { programPath: () => program },
      {
        name: named,
        kind: "chatgpt-subscription",
        runtime: "codex",
        credential: { kind: "codex-home", folder: "/second-home" },
      },
    );
    expect(status.signIn).toEqual({
      state: "not-signed-in",
      // Signed in by the program the account uses, not a bare `codex` that may be another one.
      hint: {
        kind: "command",
        command: "codex login",
        environment: { CODEX_HOME: "/second-home" },
        program,
      },
    });
    expect(signInCommand((status.signIn as { hint: SignInHint }).hint)).toBe(
      `CODEX_HOME='/second-home' '${program}' login`,
    );
  });

  test("the path the person set is asked first, used and shown; the PATH's is not started", async () => {
    const root = scratchFolder();
    const set = file(join(root, "set"));
    file(join(root, "bin"));
    const fake = fakeWith();
    const status = await probe(fake, {
      programPath: () => set,
      environment: { PATH: join(root, "bin") },
    });
    expect(fake.processes.map((p) => p.program)).toEqual([set]);
    expect(status.program).toMatchObject({ path: set, found: "set" });
  });

  test("a set path where nothing runs is the account's state: no other program is run in its place", async () => {
    const root = scratchFolder();
    const app = file(join(root, "app"));
    const fake = fakeWith();
    const status = await probe(fake, {
      programPath: () => join(root, "gone"),
      apps: () => [app],
    });
    expect(fake.processes).toHaveLength(0);
    expect(status.signIn).toMatchObject({
      state: "runtime-unavailable",
      reason: "not-installed",
    });
    expect((status.signIn as { fix: string }).fix).toContain(
      `nothing runs at ${join(root, "gone")}`,
    );
  });
});

// Why: models and effort levels come from Codex alone; none is written in code.
test("models: every page read, the default first, hidden ones and unknown effort levels left out", async () => {
  const root = scratchFolder();
  const status = await probe(fakeWith(), { programPath: () => file(root) });
  expect(status.models).toEqual([
    {
      id: "main",
      displayName: "Main",
      description: "default",
      supportsEffort: true,
      supportedEffortLevels: ["medium", "high"],
    },
    {
      id: "other",
      displayName: "Other",
      description: "second",
      supportsEffort: true,
      supportedEffortLevels: ["low"],
    },
  ]);
  expect(status.limits).toEqual([
    expect.objectContaining({ window: "five-hour", utilization: 0.25 }),
  ]);
});

// Why: a missing program is the account's state, never its capabilities, so the account still lists
// and its chat fails with that state; and a session cannot open without the chat's folder.
test("capabilities never depend on the program, and a session needs the chat's folder", async () => {
  const fake = fakeWith();
  await Effect.runPromise(
    Effect.gen(function* () {
      const runtime = yield* makeRuntime({
        environment: { PATH: "" },
        apps: () => [],
      });
      expect((yield* runtime.capabilities(account)).ownsLoop).toBe(true);
      const policy = {
        systemPrompt: "",
        tools: [],
        approvalPolicy: "allow" as const,
        turnLimit: TurnLimit.parse(1),
      };
      const noFolder = yield* Effect.scoped(
        runtime.openSession(account, policy, { kind: "new" }),
      ).pipe(Effect.exit);
      expect(JSON.stringify(noFolder)).toContain("protocol-error");
      const missing = yield* Effect.scoped(
        runtime.openSession(
          account,
          { ...policy, folder: "/work" },
          { kind: "new" },
        ),
      ).pipe(Effect.exit);
      expect(
        Exit.isFailure(missing) && JSON.stringify(missing.cause),
      ).toContain("not-installed");
    }).pipe(Effect.provide(fake.layer)),
  );
});

// Why: the app is found by its identifier and read through its own manifest, by T3 Code's rule.
describe("OpenAI's apps", () => {
  const app = (
    folder: string,
    name: string,
    identifier: string,
    manifest: object | undefined,
    entry = "bin/codex",
  ) => {
    const contents = join(folder, `${name}.app`, "Contents");
    mkdirSync(join(contents, "Resources", "codex", "bin"), { recursive: true });
    writeFileSync(
      join(contents, "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string></dict></plist>`,
    );
    if (manifest !== undefined)
      writeFileSync(
        join(contents, "Resources", "codex", "codex-package.json"),
        JSON.stringify(manifest),
      );
    return file(
      join(contents, "Resources", "codex", entry, ".."),
      entry.split("/").at(-1),
    );
  };
  /** The apps of every test below, in one folder. */
  const apps = () => {
    const folder = scratchFolder();
    const good = app(folder, "Desktop", "com.openai.codex", {
      layoutVersion: 1,
      entrypoint: "bin/codex",
    });
    app(folder, "Other", "com.example.other", {
      layoutVersion: 1,
      entrypoint: "bin/codex",
    });
    app(folder, "Later", "com.openai.codex", {
      layoutVersion: 2,
      entrypoint: "bin/codex",
    });
    app(
      folder,
      "Outside",
      "com.openai.codex",
      { layoutVersion: 1, entrypoint: "codex" },
      "codex",
    );
    app(folder, "Bare", "com.openai.codex", undefined);
    return { folder, good };
  };
  /** Reads the identifier from the fixtures' XML property lists, on any system. */
  const fromXml = (app: string) =>
    /<key>CFBundleIdentifier<\/key><string>([^<]+)<\/string>/.exec(
      readFileSync(join(app, "Contents", "Info.plist"), "utf8"),
    )?.[1];
  const read = (
    folder: string,
    reader?: (app: string) => string | undefined,
  ) => {
    const skipped: string[] = [];
    const found = inApps(
      [folder, join(folder, "missing")],
      (path, why) => skipped.push(`${path}: ${why}`),
      reader,
    );
    return { found, skipped };
  };

  // On every system: the rule for the manifest, with the property list read by a stand-in.
  test("the program the manifest declares, by identifier; no manifest, an unknown layout and an entry outside bin are reported and skipped", () => {
    const { folder, good } = apps();
    expect(read(folder, fromXml)).toEqual({
      found: [good],
      skipped: [
        `${join(folder, "Bare.app")}: it has no manifest naming its Codex`,
        `${join(folder, "Later.app")}: a layout this Neuve does not know`,
        `${join(folder, "Outside.app")}: a layout this Neuve does not know`,
      ],
    });
  });

  // On macOS only: the same apps, read through the system's own `plutil`.
  test.if(process.platform === "darwin")(
    "on macOS the property list is read by plutil, with the same result",
    () => {
      const { folder, good } = apps();
      expect(read(folder).found).toEqual([good]);
    },
  );

  // Off macOS: no app is looked for and no macOS tool is started, and the person is told why.
  test("off macOS no app is looked for, no macOS tool runs, and the fix does not point at one", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      const { folder } = apps();
      expect(applicationFolders("/home/someone")).toEqual([]);
      // The default reader starts nothing: a found manifest is still not an app here.
      expect(read(folder).found).toEqual([]);
      const root = scratchFolder();
      const stranger = file(join(root, "npm"));
      const fake = fakeWith([stranger]);
      const found = await Effect.runPromise(
        discoverCodex({ environment: { PATH: join(root, "npm") } }).pipe(
          Effect.provide(fake.layer),
        ),
      );
      expect(found.appsLookedFor).toBe(false);
      expect(found.tried.map((t) => t.candidate.found)).toEqual(["path"]);
      expect(found.found).toBeUndefined();
      const status = await probe(fakeWith([stranger]), {
        environment: { PATH: join(root, "npm") },
      });
      const fix = (status.signIn as { fix: string }).fix;
      expect(fix).toContain("--find to look for Codex everywhere on the PATH");
      expect(fix).not.toContain("installed apps");
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });
});

// Why: input handling. An answer to the account or model question that does not decode is a
// failed check, a state, never a defect that would stop a check of every account.
test("an account answer that does not decode is a failed check; models that do not decode are left out", async () => {
  const root = scratchFolder();
  const program = file(root);
  const garbled = codex((message) =>
    message.method === "account/read" ? { account: 42 } : undefined,
  );
  const failed = await probe(garbled, { programPath: () => program });
  expect(failed.signIn).toEqual({ state: "unknown", reason: "check-failed" });
  const noModels = codex((message) =>
    message.method === "model/list"
      ? { data: "none" }
      : message.method === "account/rateLimits/read"
        ? { rateLimits: { primary: null, secondary: null } }
        : undefined,
  );
  const status = await probe(noModels, { programPath: () => program });
  expect(status.signIn).toEqual({ state: "signed-in" });
  expect(status.models).toBeUndefined();
});

// Why: a path set or unset from the CLI must be used by a workspace already running, whose
// runtime remembers the program it found.
test("the program a session opens on follows the person's setting, not the last one found", async () => {
  const root = scratchFolder();
  const first = file(join(root, "first"));
  const second = file(join(root, "second"));
  let setting: string | undefined = first;
  const fake = fakeWith();
  const policy = {
    systemPrompt: "",
    tools: [],
    approvalPolicy: "allow" as const,
    turnLimit: TurnLimit.parse(1),
    folder: "/work",
  };
  await Effect.runPromise(
    Effect.gen(function* () {
      const runtime = yield* makeRuntime({
        environment: { PATH: "" },
        apps: () => [],
        programPath: () => setting,
      });
      yield* Effect.scoped(
        runtime.openSession(account, policy, { kind: "new" }),
      );
      setting = second;
      const before = fake.processes.length;
      yield* Effect.scoped(
        runtime.openSession(account, policy, { kind: "new" }),
      );
      expect(
        fake.processes.slice(before).every((p) => p.program === second),
      ).toBe(true);
      expect(
        fake.processes.slice(0, before).every((p) => p.program === first),
      ).toBe(true);
    }).pipe(Effect.provide(fake.layer)),
  );
});

// Why: input handling. A file of program paths Neuve cannot read is the account's state, with its
// fix, never a defect that would stop a check of every account.
test("an unreadable program setting is a state with its fix, and no program is run", async () => {
  const fake = fakeWith();
  const status = await probe(fake, {
    programPath: () => {
      throw new Error("programs.json is not a valid Neuve account file.");
    },
  });
  expect(fake.processes).toHaveLength(0);
  expect(status.signIn).toMatchObject({
    state: "runtime-unavailable",
    reason: "start-failed",
  });
  expect((status.signIn as { fix: string }).fix).toContain(
    "programs.json is not a valid Neuve account file.",
  );
});
