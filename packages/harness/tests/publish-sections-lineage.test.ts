import { expect, test } from "bun:test";
import { Effect } from "effect";
import {
  Blobs,
  Lineage,
  Log,
  PublishedPackets,
  canonicalJson,
  mintUlid,
  sha256Hex,
} from "@neuve/records-core";
import type { RecordEvent } from "@neuve/records-schema";
import { reviewEvents } from "../../records-core/tests/review-fixtures.ts";
import { publishSettled } from "../src/publish-sections.ts";
import {
  batchOf,
  eventsOf,
  inputOf,
  lines,
  scratch,
  section,
  threeBatches,
  unit,
} from "./publish-sections-fixtures.ts";

type Lineage = Extract<RecordEvent, { kind: "lineage.recorded@1" }>;

const actor = sha256Hex("lineage-test-actor");
const range = {
  baseRef: "main",
  baseOid: "1".repeat(40),
  headOid: "2".repeat(40),
};

/** A cycle opened with a review origin in one chat, as a request records it. */
const openCycle = (cycleId: string, chat: number, head = range.headOid) =>
  Log.append([
    {
      id: mintUlid(),
      kind: "cycle.opened@1",
      idempotencyKey: `test:cycle:${cycleId}`,
      actor,
      occurredAt: new Date().toISOString(),
      attribution: { cycleId, range: { ...range, headOid: head } },
      payload: {},
    },
    {
      id: mintUlid(),
      kind: "review.origin-recorded@1",
      idempotencyKey: `test:origin:${cycleId}`,
      actor,
      occurredAt: new Date().toISOString(),
      attribution: { cycleId, range: { ...range, headOid: head } },
      payload: {
        identity: sha256Hex(`origin:${cycleId}`),
        origin: {
          kind: "channel",
          host: "host",
          channel: "review",
          chat,
          items: [],
        },
      },
    },
  ]);

// Why: another configuration of the same range cuts a file differently. Its unit is related to
// the earlier units it overlaps, as changed, and an old unit link resolves to its successor.
test("a regroup in the same cycle names the earlier units as changed, and they resolve", async () => {
  const store = scratch();
  const { a } = threeBatches();
  const whole = section({
    label: "a-whole",
    path: "src/a.ts",
    kind: "block",
    name: null,
    where: { startLine: 1, endLine: 50 },
    ranges: [...lines("src/a.ts", 3, 3), ...lines("src/a.ts", 31, 2)],
    lane: "human-required",
  });
  const regrouped = batchOf(
    "Retry policy",
    ["src/a.ts"],
    [whole],
    [unit("src/a.ts", "human-required", [whole])],
  );
  const result = await store.run(
    Effect.gen(function* () {
      const first = store.ctx();
      yield* publishSettled(
        first,
        inputOf([a], { ending: true, totals: { batches: 1, sections: 2 } }),
      );
      const before = yield* PublishedPackets.readStanding(first.cycleId);
      const later = store.ctx({ runKey: "d".repeat(64) });
      yield* publishSettled(
        later,
        inputOf([regrouped], {
          ending: true,
          totals: { batches: 1, sections: 1 },
        }),
      );
      const after = yield* PublishedPackets.readStanding(first.cycleId);
      const earlierIds =
        before?.kind === "packet.published@2"
          ? before.batches[0]!.units.map((u) => u.unitId)
          : [];
      const successors = [];
      for (const id of earlierIds)
        successors.push(yield* Lineage.successors(id));
      return { earlierIds, after, successors };
    }),
  );
  const after = result.after;
  if (after?.kind !== "packet.published@2") throw new Error("no packet");
  const successor = after.batches[0]!.units[0]!;
  expect(
    successor.lineage?.payload.from.map((f) => [f.unitId, f.relation]),
  ).toEqual(
    expect.arrayContaining(result.earlierIds.map((id) => [id, "changed"])),
  );
  expect(successor.lineage?.payload.from).toHaveLength(2);
  expect(successor.lineage?.payload.from.map((f) => f.lane).sort()).toEqual([
    "agentic",
    "human-required",
  ]);
  expect(
    result.successors.map((list) => list.map((s) => [s.unitId, s.relation])),
  ).toEqual([[[successor.unitId, "changed"]], [[successor.unitId, "changed"]]]);
  // The ending packet of the regroup completes it; no earlier unit is left without a successor.
  expect(after.unmatched).toEqual([]);
});

