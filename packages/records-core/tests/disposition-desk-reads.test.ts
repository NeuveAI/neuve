// Why: the review desk judges every unit of a review on each page load, so `Dispositions.current`
// must read through the indexes instead of every disposition in the store. A rewritten filter is easy
// to get subtly wrong (a lost row, a changed order), so each filter is checked against the statement
// it replaced, kept here as the reference, on a store with every kind of disposition; the plan is the
// point of the change, so the unit filter must name the dispositions' index. The desk's batched reads
// (`currentMany`, `successorsMany`) must answer exactly what the per-unit reads answer, for units
// with nothing too, across a 500-unit page. The live rule's checks read only what names the row
// (its supersession links, its unit's events), so the references keep the live rule as it was
// before that narrowing too: a narrowed check that lost one superseding copy would let a withdrawn
// decision stand, and every reader would see it.
import { afterAll, expect, test } from "bun:test";
import { DispositionView, safeRead } from "@neuve/records-schema";
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { dispositionRows } from "../src/carried-relations.ts";
import {
  Dispositions,
  Lineage,
  Log,
  ReviewList,
  mintUlid,
  sha256Hex,
} from "../src/index.ts";
import {
  freshLocation,
  headOid,
  removeTemporaryDirectories,
  runOn,
} from "./support.ts";

afterAll(removeTemporaryDirectories);

/**
 * The live rule as it was before its checks were narrowed to what names the row: the second check
 * read every carried copy the row's actor recorded. The reference every read here is checked against.
 */
const liveBeforeNarrowing = (alias: string) =>
  `NOT EXISTS (SELECT 1 FROM projection_supersessions s JOIN events e ON e.id = s.by_event_id
    WHERE s.target_id = ${alias}.event_id AND e.actor_id = ${alias}.actor_id
    AND e.kind IN ('disposition.recorded@1', 'disposition.recorded@2', 'disposition.retracted@1'))
    AND NOT EXISTS (SELECT 1 FROM events e WHERE e.kind = 'disposition.carried@1' AND e.actor_id = ${alias}.actor_id
      AND json_extract(e.envelope, '$.causation.supersedes') = ${alias}.event_id)`;

const range = { baseRef: "refs/heads/main", baseOid: "b".repeat(40), headOid };
const at = "2026-11-13T09:00:00.000Z";

/** A deterministic generator, so a failure reproduces. */
const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/**
 * Three cycles of 30 units; 400 dispositions by three people, three agents and an unregistered
 * actor, recorded (both versions), replaced, retracted and carried, a tenth of them naming another
 * cycle than their unit's; lanes on most units; lineage from each cycle's units to the previous
 * cycle's, one successor named by two lineage events.
 */
