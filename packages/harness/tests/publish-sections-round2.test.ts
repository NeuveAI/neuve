// Why: the defects the independent review found (round 2), each at the publisher's boundary. A
// call that adds no batch after a packet must finish its publication (or write nothing) and never
// hang the sequence; a person's newest decision is the one that carries; a section no agent
// decided never sits where an agent can close it; and no cut or clip happens without a word.
import { expect, test } from "bun:test";
import { Effect } from "effect";
import {
  Computations,
  Dispositions,
  HumanCommands,
  Identity,
  Log,
  PublishedPackets,
  canonicalJson,
  mintUlid,
  sha256Hex,
} from "@neuve/records-core";
import { PAYLOAD_MAX_BYTES, type RecordEvent } from "@neuve/records-schema";
import type { PublishContext } from "../src/publish.ts";
import {
  PublicationChainBroken,
  publishSettled,
  publishSettledForTest,
  unpublishedBatches,
  type SettledBatch,
} from "../src/publish-sections.ts";
import { sectionKeySetHash } from "../src/section-identity.ts";
import {
  atTime,
  comment,
  eventsOf,
  inputOf,
  keyedOf,
  scratch,
  threeBatches,
} from "./publish-sections-fixtures.ts";

type Packet = Extract<RecordEvent, { kind: "packet.published@2" }>;

const packetsOf = (cycleId: string) =>
  Effect.map(eventsOf(cycleId, "packet.published@2"), (events) =>
    (events as Array<Packet>).sort((x, y) => (x.id < y.id ? -1 : 1)),
  );

/** Batch `c` refused by the lane check: its unit says human-required, its section agentic. */
const refusedC = (): SettledBatch => {
  const { c } = threeBatches();
  return { ...c, units: [{ ...c.units[0]!, lane: "human-required" }] };
};

const ONE = { batches: 1, sections: 2 };

// Finding 1, probe p1: an ending call with no new batch after a packet writes its one packet.
test("an ending call that adds no batch after a packet writes its packet, and a repeat writes nothing", async () => {
  const store = scratch();
  const { a } = threeBatches();
  const result = await store.run(
    Effect.gen(function* () {
      const ctx = store.ctx();
      const first = yield* publishSettled(ctx, inputOf([a], { totals: ONE }));
      const ending = yield* publishSettled(
        ctx,
        inputOf([], { ending: true, totals: ONE }),
      );
      const count = (yield* eventsOf(ctx.cycleId)).length;
      const again = yield* publishSettled(
        ctx,
        inputOf([], { ending: true, totals: ONE }),
      );
      return {
        first,
        ending,
        again,
        grew: (yield* eventsOf(ctx.cycleId)).length - count,
        packets: yield* packetsOf(ctx.cycleId),
        standing: yield* PublishedPackets.readStanding(ctx.cycleId),
      };
    }),
  );
  expect(result.packets).toHaveLength(2);
  const [p1, p2] = result.packets;
  expect(p2!.causation?.supersedes).toBe(p1!.id);
  expect(p1!.payload.complete).toBe(false);
  expect(p2!.payload.complete).toBe(true);
  expect(p2!.payload.ordinal).toBe(2);
  expect(p2!.payload.added).toEqual({
    batches: 0,
    units: 0,
    sections: 0,
    undecided: {},
  });
  expect(result.ending.packetEventId).toBe(p2!.id);
  expect(result.standing?.eventId).toBe(p2!.id);
  expect(result.grew).toBe(0);
  expect(result.again.packetEventId).toBe(p2!.id);
}, 15_000);

