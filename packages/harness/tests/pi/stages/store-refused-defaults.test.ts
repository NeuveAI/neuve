// Why: a refused accounts folder must not hold pi reviews or API-key reviews at startup or after opening.
import { expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  AccountDirectory,
  AccountName,
  AccountStore,
  RuntimeRegistry,
  runtimeRegistryLayer,
} from "@neuve/runtime";
import { scratch } from "../../../../runtime/tests/store/fixtures.ts";
import { piStatusRuntime } from "../../../src/pi/status-runtime.ts";
import { workerRuntimeOptions } from "../../../src/runtimes.ts";
import { OPUS_ROUTE, SOL_ROUTE } from "../../../src/route.ts";
import { settled, world } from "./fixture.ts";

for (const route of [OPUS_ROUTE, SOL_ROUTE]) {
  for (const startup of [true, false]) {
    test(`${route.account?.name} pi review commits with a store refused ${startup ? "at startup" : "after open"}`, async () => {
      const at = scratch();
      const scope = await Effect.runPromise(Scope.make());
      let run: Awaited<ReturnType<typeof world>> | undefined;
      let opened:
        | Awaited<ReturnType<Awaited<ReturnType<typeof world>>["open"]>>
        | undefined;
      try {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const store = yield* AccountStore.make(at.home);
              yield* store.add("claude", "named");
            }),
          ),
        );
        const folder = AccountStore.neuveFolder(at.home);
        if (startup) chmodSync(folder, 0o775);
        const registry = await Effect.runPromise(
          Effect.gen(function* () {
            // Built in the test's scope, as the worker keeps it for the process.
            const directory = Context.get(
              yield* Layer.build(
                workerRuntimeOptions(at.home).accountDirectory,
              ),
              AccountDirectory,
            );
            if (!startup)
              expect(
                yield* directory.lookup(AccountName.parse("named"), "use"),
              ).toBeDefined();
            chmodSync(folder, 0o775);
            return yield* RuntimeRegistry.pipe(
              Effect.provide(
                runtimeRegistryLayer([piStatusRuntime()]).pipe(
                  Layer.provide(Layer.succeed(AccountDirectory, directory)),
                ),
              ),
            );
          }).pipe(Effect.provideService(Scope.Scope, scope)),
        );
        run = await world(
          `store-refused-${route.account?.name}-${startup}`,
          6,
          false,
          false,
          "faux",
          undefined,
          false,
          undefined,
          { runtimes: registry },
        );
        run.ctx.config.route = route;
        run.script.push(() =>
          fauxAssistantMessage([fauxToolCall("submit_frame", { answer: 7 })], {
            stopReason: "toolUse",
          }),
        );
        opened = await run.open();
        const id = await run.start(opened);
        await opened.harness.resume();
        expect(await settled(opened.harness, id)).toMatchObject({
          status: "computed",
        });
        expect(run.sent).toHaveLength(1);
        expect(run.probes).toEqual([]);
        expect(run.runtime.sessionOpens()).toBe(0);
      } finally {
        if (opened) await opened.harness.close(context);
        if (run) await Effect.runPromise(Scope.close(run.scope, Exit.void));
        await Effect.runPromise(Scope.close(scope, Exit.void));
        chmodSync(AccountStore.neuveFolder(at.home), 0o755);
        at.close();
      }
    });
  }
}
