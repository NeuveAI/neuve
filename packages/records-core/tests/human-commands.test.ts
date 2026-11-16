// Why (M5 S1): the human commands are the first path that records a person's disposition, and two
// rules decide closure through them. The human-required approval refusal guards who decides (4.5):
// through the commands, a person's approval closes human-required work, and an actor Records holds
// as anything but a registered human is refused however it is named. RD5 as ruled in 10.100: a
// recorded unit the review never assessed reads as human-suggested and closes on the agent's
// approval unless a person adds judgement; a person's current disposition then stands (RD6).
import { afterAll, expect, test } from "bun:test";
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import {
  Dispositions,
  HumanCommands,
  Identity,
  Log,
  mintUlid,
} from "../src/index.ts";
import {
  agent,
  envelope,
  freshLocation,
  headOid,
  removeTemporaryDirectories,
  runOn,
  workflowEvents,
} from "./support.ts";

afterAll(removeTemporaryDirectories);

const owner = { email: "Owner@Example.com", displayName: "Owner" };

/** A cycle with one recorded unit (owned lines src/a.ts new 10-20) and no assessment. */
const unassessedUnit = () => {
  const w = workflowEvents();
  const unitId = mintUlid();
  const unit = envelope(
    "unit.recorded@2",
    `unit:${unitId}`,
    agent,
    { cycleId: w.cycleId, batchId: w.batchId, unitIds: [unitId] },
    {
      title: "Unassessed",
      ownedRanges: [
        {
          kind: "lines",
          path: "src/a.ts",
          side: "new",
          startLine: 10,
          endLine: 20,
        },
      ],
      grouping: { gapLines: 20 },
    },
  );
  return {
    w,
    unitId,
    events: [w.registrations.agent, w.structure.cycle, w.structure.batch, unit],
  };
};

const judged = (unitId: string) =>
  Effect.map(Dispositions.judge(unitId), (j) => ({
    lane: j.lane,
    assessed: j.assessed,
    needs: j.needs,
    closed: j.closed,
    closing: j.closing.map((d) => [d.actorKind, d.verdict]),
    context: j.context.map((d) => [d.actorKind, d.verdict]),
    standing:
      j.standing === null ? null : [j.standing.actorKind, j.standing.verdict],
  }));

const dispositionCount = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const [row] = yield* sql<{
    n: number;
  }>`SELECT count(*) AS n FROM events WHERE kind = 'disposition.recorded@2'`;
  return row!.n;
});

test("through the human commands, a person approves human-required work and nobody else does", async () => {
  const location = freshLocation();
  const w = workflowEvents();
  const { registrations: r, structure: s } = w;
  await runOn(
    location,
    Log.append([r.agent, s.cycle, s.batch, s.unit, s.humanRequired]),
  );
  const agentApproval = envelope(
    "disposition.recorded@2",
    "agent:approve",
    agent,
    { cycleId: w.cycleId, unitIds: [w.unitId] },
    { verdict: "approve", reviewedHeadOid: headOid, restsOn: [], proof: [] },
  );
  const agentRefused = await runOn(
    location,
    Effect.flip(Log.append([agentApproval])),
  );

  // An actor ID Records first registered as an agent is not a human, whatever the command calls it.
  const forged = { email: "forged@example.com" };
  await runOn(
    location,
    Log.append([
      envelope(
        "actor.registered@1",
        "actor:forged-as-agent",
        Identity.humanFingerprint(forged.email),
        undefined,
        { actorKind: "agent", harness: "test", sessionId: "forged" },
      ),
    ]),
  );
  const forgedRefused = await runOn(
    location,
    Effect.flip(
      HumanCommands.recordDisposition({
        person: forged,
        unitId: w.unitId,
        verdict: "approve",
      }),
    ),
  );
  const noEmail = await runOn(
    location,
    Effect.flip(
      HumanCommands.recordDisposition({
        person: { email: " " },
        unitId: w.unitId,
        verdict: "approve",
      }),
    ),
  );
  const before = await runOn(location, judged(w.unitId));
  const recorded = await runOn(
    location,
    HumanCommands.recordDisposition({
      person: owner,
      unitId: w.unitId,
      verdict: "approve",
      note: "Checked the reassessed paths.",
    }),
  );
  const after = await runOn(location, judged(w.unitId));
  const stored = await runOn(location, Log.get(recorded.dispositionId));

  expect(agentRefused).toMatchObject({
    _tag: "WorkflowRuleViolation",
    rule: "human-required-approval",
  });
  expect(forgedRefused).toMatchObject({
    _tag: "WorkflowRuleViolation",
    rule: "human-required-approval",
  });
  expect(noEmail).toMatchObject({
    _tag: "HumanCommandRefused",
    reason: "no-email",
  });
  expect(before).toMatchObject({
    lane: "human-required",
    closed: false,
    standing: null,
  });
  expect(after).toMatchObject({
    lane: "human-required",
    needs: "a-human-disposition",
    closed: true,
    closing: [["human", "approve"]],
    standing: ["human", "approve"],
  });
  // The person is the actor, with the cycle's head as the reviewed source.
  expect(recorded.actor).toBe(Identity.humanFingerprint("owner@example.com"));
  expect(stored._tag === "Some" && stored.value.event).toMatchObject({
    kind: "disposition.recorded@2",
    actor: recorded.actor,
    payload: { verdict: "approve", reviewedHeadOid: headOid },
  });
  expect(await runOn(location, dispositionCount)).toBe(1);
});

