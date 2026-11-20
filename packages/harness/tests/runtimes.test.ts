import { afterAll, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import {
  Account,
  AccountName,
  AccountStatus,
  CapabilityUnsupported,
  DEFAULT_ACCOUNTS,
  RuntimeRegistry,
  RuntimeUnavailable,
  TurnLimit,
  inMemoryAccountDirectoryLayer,
  runtimeRegistryLayer,
  type SessionPolicy,
} from "@neuve/runtime";
import { Effect, Layer, type Scope } from "effect";
import { authFilePath, readAuth, writeAuth } from "../src/openai-auth.ts";
import { piStatusRuntime } from "../src/pi/status-runtime.ts";
import { harnessRuntimes } from "../src/runtimes.ts";
import { harnessRuntimes as publicHarnessRuntimes } from "@neuve/harness/runtimes";

const scratch = mkdtempSync(join(tmpdir(), "neuve-runtimes-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const folder = () => mkdtempSync(join(scratch, "signin-"));
const name = AccountName.parse;
const policy: SessionPolicy = {
  systemPrompt: "test",
  tools: [],
  turnLimit: TurnLimit.parse(1),
  approvalPolicy: "allow",
};
const failure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.match({
      onFailure: (error) => error,
      onSuccess: () => "unexpected success",
    }),
  );
const run = <A, E>(
  effect: Effect.Effect<A, E, RuntimeRegistry | Scope.Scope>,
  options: Parameters<typeof piStatusRuntime>[0] & {
    accountDirectory?: ReturnType<typeof inMemoryAccountDirectoryLayer>;
  } = {},
) =>
  Effect.runPromise(
    Effect.scoped(effect).pipe(
      Effect.provide(harnessRuntimes({ claude: false, ...options })),
    ),
  );
const probe = (account: string) =>
  Effect.flatMap(RuntimeRegistry, (registry) => registry.probe(name(account)));
// These reproductions change process-wide auth selection or seal the environment.
// Isolate them so only synthetic keys and scratch sign-in folders are reachable.
function boundary(script: string, environment: Record<string, string> = {}) {
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--no-env-file",
      "--eval",
      `
        import { Effect } from ${JSON.stringify(import.meta.resolve("effect"))};
        import { Account, AccountName, AccountStore, RuntimeRegistry, inMemoryAccountDirectoryLayer }
          from ${JSON.stringify(import.meta.resolve("@neuve/runtime"))};
        import { harnessRuntimes, workerRuntimeOptions, defaultClaudeWorkingFolder }
          from ${JSON.stringify(new URL("../src/runtimes.ts", import.meta.url).href)};
        const probe = (account, options = {}) => Effect.runPromise(
          Effect.flatMap(RuntimeRegistry, registry => registry.probe(AccountName.parse(account)))
            .pipe(Effect.provide(harnessRuntimes({ claude: false, ...options })))
        );
        ${script}
      `,
    ],
    {
      env: {
        HOME: scratch,
        XDG_CONFIG_HOME: scratch,
        TMPDIR: scratch,
        BUN_TMPDIR: scratch,
        NEUVE_MODE: "check",
        ...environment,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    },
  );
  expect(child.stderr.toString()).toBe("");
  expect(child.exitCode).toBe(0);
  return JSON.parse(child.stdout.toString());
}
// Capabilities require an executable file. Folder tests forbid executing it or any SDK child.
function claudeBoundary(
  script: string,
  environment: Record<string, string> = {},
) {
  const executable = join(folder(), "not-a-program");
  writeFileSync(executable, "not a Claude program\n", { mode: 0o700 });
  return boundary(
    `
      import * as childProcess from "node:child_process";
      import { spyOn } from "bun:test";
      const executable = ${JSON.stringify(executable)};
      const refuseChild = () => { throw new Error("Claude child forbidden in folder tests"); };
      spyOn(childProcess, "spawn").mockImplementation(refuseChild);
      spyOn(Bun, "spawn").mockImplementation(refuseChild);
      ${script}
    `,
    { PATH: "", ...environment },
  );
}
const issuer = "https://fake-issuer.invalid";
function fakeSignIn(
  directory: string,
  email: string | null = "fake@example.invalid",
) {
  writeAuth(directory, {
    version: 1,
    issuer,
    hostId: "urn:uuid:00000000-0000-0000-0000-000000000000",
    registration: {
      clientId: "fake-client",
      ...(email === null ? {} : { email }),
    },
    session: {
      accessToken: "fake-access-secret",
      refreshToken: "fake-refresh-secret",
      idToken: "fake-id-secret",
      expiresAt: Date.now() + 3_600_000,
      refreshIssuedAt: new Date().toISOString(),
      scopes: ["chatgpt.tokens.use.direct"],
    },
  });
}

test("pi cannot open sessions and capabilities need no credentials, so generation stays on its existing path", async () => {
  let reads = 0;
  const environment = Object.defineProperty({}, "ANTHROPIC_API_KEY", {
    get() {
      reads += 1;
      throw new Error("must not read credentials");
    },
  });
  const result = await run(
    Effect.gen(function* () {
      const registry = yield* RuntimeRegistry;
      const capabilities = yield* registry.capabilities(name("chatgpt"));
      const refused = [];
      for (const account of ["chatgpt", "anthropic"])
        refused.push(
          yield* failure(registry.openSession(name(account), policy)),
        );
      return { capabilities, refused };
    }),
    { environment, auth: { directory: folder() } },
  );
  expect(result.capabilities).toEqual({
    ownsLoop: false,
    toolEndsTurn: false,
    resumeInTurn: false,
    perMessageUsage: false,
    resume: false,
    fork: false,
    interrupt: false,
    modelSwitchInSession: false,
    structuredOutput: false,
    steering: false,
    approvals: false,
    perRequestTelemetry: false,
    byteExactCapture: false,
    nativeToolServer: false,
    statusProbe: true,
    internalRetries: false,
  });
  expect(result.refused).toEqual(
    ["chatgpt", "anthropic"].map(
      (account) =>
        new CapabilityUnsupported({
          account: name(account),
          capability: "ownsLoop",
        }),
    ),
  );
  expect(reads).toBe(0);

  const runtime = piStatusRuntime();
  const open = spyOn(runtime, "openSession");
  try {
    const refused = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* RuntimeRegistry;
          return yield* failure(registry.openSession(name("chatgpt"), policy));
        }),
      ).pipe(
        Effect.provide(
          runtimeRegistryLayer([runtime]).pipe(
            Layer.provide(inMemoryAccountDirectoryLayer(DEFAULT_ACCOUNTS)),
          ),
        ),
      ),
    );
    expect(refused).toEqual(
      new CapabilityUnsupported({
        account: name("chatgpt"),
        capability: "ownsLoop",
      }),
    );
    expect(open).not.toHaveBeenCalled();
    const account = DEFAULT_ACCOUNTS.find(
      (account) => account.name === "chatgpt",
    );
    if (account === undefined) throw new Error("missing fixture");
    expect(
      await Effect.runPromise(
        Effect.scoped(
          failure(runtime.openSession(account, policy, { kind: "new" })),
        ),
      ),
    ).toEqual(refused);
  } finally {
    open.mockRestore();
  }
});