// Finding 1, probe p4: a call whose only batch is refused returns, writes no packet, and its
// refusal reaches the ending packet.
test("a refused-only call after a packet returns, writes no packet, and its gap is in the ending packet", async () => {
  const store = scratch();
  const { a } = threeBatches();
  const totals = { batches: 2, sections: 3 };
  const result = await store.run(
    Effect.gen(function* () {
      const ctx = store.ctx();
      yield* publishSettled(ctx, inputOf([a], { totals }));
      const refused = yield* publishSettled(
        ctx,
        inputOf([refusedC()], { totals }),
      );
      const between = (yield* packetsOf(ctx.cycleId)).length;
      const unpublished = yield* unpublishedBatches({
        cycleId: ctx.cycleId,
        runKey: ctx.runKey,
        runId: ctx.runId,
      });
      const ending = yield* publishSettled(
        ctx,
        inputOf([], { ending: true, totals }),
      );
      const read = yield* PublishedPackets.readStanding(ctx.cycleId);
      return { refused, between, unpublished, ending, read };
    }),
  );
  expect(result.refused.refused).toEqual([
    { batch: expect.stringMatching(/^b\./), check: "unit-lane" },
  ]);
  expect(result.refused.packetEventId).toBeNull();
  expect(result.refused.publications).toEqual([]);
  expect(result.between).toBe(1);
  expect(result.unpublished).toEqual([]);
  if (result.read?.kind !== "packet.published@2") throw new Error("no packet");
  expect(result.read.eventId).toBe(result.ending.packetEventId!);
  expect(result.read.ordinal).toBe(2);
  expect(result.read.complete).toBe(false);
  expect(result.read.counts.pending).toEqual({ batches: 1, sections: 1 });
  const refusals = result.read.gaps.filter(
    (g) => g.payload.kind === "batch-not-published",
  );
  expect(refusals).toHaveLength(1);
  expect(refusals[0]!.payload.detail).toContain('"Lookup table"');
}, 15_000);

// Finding 1: the ending-only publication, stopped and replayed later, writes the same packet.
test.each(["plan", "manifest"] as const)(
  "an ending-only publication stopped after its %s replays to the same packet",
  async (stop) => {
    const T = Date.UTC(2026, 10, 12, 14, 0, 0);
    const cycleId = mintUlid();
    const runId = mintUlid();
    const { a } = threeBatches();
    const once = (stopAt?: "plan" | "manifest") => {
      const store = scratch({ cycleId });
      return store.run(
        Effect.gen(function* () {
          const ctx = store.ctx({ runId, startedAt: T - 1_000 });
          yield* atTime(T)(publishSettled(ctx, inputOf([a], { totals: ONE })));
          const ending = inputOf([], { ending: true, totals: ONE });
          if (stopAt !== undefined)
            expect(
              (yield* Effect.exit(
                atTime(T + 10)(publishSettledForTest(ctx, ending, stopAt)),
              ))._tag,
            ).toBe("Failure");
          // Run again later: what the stored plan fixed does not move with the clock.
          yield* atTime(T + (stopAt === undefined ? 10 : 50))(
            publishSettled(ctx, ending),
          );
          return {
            packets: (yield* packetsOf(cycleId)).map((p) => [
              p.id,
              p.refs[0].ref,
            ]),
            keyed: yield* keyedOf(cycleId, ctx.runKey),
          };
        }),
      );
    };
    const reference = await once();
    const replayed = await once(stop);
    expect(replayed.packets).toHaveLength(2);
    expect(replayed).toEqual(reference);
  },
  15_000,
);

/** Stores a chain whose second publication names its own base as its packet. */
const brokenChain = (ctx: PublishContext) =>
  Effect.gen(function* () {
    const store = yield* Computations.ComputationStore;
    const json = (value: unknown) =>
      Effect.succeed({
        bytes: new TextEncoder().encode(canonicalJson(value)),
        mediaType: "application/json",
      });
    const packet = mintUlid();
    const plan = {
      batches: [],
      mode: "first",
      lineage: [],
      run: { runId: ctx.runId },
    };
    const written = (packetId: string) => ({
      kind: "packet",
      packetId,
      batches: [],
      fates: [],
      matched: [],
      gaps: [],
      fellBack: false,
    });
    for (const base of ["root", packet]) {
      const planned = yield* store.run(
        {
          op: "harness.publication",
          opVersion: 2,
          inputs: { cycle: ctx.cycleId, runKey: ctx.runKey, base },
        },
        json(plan),
      );
      yield* store.run(
        {
          op: "harness.publication-write",
          opVersion: 2,
          inputs: { plan: `computation:${planned.computation.key}` },
        },
        json(written(packet)),
      );
    }
  });

// Finding 1: a chain that does not advance is a typed failure, never a loop.
test("a stored chain that does not advance fails loudly instead of spinning", async () => {
  const store = scratch();
  const { a } = threeBatches();
  const result = await store.run(
    Effect.gen(function* () {
      const ctx = store.ctx();
      yield* brokenChain(ctx);
      return {
        publish: yield* Effect.flip(publishSettled(ctx, inputOf([a]))),
        unpublished: yield* Effect.flip(
          unpublishedBatches({
            cycleId: ctx.cycleId,
            runKey: ctx.runKey,
            runId: ctx.runId,
          }),
        ),
      };
    }),
  );
  expect(result.publish).toBeInstanceOf(PublicationChainBroken);
  expect(result.unpublished).toBeInstanceOf(PublicationChainBroken);
}, 15_000);