const busyStore = () => {
  const random = seeded(148);
  const pick = <A>(items: ReadonlyArray<A>) =>
    items[Math.floor(random() * items.length)]!;
  const humans = [0, 1, 2].map((n) =>
    sha256Hex(`neuve-actor/1\u0000human\u0000p${n}@example.com`),
  );
  const agents = [0, 1, 2].map((n) =>
    sha256Hex(`neuve-actor/1\u0000agent\u0000a${n}`),
  );
  const actors = [...humans, ...agents, sha256Hex("neuve-actor/1\u0000nobody")];
  const event = (
    kind: string,
    actor: string,
    attribution: unknown,
    payload: unknown,
    causation?: unknown,
  ) => ({
    id: mintUlid(),
    kind,
    idempotencyKey: mintUlid(),
    actor,
    occurredAt: at,
    ...(attribution === undefined ? {} : { attribution }),
    ...(causation === undefined ? {} : { causation }),
    payload,
  });
  const events: Array<unknown> = [
    ...humans.map((id, n) =>
      event("actor.registered@1", id, undefined, {
        actorKind: "human",
        harness: "git",
        email: `p${n}@example.com`,
      }),
    ),
    ...agents.map((id, n) =>
      event("actor.registered@1", id, undefined, {
        actorKind: "agent",
        harness: "test",
        sessionId: `s${n}`,
      }),
    ),
  ];
  const cycles: Array<{ cycleId: string; unitIds: Array<string> }> = [];
  for (let c = 0; c < 3; c++) {
    const cycleId = mintUlid();
    const batchId = mintUlid();
    const unitIds = Array.from({ length: 30 }, () => mintUlid());
    events.push(
      event("cycle.opened@1", humans[0]!, { cycleId, range }, {}),
      event(
        "batch.recorded@1",
        agents[0]!,
        { cycleId, batchId },
        { title: "Batch", focus: "Focus" },
      ),
      ...unitIds.map((unitId, index) =>
        event(
          "unit.recorded@1",
          agents[0]!,
          { cycleId, batchId, unitIds: [unitId] },
          {
            title: `Unit ${index}`,
            ownedRanges: [
              { path: `src/${index}.ts`, startLine: 1, endLine: 9 },
            ],
          },
        ),
      ),
    );
    cycles.push({ cycleId, unitIds });
  }
  const units = cycles.flatMap((cycle) =>
    cycle.unitIds.map((unitId) => ({ unitId, cycleId: cycle.cycleId })),
  );
  const from = {
    review: "earlier",
    cycle: mintUlid(),
    head: headOid,
    judgement: "c".repeat(64),
    output: "d".repeat(64),
    savedMs: 0,
  };
  const held = new Map<string, Array<string>>();
  const made = {
    retracted: 0,
    replaced: 0,
    carried: 0,
    otherCycle: 0,
    // A carried copy that supersedes, one a later disposition replaces, one a person retracts.
    carriedSuperseding: 0,
    carriedReplaced: 0,
    carriedRetractedByPerson: 0,
  };
  const carriedIds = new Set<string>();
  // The last five units of each cycle get no disposition.
  const decided = cycles.flatMap((cycle) =>
    cycle.unitIds
      .slice(0, -5)
      .map((unitId) => ({ unitId, cycleId: cycle.cycleId })),
  );
  for (let n = 0; n < 400; n++) {
    const unit = pick(decided);
    const otherCycle = random() < 0.1;
    const cycleId = otherCycle ? pick(cycles).cycleId : unit.cycleId;
    const actor = pick(actors);
    const key = `${unit.unitId} ${cycleId} ${actor}`;
    const earlier = held.get(key) ?? [];
    const attribution = { cycleId, unitIds: [unit.unitId] };
    const roll = random();
    const verdict = random() < 0.7 ? "approve" : "request-changes";
    const body = { verdict, reviewedHeadOid: headOid, restsOn: [], proof: [] };
    let next;
    if (roll < 0.12 && earlier.length > 0) {
      made.retracted++;
      const target = pick(earlier);
      if (carriedIds.has(target) && humans.includes(actor))
        made.carriedRetractedByPerson++;
      next = event(
        "disposition.retracted@1",
        actor,
        attribution,
        { reason: "Withdrawn" },
        { supersedes: target },
      );
    } else if (roll < 0.24) {
      made.carried++;
      const supersedes =
        earlier.length > 0 && random() < 0.5 ? earlier.at(-1) : undefined;
      if (supersedes !== undefined) made.carriedSuperseding++;
      next = event(
        "disposition.carried@1",
        actor,
        attribution,
        { ...body, lineage: "carried", from },
        supersedes === undefined ? undefined : { supersedes },
      );
      carriedIds.add(next.id);
    } else if (roll < 0.4 && earlier.length > 0) {
      made.replaced++;
      if (carriedIds.has(earlier.at(-1)!)) made.carriedReplaced++;
      next = event("disposition.recorded@2", actor, attribution, body, {
        supersedes: earlier.at(-1),
      });
    } else if (roll < 0.45) {
      next = event("disposition.recorded@1", actor, attribution, {
        verdict,
        reviewedHeadOid: headOid,
      });
    } else {
      next = event("disposition.recorded@2", actor, attribution, body);
    }
    if (otherCycle && cycleId !== unit.cycleId) made.otherCycle++;
    if (next.kind !== "disposition.retracted@1")
      held.set(key, [...earlier, next.id]);
    events.push(next);
  }
  // Chains that always hold a carried copy's supersession, by people and agents in turn: on twelve
  // units, a decision, then a carried copy that supersedes it, then a carried copy of that copy, a
  // replacement of it or a retraction of it.
  for (let n = 0; n < 12; n++) {
    const unit = decided[n * 5]!;
    const actor = n % 2 === 0 ? humans[n % 3]! : agents[n % 3]!;
    const key = `${unit.unitId} ${unit.cycleId} ${actor}`;
    const attribution = { cycleId: unit.cycleId, unitIds: [unit.unitId] };
    const body = (verdict: string) => ({
      verdict,
      reviewedHeadOid: headOid,
      restsOn: [],
      proof: [],
    });
    const carried = (supersedes: string) =>
      event(
        "disposition.carried@1",
        actor,
        attribution,
        { ...body("approve"), lineage: "carried", from },
        { supersedes },
      );
    const first = event(
      "disposition.recorded@2",
      actor,
      attribution,
      body(n % 4 < 2 ? "approve" : "request-changes"),
    );
    const copy = carried(first.id);
    made.carried++;
    made.carriedSuperseding++;
    carriedIds.add(copy.id);
    const last =
      n % 3 === 0
        ? carried(copy.id)
        : n % 3 === 1
          ? event(
              "disposition.recorded@2",
              actor,
              attribution,
              body("request-changes"),
              {
                supersedes: copy.id,
              },
            )
          : event(
              "disposition.retracted@1",
              actor,
              attribution,
              { reason: "Withdrawn" },
              { supersedes: copy.id },
            );
    if (n % 3 === 0) {
      made.carried++;
      made.carriedSuperseding++;
      carriedIds.add(last.id);
    } else if (n % 3 === 1) made.carriedReplaced++;
    else if (humans.includes(actor)) made.carriedRetractedByPerson++;
    const ids = [first.id, copy.id];
    if (last.kind !== "disposition.retracted@1") ids.push(last.id);
    held.set(key, [...(held.get(key) ?? []), ...ids]);
    events.push(first, copy, last);
  }
  // Lanes after the decisions, so the human-required approval rule refuses none of them.
  const lanes = [
    "static-automation",
    "agentic",
    "human-suggested",
    "human-required",
  ];
  for (const unit of units)
    if (random() < 0.8)
      events.push(
        event(
          "assessment.recorded@1",
          agents[0]!,
          { cycleId: unit.cycleId, unitIds: [unit.unitId] },
          {
            lane: pick(lanes),
            complexity: "low",
            easeOfValidation: "easy",
            rationale: "Read",
          },
        ),
      );
  const link = (c: number, successor: string, earlierUnits: Array<string>) =>
    event(
      "lineage.recorded@1",
      agents[0]!,
      { cycleId: cycles[c]!.cycleId, unitIds: [successor, ...earlierUnits] },
      {
        from: earlierUnits.map((unitId) => {
          const unchanged = random() < 0.5;
          return {
            unitId,
            cycleId: cycles[c - 1]!.cycleId,
            relation: unchanged ? "unchanged" : "changed",
            unchanged: unchanged ? 2 : 1,
            changed: unchanged ? 0 : 1,
            lane: null,
          };
        }),
      },
    );
  let first: { successor: string; earlier: Array<string> } | undefined;
  for (let c = 1; c < cycles.length; c++)
    for (const successor of cycles[c]!.unitIds) {
      if (random() < 0.5) continue;
      const earlier = [
        ...new Set(
          Array.from({ length: 1 + Math.floor(random() * 3) }, () =>
            pick(cycles[c - 1]!.unitIds),
          ),
        ),
      ];
      first ??= { successor, earlier };
      events.push(link(c, successor, earlier));
    }
  // The same successor again, newer: each earlier unit reads it once, from this event.
  if (first !== undefined) events.push(link(1, first.successor, first.earlier));
  return { events, cycles, units, humans, agents, made };
};