for (const kind of ["anthropic-api-key", "openai-api-key"] as const) {
  for (const reference of [
    { kind: "environment", variable: "FAKE_KEY" },
    { kind: "vault", entry: "FAKE_KEY" },
  ] as const) {
    test(`${kind} probes ${reference.kind} presence without exposing the key, so worker vault variables and environment references agree`, async () => {
      const account = Account.parse({
        name: "fake-key",
        kind,
        runtime: "pi",
        credential: reference,
      });
      const accountDirectory = inMemoryAccountDirectoryLayer([account]);
      for (const value of [undefined, "", " \t", "fake-private-api-key"]) {
        const before = Date.now();
        const result = await run(probe(account.name), {
          accountDirectory,
          environment: { FAKE_KEY: value },
        });
        expect(AccountStatus.safeParse(result).success).toBe(true);
        expect(result.signIn).toEqual(
          value?.trim()
            ? { state: "signed-in", credentialSource: reference.kind }
            : {
                state: "not-signed-in",
                hint: { kind: "settings", entry: "accounts" },
              },
        );
        expect(result.limits).toEqual([]);
        expect(Date.parse(result.checkedAt)).toBeGreaterThanOrEqual(before);
        expect(Date.parse(result.checkedAt)).toBeLessThanOrEqual(Date.now());
        expect(JSON.stringify(result)).not.toContain("fake-private-api-key");
      }
      if (kind === "anthropic-api-key") {
        const value = "  sk-ant-oat-fake-subscription-secret  ";
        const result = await run(probe(account.name), {
          accountDirectory,
          environment: { FAKE_KEY: value },
        });
        expect(result.signIn).toEqual({
          state: "credential-rejected",
          reason: "other",
          hint: { kind: "settings", entry: "accounts" },
        });
        expect(JSON.stringify(result)).not.toContain(value.trim());
      }
    });
  }
}

test("a leasing worker agrees with route preflight without running the command or reading local sign-in for email", () => {
  const directory = folder();
  const command = join(directory, "fake-lease");
  writeFileSync(command, '#!/bin/sh\necho run > "$0.ran"\nexit 1\n', {
    mode: 0o700,
  });
  const result = boundary(
    `
      import { writeFileSync, mkdirSync } from "node:fs";
      import { credentialPresent } from ${JSON.stringify(new URL("../src/route-provider.ts", import.meta.url).href)};
      import { SOL_ROUTE } from ${JSON.stringify(new URL("../src/route.ts", import.meta.url).href)};
      import { authDirectory, authFilePath } from ${JSON.stringify(new URL("../src/openai-auth.ts", import.meta.url).href)};
      const admitted = credentialPresent(SOL_ROUTE);
      const empty = await probe("chatgpt");
      // A malformed local file proves that a command-backed check never reads it.
      const local = authDirectory();
      mkdirSync(local, { recursive: true });
      writeFileSync(authFilePath(local), "fake-private-invalid-file", { mode: 0o600 });
      const unread = await probe("chatgpt");
      const named = Account.parse({ name: "named-chatgpt", kind: "chatgpt-subscription", runtime: "pi",
        credential: { kind: "neuve-sign-in", folder: ${JSON.stringify(directory)} } });
      const namedStatus = await probe(named.name, { accountDirectory: inMemoryAccountDirectoryLayer([named]) });
      console.log(JSON.stringify({ admitted, empty: empty.signIn, unread: unread.signIn, named: namedStatus.signIn }));
    `,
    { XDG_CONFIG_HOME: directory, NEUVE_OPENAI_TOKEN_COMMAND: command },
  );
  expect(result).toEqual({
    admitted: true,
    empty: { state: "signed-in", credentialSource: "neuve-sign-in" },
    unread: { state: "signed-in", credentialSource: "neuve-sign-in" },
    named: {
      state: "not-signed-in",
      hint: {
        kind: "command",
        command: "neuve auth login",
        account: "named-chatgpt",
      },
    },
  });
  expect(existsSync(`${command}.ran`)).toBe(false);
});

