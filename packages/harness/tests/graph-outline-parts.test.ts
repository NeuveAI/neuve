// Why: an outline read of a whole size group was one shared publication by value, and on this
// repository one was 294 MB against a 128 MiB limit. The run that computed it then failed its own
// caller, who retried. The holder must keep its answer, and a read must come in parts that fit,
// each its own shared work (record 0016), run a few at a time within the CPU budget.
import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import * as GraphClient from "@neuve/graph-client";
import {
  SharedWork,
  type SharedWorkEvent,
} from "@neuve/records-core/shared-work";
import { graphTestPrerequisite } from "../../../scripts/graph-test-prerequisite.ts";
import { CpuWork } from "../src/budget/cpu.ts";
import { Scheduler } from "../src/budget/scheduler.ts";
import * as Outline from "../src/graph-outline.ts";
import { PublicationPolicy } from "../src/shared-publication.ts";
import { publicationHost } from "./fixtures/publication-host.ts";

const {
  OUTLINE_PART_CONCURRENCY,
  captureOutlineSource,
  outlineExecutable,
  outlineParts,
  outlineReadKey,
  readOutlines,
  readOutlinesWithBudget,
} = Outline;
// A second copy of the module has its own keys in flight: to the host it is another process.
const elsewhere: typeof Outline = await import(
  `../src/graph-outline.ts?${"elsewhere"}`
);

const graph = graphTestPrerequisite({
  available: existsSync(outlineExecutable()),
  message:
    "Graph engine is missing at apps/neuve-graph/entire-graph. Run `bun run build:graph` from the workspace root.",
});

const file = (index: number) => ({
  path: `src/m${String(index).padStart(2, "0")}.ts`,
  bytes: new TextEncoder().encode(
    Array.from(
      { length: 40 },
      (_, line) =>
        `export function f${index}_${line}(x: number) { return x + ${line}; }`,
    ).join("\n") + "\n",
  ),
});
const files = Array.from({ length: 12 }, (_, index) => file(index));
/** Parts of two or three of these files, each publication a small fraction of this limit. */
const SMALL = 320 * 1024;
const run1 = <A>(run: (permits: number) => Promise<A>) => run(1);
/**
 * Graph labels symbol ids with a digest of the files it read together, as its own batches already
 * did: no caller stores the label, so answers from different reads compare without it.
 */
const unlabelled = (value: unknown) =>
  JSON.parse(
    JSON.stringify(value).replace(
      /local\/source-[0-9a-f]{64}/g,
      "local/source",
    ),
  );
const pathsOf = (part: ReadonlyArray<{ file: { path: string } }>) =>
  part.map(({ file }) => file.path).join(",");