/** The statement `current` ran before it read through the indexes: the reference. */
const reference = (filter: {
  readonly unitId?: string | undefined;
  readonly cycleId?: string | undefined;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const live = (alias: string) => sql.literal(liveBeforeNarrowing(alias));
    const rows = yield* sql<
      Record<string, unknown>
    >`WITH all_dispositions AS ${sql.literal(dispositionRows)} SELECT d.event_id, d.unit_id, d.cycle_id, d.actor_id,
      d.verdict, d.reviewed_head_oid, d.rests_on_count, d.proof_count FROM all_dispositions d
      WHERE (${filter.unitId ?? null} IS NULL OR d.unit_id = ${filter.unitId ?? null})
        AND (${filter.cycleId ?? null} IS NULL OR d.cycle_id = ${filter.cycleId ?? null})
        AND ${live("d")}
        AND d.event_id = (SELECT max(n.event_id) FROM all_dispositions n
          WHERE n.unit_id = d.unit_id AND n.cycle_id = d.cycle_id AND n.actor_id = d.actor_id AND ${live("n")})
      ORDER BY d.unit_id, d.cycle_id, d.actor_id`;
    return rows.map((row) => {
      const parsed = safeRead(DispositionView, row);
      if (!parsed.success) throw new Error(parsed.error.message);
      return parsed.data;
    });
  });

