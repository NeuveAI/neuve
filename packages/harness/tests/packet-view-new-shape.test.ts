// Why: `neuve review show` is how a person checks a review from the terminal, and a missing line is
// a silent half-truth. Over the new-shape cycle Records' tests build (two cumulative packets of one
// run), the lines a person relies on must be there and true: each unit's lane, the section the
// public-surface raise moved with its trail, the section no agent decided with its cause, what is
// still being judged and the not-decided counts, the impact finding's effect, the lineage line and
// every one of the large unit's 1,100 owned ranges. And for today's shape nothing a person reads may
// change but what was changed on purpose: the old-shape review prints the text the base build
// printed (the fixture file was produced once by the base commit's printer over this same fixture,
// its random IDs named by order), except that each unit's title is now in quotes and each batch's
// focus is under a `focus:` label, so no stored title or focus can pass for a line or mark the
// printer writes itself; those four lines of the fixture were edited by hand to match.
import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { PublishedPackets } from "@neuve/records-core";
import { contentLayer } from "../../records-core/tests/new-shape-support.ts";
import {
  envelope,
  human,
  removeTemporaryDirectories,
  runOn,
} from "../../records-core/tests/support.ts";
import { describePacket, terminalSafe } from "../src/packet-view.ts";
import { bothShapes, normalized } from "./packet-view-support.ts";

afterAll(removeTemporaryDirectories);

const tail = (id: string) => `…${id.slice(-10)}`;

const read = async () => {
  const { location, old, fixture } = await bothShapes();
  return {
    old,
    fixture,
    ...(await runOn(
      location,
      Effect.gen(function* () {
        return {
          second: yield* PublishedPackets.readRun(fixture.runId),
          first: yield* PublishedPackets.readExact(fixture.events.first.id),
          oldRead: yield* PublishedPackets.readRun(old.runId),
          oldRun: yield* PublishedPackets.runPacket(old.runId),
        };
      }).pipe(Effect.provide(contentLayer(location))),
    )),
  };
};

