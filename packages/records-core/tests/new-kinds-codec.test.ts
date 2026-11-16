// Why: the bounds of the five new kinds (`unit.recorded@3`, `assessment.recorded@4`,
// `comment.recorded@3`, `lineage.recorded@1`, `packet.published@2`) are the contract the harness and
// the readers lanes write against. Each kind decodes at its bounds and refuses just past them, and
// the two whose payloads carry open-ended counts fit the 64 KB payload cap at every bound, which
// only measuring shows.
import { afterAll, expect, test } from "bun:test";
import { Effect } from "effect";
import { PAYLOAD_MAX_BYTES, UnitSections } from "@neuve/records-schema";
import { Log, canonicalJson, mintUlid, sha256Hex } from "../src/index.ts";
import { newShapeReview } from "./review-fixtures.ts";
import { freshLocation, removeTemporaryDirectories, runOn } from "./support.ts";

afterAll(removeTemporaryDirectories);

type Envelope = Record<string, unknown> & {
  readonly payload: unknown;
  readonly attribution?: unknown;
};

/** A copy of `event` with a fresh identity and `patch` applied, as a separate record. */
const vary = (event: Envelope, patch: Record<string, unknown>) => ({
  ...event,
  id: mintUlid(),
  idempotencyKey: `variant:${mintUlid()}`,
  ...patch,
});

const payloadOf = (event: Envelope) => event.payload as Record<string, unknown>;

/** A store holding the new-shape review, and a check that appends one event and names the outcome. */
const setup = async () => {
  const fixture = newShapeReview();
  const location = freshLocation();
  await runOn(location, Log.append(fixture.all));
  const outcome = (event: unknown) =>
    runOn(
      location,
      Effect.match(Log.append([event]), {
        onFailure: (error) => (error as { _tag?: string })._tag ?? "untagged",
        onSuccess: () => "appended",
      }),
    );
  return { fixture, outcome };
};

const bytesOf = (payload: unknown) =>
  new TextEncoder().encode(canonicalJson(payload)).length;

test("unit version 3 decodes at its bounds and refuses just past them", async () => {
  const { fixture, outcome } = await setup();
  const unit = fixture.events.units.large as Envelope;
  const payload = payloadOf(unit);
  const cases: ReadonlyArray<
    readonly [string, Record<string, unknown>, string]
  > = [
    [
      "title at 512",
      { payload: { ...payload, title: "t".repeat(512) } },
      "appended",
    ],
    [
      "title at 513",
      { payload: { ...payload, title: "t".repeat(513) } },
      "InvalidEvent",
    ],
    [
      "path at 4,096",
      { payload: { ...payload, path: "p".repeat(4_096) } },
      "appended",
    ],
    [
      "path at 4,097",
      { payload: { ...payload, path: "p".repeat(4_097) } },
      "InvalidEvent",
    ],
    [
      "no section",
      { payload: { ...payload, sections: { count: 0 } } },
      "InvalidEvent",
    ],
    [
      "no range",
      { payload: { ...payload, ranges: { count: 0, lines: 0 } } },
      "InvalidEvent",
    ],
    [
      "negative lines",
      { payload: { ...payload, ranges: { count: 1, lines: -1 } } },
      "InvalidEvent",
    ],
    [
      "a key that is not a hash",
      { payload: { ...payload, key: "u1" } },
      "InvalidEvent",
    ],
    [
      "a grouping, which version 3 has not",
      { payload: { ...payload, grouping: { gapLines: 20 } } },
      "InvalidEvent",
    ],
    [
      "titled by an agent",
      { payload: { ...payload, titleBy: "agent" } },
      "appended",
    ],
    [
      "titled by someone else",
      { payload: { ...payload, titleBy: "human" } },
      "InvalidEvent",
    ],
    [
      "no titleBy",
      { payload: { ...payload, titleBy: undefined } },
      "InvalidEvent",
    ],
    [
      "a sections ref that is a computation",
      { refs: [{ ref: `computation:${sha256Hex("x")}`, role: "sections" }] },
      "InvalidEvent",
    ],
    ["no sections ref", { refs: [] }, "InvalidEvent"],
  ];
  for (const [name, patch, expected] of cases)
    expect({ name, outcome: await outcome(vary(unit, patch)) }).toEqual({
      name,
      outcome: expected,
    });
});

