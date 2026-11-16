// Why: the Link-to-Records boundary must preserve anchors, defect restsOn, Guided citations,
// idempotent publication and the read model consumed by the web desk.
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { ReviewStats } from "@neuve/records-core";
import { describePacket } from "../src/packet-view.ts";
import type { RunContext } from "../src/pipeline.ts";
import { Log, PublishedPackets, mintUlid } from "@neuve/records-core";
import { FindStored } from "../src/find.ts";
import {
  codeFilledBatch,
  linkedReview,
  linkChangeMap,
  fill,
  link,
} from "../src/link.ts";
import { publishPacket, stableUlid } from "../src/publish.ts";
import { AssembledBatch } from "../src/compose.ts";
import { storedOutput } from "../src/pipeline.ts";
import {
  hunk,
  frame,
  mapOf,
  manifestOf,
  put,
  storeFixture,
  inputsOf,
} from "./fixtures/link.ts";

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

test("Frame, Map and verified findings publish and project unchanged in Records", async () => {
  const result = await store.run(
    Effect.gen(function* () {
      const ctx = yield* store.ctx();
      const hunks = [
        hunk("h1", "a.ts"),
        hunk("h2", "b.ts"),
        hunk("h3", "c.ts"),
        hunk("h4", "bun.lock"),
      ];
      const frameKey = yield* put("test.frame", frame);
      const map = { ...mapOf(hunks), frame: frameKey };
      const mapKey = yield* put("test.map", map),
        manifestKey = yield* put("test.manifest", manifestOf(hunks));
      const setup = {
        precompute: "unused",
        scopeKey: null,
        refreshKey: null,
        pins: [],
        disclosures: [],
      };
      const filled = yield* fill(ctx, { mapKey, manifestKey, setup });
      const finding = (
        id: string,
        path: string,
        kind: "defect" | "risk",
        claim: string,
      ) => ({
        id,
        lens: "correctness",
        hunkId: path === "a.ts" ? "h1" : "h2",
        claim,
        kind,
        about: "code",
        signal: null,
        critical: false,
        anchors: [{ path, side: "new", startLine: 11, endLine: 11 }],
        doneWhen: "D1",
        group: "g1",
        evidence: [],
      });
      const found = FindStored.parse({
        lens: "correctness",
        source: "agent",
        findings: [
          finding("f1", "a.ts", "defect", "The revoked link remains usable."),
          finding(
            "f2",
            "b.ts",
            "risk",
            "The revocation boundary needs a human check.",
          ),
          finding("f3", "c.ts", "defect", "Unchecked claim."),
          finding("f4", "missing.ts", "defect", "An unanchored claim."),
          finding("f5", "a.ts", "defect", "Dropped claim."),
        ],
        notes: [],
        reading: { used: 10, limit: 200_000 },
      });
      const findKey = yield* put("test.find", found),
        verifyKey = yield* put("test.verify", {
          decision: "keep",
          reason: "The code supports the claim.",
        });
      const linked = yield* link(ctx, {
        frameKey,
        mapKey,
        manifestKey,
        fill: filled,
        setup,
        finders: [
          {
            lens: "correctness",
            findKey,
            stages: [],
            end: { find: "completed", verify: "completed" },
            findings: [
              { id: "f1", status: "kept", verifyKey },
              { id: "f2", status: "kept", verifyKey },
              { id: "f3", status: "unverified", verifyKey: null },
              { id: "f4", status: "kept", verifyKey },
              { id: "f5", status: "dropped", verifyKey },
            ],
          },
        ],
      });
      const input = {
        findings: ["f1", "f2", "f4"],
        candidates: linked.candidates,
        stages: [filled.record, linked.record],
        sources: {
          manifest: manifestKey,
          changeMap: linked.changeMapKey,
          scope: null,
        },
        strongestStratum: frame.stratum,
        disclosures: linked.disclosures,
      };
      const first = yield* publishPacket(ctx, input),
        before = yield* Log.history({ cycleId: ctx.cycleId, limit: 1000 });
      const second = yield* publishPacket(ctx, input),
        after = yield* Log.history({ cycleId: ctx.cycleId, limit: 1000 });
      const projected = yield* PublishedPackets.runPacket(ctx.runId);
      const assembled = yield* storedOutput(
        ctx,
        linked.candidates[0]!.assembledKey,
        AssembledBatch,
      );
      return { first, second, before, after, projected, linked, assembled };
    }),
  );
  expect(result.after.length).toBe(result.before.length);
  expect(result.second.manifest).toBe(result.first.manifest);
  expect(result.first.counts).toMatchObject({
    units: 4,
    comments: 2,
    dispositions: 1,
    assessments: 0,
  });
  // Why: this synthetic range has no Git proof lookup, so that unchecked work stays partial.
  expect(result.assembled.gaps).toContain(
    "The range's proof records could not be read; verification has no proof credit.",
  );
  expect(result.first.complete).toBe(false);
  expect(result.first.findings).toEqual([
    { id: "f1", fate: "published", publicationId: expect.any(String) },
    { id: "f2", fate: "published", publicationId: expect.any(String) },
    { id: "f4", fate: "withheld", reason: "no-comment" },
  ]);
  expect(result.projected?.undecoded).toEqual([]);
  expect(describePacket(result.projected!).join("\n")).toContain(
    "review (agent, lane-blind): no disposition",
  );
  expect(describePacket(result.projected!).join("\n")).not.toContain("approve");
  const projectedUnits =
    result.projected?.batches.flatMap((batch) => batch.units) ?? [];
  expect(projectedUnits).toHaveLength(4);
  expect(
    projectedUnits.find((unit) => unit.local === "g1.u1")?.comments[0]?.payload
      .body,
  ).toBe("The revoked link remains usable.");
  expect(
    projectedUnits.find((unit) => unit.local === "g1.u1")?.disposition?.payload
      .verdict,
  ).toBe("request-changes");
  expect(
    projectedUnits.find((unit) => unit.local === "g1.u2")?.disposition,
  ).toBeUndefined();
  expect(
    projectedUnits.find((unit) => unit.local === "g1.u3")?.content.guided
      ?.rows?.[0]?.status,
  ).toBe("no-evidence");
  // A version 1 Guided stop cites exactly its rows' and outside items' evidence: Dispose writes no
  // row reading, so reading a row's reading changes nothing here.
  const guidedEvidence = projectedUnits.map((unit) =>
    [
      ...new Set(
        [
          ...(unit.content.guided?.rows ?? []),
          ...(unit.content.guided?.outside ?? []),
        ].flatMap((row) => row.evidence),
      ),
    ].sort(),
  );
  expect(guidedEvidence.flat().length).toBeGreaterThan(0);
  expect(
    projectedUnits.map((unit) =>
      unit.citations.cited
        .filter((cited) => cited.stops.includes("guided"))
        .map((cited) => cited.id)
        .sort(),
    ),
  ).toEqual(guidedEvidence);
  const comments = result.before.flatMap((row) =>
    row.event.kind === "comment.recorded@2" ? [row] : [],
  );
  expect(
    result.first.findings.flatMap((finding) =>
      finding.fate === "published" ? [finding.publicationId] : [],
    ),
  ).toEqual(comments.map((row) => row.event.id));
  expect(result.second.findings).toEqual(result.first.findings);
  const dispositions = result.before.flatMap((row) =>
    row.event.kind === "disposition.recorded@2" ? [row.event] : [],
  );
  expect(dispositions).toHaveLength(1);
  expect(dispositions[0]?.payload).toMatchObject({
    verdict: "request-changes",
    restsOn: [comments[0]!.event.id],
  });
  expect(
    result.before.some(
      (row) =>
        row.event.kind === "disposition.carried@1" ||
        row.event.kind === "comment.carried@1",
    ),
  ).toBe(false);
  const gaps = result.before.flatMap((row) =>
    row.event.kind === "gap.disclosed@1" ? [row.event.payload] : [],
  );
  expect(
    result.before
      .flatMap((row) =>
        row.event.kind === "gap.disclosed@1" &&
        row.event.payload.kind === "not-assessed"
          ? (row.event.attribution.unitIds ?? [])
          : [],
      )
      .sort(),
  ).toEqual(projectedUnits.map((unit) => unit.unitId).sort());
  expect(
    gaps.filter((gap) => gap.kind === "not-assessed").map((gap) => gap.detail),
  ).toEqual([
    '3 units in "Group 1" have no assessment of complexity or ease of validation.',
    '1 unit in "Lockfiles and generated files" has no assessment of complexity or ease of validation.',
  ]);
  expect(gaps.filter((gap) => gap.kind === "review-missing")).toHaveLength(0);
  expect(gaps.filter((gap) => gap.kind === "finding-unanchored")).toHaveLength(
    1,
  );
  expect(gaps.filter((gap) => gap.kind === "findings-unverified")).toHaveLength(
    1,
  );
  expect(result.assembled.batches[0]?.digest.digest).toContain(
    "[The revoked link remains usable.](g1.u1)",
  );
  expect(result.assembled.batches[0]?.digest.limitations.join(" ")).toContain(
    "1 findings dropped",
  );
});