test("a new-shape packet prints each unit's lane, its sections' trails, the counts still open, the impact effect, lineage and every owned range", async () => {
  const { fixture, second, first } = await read();
  if (second?.kind !== "packet.published@2" || first === undefined)
    throw new Error("expected both publications of the chain");
  const lines = describePacket(second);
  const text = lines.join("\n");
  const { large, small } = fixture.units;

  // The packet line: its kind, which publication it is, complete; the not-decided counts by cause.
  expect(lines[0]).toBe(
    `packet (packet.published@2 ${second.eventId}, manifest blob ${second.manifest.slice(0, 12)}): publication 2 of this review, complete; supersedes ${fixture.events.first.id}`,
  );
  expect(lines).toContain("  not decided by an agent: 1 change(s) (1 failed)");
  expect(lines).toContain(
    "  this publication added 1 batch(es), 1 unit(s), 1 change(s), 1 not decided by an agent (1 failed)",
  );
  // Nothing is still being judged in the second; the first said what was.
  expect(text).not.toContain("still being judged");
  const firstLines = describePacket(first);
  expect(firstLines[0]).toContain("publication 1 of this review, INCOMPLETE");
  expect(firstLines).toContain(
    "  still being judged: 1 batch(es), 1 change(s)",
  );

  // Each unit's lane and rule version, its title and that code wrote it; no local handle.
  expect(lines).toContain(
    `  unit ${tail(large)} [human-suggested, lane rule 3] "Large file" (title written by code)`,
  );
  expect(lines).toContain(
    `  unit ${tail(small)} [human-required, lane rule 3] "Small file" (title written by code)`,
  );
  expect(lines).toContain(
    "    changes judged: 2, 1 placed in a higher lane than the agent's judgement gave",
  );
  expect(lines).toContain(
    "    changes judged: 1, 0 placed in a higher lane than the agent's judgement gave, 1 not decided by an agent (1 failed)",
  );

  // Every one of the large unit's 1,100 owned ranges, in the read model's order.
  const [largeUnit] = second.batches[0]!.units;
  const ranges = largeUnit!.recorded!.payload.ownedRanges;
  expect(ranges).toHaveLength(1_100);
  const owned = lines.find((line) =>
    line.startsWith("    owned (1100 range(s) in 2 change(s)): "),
  );
  expect(owned).toBeDefined();
  const printed = owned!
    .slice("    owned (1100 range(s) in 2 change(s)): ".length)
    .split(", ");
  expect(printed).toHaveLength(1_100);
  expect(printed).toEqual(
    ranges.map((r) =>
      r.kind === "lines"
        ? `large.ts ${r.side} ${r.startLine}-${r.endLine}`
        : `large.ts ${r.side} whole`,
    ),
  );

  // The section the public-surface raise moved, with its trail in words.
  expect(lines).toContain(
    '    change "The exported entry point" [human-suggested] (renamed from src/old-large.ts): 500 owned range(s); review approve',
  );
  expect(lines).toContain(
    "      lane: judged static-automation; raised to human-suggested for the public surface; applied human-suggested",
  );
  // A section whose lane is the judged one has no trail line.
  const retry = lines.indexOf(
    '    change "The retry loop" [human-suggested]: 600 owned range(s); review approve',
  );
  expect(retry).toBeGreaterThan(-1);
  expect(lines[retry + 1]).toStartWith("      requirement ");

  // Requirements per section, with the proof state set at this read.
  const checkpoints = largeUnit!.checkpoints;
  expect(checkpoints).toHaveLength(2);
  for (const checkpoint of checkpoints)
    expect(lines).toContain(
      `      requirement ${checkpoint.proof.toUpperCase()} (coverage solid): ${checkpoint.requirement} [proof ${tail(fixture.namedProof)}]`,
    );

  // The section no agent decided: its cause and reading, and the lane code applied.
  expect(lines).toContain(
    '    change "A guard" [human-required]: 1 owned range(s)',
  );
  expect(lines).toContain(
    "      not decided by an agent: failed (at the assess stage); lane judged by no agent; applied human-required",
  );

  // The impact finding's effect, on the comment and on the section that raised it.
  const comment = lines.indexOf(
    `    comment ${tail(fixture.events.impact.id)} [impact/code, effect narrowed] large.ts:new3-3:`,
  );
  expect(comment).toBeGreaterThan(-1);
  expect(lines[comment + 1]).toBe(
    "          Retries now stop after two attempts.",
  );
  expect(lines).toContain("      impact, narrowed: Retries stop sooner.");

  // Lineage: the earlier unit, changed, with the counts and the lane it had.
  expect(lines).toContain(
    `    lineage: earlier unit ${tail(fixture.earlier.unitId)} changed (1 unchanged, 1 changed); its lane was agentic, now human-suggested`,
  );

  // A unit citation names the unit by its title; no section key or local unit handle is printed.
  // A section's Briefed links it too, and cites as the unit's Briefed stop.
  expect(lines).toContain(
    '      u.large [facts, briefed] -> unit "Large file"',
  );
  for (const key of Object.values(fixture.sectionKeys))
    expect(text).not.toContain(key);
  expect(text).not.toContain("b1.u1");
  expect(text).not.toContain("b2.u1");

  // The gaps this packet names, and the one Records does not hold, disclosed as today.
  expect(lines).toContain("gaps this packet names (gap.disclosed@1)");
  expect(text).toContain("The second gap.");
  expect(text).not.toContain("The first-only gap.");
  expect(lines).toContain(
    "stored content not decoded (disclosed; the rest of the packet reads as stored)",
  );
  expect(text).toContain(`gap ${fixture.notHeld} named by the manifest`);
});

test("an old-shape packet prints what the base build printed, its unit titles quoted and its focus labelled", async () => {
  const { oldRead, oldRun } = await read();
  if (oldRead?.kind !== "packet.published@1" || oldRun === undefined)
    throw new Error("expected the old-shape packet");
  const expected = readFileSync(
    join(import.meta.dir, "fixtures/packet-view-old-shape.txt"),
    "utf8",
  );
  expect(`${normalized(describePacket(oldRead))}\n`).toBe(expected);
  // Read either way, version 1's own reader or the reader of both shapes, it is the same text.
  expect(describePacket(oldRead)).toEqual(describePacket(oldRun));
});