test("a sealed worker supplies vault presence through the resolver when its environment no longer has the key", () => {
  const result = boundary(
    `
      import { key, seal } from ${JSON.stringify(new URL("../../../apps/neuve-host/src/keys.ts", import.meta.url).href)};
      // The injected synthetic key resolves before any Keychain read is needed.
      let keychainReads = 0;
      Bun.secrets = { ...Bun.secrets, get: async () => { keychainReads += 1; throw new Error("must not prompt"); } };
      seal();
      const account = Account.parse({ name: "fake-vault", kind: "openai-api-key", runtime: "pi",
        credential: { kind: "vault", entry: "FAKE_CONTRACT_KEY" } });
      const seen = [];
      const status = await probe(account.name, {
        accountDirectory: inMemoryAccountDirectoryLayer([account]),
        keyPresence: async reference => {
          seen.push(reference);
          return await key(reference.entry) ? "present" : "absent";
        }
      });
      console.log(JSON.stringify({ workerCanResolve: (await key("FAKE_CONTRACT_KEY")) === "synthetic-worker-key",
        processEnvironmentHasKey: process.env.FAKE_CONTRACT_KEY !== undefined, signIn: status.signIn, seen, keychainReads }));
    `,
    { FAKE_CONTRACT_KEY: "synthetic-worker-key" },
  );
  expect(result).toEqual({
    workerCanResolve: true,
    processEnvironmentHasKey: false,
    signIn: { state: "signed-in", credentialSource: "vault" },
    seen: [{ kind: "vault", entry: "FAKE_CONTRACT_KEY" }],
    keychainReads: 0,
  });
  expect(JSON.stringify(result)).not.toContain("synthetic-worker-key");
});

for (const reference of [
  { kind: "environment", variable: "FAKE_KEY" },
  { kind: "vault", entry: "FAKE_KEY" },
] as const) {
  test(`an injected ${reference.kind} resolver owns presence and subscription-token classification without exposing values`, async () => {
    const account = Account.parse({
      name: "fake-key",
      kind: "anthropic-api-key",
      runtime: "pi",
      credential: reference,
    });
    const accountDirectory = inMemoryAccountDirectoryLayer([account]);
    for (const presence of [
      "present",
      "absent",
      "subscription-token",
    ] as const) {
      const seen: Array<typeof account.credential> = [];
      const result = await run(probe(account.name), {
        accountDirectory,
        environment: {},
        keyPresence: async (reference) => {
          seen.push(reference);
          return presence;
        },
      });
      expect(seen).toEqual([reference]);
      expect(result.signIn).toEqual(
        presence === "present"
          ? { state: "signed-in", credentialSource: reference.kind }
          : presence === "absent"
            ? {
                state: "not-signed-in",
                hint: { kind: "settings", entry: "accounts" },
              }
            : {
                state: "credential-rejected",
                reason: "other",
                hint: { kind: "settings", entry: "accounts" },
              },
      );
    }
  });

  test(`a throwing or rejecting ${reference.kind} resolver gives check-failed without provider text`, async () => {
    const account = Account.parse({
      name: "fake-key",
      kind: "openai-api-key",
      runtime: "pi",
      credential: reference,
    });
    for (const keyPresence of [
      () => {
        throw new Error("fake-private-provider-error");
      },
      async () => {
        throw new Error("fake-private-provider-error");
      },
    ]) {
      const result = await run(probe(account.name), {
        accountDirectory: inMemoryAccountDirectoryLayer([account]),
        keyPresence,
      });
      expect(result.signIn).toEqual({
        state: "unknown",
        reason: "check-failed",
      });
      expect(AccountStatus.safeParse(result).success).toBe(true);
      expect(JSON.stringify(result)).not.toContain(
        "fake-private-provider-error",
      );
    }
  });
}