// Why: across commits, an untouched section keeps its key, so its unit is `unchanged`; a touched
// symbol is `changed`; a reverted file's earlier unit is listed, so its human work stays reachable.
test("a later cycle of the same review says unchanged, changed and unmatched", async () => {
  const store = scratch();
  const { a, b } = threeBatches();
  const a2Changed = section({
    label: "a2-later",
    path: "src/a.ts",
    name: "exported",
    where: { startLine: 30, endLine: 52 },
    ranges: lines("src/a.ts", 31, 3),
    lane: "human-required",
  });
  const laterA = batchOf(
    "Retry policy",
    ["src/a.ts"],
    [a.sections[0]!, a2Changed],
    [a.units[0]!, unit("src/a.ts", "human-required", [a2Changed])],
  );
  const result = await store.run(
    Effect.gen(function* () {
      const cycle1 = mintUlid();
      yield* openCycle(cycle1, 7);
      const first = store.ctx({ cycleId: cycle1 });
      yield* publishSettled(
        first,
        inputOf([a, b], { ending: true, totals: { batches: 2, sections: 4 } }),
      );
      const earlier = yield* PublishedPackets.readStanding(cycle1);
      const cycle2 = mintUlid();
      yield* openCycle(cycle2, 7, "3".repeat(40));
      const second = store.ctx({
        cycleId: cycle2,
        range: { ...range, headOid: "3".repeat(40) },
      });
      yield* publishSettled(
        second,
        inputOf([laterA], {
          ending: true,
          totals: { batches: 1, sections: 2 },
        }),
      );
      return { earlier, later: yield* PublishedPackets.readStanding(cycle2) };
    }),
  );
  if (
    result.earlier?.kind !== "packet.published@2" ||
    result.later?.kind !== "packet.published@2"
  )
    throw new Error("no packets");
  const [e1, e2] = result.earlier.batches[0]!.units;
  const eb = result.earlier.batches[1]!.units[0]!;
  const [n1, n2] = result.later.batches[0]!.units;
  expect(n1!.lineage?.payload.from).toEqual([
    {
      unitId: e1!.unitId,
      cycleId: result.earlier.batches[0]!.recorded!.attribution.cycleId,
      relation: "unchanged",
      unchanged: 1,
      changed: 0,
      lane: "agentic",
    },
  ]);
  expect(
    n2!.lineage?.payload.from.map((f) => [
      f.unitId,
      f.relation,
      f.unchanged,
      f.changed,
    ]),
  ).toEqual([[e2!.unitId, "changed", 0, 1]]);
  expect(n1!.unitId).not.toBe(e1!.unitId);
  expect(result.later.unmatched).toEqual([eb.unitId]);
});

// Why: an older-shape review of the same cycle has units with ranges only; they match by
// overlapping lines, and the new review supersedes it only when it ends.
test("an older-shape earlier packet in the same cycle matches by overlapping lines", async () => {
  const store = scratch();
  const fixture = reviewEvents();
  const s = section({
    label: "a-new",
    path: "src/a.ts",
    name: "retry",
    where: { startLine: 1, endLine: 9 },
    ranges: lines("src/a.ts", 3, 2),
    lane: "agentic",
  });
  const batch = batchOf(
    "Retry",
    ["src/a.ts"],
    [s],
    [unit("src/a.ts", "agentic", [s])],
  );
  const result = await store.run(
    Effect.gen(function* () {
      yield* Log.append(
        fixture.all.filter((event) => event.kind !== "packet.published@1"),
      );
      const manifest = {
        version: 7,
        batches: [
          {
            batch: "b1",
            batchId: fixture.batchId,
            units: fixture.units.map((unitId, n) => ({
              unit: `b1.u${n + 1}`,
              unitId,
              events: [],
            })),
            events: fixture.structure.map((event) => ({
              kind: event.kind,
              id: event.id,
            })),
          },
        ],
      };
      const blobs = yield* Blobs.BlobStore;
      const stored = yield* blobs.put({
        bytes: new TextEncoder().encode(canonicalJson(manifest)),
        mediaType: "application/json",
        retention: "durable",
      });
      yield* Log.append([
        {
          ...fixture.packet,
          refs: [{ ref: `blob:${stored.blob.hash}`, role: "manifest" }],
        },
      ]);
      const ctx = store.ctx({ cycleId: fixture.cycleId });
      const staged = yield* publishSettled(
        ctx,
        inputOf([batch], { totals: { batches: 1, sections: 1 } }),
      );
      const between = yield* PublishedPackets.standingPacketId(fixture.cycleId);
      yield* publishSettled(
        ctx,
        inputOf([], { ending: true, totals: { batches: 1, sections: 1 } }),
      );
      const read = yield* PublishedPackets.readStanding(fixture.cycleId);
      const lineage = (yield* eventsOf(
        fixture.cycleId,
        "lineage.recorded@1",
      )) as Array<Lineage>;
      return { staged, between, read, lineage };
    }),
  );
  expect(result.staged.packetEventId).toBeNull();
  expect(result.between).toBe(fixture.packet.id);
  expect(result.read?.kind).toBe("packet.published@2");
  expect(result.read?.supersedes).toBe(fixture.packet.id);
  expect(result.lineage).toHaveLength(1);
  expect(result.lineage[0]!.payload.from).toEqual([
    {
      unitId: fixture.units[0],
      cycleId: fixture.cycleId,
      relation: "changed",
      unchanged: 0,
      changed: 1,
      lane: "agentic",
    },
  ]);
  if (result.read?.kind === "packet.published@2")
    expect([...result.read.unmatched].sort()).toEqual(
      [fixture.units[1], fixture.units[2]].sort(),
    );
});

