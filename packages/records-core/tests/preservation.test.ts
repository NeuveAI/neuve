// Updates must retain the fields an older reader dropped, including nested and variant data.
import { afterAll, describe, expect, test } from "bun:test";
import { z } from "zod";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { deserialize, serialize } from "node:v8";
import { preserveUnknown, safeRead } from "@neuve/records-schema";
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { Registry, Sessions, JobQueue } from "../src/index.ts";
import {
  freshLocation,
  runOn,
  runFs,
  removeTemporaryDirectories,
} from "./support.ts";
afterAll(removeTemporaryDirectories);

for (const required of [true, false]) {
  test(`V8 aliases keep a ${required ? "required" : "optional"} known field when only the Map value rejects it`, () => {
    const older = z.strictObject({ used: z.number() });
    const schema = z.strictObject({
      postings: z.map(z.string(), older),
      aware: z.strictObject({
        used: z.number(),
        future: required ? z.boolean() : z.boolean().optional(),
      }),
    });
    const shared = { used: 1, future: true };
    const stored = deserialize(
      serialize({
        postings: new Map([["entry", shared]]),
        aware: shared,
      }),
    );
    expect(stored.postings.get("entry")).toBe(stored.aware);
    for (const input of [
      stored,
      {
        postings: new Map([["entry", { ...shared }]]),
        aware: { ...shared },
      },
    ]) {
      const read = safeRead(schema, input, { notice: false });
      expect(read.success).toBe(true);
      if (!read.success) throw read.error;
      expect(read.data).toEqual({
        postings: new Map([["entry", { used: 1 }]]),
        aware: { used: 1, future: true },
      });
      expect(read.droppedPaths).toEqual([["postings", "entry", "future"]]);
      expect(
        preserveUnknown(schema, input, {
          postings: new Map([["entry", { used: 2 }]]),
          aware: { used: 3, future: false },
        }),
      ).toEqual({
        postings: new Map([["entry", { used: 2, future: true }]]),
        aware: { used: 3, future: false },
      });
    }
    expect(stored.aware).toEqual(shared);
    expect(stored.postings.get("entry")).toBe(stored.aware);
  });
}

test("omitted Set and object-keyed Map steps stay inside their reported container, including union paths", () => {
  const shared = { used: 1, future: true };
  const older = z.strictObject({ used: z.number() });
  const aware = z.strictObject({ used: z.number(), future: z.boolean() });
  const key = { id: 1 };
  const schema = z.strictObject({
    nested: z.union([
      z.strictObject({
        kind: z.literal("a"),
        entries: z.set(z.strictObject({ child: older })),
      }),
      z.strictObject({ kind: z.literal("b") }),
    ]),
    map: z.map(
      z.strictObject({ id: z.number() }),
      z.strictObject({ child: older }),
    ),
    aware,
  });
  const stored = {
    nested: { kind: "a", entries: new Set([{ child: shared }]) },
    map: new Map([[key, { child: shared }]]),
    aware: shared,
  };
  const read = safeRead(schema, stored, { notice: false });
  expect(read.success).toBe(true);
  if (!read.success) throw read.error;
  expect(read.droppedPaths).toEqual([
    ["nested", "entries", 0, "child", "future"],
    ["map", key, "child", "future"],
  ]);
  expect(read.data).toEqual({
    nested: { kind: "a", entries: new Set([{ child: { used: 1 } }]) },
    map: new Map([[key, { child: { used: 1 } }]]),
    aware: shared,
  });
  expect(stored.aware.future).toBe(true);
  // V8 keeps the shared child; both occurrences must still be repaired independently.
  const aliased = deserialize(
    serialize(new Set([{ child: shared }, { child: shared }])),
  );
  const setSchema = z.set(z.strictObject({ child: older }));
  const setRead = safeRead(setSchema, aliased, { notice: false });
  expect(setRead.success).toBe(true);
  if (!setRead.success) throw setRead.error;
  expect([...setRead.data]).toEqual([
    { child: { used: 1 } },
    { child: { used: 1 } },
  ]);
  expect(() => preserveUnknown(setSchema, aliased, setRead.data)).toThrow(
    "cannot preserve newer fields",
  );
  const cyclic = new Set<unknown>();
  cyclic.add(cyclic);
  const cycleRead = safeRead(
    z.set(z.union([z.set(z.unknown()), older])),
    new Set<unknown>([cyclic, shared]),
    { notice: false },
  );
  expect(cycleRead.success).toBe(true);
  if (!cycleRead.success) throw cycleRead.error;
  expect(cycleRead.droppedPaths).toEqual([[1, "future"]]);
});

test("NaN Map drop paths use Map equality for reading, redaction and preservation", () => {
  const schema = z.map(z.nan(), z.strictObject({ used: z.number() }));
  const stored = new Map([[NaN, { used: 1, future: true }]]);
  const read = safeRead(schema, stored, { notice: false });
  expect(read.success).toBe(true);
  if (!read.success) throw read.error;
  expect(read.data).toEqual(new Map([[NaN, { used: 1 }]]));
  expect(read.droppedKeys).toEqual(["[entry].future"]);
  expect(read.droppedPaths).toEqual([[NaN, "future"]]);
  expect(
    preserveUnknown(schema, stored, new Map([[NaN, { used: 2 }]])),
  ).toEqual(new Map([[NaN, { used: 2, future: true }]]));
  expect(stored.get(NaN)).toEqual({ used: 1, future: true });
});

const schema = z.strictObject({
  reading: z.strictObject({ used: z.number() }),
  items: z.array(z.strictObject({ id: z.string(), used: z.number() })),
  variant: z.union([
    z.strictObject({ kind: z.literal("a"), value: z.number() }),
    z.strictObject({ kind: z.literal("b"), text: z.string() }),
  ]),
});
const stored = {
  reading: { used: 0, futureNested: { untouched: [1, 2] } },
  items: [
    { id: "first", used: 1, future: "one" },
    { id: "second", used: 2, future: "two" },
  ],
  variant: { kind: "a", value: 1, futureBranch: true },
  futureRoot: { keep: "newer data" },
};
const next = {
  reading: { used: 1 },
  items: [
    { id: "second", used: 3 },
    { id: "first", used: 1 },
  ],
  variant: { kind: "a", value: 2 },
};