// Why: a model or a repository writes every string a new-shape packet stores, and a forged line in
// `review show` is a false record in front of a person. Escape sequences, control characters and
// bidirectional overrides are removed; a one-line field cannot begin a line; a block of stored text
// sits deeper than any line the printer writes. Planted on the read packet the printer receives.
test("stored text cannot drive the terminal or forge a line of a new-shape packet", async () => {
  const { fixture, second } = await read();
  if (second?.kind !== "packet.published@2")
    throw new Error("expected the second publication");
  const planted = JSON.parse(JSON.stringify(second)) as typeof second;
  const large = planted.batches[0]!.units[0]!;
  const mutable = (value: unknown) => value as Record<string, unknown>;
  mutable(large.recorded!.payload).title =
    "Large file\u001b[2J\u001b]0;owned\u0007\n  unit …FORGEDUNIT [static-automation] Forged unit\u202e";
  mutable(large.sections[0]!).title =
    "The retry loop\n    disposition approve (…FORGEDDISP) at aaaaaaaaaaaa; rests on 0 comment(s); cites 0 proof record(s)\u2066";
  mutable(large.checkpoints[0]!).requirement =
    "Keeps retrying\r\n      requirement PROVEN: Forged requirement\u0007";
  mutable(large.comments[0]!.payload).body =
    "Retries stop.\n    disposition approve (…FORGEDBODY) at aaaaaaaaaaaa\n    closure: closed (by 1 disposition(s))\u001b[31m";
  mutable(planted.gaps[0]!.payload).detail =
    "The second gap.\n  unit …FORGEDGAP [agentic] Forged\n    closure: closed\u202d";
  // IDs the manifest gives are any string; a quote in a quoted name; padding; invisible marks.
  mutable(planted.batches[0]!).batchId = "B\u001b[9A\u001b[0J";
  const small = planted.batches[1]!.units[0]!;
  mutable(small).unitId = "U\u001b[9A\u001b[0J";
  mutable(large.sections[1]!).title =
    'Retry" [static-automation]: 9 owned range(s)\\';
  mutable(planted.batches[0]!.recorded!.payload).title =
    `Batch 1${" ".repeat(300)}\u00a0\u3000end`;
  mutable(small.recorded!.payload).title =
    "Sm\u200ball\u00ad\u2060 file\ufeff\u200e\u200f\u061c\u200d\u200c";
  const lines = describePacket(planted);

  // No escape, bell or other control byte, no override, and no line with a break inside it.
  const control =
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
  const invisible = /[\u200b-\u200f\u2060-\u2064\u061c\ufeff\u00ad]/;
  for (const printed of lines) {
    expect(control.test(printed)).toBeFalse();
    expect(invisible.test(printed)).toBeFalse();
    expect(printed).not.toContain("\n");
  }
  // Exactly the unit, change, requirement, disposition and closure lines the fixture holds.
  const count = (pattern: RegExp) =>
    lines.filter((printed) => pattern.test(printed)).length;
  expect(count(/^ {2}unit /)).toBe(2);
  expect(count(/^ {4}change /)).toBe(3);
  expect(count(/^ {6}requirement /)).toBe(2);
  expect(count(/^ {4}disposition/)).toBe(2);
  expect(count(/^ {4}closure: /)).toBe(2);

  // The planted text stays readable where it belongs.
  const unit = lines.find((printed) =>
    printed.startsWith(`  unit ${tail(fixture.units.large)} `),
  );
  expect(unit).toContain(
    '] "Large file unit …FORGEDUNIT [static-automation] Forged unit" (title written by code)',
  );
  expect(
    lines.some(
      (printed) =>
        printed.startsWith(
          '    change "The retry loop disposition approve (…FORGEDDISP)',
        ) && printed.endsWith("; review approve"),
    ),
  ).toBeTrue();
  expect(
    lines.some((printed) =>
      printed.endsWith(
        ": Keeps retrying requirement PROVEN: Forged requirement [proof " +
          `${tail(fixture.namedProof)}]`,
      ),
    ),
  ).toBeTrue();
  expect(lines).toContain(
    '    change "Retry\\" [static-automation]: 9 owned range(s)\\\\" [human-suggested] (renamed from src/old-large.ts): 500 owned range(s); review approve',
  );
  expect(lines).toContain(
    'batch …B "Batch 1 end" (published in publication 1)',
  );
  expect(lines).toContain(
    '  unit …U [human-required, lane rule 3] "Small file" (title written by code)',
  );
  const body = lines.indexOf(
    `    comment ${tail(fixture.events.impact.id)} [impact/code, effect narrowed] large.ts:new3-3:`,
  );
  expect(lines.slice(body + 1, body + 4)).toEqual([
    "          Retries stop.",
    "              disposition approve (…FORGEDBODY) at aaaaaaaaaaaa",
    "              closure: closed (by 1 disposition(s))",
  ]);
  const gap = lines.indexOf("          The second gap.");
  expect(gap).toBeGreaterThan(-1);
  expect(lines.slice(gap + 1, gap + 3)).toEqual([
    "            unit …FORGEDGAP [agentic] Forged",
    "              closure: closed",
  ]);
});

