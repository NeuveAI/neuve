import { expect, test } from "bun:test";
import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Effect, Layer, Scope, Exit, Context } from "effect";
import {
  AccountStore,
  AccountDirectory,
  RuntimeRegistry,
  runtimeRegistryLayer,
} from "@neuve/runtime";
import { fixture, FakeRuntime } from "./fixture.ts";

// Exercise the merged store's real stop-before-failure check, without a watcher racing the setup.
test("the real store checkTurn removal failure reaches the pi stream", async () => {
  const home = mkdtempSync(join(tmpdir(), "chat-runtime-store-"));
  const scope = Scope.makeUnsafe();
  const store = await Effect.runPromise(
    AccountStore.make(home).pipe(Effect.provideService(Scope.Scope, scope)),
  );
  const added = await Effect.runPromise(store.add("claude", "subscription"));
  let removeOnCheck = false;
  const directory = {
    ...store.directory,
    checkTurn: (name: Parameters<typeof store.checkTurn>[0]) =>
      Effect.suspend(() => {
        if (removeOnCheck) {
          removeOnCheck = false;
          const entry = AccountStore.readAccounts(home).find(
            (entry) => entry.account.name === added.name,
          )!;
          renameSync(
            AccountStore.recordPath(home, entry),
            AccountStore.recordPath(home, { ...entry, state: "removing" }),
          );
        }
        return store.checkTurn(name);
      }),
  };
  const fake = new FakeRuntime();
  const built = await Effect.runPromise(
    Layer.buildWithScope(
      runtimeRegistryLayer([fake.shape]).pipe(
        Layer.provide(Layer.succeed(AccountDirectory, directory)),
      ),
      scope,
    ),
  );
  const run = await fixture({
    fake,
    accounts: [added],
    registry: () => Context.get(built, RuntimeRegistry),
  });
  const results: AssistantMessage[] = [];
  const stream = run.bridge.stream.bind(run.bridge);
  run.bridge.stream = (...args) => {
    const output = stream(...args);
    void output.result().then((message) => results.push(message));
    return output;
  };
  try {
    fake.frames.push({ text: "first" });
    await run.submit("first");
    removeOnCheck = true;
    await run.submit("next");
    expect(results.at(-1)?.errorMessage).toBe(
      "The selected account subscription is no longer available.",
    );
    expect(fake.requests).toHaveLength(1);
  } finally {
    await run.close();
    await Effect.runPromise(Scope.close(scope, Exit.void));
    rmSync(home, { recursive: true, force: true });
  }
});
