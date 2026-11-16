import { expect, test } from "bun:test";
import { Effect } from "effect";
import { PublishedPackets } from "@neuve/records-core";
import {
  SettledInputRefused,
  publishSettled,
  type SettledBatch,
} from "../src/publish-sections.ts";
import {
  batchOf,
  comment,
  inputOf,
  lines,
  scratch,
  section,
  threeBatches,
  unit,
} from "./publish-sections-fixtures.ts";

const publishWith = (broken: SettledBatch) => {
  const store = scratch();
  const { a, c } = threeBatches();
  return store.run(
    Effect.gen(function* () {
      const ctx = store.ctx();
      const summary = yield* publishSettled(
        ctx,
        inputOf([a, broken, c], { ending: true }),
      );
      const read = yield* PublishedPackets.readStanding(ctx.cycleId);
      if (read?.kind !== "packet.published@2") throw new Error("no packet");
      return { summary, read };
    }),
  );
};

/** Batch `b` broken one way per check. */
const broken = (): ReadonlyArray<readonly [string, SettledBatch]> => {
  const { b, a } = threeBatches();
  const [b1, b2] = b.sections;
  const only = b.units[0]!;
  return [
    [
      "section-in-no-unit",
      { ...b, units: [{ ...only, sectionKeys: [b1!.identity.key] }] },
    ],
    // A decided section judged into another lane than its unit's.
    [
      "unit-lane",
      {
        ...b,
        sections: [
          b1!,
          {
            ...b2!,
            entry: {
              ...b2!.entry,
              lane: { ...b2!.entry.lane, applied: "agentic" },
            },
          },
        ],
      },
    ],
    [
      "entry-key",
      {
        ...b,
        sections: [
          b1!,
          { ...b2!, entry: { ...b2!.entry, key: b1!.identity.key } },
        ],
      },
    ],
    [
      "unit-path",
      {
        ...b,
        sections: [
          b1!,
          {
            ...b2!,
            identity: {
              ...b2!.identity,
              parts: { ...b2!.identity.parts, path: "src/x.ts" },
            },
          },
        ],
      },
    ],
    [
      "owned-twice",
      { ...b, sections: [b1!, { ...b2!, ownedRanges: b1!.ownedRanges }] },
    ],
    [
      "comment-section",
      {
        ...b,
        units: [
          {
            ...only,
            comments: [comment("c1", { section: a.sections[0]!.identity.key })],
          },
        ],
      },
    ],
    [
      "comment-id",
      { ...b, units: [{ ...only, comments: [comment("has space")] }] },
    ],
    [
      "comment-id",
      { ...b, units: [{ ...only, comments: [comment("c1"), comment("c1")] }] },
    ],
    [
      "unit-sections",
      {
        ...b,
        sections: [
          b1!,
          {
            ...b2!,
            identity: {
              ...b2!.identity,
              parts: { ...b2!.identity.parts, side: "none" },
            },
          },
        ],
      },
    ],
    // A file marked as not read (`excluded`) and as one no agent decided.
    [
      "excluded-undecided",
      {
        ...b,
        sections: [
          { ...b1!, entry: { ...b1!.entry, excluded: { reason: "lockfile" } } },
          b2!,
        ],
      },
    ],
    // The backstop: a section no agent decided, here placed agentic in an agentic unit.
    [
      "undecided-not-for-person",
      {
        ...b,
        sections: [
          {
            ...b1!,
            entry: {
              ...b1!.entry,
              lane: { ...b1!.entry.lane, applied: "agentic" },
            },
          },
          {
            ...b2!,
            entry: {
              ...b2!.entry,
              lane: { ...b2!.entry.lane, applied: "agentic" },
            },
          },
        ],
        units: [{ ...only, lane: "agentic" }],
      },
    ],
  ];
};

// Why: a batch that fails a check is never half written. Each check leaves its batch unpublished,
// pending, with a gap in a reader's words, and the review's other batches published.
test.each(
  broken().map(
    ([check, batch], n) => [`${check} (${n + 1})`, check, batch] as const,
  ),
)(
  "a batch failing %s stays pending with a gap",
  async (_label, check, batch) => {
    const { summary, read } = await publishWith(batch);
    expect(summary.refused).toEqual([
      { batch: expect.stringMatching(/^b\./), check },
    ]);
    expect(read.batches.map((b) => b.recorded?.payload.title)).toEqual([
      "Retry policy",
      "Lookup table",
    ]);
    expect(read.counts.pending).toEqual({ batches: 1, sections: 2 });
    expect(read.complete).toBe(false);
    const gap = read.gaps.find((g) => g.payload.kind === "batch-not-published");
    expect(gap?.payload.detail).toStartWith(
      'The changes in "Guards" aren\'t in this review yet, because',
    );
    expect(gap?.payload.detail).not.toMatch(/[0-9a-f]{16}/);
  },
);

