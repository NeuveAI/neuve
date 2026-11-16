import { captureOutlineSource } from "../src/graph-outline.ts";
// Why: PC13 lets a review reuse the leads commit preparation searched only when the range's hunk
// has the same text and its file is unchanged in the range's base tree. Reusing them under any
// other condition would hand Investigate leads for code that is not the reviewed code, and nothing
// downstream would notice; never reusing them would silently redo commit-time work. This prepares
// two commits of a small repository and checks which of a range's hunks reuse their leads.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer } from "effect";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import { prepareCommit } from "../src/commit-prepare.ts";
import { treeOf } from "../src/git-objects.ts";
import {
  defaultManifestSettings,
  leadsByHunk,
  rangeManifest,
} from "../src/manifest.ts";

const directory = mkdtempSync(join(tmpdir(), "harness-leads-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const repository = join(directory, "repo");
const run = (...args: Array<string>) => {
  const result = Bun.spawnSync(["git", "-C", repository, ...args], {
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
};

const source = (changes: Record<number, string>) =>
  Array.from({ length: 40 }, (_, index) => {
    const line = index + 1;
    return (
      changes[line] ??
      `export const value${line} = computeValue(${line}, "label ${line}");`
    );
  }).join("\n") + "\n";

const commit = (message: string, text: string) => {
  writeFileSync(join(repository, "values.ts"), text);
  run("add", "values.ts");
  run(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.test",
    "commit",
    "-q",
    "-m",
    message,
  );
  return run("rev-parse", "HEAD");
};

test("a range reuses file leads only when both blobs match", async () => {
  Bun.spawnSync(["git", "init", "-q", repository]);
  writeFileSync(
    join(repository, "notes.md"),
    "# Values\n\ncomputeValue labels each value.\n",
  );
  run("add", "notes.md");
  const c1 = commit("values", source({}));
  const c2 = commit(
    "change line 5",
    source({ 5: `export const value5 = computeValue(5, "renamed five");` }),
  );
  const c3 = commit(
    "change line 30",
    source({
      5: `export const value5 = computeValue(5, "renamed five");`,
      30: `export const value30 = computeValue(30, "renamed thirty");`,
    }),
  );
  const location = storeLocationIn(join(directory, "store"));
  const result = await Effect.runPromise(
    Effect.andThen(
      Store.prepareForWrite,
      Effect.gen(function* () {
        for (const oid of [c3, c2])
          yield* prepareCommit(
            { repository },
            {
              oid,
              parents: [run("rev-parse", `${oid}^`)],
              tree: yield* treeOf(repository, oid),
            },
          );
        const settings = defaultManifestSettings(1_000_000);
        const whole = yield* rangeManifest(
          repository,
          { baseOid: c1, headOid: c3 },
          settings,
          captureOutlineSource(),
        );
        const last = yield* rangeManifest(
          repository,
          { baseOid: c2, headOid: c3 },
          settings,
          captureOutlineSource(),
        );
        return {
          whole: whole.value,
          wholeLeads: leadsByHunk(whole.leads.value),
          last: last.value,
          lastLeads: leadsByHunk(last.leads.value),
        };
      }),
    ).pipe(
      Effect.provide(
        Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
      ),
      Effect.provide(Store.layer(location, { create: true })),
      Effect.provide(BunFileSystem.layer),
    ),
  );
  const sourceAt = (
    manifest: typeof result.whole,
    leads: typeof result.wholeLeads,
    line: number,
  ) => {
    const hunk = manifest.hunks.find(
      (entry) =>
        entry.newStart <= line && entry.newStart + entry.newLines > line,
    );
    return hunk === undefined ? undefined : leads.get(hunk.hunkId)?.source;
  };
  // c1..c3 has a new head blob: both hunks belong to a new file pair.
  expect(sourceAt(result.whole, result.wholeLeads, 5)).toBe("searched");
  // The line-30 hunk is c3's text, but c3's leads were keyed by c2's blob, not the base's c1 blob.
  expect(sourceAt(result.whole, result.wholeLeads, 30)).toBe("searched");
  // c2..c3: the base blob is c2's, so c3's commit-time leads apply.
  expect(sourceAt(result.last, result.lastLeads, 30)).toBe("cached");
  // Each hunk's owned ranges come from the shared review rules, with their side.
  const five = result.whole.hunks.find(
    (hunk) => hunk.newStart <= 5 && hunk.newStart + hunk.newLines > 5,
  );
  expect(five?.ownedRanges).toEqual([
    { side: "old", startLine: 5, lineCount: 1 },
    { side: "new", startLine: 5, lineCount: 1 },
  ]);
}, 60_000);
