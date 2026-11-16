import { Effect } from "effect";
import {
  encodeUnits,
  encodeUnitId,
  pendingUnits,
  queryVectorStored,
} from "./dense.ts";
import type { BaseCorpus } from "./corpus.ts";
import type { HunkQuery } from "./queries.ts";
import { MODELS, modelIdentity } from "./models.ts";
import { E0_UNITS_PER_SECOND } from "./modal-chunks.ts";

export const RERANK_PAIR_USD = 0.08 / 3550;
// Planning assumption only, configurable at the CLI; excludes CPU, startup and storage.
export const L40S_GPU_SECOND_USD = 0.000542;

export const encodingPlan = (input: {
  bases: readonly BaseCorpus[];
  queries: readonly HunkQuery[];
  containers: number;
  gpuSecondUsd: number;
}) =>
  Effect.gen(function* () {
    if (
      !Number.isInteger(input.containers) ||
      input.containers < 1 ||
      !Number.isFinite(input.gpuSecondUsd) ||
      input.gpuSecondUsd < 0
    )
      throw new Error("Invalid E0 cost assumptions");
    const units = encodeUnits(input.bases, new Map());
    const pending = yield* pendingUnits(MODELS.E0, units);
    const queryKeys: string[] = [];
    for (const query of input.queries)
      if (!(yield* queryVectorStored(MODELS.E0, query)))
        queryKeys.push(query.sha256);
    const pendingKeys = [
      ...pending.map((unit) => `chunk:${encodeUnitId(unit)}`),
      ...[...new Set(queryKeys)].map((hash) => `query:${hash}`),
    ];
    const wallSeconds = pendingKeys.length / E0_UNITS_PER_SECOND;
    return {
      model: "E0",
      identity: modelIdentity(MODELS.E0),
      units: units.length,
      pendingChunks: pending.length,
      pendingQueries: new Set(queryKeys).size,
      pendingKeys,
      estimatedWallSeconds: wallSeconds,
      estimatedUsd: wallSeconds * input.containers * input.gpuSecondUsd,
      assumptions: {
        unitsPerSecond: E0_UNITS_PER_SECOND,
        containers: input.containers,
        gpuSecondUsd: input.gpuSecondUsd,
        note: "Measured 75,686 units in 811 wall seconds. USD assumes all containers billed for that wall time; excludes startup, CPU and storage. Query rate approximated by chunk rate.",
      },
    };
  });