test("assessment version 4 decodes at its bounds, refuses past them, and fits the payload cap at every bound", async () => {
  const { fixture, outcome } = await setup();
  const assessment = fixture.events.assessments.large as Envelope;
  const payload = payloadOf(assessment);
  const causes = (n: number, value = 1) =>
    Object.fromEntries(
      Array.from({ length: n }, (_, index) => [
        `c${String(index).padStart(2, "0")}${"x".repeat(29)}`,
        value,
      ]),
    );
  const sections = (patch: Record<string, unknown>) => ({
    payload: {
      ...payload,
      sections: { count: 2, raised: 0, undecided: {}, ...patch },
    },
  });
  const cases: ReadonlyArray<
    readonly [string, Record<string, unknown>, string]
  > = [
    ["lane rule 3", { payload: { ...payload, laneRule: 3 } }, "appended"],
    ["lane rule 2", { payload: { ...payload, laneRule: 2 } }, "InvalidEvent"],
    [
      "lane rule 1,000",
      { payload: { ...payload, laneRule: 1_000 } },
      "appended",
    ],
    [
      "lane rule 1,001",
      { payload: { ...payload, laneRule: 1_001 } },
      "InvalidEvent",
    ],
    ["no section", sections({ count: 0 }), "InvalidEvent"],
    ["every section raised", sections({ raised: 2 }), "appended"],
    ["more raised than held", sections({ raised: 3 }), "InvalidEvent"],
    [
      "every section undecided",
      sections({ undecided: { failed: 1, "not-reached": 1 } }),
      "appended",
    ],
    [
      "more undecided than held",
      sections({ undecided: { failed: 2, unsure: 1 } }),
      "InvalidEvent",
    ],
    [
      "a cause counted zero",
      sections({ undecided: { failed: 0 } }),
      "InvalidEvent",
    ],
    [
      "a cause that is not a cause name",
      sections({ undecided: { Failed: 1 } }),
      "InvalidEvent",
    ],
    ["16 causes", sections({ count: 16, undecided: causes(16) }), "appended"],
    [
      "17 causes",
      sections({ count: 17, undecided: causes(17) }),
      "InvalidEvent",
    ],
    [
      "a cause name of 32",
      sections({ undecided: { [`a${"b".repeat(31)}`]: 1 } }),
      "appended",
    ],
    [
      "a cause name of 33",
      sections({ undecided: { [`a${"b".repeat(32)}`]: 1 } }),
      "InvalidEvent",
    ],
    [
      "rationale at 1,000",
      { payload: { ...payload, rationale: "r".repeat(1_000) } },
      "appended",
    ],
    [
      "rationale at 1,001",
      { payload: { ...payload, rationale: "r".repeat(1_001) } },
      "InvalidEvent",
    ],
    [
      "axes, which version 4 keeps per section",
      { payload: { ...payload, quadrant: "low-easy" } },
      "InvalidEvent",
    ],
    [
      "judgements as a blob",
      { refs: [{ ref: `blob:${sha256Hex("x")}`, role: "judgements" }] },
      "InvalidEvent",
    ],
  ];
  for (const [name, patch, expected] of cases)
    expect({ name, outcome: await outcome(vary(assessment, patch)) }).toEqual({
      name,
      outcome: expected,
    });

  // Every count at its largest, 16 causes of 32 characters, the rationale in 3-byte characters.
  const max = Number.MAX_SAFE_INTEGER;
  const largest = vary(assessment, {
    payload: {
      lane: "human-required",
      laneRule: 1_000,
      sections: {
        count: max,
        raised: max,
        undecided: Object.fromEntries(
          Array.from({ length: 16 }, (_, index) => [
            `c${String(index).padStart(2, "0")}${"x".repeat(29)}`,
            Math.floor(max / 16),
          ]),
        ),
      },
      rationale: "語".repeat(1_000),
    },
  });
  expect(bytesOf(largest.payload)).toBeLessThanOrEqual(PAYLOAD_MAX_BYTES);
  expect(await outcome(largest)).toBe("appended");
});