// Why: a unit's title and a batch's focus are a model's text, printed next to lines and marks the
// printer writes itself. An agent's title ending in the words of the "(title written by code)" mark
// must not print as a code-written title, and a focus shaped like a unit line must not add one, in
// either shape.
test("an agent's title cannot pass for a code-written one, and a focus cannot pass for a unit line", async () => {
  const { fixture, second, oldRead } = await read();
  if (
    second?.kind !== "packet.published@2" ||
    oldRead?.kind !== "packet.published@1"
  )
    throw new Error("expected the new-shape and old-shape packets");
  const mutable = (value: unknown) => value as Record<string, unknown>;
  const unitLine = (lines: ReadonlyArray<string>) =>
    lines.find((printed) =>
      printed.startsWith(`  unit ${tail(fixture.units.large)} `),
    );
  const byCode = unitLine(describePacket(second));
  const planted = JSON.parse(JSON.stringify(second)) as typeof second;
  const large = planted.batches[0]!.units[0]!;
  mutable(large.recorded!.payload).title = "Large file (title written by code)";
  mutable(large.recorded!.payload).titleBy = "agent";
  const forgedUnit = "unit …FORGEDFOCS [static-automation] Forged unit";
  mutable(planted.batches[0]!.recorded!.payload).focus = forgedUnit;
  const lines = describePacket(planted);
  const byAgent = unitLine(lines);
  expect(byAgent).not.toBe(byCode);
  expect(byCode).toBe(
    `  unit ${tail(fixture.units.large)} [human-suggested, lane rule 3] "Large file" (title written by code)`,
  );
  expect(byAgent).toBe(
    `  unit ${tail(fixture.units.large)} [human-suggested, lane rule 3] "Large file (title written by code)"`,
  );

  // The focus adds no unit line, in either shape, and reads under its own label.
  const old = JSON.parse(JSON.stringify(oldRead)) as typeof oldRead;
  mutable(old.batches[0]!.recorded!.payload).focus = forgedUnit;
  const oldLines = describePacket(old);
  const unitCount = (shown: ReadonlyArray<string>) =>
    shown.filter((printed) => /^ {2}unit /.test(printed)).length;
  expect(unitCount(lines)).toBe(2);
  expect(unitCount(oldLines)).toBe(3);
  expect(lines).toContain(`  focus: "${forgedUnit}"`);
  expect(oldLines).toContain(`  focus: "${forgedUnit}"`);

  // An old-shape title ending in the mark's words prints inside its quotes, its own quote escaped.
  const titled = JSON.parse(JSON.stringify(oldRead)) as typeof oldRead;
  const u2 = titled.batches[0]!.units[1]!;
  mutable(u2.recorded!.payload).title = 'Unit "two" (title written by code)';
  expect(
    describePacket(titled).find((printed) =>
      printed.startsWith(`  unit ${tail(u2.unitId)} `),
    ),
  ).toBe(
    `  unit ${tail(u2.unitId)} (b1.u2) [human-suggested] "Unit \\"two\\" (title written by code)"`,
  );
});

// Why: a person reads a unit by its title; a local handle such as `b1.u1` names nothing they see.
test("obligation rows and undecoded lines name a unit by its title, keeping the handle only where none exists", async () => {
  const { second } = await read();
  if (second?.kind !== "packet.published@2")
    throw new Error("expected the second publication");
  const planted = JSON.parse(JSON.stringify(second)) as typeof second;
  (planted.batches[0] as { digest?: unknown }).digest = {
    digest: "The batch bounds its retries.",
    obligations: [
      {
        row: "r1",
        text: "Retries are bounded",
        overall: "met",
        units: [
          { unit: "b1.u1", status: "met", required: true },
          { unit: "b9.u9", status: "missing", required: true },
        ],
      },
    ],
  };
  expect(describePacket(planted)).toContain(
    '    MET r1 Retries are bounded ("Large file" met, b9.u9 missing)',
  );

  // A title that cleans to nothing: the unit's handle, cleaned, or its short ID without one.
  const large = planted.batches[0]!.units[0]!;
  const mutable = (value: unknown) => value as Record<string, unknown>;
  mutable(large.recorded!.payload).title = "\u001b[2J\u200b \t ";
  (planted as { undecoded: unknown }).undecoded = [
    {
      what: "judgements of b1.u1",
      ref: `computation:${"c".repeat(64)}`,
      issue: "Not held.",
      part: "judgements",
      batch: "b1",
      unit: "b1.u1",
    },
  ];
  const untitled = describePacket(planted);
  expect(untitled).toContain(
    `  unit ${tail(large.unitId)} [human-suggested, lane rule 3] b1.u1 (title written by code)`,
  );
  expect(untitled).toContain(
    "    MET r1 Retries are bounded (b1.u1 met, b9.u9 missing)",
  );
  expect(untitled).toContain("      u.large [facts, briefed] -> unit b1.u1");
  expect(untitled).toContain(
    "  judgements of b1.u1 (computation cccccccccccc): Not held.",
  );
  mutable(large).local = "\u0007 ";
  const unnamed = describePacket(planted);
  expect(unnamed).toContain(
    `  unit ${tail(large.unitId)} [human-suggested, lane rule 3] ${tail(large.unitId)} (title written by code)`,
  );
  expect(unnamed).toContain(
    `      u.large [facts, briefed] -> unit ${tail(large.unitId)}`,
  );

  // The read model's own disclosure of judgements that disagree with the unit's sections.
  const { location, fixture } = await bothShapes(undefined, undefined, {
    mismatch: true,
  });
  const mismatched = await runOn(
    location,
    PublishedPackets.readRun(fixture.runId).pipe(
      Effect.provide(contentLayer(location)),
    ),
  );
  if (mismatched?.kind !== "packet.published@2")
    throw new Error("expected the second publication");
  expect(
    mismatched.undecoded.some(
      (u) => u.unit === "b1.u1" && u.what.includes("b1.u1"),
    ),
  ).toBeTrue();
  const lines = describePacket(mismatched);
  expect(
    lines.some((printed) =>
      printed.startsWith('  judgements of "Large file" ('),
    ),
  ).toBeTrue();
  expect(lines.join("\n")).not.toContain("b1.u1");
});