test("the preservation helper keeps nested objects, keyed array entries and the selected union branch without mutating input", () => {
  expect(
    preserveUnknown(schema, stored, next, { arrayKeys: { items: ["id"] } }),
  ).toEqual({
    reading: { used: 1, futureNested: { untouched: [1, 2] } },
    items: [
      { id: "second", used: 3, future: "two" },
      { id: "first", used: 1, future: "one" },
    ],
    variant: { kind: "a", value: 2, futureBranch: true },
    futureRoot: { keep: "newer data" },
  });
  expect(stored.reading.used).toBe(0);
  expect(stored.items[0]?.id).toBe("first");
  expect(next.reading).toEqual({ used: 1 });
});

test("arrays without stable keys move only unchanged known entries and leave ambiguous changes to the newer build", () => {
  expect(
    preserveUnknown(schema, stored, {
      ...next,
      items: [
        { id: "second", used: 2 },
        { id: "first", used: 1 },
      ],
    }),
  ).toMatchObject({
    items: [
      { id: "second", used: 2, future: "two" },
      { id: "first", used: 1, future: "one" },
    ],
  });
  expect(() => preserveUnknown(schema, stored, next)).toThrow(
    "cannot preserve newer fields",
  );
  expect(() =>
    preserveUnknown(
      schema,
      stored,
      { ...next, items: [] },
      { arrayKeys: { items: ["id"] } },
    ),
  ).toThrow("cannot preserve newer fields");
});

test("a union transition cannot replace an unknown parent or give a dropped key new meaning", () => {
  const union = z.union([
    z.strictObject({
      kind: z.literal("a"),
      child: z.strictObject({ used: z.number() }),
    }),
    z.strictObject({
      kind: z.literal("b"),
      child: z.string(),
      future: z.number(),
    }),
  ]);
  expect(() =>
    preserveUnknown(
      union,
      { kind: "a", child: { used: 0, future: true } },
      { kind: "b", child: "replacement", future: 1 },
    ),
  ).toThrow("cannot preserve newer fields");
  expect(() =>
    preserveUnknown(
      union,
      { kind: "a", child: { used: 0 }, future: 2 },
      { kind: "b", child: "replacement", future: 1 },
    ),
  ).toThrow("cannot preserve newer fields");
  expect(() =>
    preserveUnknown(schema, stored, { ...next, extraInput: true }),
  ).toThrow();
});

// A newer worker may attach metadata to a previous attempt's error before this worker retries.
test("a queue attempt keeps newer last-error fields when it records a new failure", async () => {
  const result = await runOn(
    freshLocation(),
    Effect.gen(function* () {
      const queue = yield* JobQueue.JobQueue;
      const sql = yield* SqlClient;
      const job = yield* queue.enqueue({
        kind: "worker.probe",
        dedupeKey: "preserve-error",
        payload: { failAttempts: 9 },
      });
      const active = yield* queue.take(["worker.probe"]);
      if (active._tag !== "Some") throw new Error("job not taken");
      yield* sql`UPDATE jobs SET last_error=${JSON.stringify({ tag: "ProbeFailed", message: "old", attempt: 1, at: "2026-11-01T00:00:00.000Z", future: true })} WHERE job_seq=${job.job.seq}`;
      yield* queue.fail(job.job.seq, active.value.attempts, {
        tag: "ProbeFailed",
        message: "new",
        final: true,
      });
      const [stored] = yield* sql<{
        lastError: string;
      }>`SELECT last_error FROM jobs WHERE job_seq=${job.job.seq}`;
      if (stored === undefined) throw new Error("job absent");
      return JSON.parse(stored.lastError) as unknown;
    }).pipe(Effect.provide(JobQueue.layer)),
  );
  expect(result).toMatchObject({ message: "new", future: true });
});

test("session updates keep newer fields and session cleanup leaves them to the newer build", async () => {
  const location = freshLocation();
  const state = {
    version: 1 as const,
    harness: "test",
    sessionId: "one",
    actorId: "a".repeat(64),
    turnKey: "old",
  };
  await runFs(Sessions.writeSession(location, state));
  const { readdirSync } = await import("node:fs");
  const directory = join(
    Sessions.sessionsDirectory(location),
    readdirSync(Sessions.sessionsDirectory(location))[0]!,
  );
  const path = join(directory, "session.json");
  writeFileSync(path, JSON.stringify({ ...state, future: true }));
  await runFs(Sessions.writeSession(location, { ...state, turnKey: "new" }));
  expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
    turnKey: "new",
    future: true,
  });
  await runFs(Sessions.removeSession(location, "test", "one"));
  expect(existsSync(path)).toBe(true);
});

test("registry updates keep newer root and repository fields while adding a repository", async () => {
  const location = freshLocation();
  const path = join(location.directory, "repositories.json");
  mkdirSync(location.directory, { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      future: true,
      repositories: [
        { store: "older-store", repository: "older-repo", future: true },
      ],
    }),
  );
  expect(
    await runFs(Registry.registerRepository(location, "current-repo", path)),
  ).toBe(true);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    version: 1,
    future: true,
    repositories: [
      { store: "older-store", repository: "older-repo", future: true },
      { store: location.directory, repository: "current-repo" },
    ],
  });
});