test("ChatGPT probes local sign-in and plan permission without fetching, so checking status never signs in or refreshes", async () => {
  const directory = folder();
  let requests = 0;
  const fetcher: typeof fetch = Object.assign(
    async () => {
      requests += 1;
      throw new Error("must not fetch");
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  const options = {
    environment: {},
    auth: { directory, issuer, fetch: fetcher },
  };
  expect((await run(probe("chatgpt"), options)).signIn).toEqual({
    state: "not-signed-in",
    hint: {
      kind: "command",
      command: "neuve auth login",
      account: name("chatgpt"),
    },
  });
  fakeSignIn(directory);
  const result = await run(probe("chatgpt"), options);
  expect(result.signIn).toEqual({
    state: "signed-in",
    credentialSource: "neuve-sign-in",
    email: "fake@example.invalid",
  });
  for (const value of [
    "fake-access-secret",
    "fake-refresh-secret",
    "fake-id-secret",
  ])
    expect(JSON.stringify(result)).not.toContain(value);
  fakeSignIn(directory, null);
  expect((await run(probe("chatgpt"), options)).signIn).toEqual({
    state: "signed-in",
    credentialSource: "neuve-sign-in",
  });
  const stored = readAuth(directory);
  if (stored?.session === undefined) throw new Error("missing fake sign-in");
  writeAuth(directory, {
    ...stored,
    session: { ...stored.session, scopes: [] },
  });
  expect((await run(probe("chatgpt"), options)).signIn.state).toBe(
    "not-signed-in",
  );
  writeFileSync(authFilePath(directory), "fake-private-invalid-file");
  const failed = await run(probe("chatgpt"), options);
  expect(failed.signIn).toEqual({ state: "unknown", reason: "check-failed" });
  expect(JSON.stringify(failed)).not.toContain("fake-private-invalid-file");
  expect(JSON.stringify(failed)).not.toContain(directory);
  expect(requests).toBe(0);
});

test("continuation identifies only credential references, so aliases share sessions without carrying credential values", async () => {
  const directory = folder();
  const references = [
    { kind: "environment", variable: "FAKE_KEY" },
    { kind: "vault", entry: "FAKE_KEY" },
    { kind: "neuve-sign-in" },
    { kind: "neuve-sign-in", folder: directory },
  ] as const;
  const accounts = references.flatMap((credential, index) =>
    [0, 1].map((alias) =>
      Account.parse({
        name: `account-${index}-${alias}`,
        runtime: "pi",
        kind:
          credential.kind === "neuve-sign-in"
            ? "chatgpt-subscription"
            : "openai-api-key",
        credential,
      }),
    ),
  );
  const identities = await run(
    Effect.gen(function* () {
      const registry = yield* RuntimeRegistry;
      return yield* Effect.forEach(accounts, (account) =>
        registry.continuation(account.name),
      );
    }),
    {
      accountDirectory: inMemoryAccountDirectoryLayer(accounts),
      environment: { FAKE_KEY: "fake-continuation-secret" },
    },
  );
  expect(identities).toEqual(
    references.flatMap((reference) => {
      const referenceName =
        reference.kind === "environment"
          ? reference.variable
          : reference.kind === "vault"
            ? reference.entry
            : "folder" in reference
              ? reference.folder
              : "default";
      return [0, 1].map(() => ({
        runtime: "pi",
        key: JSON.stringify([reference.kind, referenceName]),
      }));
    }),
  );
  expect(new Set(identities.map((identity) => identity.key)).size).toBe(4);
  expect(JSON.stringify(identities)).not.toContain("fake-continuation-secret");
});

test("ChatGPT sign-out clears the named folder through auth while key sign-out does nothing, so account removal respects credential ownership", async () => {
  const directory = folder();
  const other = folder();
  fakeSignIn(directory);
  fakeSignIn(other);
  const account = Account.parse({
    name: "named-chatgpt",
    kind: "chatgpt-subscription",
    runtime: "pi",
    credential: { kind: "neuve-sign-in", folder: directory },
  });
  const keyAccounts = ["anthropic-api-key", "openai-api-key"].flatMap((kind) =>
    [
      { kind: "environment", variable: "FAKE_KEY" },
      { kind: "vault", entry: "FAKE_KEY" },
    ].map((credential) =>
      Account.parse({
        name: `${kind}-${credential.kind}`,
        kind,
        runtime: "pi",
        credential,
      }),
    ),
  );
  const requests: string[] = [];
  const fetcher: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/.well-known/openid-configuration"))
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          revocation_endpoint: `${issuer}/revoke`,
        });
      if (url === `${issuer}/revoke`)
        return new Response(null, { status: 200 });
      throw new Error("unexpected fake request");
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  await run(
    Effect.gen(function* () {
      const registry = yield* RuntimeRegistry;
      for (const key of keyAccounts) yield* registry.signOut(key.name);
      expect(requests).toEqual([]);
      yield* registry.signOut(account.name);
      expect((yield* registry.probe(account.name)).signIn.state).toBe(
        "not-signed-in",
      );
    }),
    {
      accountDirectory: inMemoryAccountDirectoryLayer([
        account,
        ...keyAccounts,
      ]),
      environment: {},
      auth: { directory: other, issuer, fetch: fetcher },
    },
  );
  expect(requests).toEqual([
    `${issuer}/.well-known/openid-configuration`,
    `${issuer}/revoke`,
  ]);
  expect(readAuth(directory)?.session).toBeUndefined();
  expect(readAuth(other)?.session).toBeDefined();
});

