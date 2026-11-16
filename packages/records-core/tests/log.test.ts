// Why: the append transaction is the only write path (D4, D6, D16). These cases pin its observable
// contract on a real SQLite file: retries are idempotent, a conflicting key rolls the whole batch back
// (including its enqueued job), and a multi-unit event is one row plus index rows.
import { afterAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { Dispositions, Log, mintUlid } from "../src/index.ts";
import {
  agent,
  commitEvent,
  cycleEvents,
  envelope,
  headOid,
  human,
  workflowEvents,
  freshLocation,
  runOn,
  removeTemporaryDirectories,
} from "./support.ts";

afterAll(removeTemporaryDirectories);

const counts = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const [row] = yield* sql<{
    events: number;
    units: number;
    jobs: number;
  }>`SELECT
    (SELECT count(*) FROM events) AS events,
    (SELECT count(*) FROM event_units) AS units,
    (SELECT count(*) FROM jobs) AS jobs`;
  return row;
});

describe("append", () => {
  test("a retry with a new ULID and time but the same key and content returns the stored event", async () => {
    const location = freshLocation();
    const { events } = cycleEvents(3);
    const first = await runOn(location, Log.append(events));
    const retried = events.map((event) => ({
      ...event,
      id: mintUlid(),
      occurredAt: "2026-10-18T00:00:00.000Z",
    }));
    const second = await runOn(location, Log.append(retried));

    expect(first.map((r) => r.status)).toEqual(events.map(() => "appended"));
    expect(second).toEqual(first.map((r) => ({ ...r, status: "existing" })));
    expect(await runOn(location, counts)).toEqual({
      events: 7,
      units: 3 + 3 + 1,
      // The cycle's one scope.fetch job (cycle.opened@1 enqueues it), not repeated by the retry.
      jobs: 1,
    });
  });

  test("the same key with different content fails and rolls back the whole batch, job included", async () => {
    const location = freshLocation();
    const { events } = cycleEvents(1);
    await runOn(location, Log.append(events));
    const disposition = events[events.length - 1]!;
    const changed = {
      ...disposition,
      id: mintUlid(),
      payload: { verdict: "request-changes", reviewedHeadOid: "a".repeat(40) },
    };

    const failure = await runOn(
      location,
      Effect.flip(Log.append([commitEvent("d".repeat(40)), changed])),
    );

    expect(failure._tag).toBe("IdempotencyConflict");
    expect(await runOn(location, counts)).toEqual({
      events: 5,
      units: 3,
      // Only the first batch's scope.fetch job (from its cycle.opened@1); the rolled-back commit's
      // commit.prepare job is gone with it.
      jobs: 1,
    });
  });

  test("an event attributed to 16 units is stored once with 16 unit index rows", async () => {
    const location = freshLocation();
    const { events, unitIds } = cycleEvents(16);
    await runOn(location, Log.append(events));
    const shared = events.find(
      (event) => event.kind === "context.referenced@1",
    )!;

    const [stored] = await runOn(
      location,
      Log.history({ kind: "context.referenced@1" }),
    );
    const forLastUnit = await runOn(
      location,
      Log.history({ unitId: unitIds[15] }),
    );
    const rows = await runOn(
      location,
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        return yield* sql<{ n: number }>`SELECT count(*) AS n FROM event_units
          WHERE event_seq = (SELECT seq FROM events WHERE id = ${shared.id})`;
      }),
    );

    expect(stored?.event.id).toBe(shared.id);
    expect(rows[0]?.n).toBe(16);
    expect(forLastUnit.map((s) => s.event.kind)).toEqual([
      "unit.recorded@1",
      "context.referenced@1",
    ]);
  });

  test("a commit event enqueues its job in the same transaction, once per commit", async () => {
    const location = freshLocation();
    const oid = "e".repeat(40);
    await runOn(location, Log.append([commitEvent(oid)]));
    await runOn(location, Log.append([commitEvent(oid)]));

    const jobs = await runOn(
      location,
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        return yield* sql`SELECT kind, dedupe_key, state, attempts FROM jobs`;
      }),
    );
    expect(jobs).toEqual([
      {
        kind: "commit.prepare",
        dedupeKey: `commit.prepare:${oid}`,
        state: "waiting",
        attempts: 0,
      },
    ]);
  });
});

// Why (S3 prerequisite b): the lane rules are enforced only at append (0009). An agent approval of a
// human-required unit and a retraction by someone other than the author must be refused, while the
// human approval and the author's own retraction go through.
test("only a human approves human-required work, and only the author retracts", async () => {
  const location = freshLocation();
  const w = workflowEvents();
  const { registrations: r, structure: s, dispositions: d } = w;
  await runOn(
    location,
    Log.append([r.human, r.agent, s.cycle, s.batch, s.unit, s.humanRequired]),
  );
  const unit = { cycleId: w.cycleId, unitIds: [w.unitId] };
  const agentApproval = envelope(
    "disposition.recorded@1",
    "disposition:a-approve",
    agent,
    unit,
    {
      verdict: "approve",
      reviewedHeadOid: headOid,
    },
  );
  const foreignRetraction = envelope(
    "disposition.retracted@1",
    "retraction:by-agent",
    agent,
    unit,
    {},
    {
      supersedes: d.humanApproval.id,
    },
  );

  const refused = await runOn(
    location,
    Effect.flip(Log.append([agentApproval])),
  );
  await runOn(location, Log.append([d.humanApproval, d.agentChange]));
  const foreign = await runOn(
    location,
    Effect.flip(Log.append([foreignRetraction])),
  );
  await runOn(location, Log.append([d.agentRetraction]));
  const current = await runOn(
    location,
    Dispositions.current({ unitId: w.unitId }),
  );

  expect(refused).toMatchObject({
    _tag: "WorkflowRuleViolation",
    rule: "human-required-approval",
  });
  expect(foreign).toMatchObject({
    _tag: "WorkflowRuleViolation",
    rule: "supersedes-other-author",
  });
  expect(current.map((c) => c.eventId)).toEqual([d.humanApproval.id]);
});

