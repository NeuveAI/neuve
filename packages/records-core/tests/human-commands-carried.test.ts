// Why: a person's later decision on a unit must replace the decision of theirs carried onto it by
// name, never by which ID sorts later: the publisher mints carried decisions on its own clock,
// which can be ahead of the clock a person's command runs on. A retraction of a carried approval
// reopens the unit, and a person's command never touches another actor's carried decision.
import { afterAll, expect, test } from "bun:test";
import { RecordEvent } from "@neuve/records-schema";
import { Effect } from "effect";
import { ulid } from "ulid";
import {
  Dispositions,
  HumanCommands,
  Identity,
  Log,
  ReviewList,
  mintUlid,
} from "../src/index.ts";
import {
  actor as agent,
  cycleEvents,
  freshLocation,
  headOid,
  removeTemporaryDirectories,
  runOn,
} from "./support.ts";

afterAll(removeTemporaryDirectories);

const email = "carried@example.com";
const person = Identity.humanFingerprint(email);
const from = {
  review: "earlier",
  cycle: mintUlid(),
  head: headOid,
  judgement: mintUlid(),
  output: mintUlid(),
  savedMs: 0,
};
/** Two minutes ahead of this clock, as a publisher's plan clock can be. */
const ahead = () => ulid(Date.now() + 120_000);

const setup = () => {
  const data = cycleEvents(2);
  const opened = RecordEvent.parse(data.events[0]);
  if (opened.kind !== "cycle.opened@1")
    throw new Error("fixture must open a cycle");
  const cycleId = opened.attribution.cycleId;
  const unitId = data.unitIds[1]!;
  const carried = (actor: string, verdict: "approve" | "request-changes") => ({
    id: ahead(),
    kind: "disposition.carried@1",
    idempotencyKey: `test:carried:${actor}:${verdict}`,
    actor,
    occurredAt: new Date().toISOString(),
    attribution: { cycleId, unitIds: [unitId] },
    payload: {
      verdict,
      reviewedHeadOid: headOid,
      restsOn: [],
      proof: [],
      lineage: "carried",
      from,
    },
  });
  const registered = {
    id: mintUlid(),
    kind: "actor.registered@1",
    idempotencyKey: `actor:${person}`,
    actor: person,
    occurredAt: new Date().toISOString(),
    payload: { actorKind: "human", harness: "git", email },
  };
  return { data, cycleId, unitId, carried, registered };
};

test("a person's command replaces their carried decision by name, even with the publisher's clock ahead", async () => {
  const { data, cycleId, unitId, carried, registered } = setup();
  const theirs = carried(person, "approve");
  const agents = carried(agent, "request-changes");
  const result = await runOn(
    freshLocation(),
    Effect.gen(function* () {
      yield* Log.append([...data.events, registered, theirs, agents]);
      const recorded = yield* HumanCommands.recordDisposition({
        person: { email },
        unitId,
        verdict: "request-changes",
        comments: [{ body: "Bound the retry." }],
      });
      const held = yield* Log.get(recorded.dispositionId);
      return {
        recorded,
        event: held._tag === "Some" ? held.value.event : undefined,
        current: yield* Dispositions.current({ unitId, cycleId }),
        judged: yield* Dispositions.judge(unitId),
        decided: yield* ReviewList.decided([{ unitId, cycleId }]),
      };
    }),
  );
  expect(result.recorded.replaced).toBe(theirs.id);
  expect(result.event?.causation?.supersedes).toBe(theirs.id);
  // The person's request for changes is current and the carried approval is not; the agent's
  // carried decision is untouched.
  expect(
    result.current.map((d) => [d.actorId, d.verdict, d.eventId]).sort(),
  ).toEqual(
    [
      [person, "request-changes", result.recorded.dispositionId],
      [agent, "request-changes", agents.id],
    ].sort(),
  );
  expect(result.judged.standing?.eventId).toBe(result.recorded.dispositionId);
  expect(result.decided).toEqual([
    { unitId, cycleId, verdict: "request-changes" },
  ]);
});

/** The unit made human-required, so only a person's decision closes it. */
const humanRequired = (cycleId: string, unitId: string) => ({
  id: mintUlid(),
  kind: "assessment.recorded@1",
  idempotencyKey: `test:assess:${unitId}`,
  actor: agent,
  occurredAt: new Date().toISOString(),
  attribution: { cycleId, unitIds: [unitId] },
  payload: {
    lane: "human-required",
    complexity: "high",
    easeOfValidation: "hard",
    rationale: "Hard to validate.",
  },
});

test("a person retracting their carried approval through the command reopens the unit", async () => {
  const { data, cycleId, unitId, carried, registered } = setup();
  const theirs = carried(person, "approve");
  const result = await runOn(
    freshLocation(),
    Effect.gen(function* () {
      yield* Log.append([
        ...data.events,
        humanRequired(cycleId, unitId),
        registered,
        theirs,
      ]);
      const before = yield* Dispositions.judge(unitId);
      const retracted = yield* HumanCommands.retractDisposition({
        person: { email },
        dispositionId: theirs.id,
      });
      const held = yield* Log.get(retracted.retractionId);
      return {
        before,
        retraction: held._tag === "Some" ? held.value.event : undefined,
        after: yield* Dispositions.judge(unitId),
        current: yield* Dispositions.current({ unitId, cycleId }),
        decided: yield* ReviewList.decided([{ unitId, cycleId }]),
      };
    }),
  );
  expect(result.before).toMatchObject({ lane: "human-required", closed: true });
  expect(result.retraction?.causation?.supersedes).toBe(theirs.id);
  expect(result.after).toMatchObject({ lane: "human-required", closed: false });
  expect(result.current.filter((d) => d.actorId === person)).toEqual([]);
  expect(result.decided).toEqual([]);
});

test("a person cannot retract another person's carried decision, nor an agent's", async () => {
  const { data, cycleId, unitId, carried, registered } = setup();
  const otherEmail = "someone-else@example.com";
  const other = Identity.humanFingerprint(otherEmail);
  const others = carried(other, "approve");
  const agents = carried(agent, "request-changes");
  const result = await runOn(
    freshLocation(),
    Effect.gen(function* () {
      yield* Log.append([
        ...data.events,
        humanRequired(cycleId, unitId),
        registered,
        {
          id: mintUlid(),
          kind: "actor.registered@1",
          idempotencyKey: `actor:${other}`,
          actor: other,
          occurredAt: new Date().toISOString(),
          payload: { actorKind: "human", harness: "git", email: otherEmail },
        },
        others,
        agents,
      ]);
      const attempt = (dispositionId: string) =>
        Effect.flip(
          HumanCommands.retractDisposition({
            person: { email },
            dispositionId,
          }),
        );
      return {
        ofOther: yield* attempt(others.id),
        ofAgent: yield* attempt(agents.id),
        current: yield* Dispositions.current({ unitId, cycleId }),
        judged: yield* Dispositions.judge(unitId),
      };
    }),
  );
  for (const refused of [result.ofOther, result.ofAgent])
    expect(refused).toMatchObject({
      _tag: "HumanCommandRefused",
      reason: "unknown-disposition",
      message: expect.stringContaining("not one of yours"),
    });
  expect(result.current.map((d) => d.eventId).sort()).toEqual(
    [others.id, agents.id].sort(),
  );
  expect(result.judged.closed).toBe(true);
});