test("comment version 3 holds an impact finding with its effect and summary, and refuses either alone", async () => {
  const { fixture, outcome } = await setup();
  const comment = fixture.events.impact as Envelope;
  const finding = (patch: Record<string, unknown>) => ({
    payload: {
      body: "A finding.",
      finding: {
        kind: "impact",
        about: "code",
        effect: "removed",
        summary: "The retry limit is gone.",
        evidence: [],
        ...patch,
      },
    },
  });
  const cases: ReadonlyArray<
    readonly [string, Record<string, unknown>, string]
  > = [
    ["impact with its effect", finding({}), "appended"],
    [
      "impact without an effect",
      finding({ effect: undefined }),
      "InvalidEvent",
    ],
    [
      "an effect on a defect",
      finding({ kind: "defect", summary: undefined }),
      "InvalidEvent",
    ],
    [
      "a defect without an effect",
      finding({ kind: "defect", effect: undefined, summary: undefined }),
      "appended",
    ],
    // Round 3: the impact finding's one sentence, which the desk prints in a batch briefing.
    [
      "impact without a summary",
      finding({ summary: undefined }),
      "InvalidEvent",
    ],
    [
      "a summary on a defect",
      finding({ kind: "defect", effect: undefined }),
      "InvalidEvent",
    ],
    [
      "a summary on a risk",
      finding({ kind: "risk", effect: undefined }),
      "InvalidEvent",
    ],
    ["a summary at 300", finding({ summary: "s".repeat(300) }), "appended"],
    ["a summary at 301", finding({ summary: "s".repeat(301) }), "InvalidEvent"],
    [
      "a summary with a line break",
      finding({ summary: "One line.\nAnother." }),
      "InvalidEvent",
    ],
    [
      "a summary with a tab",
      finding({ summary: "One\tline." }),
      "InvalidEvent",
    ],
    [
      "a summary with a control character",
      finding({ summary: "One\u0001line." }),
      "InvalidEvent",
    ],
    ["an empty summary", finding({ summary: "" }), "InvalidEvent"],
    // Last pass: a summary says something, on one line.
    ["a summary of one space", finding({ summary: " " }), "InvalidEvent"],
    [
      "a summary of spaces only",
      finding({ summary: "\u00a0 \u3000" }),
      "InvalidEvent",
    ],
    [
      "a summary with spaces around its words",
      finding({ summary: " Retries stop sooner. " }),
      "appended",
    ],
    [
      "a summary with a line separator",
      finding({ summary: "One\u2028line." }),
      "InvalidEvent",
    ],
    [
      "a summary with a paragraph separator",
      finding({ summary: "One\u2029line." }),
      "InvalidEvent",
    ],
    [
      "a summary with a next-line character",
      finding({ summary: "One\u0085line." }),
      "InvalidEvent",
    ],
    // Fixes: a summary of only invisible or filler characters prints blank, so it is refused; one
    // letter or digit is enough.
    ...(
      [
        ["a zero-width space", "\u200b"],
        ["a word joiner", "\u2060"],
        ["a Hangul filler", "\u3164"],
        ["a halfwidth Hangul filler", "\uffa0"],
        ["a soft hyphen", "\u00ad"],
        ["a blank Braille pattern", "\u2800"],
      ] as const
    ).map(
      ([name, filler]) =>
        [
          `a summary of only ${name}`,
          finding({ summary: `${filler}${filler} ${filler}` }),
          "InvalidEvent",
        ] as const,
    ),
    ["a summary that is a number", finding({ summary: "42" }), "appended"],
    [
      "a summary that is a JSON number",
      finding({ summary: 42 }),
      "InvalidEvent",
    ],
    [
      "a summary of fillers around one letter",
      finding({ summary: "\u200bx\u3164" }),
      "appended",
    ],
    [
      "an effect that is not one",
      finding({ effect: "broken" }),
      "InvalidEvent",
    ],
    [
      "a forged sign on an impact finding",
      finding({ about: "tests", signal: "forged" }),
      "InvalidEvent",
    ],
    ["a plain comment", { payload: { body: "A note." } }, "appended"],
    [
      "superseding another record",
      { causation: { supersedes: mintUlid() } },
      "InvalidEvent",
    ],
    // Round 2: a body bounded in characters that take at most 3 bytes; round 3 lowered the bound
    // from 11,000 to 10,600 to make room for the summary.
    ["a body at 10,600", { payload: { body: "b".repeat(10_600) } }, "appended"],
    [
      "a body at 10,601",
      { payload: { body: "b".repeat(10_601) } },
      "InvalidEvent",
    ],
    [
      "a body with a control character",
      { payload: { body: "a\u0001b" } },
      "InvalidEvent",
    ],
    // The section the comment is about, by its key; absent for the whole unit.
    [
      "a section key",
      { payload: { body: "A note.", section: "a".repeat(64) } },
      "appended",
    ],
    [
      "a section key in upper case",
      { payload: { body: "A note.", section: "A".repeat(64) } },
      "InvalidEvent",
    ],
    [
      "a section key one hex short",
      { payload: { body: "A note.", section: "a".repeat(63) } },
      "InvalidEvent",
    ],
    [
      "a section that is not a key",
      { payload: { body: "A note.", section: "src/a.ts" } },
      "InvalidEvent",
    ],
    [
      "a null section",
      { payload: { body: "A note.", section: null } },
      "InvalidEvent",
    ],
  ];
  for (const [name, patch, expected] of cases)
    expect({ name, outcome: await outcome(vary(comment, patch)) }).toEqual({
      name,
      outcome: expected,
    });

  // Every length at its bound, at its most bytes: the body and the summary in 3-byte characters,
  // the anchor's path in control characters (6 bytes each), the section's key, 32 citations at
  // their longest, the longest finding. Measured at 64,776 bytes of the 65,536 cap; the section
  // takes 77 of them; without the summary and with the body at 11,000 it was 64,986, and the
  // summary alone takes 913.
  const largest = vary(comment, {
    payload: {
      body: "語".repeat(10_600),
      anchor: {
        path: "\u0001".repeat(4_096),
        side: "new",
        startLine: Number.MAX_SAFE_INTEGER,
        endLine: Number.MAX_SAFE_INTEGER,
      },
      section: "f".repeat(64),
      finding: {
        kind: "impact",
        about: "proof",
        effect: "narrowed",
        summary: "語".repeat(300),
        evidence: Array.from({ length: 32 }, () => ({
          ref: `computation:${"c".repeat(64)}`,
          entry: "e".repeat(128),
        })),
      },
    },
  });
  expect(bytesOf(largest.payload)).toBe(64_776);
  expect(bytesOf(largest.payload)).toBeLessThanOrEqual(PAYLOAD_MAX_BYTES);
  expect(await outcome(largest)).toBe("appended");
});

