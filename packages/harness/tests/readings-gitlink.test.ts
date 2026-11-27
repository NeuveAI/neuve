import { oneBatchPlanMap } from "./fixtures/readings.ts";
// Why (NEU-148, round 17): a review whose head differs from an earlier one only by a submodule
// pointer re-read unchanged sections, because they shared a reading group with the pointer and a
// group's readings are keyed by its whole reading text. These hold, in a real Git repository with
// real gitlink entries, that the pointer is read alone and every other group keeps its key; and
// that a changed neighbour in the same group still makes its unchanged sections be read again.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import {
  Blobs,
  Computations,
  Store,
  mintUlid,
  storeLocationIn,
} from "@neuve/records-core";
import { graphTestPrerequisite } from "../../../scripts/graph-test-prerequisite.ts";
import { defaultConfig } from "../src/config.ts";
import { captureOutlineSource } from "../src/graph-outline.ts";
import { defaultManifestSettings, frontManifest } from "../src/manifest.ts";
import { McpClients, mcpClientsLayer } from "../src/mcp-client.ts";
import { agentStageSpec, storedOutput } from "../src/pipeline.ts";
import { DEFAULT_READING_BOUNDS } from "../src/reading-groups.ts";
import { readingStep } from "../src/pi/stages/reading-task.ts";
import { stageRunner } from "../src/pi/stages/services.ts";
import { storePlan } from "../src/readings/collect.ts";
import { ReadingPlan } from "../src/readings/plan.ts";