/** A git repository with two commits on one line and one unrelated commit. */
const repository = () => {
  const directory = scratch().directory;
  const git = (...args: Array<string>) => {
    const run = Bun.spawnSync(
      [
        "git",
        "-C",
        directory,
        "-c",
        "user.email=t@example.com",
        "-c",
        "user.name=t",
        ...args,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (run.exitCode !== 0) throw new Error(run.stderr.toString());
    return run.stdout.toString().trim();
  };
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "one");
  const first = git("rev-parse", "HEAD");
  git("commit", "-q", "--allow-empty", "-m", "two");
  const second = git("rev-parse", "HEAD");
  git("checkout", "-q", "--orphan", "other");
  git("commit", "-q", "--allow-empty", "-m", "unrelated");
  const unrelated = git("rev-parse", "HEAD");
  return { directory, first, second, unrelated };
};

const openPlainCycle = (cycleId: string, head: string) =>
  Log.append([
    {
      id: mintUlid(),
      kind: "cycle.opened@1",
      idempotencyKey: `test:cycle:${cycleId}`,
      actor,
      occurredAt: new Date().toISOString(),
      attribution: { cycleId, range: { ...range, headOid: head } },
      payload: {},
    },
  ]);

// Why: with no review origin, "the same review" is the newest earlier cycle on the same base whose
// head is an ancestor of this head; a cycle whose head is unrelated finds none.
test("with no origin, an earlier cycle counts only when its head is an ancestor", async () => {
  const git = repository();
  const store = scratch();
  const { a } = threeBatches();
  const totals = { batches: 1, sections: 2 };
  const result = await store.run(
    Effect.gen(function* () {
      const cycle1 = mintUlid();
      yield* openPlainCycle(cycle1, git.first);
      yield* publishSettled(
        {
          ...store.ctx({
            cycleId: cycle1,
            range: { ...range, headOid: git.first },
          }),
          repository: git.directory,
        },
        inputOf([a], { ending: true, totals }),
      );
      const cycle2 = mintUlid();
      yield* openPlainCycle(cycle2, git.second);
      yield* publishSettled(
        {
          ...store.ctx({
            cycleId: cycle2,
            range: { ...range, headOid: git.second },
          }),
          repository: git.directory,
        },
        inputOf([a], { ending: true, totals }),
      );
      const cycle3 = mintUlid();
      yield* openPlainCycle(cycle3, git.unrelated);
      yield* publishSettled(
        {
          ...store.ctx({
            cycleId: cycle3,
            range: { ...range, headOid: git.unrelated },
          }),
          repository: git.directory,
        },
        inputOf([a], { ending: true, totals }),
      );
      const relations = [];
      for (const cycle of [cycle2, cycle3])
        relations.push(
          (
            (yield* eventsOf(cycle, "lineage.recorded@1")) as Array<Lineage>
          ).map((e) =>
            e.payload.from.map((f) => [
              f.cycleId === cycle1 || f.cycleId === cycle2
                ? "earlier"
                : f.cycleId,
              f.relation,
            ]),
          ),
        );
      return relations;
    }),
  );
  expect(result[0]).toEqual([
    [["earlier", "unchanged"]],
    [["earlier", "unchanged"]],
  ]);
  expect(result[1]).toEqual([]);
});