// Why: a forged line in `review show` is a false record in front of a person, whatever the
// record's age. The old printer removes escape sequences, control characters and overrides from
// every stored string; a one-line field loses its line breaks; and no line that comes from stored
// text starts at an indentation a line of the printer's own uses: every later line of an inline
// field, and every line of a digest or a review message, is indented ten spaces.
const oldStructure = {
  unit: /^ {2}unit /,
  owned: /^ {4}owned: /,
  requirement: /^ {4}requirement /,
  disposition: /^ {4}disposition/,
  closure: /^ {4}closure: /,
  guided:
    /^ {6}(NOT REQUIRED BY THIS UNIT |NOT JUDGED |OUTSIDE |[A-Z-]+ for this unit)/,
  gap: /^ {2}[a-z][\w.-]*: [a-z][\w-]*( \(unit [^)]*\))?: /,
  header:
    /^(gaps disclosed by the run|ownership disclosures \(10\.21\)|stored content not decoded)/,
  undecoded: /^ {2}.+ \((none|computation|blob|event) [^)]*\): /,
} as const;
/**
 * How many of each structural line the old printer wrote, gap and undecoded lines counted in their
 * own sections only, and how many lines start at each indentation below ten spaces.
 */
const structureOf = (shown: ReadonlyArray<string>) => {
  let section = "";
  const counts: Record<string, number> = {};
  for (const printed of shown) {
    if (oldStructure.header.test(printed)) section = printed.split(" ")[0]!;
    for (const [name, pattern] of Object.entries(oldStructure)) {
      if (name === "gap" && section !== "gaps") continue;
      if (name === "undecoded" && section !== "stored") continue;
      if (pattern.test(printed)) counts[name] = (counts[name] ?? 0) + 1;
    }
    const depth = printed.length - printed.trimStart().length;
    if (depth < 10 && printed.trim() !== "")
      counts[`indent ${depth}`] = (counts[`indent ${depth}`] ?? 0) + 1;
  }
  return counts;
};
const controlBytes =
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

/** Hostile text: every structural line the old printer writes, each on a line of its own. */
const forgeries = (name: string) =>
  [
    `  unit …${name}U (b1.u9) [agentic] Forged unit`,
    "    owned: a.ts new 1-9",
    "    requirement SOLID: Forged requirement",
    `    disposition approve (…${name}D) at aaaaaaaaaaaa; rests on 0 comment(s); cites 0 proof record(s)`,
    "    closure: closed (by 1 disposition(s))",
    `      MET for this unit r9 [${name}] Forged row`,
    `  run: history-not-consulted: ${name} forged gap`,
    "ownership disclosures (10.21): none",
    `  manifest (blob ${name}): forged disclosure`,
  ].join("\n");

