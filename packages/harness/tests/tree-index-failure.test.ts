import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Cause, Deferred, Effect, Exit, Fiber, Option } from "effect";
import { Computations, storeLocationIn } from "@neuve/records-core";
import { SharedWork } from "@neuve/records-core/shared-work";
import { treeIndex } from "../src/search-index.ts";
import { runIn, value } from "./pi/capture/fixture.ts";

// A producer's typed failure and a subscriber's recorded failure must keep their retry contracts.
test("a failed shared tree build preserves the producer cause and records the subscriber failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "tree-failure-"));
  const original = SharedWork.prototype.run;
  const git = (args: string[], input?: string) => {
    const child = Bun.spawnSync(["git", "-C", root, ...args], {
      ...(input === undefined
        ? {}
        : { stdin: new TextEncoder().encode(input) }),
    });
    if (child.exitCode !== 0) throw new Error(child.stderr.toString());
    return child.stdout.toString().trim();
  };
  try {
    git(["init", "-q"]);
    const blob = git(["hash-object", "-w", "--stdin"], "export const n = 1;\n");
    const tree = git(["mktree"], `100644 blob ${blob}\tunit.ts\n`);
    const executable = join(root, "missing-engine");
    const source = { executable, key: { unavailable: executable } };
    value(
      await runIn(storeLocationIn(join(root, "records")))(
        Effect.gen(function* () {
          const store = yield* Computations.ComputationStore;
          const started = yield* Deferred.make<void>();
          const subscribed = yield* Deferred.make<void>();
          const resume = yield* Deferred.make<void>();
          let attempts = 0;
          const injected = new Computations.SharedAttemptFailed({
            key: "fixture-blob",
            attemptId: "fixture-attempt",
            tag: "Fixture",
            message: "index-fixture-failed",
          });
          const failing: Computations.ComputationStore["Service"] = {
            ...store,
            run: (spec, compute) =>
              spec.op !== "harness.blob-chunks"
                ? store.run(spec, compute)
                : Effect.gen(function* () {
                    attempts++;
                    yield* Deferred.succeed(started, undefined);
                    yield* Deferred.await(resume);
                    return yield* Effect.fail(injected);
                  }),
          };
          let callers = 0;
          SharedWork.prototype.run = new Proxy(original, {
            apply(target, receiver, args) {
              const options: Parameters<typeof original>[0] = args[0];
              const pending = Reflect.apply(target, receiver, args);
              if (
                options.key.startsWith("tree-index@1") &&
                options.key.includes(JSON.stringify(source.key)) &&
                ++callers === 2
              )
                Deferred.doneUnsafe(subscribed, Exit.void);
              return pending;
            },
          });
          const producer = yield* Effect.forkChild(
            Effect.exit(
              treeIndex(root, tree, source).pipe(
                Effect.provideService(Computations.ComputationStore, failing),
              ),
            ),
          );
          yield* Deferred.await(started);
          const subscriber = yield* Effect.forkChild(
            Effect.exit(treeIndex(root, tree, source)),
          );
          yield* Deferred.await(subscribed);
          yield* Deferred.succeed(resume, undefined);
          const first = yield* Fiber.join(producer),
            second = yield* Fiber.join(subscriber);
          expect(Exit.isFailure(first)).toBe(true);
          expect(Exit.isFailure(second)).toBe(true);
          if (Exit.isFailure(first) && Exit.isFailure(second)) {
            const owned = Option.getOrUndefined(
              Cause.findErrorOption(first.cause),
            );
            const recorded = Option.getOrUndefined(
              Cause.findErrorOption(second.cause),
            );
            expect(owned).toBe(injected);
            expect(recorded).toBeInstanceOf(Computations.SharedAttemptFailed);
            if (recorded instanceof Computations.SharedAttemptFailed)
              expect(recorded.message).toContain("index-fixture-failed");
          }
          expect(attempts).toBe(1);
        }).pipe(Effect.provide(Computations.layer)),
      ),
    );
  } finally {
    SharedWork.prototype.run = original;
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);