test("the unit sections write schema refuses a repeated section key", async () => {
  const fixture = newShapeReview();
  const blob = JSON.parse(
    fixture.blobs.find((b) => b.label === "sections:Large file")!.text,
  ) as { sections: Array<Record<string, unknown>> };
  expect(UnitSections.safeParse(blob).success).toBe(true);
  const repeated = {
    sections: [
      blob.sections[0]!,
      { ...blob.sections[1]!, key: blob.sections[0]!["key"] },
    ],
  };
  expect(UnitSections.safeParse(repeated).success).toBe(false);
});

// Why: a section's own content and the side its lines are on are what the desk reads from the
// blob, so the write schema holds them to their one shape: the assembled unit's section content,
// and a side of new, old or none, where none has no lines.
test("the unit sections write schema holds a section's content and side to their shapes", async () => {
  const fixture = newShapeReview();
  const blob = JSON.parse(
    fixture.blobs.find((b) => b.label === "sections:Large file")!.text,
  ) as { sections: Array<Record<string, unknown>> };
  const [withContent, withoutContent] = blob.sections as [
    Record<string, unknown> & {
      parts: Record<string, unknown>;
      content: Record<string, unknown>;
    },
    Record<string, unknown> & { parts: Record<string, unknown> },
  ];
  const decodes = (section: Record<string, unknown>) =>
    UnitSections.safeParse({ sections: [section] }).success;
  const cases: ReadonlyArray<
    readonly [string, Record<string, unknown>, boolean]
  > = [
    ["content in its shape", withContent, true],
    ["no content", withoutContent, true],
    ["no side, as written before it", withoutContent, true],
    [
      "a key content does not have",
      { ...withContent, content: { ...withContent.content, extra: 1 } },
      false,
    ],
    [
      "content without its facts",
      { ...withContent, content: { briefed: null, explained: null } },
      false,
    ],
    [
      "side old",
      { ...withContent, parts: { ...withContent.parts, side: "old" } },
      true,
    ],
    [
      "a side that is not one",
      { ...withContent, parts: { ...withContent.parts, side: "both" } },
      false,
    ],
    [
      "side none with no span",
      {
        ...withContent,
        parts: { ...withContent.parts, side: "none" },
        where: null,
      },
      true,
    ],
    [
      "side none with lines",
      { ...withContent, parts: { ...withContent.parts, side: "none" } },
      false,
    ],
  ];
  expect("side" in withoutContent.parts).toBe(false);
  for (const [name, section, expected] of cases)
    expect({ name, decodes: decodes(section) }).toEqual({
      name,
      decodes: expected,
    });
});

