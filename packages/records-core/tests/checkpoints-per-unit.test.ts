// Why: the readers write each section's judgement entry with its whole Assess class's
// requirements, so every section of a class repeats them. A real published review showed one test
// file with 44 checkpoints that were 4 requirements, and a documentation requirement on a test file
// none of whose lines it named. These are the shapes that packet showed: many sections of one class
// in one unit, one class across units with and without anchors, a requirement no section ties to a
// line, and requirements that look alike but differ in what identifies them. Identity is easy to
// get wrong both ways: merging what differs hides a requirement, keeping copies multiplies it.
// An Assess class can also span batches (reading groups follow directories, not Map groups), so
// placement is read over the whole packet, and merged copies must not hide a disagreement.
import { afterAll, expect, test } from "bun:test";
import { Effect } from "effect";
import type { AssessedSection } from "@neuve/records-schema";
import {
  Blobs,
  Checkpoints,
  Log,
  PublishedPackets,
  mintUlid,
} from "../src/index.ts";
import { contentLayer, storeContent } from "./new-shape-support.ts";
import { newShapeReview } from "./review-fixtures.ts";
import {
  actor,
  freshLocation,
  removeTemporaryDirectories,
  runOn,
} from "./support.ts";

afterAll(removeTemporaryDirectories);

type Requirement = NonNullable<
  AssessedSection["assess"]
>["easeOfValidation"]["requirements"][number];

type Lines = Requirement["anchors"][number];

const lines = (path: string, startLine: number, endLine: number): Lines => ({
  path,
  side: "new",
  startLine,
  endLine,
});

const requirement = (
  text: string,
  anchors: ReadonlyArray<Lines>,
  over: Partial<Requirement> = {},
): Requirement => ({
  requirement: text,
  cites: ["src/a.ts:n:1-3"],
  coverage: "solid",
  proof: [],
  kinds: ["test-run", "log"],
  agree: true,
  testable: true,
  anchors: [...anchors],
  sources: [],
  ...over,
});

/** A section of a unit: its judgement entry, holding `requirements`, and its owned lines. */
const section = (
  key: string,
  owned: Lines,
  requirements: ReadonlyArray<Requirement>,
) => ({
  entry: {
    key,
    assess: {
      complexity: { level: "low", factors: [] },
      easeOfValidation: { level: "easy", requirements: [...requirements] },
      movement: [],
      gaps: [],
    },
    review: null,
    lane: { judged: null, surfaced: null, floors: [], applied: "agentic" },
    lineage: "fresh",
  } as AssessedSection,
  ownedRanges: [{ kind: "lines" as const, ...owned }],
});

type Section = ReturnType<typeof section>;

/** Reads each unit's checkpoints from its sections, as the packet read does for a packet. */
const read = (units: ReadonlyArray<ReadonlyArray<Section>>) =>
  runOn(
    freshLocation(),
    Checkpoints.sectionCheckpoints({
      units: units.map((sections) => ({
        sections,
        ownedPaths: sections.flatMap((s) => s.ownedRanges.map((r) => r.path)),
        pins: [],
      })),
      check: undefined,
    }),
  );

const TEXTS = [
  "Retries stop after the third attempt.",
  "The error names the file it could not read.",
  "The README says how to run the check.",
  "A cancelled run leaves no lock behind.",
];

test("four requirements on eleven sections of one class in one unit are four checkpoints, each with the union of the anchors", async () => {
  const sections = Array.from({ length: 11 }, (_, i) => {
    const own = lines("tests/large.test.ts", 100 - 9 * i, 102 - 9 * i);
    return section(
      `s${i}`,
      own,
      TEXTS.map((text) => requirement(text, [own])),
    );
  });
  const [unit] = await read([sections]);
  expect(unit!.checkpoints.map((c) => [c.number, c.requirement])).toEqual(
    TEXTS.map((text, i) => [i + 1, text]),
  );
  // In line order, deduplicated: the sections were listed from the bottom of the file up.
  const union = Array.from({ length: 11 }, (_, i) =>
    lines("tests/large.test.ts", 10 + 9 * i, 12 + 9 * i),
  );
  for (const checkpoint of unit!.checkpoints) {
    expect(checkpoint.anchors).toEqual(union);
    expect(checkpoint.section).toBe("s0");
  }
});

