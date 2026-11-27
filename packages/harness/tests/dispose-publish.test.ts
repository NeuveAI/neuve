import { LinkedReview, guidedBasis } from "../src/disposition.ts";
import type { BatchInputs, AssembledUnit } from "../src/compose.ts";
type Finding = FindStored["findings"][number];
// Why: the Link-to-Records boundary must preserve anchors, defect restsOn, Guided citations,
// idempotent publication and the read model consumed by the web desk.
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { ReviewStats } from "@neuve/records-core";
import type { RunContext } from "../src/pipeline.ts";
import { Log, PublishedPackets, mintUlid } from "@neuve/records-core";
import { FindStored } from "../src/historical-find.ts";
import { codeFilledBatch } from "../src/link.ts";
import { publishPacket, clipText } from "../src/publish.ts";
import { AssembledBatch, citationIndex } from "../src/compose.ts";
import { hunk, frame, put, storeFixture, inputsOf } from "./fixtures/link.ts";

const store = storeFixture("link-publish-");

// Why: changed lines without ownership must stay partial even when untouched units are allowed.
test("an unallocated changed range makes a packet partial with every unit untouched", async () => {
  const result = await store.run(
    Effect.gen(function* () {
      const ctx = yield* store.ctx();
      const inputs = inputsOf([
        hunk("h1", "a.ts"),
        hunk("h2", "b.ts", 10, { ownedRanges: [] }),
      ]);
      const assembled = codeFilledBatch(inputs);
      const assembledKey = yield* put("test.unallocated", assembled);
      const summary = yield* publishPacket(ctx, {
        candidates: [{ candidate: "g1", assembledKey, disposed: [] }],
        stages: [{ stage: "find", status: "computed", wallMs: 1 }],
        sources: {
          manifest: yield* put("test.unallocated.manifest", inputs.manifest),
          changeMap: null,
          scope: null,
        },
        strongestStratum: frame.stratum,
      });
      return {
        assembled,
        summary,
        history: yield* Log.history({ cycleId: ctx.cycleId, limit: 1000 }),
      };
    }),
  );
  expect(result.assembled.units).toHaveLength(2);
  expect(
    result.assembled.units.every(
      (unit) => unit.assessment.status === "not-assessed",
    ),
  ).toBe(true);
  expect(result.summary.counts.dispositions).toBe(0);
  expect(result.summary.complete).toBe(false);
  expect(
    result.history.flatMap((row) =>
      row.event.kind === "packet.published@1"
        ? [row.event.payload.complete]
        : [],
    ),
  ).toEqual([false]);
});

// Why (12.41): untouched units are expected; an interrupted stage still means unfinished work.
test.each(["computed", "interrupted"] as const)(
  "untouched units with a %s stage retain the packet completeness rule",
  async (status) => {
    const result = await store.run(
      Effect.gen(function* () {
        const ctx = yield* store.ctx();
        const inputs = inputsOf([hunk("h1", "a.ts")]);
        const assembledKey = yield* put(
          "test.untouched",
          codeFilledBatch(inputs),
        );
        const summary = yield* publishPacket(ctx, {
          candidates: [{ candidate: "g1", assembledKey, disposed: [] }],
          stages: [
            { stage: "find", agent: "find.correctness", status, wallMs: 1 },
          ],
          sources: { manifest: null, changeMap: null, scope: null },
          strongestStratum: frame.stratum,
        });
        return {
          summary,
          history: yield* Log.history({ cycleId: ctx.cycleId, limit: 1000 }),
        };
      }),
    );
    expect(result.summary.complete).toBe(status === "computed");
    expect(result.summary.counts).toMatchObject({
      units: 1,
      comments: 0,
      dispositions: 0,
    });
    expect(
      result.history.flatMap((row) =>
        row.event.kind === "packet.published@1"
          ? [row.event.payload.complete]
          : [],
      ),
    ).toEqual([status === "computed"]);
  },
);

// Why: a later generation may add findings to a pending unit without duplicating its coverage.

// Why: Records can reject a batch transaction; publication must disclose the failure and retain only stored IDs.

// Why: four finders can keep five findings each on the same unit. The former agent's
// twelve-comment submission cap must not discard verified findings at the packet boundary.

// Why: requests for changes need a defect comment with resolvable evidence, even if a
// stored finding loses its hunk reference. This also exercises the published disclosure.