// Finding 2, probe p2: a person's newest decision on the same code is the one that carries.
test("a person's later request for changes on configuration A carries to configuration B, not their older approval", async () => {
  for (let store = 0; store < 4; store++) {
    const { a } = threeBatches();
    const email = "ana-p2@example.com";
    const ana = Identity.humanFingerprint(email);
    const s = scratch();
    const range = (head: string) => ({
      baseRef: "main",
      baseOid: "1".repeat(40),
      headOid: head,
    });
    const open = (cycleId: string, head: string) =>
      Log.append([
        {
          id: mintUlid(),
          kind: "cycle.opened@1",
          idempotencyKey: `test:cycle:${cycleId}`,
          actor: sha256Hex("opener"),
          occurredAt: new Date().toISOString(),
          attribution: { cycleId, range: range(head) },
          payload: {},
        },
        {
          id: mintUlid(),
          kind: "review.origin-recorded@1",
          idempotencyKey: `test:origin:${cycleId}`,
          actor: sha256Hex("opener"),
          occurredAt: new Date().toISOString(),
          attribution: { cycleId, range: range(head) },
          payload: {
            identity: sha256Hex(`origin:${cycleId}`),
            origin: {
              kind: "channel",
              host: "h",
              channel: "c",
              chat: 3,
              items: [],
            },
          },
        },
      ]);
    const result = await s.run(
      Effect.gen(function* () {
        const unitOf = (cycleId: string) =>
          Effect.gen(function* () {
            const read = yield* PublishedPackets.readStanding(cycleId);
            if (read?.kind !== "packet.published@2")
              throw new Error("no packet");
            return read.batches[0]!.units.find(
              (u) => u.assessment?.payload.lane === "human-required",
            )!;
          });
        const cycle1 = mintUlid();
        yield* open(cycle1, "2".repeat(40));
        yield* publishSettled(
          s.ctx({ cycleId: cycle1, range: range("2".repeat(40)) }),
          inputOf([a], { ending: true, totals: ONE }),
        );
        yield* HumanCommands.recordDisposition({
          person: { email },
          unitId: (yield* unitOf(cycle1)).unitId,
          verdict: "approve",
        });
        const cycle2 = mintUlid();
        yield* open(cycle2, "3".repeat(40));
        const second = { cycleId: cycle2, range: range("3".repeat(40)) };
        yield* publishSettled(
          s.ctx({ ...second, runKey: "a".repeat(64) }),
          inputOf([a], { ending: true, totals: ONE }),
        );
        const onA = yield* unitOf(cycle2);
        yield* HumanCommands.recordDisposition({
          person: { email },
          unitId: onA.unitId,
          verdict: "request-changes",
          comments: [{ body: "The export needs a guard." }],
        });
        yield* publishSettled(
          s.ctx({ ...second, runKey: "b".repeat(64) }),
          inputOf([a], { ending: true, totals: ONE }),
        );
        const onB = yield* unitOf(cycle2);
        return {
          onA: onA.unitId,
          onB,
          judged: yield* Dispositions.judge(onB.unitId),
        };
      }),
    );
    expect(result.onB.unitId).not.toBe(result.onA);
    expect(
      result.onB.carriedDecisions.map((d) => [d.actor, d.payload.verdict]),
    ).toEqual([[ana, "request-changes"]]);
    // A person's request for changes is their decision: it stands on the unit.
    expect(result.judged.standing?.verdict).toBe("request-changes");
    expect(result.judged.standing?.actorId).toBe(ana);
  }
}, 30_000);

// Finding 4: a section no agent decided is refused anywhere but human-required.
test("a section no agent decided outside a human-required unit refuses its batch", async () => {
  const store = scratch();
  const { b } = threeBatches();
  const [b1] = b.sections;
  const agentic = {
    ...b1!,
    entry: {
      ...b1!.entry,
      lane: { ...b1!.entry.lane, applied: "agentic" as const },
    },
  };
  const lowered: SettledBatch = {
    ...b,
    sections: [agentic],
    units: [
      {
        path: "src/b.ts",
        lane: "agentic",
        sectionKeys: [agentic.identity.key],
        verdict: "approve",
        disposition: "approve",
        proof: [],
        comments: [],
      },
    ],
  };
  const result = await store.run(
    Effect.gen(function* () {
      const ctx = store.ctx();
      const summary = yield* publishSettled(
        ctx,
        inputOf([lowered], {
          ending: true,
          totals: { batches: 1, sections: 1 },
        }),
      );
      return {
        summary,
        read: yield* PublishedPackets.readStanding(ctx.cycleId),
      };
    }),
  );
  expect(result.summary.refused).toEqual([
    { batch: expect.stringMatching(/^b\./), check: "undecided-not-for-person" },
  ]);
  if (result.read?.kind !== "packet.published@2") throw new Error("no packet");
  expect(result.read.batches).toEqual([]);
  expect(
    result.read.gaps.find((g) => g.payload.kind === "batch-not-published")
      ?.payload.detail,
  ).toContain("no agent decided wasn't marked for a person to decide");
}, 15_000);

