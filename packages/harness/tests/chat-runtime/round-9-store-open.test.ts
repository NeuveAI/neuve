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

// O2: the real store can reject admission before a resumed session reaches the runtime.
test("a removed account's typed open failure reaches the person when the next message resumes", async () => {
  const home = mkdtempSync(join(tmpdir(), "chat-runtime-r9-store-"));
  const scope = Scope.makeUnsafe();
  const store = await Effect.runPromise(
    AccountStore.make(home).pipe(Effect.provideService(Scope.Scope, scope)),
  );
  const added = await Effect.runPromise(store.add("claude", "subscription"));
  const fake = new FakeRuntime();
  const built = await Effect.runPromise(
    Layer.buildWithScope(
      runtimeRegistryLayer([fake.shape]).pipe(
        Layer.provide(Layer.succeed(AccountDirectory, store.directory)),
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
    expect((await run.submit("first")).status).toBe("done");
    await run.bridge.closeSession(fake.opened[0]!.session.id);
    const entry = AccountStore.readAccounts(home).find(
      (item) => item.account.name === added.name,
    )!;
    renameSync(
      AccountStore.recordPath(home, entry),
      AccountStore.recordPath(home, { ...entry, state: "removing" }),
    );
    await run.submit("next");
    expect(fake.opened).toHaveLength(1);
    expect(results.at(-1)?.errorMessage).toBe(
      "The selected account subscription is no longer available.",
    );
  } finally {
    await run.close();
    await Effect.runPromise(Scope.close(scope, Exit.void));
    rmSync(home, { recursive: true, force: true });
  }
});