// Why: a later generation may add findings to a pending unit without duplicating its coverage.
test("a later generation fills a pending review and replay appends nothing", async () => {
  const result = await store.run(
    Effect.gen(function* () {
      const ctx = yield* store.ctx(),
        inputs = inputsOf([hunk("h1", "a.ts")]);
      const assembled = codeFilledBatch(inputs),
        unit = assembled.units[0]!;
      const assembledKey = yield* put("test.assembled", assembled),
        changeMap = yield* put(
          "test.map",
          linkChangeMap(frame, mapOf(inputs.manifest.hunks)),
        );
      const base = {
        stages: [],
        sources: { manifest: null, changeMap, scope: null },
        strongestStratum: frame.stratum,
      };
      const pending = yield* publishPacket(ctx, {
        ...base,
        candidates: [{ candidate: "g1", assembledKey, disposed: [] }],
      });
      const finding = FindStored.shape.findings.element.parse({
        id: "f1",
        lens: "correctness",
        hunkId: "h1",
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
      const later = { ...ctx, runId: mintUlid(), startedAt: ctx.startedAt + 1 };
      const ready = {
        ...base,
        candidates: [
          {
            candidate: "g1",
            assembledKey,
            disposed: [
              { unit: unit.id, key: reviewKey, status: "computed" as const },
            ],
          },
        ],
      };
      const filled = yield* publishPacket(later, ready),
        before = yield* Log.history({ cycleId: ctx.cycleId, limit: 1000 });
      yield* publishPacket(later, ready);
      return {
        pending,
        filled,
        before,
        after: yield* Log.history({ cycleId: ctx.cycleId, limit: 1000 }),
        view: yield* PublishedPackets.runPacket(ctx.runId),
      };
    }),
  );
  expect(result.pending.complete).toBe(true);
  expect(result.filled.complete).toBe(true);
  expect(result.after.length).toBe(result.before.length);
  expect(
    result.before.filter((row) => row.event.kind === "unit.recorded@2"),
  ).toHaveLength(1);
  expect(
    result.before.filter((row) => row.event.kind === "disposition.recorded@2"),
  ).toHaveLength(1);
  expect(result.view?.batches[0]?.units[0]?.disposition?.payload.verdict).toBe(
    "request-changes",
  );
});

// Why: Records can reject a batch transaction; publication must disclose the failure and retain only stored IDs.
test("a conflicting comment falls back event by event and projects the retained comment", async () => {
  const result = await store.run(
    Effect.gen(function* () {
      const ctx = yield* store.ctx(),
        inputs = inputsOf([hunk("h1", "a.ts")]);
      const assembled = codeFilledBatch(inputs),
        unit = assembled.units[0]!;
      const namespace = `review:${ctx.cycleId}:${ctx.runKey}:`;
      const earlier = mintUlid();
      yield* Log.append([
        {
          id: earlier,
          kind: "comment.recorded@2",
          idempotencyKey: `${namespace}unit:${unit.id}:comment:0`,
          actor: "a".repeat(64),
          occurredAt: new Date().toISOString(),
          attribution: {
            cycleId: ctx.cycleId,
            unitIds: [
              stableUlid(
                ctx.startedAt,
                0,
                `${namespace}entity:unit:${unit.id}`,
              ),
            ],
          },
          payload: { body: "An earlier comment." },
        },
      ]);
      const finding = FindStored.shape.findings.element.parse({
        id: "f1",
        lens: "correctness",
        hunkId: "h1",
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
      const key = yield* put(
        "test.review",
        linkedReview(inputs, assembled, unit, [finding]),
      );
      const assembledKey = yield* put("test.assembled", assembled);
      const summary = yield* publishPacket(ctx, {
        candidates: [
          {
            candidate: "g1",
            assembledKey,
            disposed: [{ unit: unit.id, key, status: "computed" }],
          },
        ],
        stages: [],
        sources: { manifest: null, changeMap: null, scope: null },
        strongestStratum: frame.stratum,
      });
      const view = yield* PublishedPackets.runPacket(ctx.runId);
      return { summary, view, earlier };
    }),
  );
  expect(result.summary.complete).toBe(false);
  expect(result.summary.findings).toEqual([
    { id: "f1", fate: "withheld", reason: "comment-kept-earlier" },
  ]);
  expect(result.view?.gaps.map((gap) => gap.payload.kind)).toContain(
    "publish-kept-earlier",
  );
  expect(result.view?.batches[0]?.units[0]?.comments[0]?.id).toBe(
    result.earlier,
  );
  expect(result.view?.undecoded).toEqual([]);
});

// Why: four finders can keep five findings each on the same unit. The former agent's
// twelve-comment submission cap must not discard verified findings at the packet boundary.
test("all twenty kept findings on one unit reach Records", async () => {
  const result = await store.run(
    Effect.gen(function* () {
      const ctx = yield* store.ctx();
      const inputs = inputsOf([hunk("h1", "a.ts")]);
      const assembled = codeFilledBatch(inputs);
      const unit = assembled.units[0]!;
      const findings = Array.from({ length: 20 }, (_, index) =>
        FindStored.shape.findings.element.parse({
          id: `f${index}`,
          lens: ["correctness", "risky-edges", "tests", "scope-fit"][index % 4],
          hunkId: "h1",
          claim: `Defect ${index}.`,
          kind: "defect",
          about: "code",
          signal: null,
          critical: false,
          anchors: [{ path: "a.ts", side: "new", startLine: 11, endLine: 11 }],
          doneWhen: "D1",
          group: "g1",
          evidence: [],
        }),
      );
      const key = yield* put(
        "test.review-twenty",
        linkedReview(inputs, assembled, unit, findings),
      );
      const assembledKey = yield* put("test.assembled", assembled);
      const summary = yield* publishPacket(ctx, {
        candidates: [
          {
            candidate: "g1",
            assembledKey,
            disposed: [{ unit: unit.id, key, status: "computed" }],
          },
        ],
        stages: [],
        sources: { manifest: null, changeMap: null, scope: null },
        strongestStratum: frame.stratum,
      });
      return { summary, view: yield* PublishedPackets.runPacket(ctx.runId) };
    }),
  );
  expect(result.summary.counts).toMatchObject({
    comments: 20,
    dispositions: 1,
  });
  expect(result.view?.batches[0]?.units[0]?.comments).toHaveLength(20);
  expect(
    result.view?.batches[0]?.units[0]?.disposition?.payload.restsOn,
  ).toHaveLength(20);
  expect(result.view?.undecoded).toEqual([]);
});

// Why: requests for changes need a defect comment with resolvable evidence, even if a
// stored finding loses its hunk reference. This also exercises the published disclosure.
test("a defect without resolvable evidence publishes no disposition and discloses the gap", async () => {
  const own = storeFixture("link-no-evidence-");
  const packet = await own.run(
    Effect.gen(function* () {
      const ctx = yield* own.ctx();
      yield* publishFixture(ctx, "absent");
      return yield* PublishedPackets.runPacket(ctx.runId);
    }),
  );
  expect(packet?.batches[0]?.units[0]?.comments).toHaveLength(1);
  expect(packet?.batches[0]?.units[0]?.disposition).toBeUndefined();
  expect(
    packet?.gaps.some(
      (gap) =>
        gap.payload.kind === "review-gap" &&
        gap.payload.detail.includes("no resolvable evidence"),
    ),
  ).toBe(true);
  expect(packet?.undecoded).toEqual([]);
});

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