/** `ReviewList.decided` as it ran before its unit filter moved inside the rows: the reference. */
const decidedReference = (
  units: ReadonlyArray<{ readonly unitId: string; readonly cycleId: string }>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const live = (alias: string) => sql.literal(liveBeforeNarrowing(alias));
    const cycleOf = new Map(units.map((unit) => [unit.unitId, unit.cycleId]));
    const rows = yield* sql<{
      unitId: string;
      cycleId: string;
      verdict: string;
      eventId: string;
    }>`WITH all_dispositions AS ${sql.literal(dispositionRows)}
      SELECT d.unit_id, d.cycle_id, d.verdict, d.event_id
      FROM all_dispositions d
      JOIN projection_actors a ON a.actor_id = d.actor_id AND a.actor_kind = 'human'
      WHERE ${live("d")}
        AND d.event_id = (SELECT max(n.event_id) FROM all_dispositions n
          WHERE n.unit_id = d.unit_id AND n.cycle_id = d.cycle_id AND n.actor_id = d.actor_id
            AND ${live("n")})`;
    const standing = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      if (cycleOf.get(row.unitId) !== row.cycleId) continue;
      const known = standing.get(row.unitId);
      if (known === undefined || row.eventId > known.eventId)
        standing.set(row.unitId, row);
    }
    return [...cycleOf.keys()].flatMap((unitId) => {
      const row = standing.get(unitId);
      return row === undefined
        ? []
        : [{ unitId, cycleId: row.cycleId, verdict: row.verdict }];
    });
  });

/** `Dispositions.judge` over the reference rows: the unit's lane and each actor's kind, judged. */
const judgeReference = (unitId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const [unit] = yield* sql<{
      cycleId: string | null;
      lane: Dispositions.UnitJudgement["lane"];
      assessmentEventId: string | null;
      recordedEventId: string | null;
    }>`SELECT cycle_id, lane, assessment_event_id, recorded_event_id FROM projection_units WHERE unit_id = ${unitId}`;
    const assessmentEventId = unit?.assessmentEventId ?? null;
    const judged: Array<Dispositions.JudgedDisposition> = [];
    for (const row of yield* reference({
      unitId,
      cycleId: unit?.cycleId ?? undefined,
    })) {
      const [actor] = yield* sql<{
        actorKind: string;
      }>`SELECT actor_kind FROM projection_actors WHERE actor_id = ${row.actorId}`;
      judged.push({
        ...row,
        actorKind:
          actor?.actorKind === "human" || actor?.actorKind === "agent"
            ? actor.actorKind
            : "unregistered",
        beforeAssessment:
          assessmentEventId === null || row.eventId < assessmentEventId,
      });
    }
    return Dispositions.judgeDispositions(
      {
        unitId,
        cycleId: unit?.cycleId ?? null,
        lane: unit?.lane ?? null,
        assessmentEventId,
        recorded: (unit?.recordedEventId ?? null) !== null,
      },
      judged,
    );
  });

const planOfStatement = (statement: {
  readonly compile: () => readonly [string, ReadonlyArray<unknown>];
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const [text, params] = statement.compile();
    const rows = yield* sql.unsafe<{ detail: string }>(
      `EXPLAIN QUERY PLAN ${text}`,
      params as Array<unknown>,
    );
    return rows.map((row) => row.detail);
  });

const planOf = (filter: {
  readonly unitId?: string | undefined;
  readonly cycleId?: string | undefined;
}) => Effect.flatMap(Dispositions.currentQuery(filter), planOfStatement);

