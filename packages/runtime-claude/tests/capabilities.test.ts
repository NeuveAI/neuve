import { expect, spyOn, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  Account,
  RuntimeRegistry,
  RuntimeUnavailable,
  TurnLimit,
  inMemoryAccountDirectoryLayer,
  runtimeRegistryLayer,
  type SessionPolicy,
} from "@neuve/runtime";
import { Effect, Layer } from "effect";
import { capabilities, makeRuntime } from "../src/runtime.ts";
import { executableLayer } from "../src/production.ts";
import {
  ClaudeExecutable,
  ClaudeProcess,
  ClaudeSdk,
  ClaudeSdkError,
} from "../src/services.ts";

const account = Account.parse({
  name: "subscription",
  kind: "claude-subscription",
  runtime: "claude-code",
  credential: { kind: "claude-config-folder" },
});
const policy: SessionPolicy = {
  systemPrompt: "test",
  tools: [],
  turnLimit: TurnLimit.parse(1),
  approvalPolicy: "allow",
};

function productionSetup(executable?: string) {
  const calls = { opens: 0, runs: 0 };
  return {
    calls,
    runtime: makeRuntime({
      cwd: "/test/neuve",
      ...(executable === undefined ? {} : { executable }),
      environment: {},
    }).pipe(
      Effect.provide(executableLayer),
      Effect.provideService(ClaudeSdk, {
        prefixes: { usage: [], organization: [] },
        open: () =>
          Effect.suspend(() => {
            calls.opens++;
            return Effect.fail(
              new ClaudeSdkError({ method: "unexpected-open" }),
            );
          }),
      }),
      Effect.provideService(ClaudeProcess, {
        run: () =>
          Effect.suspend(() => {
            calls.runs++;
            return Effect.fail(
              new ClaudeSdkError({ method: "unexpected-run" }),
            );
          }),
      }),
    ),
  };
}