// Note: a request for changes resting on more comments than a disposition can name says so.
test("a request for changes resting on more than 64 comments names 64 and says how many more", async () => {
  const store = scratch();
  const { a } = threeBatches();
  const many: SettledBatch = {
    ...a,
    units: [
      {
        ...a.units[0]!,
        comments: Array.from({ length: 70 }, (_, n) =>
          comment(`claim:${n}`, { restedOn: true }),
        ),
      },
      a.units[1]!,
    ],
  };
  const result = await store.run(
    Effect.gen(function* () {
      const ctx = store.ctx();
      yield* publishSettled(
        ctx,
        inputOf([many], { ending: true, totals: ONE }),
      );
      return yield* PublishedPackets.readStanding(ctx.cycleId);
    }),
  );
  if (result?.kind !== "packet.published@2") throw new Error("no packet");
  const unit = result.batches[0]!.units[0]!;
  expect(unit.comments).toHaveLength(70);
  expect(unit.disposition?.payload.restsOn).toHaveLength(64);
  const cut = result.batches[0]!.gaps.filter(
    (g) => g.payload.kind === "rests-on-cut",
  );
  expect(cut.map((g) => [g.attribution.unitIds, g.payload.detail])).toEqual([
    [
      [unit.unitId],
      expect.stringContaining(
        "rests on 70 comments; it names 64, so 6 more aren't named on it.",
      ),
    ],
  ]);
}, 15_000);

// Note: the reader needs no made-up assembled batch; a batch with references gets only its own.
test("a batch without references names no assembled batch; one with references reads them, nothing undecoded", async () => {
  const store = scratch();
  const { a, c } = threeBatches();
  const withReference: SettledBatch = {
    ...c,
    references: [
      {
        id: "r1",
        entries: ["p1.e1"],
        unitIds: [sectionKeySetHash([c.sections[0]!.identity.key])],
        markerKind: "doc",
        origin: "committed",
        locator: "docs/table.md",
        source: {
          origin: "repository",
          repository: "local",
          revision: "2".repeat(40),
          rev: "head",
          blob: "4".repeat(40),
          path: "docs/table.md",
          startLine: 1,
          endLine: 5,
          kind: "undeclared",
          sameBatch: [],
        },
        anchors: [
          {
            hunk: "h1",
            path: "src/c.ts",
            side: "new",
            startLine: 1,
            endLine: 1,
          },
        ],
        grade: "useful",
        stance: "supports",
        why: "The table's format is documented here.",
        beforeYouDecide: "Check the columns match.",
        retrieval: {
          retriever: null,
          querySha256: null,
          rank: null,
          score: null,
        },
        tokens: 10,
      },
    ],
  };
  const result = await store.run(
    Effect.gen(function* () {
      const ctx = store.ctx();
      yield* publishSettled(
        ctx,
        inputOf([a, withReference], {
          ending: true,
          totals: { batches: 2, sections: 3 },
        }),
      );
      return yield* PublishedPackets.readStanding(ctx.cycleId);
    }),
  );
  if (result?.kind !== "packet.published@2") throw new Error("no packet");
  expect(result.undecoded).toEqual([]);
  const [plain, referenced] = result.batches;
  expect(plain!.assembled).toBeUndefined();
  expect(referenced!.assembled).toMatch(/^computation:/);
  const unit = referenced!.units[0]!;
  expect(unit.references).toHaveLength(1);
  expect(Object.values(unit.referenceDetails).map((d) => d.locator)).toEqual([
    "docs/table.md",
  ]);
}, 15_000);