test("sign-out read failures have a typed safe error, so provider or file details never escape", async () => {
  const directory = folder();
  writeFileSync(authFilePath(directory), "fake-private-broken-signin", {
    mode: 0o600,
  });
  const result = await run(
    Effect.flatMap(RuntimeRegistry, (registry) =>
      failure(registry.signOut(name("chatgpt"))),
    ),
    { auth: { directory }, environment: {} },
  );
  expect(result).toEqual(
    new RuntimeUnavailable({
      account: name("chatgpt"),
      reason: "start-failed",
    }),
  );
  expect(JSON.stringify(result)).not.toContain("fake-private-broken-signin");
  expect(JSON.stringify(result)).not.toContain(directory);
});

test("without Claude Code registered, the default Claude account is unregistered, so a missing registration cannot select pi", async () => {
  const result = await run(failure(probe("claude")), {
    environment: {},
    auth: { directory: folder() },
  });
  expect(result).toEqual(
    new RuntimeUnavailable({
      account: name("claude"),
      reason: "not-registered",
    }),
  );
});

// Why: closing an attempt must not destroy the worker's directory, account events or registry.
test("two real attempts reuse one process registry and late configuration is refused", () => {
  const result = boundary(`
    const { exerciseProcessRuntimes } = await import(${JSON.stringify(new URL("./fixtures/process-runtimes.ts", import.meta.url).href)});
    console.log(JSON.stringify(await exerciseProcessRuntimes(process.env.TMPDIR)));
  `);
  expect(result).toEqual({ builds: 1, attempts: 2, rejected: true });
});

// Why: a transient directory build failure must release its scope and allow the worker's next attempt to build again.
test("a failed process registry build is released and retried", () => {
  const result = boundary(`
    const { AccountDirectory, DEFAULT_ACCOUNTS, inMemoryAccountDirectory } = await import(${JSON.stringify(import.meta.resolve("@neuve/runtime"))});
    const { Layer } = await import(${JSON.stringify(import.meta.resolve("effect"))});
    const { configureProcessRuntimes, processRuntimes } = await import(${JSON.stringify(new URL("../src/runtimes.ts", import.meta.url).href)});
    let builds = 0;
    let released = 0;
    configureProcessRuntimes({
      accountDirectory: Layer.effect(AccountDirectory, Effect.gen(function* () {
        builds++;
        yield* Effect.acquireRelease(Effect.void, () => Effect.sync(() => { released++; }));
        if (builds === 1) return yield* Effect.die(new Error("synthetic directory build failure"));
        return inMemoryAccountDirectory(DEFAULT_ACCOUNTS);
      })),
    });
    const first = processRuntimes();
    const samePending = first === processRuntimes();
    let failed = false;
    try { await first; } catch { failed = true; }
    const releasedBeforeRetry = released;
    const registry = await processRuntimes();
    const reused = registry === await processRuntimes();
    const capabilities = await Effect.runPromise(registry.capabilities(AccountName.parse("anthropic")));
    console.log(JSON.stringify({ builds, failed, samePending, releasedBeforeRetry, reused, ownsLoop: capabilities.ownsLoop }));
  `);
  expect(result).toEqual({
    builds: 2,
    failed: true,
    samePending: true,
    releasedBeforeRetry: 1,
    reused: true,
    ownsLoop: false,
  });
});

