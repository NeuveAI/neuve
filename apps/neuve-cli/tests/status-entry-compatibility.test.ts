import { expect, spyOn, test } from "bun:test";
import { createModels } from "@earendil-works/pi-ai";
import { AccountStore, RuntimeRegistry, type Account } from "@neuve/runtime";
import { Effect, Scope } from "effect";
import { readFileSync } from "node:fs";
import { ClaudeRouteConfig } from "../../../packages/harness/src/route.ts";
import { routeReadiness } from "../../../packages/harness/src/route-provider.ts";
import { writeJson } from "../../../packages/runtime/src/store/files.ts";
import {
  fakeRuntime,
  provideRegistry,
  scratch,
} from "../../../packages/runtime/tests/store/fixtures.ts";
import {
  productionChatSources,
  workspaceChatModels,
} from "../src/workspace-chat-runtime.ts";
import { runAuthCli } from "../src/auth-cli.ts";
import * as RecordsCli from "../src/records-cli.ts";

// Reason: a future sign-in state must not hide a healthy sibling from admission, coding discovery or the public CLI.
test("one refused status keeps sibling readiness, coding models and auth status usable without provider calls", async () => {
  const { home, close } = scratch();
  const calls: string[] = [];
  const fake = fakeRuntime({ calls });
  const output: string[] = [];
  const writer = spyOn(RecordsCli, "write").mockImplementation((text) => {
    output.push(text);
    return Promise.resolve(text.length);
  });
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AccountStore.make(home);
          const work = yield* store.add("claude", "work");
          const sibling = yield* store.add("claude", "sibling");
          const snapshot = (account: Account) => ({
            name: account.name,
            kind: account.kind,
            identity: AccountStore.readAccounts(home).find(
              (entry) => entry.account.name === account.name,
            )?.folderId,
            signIn: { state: "signed-in" },
            limits: [],
            models: [
              { id: "sonnet", displayName: "Sonnet", description: "A model" },
            ],
            checkedAt: "2026-11-11T00:00:00Z",
          });
          writeJson(home, AccountStore.statusesPath(home), {
            version: 1,
            accounts: [snapshot(work), snapshot(sibling)],
          });
          yield* Effect.gen(function* () {
            const registry = yield* RuntimeRegistry;
            const service = yield* AccountStore.makeStatuses(home, registry);
            const refused = {
              ...snapshot(work),
              signIn: { state: "future-state" },
            };
            writeJson(home, AccountStore.statusesPath(home), {
              version: 1,
              accounts: [refused, snapshot(sibling)],
            });
            const before = readFileSync(
              AccountStore.statusesPath(home),
              "utf8",
            );
            let checks = 0;
            const statuses = Effect.succeed({
              service: {
                read: service.read,
                check: (name: Account["name"]) =>
                  Effect.sync(() => {
                    checks++;
                  }).pipe(Effect.andThen(service.check(name))),
              },
              scope: yield* Scope.Scope,
            });
            const route = (account: Account) =>
              ClaudeRouteConfig.parse({
                provider: "claude",
                account: { name: account.name, kind: account.kind },
                model: "sonnet",
                effort: "high",
                window: 200000,
                maxOutputTokens: 32000,
                price: null,
              });
            expect(
              (yield* routeReadiness(route(sibling), registry, statuses)).ready,
            ).toBe(true);
            expect(
              (yield* routeReadiness(route(work), registry, statuses)).ready,
            ).toBe(false);
            expect(checks).toBe(0);
            const sources = productionChatSources({ home });
            try {
              // Production snapshot sources with the real fake-backed registry keep discovery off installed runtimes.
              const models = yield* Effect.promise(() =>
                workspaceChatModels(createModels(), { ...sources, registry }),
              );
              try {
                expect(models.current()).toEqual([
                  { provider: sibling.name, modelId: "sonnet", efforts: [] },
                ]);
              } finally {
                yield* Effect.promise(() => models.close());
              }
            } finally {
              yield* Effect.promise(() => sources.close());
            }
            expect(
              yield* Effect.promise(() =>
                runAuthCli(["status", "sibling", "--json"], {
                  home,
                  runtimes: [fake],
                }),
              ),
            ).toBe(0);
            expect(JSON.parse(output.join("")).signIn).toEqual({
              state: "signed-in",
            });
            expect(JSON.parse(output.join("")).models).toEqual(
              snapshot(sibling).models,
            );
            expect(calls).toEqual([]);
            expect(checks).toBe(0);
            expect(readFileSync(AccountStore.statusesPath(home), "utf8")).toBe(
              before,
            );
            expect(JSON.parse(before).accounts[0]).toEqual(refused);
          }).pipe(Effect.provide(provideRegistry(store, [fake])));
        }),
      ),
    );
  } finally {
    writer.mockRestore();
    close();
  }
});