const directory = mkdtempSync(join(tmpdir(), "readings-gitlink-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const source = captureOutlineSource();
const graph = graphTestPrerequisite({
  available: "sha256" in source.key,
  message:
    "The Graph engine at NEUVE_GRAPH_OUTLINE_EXECUTABLE (or apps/neuve-graph/entire-graph) is missing: build it, or point the variable at one.",
});

const A_BEFORE = `export function total(values: number[]) {
  let sum = 0;
  for (const value of values) sum += value;
  return sum;
}
`;
const A_AFTER = `export function total(values: number[]) {
  let sum = 0;
  for (const value of values) sum += Math.max(0, value);
  return sum;
}
`;
const B_BEFORE = `export function label(name: string) {
  return name.trim();
}
`;
const B_AFTER = `export function label(name: string) {
  return name.trim().toLowerCase();
}
`;
/** Another change to the neighbour of `lib/a.ts`, in the same reading group. */
const B_OTHER = `export function label(name: string) {
  return name.trim().toUpperCase();
}
`;

const POINTER = {
  base: "1".repeat(40),
  one: "2".repeat(40),
  two: "3".repeat(40),
};

/**
 * A repository with a base commit and heads made from it with plumbing, so each tree holds a real
 * gitlink entry (`160000`) at `lib/vendor` beside two TypeScript files in the same directory.
 */
const repositoryOf = () => {
  const repository = join(directory, "repo");
  mkdirSync(repository, { recursive: true });
  Bun.spawnSync(["git", "init", "-q", repository]);
  const git = (args: Array<string>, stdin?: string) => {
    const out = Bun.spawnSync(["git", "-C", repository, ...args], {
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.test",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.test",
      },
    });
    if (out.exitCode !== 0)
      throw new Error(`git ${args.join(" ")}: ${out.stderr.toString()}`);
    return out.stdout.toString().trim();
  };
  const commit = (
    parent: string | null,
    files: { a: string; b: string; pointer: string },
    message: string,
  ) => {
    git(["read-tree", "--empty"]);
    for (const [path, text] of [
      ["lib/a.ts", files.a],
      ["lib/b.ts", files.b],
    ] as const)
      git([
        "update-index",
        "--add",
        "--cacheinfo",
        `100644,${git(["hash-object", "-w", "--stdin"], text)},${path}`,
      ]);
    git([
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${files.pointer},lib/vendor`,
    ]);
    const tree = git(["write-tree"]);
    return git([
      "commit-tree",
      tree,
      ...(parent === null ? [] : ["-p", parent]),
      "-m",
      message,
    ]);
  };
  const base = commit(
    null,
    { a: A_BEFORE, b: B_BEFORE, pointer: POINTER.base },
    "base",
  );
  const heads = {
    // The change with the pointer as it was.
    still: commit(
      base,
      { a: A_AFTER, b: B_AFTER, pointer: POINTER.base },
      "clamp and lower",
    ),
    // The same change, the pointer moved.
    one: commit(
      base,
      { a: A_AFTER, b: B_AFTER, pointer: POINTER.one },
      "clamp and lower, bump vendor",
    ),
    // The same change, the pointer moved elsewhere: differs from `one` only by the pointer.
    two: commit(
      base,
      { a: A_AFTER, b: B_AFTER, pointer: POINTER.two },
      "clamp and lower, bump vendor again",
    ),
    // `lib/a.ts` as in `one`, its neighbour changed otherwise, the pointer as in `one`.
    neighbour: commit(
      base,
      { a: A_AFTER, b: B_OTHER, pointer: POINTER.one },
      "clamp and upper, bump vendor",
    ),
  };
  return { repository, base, heads };
};

/** Each group of a plan as its paths and member keys. */
const shapeOf = (plan: ReadingPlan) =>
  plan.groups.map((group) => ({
    id: group.id,
    keys: group.keys,
    paths: group.paths,
  }));

// Reason: a pointer-only change must not re-read unchanged code; and carrying a reading is safe
// only because its whole reading text decides reuse, so a changed neighbour still reads again.
test.skipIf(graph.skip)(
  "a submodule pointer is read in a group of its own: heads that differ only by the pointer give every other group the same members and Assess key, and a changed neighbour still reads its group again",
  async () => {
    graph.require();
    const { repository, base, heads } = repositoryOf();
    const location = storeLocationIn(join(directory, "store"));
    const scope = await Effect.runPromise(Scope.make());
    const records = await Effect.runPromise(
      Layer.buildWithScope(
        Computations.layer.pipe(
          Layer.provideMerge(Blobs.layer(location)),
          Layer.provideMerge(Store.layer(location, { create: true })),
          Layer.provideMerge(BunFileSystem.layer),
        ),
        scope,
      ),
    );
    await Effect.runPromise(Effect.provide(Store.prepareForWrite, records));
    const clients = Context.get(
      await Effect.runPromise(
        Layer.buildWithScope(
          mcpClientsLayer({ status: "absent", path: "(none)" }),
          scope,
        ),
      ),
      McpClients,
    );
    const config = defaultConfig();

    /** One head's stored plan, and each of its groups' Assess key as `readingStep` builds it. */
    const reviewOf = async (head: string) => {
      const range = { baseOid: base, headOid: head };
      const ctx = {
        location,
        repository,
        runId: mintUlid(),
        runKey: head.padEnd(64, "0"),
        range: { baseRef: "main", ...range },
        cycleId: mintUlid(),
        config,
        log: { path: "(memory)", write: () => {}, read: () => [] },
        startedAt: Date.now(),
        reconciliationId: mintUlid(),
        records,
      };
      const run = stageRunner(ctx, clients);
      const manifest = await run(
        frontManifest(
          repository,
          range,
          defaultManifestSettings(1_000_000),
          source,
        ),
      );
      const planKey = await run(
        storePlan(ctx, {
          manifestKey: manifest.key,
          bounds: DEFAULT_READING_BOUNDS,
          map: oneBatchPlanMap(manifest),
          manifest: manifest.value,
        }),
      );
      const plan = await run(storedOutput(ctx, planKey, ReadingPlan));
      const assessKeys = new Map<string, string>();
      for (const group of plan.groups) {
        const step = await readingStep(
          ctx,
          run,
          async () => {
            throw new Error("Assess reads no range view");
          },
          {
            kind: "assess",
            params: {
              plan: planKey,
              group: group.id,
              rank: group.rank,
              manifest: manifest.key,
              part: "read",
            },
          },
        );
        assessKeys.set(
          group.id,
          Computations.computationKey(
            agentStageSpec(config, step.spec, {
              op: step.op,
              opVersion: step.opVersion,
              inputs: step.inputs,
            }),
          ).key,
        );
      }
      const pointer = plan.sections.filter((s) => s.path === "lib/vendor");
      return { plan, assessKeys, pointer, hunks: manifest.value.hunks };
    };

    const still = await reviewOf(heads.still);
    const one = await reviewOf(heads.one);
    const two = await reviewOf(heads.two);
    const neighbour = await reviewOf(heads.neighbour);

    // The pointer is a real gitlink in the manifest, read as one section.
    expect(
      one.hunks
        .filter((hunk) => hunk.path === "lib/vendor")
        .map((hunk) => [hunk.oldMode, hunk.newMode]),
    ).toEqual([["160000", "160000"]]);
    expect(one.pointer).toHaveLength(1);
    expect(two.pointer).toHaveLength(1);
    expect(still.pointer).toHaveLength(0);
    // The pointer's own text changed between the two heads, so its key did.
    expect(one.pointer[0]!.key).not.toBe(two.pointer[0]!.key);

    // At each head the pointer is alone in its group; the two code files share another.
    for (const review of [one, two]) {
      const own = review.plan.groups.filter((group) =>
        group.keys.includes(review.pointer[0]!.key),
      );
      expect(own).toHaveLength(1);
      expect(own[0]!.keys).toEqual([review.pointer[0]!.key]);
    }
    const others = (review: typeof one) =>
      shapeOf(review.plan).filter(
        (group) => !group.paths.includes("lib/vendor"),
      );
    expect(others(one)).toHaveLength(1);
    expect(others(one)[0]!.paths).toEqual(["lib/a.ts", "lib/b.ts"]);

    // Every other group is the same at both heads, and as it is with no pointer change at all.
    expect(others(two)).toEqual(others(one));
    expect(others(still)).toEqual(others(one));
    // And so is every other group's Assess key: stored Assess is found again for them.
    for (const group of others(one)) {
      expect(two.assessKeys.get(group.id)).toBe(one.assessKeys.get(group.id)!);
      expect(still.assessKeys.get(group.id)).toBe(
        one.assessKeys.get(group.id)!,
      );
    }
    const pointerGroup = (review: typeof one) =>
      review.plan.groups.find((group) =>
        group.keys.includes(review.pointer[0]!.key),
      )!.id;
    expect(two.assessKeys.get(pointerGroup(two))).not.toBe(
      one.assessKeys.get(pointerGroup(one)),
    );

    // A changed neighbour is no pointer: `lib/a.ts` is unchanged, its section has the same key, but
    // its group's reading text changed with its neighbour, so the group is read again.
    const sectionOfA = (review: typeof one) =>
      review.plan.sections.find((s) => s.path === "lib/a.ts")!.key;
    expect(sectionOfA(neighbour)).toBe(sectionOfA(one));
    const groupOfA = (review: typeof one) =>
      review.plan.groups.find((group) =>
        group.keys.includes(sectionOfA(review)),
      )!;
    expect(groupOfA(neighbour).paths).toEqual(["lib/a.ts", "lib/b.ts"]);
    expect(neighbour.assessKeys.get(groupOfA(neighbour).id)).not.toBe(
      one.assessKeys.get(groupOfA(one).id),
    );
    // The pointer as in `one` keeps its own group's key there.
    expect(neighbour.pointer[0]!.key).toBe(one.pointer[0]!.key);
    expect(neighbour.assessKeys.get(pointerGroup(neighbour))).toBe(
      one.assessKeys.get(pointerGroup(one))!,
    );

    await Effect.runPromise(Scope.close(scope, Exit.void));
  },
  120_000,
);