// Why: the worker's readiness for the default Claude route must name a refused Neuve folder in ruling 46's
// words, not "couldn't be checked", and must not cache the refusal. The worker reads the configured home,
// never homedir(); the child also runs with a scratch HOME, and refuses to run on the real one.
test("worker readiness for the default Claude route names a refused Neuve folder and recovers after repair", () => {
  // Bun's homedir() and userInfo().homedir both follow HOME, so the real home is named from the user.
  const { username } = userInfo();
  const realHomes = [`/Users/${username}`, `/home/${username}`];
  const underRealHome = (path: string) =>
    realHomes.some((home) => path === home || path.startsWith(`${home}/`));
  expect(scratch.startsWith(`${tmpdir()}/`)).toBe(true);
  expect(underRealHome(scratch)).toBe(false);
  const result = claudeBoundary(
    `
    import { chmodSync, existsSync, mkdtempSync } from "node:fs";
    import { homedir } from "node:os";
    import { join } from "node:path";
    import { configureProcessRuntimes, processRuntimes, processReadinessStatuses } from ${JSON.stringify(new URL("../src/runtimes.ts", import.meta.url).href)};
    import { routeReadiness } from ${JSON.stringify(new URL("../src/route-provider.ts", import.meta.url).href)};
    import { ClaudeRouteConfig, OPUS_ROUTE } from ${JSON.stringify(new URL("../src/route.ts", import.meta.url).href)};
    const realHomes = ${JSON.stringify(realHomes)};
    if (homedir() !== ${JSON.stringify(scratch)} ||
        realHomes.some(real => homedir() === real || homedir().startsWith(real + "/")))
      throw new Error("Refusing to run outside the scratch home");
    // A home other than homedir(), so the worker can only reach it through its configuration.
    const home = mkdtempSync(join(homedir(), "default-claude-readiness-"));
    const route = ClaudeRouteConfig.parse({
      model: OPUS_ROUTE.model, effort: OPUS_ROUTE.effort, window: OPUS_ROUTE.window,
      maxOutputTokens: OPUS_ROUTE.maxOutputTokens, provider: "claude",
      account: { name: "claude", kind: "claude-subscription" }, price: null,
    });
    await Effect.runPromise(Effect.scoped(Effect.flatMap(AccountStore.make(home),
      store => store.add("claude", "work-claude"))));
    const root = AccountStore.neuveFolder(home);
    const options = workerRuntimeOptions(home);
    options.claude = { ...options.claude, executable };
    configureProcessRuntimes({ ...options, home });
    const registry = await processRuntimes();
    const readiness = () => Effect.runPromise(routeReadiness(route, registry, processReadinessStatuses()));
    chmodSync(root, 0o775);
    let refused, restored;
    try { refused = await readiness(); } finally { chmodSync(root, 0o755); }
    restored = await readiness();
    console.log(JSON.stringify({
      refused, restored,
      expected: root + " is writable by other users. Neuve needs it writable only by you.",
      homedirUntouched: !existsSync(AccountStore.neuveFolder(homedir())),
    }));
    process.exit(0);
    `,
  );
  expect(result.refused).toEqual({ ready: false, credential: result.expected });
  expect(JSON.stringify(result)).not.toMatch(/couldn't be checked|newer Neuve/);
  // The failure isn't cached: the next readiness passes the folder check and waits for the shared check.
  expect(result.restored).toEqual({
    ready: false,
    credential:
      "Account claude hasn't been checked yet; waiting for its shared account check",
  });
  expect(result.homedirUntouched).toBe(true);
});

// Why: pi attempts build this registry too, so capabilities and pi probes must leave HOME empty.
// A file satisfies executable lookup; the first Claude probe creates its folder before spawn is refused.
test("harnessRuntimes registers Claude Code beside pi and creates its working folder only on first use", () => {
  const result = claudeBoundary(
    `
    import { existsSync, mkdtempSync, readdirSync, statSync } from "node:fs";
    import { join } from "node:path";
    const home = mkdtempSync(join(process.env.HOME, "lazy-work-"));
    const cwd = defaultClaudeWorkingFolder(home);
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const registry = yield* RuntimeRegistry;
      const claude = (yield* registry.capabilities(AccountName.parse("claude"))).ownsLoop;
      const chatgpt = (yield* registry.capabilities(AccountName.parse("chatgpt"))).ownsLoop;
      const continuation = (yield* registry.continuation(AccountName.parse("claude"))).runtime;
      const pi = yield* registry.probe(AccountName.parse("anthropic"));
      const before = readdirSync(home);
      const status = yield* registry.probe(AccountName.parse("claude"));
      return { claude, chatgpt, continuation, pi: pi.signIn.state, before,
        exists: existsSync(cwd), mode: statSync(cwd).mode & 0o777, status: status.signIn };
    })).pipe(Effect.provide(harnessRuntimes({ claude: { cwd, executable }, environment: {} }))));
    console.log(JSON.stringify(result));
  `,
    { PATH: "" },
  );
  expect(result).toEqual({
    claude: true,
    chatgpt: false,
    continuation: "claude-code",
    pi: "not-signed-in",
    before: [],
    exists: true,
    mode: 0o700,
    status: {
      state: "unknown",
      reason: "check-failed",
      hint: { kind: "command", command: "claude auth login" },
    },
  });
});

// Consumers outside the harness reach the one registration through the package's public path.
test("harnessRuntimes is exported through @neuve/harness/runtimes", () => {
  expect(publicHarnessRuntimes).toBe(harnessRuntimes);
});

// A working folder Neuve can't create must not take pi's accounts down; Claude reports itself unavailable.
test("an unusable Claude working folder leaves pi working and reports Claude Code unavailable", async () => {
  const parent = join(scratch, "read-only-home");
  mkdirSync(parent, { mode: 0o700 });
  chmodSync(parent, 0o500);
  try {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* RuntimeRegistry;
          const pi = yield* registry.probe(name("anthropic"));
          const claude = yield* registry.probe(name("claude"));
          const opened = yield* failure(
            registry.openSession(name("claude"), policy),
          );
          return { pi: pi.signIn.state, claude: claude.signIn, opened };
        }),
      ).pipe(
        Effect.provide(
          harnessRuntimes({
            // Reason: pin an executable so the working-folder failure is tested without installed Claude.
            claude: {
              cwd: join(parent, "claude-code", "work"),
              executable: process.execPath,
            },
            environment: { ANTHROPIC_API_KEY: "sk-ant-api03-fake-test-value" },
            auth: { directory: folder() },
          }),
        ),
      ),
    );
    expect(result.pi).toBe("signed-in");
    expect(result.claude).toEqual({
      state: "runtime-unavailable",
      reason: "start-failed",
    });
    expect(result.opened).toEqual(
      new RuntimeUnavailable({
        account: name("claude"),
        reason: "start-failed",
      }),
    );
  } finally {
    chmodSync(parent, 0o700);
  }
});

