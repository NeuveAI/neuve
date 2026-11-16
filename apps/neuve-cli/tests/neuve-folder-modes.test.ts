import { expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Effect, Scope } from "effect";
import { ClaudeRouteConfig } from "../../../packages/harness/src/route.ts";
import { routeReadiness } from "../../../packages/harness/src/route-provider.ts";
import { neuveFolder } from "../../../packages/runtime/src/store/files.ts";
import {
  AccountStore,
  RuntimeRegistry,
  fakeRuntime,
  provideRegistry,
  scratch,
} from "../../../packages/runtime/tests/store/fixtures.ts";
import { runAuthCli } from "../src/auth-cli.ts";
import * as RecordsCli from "../src/records-cli.ts";

// Reason: an existing settings root must allow the production CLI check and admit a Claude-subscription review.
test("0755 settings root supports auth list, auth status check and route readiness", async () => {
  const { home, close } = scratch();
  const root = neuveFolder(home);
  mkdirSync(root, { recursive: true });
  chmodSync(root, 0o755);
  const settings = "{}\n";
  writeFileSync(join(root, "settings.json"), settings);
  const calls: string[] = [];
  const fake = fakeRuntime({
    calls,
    probe: () =>
      Effect.succeed({
        signIn: { state: "signed-in" },
        limits: [],
        checkedAt: "2026-11-11T00:00:00Z",
      }),
  });
  const output: string[] = [];
  const writer = spyOn(RecordsCli, "write").mockImplementation((text) => {
    output.push(text);
    return Promise.resolve(text.length);
  });
  try {
    expect(await runAuthCli(["list"], { home, runtimes: [fake] })).toBe(0);
    expect(output.join("")).toContain("claude");
    expect(calls).toEqual([]);
    output.length = 0;
    expect(
      await runAuthCli(["status", "claude", "--check"], {
        home,
        runtimes: [fake],
      }),
    ).toBe(0);
    expect(output.join("")).toBe("claude  claude-subscription  signed-in");
    expect(calls).toEqual(["probe:claude"]);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AccountStore.make(home);
          yield* Effect.gen(function* () {
            const registry = yield* RuntimeRegistry;
            const service = yield* AccountStore.makeStatuses(home, registry);
            const scope = yield* Scope.Scope;
            const route = ClaudeRouteConfig.parse({
              provider: "claude",
              account: { name: "claude", kind: "claude-subscription" },
              model: "sonnet",
              effort: "high",
              window: 200000,
              maxOutputTokens: 32000,
              price: null,
            });
            expect(
              (yield* routeReadiness(
                route,
                registry,
                Effect.succeed({ service, scope }),
              )).ready,
            ).toBe(true);
          }).pipe(Effect.provide(provideRegistry(store, [fake])));
        }),
      ),
    );
    expect(calls).toEqual(["probe:claude"]);
    expect(statSync(join(root, "accounts")).mode & 0o777).toBe(0o700);
    expect(statSync(root).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(root, "settings.json"), "utf8")).toBe(settings);
  } finally {
    writer.mockRestore();
    close();
  }
});