// Reason: the production resolver must check configured paths on each entry point, without starting Claude.
test("production lookup rejects a missing configured path for capabilities and openSession", async () => {
  const directory = mkdtempSync(join(tmpdir(), "claude-capabilities-"));
  const lookup = spyOn(Bun, "which");
  try {
    const path = join(directory, "absent");
    const fake = productionSetup(path);
    const runtime = await Effect.runPromise(fake.runtime);
    const unavailable = new RuntimeUnavailable({
      account: account.name,
      reason: "not-installed",
    });
    expect(
      await Effect.runPromise(runtime.capabilities(account).pipe(Effect.flip)),
    ).toEqual(unavailable);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(
      await Effect.runPromise(
        Effect.scoped(runtime.openSession(account, policy).pipe(Effect.flip)),
      ),
    ).toEqual(unavailable);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(lookup).toHaveBeenLastCalledWith(path);
    expect(fake.calls).toEqual({ opens: 0, runs: 0 });
  } finally {
    lookup.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});

// Reason: checking a configured path must still admit an existing executable without executing it.
test("production lookup accepts an existing configured executable", async () => {
  const fake = productionSetup(process.execPath);
  const runtime = await Effect.runPromise(fake.runtime);
  expect(await Effect.runPromise(runtime.capabilities(account))).toEqual(
    capabilities,
  );
  expect(fake.calls).toEqual({ opens: 0, runs: 0 });
});

// Reason: an existing file without executable permission cannot serve the account.
test("production lookup rejects a configured file without executable permission", async () => {
  const directory = mkdtempSync(join(tmpdir(), "claude-capabilities-"));
  try {
    const path = join(directory, "not-executable");
    writeFileSync(path, "fixture\n");
    chmodSync(path, 0o644);
    const fake = productionSetup(path);
    const runtime = await Effect.runPromise(fake.runtime);
    expect(
      await Effect.runPromise(runtime.capabilities(account).pipe(Effect.flip)),
    ).toEqual(
      new RuntimeUnavailable({
        account: account.name,
        reason: "not-installed",
      }),
    );
    expect(fake.calls).toEqual({ opens: 0, runs: 0 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Reason: the default production lookup must still find a PATH executable, without relying on an installed Claude.
test("production lookup finds claude on PATH", async () => {
  const directory = mkdtempSync(join(tmpdir(), "claude-capabilities-"));
  const which = Bun.which;
  const lookup = spyOn(Bun, "which").mockImplementation((command, options) =>
    which(command, { ...options, PATH: directory }),
  );
  try {
    const path = join(directory, "claude");
    writeFileSync(path, "#!/bin/sh\nexit 1\n");
    chmodSync(path, 0o755);
    const fake = productionSetup();
    const runtime = await Effect.runPromise(fake.runtime);
    expect(await Effect.runPromise(runtime.capabilities(account))).toEqual(
      capabilities,
    );
    expect(lookup).toHaveBeenCalledWith("claude");
    expect(fake.calls).toEqual({ opens: 0, runs: 0 });
  } finally {
    lookup.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});

// Reason: configured relative paths must use the process working directory and the same executable checks.
test.each(["executable", "missing", "not-executable"])(
  "production lookup checks a relative configured path: %s",
  async (kind) => {
    const directory = mkdtempSync(join(tmpdir(), "claude-capabilities-"));
    try {
      const path = join(directory, "fixture");
      if (kind !== "missing") {
        writeFileSync(path, "#!/bin/sh\nexit 1\n");
        chmodSync(path, kind === "executable" ? 0o755 : 0o644);
      }
      const fake = productionSetup(relative(process.cwd(), path));
      const runtime = await Effect.runPromise(fake.runtime);
      if (kind === "executable") {
        expect(await Effect.runPromise(runtime.capabilities(account))).toEqual(
          capabilities,
        );
      } else {
        expect(
          await Effect.runPromise(
            runtime.capabilities(account).pipe(Effect.flip),
          ),
        ).toEqual(
          new RuntimeUnavailable({
            account: account.name,
            reason: "not-installed",
          }),
        );
      }
      expect(fake.calls).toEqual({ opens: 0, runs: 0 });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

function setup(path: string | undefined) {
  const lookups: Array<string | undefined> = [];
  const calls = { opens: 0, runs: 0, lookups };
  const layer = Layer.mergeAll(
    Layer.succeed(ClaudeExecutable, {
      resolve: (explicit) =>
        Effect.sync(() => {
          calls.lookups.push(explicit);
          return path;
        }),
    }),
    Layer.succeed(ClaudeSdk, {
      prefixes: { usage: [], organization: [] },
      open: () =>
        Effect.suspend(() => {
          calls.opens++;
          return Effect.fail(new ClaudeSdkError({ method: "unexpected-open" }));
        }),
    }),
    Layer.succeed(ClaudeProcess, {
      run: () =>
        Effect.suspend(() => {
          calls.runs++;
          return Effect.fail(new ClaudeSdkError({ method: "unexpected-run" }));
        }),
    }),
  );
  return {
    calls,
    setPath: (next: string | undefined) => {
      path = next;
    },
    runtime: makeRuntime({
      cwd: "/test/neuve",
      executable: "/test/claude",
      environment: {},
    }).pipe(Effect.provide(layer)),
  };
}

// Reason: readiness must reject a missing installation without starting Claude.
test("capabilities rejects a missing executable without SDK or process use", async () => {
  const fake = setup(undefined);
  const runtime = await Effect.runPromise(fake.runtime);
  const error = await Effect.runPromise(
    runtime.capabilities(account).pipe(Effect.flip),
  );
  expect(error).toEqual(
    new RuntimeUnavailable({ account: account.name, reason: "not-installed" }),
  );
  expect(fake.calls).toEqual({ opens: 0, runs: 0, lookups: ["/test/claude"] });
});

// Reason: the lookup must preserve every declared capability and remain passive.
test("capabilities returns the unchanged declaration for a present executable", async () => {
  const fake = setup("/test/claude");
  const runtime = await Effect.runPromise(fake.runtime);
  expect(await Effect.runPromise(runtime.capabilities(account))).toEqual(
    capabilities,
  );
  expect(fake.calls).toEqual({ opens: 0, runs: 0, lookups: ["/test/claude"] });
});

// Reason: account validation must retain precedence over installation lookup.
test("capabilities rejects an unsupported account before executable lookup", async () => {
  const fake = setup(undefined);
  const unsupported = Account.parse({
    name: "api",
    kind: "anthropic-api-key",
    runtime: "claude-code",
    credential: { kind: "environment", variable: "TEST_KEY" },
  });
  const runtime = await Effect.runPromise(fake.runtime);
  const error = await Effect.runPromise(
    runtime.capabilities(unsupported).pipe(Effect.flip),
  );
  expect(error).toEqual(
    new RuntimeUnavailable({
      account: unsupported.name,
      reason: "not-registered",
    }),
  );
  expect(fake.calls).toEqual({ opens: 0, runs: 0, lookups: [] });
});

// Reason: opening must recheck an installation that disappeared after readiness.
test("openSession rechecks the executable after capabilities succeeds", async () => {
  const fake = setup("/test/claude");
  const runtime = await Effect.runPromise(fake.runtime);
  expect(await Effect.runPromise(runtime.capabilities(account))).toEqual(
    capabilities,
  );
  fake.setPath(undefined);
  const error = await Effect.runPromise(
    Effect.scoped(runtime.openSession(account, policy).pipe(Effect.flip)),
  );
  expect(error).toEqual(
    new RuntimeUnavailable({ account: account.name, reason: "not-installed" }),
  );
  expect(fake.calls).toEqual({
    opens: 0,
    runs: 0,
    lookups: ["/test/claude", "/test/claude"],
  });
});

// Reason: installing Claude after a failed check must restore readiness immediately.
test("capabilities rechecks the executable after an earlier missing installation", async () => {
  const fake = setup(undefined);
  const runtime = await Effect.runPromise(fake.runtime);
  expect(
    await Effect.runPromise(runtime.capabilities(account).pipe(Effect.flip)),
  ).toEqual(
    new RuntimeUnavailable({ account: account.name, reason: "not-installed" }),
  );
  fake.setPath("/test/claude");
  expect(await Effect.runPromise(runtime.capabilities(account))).toEqual(
    capabilities,
  );
  expect(fake.calls).toEqual({
    opens: 0,
    runs: 0,
    lookups: ["/test/claude", "/test/claude"],
  });
});

// Reason: callers using the registry must receive the same readiness failure.
test("registry capabilities propagates a missing executable for the account", async () => {
  const fake = setup(undefined);
  const runtime = await Effect.runPromise(fake.runtime);
  const layer = runtimeRegistryLayer([runtime]).pipe(
    Layer.provide(inMemoryAccountDirectoryLayer([account])),
  );
  const error = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* RuntimeRegistry;
      return yield* registry.capabilities(account.name).pipe(Effect.flip);
    }).pipe(Effect.provide(layer)),
  );
  expect(error).toEqual(
    new RuntimeUnavailable({ account: account.name, reason: "not-installed" }),
  );
  expect(fake.calls).toEqual({ opens: 0, runs: 0, lookups: ["/test/claude"] });
});