test("one class across units: each unit holds the requirement once with its own anchors, and a unit holding it on no line gets none", async () => {
  const text = TEXTS[0]!;
  const a1 = lines("src/a.ts", 1, 2);
  const a2 = lines("src/a.ts", 5, 6);
  const b1 = lines("src/b.ts", 20, 22);
  const [a, b, c] = await read([
    [
      section("a1", a1, [requirement(text, [a1])]),
      section("a2", a2, [requirement(text, [a2])]),
    ],
    [section("b1", b1, [requirement(text, [b1])])],
    [section("c1", lines("docs/c.md", 3, 4), [requirement(text, [])])],
  ]);
  expect(a!.checkpoints.map((c) => [c.requirement, c.anchors])).toEqual([
    [text, [a1, a2]],
  ]);
  expect(b!.checkpoints.map((c) => [c.requirement, c.anchors])).toEqual([
    [text, [b1]],
  ]);
  expect(c!.checkpoints).toEqual([]);
});

test("a requirement no section ties to a line is one checkpoint, on the unit holding the class's first section by path then line, tied to no line", async () => {
  const text = TEXTS[2]!;
  const [x, y, z] = await read([
    [section("x1", lines("src/x.ts", 40, 41), [requirement(text, [])])],
    [section("y1", lines("src/y.ts", 7, 9), [requirement(text, [])])],
    [
      section("z1", lines("src/w.ts", 50, 51), [requirement(text, [])]),
      section("z2", lines("src/w.ts", 30, 31), [requirement(text, [])]),
    ],
  ]);
  expect(x!.checkpoints).toEqual([]);
  expect(y!.checkpoints).toEqual([]);
  // The path first, as units are listed (src/w.ts before src/x.ts and src/y.ts, though src/y.ts
  // starts on an earlier line), then the line within it. An empty anchor list is the existing mark
  // for a checkpoint anchored to its unit as a whole.
  expect(
    z!.checkpoints.map((c) => [c.number, c.requirement, c.section, c.anchors]),
  ).toEqual([[1, text, "z2", []]]);
});

test("requirements that differ only in cites, kinds or proof stay apart; whitespace and case alone do not", async () => {
  const own = (i: number) => lines("src/a.ts", 10 * i + 1, 10 * i + 2);
  const held = (i: number) => [
    requirement(TEXTS[1]!, [own(i)]),
    requirement(TEXTS[1]!, [own(i)], { cites: ["src/a.ts:n:4-5"] }),
    requirement(TEXTS[1]!, [own(i)], { kinds: ["test-run", "screenshot"] }),
    requirement(TEXTS[1]!, [own(i)], { proof: ["01JPROOF0000000000000000AA"] }),
    requirement(`  ${TEXTS[1]!.toUpperCase().replace(/ /g, "  ")}\n`, [own(i)]),
  ];
  const [unit] = await read([
    [section("s1", own(1), held(1)), section("s2", own(2), held(2))],
  ]);
  expect(
    unit!.checkpoints.map((c) => [
      c.cites,
      c.kinds,
      c.records.map((r) => r.eventId),
      c.anchors,
    ]),
  ).toEqual([
    [["src/a.ts:n:1-3"], ["test-run", "log"], [], [own(1), own(2)]],
    [["src/a.ts:n:4-5"], ["test-run", "log"], [], [own(1), own(2)]],
    [["src/a.ts:n:1-3"], ["test-run", "screenshot"], [], [own(1), own(2)]],
    [
      ["src/a.ts:n:1-3"],
      ["test-run", "log"],
      ["01JPROOF0000000000000000AA"],
      [own(1), own(2)],
    ],
  ]);
});

/** Stores a new-shape review whose one Assess class spans both batches, and reads its packet. */
const spanning = async () => {
  const fixture = newShapeReview({ spans: true });
  const location = freshLocation();
  const packet = await runOn(
    location,
    Effect.gen(function* () {
      yield* storeContent(fixture);
      yield* Log.append(fixture.all);
      return yield* PublishedPackets.readStanding(fixture.cycleId);
    }).pipe(Effect.provide(contentLayer(location))),
  );
  if (packet?.kind !== "packet.published@2")
    throw new Error("expected version 2");
  return {
    fixture,
    large: packet.batches[0]!.units[0]!,
    small: packet.batches[1]!.units[0]!,
  };
};