const linkedReview = (
  inputs: BatchInputs,
  assembled: AssembledBatch,
  unit: AssembledUnit,
  findings: ReadonlyArray<Finding>,
): LinkedReview => {
  const batch = assembled.batches.find((batch) => batch.id === unit.batchId);
  if (batch === undefined || findings.length === 0)
    throw new Error("Link needs a touched unit in a batch");
  const guided = guidedBasis(inputs, batch, unit);
  const citations = citationIndex(inputs, {
    units: assembled.units,
    proofs: assembled.proofs.map((proof) => ({ ...proof, listing: "" })),
    references: [],
  }).index;
  const evidence = (finding: Finding) =>
    [...new Set([finding.hunkId, ...finding.evidence])]
      .filter((id) => citations.has(id))
      .slice(0, 8);
  const defects = findings.filter(
    (finding) => finding.kind === "defect" && evidence(finding).length > 0,
  );
  return LinkedReview.parse({
    unit: unit.id,
    source: "agent",
    uncited: false,
    withheld: defects.length === 0,
    notes: [],
    guided,
    citations: Object.fromEntries(citations),
    review: {
      verdict: defects.length > 0 ? "request-changes" : "approve",
      criteria: guided.rows.map((row) => {
        const defect = defects.find((finding) => finding.doneWhen === row.row);
        return {
          row: row.row,
          status: defect === undefined ? "no-evidence" : "not-met",
          does: clipText(
            defect?.claim ??
              "No verified defect establishes this condition's outcome.",
            200,
          ),
          evidence: defect === undefined ? [] : evidence(defect),
        };
      }),
      outside: [],
      findings: findings.map((finding) => ({
        id: finding.id,
        anchor: finding.anchors[0],
        kind: finding.kind,
        about: finding.about,
        signal: finding.signal,
        text: clipText(
          [
            finding.claim,
            ...finding.anchors
              .slice(1)
              .map(
                (anchor) =>
                  `${anchor.path} lines ${anchor.startLine}-${anchor.endLine} (${anchor.side === "new" ? "head" : "base"})`,
              ),
          ].join("; "),
          400,
        ),
        evidence: evidence(finding),
        row: null,
      })),
      message: clipText(
        defects.length > 0
          ? defects.map((finding) => finding.claim).join("\n")
          : "Verified comments are recorded. This unit has no agent disposition.",
        1200,
      ),
      gaps: findings.some(
        (finding) =>
          finding.kind === "defect" && evidence(finding).length === 0,
      )
        ? [
            "A verified defect has no resolvable evidence and cannot support a disposition.",
          ]
        : [],
    },
  });
};

/** Append complete links only; the digest cap can never sever a finding's unit link. */
const publishFixture = (ctx: RunContext["Service"], evidenceHunk = "h1") =>
  Effect.gen(function* () {
    const inputs = inputsOf([hunk("h1", "a.ts"), hunk("h2", "b.ts")]);
    const assembled = codeFilledBatch(inputs);
    const unit = assembled.units[0]!;
    const finding = FindStored.shape.findings.element.parse({
      id: "f1",
      lens: "correctness",
      hunkId: evidenceHunk,
      claim: "The check is inverted.",
      kind: "defect",
      about: "code",
      signal: null,
      critical: false,
      anchors: [{ path: "a.ts", side: "new", startLine: 11, endLine: 11 }],
      doneWhen: "D1",
      group: "g1",
      evidence: [],
    });
    const reviewKey = yield* put(
      "test.link-review",
      linkedReview(inputs, assembled, unit, [finding]),
    );
    const assembledKey = yield* put("test.assembled", assembled);
    return yield* publishPacket(ctx, {
      candidates: [
        {
          candidate: "g1",
          assembledKey,
          disposed: [{ unit: unit.id, key: reviewKey, status: "computed" }],
        },
      ],
      stages: [],
      sources: { manifest: null, changeMap: null, scope: null },
      strongestStratum: frame.stratum,
    });
  });

// Why: multiple run keys retain history but readers and stats must use the newest packet.
test("two run keys in a cycle expose only the newest packet's units to show and stats", async () => {
  const own = storeFixture("link-standing-");
  const result = await own.run(
    Effect.gen(function* () {
      const a = yield* own.ctx();
      const b = {
        ...a,
        runId: mintUlid(),
        runKey: "d".repeat(64),
        startedAt: a.startedAt + 1,
      };
      yield* publishFixture(a);
      yield* publishFixture(b);
      const events = (yield* Log.history({
        cycleId: a.cycleId,
        limit: 1000,
      })).map((row) => row.event);
      const units = yield* PublishedPackets.standingUnits(a.cycleId);
      return {
        events,
        units,
        all: yield* ReviewStats.reviewStats({ cycleId: a.cycleId }),
        standing: yield* ReviewStats.reviewStats({ cycleId: a.cycleId, units }),
        view: yield* PublishedPackets.runPacket(a.runId),
      };
    }),
  );
  const packets = result.events.filter(
    (event) => event.kind === "packet.published@1",
  );
  expect(packets).toHaveLength(2);
  expect(packets[1]?.causation?.supersedes).toBe(packets[0]?.id);
  expect(
    result.events.filter((event) => event.kind === "unit.recorded@2"),
  ).toHaveLength(4);
  expect(result.units).toHaveLength(2);
  expect(
    result.all.grouping.byGapLines.reduce((n, row) => n + row.units, 0),
  ).toBe(4);
  expect(
    result.standing.grouping.byGapLines.reduce((n, row) => n + row.units, 0),
  ).toBe(2);
  expect(
    result.standing.agentDispositions.reduce(
      (n, row) => n + row.dispositions,
      0,
    ),
  ).toBe(1);
  expect(result.view?.eventId).toBe(packets[1]?.id);
  expect(result.view?.requestedPacket).toBe(packets[0]?.id);
  expect(
    result.view?.batches
      .flatMap((batch) => batch.units.map((unit) => unit.unitId))
      .sort(),
  ).toEqual([...result.units!].sort());
});