// Why (4.13): whether a unit's needed dispositions are in is read against its current lane, and a
// wrong answer silently closes human-required work on an agent's approval.
test("dispositions are judged against the current lane; earlier agent approvals become context", async () => {
  const location = freshLocation();
  const w = workflowEvents();
  const { registrations: r, structure: s } = w;
  const assess = (unitId: string, lane: string) =>
    envelope(
      "assessment.recorded@1",
      `assessment:${unitId}:${lane}`,
      agent,
      { cycleId: w.cycleId, unitIds: [unitId] },
      {
        lane,
        complexity: lane === "agentic" ? "low" : "high",
        easeOfValidation: lane === "agentic" ? "easy" : "hard",
        rationale: lane,
      },
    );
  const approve = (actorId: string, unitId: string) =>
    envelope(
      "disposition.recorded@1",
      `disposition:${actorId.slice(0, 8)}:${unitId}`,
      actorId,
      { cycleId: w.cycleId, unitIds: [unitId] },
      { verdict: "approve", reviewedHeadOid: headOid },
    );
  const judged = (unitId: string) =>
    runOn(location, Dispositions.judge(unitId)).then((j) => ({
      lane: j.lane,
      needs: j.needs,
      closed: j.closed,
      closing: j.closing.map((d) => d.actorKind),
      context: j.context.map((d) => [
        d.actorKind,
        d.verdict,
        d.beforeAssessment,
      ]),
    }));

  // Approve, then reassess: an agent approves agentic work, and the unit becomes human-required.
  await runOn(
    location,
    Log.append([
      r.human,
      r.agent,
      s.cycle,
      s.batch,
      s.unit,
      assess(w.unitId, "agentic"),
    ]),
  );
  await runOn(location, Log.append([approve(agent, w.unitId)]));
  const agentic = await judged(w.unitId);
  await runOn(location, Log.append([assess(w.unitId, "human-required")]));
  const reassessed = await judged(w.unitId);
  await runOn(location, Log.append([approve(human, w.unitId)]));
  const humanApproved = await judged(w.unitId);

  // Approve before any assessment, then assessed human-required.
  const early = mintUlid();
  await runOn(
    location,
    Log.append([
      envelope(
        "unit.recorded@1",
        `unit:${early}`,
        agent,
        { cycleId: w.cycleId, batchId: w.batchId, unitIds: [early] },
        {
          title: "Early",
          ownedRanges: [{ path: "src/b.ts", startLine: 1, endLine: 2 }],
        },
      ),
      approve(agent, early),
    ]),
  );
  const unassessed = await judged(early);
  await runOn(location, Log.append([assess(early, "human-required")]));
  const assessedLater = await judged(early);

  expect(agentic).toEqual({
    lane: "agentic",
    needs: "a-disposition",
    closed: true,
    closing: ["agent"],
    context: [],
  });
  expect(reassessed).toEqual({
    lane: "human-required",
    needs: "a-human-disposition",
    closed: false,
    closing: [],
    context: [["agent", "approve", true]],
  });
  expect(humanApproved).toMatchObject({
    closed: true,
    closing: ["human"],
    context: [["agent", "approve", true]],
  });
  // 10.100: a recorded unit the review never assessed reads as human-suggested, and the agent's
  // approval on it applies; once it is assessed human-required, that approval is context (4.13).
  expect(unassessed).toEqual({
    lane: "human-suggested",
    needs: "a-disposition",
    closed: true,
    closing: ["agent"],
    context: [],
  });
  expect(assessedLater).toEqual({
    lane: "human-required",
    needs: "a-human-disposition",
    closed: false,
    closing: [],
    context: [["agent", "approve", true]],
  });
});

// Why (S3 prerequisite c): a producer that retries a batch mints new IDs for every event, including the
// ones its events link to, earlier or later in the batch. The retry must return the stored events
// instead of a conflict.
test("a retried batch linked through freshly minted IDs returns the stored events", async () => {
  const location = freshLocation();
  const w = workflowEvents();
  const { registrations: r, structure: s } = w;
  const unit = { cycleId: w.cycleId, unitIds: [w.unitId] };
  await runOn(location, Log.append([r.human, s.cycle, s.batch, s.unit]));
  const batch = () => {
    const approval = envelope(
      "disposition.recorded@1",
      "retry:approval",
      human,
      unit,
      {
        verdict: "approve",
        reviewedHeadOid: headOid,
      },
    );
    const change = envelope(
      "disposition.recorded@1",
      "retry:change",
      human,
      unit,
      {
        verdict: "request-changes",
        reviewedHeadOid: headOid,
      },
      { supersedes: approval.id, causedBy: approval.id },
    );
    // Links forward, to an event later in the same batch.
    const note = envelope(
      "comment.recorded@1",
      "retry:note",
      human,
      unit,
      { body: "Why the change was requested" },
      { causedBy: change.id },
    );
    return [note, approval, change];
  };

  const first = await runOn(location, Log.append(batch()));
  const retried = await runOn(location, Log.append(batch()));
  const [stored] = await runOn(
    location,
    Log.history({ kind: "disposition.recorded@1", afterSeq: first[1]!.seq }),
  );

  expect(retried).toEqual(first.map((r) => ({ ...r, status: "existing" })));
  expect(stored?.event.causation).toEqual({
    causedBy: first[1]!.id,
    supersedes: first[1]!.id,
  });
});
