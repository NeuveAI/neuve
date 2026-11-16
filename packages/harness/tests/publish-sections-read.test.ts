import { expect, test } from "bun:test";
import { Effect } from "effect";
import {
  Dispositions,
  Log,
  PublishedPackets,
  mintUlid,
} from "@neuve/records-core";
import { publishSettled } from "../src/publish-sections.ts";
import { harnessActor } from "../src/receipt.ts";
import {
  TOTALS,
  inputOf,
  scratch,
  threeBatches,
  unit,
} from "./publish-sections-fixtures.ts";

// Why: the writer and the reviewed reader must meet. What `publishSettled` writes,
// `PublishedPackets.readStanding` reads whole, with nothing left undecoded.
test("the reviewed reader reads back every unit, range, section, comment, decision and gap", async () => {
  const store = scratch();
  const { a, b, c, sections } = threeBatches();
  const result = await store.run(
    Effect.gen(function* () {
      const ctx = store.ctx();
      const summary = yield* publishSettled(
        ctx,
        inputOf([a, b, c], { ending: true }),
      );
      const read = yield* PublishedPackets.readStanding(ctx.cycleId);
      const judged: Record<string, Dispositions.UnitJudgement> = {};
      if (read?.kind === "packet.published@2")
        for (const batch of read.batches)
          for (const u of batch.units)
            judged[u.local] = yield* Dispositions.judge(u.unitId);
      return { summary, read, judged };
    }),
  );
  const { summary, read } = result;
  expect(read?.kind).toBe("packet.published@2");
  if (read?.kind !== "packet.published@2") return;
  expect(read.undecoded).toEqual([]);
  expect(read.complete).toBe(true);
  expect(read.ordinal).toBe(1);
  expect(read.eventId).toBe(summary.packetEventId!);
  expect(read.batches.map((batch) => batch.recorded?.payload.title)).toEqual([
    "Retry policy",
    "Guards",
    "Lookup table",
  ]);
  const units = read.batches.flatMap((batch) => batch.units);
  expect(units).toHaveLength(4);
  // Every range of the 1,100-range unit, beside its section joined to its judgement.
  const large = units.find((u) =>
    u.recorded?.payload.title.startsWith("c.ts"),
  )!;
  expect(large.recorded?.payload.ownedRanges).toHaveLength(1_100);
  expect(large.sections).toHaveLength(1);
  expect(large.sections[0]!.ownedRanges).toHaveLength(1_100);
  expect(large.sections[0]!.lane?.applied).toBe("agentic");
  expect(large.assessment?.kind).toBe("assessment.recorded@4");
  // The split file: two units of one file, each with its own title and lane.
  const [agentic, required] = read.batches[0]!.units;
  expect(agentic!.assessment?.payload.lane).toBe("agentic");
  expect(required!.assessment?.payload.lane).toBe("human-required");
  expect(agentic!.recorded?.payload.title).not.toBe(
    required!.recorded?.payload.title,
  );
  expect(agentic!.sections[0]!.key).toBe(sections.a1.identity.key);
  expect(agentic!.sections[0]!.parts["spanSha256"]).toBe(
    sections.a1.identity.parts["spanSha256"],
  );
  expect(required!.sections[0]!.lane?.floors).toEqual([
    { rule: "public-surface", to: "human-required" },
  ]);
  if (required!.assessment?.kind === "assessment.recorded@4")
    expect(required!.assessment.payload.sections).toEqual({
      count: 1,
      raised: 1,
      undecided: {},
    });
  // Comments in rank order: the two shown or rested on, the one below the cut withheld.
  expect(
    agentic!.comments.map((comment) =>
      comment.kind === "comment.recorded@3"
        ? comment.payload.finding?.kind
        : "",
    ),
  ).toEqual(["defect", "impact", "defect"]);
  // Each keeps the section it is about; the impact comment is about the whole unit.
  expect(
    agentic!.comments.map((comment) =>
      comment.kind === "comment.recorded@3" ? comment.payload.section : "",
    ),
  ).toEqual([sections.a1.identity.key, undefined, sections.a1.identity.key]);
  const impact = agentic!.comments[1]!;
  if (impact.kind === "comment.recorded@3")
    expect(impact.payload.finding).toMatchObject({
      effect: "narrowed",
      summary: "Retries stop after two attempts instead of five.",
    });
  // The request for changes rests on its two comments.
  expect(agentic!.disposition?.payload.verdict).toBe("request-changes");
  expect(agentic!.disposition?.payload.restsOn).toEqual(
    [agentic!.comments[0]!.id, agentic!.comments[2]!.id].sort(),
  );
  // The not-decided gap names its unit, by cause, and the counts say the same.
  const guards = read.batches[1]!;
  const undecided = guards.gaps.filter((gap) =>
    gap.payload.kind.startsWith("undecided-"),
  );
  expect(
    undecided.map((gap) => [gap.payload.kind, gap.attribution.unitIds]),
  ).toEqual([["undecided-failed", [guards.units[0]!.unitId]]]);
  expect(undecided[0]!.payload.detail).toContain("a person decides it");
  expect(
    guards.units[0]!.sections.find((s) => s.undecided !== undefined)?.undecided,
  ).toEqual({ cause: "failed", reading: "assess" });
  expect(read.counts).toMatchObject({
    batches: 3,
    units: 4,
    sections: 5,
    assessments: 4,
    comments: 3,
    dispositions: 2,
    pending: { batches: 0, sections: 0 },
    undecided: { failed: 1 },
  });
  expect(read.added).toEqual({
    batches: 3,
    units: 4,
    sections: 5,
    undecided: { failed: 1 },
  });
  // Each lane needs what Dispositions says it needs.
  expect(
    Object.values(result.judged).map((j) => [j.lane, j.needs, j.closed]),
  ).toEqual([
    ["agentic", "a-disposition", true],
    ["human-required", "a-human-disposition", false],
    ["human-required", "a-human-disposition", false],
    ["agentic", "a-disposition", true],
  ]);
  expect(summary.closure).toEqual({
    closed: 2,
    "needs a-human-disposition": 2,
  });
  expect(summary.findings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: "claim:below",
        fate: "withheld",
        reason: "below-the-cut",
      }),
      expect.objectContaining({ id: "claim:impact", fate: "published" }),
    ]),
  );
  expect(summary.pending).toEqual({ batches: 0, sections: 0 });
  expect(TOTALS.sections).toBe(read.counts.sections);
});