// Note: a carried comment from an earlier one at its cap still fits, so the decision keeps it.
test("a comment carried from an earlier comment at the payload cap is clipped to fit and still rested on", async () => {
  const { a } = threeBatches();
  const email = "ana-cap@example.com";
  const ana = Identity.humanFingerprint(email);
  const s = scratch();
  const range = (head: string) => ({
    baseRef: "main",
    baseOid: "1".repeat(40),
    headOid: head,
  });
  const result = await s.run(
    Effect.gen(function* () {
      const open = (cycleId: string, head: string) =>
        Log.append([
          {
            id: mintUlid(),
            kind: "cycle.opened@1",
            idempotencyKey: `test:cycle:${cycleId}`,
            actor: sha256Hex("opener"),
            occurredAt: new Date().toISOString(),
            attribution: { cycleId, range: range(head) },
            payload: {},
          },
          {
            id: mintUlid(),
            kind: "review.origin-recorded@1",
            idempotencyKey: `test:origin:${cycleId}`,
            actor: sha256Hex("opener"),
            occurredAt: new Date().toISOString(),
            attribution: { cycleId, range: range(head) },
            payload: {
              identity: sha256Hex(`origin:${cycleId}`),
              origin: {
                kind: "channel",
                host: "h",
                channel: "c",
                chat: 4,
                items: [],
              },
            },
          },
        ]);
      const cycle1 = mintUlid();
      yield* open(cycle1, "2".repeat(40));
      yield* publishSettled(
        s.ctx({ cycleId: cycle1, range: range("2".repeat(40)) }),
        inputOf([a], { ending: true, totals: ONE }),
      );
      const read1 = yield* PublishedPackets.readStanding(cycle1);
      if (read1?.kind !== "packet.published@2") throw new Error("no packet");
      const earlier = read1.batches[0]!.units[1]!.unitId;
      // An earlier comment as large as the cap allows: its body grown until the payload fills it.
      const evidence = Array.from({ length: 32 }, () => ({
        ref: `computation:${"c".repeat(64)}`,
        entry: "e".repeat(128),
      }));
      const payloadOf = (n: number) => ({
        body: "語".repeat(n),
        finding: { kind: "defect", about: "code", evidence },
      });
      const bytes = (value: unknown) =>
        new TextEncoder().encode(canonicalJson(value)).length;
      let n = 20_000;
      while (bytes(payloadOf(n)) > PAYLOAD_MAX_BYTES - 10) n -= 1;
      const big = payloadOf(n);
      const remark = {
        id: mintUlid(),
        kind: "comment.recorded@2",
        idempotencyKey: `test:big:${mintUlid()}`,
        actor: ana,
        occurredAt: new Date().toISOString(),
        attribution: { cycleId: cycle1, unitIds: [earlier] },
        payload: big,
      };
      yield* Log.append([
        {
          id: mintUlid(),
          kind: "actor.registered@1",
          idempotencyKey: `actor:${ana}`,
          actor: ana,
          occurredAt: new Date().toISOString(),
          payload: { actorKind: "human", harness: "git", email },
        },
        remark,
        {
          id: mintUlid(),
          kind: "disposition.recorded@2",
          idempotencyKey: `test:ask:${mintUlid()}`,
          actor: ana,
          occurredAt: new Date().toISOString(),
          attribution: { cycleId: cycle1, unitIds: [earlier] },
          payload: {
            verdict: "request-changes",
            reviewedHeadOid: "2".repeat(40),
            restsOn: [remark.id],
            proof: [],
          },
        },
      ]);
      const cycle2 = mintUlid();
      yield* open(cycle2, "3".repeat(40));
      const summary = yield* publishSettled(
        s.ctx({ cycleId: cycle2, range: range("3".repeat(40)) }),
        inputOf([a], { ending: true, totals: ONE }),
      );
      const read2 = yield* PublishedPackets.readStanding(cycle2);
      if (read2?.kind !== "packet.published@2") throw new Error("no packet");
      return { summary, read2, big };
    }),
  );
  const unit = result.read2.batches[0]!.units[1]!;
  const carried = unit.comments.filter((c) => c.kind === "comment.carried@1");
  expect(carried).toHaveLength(1);
  const payload = carried[0]!.payload as { body: string };
  expect(payload.body.length).toBeLessThan(result.big.body.length);
  expect(
    new TextEncoder().encode(canonicalJson(carried[0]!.payload)).length,
  ).toBeLessThanOrEqual(PAYLOAD_MAX_BYTES);
  expect(unit.carriedDecisions[0]?.payload.restsOn).toEqual([carried[0]!.id]);
  expect(result.read2.complete).toBe(true);
  expect(result.read2.batches[0]!.gaps.map((g) => g.payload.kind)).toContain(
    "carried-comment-clipped",
  );
}, 30_000);
