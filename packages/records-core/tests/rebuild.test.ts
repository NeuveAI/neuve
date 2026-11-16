// Why: projections are only trustworthy if they are a pure function of the log (D7). This checks that
// projections maintained in the append transaction equal a replay, and that two stores fed the same
// events, appended at different times and in different batches, project to identical checksums.
import { afterAll, expect, test } from "bun:test";
import { Effect } from "effect";
import { Actors, Admin, Dispositions, Log } from "../src/index.ts";
import {
  agent,
  collidingActors,
  commitEvent,
  cycleEvents,
  envelope,
  workflowEvents,
  freshLocation,
  runOn,
  removeTemporaryDirectories,
} from "./support.ts";

afterAll(removeTemporaryDirectories);

test("rebuild reproduces the appended projections, and equal logs project identically", async () => {
  const { events } = cycleEvents(5);
  const all = [commitEvent("f".repeat(40)), ...events];

  const one = freshLocation();
  await runOn(one, Log.append(all));
  const report = await runOn(one, Admin.rebuild);

  const two = freshLocation();
  for (const event of all) await runOn(two, Log.append([event]));
  const other = await runOn(two, Admin.rebuild);

  expect(report.events).toBe(all.length);
  expect(report.afterCombined).toBe(report.beforeCombined);
  expect(report.after.find((c) => c.table === "projection_units")?.rows).toBe(
    5,
  );
  expect(other.afterCombined).toBe(report.afterCombined);
});

// Why (S3 prerequisite a): `seq` is not causal across capture paths (D18), so two stores holding the
// same events appended in different orders must project identically: the newest assessment's lane, the
// newest model, the first alias holder, and the current dispositions decided by supersedes links.
test("the same events appended in different orders project identically", async () => {
  const w = workflowEvents();
  const { registrations: r, structure: s, turns: t, dispositions: d } = w;
  const causal = [
    r.human,
    r.agent,
    r.first,
    r.second,
    s.cycle,
    s.batch,
    s.unit,
    s.agentic,
    s.humanRequired,
    t.older,
    t.newer,
    d.humanApproval,
    d.humanChange,
    d.agentChange,
    d.agentRetraction,
  ];
  const shuffled = [
    r.second,
    r.first,
    r.agent,
    r.human,
    t.newer,
    s.humanRequired,
    s.agentic,
    s.unit,
    s.batch,
    s.cycle,
    d.agentChange,
    d.humanApproval,
    d.agentRetraction,
    t.older,
    d.humanChange,
  ];
  const read = Effect.gen(function* () {
    const report = yield* Admin.rebuild;
    return {
      checksum: report.afterCombined,
      verified: report.afterCombined === report.beforeCombined,
      current: yield* Dispositions.current({ unitId: w.unitId }),
      actors: (yield* Actors.list).map((a) => [
        a.actorId,
        a.alias,
        a.activity.model,
      ]),
    };
  });

  const one = freshLocation();
  for (const event of causal) await runOn(one, Log.append([event]));
  const two = freshLocation();
  for (const event of shuffled) await runOn(two, Log.append([event]));
  const first = await runOn(one, read);
  const second = await runOn(two, read);

  expect(second).toEqual(first);
  expect(first.verified).toBe(true);
  expect(first.current.map((c) => [c.eventId, c.verdict])).toEqual([
    [d.humanChange.id, "request-changes"],
  ]);
  const alias = new Map(first.actors.map(([id, a]) => [id, a]));
  expect(alias.get(collidingActors[0])?.split("-")).toHaveLength(3);
  expect(alias.get(collidingActors[1])?.split("-")).toHaveLength(4);
  expect(
    alias
      .get(collidingActors[1])
      ?.startsWith(`${alias.get(collidingActors[0])}-`),
  ).toBe(true);
  expect(first.actors.find(([id]) => id === agent)?.[2]).toBe("model-new");
});

// Why (S3 review B1): an actor's kind and identity must come from its earliest registration by ULID,
// not from whichever registration was appended first, or a later conflicting registration could turn
// an agent into a human (or back) depending on capture order.
test("conflicting registrations for one actor project the earliest one in either order", async () => {
  const id = "c".repeat(64);
  const earlier = envelope(
    "actor.registered@1",
    "actor:c:agent",
    id,
    undefined,
    {
      actorKind: "agent",
      harness: "claude-code",
      sessionId: "s-1",
    },
  );
  const later = envelope("actor.registered@1", "actor:c:human", id, undefined, {
    actorKind: "human",
    harness: "git",
    email: "alice@example.com",
  });
  const read = Effect.gen(function* () {
    const report = yield* Admin.rebuild;
    const [actor] = yield* Actors.list;
    return { checksum: report.afterCombined, actor };
  });

  const one = freshLocation();
  await runOn(one, Log.append([earlier, later]));
  const two = freshLocation();
  await runOn(two, Log.append([later, earlier]));
  const first = await runOn(one, read);

  expect(await runOn(two, read)).toEqual(first);
  expect(first.actor).toMatchObject({
    actorKind: "agent",
    harness: "claude-code",
    sessionId: "s-1",
    email: null,
    registeredEventId: earlier.id,
  });
});