// Why: a comment Records cannot hold as given is withheld and said, never dropped silently.
test("an impact comment without a summary and a comment outside its unit are withheld and disclosed", async () => {
  const { b } = threeBatches();
  const withComments: SettledBatch = {
    ...b,
    units: [
      {
        ...b.units[0]!,
        comments: [
          comment("no-summary", { kind: "impact", effect: "removed" }),
          comment("blank-summary", {
            kind: "impact",
            effect: "removed",
            summary: " \t ",
          }),
          comment("outside", {
            anchor: {
              path: "src/b.ts",
              side: "new",
              startLine: 900,
              endLine: 901,
            },
          }),
          comment("kept"),
        ],
      },
    ],
  };
  const { summary, read } = await publishWith(withComments);
  const guards = read.batches[1]!;
  expect(guards.units[0]!.comments).toHaveLength(1);
  const fates = Object.fromEntries(
    summary.findings.map((f) => [
      f.id,
      f.fate === "withheld" ? f.reason : f.fate,
    ]),
  );
  expect(fates).toMatchObject({
    "no-summary": "impact-without-summary",
    "blank-summary": "impact-without-summary",
    outside: "anchor-outside-unit",
    kept: "published",
  });
  const withheld = guards.gaps.filter(
    (g) => g.payload.kind === "comment-withheld",
  );
  expect(withheld.map((g) => g.payload.detail).sort()).toEqual([
    '2 comments on "b.ts: The block change and 1 more" aren\'t shown, because an impact comment gives no one-line summary of what changes.',
    "A comment on \"b.ts: The block change and 1 more\" isn't shown, because it points to lines the unit doesn't own.",
  ]);
});

// Why: hostile text is cleaned and bounded, never a reason to refuse a whole batch.
test("control characters and a 30,000-character body are cleaned and bounded", async () => {
  const { b } = threeBatches();
  const hostile: SettledBatch = {
    ...b,
    title: "Guards\u0000\u001b[31m",
    units: [
      {
        ...b.units[0]!,
        comments: [
          comment("long", { body: `Bad\u0007 news. ${"x".repeat(30_000)}` }),
          comment("impact", {
            kind: "impact",
            effect: "removed",
            summary: "Removes\nthe\u0000 retry\ttimer.",
          }),
        ],
      },
    ],
  };
  const { read } = await publishWith(hostile);
  const guards = read.batches[1]!;
  expect(guards.recorded?.payload.title).toBe("Guards  [31m");
  const [long, impact] = guards.units[0]!.comments;
  if (
    long?.kind !== "comment.recorded@3" ||
    impact?.kind !== "comment.recorded@3"
  )
    throw new Error("comments missing");
  expect(long.payload.body.length).toBe(10_600);
  expect(long.payload.body).toStartWith("Bad  news.");
  expect(impact.payload.finding?.summary).toBe("Removes the  retry timer.");
});

// Why: a caller's value is checked at the door; one that is not a settled input writes nothing.
test("an input that does not decode is refused whole and writes nothing", async () => {
  const store = scratch();
  const result = await store.run(
    Effect.gen(function* () {
      const ctx = store.ctx();
      const refused = yield* Effect.flip(
        // Not a settled input, as a caller's bug would hand in.
        publishSettled(ctx, {
          batches: [{ title: "x" }],
          totals: { batches: 1, sections: 1 },
        } as never),
      );
      return {
        refused,
        standing: yield* PublishedPackets.standingPacketId(ctx.cycleId),
      };
    }),
  );
  expect(result.refused).toBeInstanceOf(SettledInputRefused);
  expect(result.standing).toBeUndefined();
});

// Why: the readers' batch of lockfiles and generated files has sections no agent judged, by design
// and not undecided: no axes, no review, the lane they are handed, an extra key the reader keeps.
// The backstop must not refuse it.
test("a lockfile batch with no judgement and no undecided cause is accepted at the lane it is handed", async () => {
  const lock = (
    path: string,
    label: string,
    reason: "lockfile" | "declared-generated",
  ) => {
    const s = section({
      label,
      path,
      kind: "file",
      name: null,
      where: { startLine: 1, endLine: 400 },
      ranges: lines(path, 1, 3),
      lane: "static-automation",
    });
    return {
      ...s,
      entry: {
        key: s.identity.key,
        assess: null,
        review: null,
        lane: {
          judged: null,
          surfaced: null,
          floors: [],
          applied: "static-automation" as const,
        },
        lineage: "fresh" as const,
        excluded: { reason },
      },
    };
  };
  const bun = lock("bun.lock", "lock-bun", "lockfile");
  const gen = lock("src/generated.ts", "lock-gen", "declared-generated");
  const files = batchOf(
    "Lockfiles and generated files",
    ["bun.lock", "src/generated.ts"],
    [bun, gen],
    [
      unit("bun.lock", "static-automation", [bun]),
      unit("src/generated.ts", "static-automation", [gen]),
    ],
  );
  const { summary, read } = await publishWith(files);
  expect(summary.refused).toEqual([]);
  const batch = read.batches.find(
    (b) => b.recorded?.payload.title === "Lockfiles and generated files",
  );
  expect(batch?.units.map((u) => u.assessment?.payload.lane)).toEqual([
    "static-automation",
    "static-automation",
  ]);
  expect(batch?.units[0]!.sections[0]!.lane?.applied).toBe("static-automation");
  expect(
    (batch?.units[0]!.sections[0] as { excluded?: unknown }).excluded,
  ).toEqual({ reason: "lockfile" });
  expect(
    batch?.units.every(
      (u) => u.disposition === undefined && u.comments.length === 0,
    ),
  ).toBe(true);
});