test("lineage refuses a repeated earlier unit, an unchanged relation with changed sections, and a misattributed record", async () => {
  const { fixture, outcome } = await setup();
  const lineage = fixture.events.lineage as Envelope;
  const successor = fixture.units.large;
  const cycleId = fixture.cycleId;
  const entry = (patch: Record<string, unknown> = {}) => ({
    unitId: mintUlid(),
    cycleId: mintUlid(),
    relation: "changed",
    unchanged: 1,
    changed: 1,
    lane: "agentic",
    ...patch,
  });
  const record = (
    from: ReadonlyArray<Record<string, unknown>>,
    unitIds?: ReadonlyArray<string>,
  ) => ({
    attribution: {
      cycleId,
      unitIds: unitIds ?? [successor, ...from.map((e) => e.unitId as string)],
    },
    payload: { from },
  });
  const repeated = entry();
  const sixtyFour = Array.from({ length: 64 }, () => entry());
  const cases: ReadonlyArray<
    readonly [string, Record<string, unknown>, string]
  > = [
    ["one earlier unit", record([entry()]), "appended"],
    [
      "an earlier unit with no lane",
      record([entry({ lane: null })]),
      "appended",
    ],
    ["no lane given", record([entry({ lane: undefined })]), "InvalidEvent"],
    [
      "unchanged with no changed section",
      record([entry({ relation: "unchanged", unchanged: 2, changed: 0 })]),
      "appended",
    ],
    [
      "unchanged with a changed section",
      record([entry({ relation: "unchanged" })]),
      "InvalidEvent",
    ],
    [
      "no section counted",
      record([entry({ unchanged: 0, changed: 0 })]),
      "InvalidEvent",
    ],
    [
      "a repeated earlier unit",
      record(
        [repeated, { ...repeated, cycleId: mintUlid() }],
        [successor, repeated.unitId as string, mintUlid()],
      ),
      "InvalidEvent",
    ],
    ["64 earlier units", record(sixtyFour), "appended"],
    ["65 earlier units", record([...sixtyFour, entry()]), "InvalidEvent"],
    ["no earlier unit", record([], [successor, mintUlid()]), "InvalidEvent"],
    [
      "two earlier units, attributed in order",
      record([entry(), entry()]),
      "appended",
    ],
    [
      "attributed without the successor first",
      (() => {
        const from = [entry()];
        return record(from, [from[0]!.unitId as string, successor]);
      })(),
      "InvalidEvent",
    ],
    [
      "superseding another record",
      { causation: { supersedes: mintUlid() } },
      "InvalidEvent",
    ],
  ];
  for (const [name, patch, expected] of cases)
    expect({ name, outcome: await outcome(vary(lineage, patch)) }).toEqual({
      name,
      outcome: expected,
    });
});