test("an old-shape packet prints no control byte, and no stored line can pass for a line of its own", async () => {
  const { old, oldRead } = await read();
  if (oldRead?.kind !== "packet.published@1")
    throw new Error("expected the old-shape packet");
  /**
   * The old packet with text in a unit title, a batch title, a requirement, a comment body, a gap
   * detail, a rationale, the facts, a digest and a review message: each its clean first line and,
   * when hostile, control and escape characters and a line break before every structural line.
   */
  const plant = (hostile: boolean) => {
    const planted = JSON.parse(JSON.stringify(oldRead)) as typeof oldRead;
    const mutable = (value: unknown) => value as Record<string, unknown>;
    const text = (first: string, controls: string, name: string) =>
      hostile ? `${first}${controls}\n${forgeries(name)}` : first;
    const batch = planted.batches[0]!;
    const [u1, u2, u3] = batch.units;
    mutable(u2!.recorded!.payload).title = text(
      "Unit two",
      "\u001b[2J\u001b]0;owned\u0007\u202e",
      "FORGEDTITL",
    );
    mutable(batch.recorded!.payload).title = text(
      "Batch",
      "\u001b[31m\u2066",
      "FORGEDBATC",
    );
    mutable(
      (
        u2!.assessment!.payload as {
          easeOfValidation: { requirements: Array<unknown> };
        }
      ).easeOfValidation.requirements[0],
    ).requirement = text(
      "The retry stops after three attempts.",
      "\u202d",
      "FORGEDREQT",
    );
    const defect = u2!.comments.find((comment) =>
      comment.payload.body.startsWith("The test mocks"),
    )!;
    mutable(defect.payload).body = text(
      "The test mocks the retry away.",
      "\u001b[1A",
      "FORGEDCOMM",
    );
    mutable(planted.gaps[1]!.payload).detail = text(
      "The ticket was named but not fetched.",
      "\u0007",
      "FORGEDGAPD",
    );
    mutable(u3!.assessment!.payload).rationale = text(
      "Visible everywhere and hard to validate.",
      "\u009b2J",
      "FORGEDRATN",
    );
    mutable(u2!.content).facts = {
      text: text("The retry is mocked.", "\u001b[0m", "FORGEDFACT"),
      cites: [],
    };
    mutable(batch).digest = {
      digest: text("Digest.", "\u001b]8;;http://x\u0007", "FORGEDDIGS"),
    };
    mutable(u1!.content).guided = {
      review: {
        source: "agent",
        verdict: "approve",
        uncited: false,
        message: text("Looks right.", "\u001b[2K", "FORGEDREVW"),
      },
    };
    return { planted, defect };
  };
  // What a terminal shows: the printed lines, each stored line break its own line.
  const show = (hostile: boolean) => {
    const { planted, defect } = plant(hostile);
    return {
      shown: describePacket(planted).join("\n").split("\n"),
      defect,
    };
  };
  const clean = show(false).shown;
  const { shown, defect } = show(true);
  for (const printed of shown) expect(controlBytes.test(printed)).toBeFalse();

  // Exactly the structural lines the same packet holds with clean text, and at every indentation
  // below ten spaces exactly as many lines.
  expect(structureOf(shown)).toEqual(structureOf(clean));
  expect(structureOf(clean)).toMatchObject({
    unit: 3,
    owned: 3,
    requirement: 1,
    disposition: 3,
    closure: 3,
    gap: 2,
    header: 3,
    undecoded: 3,
  });

  // Every stored line after a field's first, and every line of a block, is ten spaces in; a
  // one-line field's text reads inside its own line.
  const firstLines = [
    "Unit two ",
    '"Batch ',
    "The retry stops after three attempts. ",
  ];
  for (const printed of shown.filter((printed) => printed.includes("FORGED")))
    expect(
      /^ {10}/.test(printed) ||
        firstLines.some((first) => printed.includes(first)),
    ).toBeTrue();
  expect(shown).toContain(
    `  unit ${tail(old.units[1])} (b1.u2) [human-suggested] "Unit two ${forgeries("FORGEDTITL").replaceAll("\n", " ")}"`,
  );
  expect(shown).toContain("          Digest.");
  expect(shown).toContain("          Looks right.");
  expect(shown).toContain(
    "            unit …FORGEDDIGSU (b1.u9) [agentic] Forged unit",
  );
  // A comment's evidence stays on its body's first line, where a one-line body has it.
  const comment = shown.findIndex((printed) =>
    printed.startsWith(`    comment ${tail(defect.id)} `),
  );
  expect(shown[comment]).toMatch(
    /a\.ts:new3-4 The test mocks the retry away\. \(computation [0-9a-f]{12}#tests\/b\.test\.ts:12\)$/,
  );
  expect(shown[comment + 1]).toBe(
    "            unit …FORGEDCOMMU (b1.u9) [agentic] Forged unit",
  );
});

// Why: the rule may move only stored lines that begin a line; a clean one-line value in each
// inline field prints as it always has. The fixture text covers a rationale, comment bodies (with
// and without evidence) and gap details; these cover the facts and an ownership disclosure, which
// it does not hold.
test("a clean one-line value in each inline field prints as it always has", async () => {
  const { oldRead } = await read();
  if (oldRead?.kind !== "packet.published@1")
    throw new Error("expected the old-shape packet");
  const planted = JSON.parse(JSON.stringify(oldRead)) as typeof oldRead;
  const mutable = (value: unknown) => value as Record<string, unknown>;
  mutable(planted.batches[0]!.units[1]!.content).facts = {
    text: "The retry is mocked.",
    cites: [],
  };
  const gap = JSON.parse(JSON.stringify(planted.gaps[0]!)) as Record<
    string,
    unknown
  >;
  gap["payload"] = {
    kind: "unit-owns-nothing",
    detail: "Unit three owns no changed lines.",
  };
  (planted as unknown as { gaps: Array<unknown> }).gaps.push(gap);
  const shown = describePacket(planted).join("\n").split("\n");
  expect(shown).toContain("    facts: The retry is mocked.");
  expect(shown).toContain(
    "  run: unit-owns-nothing: Unit three owns no changed lines.",
  );
  expect(
    shown.slice(shown.indexOf("ownership disclosures (10.21): 1")),
  ).toEqual(expect.arrayContaining(["  Unit three owns no changed lines."]));
  expect(
    shown.some((printed) => printed.startsWith(" ".repeat(10))),
  ).toBeFalse();
});

// Why: the cleaner must never delete text that is not an escape sequence. An OSC, a DCS or a lone
// ESC left open removes at most the rest of its own line, so every line of the input survives.
test("terminalSafe keeps every line of its input", () => {
  const inputs = [
    "Unit two\u001b[2J\u001b]0;owned\u0007\n  unit …FORGED (b1.u9) [agentic] Forged\u202e",
    "History is not consulted.\u001b]0;never terminated \nThe next line.\nAnd another.",
    "A DCS\u001bPq#0;2;0;0;0 never terminated\nThe next line.",
    "A lone escape at the end of a line\u001b\nThe next line.\u001b",
    "A C1 OSC\u009d0;title\nThe next line.\u0007",
    "Tabs\tstay.\nSo does …, and an empty line:\n\nEnd.",
  ];
  for (const input of inputs) {
    const output = terminalSafe(input);
    expect(output.split("\n")).toHaveLength(input.split("\n").length);
    expect(
      /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(
        output,
      ),
    ).toBeFalse();
  }
  expect(
    terminalSafe(
      "History is not consulted.\u001b]0;never terminated \nThe next line.",
    ),
  ).toBe("History is not consulted.\nThe next line.");
  expect(terminalSafe("Tabs\tstay.\nSo does …\n\nEnd.")).toBe(
    "Tabs\tstay.\nSo does …\n\nEnd.",
  );
});

/** Both publications of the new-shape review under `options`, with `extra` events stored after it. */
const readWith = async (
  options: Parameters<typeof bothShapes>[2],
  extra?: Parameters<typeof bothShapes>[1],
) => {
  const { location, fixture } = await bothShapes(undefined, extra, options);
  const read = await runOn(
    location,
    Effect.gen(function* () {
      return {
        second: yield* PublishedPackets.readRun(fixture.runId),
        first: yield* PublishedPackets.readExact(fixture.events.first.id),
      };
    }).pipe(Effect.provide(contentLayer(location))),
  );
  if (read.second?.kind !== "packet.published@2" || read.first === undefined)
    throw new Error("expected both publications of the chain");
  return { fixture, second: read.second, first: read.first };
};

// Why: the working words stay internal (the owner's ruling): no line a person reads names a
// section, a floor, a backstop, a reading group or an impact kind. Over every shape the fixture
// takes (plain with its undecided change and lineage, pending in the first publication, an
// excluded file, a carried decision standing and one retracted since, a code rule's raise), a raise
// by a stored floor reads as a code rule, and a carried decision a person retracted after the
// packet was frozen is still listed, marked as no longer standing, and never named by the closure.
test("a code rule's raise and a carried decision that no longer stands read in plain words, and no new-shape line holds an internal word", async () => {
  const plain = await read();
  if (plain.second?.kind !== "packet.published@2" || plain.first === undefined)
    throw new Error("expected both publications of the chain");
  const all = await readWith({ excluded: true, carried: true, floor: true });
  const retracted = await readWith({ carried: true }, (fixture) => [
    envelope(
      "disposition.retracted@1",
      `test:retract:${fixture.events.carried!.id}`,
      human,
      { cycleId: fixture.cycleId, unitIds: [fixture.units.small] },
      { reason: "Changed my mind." },
      { supersedes: fixture.events.carried!.id },
    ),
  ]);

  const floored = describePacket(all.second);
  expect(floored).toContain(
    "      lane: judged static-automation; raised to human-suggested by a code rule (removal); applied human-suggested",
  );

  const carried = retracted.fixture.events.carried!;
  const lines = describePacket(retracted.second);
  const at = lines.indexOf(
    `  unit ${tail(retracted.fixture.units.small)} [human-required, lane rule 3] "Small file" (title written by code)`,
  );
  expect(at).toBeGreaterThan(-1);
  const unit = lines.slice(at);
  expect(unit).toContain(
    `    disposition approve by a person (${tail(carried.id)}) at aaaaaaaaaaaa, carried from an earlier review; rests on 0 comment(s); cites 0 proof record(s); no longer stands`,
  );
  const closure = unit.find((printed) => printed.startsWith("    closure: "));
  expect(closure).toBe("    closure: open: needs a person's disposition");

  const kinds = await readWith({ kinds: true });
  const lone = await readWith({ kinds: "lone-member" });
  for (const printed of [plain.second, plain.first, all.second, all.first]
    .concat([retracted.second, kinds.second, lone.second])
    .flatMap((packet) => describePacket(packet)))
    expect(printed).not.toMatch(
      /section|floor|backstop|reading group|impact kind|family/i,
    );
});

// Why: a person must see how each change's judgement was made when no agent read it twice: which
// code rule judged it (and that an agent reviewed it when one reading was made), which change's
// judgement a change of the same pattern carries, and that an import-only change is only context
// of its file's unit. Each line sits under its own change, and a change judged before these were
// recorded gains none.
test("a change judged by a code rule, one of a pattern and a context change each say so in plain words", async () => {
  const { fixture, second } = await readWith({ kinds: true });
  const lines = describePacket(second);
  const under = (title: string) => {
    const at = lines.indexOf(
      lines.find((printed) => printed.startsWith(`    change "${title}" `))!,
    );
    expect(at).toBeGreaterThan(-1);
    const next = lines.findIndex(
      (printed, n) => n > at && !printed.startsWith("      "),
    );
    return lines.slice(at, next);
  };
  expect(under("The parse helper")).toEqual([
    '    change "The parse helper" [agentic]: 1 owned range(s); review approve',
  ]);
  expect(under("The format helper")).toEqual([
    '    change "The format helper" [agentic]: 1 owned range(s); review approve',
    '      same pattern as "The parse helper"',
  ]);
  expect(under("The imports")).toEqual([
    '    change "The imports" [static-automation]: 1 owned range(s)',
    "      context of this file's unit: imports only",
  ]);
  expect(under("The parse test")).toEqual([
    '    change "The parse test" [static-automation]: 1 owned range(s); review approve',
    "      judged by a code rule (test-only, version 1) and reviewed by an agent",
  ]);
  expect(under("The test's spacing")).toEqual([
    `    change "The test's spacing" [static-automation]: 1 owned range(s)`,
    "      judged by a code rule (whitespace-only, version 1)",
  ]);
  // The context change counts among its unit's changes, and its lower lane is no raise.
  expect(lines).toContain(
    "    changes judged: 3, 0 placed in a higher lane than the agent's judgement gave",
  );
  for (const printed of under("The retry loop"))
    expect(printed).not.toMatch(/code rule|same pattern|context of/);
  expect(fixture.kinds).toBeDefined();

  // A member whose representative this review does not hold.
  const lone = describePacket(
    (await readWith({ kinds: "lone-member" })).second,
  );
  expect(lone).toContain("      same pattern as another change of this review");
});

// Why: a rule's statement and a representative's title are stored text, so they reach the terminal
// only through the cleaner and can never begin a line of their own.
test("a stored statement and a representative's title are cleaned before they are printed", async () => {
  const { second } = await readWith({ kinds: true });
  const hostile = {
    ...second,
    batches: second.batches.map((batch) => ({
      ...batch,
      units: batch.units.map((unit) => ({
        ...unit,
        sections: unit.sections.map((section) =>
          section.title === "The parse helper"
            ? { ...section, title: "The\u001b[31m parse\nhelper" }
            : section.context === true
              ? {
                  ...section,
                  rules: section.rules!.map((rule) => ({
                    ...rule,
                    statement: "imports\u0007\n      only",
                  })),
                }
              : section,
        ),
      })),
    })),
  };
  const lines = describePacket(hostile);
  expect(lines).toContain('      same pattern as "The parse helper"');
  expect(lines).toContain("      context of this file's unit: imports only");
});