// A job's payload belongs to its newer writer, including fields nested in its range.
test("failed preparation revival keeps futureRoot and range.futureNested, and refuses a destructive branch change before writing", async () => {
  const result = await runOn(
    freshLocation(),
    Effect.gen(function* () {
      const queue = yield* JobQueue.JobQueue;
      const sql = yield* SqlClient;
      const payload = {
        kind: "range",
        range: { baseOid: "a".repeat(40), headOid: "b".repeat(40) },
      };
      const first = yield* queue.enqueue({
        kind: "commit.prepare@2",
        dedupeKey: "revive",
        payload,
      });
      const taken = yield* queue.take(["commit.prepare@2"]);
      if (taken._tag !== "Some") throw new Error("job not taken");
      yield* queue.fail(first.job.seq, taken.value.attempts, {
        tag: "Fixture",
        message: "failed",
        final: true,
      });
      const newer = {
        ...payload,
        futureRoot: { keep: true },
        range: { ...payload.range, futureNested: true },
      };
      yield* sql`UPDATE jobs SET payload=${JSON.stringify(newer)} WHERE job_seq=${first.job.seq}`;
      const snapshot =
        yield* sql`SELECT * FROM jobs WHERE job_seq=${first.job.seq}`;
      const refused = yield* Effect.result(
        queue.enqueue({
          kind: "commit.prepare@2",
          dedupeKey: "revive",
          payload: {
            kind: "commit",
            commit: { oid: "a".repeat(40), tree: "b".repeat(40), parents: [] },
          },
        }),
      );
      const unchanged =
        yield* sql`SELECT * FROM jobs WHERE job_seq=${first.job.seq}`;
      const revived = yield* queue.enqueue({
        kind: "commit.prepare@2",
        dedupeKey: "revive",
        payload,
      });
      const [stored] = yield* sql<{
        payload: string;
      }>`SELECT payload FROM jobs WHERE job_seq=${first.job.seq}`;
      return {
        snapshot,
        unchanged,
        refused: refused._tag,
        status: revived.status,
        payload: JSON.parse(stored!.payload),
        newer,
      };
    }).pipe(Effect.provide(JobQueue.layer)),
  );
  expect(result.refused).toBe("Failure");
  expect(result.unchanged).toEqual(result.snapshot);
  expect(result.status).toBe("enqueued");
  expect(result.payload).toEqual(result.newer);
});

test("taking known jobs leaves a newer kind's due delayed job unchanged because unknown work is its writer's", async () => {
  const result = await runOn(
    freshLocation(),
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const queue = yield* JobQueue.JobQueue;
      yield* sql`INSERT INTO jobs(kind,dedupe_key,state,run_at) VALUES('review.run@99','newer-delayed','delayed','2000-01-01T00:00:00.000Z')`;
      const before =
        yield* sql`SELECT * FROM jobs WHERE dedupe_key='newer-delayed'`;
      yield* queue.enqueue({
        kind: "worker.probe",
        dedupeKey: "known",
        payload: {},
      });
      yield* queue.take(["worker.probe"]);
      yield* queue.recoverStalled;
      return {
        before,
        after: yield* sql`SELECT * FROM jobs WHERE dedupe_key='newer-delayed'`,
      };
    }).pipe(Effect.provide(JobQueue.layer)),
  );
  expect(result.after).toEqual(result.before);
});

test("spool ingestion leaves unknown event kinds and spool versions in place for their newer ingester", async () => {
  const { Ingest, mintUlid } = await import("../src/index.ts");
  const location = freshLocation();
  mkdirSync(location.spool, { recursive: true });
  const files = [
    { spool: 1, event: { id: mintUlid(), kind: "review.newer@99" } },
    { spool: 2, event: { id: mintUlid(), kind: "cycle.opened@1" } },
  ];
  const stored = files.map((value) => ({
    value,
    text: JSON.stringify(value) + "\n",
  }));
  stored.forEach(({ value, text }) =>
    writeFileSync(join(location.spool, `${value.event.id}.json`), text),
  );
  const result = await runOn(location, Ingest.ingestSpool(location));
  expect(result.appended).toBe(0);
  expect(result.rejected).toEqual([]);
  stored.forEach(({ value, text }) =>
    expect(
      readFileSync(join(location.spool, `${value.event.id}.json`), "utf8"),
    ).toBe(text),
  );
});

// Container identity must survive both the compatibility read and the later whole-value update.
test("Map values preserve newer fields while known values change, and removing their key refuses the update", async () => {
  const { safeRead } = await import("@neuve/records-schema");
  const schema = z.strictObject({
    values: z.map(z.string(), z.strictObject({ used: z.number() })),
  });
  const stored = {
    values: new Map([["one", { used: 1, future: { keep: true } }]]),
  };
  const next = { values: new Map([["one", { used: 2 }]]) };
  const merged = preserveUnknown(schema, stored, next);
  expect(merged).toEqual({
    values: new Map([["one", { used: 2, future: { keep: true } }]]),
  });
  expect(safeRead(schema, merged).success).toBe(true);
  expect(() => preserveUnknown(schema, stored, { values: new Map() })).toThrow(
    "cannot preserve newer fields",
  );
  expect(stored.values.get("one")?.used).toBe(1);
  expect(next.values.get("one")).toEqual({ used: 2 });
});

test("Set issue provenance drops only the affected union element and preservation refuses without stable identity", async () => {
  const { safeRead } = await import("@neuve/records-schema");
  const schema = z.set(
    z.union([
      z.strictObject({ kind: z.literal("a"), used: z.number() }),
      z.strictObject({ kind: z.literal("b"), future: z.boolean() }),
    ]),
  );
  const stored = new Set([
    { kind: "a", used: 1, future: true },
    { kind: "b", future: false },
  ]);
  const read = safeRead(schema, stored);
  expect(read.success).toBe(true);
  if (!read.success) throw read.error;
  expect(read.data).toEqual(
    new Set([
      { kind: "a", used: 1 },
      { kind: "b", future: false },
    ]),
  );
  expect(read.droppedPaths).toEqual([[0, "future"]]);
  expect(() => preserveUnknown(schema, stored, read.data)).toThrow(
    "cannot preserve newer fields",
  );
  expect([...stored][0]).toEqual({ kind: "a", used: 1, future: true });
  expect(
    safeRead(schema, new Set([{ kind: "a", used: "bad", future: true }]))
      .success,
  ).toBe(false);
});

