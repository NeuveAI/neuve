import { test, expect } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  readdirSync,
  copyFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect, Layer } from "effect";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import { SharedWork } from "@neuve/records-core/shared-work";
import { treeIndex } from "../src/search-index.ts";
import { CodeWork } from "../src/code-work.ts";
import { PublicationPolicy } from "../src/shared-publication.ts";
import { publicationHost } from "./fixtures/publication-host.ts";

test("a local warm hit after the disclosed floor needs no publication host", async () => {
  let warm = false;
  const result = await new SharedWork<number>().run({
    scope: "warm-floor",
    key: "key",
    crossProcess: {
      store: "warm-floor",
      transport: {
        claim: async () => {
          warm = true;
          return { kind: "floor", reason: "unreachable" };
        },
      },
      read: async () => undefined,
      local: {
        read: async () => (warm ? { value: 42 } : undefined),
        publish: async () => {
          throw new Error("A floor has no publication host");
        },
      },
    },
    run: async () => {
      throw new Error("Warm value must not be materialized");
    },
  });
  expect(result).toEqual({
    outcome: { kind: "succeeded", value: 42 },
    floor: "unreachable",
  });
});
// B4: this is the real snapshot handoff, with a joined subscriber and no index materialization.
test("a warm snapshot appearing before the grant has a readable joined publication", async () => {
  const root = mkdtempSync(join(tmpdir(), "warm-publication-")),
    prior = process.env.NEUVE_BUDGET_DIRECTORY,
    original = SharedWork.prototype.run;
  const host = publicationHost(root);
  process.env.NEUVE_BUDGET_DIRECTORY = join(root, "budget");
  try {
    const git = (args: string[], input?: string) => {
      const child = Bun.spawnSync(["git", "-C", root, ...args], {
        ...(input === undefined
          ? {}
          : { stdin: new TextEncoder().encode(input) }),
      });
      if (child.exitCode) throw new Error(child.stderr.toString());
      return child.stdout.toString().trim();
    };
    git(["init", "-q"]);
    const blob = git(
      ["hash-object", "-w", "--stdin"],
      "# Warm snapshot\n\nDocument text.\n",
    );
    const tree = git(["mktree"], `100644 blob ${blob}\tREADME.md\n`);
    const seed = join(root, "seed-work"),
      work = join(root, "request-work");
    const child = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "fixtures/publication-snapshot.ts"),
        root,
        tree,
        seed,
      ],
      {
        env: {
          ...process.env,
          NEUVE_BUDGET_DIRECTORY: join(root, "seed-budget"),
        },
      },
    );
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    const seedFolder = join(seed, "code-work", "indexes"),
      snapshot = readdirSync(seedFolder).find((name) =>
        name.endsWith(".index"),
      );
    if (!snapshot) throw new Error("No snapshot");
    const executable = join(root, "missing-engine"),
      source = { executable, key: { unavailable: executable } };
    type Result = z.infer<typeof ResultSchema>;
    let intercepted = false,
      materializations = 0,
      subscriber:
        | Promise<
            import("@neuve/records-core/shared-work").SharedResult<
              Result,
              unknown
            >
          >
        | undefined;
    const waiting = Promise.withResolvers<void>(),
      settled: string[] = [];
    SharedWork.prototype.run = new Proxy(original, {
      apply(target, receiver, args) {
        const options: Parameters<typeof original>[0] = args[0];
        if (
          intercepted ||
          !options.key.startsWith("tree-index@1") ||
          !options.crossProcess
        )
          return Reflect.apply(target, receiver, args);
        intercepted = true;
        const cross = options.crossProcess;
        return Reflect.apply(target, receiver, [
          {
            ...options,
            crossProcess: {
              ...cross,
              transport: {
                claim: async (
                  request: Parameters<typeof host.transport.claim>[0],
                ) => {
                  const connected = await host.transport.claim(request);
                  if (connected.kind !== "connected")
                    throw new Error("No host");
                  const settle = connected.claim.settle;
                  connected.claim.settle = async (kind, publication) => {
                    settled.push(publication);
                    await settle(kind, publication);
                  };
                  // The shared reader is exactly the production closure, not a test result or receipt decoder.
                  const remote = new SharedWork<unknown, unknown>().run({
                    scope: options.scope,
                    key: options.key,
                    onEvent: (event) => {
                      if (event.role === "waiter") waiting.resolve();
                    },
                    crossProcess: { ...cross, transport: host.transport },
                    run: async () => {
                      throw new Error("Unexpected remote producer");
                    },
                  });
                  subscriber = remote.then((result) => {
                    if (result.outcome.kind !== "succeeded")
                      return {
                        outcome: {
                          kind: "failed" as const,
                          error: result.outcome.error,
                        },
                      };
                    const parsed = ResultSchema.parse(result.outcome.value);
                    return {
                      outcome: { kind: "succeeded" as const, value: parsed },
                    };
                  });
                  await waiting.promise;
                  const destination = join(work, "code-work", "indexes");
                  mkdirSync(destination, { recursive: true });
                  copyFileSync(
                    join(seedFolder, snapshot),
                    join(destination, snapshot),
                  );
                  return connected;
                },
              },
            },
            run: async (signal: AbortSignal) => {
              materializations++;
              return options.run(signal);
            },
          },
        ]);
      },
    });
    const location = storeLocationIn(join(root, "records"));
    const layer = Computations.layer.pipe(
      Layer.provideMerge(Blobs.layer(location)),
      Layer.provideMerge(
        Layer.effectDiscard(Store.prepareForWrite).pipe(
          Layer.provideMerge(Store.layer(location, { create: true })),
        ),
      ),
      Layer.provideMerge(BunFileSystem.layer),
    );
    const owner = await Effect.runPromise(
      treeIndex(root, tree, source).pipe(
        Effect.provideService(CodeWork, { directory: work, background: false }),
        Effect.provideService(PublicationPolicy, {
          ...PublicationPolicy.defaultValue(),
          authority: host.authority,
        }),
        Effect.provide(layer),
      ),
    );
    const remote = await subscriber;
    expect(owner.cached).toBe(true);
    expect(owner.index.tree).toBe(tree);
    expect(materializations).toBe(0);
    expect(settled).toHaveLength(1);
    expect(settled[0]).not.toBe("completed");
    expect(remote?.outcome.kind).toBe("succeeded");
    if (remote?.outcome.kind === "succeeded") {
      expect(remote.outcome.value.index.tree).toBe(tree);
      expect(remote.outcome.value.index.chunks.length).toBeGreaterThan(0);
    }
  } finally {
    SharedWork.prototype.run = original;
    host.host.close();
    if (prior === undefined) delete process.env.NEUVE_BUDGET_DIRECTORY;
    else process.env.NEUVE_BUDGET_DIRECTORY = prior;
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
import { z } from "zod";
// Assert observable content without a cast from the generic shared-work interception.
const ResultSchema = z.object({
  cached: z.boolean(),
  index: z
    .object({ tree: z.string(), chunks: z.array(z.unknown()) })
    .passthrough(),
});
