import { captureOutlineSource } from "../../src/graph-outline.ts";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Exit, Layer, Scope } from "effect";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import {
  defaultManifestSettings,
  frontSettings,
  type ManifestHunk,
  type RangeManifest,
} from "../../src/manifest.ts";
import { diffTrees, lsTree, readBlobs, treeOf } from "../../src/git-objects.ts";
import { describeHunks } from "../../src/hunks.ts";
import { readDeclarations } from "../../src/declarations.ts";

export const hunk = (path: string, id = path): ManifestHunk => ({
  hunkId: id,
  kind: "text",
  path,
  oldPath: path,
  newPath: path,
  oldOid: null,
  newOid: null,
  status: "modified",
  oldMode: "100644",
  newMode: "100644",
  oldStart: 1,
  oldLines: 1,
  newStart: 1,
  newLines: 1,
  added: 1,
  deleted: 1,
  text: "@@ -1 +1 @@\n-old\n+new\n",
  textSha256: "0".repeat(64),
  enclosing: null,
  query: null,
  ownedRanges: [],
  qualifications: [],
  declared: [],
  countsTowardReviewLines: true,
  allowance: { tokens: 0, exactShare: 0, floored: false },
});
export const manifest = (hunks: ManifestHunk[]): RangeManifest => ({
  range: {
    baseOid: "a".repeat(40),
    headOid: "b".repeat(40),
    mergeBase: "a".repeat(40),
    baseTree: "c".repeat(40),
    headTree: "d".repeat(40),
  },
  settings: frontSettings(defaultManifestSettings(400_000)),
  files: new Set(hunks.map((h) => h.path)).size,
  reviewLines: hunks.reduce((n, h) => n + h.added + h.deleted, 0),
  hunks,
  facts: [],
  declarations: { readers: [], gaps: [] },
  limitations: [],
});
export const realManifest = async (
  repository: string,
  base: string,
  head: string,
  directory: string,
) => {
  const location = storeLocationIn(directory),
    scope = await Effect.runPromise(Scope.make());
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
  try {
    await Effect.runPromise(Effect.provide(Store.prepareForWrite, records));
    return await Effect.runPromise(
      Effect.gen(function* () {
        const files = yield* diffTrees(repository, base, head);
        const hunks = yield* describeHunks(
          repository,
          files,
          captureOutlineSource(),
        );
        const tree = yield* lsTree(repository, head);
        const contents = yield* readBlobs(
          repository,
          files.flatMap((f) => (f.newOid === null ? [] : [f.newOid])),
        );
        const declarations = yield* readDeclarations({
          repository,
          revision: head,
          tree,
          paths: [...new Set(hunks.map((h) => h.path))],
          contents,
        });
        const value = manifest(
          hunks.map((h) => ({
            ...hunk(h.path, h.hunkId),
            ...h,
            declared: [...(declarations.byPath.get(h.path) ?? [])],
          })),
        );
        return {
          ...value,
          range: {
            baseOid: base,
            headOid: head,
            mergeBase: base,
            baseTree: yield* treeOf(repository, base),
            headTree: yield* treeOf(repository, head),
          },
        };
      }).pipe(Effect.provide(records)),
    );
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)));
  }
};
