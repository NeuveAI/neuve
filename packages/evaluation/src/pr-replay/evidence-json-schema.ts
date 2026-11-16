import { z } from "zod";
import { ReplayLineEvidence } from "../harness-compare/full-test/replay-evidence.ts";

/**
 * The JSON Schema of the replay's line evidence, for checking the evidence files on the research
 * volume. The zod schema in `full-test/replay-evidence.ts` is the one authority; this only exports
 * it. Codex never emits this record: strict structured outputs reject its keyed `lines` record, so
 * code builds the evidence from Codex's per-thread judgements (`concerns.ts`, whose own schema goes
 * to `--output-schema`) and the rework map.
 */
export const replayLineEvidenceJsonSchema = () =>
  z.toJSONSchema(ReplayLineEvidence);
