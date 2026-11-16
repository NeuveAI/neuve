import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer } from "effect";
import {
  Blobs,
  Computations,
  Store,
  mintUlid,
  storeLocationIn,
} from "@neuve/records-core";
import { defaultConfig } from "../../src/config.ts";
import { Frame } from "../../src/frame.ts";
import { ReviewMap } from "../../src/review-map.ts";
import {
  RangeManifest,
  ManifestHunk,
  defaultManifestSettings,
  frontSettings,
} from "../../src/manifest.ts";
import { RunContext } from "../../src/pipeline.ts";
import { openRunLog } from "../../src/run-log.ts";
import type { BatchInputs } from "../../src/compose.ts";
import { linkChangeMap } from "../../src/link.ts";

export const hunk = (
  id: string,
  path: string,
  start = 10,
  overrides: Partial<ManifestHunk> = {},
): ManifestHunk =>
  ManifestHunk.parse({
    hunkId: id,
    kind: "text",
    path,
    oldPath: path,
    newPath: path,
    oldOid: "a".repeat(40),
    newOid: "b".repeat(40),
    status: "modified",
    oldMode: "100644",
    newMode: "100644",
    oldStart: start,
    oldLines: 3,
    newStart: start,
    newLines: 4,
    added: 1,
    deleted: 0,
    text: `@@ -${start},3 +${start},4 @@\n ctx\n+line of ${id}\n ctx\n ctx\n`,
    textSha256: id,
    enclosing: null,
    query: null,
    ownedRanges: [{ side: "new", startLine: start + 1, lineCount: 1 }],
    qualifications: [],
    declared: [],
    countsTowardReviewLines: true,
    allowance: { tokens: 4000, exactShare: 0, floored: true },
    ...overrides,
  });
export const frame = Frame.parse({
  goal: "Revoked links stop working",
  stratum: "nothing",
  sourceIds: [],
  doneWhen: [
    {
      id: "D1",
      text: "A revoked link is refused",
      basis: "gathered",
      candidateId: null,
      sectionId: null,
    },
  ],
  source: "agent",
  gaps: [],
  inputs: {
    sectionsInlined: 0,
    sectionsListed: 0,
    commitsShown: 1,
    commitsTotal: 1,
  },
});
export const mapOf = (hunks: ManifestHunk[], groupCount = 1): ReviewMap =>
  ReviewMap.parse({
    frame: "frame-key",
    source: "agent",
    groups: Array.from({ length: groupCount }, (_, index) => {
      const paths = [...new Set(hunks.map((hunk) => hunk.path))];
      const own = hunks.filter(
        (hunk) =>
          hunk.path !== "bun.lock" &&
          paths.indexOf(hunk.path) % groupCount === index,
      );
      return {
        id: `g${index + 1}`,
        label: `Group ${index + 1}`,
        why: "Refuse revoked links.",
        tier: "core",
        doneWhen: ["D1"],
        files: [...new Set(own.map((hunk) => hunk.path))].map((path) => ({
          path,
          placedBy: "map",
        })),
        hunkIds: own.map((hunk) => hunk.hunkId),
        changedLines: own.length,
      };
    }),
    excluded: hunks
      .filter((hunk) => hunk.path === "bun.lock")
      .map((hunk) => ({
        path: hunk.path,
        reason: "lockfile",
        by: "code",
        hunkIds: [hunk.hunkId],
      })),
    rolledUp: [],
    unlinkedDoneWhen: [],
    gaps: [],
  });
export const manifestOf = (hunks: ManifestHunk[]): RangeManifest =>
  RangeManifest.parse({
    range: {
      baseOid: "1".repeat(40),
      headOid: "2".repeat(40),
      mergeBase: "1".repeat(40),
      baseTree: "3".repeat(40),
      headTree: "4".repeat(40),
    },
    settings: frontSettings(defaultManifestSettings(1_000_000)),
    files: new Set(hunks.map((h) => h.path)).size,
    reviewLines: hunks.length,
    hunks,
    facts: [],
    declarations: { readers: [], gaps: [] },
    limitations: [],
  });
export const inputsOf = (hunks: ManifestHunk[]): BatchInputs => {
  const manifest = manifestOf(hunks),
    map = mapOf(hunks),
    changeMap = linkChangeMap(frame, map);
  const behaviour = changeMap.behaviours[0];
  if (behaviour === undefined) throw new Error("Fixture has no group");
  return {
    behaviour,
    changeMap,
    manifest,
    hunks: new Map(hunks.map((hunk) => [hunk.hunkId, hunk])),
    snapshot: undefined,
    keys: { manifest: "a".repeat(64), changeMap: "b".repeat(64), scope: null },
  };
};
export const put = (op: string, value: unknown) =>
  Effect.gen(function* () {
    const store = yield* Computations.ComputationStore;
    const result = yield* store.run(
      { op, opVersion: 1, inputs: { test: mintUlid() } },
      Effect.succeed({
        bytes: new TextEncoder().encode(JSON.stringify(value)),
        mediaType: "application/json",
      }),
    );
    return result.computation.key;
  });
export const storeFixture = (name: string) => {
  const directory = mkdtempSync(join(tmpdir(), name));
  afterAll(() => rmSync(directory, { recursive: true, force: true }));
  const location = storeLocationIn(directory);
  const layer = Computations.layer.pipe(
    Layer.provideMerge(Blobs.layer(location)),
    Layer.provideMerge(Store.layer(location, { create: true })),
    Layer.provideMerge(BunFileSystem.layer),
  );
  const run = <A, E>(
    program: Effect.Effect<A, E, Layer.Success<typeof layer>>,
  ) =>
    Effect.runPromise(
      Effect.andThen(Store.prepareForWrite, program).pipe(
        Effect.provide(layer),
      ),
    );
  const ctx = (pastCutoff = false) =>
    Effect.gen(function* () {
      const runId = mintUlid();
      return {
        location,
        repository: directory,
        runId,
        runKey: "c".repeat(64),
        cycleId: mintUlid(),
        range: {
          baseRef: "main",
          baseOid: "1".repeat(40),
          headOid: "2".repeat(40),
        },
        config: defaultConfig(),
        log: openRunLog(location, runId),
        startedAt: Date.now() - (pastCutoff ? 700_000 : 0),
        reconciliationId: mintUlid(),
        records: yield* Effect.context<Layer.Success<typeof layer>>(),
      } satisfies RunContext["Service"];
    });
  return { directory, location, run, ctx };
};
