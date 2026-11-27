import { safeRead } from "@neuve/records-schema";
import { Effect, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { Blobs, Computations } from "@neuve/records-core";
import { z } from "zod";
import { Frame } from "./frame.ts";
import { ReviewMap } from "./review-map.ts";
import {
  FindOutput,
  FindStored,
  claimKeyOf,
  VerifyStored,
} from "./historical-find.ts";

/** Count summaries for the new stages. Old published packets still use the packet reader. */
const outputOf = (key: string) =>
  Effect.gen(function* () {
    const held = yield* (yield* Computations.ComputationStore).lookup(key);
    if (Option.isNone(held)) return undefined;
    const read = yield* (yield* Blobs.BlobStore).get(held.value.outputHash);
    if (read._tag === "Pruned") return undefined;
    const value: unknown = JSON.parse(new TextDecoder().decode(read.bytes));
    const envelope = z.object({ output: z.unknown() }).safeParse(value);
    return envelope.success ? envelope.data.output : value;
  });
const StageEvent = z.object({
  payload: z.object({ agent: z.string().optional() }),
  refs: z.array(z.object({ ref: z.string() })),
});
export const runStageOutputs = (runId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql<{ envelope: string }>`SELECT envelope FROM events
    WHERE kind = 'stage.completed@1'
    AND json_extract(envelope, '$.attribution.runId') = ${runId} ORDER BY seq`;
    const stages = rows.flatMap((row) => {
      const parsed = StageEvent.safeParse(JSON.parse(row.envelope));
      if (!parsed.success) return [];
      const { payload, refs } = parsed.data;
      return [
        {
          agent: payload.agent ?? "",
          key: refs
            .find((ref) => ref.ref.startsWith("computation:"))
            ?.ref.slice(12),
        },
      ];
    });
    // Each finder's final list, from its dedupe step, as the claims a used Verify checked (and,
    // for a Verify stored before claim keys, the finding ids): a Verify of any other claim was
    // started when its finding was recorded and not used, so its decision is not a verdict.
    const frames = stages.flatMap((stage) =>
      stage.agent === "frame" && stage.key !== undefined ? [stage.key] : [],
    );
    const finals = new Map<string, Set<string>>();
    for (const stage of stages) {
      const lens = /^find\.(.+)\.dedupe$/.exec(stage.agent)?.[1];
      if (lens === undefined || stage.key === undefined) continue;
      const held = safeRead(FindStored, yield* outputOf(stage.key));
      if (!held.success) continue;
      const final = finals.get(lens) ?? new Set<string>();
      for (const finding of held.data.findings) {
        final.add(finding.id);
        for (const frame of frames) final.add(claimKeyOf(frame, finding));
      }
      finals.set(lens, final);
    }
    const outputs = new Map<string, unknown>();
    const output = (key: string) =>
      Effect.gen(function* () {
        if (!outputs.has(key)) outputs.set(key, yield* outputOf(key));
        return outputs.get(key);
      });
    // Fail open: a lens none of whose Verifies matches its final list (its claims keyed under
    // another Frame key than the one this reads, say) prints its verdicts as before.
    const matched = new Set<string>();
    for (const { agent, key } of stages) {
      const lens = /^verify\.([^.]+)\./.exec(agent)?.[1];
      if (lens === undefined || key === undefined) continue;
      const held = safeRead(VerifyStored, yield* output(key));
      if (held.success && finals.get(lens)?.has(held.data.finding))
        matched.add(lens);
    }
    const lines: string[] = [];
    for (const { agent, key } of stages) {
      if (agent.endsWith(".dedupe")) continue;
      if (key === undefined || !/^(frame|map|find\.|verify\.)/.test(agent))
        continue;
      const stored = yield* output(key);
      if (agent === "frame") {
        const held = safeRead(Frame, stored);
        if (held.success)
          lines.push(
            `Frame: ${held.data.doneWhen.length} done-when conditions, ${held.data.gaps.length} gaps.`,
          );
      } else if (agent === "map") {
        const held = safeRead(ReviewMap, stored);
        if (held.success)
          lines.push(
            `Map: ${held.data.groups.length} groups, ${held.data.excluded.length} excluded files, ${held.data.gaps.length} gaps.`,
          );
      } else if (agent.startsWith("find.")) {
        // Find's own output; one stored before groups moved to dedupe carries a group per finding.
        const current = safeRead(FindOutput, stored);
        const held = current.success ? current : safeRead(FindStored, stored);
        if (held.success)
          lines.push(`${agent}: ${held.data.findings.length} findings.`);
      } else {
        const held = safeRead(VerifyStored, stored);
        const lens = agent.split(".")[1] ?? "";
        const final = matched.has(lens) ? finals.get(lens) : undefined;
        if (!held.success) continue;
        lines.push(
          final === undefined || final.has(held.data.finding)
            ? `${agent}: ${held.data.decision}.`
            : `${agent}: not used; its claim is not in the finder's final list.`,
        );
      }
    }
    return { lines };
  });
export const stageOutputLines = (outputs: {
  readonly lines: ReadonlyArray<string>;
}) =>
  outputs.lines.length === 0
    ? ["No current stage outputs are stored for this run."]
    : [...outputs.lines];