test("non-property Map keys locate rejected values without flattening containers and refuse ambiguous preservation", async () => {
  const { safeRead } = await import("@neuve/records-schema");
  const schema = z.map(
    z.strictObject({ id: z.number() }),
    z.strictObject({ used: z.number() }),
  );
  const stored = new Map([[{ id: 1 }, { used: 1, future: true }]]);
  const read = safeRead(schema, stored);
  expect(read.success).toBe(true);
  if (!read.success) throw read.error;
  expect(read.data).toEqual(new Map([[{ id: 1 }, { used: 1 }]]));
  expect(() => preserveUnknown(schema, stored, read.data)).toThrow(
    "cannot preserve newer fields",
  );
});

// Cycles are accepted by pinned Zod. Additive retries must close back-edges per occurrence.
test("a lazy cycle and its schema-aware sibling keep known fields and preserve additions", () => {
  const node: z.ZodType<{ used: number; self?: unknown }> = z.lazy(() =>
    z.strictObject({ used: z.number(), self: node.optional() }),
  );
  const schema = z.strictObject({
    cycle: node,
    aware: z.strictObject({
      used: z.number(),
      future: z.boolean(),
      self: z.unknown(),
    }),
    json: z.json(),
  });
  const shared: { used: number; future: boolean; self?: unknown } = {
    used: 1,
    future: true,
  };
  shared.self = shared;
  const stored = deserialize(
    serialize({ cycle: shared, aware: shared, json: shared }),
  );
  const read = safeRead(schema, stored, { notice: false });
  expect(read.success).toBe(true);
  if (!read.success) throw read.error;
  expect(read.data.cycle.used).toBe(1);
  expect(read.data.cycle.self).toBe(read.data.cycle);
  expect(read.data.aware.future).toBe(true);
  expect(read.data.aware.self).toBe(stored.aware);
  const merged = preserveUnknown(schema, stored, read.data);
  expect(merged).toMatchObject({
    cycle: { used: 1, future: true },
    aware: { future: true },
  });
  const parsed = z
    .object({ cycle: z.object({ self: z.unknown(), future: z.boolean() }) })
    .parse(merged);
  expect(parsed.cycle.self).toBe(
    z.object({ cycle: z.unknown() }).parse(merged).cycle,
  );
  expect(stored.cycle.future).toBe(true);
});

test("union candidates retain only one branch's drops and parent refinements see repaired input", () => {
  const a = z.strictObject({ a: z.number(), b: z.number().optional() });
  const b = z.strictObject({ b: z.number() });
  const union = z.union([a, b]);
  const schema = z
    .strictObject({ variant: union })
    .superRefine((value, ctx) => {
      if ("a" in value.variant)
        ctx.addIssue({ code: "custom", message: "use b" });
    });
  const read = safeRead(
    schema,
    { variant: { a: 1, b: 2, future: true } },
    { notice: false },
  );
  expect(read.success && read.data).toEqual({ variant: { b: 2 } });
  expect(read.success && read.droppedPaths).toEqual([
    ["variant", "a"],
    ["variant", "future"],
  ]);
  const discriminated = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("a"), a: z.number() }),
    z.strictObject({ kind: z.literal("b"), b: z.number() }),
  ]);
  expect(
    safeRead(
      discriminated,
      { kind: "b", b: 2, future: true },
      { notice: false },
    ),
  ).toMatchObject({
    success: true,
    data: { kind: "b", b: 2 },
    droppedKeys: ["future"],
  });
  const mixed = z.union([
    z.strictObject({ a: z.number(), required: z.number() }),
    b,
  ]);
  expect(
    safeRead(mixed, { a: 1, future: true }, { notice: false }).success,
  ).toBe(false);
  for (const pass of [true, false]) {
    const refined = z
      .strictObject({ child: z.strictObject({ used: z.number() }) })
      .refine((value) => value.child.used === (pass ? 1 : 2));
    expect(
      safeRead(refined, { child: { used: 1, future: true } }, { notice: false })
        .success,
    ).toBe(pass);
  }
});

test("identity pipes repair additions and transforming pipes refuse additive retry", () => {
  const strict = z.strictObject({ used: z.number() });
  const identity = z.unknown().pipe(strict);
  const preserving = z
    .looseObject({ used: z.number() })
    .transform((value) => ({ ...value, used: value.used + 1 }))
    .pipe(strict);
  expect(
    safeRead(identity, { used: 1, future: true }, { notice: false }),
  ).toMatchObject({ success: true, data: { used: 1 } });
  expect(
    safeRead(preserving, { used: 1, future: true }, { notice: false }),
  ).toMatchObject({
    success: false,
    refusals: [{ kind: "transforming-pipe", path: "$" }],
  });
  const generated = strict
    .transform((value): { used: number; generated?: boolean } => ({
      ...value,
      generated: true,
    }))
    .pipe(strict);
  expect(
    safeRead(generated, { used: 1, future: true }, { notice: false }).success,
  ).toBe(false);
  const finite = z.record(z.enum(["required"]), strict);
  expect(
    safeRead(finite, { private: { used: 1, future: true } }, { notice: false })
      .success,
  ).toBe(false);
});

test("a wide additive array reads without a sibling-recursion stack limit", () => {
  const schema = z.array(z.strictObject({ used: z.number() }));
  const input = Array.from({ length: 10_000 }, (_, used) => ({
    used,
    future: true,
  }));
  const read = safeRead(schema, input, { notice: false });
  expect(read.success && read.data).toEqual(
    input.map(({ used }) => ({ used })),
  );
});

// A failing alternative cannot lend its drops to a branch whose known-field refinement failed.
test("a union cannot repair a known-field refinement with drops from an invalid alternative", () => {
  const schema = z.union([
    z
      .strictObject({ used: z.number(), known: z.boolean().optional() })
      .refine((value) => value.known === undefined),
    z.strictObject({ used: z.number(), required: z.number() }),
  ]);
  expect(
    safeRead(schema, { used: 1, known: true, future: true }, { notice: false })
      .success,
  ).toBe(false);
});

