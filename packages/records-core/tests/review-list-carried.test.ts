// Why: a unit a person's carried decision closes must not be listed as waiting. `decided` reads
// the rows `Dispositions.current` reads, carried ones included, and still only registered people's.
import { afterAll, expect, test } from "bun:test";
import { RecordEvent } from "@neuve/records-schema";
import { Effect } from "effect";
import { Log, ReviewList, mintUlid, sha256Hex } from "../src/index.ts";
import {
  actor as agent,
  cycleEvents,
  freshLocation,
  headOid,
  removeTemporaryDirectories,
  runOn,
} from "./support.ts";

afterAll(removeTemporaryDirectories);

const person = sha256Hex("neuve-actor/1\u0000human\u0000decider@example.com");
const from = {
  review: "earlier",
  cycle: mintUlid(),
  head: headOid,
  judgement: mintUlid(),
  output: mintUlid(),
  savedMs: 0,
};

test("a person's carried decision is a decision; an agent's is not; the person's own later one stands", async () => {
  const location = freshLocation();
  const data = cycleEvents(2);
  const opened = RecordEvent.parse(data.events[0]);
  if (opened.kind !== "cycle.opened@1")
    throw new Error("fixture must open a cycle");
  const cycleId = opened.attribution.cycleId;
  const [byPerson, byAgent] = data.unitIds as [string, string];
  const decision = (
    actor: string,
    unitId: string,
    kind: string,
    verdict: string,
    extra: Record<string, unknown> = {},
  ) => ({
    id: mintUlid(),
    kind,
    actor,
    occurredAt: new Date().toISOString(),
    idempotencyKey: mintUlid(),
    attribution: { cycleId, unitIds: [unitId] },
    payload: {
      verdict,
      reviewedHeadOid: headOid,
      restsOn: [],
      proof: [],
      ...extra,
    },
  });
  const result = await runOn(
    location,
    Effect.gen(function* () {
      yield* Log.append([
        ...data.events,
        {
          id: mintUlid(),
          kind: "actor.registered@1",
          idempotencyKey: `actor:${person}`,
          actor: person,
          occurredAt: new Date().toISOString(),
          payload: {
            actorKind: "human",
            harness: "git",
            email: "decider@example.com",
          },
        },
      ]);
      const units = [
        { unitId: byPerson, cycleId },
        { unitId: byAgent, cycleId },
      ];
      yield* Log.append([
        decision(person, byPerson, "disposition.carried@1", "approve", {
          lineage: "carried",
          from,
        }),
        decision(agent, byAgent, "disposition.carried@1", "approve", {
          lineage: "carried",
          from,
        }),
      ]);
      const carried = yield* ReviewList.decided(units);
      yield* Log.append([
        decision(person, byPerson, "disposition.recorded@2", "request-changes"),
      ]);
      const later = yield* ReviewList.decided(units);
      return { carried, later };
    }),
  );
  expect(result.carried).toEqual([
    { unitId: byPerson, cycleId, verdict: "approve" },
  ]);
  expect(result.later).toEqual([
    { unitId: byPerson, cycleId, verdict: "request-changes" },
  ]);
});