// Why: lazy initialization must retain the existing permission-tightening behavior.
test("an existing Claude working folder is tightened to owner-only access on first probe", () => {
  const cwd = join(scratch, "open-work");
  mkdirSync(cwd, { mode: 0o755 });
  chmodSync(cwd, 0o755);
  const result = claudeBoundary(
    `
    import { statSync } from "node:fs";
    const cwd = ${JSON.stringify(cwd)};
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const registry = yield* RuntimeRegistry;
      const before = statSync(cwd).mode & 0o777;
      const status = yield* registry.probe(AccountName.parse("claude"));
      return { before, after: statSync(cwd).mode & 0o777, status: status.signIn };
    })).pipe(Effect.provide(harnessRuntimes({ claude: { cwd, executable }, environment: {} }))));
    console.log(JSON.stringify(result));
  `,
    { PATH: "" },
  );
  expect(result).toEqual({
    before: 0o755,
    after: 0o700,
    status: {
      state: "unknown",
      reason: "check-failed",
      hint: { kind: "command", command: "claude auth login" },
    },
  });
});

// Why: overlapping session/probe callers must share one initialization, including later calls.
test("concurrent first Claude session and probe create the working folder once", () => {
  const result = claudeBoundary(
    `
    import * as fs from "node:fs";
    import { join } from "node:path";
    const home = fs.mkdtempSync(join(process.env.HOME, "concurrent-work-"));
    const cwd = defaultClaudeWorkingFolder(home);
    const mkdir = fs.mkdirSync;
    let attempts = 0;
    const watched = spyOn(fs, "mkdirSync").mockImplementation((path, options) => {
      if (path === cwd) attempts++;
      return mkdir(path, options);
    });
    try {
      const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        const registry = yield* RuntimeRegistry;
        const before = attempts;
        const [opened, probed] = yield* Effect.all([
          registry.openSession(AccountName.parse("claude"), ${JSON.stringify(policy)}).pipe(
            Effect.match({ onFailure: error => ({ tag: error._tag, reason: error.reason }), onSuccess: () => "unexpected" })
          ),
          registry.probe(AccountName.parse("claude")),
        ], { concurrency: "unbounded" });
        yield* registry.probe(AccountName.parse("claude"));
        return { before, attempts, mode: fs.statSync(cwd).mode & 0o777, opened, probed: probed.signIn };
      })).pipe(Effect.provide(harnessRuntimes({ claude: { cwd, executable }, environment: {} }))));
      console.log(JSON.stringify(result));
    } finally { watched.mockRestore(); }
  `,
    { PATH: "" },
  );
  expect(result).toEqual({
    before: 0,
    attempts: 1,
    mode: 0o700,
    opened: { tag: "RuntimeUnavailable", reason: "start-failed" },
    probed: {
      state: "unknown",
      reason: "check-failed",
      hint: { kind: "command", command: "claude auth login" },
    },
  });
});

// Why: review workers must resolve added accounts through the live store, with its scope closed afterward.
test("workerRuntimeOptions supplies the accounts store directory and leaves key presence on the environment", () => {
  const result = claudeBoundary(
    `
    import { mkdtempSync, readdirSync } from "node:fs";
    import { join } from "node:path";
    const home = mkdtempSync(join(process.env.HOME, "worker-store-"));
    const options = workerRuntimeOptions(home);
    options.claude = { ...options.claude, executable };
    const beforeBuild = readdirSync(home);
    const added = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const store = yield* AccountStore.make(home);
      return yield* store.add("claude", "work-claude");
    })));
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const registry = yield* RuntimeRegistry;
      const capabilities = yield* registry.capabilities(added.name);
      const continuation = yield* registry.continuation(added.name);
      const key = yield* registry.probe(AccountName.parse("anthropic"));
      const store = yield* AccountStore.make(home);
      const later = yield* store.add("claude", "later-claude");
      const laterCapabilities = yield* registry.capabilities(later.name);
      return { beforeBuild, cwd: options.claude.cwd === defaultClaudeWorkingFolder(home),
        keyPresenceDefault: options.keyPresence === undefined, ownsLoop: capabilities.ownsLoop,
        continuation, folder: added.credential.folder, key: key.signIn,
        laterOwnsLoop: laterCapabilities.ownsLoop };
    })).pipe(Effect.provide(harnessRuntimes(options))));
    console.log(JSON.stringify({ ...result, sameFolder: result.continuation.key === result.folder,
      continuation: result.continuation.runtime, folder: undefined }));
  `,
    { PATH: "", ANTHROPIC_API_KEY: "synthetic-worker-api-key" },
  );
  expect(result).toEqual({
    beforeBuild: [],
    cwd: true,
    keyPresenceDefault: true,
    ownsLoop: true,
    continuation: "claude-code",
    key: { state: "signed-in", credentialSource: "environment" },
    laterOwnsLoop: true,
    sameFolder: true,
  });
});

