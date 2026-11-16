// Why: queue rechecks must read account snapshots and share the accounts service's check,
// without starting a Claude process or turning runtime failures into sign-in advice.
import { expect, test } from "bun:test";
import { Deferred, Effect, Exit, Scope } from "effect";
import {
  AccountStore,
  RuntimeUnavailable,
  type RuntimeError,
} from "@neuve/runtime";
import type { AccountStatus } from "@neuve/runtime/status";
import { SharedWork } from "@neuve/records-core/shared-work";
import { sharedWorkEffect } from "@neuve/records-core/shared-work-effect";
import { OPUS_ROUTE } from "../src/route.ts";
import { routeReadiness } from "../src/route-provider.ts";
import { fakeRuntime, route } from "./pi/stages/contract-fixture.ts";

const status = (part: Partial<AccountStatus> = {}): AccountStatus => ({
  name: route.account.name,
  kind: route.account.kind,
  signIn: { state: "signed-in" },
  limits: [],
  checkedAt: "2026-11-10T00:00:00Z",
  ...part,
});
const cases: {
  label: string;
  snapshot: AccountStatus;
  ready: boolean;
  reason: string;
}[] = [
  {
    label: "signed in",
    snapshot: status(),
    ready: true,
    reason: "the Claude Code sign-in of account fake-claude",
  },
  {
    label: "allowed limit",
    snapshot: status({ limits: [{ window: "five-hour", status: "allowed" }] }),
    ready: true,
    reason: "the Claude Code sign-in of account fake-claude",
  },
  {
    label: "warning limit",
    snapshot: status({ limits: [{ window: "weekly", status: "warning" }] }),
    ready: true,
    reason: "the Claude Code sign-in of account fake-claude",
  },
  {
    label: "signed out",
    snapshot: status({
      signIn: {
        state: "not-signed-in",
        hint: {
          kind: "command",
          command: "claude auth login",
          environment: { CLAUDE_CONFIG_DIR: "/fixture/claude-config" },
        },
      },
    }),
    ready: false,
    reason:
      "The Claude Code sign-in of account fake-claude is not-signed-in; run `neuve auth login fake-claude`",
  },
  {
    label: "rejected credential",
    snapshot: status({
      signIn: {
        state: "credential-rejected",
        hint: { kind: "settings", entry: "accounts" },
      },
    }),
    ready: false,
    reason:
      "The Claude Code sign-in of account fake-claude is credential-rejected; run `neuve auth login fake-claude`",
  },
  {
    label: "rejected credential without a hint",
    snapshot: status({ signIn: { state: "credential-rejected" } }),
    ready: false,
    reason:
      "The Claude Code sign-in of account fake-claude is credential-rejected; run `neuve auth login fake-claude`",
  },
  {
    label: "signed in with a rejected limit and reset time",
    snapshot: status({
      limits: [
        {
          window: "five-hour",
          status: "rejected",
          resetsAt: "2026-11-10T12:00:00Z",
        },
      ],
    }),
    ready: true,
    reason: "the Claude Code sign-in of account fake-claude",
  },
  {
    label: "signed in with a rejected limit without a reset time",
    snapshot: status({ limits: [{ window: "weekly", status: "rejected" }] }),
    ready: true,
    reason: "the Claude Code sign-in of account fake-claude",
  },
  {
    label: "failed check",
    snapshot: status({
      signIn: {
        state: "unknown",
        reason: "check-failed",
        hint: { kind: "settings", entry: "accounts" },
      },
    }),
    ready: false,
    reason:
      "Account fake-claude couldn't be checked; run `neuve auth status fake-claude --check`",
  },
];
for (const item of cases) {
  test(`snapshot readiness: ${item.label}`, async () => {
    const fake = fakeRuntime([]);
    const scope = await Effect.runPromise(Scope.make());
    try {
      const readiness = await Effect.runPromise(
        routeReadiness(
          route,
          fake.registry,
          Effect.succeed({
            scope,
            service: {
              read: Effect.succeed([item.snapshot]),
              check: () =>
                Effect.die(
                  new Error("A checked snapshot must not be checked again"),
                ),
            },
          }),
        ),
      );
      expect(readiness).toEqual({ ready: item.ready, credential: item.reason });
      expect(readiness.credential).not.toContain("/");
      expect(readiness.credential).not.toContain("CLAUDE_CONFIG_DIR");
      expect(fake.probes()).toBe(0);
      expect(fake.opens()).toBe(0);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  });
}

// Why: a failed snapshot read also needs an account check command that can wake the hold.
test("a failed snapshot read holds with the Neuve check command", async () => {
  const fake = fakeRuntime([]);
  const scope = await Effect.runPromise(Scope.make());
  try {
    const readiness = await Effect.runPromise(
      routeReadiness(
        route,
        fake.registry,
        Effect.succeed({
          scope,
          service: {
            read: Effect.fail(
              new AccountStore.StoreError({ message: "fixture read failure" }),
            ),
            check: () =>
              Effect.die(new Error("A failed read must not start a check")),
          },
        }),
      ),
    );
    expect(readiness).toEqual({
      ready: false,
      credential:
        "Account fake-claude couldn't be checked; run `neuve auth status fake-claude --check`",
    });
    expect(readiness.credential).not.toContain("/");
    expect(fake.probes()).toBe(0);
    expect(fake.opens()).toBe(0);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
});

for (const { label, snapshots: initial } of [
  { label: "missing", snapshots: [] },
  {
    label: "not checked",
    snapshots: [
      status({ signIn: { state: "unknown", reason: "not-checked" } }),
    ],
  },
  ...(
    [
      "not-registered",
      "not-installed",
      "unsupported-version",
      "start-failed",
    ] as const
  ).map((reason) => ({
    label: reason,
    snapshots: [status({ signIn: { state: "runtime-unavailable", reason } })],
  })),
]) {
  test(`two rechecks share one pending status check (${label})`, async () => {
    const scope = await Effect.runPromise(Scope.make());
    const gate = await Effect.runPromise(Deferred.make<void>());
    const entered = await Effect.runPromise(Deferred.make<void>());
    const finished = await Effect.runPromise(Deferred.make<void>());
    let subscribers = 0;
    const work = new SharedWork<AccountStatus, RuntimeError>();
    const fake = fakeRuntime([]);
    let snapshots = initial;
    let probes = 0;
    const source = Effect.succeed({
      scope,
      service: {
        read: Effect.sync(() => snapshots),
        check: () =>
          Effect.gen(function* () {
            const result = yield* sharedWorkEffect(work, {
              scope: "account-status",
              key: route.account.name,
              run: () =>
                Effect.gen(function* () {
                  probes++;
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(gate);
                  const value = status();
                  snapshots = [value];
                  return { kind: "succeeded" as const, value };
                }),
            }).pipe(Effect.orDie);
            return result.value;
          }).pipe(
            Effect.onExit(() =>
              Effect.gen(function* () {
                subscribers++;
                if (subscribers === 2)
                  yield* Deferred.succeed(finished, undefined);
              }),
            ),
          ),
      },
    });
    try {
      expect(
        await Effect.runPromise(routeReadiness(route, fake.registry, source)),
      ).toEqual({
        ready: false,
        credential:
          "Account fake-claude hasn't been checked yet; waiting for its shared account check",
      });
      await Effect.runPromise(Deferred.await(entered));
      expect(
        (await Effect.runPromise(routeReadiness(route, fake.registry, source)))
          .ready,
      ).toBe(false);
      expect(probes).toBe(1);
      await Effect.runPromise(Deferred.succeed(gate, undefined));
      await Effect.runPromise(Deferred.await(finished));
      expect(
        (await Effect.runPromise(routeReadiness(route, fake.registry, source)))
          .ready,
      ).toBe(true);
      expect(probes).toBe(1);
      expect(fake.probes()).toBe(0);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  });
}

// Why: a missing runtime must keep the job waiting for a suitable worker, even before a snapshot exists.
for (const reason of ["not-registered", "not-installed"] as const) {
  test(`registry ${reason} holds without a status read or probe`, async () => {
    const fake = fakeRuntime([]);
    const readiness = await Effect.runPromise(
      routeReadiness(
        route,
        {
          capabilities: () =>
            Effect.fail(
              new RuntimeUnavailable({ account: route.account.name, reason }),
            ),
        },
        Effect.die(new Error("Unavailable runtime must not read statuses")),
      ),
    );
    expect(readiness).toEqual({
      ready: false,
      credential:
        reason === "not-installed"
          ? "Claude Code is not installed for account fake-claude; install Claude Code, then run `neuve auth status fake-claude --check`"
          : "This worker doesn't have usable Claude Code for account fake-claude (not-registered); the job waits for a worker that does",
    });
    expect(readiness.credential).not.toContain("/");
    expect(fake.probes()).toBe(0);
  });
}

// Why: pi still uses credentialPresent, including a present or missing API key.
test("pi readiness keeps direct credential presence", async () => {
  const variable = "NEUVE_READINESS_FIXTURE_KEY";
  const configured = {
    ...OPUS_ROUTE,
    credentialVariable: variable,
  };
  const fake = fakeRuntime([]);
  const caps = fake.registry.capabilities(route.account.name);
  const registry = {
    capabilities: () =>
      Effect.map(caps, (value) => ({ ...value, ownsLoop: false })),
  };
  const before = process.env[variable];
  try {
    for (const [value, ready] of [
      [undefined, false],
      ["fixture-key", true],
    ] as const) {
      if (value === undefined) delete process.env[variable];
      else process.env[variable] = value;
      expect(
        await Effect.runPromise(
          routeReadiness(
            configured,
            registry,
            Effect.die(new Error("pi must not use snapshots")),
          ),
        ),
      ).toEqual({
        ready,
        credential: "NEUVE_READINESS_FIXTURE_KEY",
      });
    }
  } finally {
    if (before === undefined) delete process.env[variable];
    else process.env[variable] = before;
  }
});