test("packet version 2 decodes at its bounds, refuses past them, and fits the payload cap at every bound", async () => {
  const { fixture, outcome } = await setup();
  const packet = fixture.events.second as Envelope;
  const payload = payloadOf(packet);
  const cases: ReadonlyArray<
    readonly [string, Record<string, unknown>, string]
  > = [
    ["ordinal 1", { payload: { ...payload, ordinal: 1 } }, "appended"],
    ["ordinal 0", { payload: { ...payload, ordinal: 0 } }, "InvalidEvent"],
    [
      "a negative count",
      {
        payload: {
          ...payload,
          counts: { ...(payload["counts"] as object), units: -1 },
        },
      },
      "InvalidEvent",
    ],
    [
      "no pending counts",
      {
        payload: {
          ...payload,
          counts: { ...(payload["counts"] as object), pending: undefined },
        },
      },
      "InvalidEvent",
    ],
    [
      "a version 1 packet's counts alone",
      {
        payload: {
          complete: true,
          counts: {
            batches: 1,
            units: 1,
            contextReferences: 0,
            assessments: 1,
            deliveries: 0,
            dispositions: 0,
            comments: 0,
            gaps: 0,
          },
        },
      },
      "InvalidEvent",
    ],
    [
      "a cause counted zero in what was added",
      {
        payload: {
          ...payload,
          added: { ...(payload["added"] as object), undecided: { failed: 0 } },
        },
      },
      "InvalidEvent",
    ],
    // Round 2: counts that contradict each other are refused, as the assessment's are.
    [
      "more sections undecided than the review holds",
      {
        payload: {
          ...payload,
          counts: {
            ...(payload["counts"] as object),
            undecided: { failed: 2, unsure: 2 },
          },
        },
      },
      "InvalidEvent",
    ],
    [
      "more units added than the review holds",
      {
        payload: {
          ...payload,
          added: { ...(payload["added"] as object), units: 3 },
        },
      },
      "InvalidEvent",
    ],
    [
      "an added cause the review does not count",
      {
        payload: {
          ...payload,
          added: { ...(payload["added"] as object), undecided: { unsure: 1 } },
        },
      },
      "InvalidEvent",
    ],
    [
      "more of a cause added than the review counts",
      {
        payload: {
          ...payload,
          added: { ...(payload["added"] as object), undecided: { failed: 2 } },
        },
      },
      "InvalidEvent",
    ],
    [
      "more sections undecided in what was added than were added",
      {
        payload: {
          ...payload,
          counts: { ...(payload["counts"] as object), sections: 1 },
          added: {
            ...(payload["added"] as object),
            sections: 0,
            undecided: { failed: 1 },
          },
        },
      },
      "InvalidEvent",
    ],
    [
      "as many sections added as are undecided in what was added",
      {
        payload: {
          ...payload,
          counts: { ...(payload["counts"] as object), sections: 1 },
          added: {
            ...(payload["added"] as object),
            sections: 1,
            undecided: { failed: 1 },
          },
        },
      },
      "appended",
    ],
    [
      "a complete review with a batch still being judged",
      {
        payload: {
          ...payload,
          counts: {
            ...(payload["counts"] as object),
            pending: { batches: 1, sections: 0 },
          },
        },
      },
      "InvalidEvent",
    ],
    [
      "an incomplete review with a batch still being judged",
      {
        payload: {
          ...payload,
          complete: false,
          counts: {
            ...(payload["counts"] as object),
            pending: { batches: 1, sections: 2 },
          },
        },
      },
      "appended",
    ],
  ];
  for (const [name, patch, expected] of cases)
    expect({
      name,
      outcome: await outcome(vary(packet, { causation: undefined, ...patch })),
    }).toEqual({ name, outcome: expected });

  const max = Number.MAX_SAFE_INTEGER;
  // As large as each cause can be while all 16 sum to no more than the sections counted.
  const causes = Object.fromEntries(
    Array.from({ length: 16 }, (_, index) => [
      `c${String(index).padStart(2, "0")}${"x".repeat(29)}`,
      Math.floor(max / 16),
    ]),
  );
  const largest = vary(packet, {
    causation: undefined,
    payload: {
      complete: false,
      ordinal: max,
      counts: {
        batches: max,
        units: max,
        sections: max,
        contextReferences: max,
        assessments: max,
        deliveries: max,
        dispositions: max,
        comments: max,
        gaps: max,
        pending: { batches: max, sections: max },
        undecided: causes,
      },
      added: { batches: max, units: max, sections: max, undecided: causes },
    },
  });
  expect(bytesOf(largest.payload)).toBeLessThanOrEqual(PAYLOAD_MAX_BYTES);
  expect(await outcome(largest)).toBe("appended");
  const seventeen = vary(packet, {
    causation: undefined,
    payload: {
      ...(largest.payload as object),
      counts: {
        ...(largest.payload as { counts: object }).counts,
        undecided: { ...causes, extra: 1 },
      },
    },
  });
  expect(await outcome(seventeen)).toBe("InvalidEvent");
});