const store = busyStore();
const location = freshLocation();
const loaded = runOn(
  location,
  Effect.gen(function* () {
    for (let n = 0; n < store.events.length; n += 500)
      yield* Log.append(store.events.slice(n, n + 500));
  }),
);

test("every filter answers what the statement it replaced answers, through the indexes", async () => {
  await loaded;
  const result = await runOn(
    location,
    Effect.gen(function* () {
      const filters: Array<{ unitId?: string; cycleId?: string }> = [
        {},
        { unitId: mintUlid() },
        { cycleId: mintUlid() },
        ...store.cycles.map((cycle) => ({ cycleId: cycle.cycleId })),
        ...store.units.flatMap((unit) => [
          { unitId: unit.unitId },
          ...store.cycles.map((cycle) => ({
            unitId: unit.unitId,
            cycleId: cycle.cycleId,
          })),
        ]),
      ];
      const differing: Array<unknown> = [];
      let rows = 0;
      for (const filter of filters) {
        const now = yield* Dispositions.current(filter);
        const before = yield* reference(filter);
        rows += now.length;
        if (JSON.stringify(now) !== JSON.stringify(before))
          differing.push(filter);
      }
      const all = yield* Dispositions.current({});
      return {
        differing,
        filters: filters.length,
        rows,
        all,
        plans: {
          unit: yield* planOf({ unitId: store.units[0]!.unitId }),
          both: yield* planOf({
            unitId: store.units[0]!.unitId,
            cycleId: store.units[0]!.cycleId,
          }),
          cycle: yield* planOf({ cycleId: store.units[0]!.cycleId }),
        },
      };
    }),
  );
  // The store holds every case the newest check and the live rule decide.
  expect(store.made.retracted).toBeGreaterThan(10);
  expect(store.made.replaced).toBeGreaterThan(10);
  expect(store.made.carried).toBeGreaterThan(10);
  expect(store.made.otherCycle).toBeGreaterThan(10);
  expect(store.made.carriedSuperseding).toBeGreaterThan(10);
  expect(store.made.carriedReplaced).toBeGreaterThan(2);
  expect(store.made.carriedRetractedByPerson).toBeGreaterThan(0);
  const actors = new Set(result.all.map((d) => d.actorId));
  expect(store.humans.some((id) => actors.has(id))).toBe(true);
  expect(store.agents.some((id) => actors.has(id))).toBe(true);
  expect(result.rows).toBeGreaterThan(400);
  expect(result.differing).toEqual([]);
  expect(result.filters).toBe(3 + 3 + 90 * 4);
  // The unit filters lead with the dispositions' index; no filter scans the projection.
  for (const plan of [result.plans.unit, result.plans.both])
    expect(
      plan.some((detail) =>
        detail.includes(
          "SEARCH projection_dispositions USING INDEX projection_dispositions_key",
        ),
      ),
    ).toBe(true);
  for (const plan of Object.values(result.plans))
    expect(plan).not.toContain("SCAN projection_dispositions");
  // The live rule reads a carried copy's supersession through the log's unit index, never through
  // the actor's or the kind's events, and its supersession links by their key.
  for (const plan of Object.values(result.plans)) {
    expect(plan).toContain("SEARCH u USING PRIMARY KEY (unit_id=?)");
    expect(plan).toContain("SEARCH s USING PRIMARY KEY (target_id=?)");
    expect(plan.some((detail) => detail.includes("events_actor"))).toBe(false);
  }
});