/** Engine calls, held until `release` (or their abort) when `held`; every call is counted. */
const engine = (held: boolean, hold?: (call: number) => Promise<void>) => {
  const original = GraphClient.readGraphSymbols;
  const releases: Array<() => void> = [];
  const wake: Array<() => void> = [];
  const state = {
    calls: 0,
    inFlight: 0,
    most: 0,
    paths: [] as string[],
    aborted: [] as boolean[],
  };
  const notify = () => {
    for (const check of wake.splice(0)) check();
  };
  const spy = spyOn(GraphClient, "readGraphSymbols").mockImplementation(
    async (...args: Parameters<typeof original>) => {
      const [input] = args;
      const call = ++state.calls;
      state.inFlight++;
      state.most = Math.max(state.most, state.inFlight);
      state.paths.push(input.files.map((one) => one.path).join(","));
      notify();
      try {
        if (held)
          await new Promise<void>((resolve) => {
            releases.push(resolve);
            input.signal?.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
        await hold?.(call);
        input.signal?.throwIfAborted();
        return await original(...args);
      } finally {
        state.aborted.push(input.signal?.aborted ?? false);
        state.inFlight--;
        notify();
      }
    },
  );
  return {
    state,
    until: (ready: () => boolean) =>
      new Promise<void>((resolve) => {
        const check = () => (ready() ? resolve() : wake.push(check));
        check();
      }),
    release: () => {
      held = false;
      for (const resolve of releases.splice(0)) resolve();
    },
    restore: () => spy.mockRestore(),
  };
};

/** Counts callers that subscribed to another caller's run. */
const waiters = () => {
  const original = SharedWork.prototype.run;
  const wake: Array<() => void> = [];
  const state = { waiters: 0 };
  const spy = spyOn(SharedWork.prototype, "run").mockImplementation(
    new Proxy(original, {
      apply(target, receiver, args: Parameters<typeof original>) {
        const [options] = args;
        return Reflect.apply(target, receiver, [
          {
            ...options,
            onEvent: (event: SharedWorkEvent) => {
              options.onEvent?.(event);
              if (event.role === "waiter") {
                state.waiters++;
                for (const check of wake.splice(0)) check();
              }
            },
          },
        ]);
      },
    }),
  );
  return {
    state,
    until: (count: number) =>
      new Promise<void>((resolve) => {
        const check = () =>
          state.waiters >= count ? resolve() : wake.push(check);
        check();
      }),
    restore: () => spy.mockRestore(),
  };
};

const withHost = async (
  work: (
    policy: ReturnType<typeof PublicationPolicy.defaultValue>,
  ) => Promise<void>,
) => {
  const root = mkdtempSync(join(tmpdir(), "outline-parts-")),
    prior = process.env.NEUVE_BUDGET_DIRECTORY,
    host = publicationHost(root);
  process.env.NEUVE_BUDGET_DIRECTORY = root;
  try {
    await work({
      ...PublicationPolicy.defaultValue(),
      authority: host.authority,
    });
  } finally {
    host.host.close();
    if (prior === undefined) delete process.env.NEUVE_BUDGET_DIRECTORY;
    else process.env.NEUVE_BUDGET_DIRECTORY = prior;
    rmSync(root, { recursive: true, force: true });
  }
};

test.skipIf(graph.skip)(
  "the holder keeps an outline it cannot publish; a subscriber elsewhere gets the recorded failure, disclosed once",
  async () => {
    graph.require();
    await withHost(async (policy) => {
      // Any observation is over this limit, so every publication fails.
      const tiny = { ...policy, maximumBytes: 2048 };
      const input = [file(0)],
        path = input[0]!.path,
        source = captureOutlineSource();
      const calls = engine(true),
        roles = waiters(),
        warnings = spyOn(console, "warn");
      try {
        const holder = readOutlines(
          input,
          source,
          undefined,
          run1,
          false,
          tiny,
        );
        await calls.until(() => calls.state.calls === 1);
        const other = elsewhere.readOutlines(
          input,
          source,
          undefined,
          run1,
          false,
          tiny,
        );
        await roles.until(1);
        // In this process a second caller awaits the same run, not a publication.
        const beside = readOutlines(
          input,
          source,
          undefined,
          run1,
          false,
          tiny,
        );
        await roles.until(2);
        calls.release();
        const kept = await holder;
        expect(kept.context(path).kind).toBe("available");
        expect((await beside).context(path)).toEqual(kept.context(path));
        await expect(other).rejects.toMatchObject({
          tag: "PublicationTooLarge",
        });
        expect(calls.state.calls).toBe(1);
        const disclosed = warnings.mock.calls.filter(([line]) =>
          String(line).includes('"type":"graph-outline.publication-failed"'),
        );
        expect(disclosed).toHaveLength(1);
        expect(JSON.parse(String(disclosed[0]![0]))).toMatchObject({
          tag: "PublicationTooLarge",
          maximum: 2048,
          files: 1,
        });
        expect(JSON.parse(String(disclosed[0]![0])).bytes).toBeGreaterThan(
          2048,
        );
      } finally {
        calls.release();
        calls.restore();
        roles.restore();
        warnings.mockRestore();
      }
    });
  },
  30_000,
);

test.skipIf(graph.skip)(
  "a read over its bound comes in parts, each its own key, and the merged answer is one whole read's, file by file",
  async () => {
    graph.require();
    await withHost(async (policy) => {
      const source = captureOutlineSource(),
        small = { ...policy, maximumBytes: SMALL };
      const parts = outlineParts(files, {}, SMALL);
      expect(parts.length).toBeGreaterThan(2);
      // The same files in any order give the same parts.
      expect(
        outlineParts([...files].reverse(), {}, SMALL).map(pathsOf),
      ).toEqual(parts.map(pathsOf));
      const keys = parts.map(
        (part) =>
          outlineReadKey(
            part.map(({ file }) => file),
            source,
          ).key,
      );
      expect(new Set(keys).size).toBe(parts.length);
      expect(keys).not.toContain(outlineReadKey(files, source).key);
      // The whole group fits one part under the real limit: the read it always was.
      expect(outlineParts(files, {}, policy.maximumBytes)).toHaveLength(1);
      const calls = engine(false);
      try {
        const parted = await readOutlines(
          files,
          source,
          undefined,
          run1,
          false,
          small,
          { concurrency: 2 },
        );
        expect([...calls.state.paths].sort()).toEqual(
          parts.map(pathsOf).sort(),
        );
        const whole = await readOutlines(
          files,
          source,
          undefined,
          run1,
          false,
          policy,
        );
        expect(calls.state.calls).toBe(parts.length + 1);
        for (const path of [...files.map((one) => one.path), "absent.ts"])
          expect(unlabelled(parted.context(path))).toEqual(
            unlabelled(whole.context(path)),
          );
        expect(
          files.every((one) => parted.context(one.path).kind === "available"),
        ).toBe(true);
        expect(parted.tokensUnsupported).toBe(false);
      } finally {
        calls.restore();
      }
    });
  },
  60_000,
);

test.skipIf(graph.skip)(
  "two callers in different processes asking for the same read at once start each part once",
  async () => {
    graph.require();
    await withHost(async (policy) => {
      const source = captureOutlineSource(),
        small = { ...policy, maximumBytes: SMALL },
        parts = outlineParts(files, {}, SMALL);
      const roles = waiters();
      // Each part's run waits until the other caller subscribed to one more run.
      const calls = engine(false, (call) => roles.until(call));
      try {
        const [here, there] = await Promise.all([
          readOutlines(files, source, undefined, run1, false, small, {
            concurrency: 2,
          }),
          elsewhere.readOutlines(files, source, undefined, run1, false, small, {
            concurrency: 2,
          }),
        ]);
        expect(calls.state.calls).toBe(parts.length);
        expect(roles.state.waiters).toBe(parts.length);
        for (const one of files)
          expect(there.context(one.path)).toEqual(here.context(one.path));
      } finally {
        calls.restore();
        roles.restore();
      }
    });
  },
  60_000,
);

test.skipIf(graph.skip)(
  "two callers whose reads overlap share the parts they have in common",
  async () => {
    graph.require();
    await withHost(async (policy) => {
      const source = captureOutlineSource(),
        small = { ...policy, maximumBytes: SMALL };
      // Another grouping: the same files after the first three.
      const later = files.slice(3);
      const ours = outlineParts(files, {}, SMALL).map(pathsOf),
        theirs = outlineParts(later, {}, SMALL).map(pathsOf);
      const common = ours.filter((part) => theirs.includes(part));
      const union = new Set([...ours, ...theirs]);
      expect(common.length).toBeGreaterThan(0);
      expect(union.size).toBeLessThan(ours.length + theirs.length);
      const roles = waiters();
      // Every part is claimed at once; runs start only when the common ones have their subscriber.
      const calls = engine(false, () =>
        Promise.all([
          roles.until(common.length),
          calls.until(() => calls.state.calls >= union.size),
        ]).then(() => {}),
      );
      try {
        const [whole, part] = await Promise.all([
          readOutlines(files, source, undefined, run1, false, small, {
            concurrency: 16,
          }),
          elsewhere.readOutlines(later, source, undefined, run1, false, small, {
            concurrency: 16,
          }),
        ]);
        expect(calls.state.calls).toBe(union.size);
        expect([...calls.state.paths].sort()).toEqual([...union].sort());
        for (const one of later)
          expect(unlabelled(part.context(one.path))).toEqual(
            unlabelled(whole.context(one.path)),
          );
      } finally {
        calls.restore();
        roles.restore();
      }
    });
  },
  60_000,
);

test.skipIf(graph.skip)(
  "within the CPU budget at most the fixed number of parts run at once, one inside an inherited grant, and cancellation stops the rest",
  async () => {
    graph.require();
    await withHost(async (policy) => {
      const source = captureOutlineSource(),
        small = { ...policy, maximumBytes: SMALL },
        parts = outlineParts(files, {}, SMALL);
      expect(parts.length).toBeGreaterThan(OUTLINE_PART_CONCURRENCY);
      const budget = new Scheduler(4);
      const read = (inherited: boolean, signal?: AbortSignal) =>
        Effect.runPromise(
          readOutlinesWithBudget(files, "outline-parts", source).pipe(
            Effect.provideService(CpuWork, {
              budget,
              priority: {
                class: "interactive",
                position: "understand",
                stage: 0,
              },
              inherited,
              ...(inherited ? { permits: 2 } : {}),
            }),
            Effect.provideService(PublicationPolicy, small),
          ),
          signal ? { signal } : undefined,
        );
      // Each run waits for a second one in flight, or for the last part.
      const open = engine(false, () =>
        open.until(
          () =>
            open.state.inFlight >= OUTLINE_PART_CONCURRENCY ||
            open.state.calls === parts.length,
        ),
      );
      try {
        const answer = await read(false);
        expect(open.state.calls).toBe(parts.length);
        expect(open.state.most).toBe(OUTLINE_PART_CONCURRENCY);
        expect(
          files.every((one) => answer.context(one.path).kind === "available"),
        ).toBe(true);
      } finally {
        open.restore();
      }
      // A grant this read inherits is already spent: its parts take turns. New keys: a new engine copy.
      const inherited = engine(false);
      try {
        process.env.NEUVE_BUDGET_DIRECTORY = join(
          process.env.NEUVE_BUDGET_DIRECTORY!,
          "inherited",
        );
        await read(true);
        expect(inherited.state.calls).toBe(parts.length);
        expect(inherited.state.most).toBe(1);
      } finally {
        inherited.restore();
      }
      process.env.NEUVE_BUDGET_DIRECTORY = join(
        process.env.NEUVE_BUDGET_DIRECTORY!,
        "cancelled",
      );
      const held = engine(true);
      try {
        const controller = new AbortController();
        const cancelled = read(false, controller.signal);
        await held.until(() => held.state.calls === OUTLINE_PART_CONCURRENCY);
        controller.abort();
        await expect(cancelled).rejects.toBeDefined();
        // Nobody else wanted the parts in flight: both runs stopped, and no later part started.
        await held.until(() => held.state.inFlight === 0);
        expect(held.state.calls).toBe(OUTLINE_PART_CONCURRENCY);
        expect(held.state.aborted).toEqual([true, true]);
      } finally {
        held.release();
        held.restore();
      }
    });
  },
  60_000,
);
