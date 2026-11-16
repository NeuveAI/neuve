import { step } from "./telemetry.ts";
import { Effect } from "effect";
import { projectSubmittedChangedRanges } from "@neuve/review-rules";
import { diffTrees, mergeBase, treeOf } from "./git-objects.ts";
import { rawHunks } from "./hunks.ts";
import {
  defaultManifestSettings,
  frontSettings,
  RangeManifest,
  rulesSubmission,
} from "./manifest.ts";
import { codeStage, PrecomputeOutput, type RunContext } from "./pipeline.ts";

/** A coverage-only key never claims that enrichment or a cycle's scope snapshot completed. */
export const coverageStage = (ctx: RunContext["Service"]) =>
  codeStage(
    ctx,
    "precompute",
    {
      op: "harness.coverage",
      // 2: the range manifest holds no leads or index (NEU-148).
      opVersion: 2,
      inputs: {
        base: `git-commit:${ctx.range.baseOid}`,
        head: `git-commit:${ctx.range.headOid}`,
      },
    },
    step(
      "harness.precompute.coverage",
      Effect.gen(function* () {
        const merge = yield* mergeBase(
          ctx.repository,
          ctx.range.baseOid,
          ctx.range.headOid,
        );
        const [baseTree, headTree, files] = yield* Effect.all([
          treeOf(ctx.repository, merge),
          treeOf(ctx.repository, ctx.range.headOid),
          diffTrees(ctx.repository, merge, ctx.range.headOid),
        ]);
        const range = {
          baseOid: ctx.range.baseOid,
          headOid: ctx.range.headOid,
          mergeBase: merge,
          baseTree,
          headTree,
        };
        const raw = rawHunks(files);
        const projected = projectSubmittedChangedRanges(
          rulesSubmission(range, raw),
        );
        const owned = new Map(
          projected.hunks.map((hunk) => [hunk.hunkId, hunk]),
        );
        return RangeManifest.parse({
          range,
          settings: frontSettings(
            defaultManifestSettings(ctx.config.route.window),
          ),
          files: files.length,
          reviewLines: raw.reduce(
            (sum, hunk) => sum + hunk.added + hunk.deleted,
            0,
          ),
          hunks: raw.map((hunk) => ({
            ...hunk,
            ownedRanges: (owned.get(hunk.hunkId)?.changedRanges ?? []).map(
              ({ side, startLine, lineCount }) => ({
                side,
                startLine,
                lineCount,
              }),
            ),
            qualifications: (owned.get(hunk.hunkId)?.qualifications ?? []).map(
              ({ kind, detail }) => ({ kind, detail }),
            ),
            declared: [],
            countsTowardReviewLines: true,
            allowance: { tokens: 4_000, exactShare: 0, floored: true },
          })),
          facts: [],
          declarations: { readers: [], gaps: [] },
          limitations: [
            "Precompute enrichment and scope were unavailable; coverage comes from the committed range diff.",
          ],
        });
      }),
      (value) => ({
        "harness.files": value.files,
        "harness.hunks": value.hunks.length,
      }),
    ),
    { agent: "precompute.coverage", afterCutoff: true, schema: RangeManifest },
  );

export const coverageFacts = (
  manifestKey: string,
  manifest: RangeManifest,
): PrecomputeOutput => {
  const files = new Map<
    string,
    { path: string; added: number | null; deleted: number | null }
  >();
  for (const hunk of manifest.hunks) {
    const previous = files.get(hunk.path);
    files.set(hunk.path, {
      path: hunk.path,
      added:
        hunk.kind === "binary" ? null : (previous?.added ?? 0) + hunk.added,
      deleted:
        hunk.kind === "binary" ? null : (previous?.deleted ?? 0) + hunk.deleted,
    });
  }
  return {
    files: [...files.values()],
    diffBytes: manifest.hunks.reduce(
      (sum, hunk) => sum + new TextEncoder().encode(hunk.text).length,
      0,
    ),
    manifest: manifestKey,
    scope: null,
    hunks: manifest.hunks.length,
    reviewLines: manifest.reviewLines,
    strongestStratum: "nothing",
    scopeGaps: [...manifest.limitations],
  };
};
