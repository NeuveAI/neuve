import { captureOutlineSource } from "../src/graph-outline.ts";
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer } from "effect";
import {
  Blobs,
  Computations,
  JobQueue,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import { fileHunks } from "../src/manifest.ts";
import { describeHunks } from "../src/hunks.ts";
import { diffTrees } from "../src/git-objects.ts";
const directory = mkdtempSync(join(tmpdir(), "precompute-attrs-"));
const repository = join(directory, "repo");
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const git = (...args: string[]) => {
  const r = Bun.spawnSync([
    "git",
    "-c",
    "core.hooksPath=/dev/null",
    "-C",
    repository,
    ...args,
  ]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};
Bun.spawnSync(["git", "init", "-q", repository]);
const commit = (m: string) => {
  git("add", ".");
  git(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.test",
    "commit",
    "-qm",
    m,
  );
  return git("rev-parse", "HEAD");
};
const body = (v: number) =>
  "class Foo:\n    x = 0\n\n    def bar(self):\n        a = 1\n        b = 2\n        c = 3\n        d = 4\n        return " +
  v +
  "\n";
writeFileSync(join(repository, "a.py"), body(1));
const base = commit("base");
writeFileSync(join(repository, "a.py"), body(2));
const c1 = commit("change a.py");
writeFileSync(join(repository, ".gitattributes"), "*.py diff=python\n");
const head = commit("python hunk headers");
const inStore = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
  const location = storeLocationIn(join(directory, "store"));
  return Effect.andThen(Store.prepareForWrite, effect).pipe(
    Effect.provide(
      Layer.mergeAll(
        JobQueue.layer,
        Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
      ),
    ),
    Effect.provide(Store.layer(location, { create: true })),
    Effect.provide(BunFileSystem.layer),
  );
};
// Why: target-tree attributes change hunk headers even when both file blobs stay identical.
test("cached hunks use the reviewed target tree's function headers and identities", async () => {
  const out = await Effect.runPromise(
    inStore(
      Effect.gen(function* () {
        const commitFiles = yield* diffTrees(repository, base, c1);
        const prepared = yield* fileHunks(
          repository,
          commitFiles,
          captureOutlineSource(),
        ); // as commit.prepare@2 does for c1
        const rangeFiles = (yield* diffTrees(repository, base, head)).filter(
          (f) => f.newPath === "a.py",
        );
        const reused = yield* fileHunks(
          repository,
          rangeFiles,
          captureOutlineSource(),
        ); // the range's a.py, same blob pair
        const fresh = yield* describeHunks(
          repository,
          rangeFiles,
          captureOutlineSource(),
        ); // what the range diff really prints
        return {
          prepared: prepared.map((h) => [h.hunkId, h.text.split("\n")[0]]),
          reused: reused.map((h) => [h.hunkId, h.text.split("\n")[0]]),
          fresh: fresh.map((h) => [h.hunkId, h.text.split("\n")[0]]),
        };
      }),
    ),
  );
  expect(out.reused).toEqual(out.fresh);
  expect(out.prepared).not.toEqual(out.fresh);
});