// Why: store-wide readers must apply the same standing rule and retain unpublished units.
test("store-wide stats count each cycle's newest packet and units without a packet", async () => {
  const own = storeFixture("link-wide-");
  const result = await own.run(
    Effect.gen(function* () {
      const a = yield* own.ctx();
      yield* publishFixture(a);
      yield* publishFixture({
        ...a,
        runId: mintUlid(),
        runKey: "d".repeat(64),
        startedAt: a.startedAt + 1,
      });
      const other = yield* own.ctx();
      yield* publishFixture(other);
      const lone = mintUlid();
      yield* Log.append([
        {
          id: mintUlid(),
          kind: "unit.recorded@2",
          idempotencyKey: `test:${lone}`,
          actor: "a".repeat(64),
          occurredAt: new Date().toISOString(),
          attribution: {
            cycleId: mintUlid(),
            batchId: mintUlid(),
            unitIds: [lone],
          },
          payload: {
            title: "lone",
            ownedRanges: [
              {
                kind: "lines",
                path: "z.ts",
                side: "new",
                startLine: 1,
                endLine: 1,
              },
            ],
            grouping: { gapLines: 20 },
          },
        },
      ]);
      const units = yield* PublishedPackets.recordUnits();
      return {
        units,
        lone,
        all: yield* ReviewStats.reviewStats(),
        standing: yield* ReviewStats.reviewStats({ units }),
      };
    }),
  );
  expect(
    result.all.grouping.byGapLines.reduce((n, row) => n + row.units, 0),
  ).toBe(7);
  expect(result.units).toHaveLength(5);
  expect(result.units).toContain(result.lone);
  expect(
    result.standing.grouping.byGapLines.reduce((n, row) => n + row.units, 0),
  ).toBe(5);
  expect(
    result.standing.gaps.find((gap) => gap.kind === "not-assessed")?.gaps,
  ).toBe(2);
});

// Why: lost or corrupt delivery blobs must be disclosed while the rest of the packet reads.
test("missing and corrupt delivery blobs are disclosed without losing the rest of the packet", async () => {
  const own = storeFixture("link-damaged-");
  const packet = await own.run(
    Effect.gen(function* () {
      const ctx = yield* own.ctx();
      yield* publishFixture(ctx);
      const sql = yield* SqlClient;
      const blobOf = (content: string) => sql<{
        hash: string;
      }>`SELECT c.output_hash AS hash
      FROM events e JOIN computations c ON c.key = substr(json_extract(e.envelope, '$.refs[0].ref'), 13)
      WHERE e.kind = 'delivery.recorded@1' AND json_extract(e.envelope, '$.payload.content') = ${content}
      ORDER BY e.seq LIMIT 1`;
      const [facts] = yield* blobOf("facts");
      const [guided] = yield* blobOf("guided");
      for (const { name } of yield* sql<{
        name: string;
      }>`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'blobs'`)
        yield* sql.unsafe(`DROP TRIGGER ${name}`);
      yield* sql.unsafe("PRAGMA foreign_keys = OFF");
      yield* sql`DELETE FROM blobs WHERE hash = ${facts!.hash}`;
      yield* sql`UPDATE blobs SET content = ${new TextEncoder().encode("not the stored bytes")} WHERE hash = ${guided!.hash}`;
      return yield* PublishedPackets.runPacket(ctx.runId);
    }),
  );
  expect(
    packet?.undecoded.map((entry) => [entry.what, entry.issue.split(" (")[0]]),
  ).toEqual([
    ["facts of g1.u1", "its output blob is missing from this store"],
    ["guided of g1.u1", "its output blob is corrupt"],
  ]);
  const unit = packet?.batches[0]?.units[0];
  expect(unit?.content.facts).toBeUndefined();
  expect(unit?.content.guided).toBeUndefined();
  expect(packet?.batches[0]?.units[1]?.content.facts).toBeDefined();
  expect(unit?.comments).toHaveLength(1);
  expect(unit?.disposition?.payload.verdict).toBe("request-changes");
  expect(unit?.recorded?.kind).toBe("unit.recorded@2");
});