// Intersections reconcile root key ownership; neither operand may erase the other's fields.
test("intersection reads keep required and optional fields owned by either operand and reject corruption", () => {
  const left = z.strictObject({ a: z.number() });
  const right = z.strictObject({ b: z.number() });
  const schema = z.intersection(left, right);
  expect(schema.parse({ a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
  const read = safeRead(
    schema,
    { a: 1, b: 2, future: true },
    { notice: false },
  );
  expect(read).toMatchObject({
    success: true,
    data: { a: 1, b: 2 },
    droppedKeys: ["future"],
  });
  for (const flipped of [false, true]) {
    const optional = z.strictObject({
      a: z.number(),
      b: z.number().optional(),
    });
    const schema = flipped
      ? z.intersection(left, optional)
      : z.intersection(optional, left);
    expect(
      safeRead(schema, { a: 1, b: 2, future: true }, { notice: false }),
    ).toMatchObject({ success: true, data: { a: 1, b: 2 } });
    expect(
      safeRead(schema, { a: 1, b: "wrong", future: true }, { notice: false })
        .success,
    ).toBe(false);
    expect(
      preserveUnknown(schema, { a: 1, b: 2, future: true }, { a: 3, b: 4 }),
    ).toEqual({ a: 3, b: 4, future: true });
  }
  const nested = z.intersection(schema, z.strictObject({ c: z.number() }));
  expect(
    safeRead(nested, { a: 1, b: 2, c: 3, future: true }, { notice: false }),
  ).toMatchObject({ success: true, data: { a: 1, b: 2, c: 3 } });
});

test("intersection loose and catchall operands retain accepted entries during a descendant repair", () => {
  const keyed = z.intersection(
    z.strictObject({ a: z.number() }),
    z.record(z.string().regex(/^b$/), z.number()),
  );
  expect(keyed.parse({ a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
  expect(
    safeRead(keyed, { a: 1, b: 2, future: true }, { notice: false }),
  ).toMatchObject({ success: true, data: { a: 1, b: 2 } });
  expect(
    safeRead(keyed, { a: 1, b: "wrong", future: true }, { notice: false })
      .success,
  ).toBe(false);
  const leaf = z.strictObject({ used: z.number() });
  for (const side of [
    z.looseObject({ child: leaf }),
    z.object({ child: leaf }).catchall(z.unknown()),
  ]) {
    const schema = z.intersection(z.strictObject({ child: leaf }), side);
    const input = { child: { used: 1, future: true }, keep: "payload" };
    expect(safeRead(schema, input, { notice: false })).toMatchObject({
      success: true,
      data: { child: { used: 1 }, keep: "payload" },
      droppedKeys: ["child.future"],
    });
    expect(input.child.future).toBe(true);
    expect(
      safeRead(
        schema,
        { ...input, child: { used: "wrong", future: true } },
        { notice: false },
      ).success,
    ).toBe(false);
  }
  const undecidable = z.intersection(
    z.strictObject({ a: z.number() }),
    z.union([
      z.strictObject({ b: z.number().optional() }),
      z.strictObject({ c: z.number() }),
    ]),
  );
  expect(
    safeRead(undecidable, { a: 1, b: "wrong", future: true }, { notice: false })
      .success,
  ).toBe(false);
  const nestedConflict = z.intersection(
    z.strictObject({ child: z.strictObject({ a: z.number() }) }),
    z.strictObject({
      child: z.strictObject({ a: z.number(), b: z.number().optional() }),
    }),
  );
  expect(
    safeRead(
      nestedConflict,
      { child: { a: 1, b: "wrong", future: true } },
      { notice: false },
    ).success,
  ).toBe(false);
});

test("finite records prune the parser's rejected entries while full and partial records keep their presence rules", () => {
  const leaf = z.strictObject({ used: z.number() });
  const full = z.record(z.enum(["a", "b"]), leaf);
  const partial = z.partialRecord(z.enum(["a", "b"]), leaf);
  expect(
    safeRead(
      partial,
      { a: { used: 1 }, future: { used: 2 } },
      { notice: false },
    ),
  ).toMatchObject({
    success: true,
    data: { a: { used: 1 } },
    droppedKeys: ["[entry]"],
  });
  expect(
    safeRead(full, { a: { used: 1 }, future: { used: 2 } }, { notice: false })
      .success,
  ).toBe(false);
  expect(
    safeRead(
      full,
      { a: { used: 1 }, b: { used: 2 }, future: true },
      { notice: false },
    ),
  ).toMatchObject({ success: true, data: { a: { used: 1 }, b: { used: 2 } } });
  const refined = z.partialRecord(
    z.enum(["a", "b"]).refine((key) => key === "a"),
    leaf,
  );
  expect(
    safeRead(refined, { a: { used: 1 }, b: { used: 2 } }, { notice: false }),
  ).toMatchObject({ success: true, data: { a: { used: 1 } } });
  for (const schema of [full, partial])
    expect(
      safeRead(
        schema,
        { a: { used: "wrong" }, b: { used: 2 }, future: true },
        { notice: false },
      ).success,
    ).toBe(false);
});

test("loose records retain out-of-key values verbatim and preserve valid updates", () => {
  const leaf = z.strictObject({ used: z.number() });
  for (const key of [z.enum(["a"]), z.string().regex(/^a$/)]) {
    const schema = z.looseRecord(key, leaf);
    const stored = {
      a: { used: 1, future: true },
      keep: { used: "accepted", future: true },
    };
    expect(safeRead(schema, stored, { notice: false })).toMatchObject({
      success: true,
      data: { a: { used: 1 }, keep: stored.keep },
      droppedPaths: [["a", "future"]],
    });
    expect(
      preserveUnknown(schema, stored, { a: { used: 2 }, keep: "changed" }),
    ).toEqual({ a: { used: 2, future: true }, keep: "changed" });
  }
  const numeric = z.partialRecord(z.literal([1, 2]), leaf);
  expect(
    safeRead(numeric, { "1": { used: 1, future: true } }, { notice: false }),
  ).toMatchObject({ success: true, data: { "1": { used: 1 } } });
  const constrained = z.record(z.string().regex(/^a$/), leaf);
  expect(
    safeRead(
      constrained,
      { a: { used: 1, future: true }, invalid: { used: 2 } },
      { notice: false },
    ).success,
  ).toBe(false);
});

test("object strict, strip, loose and typed catchall modes keep their own unknown-key semantics", () => {
  const leaf = z.strictObject({ used: z.number() });
  for (const schema of [
    z.object({ child: leaf }),
    z.looseObject({ child: leaf }),
  ]) {
    const read = safeRead(
      schema,
      { child: { used: 1, future: true }, keep: "payload" },
      { notice: false },
    );
    expect(read).toMatchObject({
      success: true,
      droppedPaths: schema.def.catchall
        ? [["child", "future"]]
        : [["child", "future"], ["keep"]],
    });
    if (!read.success) throw read.error;
    expect(read.data).toEqual(
      schema.parse({ child: { used: 1 }, keep: "payload" }),
    );
  }
  const catchall = z.object({ child: leaf }).catchall(leaf);
  expect(
    safeRead(
      catchall,
      { child: { used: 1 }, dynamic: { used: 2, future: true } },
      { notice: false },
    ),
  ).toMatchObject({
    success: true,
    data: { child: { used: 1 }, dynamic: { used: 2 } },
    droppedKeys: ["[entry].future"],
  });
  expect(
    safeRead(
      catchall,
      { child: { used: 1 }, dynamic: { used: "wrong", future: true } },
      { notice: false },
    ).success,
  ).toBe(false);
});

test("a successful parse reports stripped keys at each input location", () => {
  const leaf = z.object({ used: z.number() });
  const schema = z.object({
    child: leaf,
    items: z.array(leaf),
    choice: z.union([z.string(), leaf]),
  });
  const used = { used: 1 };
  const added = { ...used, future: true };
  expect(
    safeRead(
      schema,
      { child: added, items: [added], choice: added, future: true },
      { notice: false },
    ),
  ).toMatchObject({
    success: true,
    droppedKeys: ["child.future", "items.[].future", "choice.future", "future"],
    droppedPaths: [
      ["child", "future"],
      ["items", 0, "future"],
      ["choice", "future"],
      ["future"],
    ],
  });
  expect(
    safeRead(schema, { child: used, items: [used], choice: used }),
  ).toMatchObject({
    success: true,
    droppedKeys: [],
    droppedPaths: [],
  });
});

describe("a pipe reports a key it strips and then restores", () => {
  const pipe = z
    .object({ used: z.number() })
    .transform(({ used }) => ({ used, future: true }));
  const input = { used: 1, future: true };

  const cases = [
    {
      placement: "top level",
      schema: pipe,
      value: input,
      data: { used: 1, future: true },
      droppedKeys: ["future"],
      droppedPaths: [["future"]],
    },
    {
      placement: "object field",
      schema: z.object({ child: pipe }),
      value: { child: input },
      data: { child: { used: 1, future: true } },
      droppedKeys: ["child.future"],
      droppedPaths: [["child", "future"]],
    },
    {
      placement: "array element",
      schema: z.array(pipe),
      value: [input],
      data: [{ used: 1, future: true }],
      droppedKeys: ["[].future"],
      droppedPaths: [[0, "future"]],
    },
    {
      placement: "union option",
      schema: z.union([z.string(), pipe]),
      value: input,
      data: { used: 1, future: true },
      droppedKeys: ["future"],
      droppedPaths: [["future"]],
    },
    {
      placement: "optional",
      schema: pipe.optional(),
      value: input,
      data: { used: 1, future: true },
      droppedKeys: ["future"],
      droppedPaths: [["future"]],
    },
    {
      placement: "lazy",
      schema: z.lazy(() => pipe),
      value: input,
      data: { used: 1, future: true },
      droppedKeys: ["future"],
      droppedPaths: [["future"]],
    },
  ];

  test.each(cases)(
    "$placement",
    ({ schema, value, data, droppedKeys, droppedPaths }) => {
      expect(safeRead<unknown>(schema, value, { notice: false })).toEqual({
        success: true,
        data,
        droppedKeys,
        droppedPaths,
      });
    },
  );
});

test("tuple rest repairs its own elements without changing arity or optional-tail semantics", () => {
  const leaf = z.strictObject({ used: z.number() });
  const schema = z.tuple([z.literal("tag"), leaf.optional()], leaf);
  expect(
    safeRead(
      schema,
      ["tag", { used: 1, future: true }, { used: 2, future: true }],
      { notice: false },
    ),
  ).toMatchObject({ success: true, data: ["tag", { used: 1 }, { used: 2 }] });
  expect(
    safeRead(schema, ["tag", { used: 1, future: true }, { used: "wrong" }], {
      notice: false,
    }).success,
  ).toBe(false);
  const fixed = z.tuple([leaf, z.number().optional()]);
  expect(
    safeRead(fixed, [{ used: 1, future: true }], { notice: false }),
  ).toMatchObject({ success: true, data: [{ used: 1 }] });
  expect(
    safeRead(fixed, [{ used: 1, future: true }, 2, 3], { notice: false })
      .success,
  ).toBe(false);
});

test("enumerable symbol fields and record entries survive unrelated repairs and use redacted paths", () => {
  const key = Symbol("private identifier");
  const leaf = z.strictObject({ used: z.number() });
  const symbolObject = z.strictObject({ child: leaf, [key]: leaf.optional() });
  const objectRead = safeRead(
    symbolObject,
    { child: { used: 1, future: true }, [key]: { used: 2, future: true } },
    { notice: false },
  );
  expect(objectRead).toMatchObject({
    success: true,
    data: { child: { used: 1 }, [key]: { used: 2 } },
    droppedKeys: ["child.future", "[field].future"],
  });
  expect(
    safeRead(
      symbolObject,
      { child: { used: 1, future: true }, [key]: { used: "wrong" } },
      { notice: false },
    ).success,
  ).toBe(false);
  const record = z.record(z.symbol(), leaf);
  expect(
    safeRead(record, { [key]: { used: 2, future: true } }, { notice: false }),
  ).toMatchObject({
    success: true,
    data: { [key]: { used: 2 } },
    droppedKeys: ["[entry].future"],
  });
  expect(
    preserveUnknown(
      record,
      { [key]: { used: 2, future: true } },
      { [key]: { used: 3 } },
    ),
  ).toEqual({ [key]: { used: 3, future: true } });
});

test("full finite loose records bypass values at noncanonical numeric keys", () => {
  const leaf = z.strictObject({ used: z.number() });
  const schema = z.looseRecord(z.literal(1), leaf);
  const stored = {
    "1": { used: 1, future: true },
    "01": { used: "accepted", future: true },
  };
  expect(safeRead(schema, stored, { notice: false })).toMatchObject({
    success: true,
    data: { "1": { used: 1 }, "01": stored["01"] },
    droppedPaths: [["1", "future"]],
  });
  expect(
    preserveUnknown(schema, stored, { "1": { used: 2 }, "01": "changed" }),
  ).toEqual({ "1": { used: 2, future: true }, "01": "changed" });
});

test("declared nonenumerable fields retain object ownership while records ignore nonenumerable entries", () => {
  const leaf = z.strictObject({ used: z.number() });
  const input = Object.defineProperty(
    { child: { used: 1, future: true } },
    "hidden",
    {
      value: { used: 2, future: true },
      enumerable: false,
    },
  );
  const schema = z.strictObject({ child: leaf, hidden: leaf.optional() });
  expect(safeRead(schema, input, { notice: false })).toMatchObject({
    success: true,
    data: { child: { used: 1 }, hidden: { used: 2 } },
    droppedKeys: ["child.future", "hidden.future"],
  });
  const intersection = z.intersection(
    schema,
    z.strictObject({ child: leaf, hidden: leaf.optional() }),
  );
  expect(safeRead(intersection, input, { notice: false })).toMatchObject({
    success: true,
    data: { child: { used: 1 }, hidden: { used: 2 } },
  });
  expect(
    safeRead(z.record(z.string(), leaf), input, { notice: false }),
  ).toMatchObject({
    success: true,
    data: { child: { used: 1 } },
    droppedKeys: ["[entry].future"],
  });
});

// Full finite records read declared keys directly, unlike the own-enumerable partial branch.
test("full finite records repair nonenumerable declared values", () => {
  const schema = z.record(
    z.enum(["a", "b"]),
    z.strictObject({ used: z.number() }),
  );
  const input = Object.defineProperty({ a: { used: 1, future: true } }, "b", {
    value: { used: 2, future: true },
  });
  expect(safeRead(schema, input, { notice: false })).toMatchObject({
    success: true,
    data: { a: { used: 1 }, b: { used: 2 } },
  });
});

test("modifiers retain fallback and absent-value semantics during an unrelated repair", () => {
  const leaf = z.strictObject({ used: z.number() });
  for (const modifier of [
    leaf.optional(),
    leaf.nullable(),
    leaf.default({ used: 7 }),
    leaf.prefault({ used: 8 }),
    leaf.catch({ used: 9 }),
    leaf.readonly(),
    leaf.optional().nonoptional(),
    z.lazy(() => leaf),
  ]) {
    const schema = z.strictObject({ child: modifier });
    const fallback = modifier instanceof z.ZodCatch;
    expect(
      safeRead(
        schema,
        { child: { used: 1, future: true }, futureRoot: true },
        { notice: false },
      ),
    ).toMatchObject({
      success: true,
      data: { child: { used: fallback ? 9 : 1 } },
    });
    expect(
      safeRead(
        schema,
        { child: { used: "wrong", future: true }, futureRoot: true },
        { notice: false },
      ).success,
    ).toBe(fallback);
  }
  const schema = z.strictObject({
    optional: leaf.optional(),
    nullable: leaf.nullable(),
    defaulted: leaf.default({ used: 7 }),
    prefaulted: leaf.prefault({ used: 8 }),
  });
  expect(
    safeRead(schema, { nullable: null, futureRoot: true }, { notice: false }),
  ).toMatchObject({
    success: true,
    data: { nullable: null, defaulted: { used: 7 }, prefaulted: { used: 8 } },
  });
});

// F29: operands that do not constrain a location cannot veto its additive repair.
test("mixed intersection operands repair nested additions at the occurrence they describe", () => {
  const leaf = z.strictObject({ used: z.number() });
  const left = z.strictObject({ child: leaf });
  const base = { child: { used: 1 } };
  const stored = { child: { used: 1, future: true } };
  for (const right of [
    z.object({}),
    z.looseObject({}),
    z.unknown(),
    z.object({}).catchall(z.unknown()),
    z.union([left, z.strictObject({ other: z.number() })]),
    z.unknown().pipe(left),
  ]) {
    for (const schema of [
      z.intersection(left, right),
      z.intersection(right, left),
    ]) {
      expect(schema.safeParse(base).success).toBe(true);
      expect(safeRead(schema, stored, { notice: false })).toMatchObject({
        success: true,
        data: base,
        droppedKeys: ["child.future"],
      });
      expect(preserveUnknown(schema, stored, { child: { used: 2 } })).toEqual({
        child: { used: 2, future: true },
      });
      expect(
        safeRead(
          schema,
          { child: { used: "wrong", future: true } },
          { notice: false },
        ).success,
      ).toBe(false);
    }
  }
  expect(stored).toEqual({ child: { used: 1, future: true } });
});

// Each selected branch owns its keys; another branch cannot lend it a deletion.
test("intersection union and discriminated union candidates keep declared keys and reject corrupt candidates", () => {
  for (const operand of [
    z.union([
      z.strictObject({ a: z.number() }),
      z.strictObject({ b: z.number() }),
    ]),
    z.discriminatedUnion("tag", [
      z.strictObject({ tag: z.literal("a"), a: z.number() }),
      z.strictObject({ tag: z.literal("b"), b: z.number() }),
    ]),
  ]) {
    const schema = z.intersection(operand, z.strictObject({ c: z.number() }));
    for (const key of ["a", "b"]) {
      const base =
        operand instanceof z.ZodDiscriminatedUnion
          ? { tag: key, [key]: 1, c: 2 }
          : { [key]: 1, c: 2 };
      const read = safeRead(
        schema,
        { ...base, future: true },
        { notice: false },
      );
      expect(read).toMatchObject({ success: true, data: { [key]: 1, c: 2 } });
      expect(read.success && read.droppedKeys).toEqual(["future"]);
      expect(read.success && read.droppedKeys).not.toContain(key);
      expect(
        safeRead(
          schema,
          { ...base, [key]: "wrong", future: true },
          { notice: false },
        ).success,
      ).toBe(false);
    }
  }
});

// F30: output declarations and rejections never erase a corrupt known input.
test("pipe input ownership protects known optional fields in strict and loose input modes", () => {
  for (const input of [
    z.strictObject({ used: z.number(), known: z.number().optional() }),
    z.looseObject({ used: z.number(), known: z.number().optional() }),
  ]) {
    const schema = input
      .transform(({ used }) => ({ used }))
      .pipe(z.strictObject({ used: z.number() }));
    const corrupt = { used: 1, known: "wrong", future: true };
    expect(schema.safeParse(corrupt).success).toBe(false);
    expect(safeRead(schema, corrupt, { notice: false }).success).toBe(false);
    expect(() => preserveUnknown(schema, corrupt, { used: 2 })).toThrow();
    const valid = safeRead(
      schema,
      { used: 1, known: 2, future: true },
      { notice: false },
    );
    // A transform that already strips the addition can still succeed strictly.
    if (schema.safeParse({ used: 1, known: 2, future: true }).success) {
      expect(valid).toMatchObject({ success: true, data: { used: 1 } });
      expect(valid.success && valid.droppedKeys).not.toContain("known");
    } else {
      expect(valid).toMatchObject({
        success: false,
        refusals: [{ kind: "transforming-pipe" }],
      });
      expect(() =>
        preserveUnknown(
          schema,
          { used: 1, known: 2, future: true },
          { used: 2 },
        ),
      ).toThrow();
    }
    expect(corrupt).toEqual({ used: 1, known: "wrong", future: true });
  }
});

// Ownership follows modifiers and typed key declarations even when the declared value is invalid.
test("mixed declarations in modifiers, records and catchalls prevent corruption repair", () => {
  const declared = z.strictObject({
    known: z.number().optional(),
    used: z.number(),
  });
  const operands: ReadonlyArray<z.ZodType> = [
    declared.optional(),
    declared.nullable(),
    declared.default({ used: 0 }),
    declared.prefault({ used: 0 }),
    declared.readonly(),
    declared.optional().nonoptional(),
    z.lazy(() => declared),
    z.partialRecord(z.enum(["known", "used"]), z.number()),
    z.record(z.string().regex(/^(known|used)$/), z.number()),
    z.object({ used: z.number() }).catchall(z.number()),
  ];
  for (const operand of operands) {
    for (const schema of [
      z.intersection(operand, z.strictObject({ used: z.number() })),
      operand.pipe(z.strictObject({ used: z.number() })),
    ]) {
      expect(
        safeRead(
          schema,
          { used: 1, known: "wrong", future: true },
          { notice: false },
        ).success,
      ).toBe(false);
    }
  }
});

// The narrowed boundary refuses every transform requiring additive retry, even one retaining a location.
test("pipe output unions refuse transforming retries including mapped and unmapped locations", () => {
  const output = z.union([
    z.strictObject({ used: z.number().min(2) }),
    z.strictObject({ other: z.string() }),
  ]);
  const preserving = z
    .looseObject({ used: z.number() })
    .transform((value): z.input<typeof output> => ({
      ...value,
      used: value.used + 1,
    }))
    .pipe(output);
  expect(
    safeRead(preserving, { used: 1, future: true }, { notice: false }),
  ).toMatchObject({
    success: false,
    refusals: [{ kind: "transforming-pipe", path: "$" }],
  });
  for (const schema of [
    z
      .unknown()
      .transform((): { used: number; future?: boolean } => ({
        used: 1,
        future: true,
      }))
      .pipe(z.strictObject({ used: z.number() })),
    z
      .looseObject({ used: z.number() })
      .transform((value) => ({ used: value.used, child: value.future }))
      .pipe(
        z.strictObject({
          used: z.number(),
          child: z.strictObject({ used: z.number() }),
        }),
      ),
  ]) {
    expect(
      safeRead(
        schema,
        { used: 1, future: { used: 2, future: true } },
        { notice: false },
      ).success,
    ).toBe(false);
  }
});

// An unknown catchall remains unconstrained through transparent modifiers and union alternatives.
test("unconstrained catchall transforms refuse retry while identity Set pipes repair additions", () => {
  for (const catchall of [
    z.unknown().optional(),
    z.any().readonly(),
    z.lazy(() => z.unknown()),
    z.union([z.number(), z.unknown()]),
    z.unknown().pipe(z.unknown()),
  ]) {
    const schema = z
      .object({ used: z.number() })
      .catchall(catchall)
      .transform((value) => ({ ...value }))
      .pipe(z.strictObject({ used: z.number() }));
    expect(
      safeRead(schema, { used: 1, future: true }, { notice: false }),
    ).toMatchObject({
      success: false,
      refusals: [{ kind: "transforming-pipe", path: "$" }],
    });
  }
  const schema = z.unknown().pipe(z.set(z.strictObject({ used: z.number() })));
  expect(
    safeRead(schema, new Set([{ used: 1, future: true }]), { notice: false }),
  ).toMatchObject({
    success: true,
    data: new Set([{ used: 1 }]),
    droppedKeys: ["[entry].future"],
  });
});

// A failing union alternative cannot make an accepted loose entry part of another candidate's repair.
test("intersection repair retains entries accepted by its selected loose union operand", () => {
  const leaf = z.strictObject({ used: z.number() });
  const schema = z.intersection(
    z.strictObject({ child: leaf }),
    z.union([
      z.looseObject({ child: leaf }),
      z.strictObject({ other: z.number().optional() }),
    ]),
  );
  const stored = { child: { used: 1, future: true }, keep: "retained" };
  expect(safeRead(schema, stored, { notice: false })).toMatchObject({
    success: true,
    data: { child: { used: 1 }, keep: "retained" },
    droppedKeys: ["child.future"],
  });
});
