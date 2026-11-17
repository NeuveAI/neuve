import { createHash } from "node:crypto";
import { Effect } from "effect";
import { turnLimitFor } from "../../config.ts";
import {
  FRAME_PROMPT_VERSION,
  Frame,
  FrameSubmission,
  composeFrame,
  fallbackFrame,
  frameProblems,
  frameSystem,
  frameTask,
  repairFrame,
  topAreas,
} from "../../frame.ts";
import {
  MAP_MANIFEST_TOKENS,
  MAP_LOCKFILES,
  MAP_MAX_ENTRIES,
  MAP_PROMPT_VERSION,
  MapManifest,
  MapSubmission,
  ReviewMap,
  buildMapManifest,
  composeMap,
  fallbackMap,
  mapAdvice,
  mapProblems,
  mapSystem,
  renderMapManifest,
  repairMap,
  type ChangeMap,
} from "../../review-map.ts";
import {
  codeStage,
  lookupContext,
  precomputeKey,
  type RangeView,
  type RunContext,
} from "../../pipeline.ts";
import type { RangeManifest } from "../../manifest.ts";
import type { AgentStep } from "./agent.ts";

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export const frameStep = (
  ctx: RunContext["Service"],
  view: RangeView,
  candidates: ChangeMap["candidates"],
) =>
  Effect.gen(function* () {
    const lookups = lookupContext(ctx, view);
    const task = yield* frameTask({ ctx: lookups, candidates });
    const checks = {
      candidates,
      snapshot: view.snapshot,
      sections: new Set(task.sectionIds),
    };
    const fallback = () =>
      fallbackFrame(
        checks,
        topAreas(lookups),
        view.commits.length,
        task.figures,
      );
    ctx.log.write({ type: "frame.inputs", ...task.figures });
    const step: AgentStep<FrameSubmission, Frame> = {
      spec: {
        stage: "frame",
        agent: "frame",
        turnLimit: turnLimitFor(ctx.config, "frame"),
        retries: 1,
        system: frameSystem,
        task: task.text,
        tools: [],
        submit: {
          schema: FrameSubmission,
          description:
            "Submit the goal and done-when conditions. sourceIds takes source ids such as S1, not section ids. Each doneWhen item takes a sectionId such as S1.1 and, when quoting a candidate, its candidateId such as O1. Use null for uncited condition fields.",
        },
        check: (o) => frameProblems(o, checks),
        repair: (o) => repairFrame(o, checks),
        backstop: () => fallback(),
      },
      op: "harness.frame",
      opVersion: FRAME_PROMPT_VERSION,
      inputs: {
        // Precompute's key holds no leads retriever, so it is Frame's basis as it stands.
        precompute: `computation:${precomputeKey(ctx)}`,
        task: sha256(task.text),
        ...(view.scopeRefresh === undefined
          ? {}
          : { scope: `computation:${view.scopeRefresh}` }),
      },
      schema: Frame,
      compose: (result) => {
        const frame =
          result.output === undefined || result.status === "backstop"
            ? fallback()
            : composeFrame(
                result.output,
                task.figures,
                result.repairedFrom === undefined ? "agent" : "repaired",
                result.repairedFrom === undefined
                  ? []
                  : ["Frame citations were repaired by code."],
              );
        ctx.log.write({
          type: "frame.result",
          conditions: frame.doneWhen.length,
          gaps: frame.gaps.length,
          source: frame.source,
        });
        return frame;
      },
      partial: () => fallback(),
    };
    return step;
  });
export const mapManifestStage = (
  ctx: RunContext["Service"],
  manifestKey: string,
  manifest: RangeManifest,
) =>
  codeStage(
    ctx,
    "map",
    {
      op: "harness.map-manifest",
      opVersion: 1,
      inputs: { manifest: `computation:${manifestKey}` },
      config: {
        tokens: MAP_MANIFEST_TOKENS,
        entries: MAP_MAX_ENTRIES,
        lockfiles: MAP_LOCKFILES,
      },
    },
    Effect.sync(() => buildMapManifest(manifest)),
    {
      agent: "map.manifest",
      schema: MapManifest,
      afterCutoff: true,
      note: (m) => {
        ctx.log.write({
          type: "map.manifest",
          entries: m.entries.length,
          excluded: m.excluded.length,
          rolledUp: m.rolledUp.length,
          tokens: m.tokens,
        });
        return `${m.entries.length} entries; ${m.tokens} tokens; ${m.excluded.length} excluded; ${m.rolledUp.length} rolled up`;
      },
    },
  );
export const mapStep = (
  ctx: RunContext["Service"],
  _view: RangeView,
  frame: { key: string; value: Frame },
  manifest: { key: string; value: MapManifest },
): AgentStep<MapSubmission, ReviewMap> => {
  const rendered = renderMapManifest(manifest.value);
  const fallback = () => fallbackMap(frame.value, manifest.value, frame.key);
  return {
    spec: {
      stage: "map",
      agent: "map",
      turnLimit: turnLimitFor(ctx.config, "map"),
      retries: 1,
      system: mapSystem,
      task: `Frame:\n${JSON.stringify(frame.value)}\n\nManifest:\n${rendered}`,
      tools: [],
      submit: {
        schema: MapSubmission,
        description: "Submit groups of manifest entry ids.",
      },
      check: (o) => mapProblems(o, frame.value, manifest.value),
      advise: (o) => mapAdvice(o, frame.value),
      repair: (o) => repairMap(o, frame.value, manifest.value),
      backstop: () => ({ groups: [] }),
    },
    op: "harness.map",
    opVersion: MAP_PROMPT_VERSION,
    inputs: { frame: `computation:${frame.key}`, manifest: sha256(rendered) },
    schema: ReviewMap,
    compose: (result) => {
      const map =
        result.output === undefined || result.status === "backstop"
          ? fallback()
          : composeMap(
              result.output,
              frame.value,
              manifest.value,
              frame.key,
              result.repairedFrom === undefined ? "agent" : "repaired",
              result.repairedFrom ?? result.output,
            );
      const paths = map.groups.flatMap((g) => g.files.map((f) => f.path));
      const placed = new Set(paths);
      const expected = manifest.value.entries.flatMap((e) =>
        e.files.map((f) => f.path),
      );
      ctx.log.write({
        type: "map.groups",
        entries: manifest.value.entries.length,
        files: paths.length,
        missingFiles: expected.filter((path) => !placed.has(path)).length,
        duplicateFiles: paths.length - placed.size,
        groups: map.groups.length,
        core: map.groups.filter((g) => g.tier === "core").length,
        supporting: map.groups.filter((g) => g.tier === "supporting").length,
        mechanical: map.groups.filter((g) => g.tier === "mechanical").length,
        codePlaced: map.groups
          .flatMap((g) => g.files)
          .filter((f) => f.placedBy === "code").length,
        unlinked: map.unlinkedDoneWhen.length,
        source: map.source,
      });
      return map;
    },
    partial: () => fallback(),
  };
};