// Why: callers share each setup attempt, but repairing a failed folder must let the next call recover.
test("a failed first-use folder attempt is shared, retried after repair, and leaves pi working", () => {
  const result = claudeBoundary(
    `
    import * as fs from "node:fs";
    import { join } from "node:path";
    const home = fs.mkdtempSync(join(process.env.HOME, "blocked-work-"));
    const blocked = join(home, "blocked");
    const cwd = join(blocked, "work");
    fs.writeFileSync(blocked, "not a directory");
    const mkdir = fs.mkdirSync;
    let attempts = 0;
    const watched = spyOn(fs, "mkdirSync").mockImplementation((path, options) => {
      if (path === cwd) attempts++;
      return mkdir(path, options);
    });
    try {
      const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        const registry = yield* RuntimeRegistry;
        const before = { attempts, pi: (yield* registry.probe(AccountName.parse("anthropic"))).signIn };
        const [probed, opened] = yield* Effect.all([
          registry.probe(AccountName.parse("claude")),
          registry.openSession(AccountName.parse("claude"), ${JSON.stringify(policy)}).pipe(
            Effect.match({ onFailure: error => ({ tag: error._tag, reason: error.reason }), onSuccess: () => "unexpected" })
          ),
        ], { concurrency: "unbounded" });
        const failedAttempts = attempts;
        fs.unlinkSync(blocked);
        const recovered = yield* Effect.all([
          registry.probe(AccountName.parse("claude")),
          registry.probe(AccountName.parse("claude")),
        ], { concurrency: "unbounded" });
        yield* registry.probe(AccountName.parse("claude"));
        return { before, failedAttempts, attempts, probed: probed.signIn, opened,
          recovered: recovered.map(status => status.signIn), mode: fs.statSync(cwd).mode & 0o777,
          after: (yield* registry.probe(AccountName.parse("anthropic"))).signIn };
      })).pipe(Effect.provide(harnessRuntimes({ claude: { cwd, executable }, environment: { ANTHROPIC_API_KEY: "synthetic-key" } }))));
      console.log(JSON.stringify(result));
    } finally { watched.mockRestore(); }
  `,
    { PATH: "" },
  );
  const signedIn = { state: "signed-in", credentialSource: "environment" };
  expect(result).toEqual({
    before: { attempts: 0, pi: signedIn },
    failedAttempts: 1,
    attempts: 2,
    probed: { state: "runtime-unavailable", reason: "start-failed" },
    opened: { tag: "RuntimeUnavailable", reason: "start-failed" },
    recovered: [
      {
        state: "unknown",
        reason: "check-failed",
        hint: { kind: "command", command: "claude auth login" },
      },
      {
        state: "unknown",
        reason: "check-failed",
        hint: { kind: "command", command: "claude auth login" },
      },
    ],
    mode: 0o700,
    after: signedIn,
  });
});

// Why: store read and permission failures must not prevent default pi accounts or readiness.
for (const mode of [0o000, 0o644])
  test(`worker registry preserves defaults and refuses named accounts when an account record has mode ${mode.toString(8)}`, () => {
    const result = boundary(
      `
      import { chmodSync, mkdtempSync, readdirSync } from "node:fs";
      import { join } from "node:path";
      import { Logger } from ${JSON.stringify(import.meta.resolve("effect"))};
      import { routeReadiness } from ${JSON.stringify(new URL("../src/route-provider.ts", import.meta.url).href)};
      import { OPUS_ROUTE } from ${JSON.stringify(new URL("../src/route.ts", import.meta.url).href)};
      const home = mkdtempSync(join(process.env.HOME, "store-failure-"));
      const added = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        const store = yield* AccountStore.make(home);
        return yield* store.add("claude", "unavailable-claude");
      })));
      const claim = AccountStore.claimPath(home, added.name);
      const path = join(claim, readdirSync(claim)[0]);
      chmodSync(path, ${mode});
      const warnings = [];
      try {
        const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
          const registry = yield* RuntimeRegistry;
          const ownsLoop = yield* Effect.forEach(["anthropic", "chatgpt"], name =>
            Effect.map(registry.capabilities(AccountName.parse(name)), caps => caps.ownsLoop));
          const added = yield* registry.capabilities(AccountName.parse("unavailable-claude")).pipe(Effect.result);
          const readiness = yield* routeReadiness(OPUS_ROUTE, registry,
            Effect.die("pi must not start the status service"));
          const statuses = yield* AccountStore.makeStatuses(home, registry).pipe(Effect.result);
          return { ownsLoop, added: added._tag === "Failure" ? added.failure._tag : "unexpected",
            readiness, statuses: statuses._tag === "Failure" ? statuses.failure._tag : "unexpected" };
        })).pipe(
          Effect.provide(harnessRuntimes(workerRuntimeOptions(home))),
          Effect.provide(Logger.layer([Logger.make(({ message }) => warnings.push(message))])),
        ));
        console.log(JSON.stringify({ ...result, warnings }));
      } finally { chmodSync(path, 0o600); }
      `,
      { PATH: "", ANTHROPIC_API_KEY: "synthetic-worker-api-key" },
    );
    expect(result).toEqual({
      ownsLoop: [false, false],
      added: "AccountStoreRefused",
      readiness: { ready: true, credential: "ANTHROPIC_API_KEY" },
      statuses: "AccountStoreError",
      warnings: [],
    });
  });