test("judge and ReviewList.decided answer what the statements they replaced answer", async () => {
  await loaded;
  // 480 unknown units first, so the store's units straddle decided's 500-unit page boundary.
  const asked = [
    ...Array.from({ length: 480 }, () => ({
      unitId: mintUlid(),
      cycleId: mintUlid(),
    })),
    ...store.units,
  ];
  const result = await runOn(
    location,
    Effect.gen(function* () {
      const differing: Array<string> = [];
      let closed = 0;
      for (const unit of store.units) {
        const now = yield* Dispositions.judge(unit.unitId);
        const before = yield* judgeReference(unit.unitId);
        if (now.closed) closed++;
        if (JSON.stringify(now) !== JSON.stringify(before))
          differing.push(unit.unitId);
      }
      return {
        differing,
        closed,
        decided: yield* ReviewList.decided(asked),
        decidedBefore: yield* decidedReference(asked),
        plan: yield* planOfStatement(
          yield* ReviewList.decidedQuery(store.units.map((u) => u.unitId)),
        ),
      };
    }),
  );
  expect(result.differing).toEqual([]);
  expect(result.closed).toBeGreaterThan(10);
  expect(result.closed).toBeLessThan(store.units.length);
  expect(result.decided).toEqual(result.decidedBefore);
  // Units on both pages, people's decisions of both verdicts.
  expect(result.decided.length).toBeGreaterThan(20);
  expect(new Set(result.decided.map((d) => d.verdict)).size).toBe(2);
  // Rows by unit through the dispositions' index and the log's unit index, never every row.
  expect(
    result.plan.some((detail) =>
      detail.includes(
        "SEARCH projection_dispositions USING INDEX projection_dispositions_key",
      ),
    ),
  ).toBe(true);
  expect(result.plan).not.toContain("SCAN projection_dispositions");
  expect(result.plan).toContain("SEARCH u USING PRIMARY KEY (unit_id=?)");
  expect(result.plan.some((detail) => detail.includes("events_actor"))).toBe(
    false,
  );
});

test("currentMany answers what current answers for each unit, across a page", async () => {
  await loaded;
  const units = store.units.map((unit) => unit.unitId);
  // 480 unknown IDs first, so the store's units straddle the 500-ID page boundary; one asked twice.
  const asked = [
    ...Array.from({ length: 480 }, () => mintUlid()),
    ...units,
    units[0]!,
    ...Array.from({ length: 40 }, () => mintUlid()),
  ];
  const result = await runOn(
    location,
    Effect.gen(function* () {
      const many = yield* Dispositions.currentMany(asked);
      const each = new Map<string, unknown>();
      for (const unitId of new Set(asked))
        each.set(unitId, yield* Dispositions.current({ unitId }));
      return { many, each };
    }),
  );
  expect([...result.many.keys()]).toEqual([...new Set(asked)]);
  expect<unknown>(Object.fromEntries(result.many)).toEqual(
    Object.fromEntries(result.each),
  );
  // Both pages hold decided units, and some units hold none.
  const decided = units.filter(
    (unitId) => (result.many.get(unitId)?.length ?? 0) > 0,
  );
  expect(decided.length).toBeGreaterThan(60);
  expect(units.indexOf(decided.at(-1)!) + 480).toBeGreaterThanOrEqual(500);
  expect(units.indexOf(decided[0]!) + 480).toBeLessThan(500);
  expect(decided.length).toBeLessThan(units.length);
});

test("successorsMany answers what successors answers for each unit, across a page", async () => {
  await loaded;
  const units = store.units.map((unit) => unit.unitId);
  const asked = [
    ...Array.from({ length: 480 }, () => mintUlid()),
    ...units,
    units[0]!,
    ...Array.from({ length: 40 }, () => mintUlid()),
  ];
  const result = await runOn(
    location,
    Effect.gen(function* () {
      const many = yield* Lineage.successorsMany(asked);
      const each = new Map<string, unknown>();
      for (const unitId of new Set(asked))
        each.set(unitId, yield* Lineage.successors(unitId));
      return { many, each };
    }),
  );
  expect([...result.many.keys()]).toEqual([...new Set(asked)]);
  expect<unknown>(Object.fromEntries(result.many)).toEqual(
    Object.fromEntries(result.each),
  );
  const linked = units.filter(
    (unitId) => (result.many.get(unitId)?.length ?? 0) > 0,
  );
  // Earlier units in the first and second cycles have successors; the last cycle's have none.
  expect(linked.length).toBeGreaterThan(10);
  expect(units.indexOf(linked.at(-1)!) + 480).toBeGreaterThanOrEqual(500);
  expect(units.indexOf(linked[0]!) + 480).toBeLessThan(500);
  expect(
    store.cycles[2]!.unitIds.every(
      (unitId) => result.many.get(unitId)?.length === 0,
    ),
  ).toBe(true);
  // Some earlier unit has more than one successor, newest lineage event first.
  expect(
    [...result.many.values()].some((successors) => successors.length > 1),
  ).toBe(true);
});