test("a class across two batches: a requirement it ties to lines in one batch is one checkpoint, on the unit that ties it", async () => {
  const { fixture, large, small } = await spanning();
  const retry = `The ${fixture.sectionKeys.k1.slice(0, 4)} change keeps retrying.`;
  expect(
    large.checkpoints.flatMap((c) =>
      c.requirement === retry && "section" in c ? [[c.section, c.anchors]] : [],
    ),
  ).toEqual([
    [
      fixture.sectionKeys.k1,
      [{ path: "src/large.ts", side: "new", startLine: 3, endLine: 5 }],
    ],
  ]);
  // The small unit, in the other batch, holds it on no line: none of it.
  expect(small.checkpoints.map((c) => c.requirement)).not.toContain(retry);
});

test("a requirement no section ties to a line, held across two batches, is one checkpoint in all", async () => {
  const { fixture, large, small } = await spanning();
  const guide = "The guide names the retry flag.";
  const held = [large, small].flatMap((unit) =>
    unit.checkpoints.flatMap((c) =>
      c.requirement === guide && "section" in c
        ? [[unit.local, c.section, c.anchors]]
        : [],
    ),
  );
  // src/large.ts is listed before src/small.ts.
  expect(held).toEqual([[large.local, fixture.sectionKeys.k1, []]]);
  expect(small.checkpoints).toEqual([]);
});

test("within one unit, a checkpoint sits under the first section that ties it to lines", async () => {
  const text = TEXTS[3]!;
  const tied = lines("src/a.ts", 20, 22);
  const [unit] = await read([
    [
      section("a1", lines("src/a.ts", 1, 2), [requirement(text, [])]),
      section("a2", tied, [requirement(text, [tied])]),
      section("a3", lines("src/a.ts", 40, 41), [
        requirement(text, [lines("src/a.ts", 40, 41)]),
      ]),
    ],
  ]);
  expect(unit!.checkpoints.map((c) => [c.section, c.anchors])).toEqual([
    ["a2", [tied, lines("src/a.ts", 40, 41)]],
  ]);
});

test("copies of one requirement that disagree read as conflicting, whichever copy comes first", async () => {
  const location = freshLocation();
  const revision = "b".repeat(40);
  const proof = (kind: "test-run" | "log") =>
    Effect.gen(function* () {
      const bytes = new TextEncoder().encode(`${kind}\n`);
      const mediaType = "text/plain; charset=utf-8";
      const stored = yield* (yield* Blobs.BlobStore).put({
        bytes,
        mediaType,
        retention: "raw-capture",
      });
      const event = {
        id: mintUlid(),
        kind: "proof.recorded@1",
        idempotencyKey: `proof:${mintUlid()}`,
        actor,
        occurredAt: "2026-11-13T10:00:00.000Z",
        attribution: {
          range: { baseRef: "main", baseOid: revision, headOid: revision },
          sessionId: "session-1",
        },
        refs: [{ ref: `blob:${stored.blob.hash}`, role: "artefact" }],
        payload: {
          kind,
          revision,
          claim: "It shows the change working.",
          requirement: { text: "The change works" },
          artefact: { mediaType, bytes: bytes.byteLength },
          worktree: { head: revision, scope: "tracked-tree", dirty: false },
        },
      };
      yield* Log.append([event]);
      return event.id;
    });
  const a = lines("src/a.ts", 1, 2);
  const b = lines("src/a.ts", 10, 12);
  const [unit] = await runOn(
    location,
    Effect.gen(function* () {
      const records = [yield* proof("test-run"), yield* proof("log")];
      const held = (agree: boolean, anchors: Lines) =>
        requirement(TEXTS[0]!, [anchors], { proof: records, agree });
      return yield* Checkpoints.sectionCheckpoints({
        units: [
          {
            sections: [
              section("s1", a, [held(true, a)]),
              section("s2", b, [held(false, b)]),
            ],
            ownedPaths: ["src/a.ts"],
            pins: [],
          },
        ],
        // Every record current, so only agreement decides between Proven and Conflicting.
        check: () => Effect.succeed({ status: "current" } as const),
      });
    }).pipe(Effect.provide(contentLayer(location))),
  );
  expect(unit!.checkpoints.map((c) => [c.proof, c.anchors])).toEqual([
    ["conflicting", [a, b]],
  ]);
});