// Why: an agent's approval of human-required work is impossible to publish, whether the caller
// hands one in or something appends one to Records directly.
test("an agent approval on a human-required unit is withheld, and Records refuses one", async () => {
  const store = scratch();
  const { a } = threeBatches();
  const approving = {
    ...a,
    units: [
      a.units[0]!,
      unit("src/a.ts", "human-required", [a.sections[1]!], {
        verdict: "approve",
        disposition: "approve" as const,
      }),
    ],
  };
  const result = await store.run(
    Effect.gen(function* () {
      const ctx = store.ctx();
      yield* publishSettled(ctx, inputOf([approving]));
      const read = yield* PublishedPackets.readStanding(ctx.cycleId);
      if (read?.kind !== "packet.published@2") return undefined;
      const required = read.batches[0]!.units[1]!;
      const direct = yield* Effect.result(
        Log.append([
          {
            id: mintUlid(),
            kind: "disposition.recorded@2",
            idempotencyKey: `test:approve:${required.unitId}`,
            actor: harnessActor(`review:${ctx.cycleId}:${ctx.runKey}`, "link"),
            occurredAt: new Date().toISOString(),
            attribution: { cycleId: ctx.cycleId, unitIds: [required.unitId] },
            payload: {
              verdict: "approve",
              reviewedHeadOid: ctx.range.headOid,
              restsOn: [],
              proof: [],
            },
          },
        ]),
      );
      return {
        disposition: required.disposition,
        gaps: read.batches[0]!.gaps.map((gap) => gap.payload.kind),
        direct:
          direct._tag === "Failure"
            ? (direct.failure as { rule?: string }).rule
            : "appended",
        judged: yield* Dispositions.judge(required.unitId),
      };
    }),
  );
  expect(result?.disposition).toBeUndefined();
  expect(result?.gaps).toContain("approval-withheld");
  expect(result?.direct).toBe("human-required-approval");
  expect(result?.judged.closed).toBe(false);
});