// Why: the desk reads a review's units through `currentMany` and judges them itself, so an agent's
// approval its author retracted must leave no standing row there, and the unit must read as open
// again, as `judge` reads it.
test("an agent's retracted approval leaves currentMany no row, and the unit reopens", async () => {
  const fresh = freshLocation();
  const agent = sha256Hex("neuve-actor/1\u0000agent\u0000retracting");
  const cycleId = mintUlid();
  const batchId = mintUlid();
  const unitId = mintUlid();
  const event = (
    kind: string,
    attribution: unknown,
    payload: unknown,
    causation?: unknown,
  ) => ({
    id: mintUlid(),
    kind,
    idempotencyKey: mintUlid(),
    actor: agent,
    occurredAt: at,
    ...(attribution === undefined ? {} : { attribution }),
    ...(causation === undefined ? {} : { causation }),
    payload,
  });
  const on = { cycleId, unitIds: [unitId] };
  const approval = event("disposition.recorded@2", on, {
    verdict: "approve",
    reviewedHeadOid: headOid,
    restsOn: [],
    proof: [],
  });
  const result = await runOn(
    fresh,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      // As the desk would: each row with its actor's kind, against the unit's lane and cycle.
      const judged = (rows: ReadonlyArray<DispositionView>) =>
        Effect.gen(function* () {
          const [unit] = yield* sql<{
            assessmentEventId: string | null;
          }>`SELECT assessment_event_id FROM projection_units WHERE unit_id = ${unitId}`;
          const assessmentEventId = unit?.assessmentEventId ?? null;
          const withKinds: Array<Dispositions.JudgedDisposition> = [];
          for (const row of rows.filter((d) => d.cycleId === cycleId)) {
            const [actor] = yield* sql<{
              actorKind: string;
            }>`SELECT actor_kind FROM projection_actors WHERE actor_id = ${row.actorId}`;
            withKinds.push({
              ...row,
              actorKind:
                actor?.actorKind === "agent" ? "agent" : "unregistered",
              beforeAssessment:
                assessmentEventId === null || row.eventId < assessmentEventId,
            });
          }
          return Dispositions.judgeDispositions(
            { unitId, cycleId, lane: "agentic", assessmentEventId },
            withKinds,
          );
        });
      yield* Log.append([
        event("actor.registered@1", undefined, {
          actorKind: "agent",
          harness: "test",
          sessionId: "retracting",
        }),
        event("cycle.opened@1", { cycleId, range }, {}),
        event(
          "batch.recorded@1",
          { cycleId, batchId },
          { title: "Batch", focus: "Focus" },
        ),
        event(
          "unit.recorded@1",
          { cycleId, batchId, unitIds: [unitId] },
          {
            title: "Unit",
            ownedRanges: [{ path: "src/a.ts", startLine: 1, endLine: 9 }],
          },
        ),
        event("assessment.recorded@1", on, {
          lane: "agentic",
          complexity: "low",
          easeOfValidation: "easy",
          rationale: "Read",
        }),
        approval,
      ]);
      const approved = (yield* Dispositions.currentMany([unitId])).get(unitId)!;
      const approvedJudgement = yield* judged(approved);
      const approvedJudge = yield* Dispositions.judge(unitId);
      yield* Log.append([
        event(
          "disposition.retracted@1",
          on,
          { reason: "Withdrawn" },
          { supersedes: approval.id },
        ),
      ]);
      const retracted = (yield* Dispositions.currentMany([unitId])).get(
        unitId,
      )!;
      return {
        approved,
        approvedJudgement,
        approvedJudge,
        retracted,
        retractedJudgement: yield* judged(retracted),
        retractedJudge: yield* Dispositions.judge(unitId),
        current: yield* Dispositions.current({ unitId }),
      };
    }),
  );
  expect(result.approved.map((d) => [d.eventId, d.actorId, d.verdict])).toEqual(
    [[approval.id, agent, "approve"]],
  );
  expect(result.approvedJudgement.closed).toBe(true);
  expect(result.approvedJudgement.standing?.actorKind).toBe("agent");
  expect(result.approvedJudgement).toEqual(result.approvedJudge);
  expect(result.retracted).toEqual([]);
  expect(result.current).toEqual([]);
  expect(result.retractedJudgement.closed).toBe(false);
  expect(result.retractedJudgement.standing).toBeNull();
  expect(result.retractedJudgement).toEqual(result.retractedJudge);
});