test("an unassessed unit closes on the agent's approval until a person adds judgement (10.100)", async () => {
  const location = freshLocation();
  const { w, unitId, events } = unassessedUnit();
  await runOn(location, Log.append(events));
  const unit = { cycleId: w.cycleId, unitIds: [unitId] };
  await runOn(
    location,
    Log.append([
      envelope(
        "disposition.recorded@2",
        "agent:approve-unassessed",
        agent,
        unit,
        {
          verdict: "approve",
          reviewedHeadOid: headOid,
          restsOn: [],
          proof: [],
        },
      ),
    ]),
  );
  const agentOnly = await runOn(location, judged(unitId));

  const outside = await runOn(
    location,
    Effect.flip(
      HumanCommands.recordDisposition({
        person: owner,
        unitId,
        verdict: "request-changes",
        comments: [
          {
            body: "Not this unit's line.",
            anchor: {
              path: "src/a.ts",
              side: "new",
              startLine: 21,
              endLine: 21,
            },
          },
        ],
      }),
    ),
  );
  const bare = await runOn(
    location,
    Effect.flip(
      HumanCommands.recordDisposition({
        person: owner,
        unitId,
        verdict: "request-changes",
      }),
    ),
  );
  const request = await runOn(
    location,
    HumanCommands.recordDisposition({
      person: owner,
      unitId,
      verdict: "request-changes",
      comments: [
        {
          body: "Handle the empty list.",
          anchor: { path: "src/a.ts", side: "new", startLine: 12, endLine: 14 },
        },
      ],
    }),
  );
  const personOverrides = await runOn(location, judged(unitId));
  const stored = await runOn(location, Log.get(request.dispositionId));
  await runOn(
    location,
    HumanCommands.retractDisposition({
      person: owner,
      dispositionId: request.dispositionId,
    }),
  );
  const undone = await runOn(location, judged(unitId));

  expect(agentOnly).toEqual({
    lane: "human-suggested",
    assessed: false,
    needs: "a-disposition",
    closed: true,
    closing: [["agent", "approve"]],
    context: [],
    standing: ["agent", "approve"],
  });
  expect(outside).toMatchObject({
    _tag: "HumanCommandRefused",
    reason: "anchor-outside-owned-lines",
  });
  expect(bare).toMatchObject({
    _tag: "HumanCommandRefused",
    reason: "request-without-comment",
  });
  expect(personOverrides).toMatchObject({
    lane: "human-suggested",
    closed: true,
    standing: ["human", "request-changes"],
  });
  // The request rests on the comment recorded first in the same transaction.
  expect(stored._tag === "Some" && stored.value.event.payload).toMatchObject({
    restsOn: request.commentIds,
  });
  expect(request.commentIds).toHaveLength(1);
  expect(undone).toMatchObject({
    closed: true,
    standing: ["agent", "approve"],
  });
});

// Why (10.102): the desk's "Comment on this unit" is on the whole unit, and a comment on a context
// marker takes that marker's lines. A dock comment that named no lines was once pinned to the unit's
// first changed lines, so it read back later as a line comment. This records both kinds, through
// the comment and through a request for changes, and reads them back from the log as stored.
test("a comment on the whole unit records with no lines; one on a marker keeps the marker's lines", async () => {
  const location = freshLocation();
  const { unitId, events } = unassessedUnit();
  await runOn(location, Log.append(events));
  const marker = {
    path: "src/a.ts",
    side: "new" as const,
    startLine: 12,
    endLine: 14,
  };
  const whole = await runOn(
    location,
    HumanCommands.recordComment({
      person: owner,
      unitId,
      comment: { body: "This unit needs a migration note." },
    }),
  );
  const onMarker = await runOn(
    location,
    HumanCommands.recordComment({
      person: owner,
      unitId,
      comment: { body: "The reference contradicts this.", anchor: marker },
    }),
  );
  const request = await runOn(
    location,
    HumanCommands.recordDisposition({
      person: owner,
      unitId,
      verdict: "request-changes",
      comments: [{ body: "Split the unit before it lands." }],
    }),
  );
  const payload = (id: string) =>
    Effect.map(Log.get(id), (stored) =>
      stored._tag === "Some" ? stored.value.event.payload : undefined,
    );
  const readBack = await runOn(
    location,
    Effect.all({
      whole: payload(whole.commentId),
      onMarker: payload(onMarker.commentId),
      requested: payload(request.commentIds[0]!),
      history: Effect.map(
        Log.history({ unitId, kind: "comment.recorded@2" }),
        (stored) => stored.map((entry) => entry.event.id),
      ),
    }),
  );

  expect(readBack.whole).toEqual({ body: "This unit needs a migration note." });
  expect(readBack.onMarker).toEqual({
    body: "The reference contradicts this.",
    anchor: marker,
  });
  expect(readBack.requested).toEqual({
    body: "Split the unit before it lands.",
  });
  expect(readBack.history).toEqual([
    whole.commentId,
    onMarker.commentId,
    ...request.commentIds,
  ]);
});
