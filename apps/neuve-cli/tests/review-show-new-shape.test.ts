// Why: two other lanes build readers against `reports/records-show-shape.md`, the JSON `neuve review
// show --run <id> --json` prints for a new-shape review, so every name it gives must be there with
// its type on a unit, a section and the packet. For today's shape the JSON may gain only
// `packet.kind`: the rest is version 1's reader's packet, byte for byte. And the recorded line says
// how many publications a run of the new shape made, while one packet reads as it always has.
// Scratch repository, scratch HOME and store, no model credentials, so no worker starts.
import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { Effect } from "effect";
import { Scope } from "@neuve/harness";
import {
  Blobs,
  Computations,
  PublishedPackets,
  mintUlid,
  resolveStoreLocation,
  sha256Hex,
} from "@neuve/records-core";
import { bothShapes } from "../../../packages/harness/tests/packet-view-support.ts";
import { contentLayer } from "../../../packages/records-core/tests/new-shape-support.ts";
import {
  receipt,
  type reviewEvents,
} from "../../../packages/records-core/tests/review-fixtures.ts";
import {
  agent,
  envelope,
  headOid,
  removeTemporaryDirectories,
  runOn,
} from "../../../packages/records-core/tests/support.ts";

import { followLine, showOutput, terminalGuard } from "../src/review-cli";
import { markSetUp } from "./fixtures/set-up.ts";

const CLI = resolve(import.meta.dir, "../src/cli.ts");

const directories: Array<string> = [];
// Three scratch repositories and stores on a slow disk can take longer than the default to delete.
afterAll(async () => {
  removeTemporaryDirectories();
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
}, 60_000);

/**
 * A scratch repository whose store holds both reviews, the new-shape run with its receipt;
 * `own` are `newShapeReview`'s options, such as `excluded` and `carried`.
 */
const scratch = async (
  plantOld?: (old: ReturnType<typeof reviewEvents>) => void,
  own: {
    readonly excluded?: boolean;
    readonly carried?: boolean;
    readonly floor?: boolean;
    readonly noFloorInputs?: boolean;
    readonly kinds?: true;
  } = {},
) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "neuve-show-")));
  directories.push(root);
  const repo = join(root, "repo");
  const home = join(root, "home");
  await mkdir(home);
  Bun.spawnSync(["git", "init", "-q", repo]);
  for (const [key, value] of [
    ["user.email", "dev@example.com"],
    ["user.name", "Dev"],
  ])
    Bun.spawnSync(["git", "-C", repo, "config", key!, value!]);
  for (const text of ["a\n", "b\n"]) {
    await writeFile(join(repo, "a"), text);
    Bun.spawnSync(["git", "-C", repo, "add", "a"]);
    Bun.spawnSync(["git", "-C", repo, "commit", "-qm", text.trim()]);
  }
  const location = await Effect.runPromise(resolveStoreLocation(repo));
  const shapes = await bothShapes(
    location,
    (fixture) => [
      envelope(
        "run.completed@1",
        `review:${fixture.runId}:run.completed`,
        agent,
        {
          cycleId: fixture.cycleId,
          range: {
            baseRef: "refs/heads/main",
            baseOid: "b".repeat(40),
            headOid,
          },
          runId: fixture.runId,
        },
        receipt(sha256Hex(`run:${fixture.runId}`), 0),
      ),
    ],
    { ...own, ...(plantOld === undefined ? {} : { plantOld }) },
  );
  return { repo, home, ...shapes };
};

const show = (home: string, repo: string, runId: string, json: boolean) => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "--no-env-file",
      CLI,
      "review",
      "show",
      "--run",
      runId,
      ...(json ? ["--json"] : []),
      "--repo",
      repo,
    ],
    { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0)
    throw new Error(
      `review show exited ${result.exitCode}: ${result.stderr.toString()}`,
    );
  return result.stdout.toString();
};

type Json = Record<string, unknown>;
const at = (value: unknown, path: string): unknown =>
  path
    .split(".")
    .reduce<unknown>(
      (held, key) =>
        held !== null && typeof held === "object"
          ? (held as Json)[key]
          : undefined,
      value,
    );
/** Each name has the type the shape file states: a JS type, `array`, `null` or a literal. */
const expectNames = (
  value: unknown,
  names: Readonly<Record<string, string>>,
  where: string,
) => {
  for (const [path, type] of Object.entries(names)) {
    const held = at(value, path);
    const actual = Array.isArray(held)
      ? "array"
      : held === null
        ? "null"
        : typeof held;
    const ok = type.startsWith("=")
      ? held === type.slice(1)
      : type.split("|").includes(actual);
    expect({ where, path, ok, actual }).toEqual({
      where,
      path,
      ok: true,
      actual,
    });
  }
};

test("review show --json prints a new-shape review with every name the shape file gives", async () => {
  const { repo, home, fixture } = await scratch();
  const output = JSON.parse(show(home, repo, fixture.runId, true)) as Json;
  const packet = output["packet"] as Json;

  expectNames(
    packet,
    {
      kind: "=packet.published@2",
      ordinal: "number",
      complete: "boolean",
      "counts.batches": "number",
      "counts.units": "number",
      "counts.sections": "number",
      "counts.contextReferences": "number",
      "counts.assessments": "number",
      "counts.deliveries": "number",
      "counts.dispositions": "number",
      "counts.comments": "number",
      "counts.gaps": "number",
      "counts.pending.batches": "number",
      "counts.pending.sections": "number",
      "counts.undecided": "object",
      "counts.undecided.failed": "number",
      "added.batches": "number",
      "added.units": "number",
      "added.sections": "number",
      "added.undecided": "object",
      batches: "array",
      gaps: "array",
    },
    "packet",
  );
  // Exactly the gaps this packet's manifest names, the batch's included; not the first's own.
  const { gaps } = fixture.events;
  expect((packet["gaps"] as Array<Json>).map((gap) => gap["id"])).toEqual([
    gaps.second.id,
    gaps.batch.id,
  ]);

  const batches = packet["batches"] as Array<Json>;
  const large = (batches[0]!["units"] as Array<Json>)[0]!;
  const small = (batches[1]!["units"] as Array<Json>)[0]!;
  expectNames(
    large,
    {
      local: "string",
      unitId: "string",
      "recorded.kind": "=unit.recorded@3",
      "recorded.id": "string",
      "recorded.payload.title": "string",
      "recorded.payload.titleBy": "=code",
      "recorded.payload.path": "string",
      "recorded.payload.key": "string",
      "recorded.payload.sections.count": "number",
      "recorded.payload.ranges.count": "number",
      "recorded.payload.ranges.lines": "number",
      "recorded.payload.ownedRanges": "array",
      "assessment.kind": "=assessment.recorded@4",
      "assessment.id": "string",
      "assessment.payload.lane": "string",
      "assessment.payload.laneRule": "number",
      "assessment.payload.sections.count": "number",
      "assessment.payload.sections.raised": "number",
      "assessment.payload.sections.undecided": "object",
      sections: "array",
      comments: "array",
      references: "array",
      content: "object",
      // The shape file writes null for none; the read model leaves the key out (as `disposition`
      // has always been for a unit without one).
      disposition: "undefined|null",
      carriedDecisions: "array",
      lineage: "object",
      "lineage.payload.from": "array",
    },
    "unit",
  );
  expect(at(large, "recorded.payload.key")).toMatch(/^[0-9a-f]{64}$/);
  const owned = at(large, "recorded.payload.ownedRanges") as Array<Json>;
  expect(owned).toHaveLength(1_100);
  for (const range of [owned[0], owned[1_099]])
    expectNames(
      range,
      {
        kind: "=lines",
        path: "string",
        side: "string",
        startLine: "number",
        endLine: "number",
      },
      "owned range",
    );
  expectNames(
    (at(large, "lineage.payload.from") as Array<Json>)[0],
    {
      unitId: "string",
      cycleId: "string",
      relation: "=changed",
      unchanged: "number",
      changed: "number",
      lane: "string|null",
    },
    "lineage entry",
  );
  expectNames(
    (large["comments"] as Array<Json>)[0],
    {
      kind: "=comment.recorded@3",
      id: "string",
      "payload.body": "string",
      "payload.anchor.path": "string",
      "payload.anchor.side": "string",
      "payload.anchor.startLine": "number",
      "payload.anchor.endLine": "number",
      "payload.finding.kind": "=impact",
      "payload.finding.effect": "=narrowed",
      "payload.finding.about": "string",
      "payload.finding.evidence": "array",
    },
    "comment",
  );

  const [retry, entry] = large["sections"] as Array<Json>;
  for (const section of [retry, entry])
    expectNames(
      section,
      {
        key: "string",
        title: "string",
        parts: "object",
        "parts.path": "string",
        where: "object|null",
        renamedFrom: "string|null",
        ownedRanges: "array",
        facts: "object",
        assess: "object|null",
        "assess.complexity.level": "string",
        "assess.complexity.factors": "array",
        "assess.easeOfValidation.level": "string",
        "assess.easeOfValidation.requirements": "array",
        "assess.movement": "array",
        "assess.gaps": "array",
        review: "object|null",
        "review.verdict": "string",
        "lane.judged": "string|null",
        "lane.surfaced": "string|null",
        "lane.floors": "array",
        "lane.applied": "string",
        lineage: "string",
        floorInputs: "object",
        "floorInputs.facts": "object",
        "floorInputs.options": "object",
        excluded: "undefined",
      },
      "section",
    );
  // The public-surface raise is the trail's `surfaced`; no floor is on in this build.
  expect(at(entry, "lane")).toEqual({
    judged: "static-automation",
    surfaced: "human-suggested",
    floors: [],
    applied: "human-suggested",
  });
  expectNames(
    (at(retry, "assess.easeOfValidation.requirements") as Array<Json>)[0],
    {
      requirement: "string",
      cites: "array",
      coverage: "string",
      proof: "array",
      kinds: "array",
      agree: "boolean",
      testable: "boolean",
      anchors: "array",
      sources: "array",
    },
    "requirement",
  );
  // Every section of a unit has the unit's lane as its applied lane.
  for (const section of large["sections"] as Array<Json>)
    expect(at(section, "lane.applied")).toBe(
      at(large, "assessment.payload.lane"),
    );
  // A section no agent judged: no axes, no judged lane, a cause, human-required.
  expectNames(
    (small["sections"] as Array<Json>)[0],
    {
      assess: "null",
      "lane.judged": "null",
      "lane.applied": "=human-required",
      "undecided.cause": "=failed",
      "undecided.reading": "=assess",
      floorInputs: "object",
    },
    "undecided section",
  );
  expect(small["lineage"] ?? null).toBeNull();
}, 120_000);

// Why: the desk and the gates lane read two more things from `review show --json`: the decisions
// people made on an earlier unit carried onto an unchanged one (the events, as `disposition` is
// printed), and why no reading was made of a section the map excluded. A person reading the text
// must see a carried decision as a person's, never as the review's own or as still waiting, and
// must be told in plain words why no one judged an excluded file.
test("review show prints a person's carried decision as theirs and says why an excluded file was not judged", async () => {
  const { repo, home, fixture } = await scratch(undefined, {
    excluded: true,
    carried: true,
    floor: true,
    noFloorInputs: true,
  });
  const lock = fixture.lock!;
  const carried = fixture.events.carried!;
  const output = JSON.parse(show(home, repo, fixture.runId, true)) as Json;
  const batches = at(output, "packet.batches") as Array<Json>;
  expect(batches).toHaveLength(3);
  const small = (batches[1]!["units"] as Array<Json>)[0]!;
  const locked = (batches[2]!["units"] as Array<Json>)[0]!;
  const decisions = small["carriedDecisions"] as Array<Json>;
  expect(decisions).toHaveLength(1);
  expectNames(
    decisions[0],
    {
      kind: "=disposition.carried@1",
      id: `=${carried.id}`,
      actor: "string",
      "attribution.cycleId": `=${fixture.cycleId}`,
      "attribution.unitIds": "array",
      "payload.verdict": "=approve",
      "payload.reviewedHeadOid": "string",
      "payload.lineage": "=carried",
      "payload.from": "object",
      "payload.from.review": "string",
      "payload.from.cycle": "string",
      "payload.from.head": "string",
      "payload.from.judgement": "string",
      "payload.from.output": "string",
      "payload.from.savedMs": "number",
      "payload.restsOn": "array",
      "payload.proof": "array",
    },
    "carried decision",
  );
  expect(at(decisions[0], "attribution.unitIds")).toEqual([
    fixture.units.small,
  ]);
  // A floor the readers' rule stores, `{ rule, to }`, beside the inputs it was given; an entry
  // written before `floorInputs` has no such key.
  const [retry, entry] = (batches[0]!["units"] as Array<Json>)[0]![
    "sections"
  ] as Array<Json>;
  expect(at(entry, "lane.floors")).toEqual([
    { rule: "removal", to: "human-suggested" },
  ]);
  expectNames(
    entry,
    {
      "floorInputs.facts.removesDeclaration": "boolean",
      "floorInputs.options.removal": "boolean",
    },
    "floored section",
  );
  expect("floorInputs" in retry!).toBe(false);
  // The review's own disposition stays apart; the person's decision closes the unit.
  expect(small["disposition"] ?? null).toBeNull();
  expect(at(small, "judgement.closed")).toBe(true);
  expect(at(locked, "carriedDecisions")).toEqual([]);

  expect(locked["unitId"]).toBe(lock.unitId);
  const [section] = locked["sections"] as Array<Json>;
  expectNames(
    section,
    {
      key: `=${lock.sectionKey}`,
      assess: "null",
      review: "null",
      undecided: "undefined",
      "excluded.reason": "=lockfile",
      "lane.judged": "null",
      "lane.applied": "=human-suggested",
      floorInputs: "object",
    },
    "excluded section",
  );
  expect(locked["disposition"] ?? null).toBeNull();
  expect(locked["comments"]).toEqual([]);

  const text = show(home, repo, fixture.runId, false).split("\n");
  const tail = (id: string) => `…${id.slice(-10)}`;
  const smallAt = text.findIndex((l) =>
    l.startsWith(`  unit ${tail(fixture.units.small)} `),
  );
  const lockAt = text.findIndex((l) =>
    l.startsWith(`  unit ${tail(lock.unitId)} `),
  );
  expect(smallAt).toBeGreaterThan(-1);
  expect(lockAt).toBeGreaterThan(smallAt);
  const smallLines = text.slice(smallAt, lockAt);
  // Not the review's own decision, and not waiting: a person's, carried from an earlier review.
  expect(smallLines).toContain("    disposition: none recorded by the agent");
  expect(smallLines).toContain(
    `    disposition approve by a person (${tail(carried.id)}) at aaaaaaaaaaaa, carried from an earlier review; rests on 0 comment(s); cites 0 proof record(s)`,
  );
  expect(smallLines).toContain(
    "    closure: closed (by 1 disposition(s); a person's approve, carried from an earlier review)",
  );
  const lockLines = text.slice(lockAt, lockAt + 8);
  expect(lockLines).toContain(
    "      not judged by an agent: a lockfile, which the review does not read; lane judged by no agent; applied human-suggested",
  );
  expect(lockLines).toContain("    closure: open: needs a disposition");
  expect(text).toContain(
    "      lane: judged static-automation; raised to human-suggested by a code rule (removal); applied human-suggested",
  );
  // No internal word reaches a person anywhere in what `review show` prints for the review.
  for (const shown of text)
    expect(shown).not.toMatch(
      /section|reading group|floor|backstop|impact kind|family/i,
    );
}, 120_000);

// Why: the desk and the gates lane read how each section's judgement was made from `review show
// --json`, so the four names `reports/records-show-shape.md` gives must be there with their types on
// each kind of entry, and absent on an entry that stores none. The text a person reads says the
// same in plain words and names no working word.
test("review show prints what produced each judgement: a code rule, a pattern, context", async () => {
  const { repo, home, fixture } = await scratch(undefined, { kinds: true });
  const kinds = fixture.kinds!;
  const output = JSON.parse(show(home, repo, fixture.runId, true)) as Json;
  const batches = at(output, "packet.batches") as Array<Json>;
  const sections = new Map(
    batches
      .flatMap((batch) => batch["units"] as Array<Json>)
      .flatMap((unit) => unit["sections"] as Array<Json>)
      .map((section) => [section["key"] as string, section]),
  );
  const keys = kinds.sectionKeys;
  expectNames(
    sections.get(keys.representative),
    {
      "origin.assess": "=model",
      "origin.review": "=model",
      "family.key": "string",
      "family.representative": `=${keys.representative}`,
      "family.reading": "string",
      "family.members": "number",
      rules: "undefined",
      context: "undefined",
    },
    "representative",
  );
  expectNames(
    sections.get(keys.member),
    {
      "origin.review": "=family",
      "family.representative": `=${keys.representative}`,
      "family.members": "undefined",
      "review.verdict": "=approve",
    },
    "member",
  );
  expectNames(
    sections.get(keys.context),
    {
      context: "boolean",
      rules: "array",
      "rules.0.rule": "=imports-only",
      "rules.0.version": "number",
      "rules.0.inputs": "object",
      "rules.0.result": "=holds",
      "rules.0.reason": "string",
      "rules.0.statement": "=imports only",
      origin: "undefined",
      assess: "null",
      "lane.applied": "=static-automation",
    },
    "context",
  );
  expectNames(
    sections.get(keys.oneReading),
    {
      "origin.assess": "=rule",
      "origin.review": "=model",
      "rules.0.rule": "=test-only",
      "review.verdict": "=approve",
    },
    "one reading",
  );
  expectNames(
    sections.get(keys.ruled),
    {
      "origin.assess": "=rule",
      "origin.review": "=none",
      "rules.0.rule": "=whitespace-only",
      review: "null",
    },
    "rule alone",
  );
  for (const key of Object.values(fixture.sectionKeys))
    for (const name of ["origin", "rules", "family", "context"])
      expect(name in sections.get(key)!).toBe(false);

  const text = show(home, repo, fixture.runId, false).split("\n");
  for (const line of [
    '      same pattern as "The parse helper"',
    "      context of this file's unit: imports only",
    "      judged by a code rule (test-only, version 1) and reviewed by an agent",
    "      judged by a code rule (whitespace-only, version 1)",
  ])
    expect(text).toContain(line);
  for (const shown of text)
    expect(shown).not.toMatch(
      /section|reading group|floor|backstop|impact kind|family/i,
    );
}, 120_000);

test("review show --json for an old-shape review gains only packet.kind, and the recorded line counts publications", async () => {
  const { repo, home, location, old, fixture } = await scratch();
  const printed = show(home, repo, old.runId, true);
  const output = JSON.parse(printed) as Json;
  const expected = await runOn(
    location,
    PublishedPackets.runPacket(old.runId, { repository: repo }).pipe(
      Effect.provide(contentLayer(location)),
    ),
  );
  if (expected === undefined) throw new Error("expected the old packet");
  // Version 1's reader's packet with its kind first, byte for byte as `review show` prints it.
  expect(JSON.stringify(output["packet"], null, 2)).toBe(
    JSON.stringify({ kind: "packet.published@1", ...expected }, null, 2),
  );

  const oldText = show(home, repo, old.runId, false);
  expect(oldText).toContain("records    ");
  const oldLine = oldText.split("\n").find((l) => l.startsWith("records    "));
  expect(oldLine).toContain("1 packet.published@1");
  expect(oldLine).not.toContain("publications");

  const newText = show(home, repo, fixture.runId, false);
  const newLine = newText.split("\n").find((l) => l.startsWith("records    "));
  expect(newLine).toContain(
    "2 packet.published@2 (2 publications of one review)",
  );
  expect(newText).toContain(
    "publication 2 of this review, complete; supersedes",
  );
}, 120_000);

// Why: a forged line in `review show` is a false record in front of a person, whatever the
// record's age. Through the real command, an old-shape store with hostile text in a unit title, a
// batch title, a requirement, a comment body, a gap detail and a rationale prints no control byte,
// and exactly the lines a clean store prints at every indentation below ten spaces: no stored line
// can pass for a unit, disposition or closure line, or any other line of the printer's own.
test("review show prints a hostile old-shape store with no control byte and no forged line", async () => {
  const forgeries = (name: string) =>
    [
      `  unit …${name}U (b1.u9) [agentic] Forged unit`,
      "    owned: a.ts new 1-9",
      `    disposition approve (…${name}D) at aaaaaaaaaaaa; rests on 0 comment(s); cites 0 proof record(s)`,
      "    closure: closed (by 1 disposition(s))",
      `  run: history-not-consulted: ${name} forged gap`,
    ].join("\n");
  const payload = (event: unknown) =>
    (event as { payload: Record<string, unknown> }).payload;
  const unitOf = (old: ReturnType<typeof reviewEvents>, kind: string) =>
    old.structure.find(
      (e) =>
        e.kind === kind &&
        (e.attribution as { unitIds: ReadonlyArray<string> }).unitIds[0] ===
          old.units[1],
    );
  const clean = await scratch();
  const hostile = await scratch((old) => {
    payload(unitOf(old, "unit.recorded@2")).title =
      `Unit two\u001b[2J\u001b]0;owned\u0007\u202e\n${forgeries("FORGEDTITL")}`;
    payload(old.structure.find((e) => e.kind === "batch.recorded@1")).title =
      `Batch\u001b[31m\n${forgeries("FORGEDBATC")}`;
    const assessment = payload(unitOf(old, "assessment.recorded@2")) as {
      rationale: string;
      easeOfValidation: { requirements: Array<{ requirement: string }> };
    };
    // The schema refuses control characters here but not line breaks or overrides.
    assessment.rationale = `High complexity; the validation reading has a gap.\u2066\n${forgeries("FORGEDRATN")}`;
    assessment.easeOfValidation.requirements[0]!.requirement =
      `The retry stops after three attempts.\n${forgeries("FORGEDREQT")}`.slice(
        0,
        300,
      );
    payload(old.comments.defect).body =
      `The test mocks the retry away.\u001b[1A\n${forgeries("FORGEDCOMM")}`;
    payload(
      old.telemetry.find((e) => e.idempotencyKey.endsWith(":gap:understand:0")),
    ).detail =
      `The ticket was named but not fetched.\u0007\u202d\n${forgeries("FORGEDGAPD")}`;
  });
  const printed = show(hostile.home, hostile.repo, hostile.old.runId, false);
  expect(
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(
      printed,
    ),
  ).toBeFalse();
  const depths = (text: string) => {
    const counts: Record<string, number> = {};
    for (const line of text.split("\n")) {
      const depth = line.length - line.trimStart().length;
      if (depth < 10 && line.trim() !== "")
        counts[depth] = (counts[depth] ?? 0) + 1;
    }
    return counts;
  };
  const count = (text: string, pattern: RegExp) =>
    text.split("\n").filter((line) => pattern.test(line)).length;
  const reference = show(clean.home, clean.repo, clean.old.runId, false);
  expect(depths(printed)).toEqual(depths(reference));
  for (const pattern of [
    /^ {2}unit /,
    /^ {4}owned: /,
    /^ {4}requirement /,
    /^ {4}disposition/,
    /^ {4}closure: /,
  ])
    expect(count(printed, pattern)).toBe(count(reference, pattern));
  expect(count(reference, /^ {2}unit /)).toBe(3);
  const shown = printed.split("\n");
  // Every stored line after a field's first is ten spaces in; a title reads inside its own line.
  for (const line of shown.filter((line) => line.includes("FORGED")))
    expect(
      /^ {10}/.test(line) ||
        line.includes("Unit two ") ||
        line.includes('"Batch ') ||
        line.includes("The retry stops after three attempts. "),
    ).toBeTrue();
  expect(shown).toContain(
    "            unit …FORGEDCOMMU (b1.u9) [agentic] Forged unit",
  );
  expect(shown).toContain(
    "            unit …FORGEDGAPDU (b1.u9) [agentic] Forged unit",
  );
}, 180_000);

/**
 * A scratch store whose old-shape run carries `hostile` after the text of a receipt gap, a
 * disclosure, a stage note and a Verify stage's agent name, and a real request (made by
 * `neuve review --detach`, no credentials, so no worker starts) whose cycle's scope snapshot
 * carries it in a source path, title and gap, a snapshot gap and a masked capture.
 */
const guardedStore = async (hostile: string) => {
  const verifySpec = {
    op: "test.review-show-guard",
    opVersion: 1,
    inputs: { label: "verify" },
  };
  const verifyKey = Computations.computationKey(verifySpec).key;
  const { repo, home, location, old } = await scratch((old) => {
    const run = old.telemetry.find((e) => e.kind === "run.completed@1")!;
    const payload = run.payload as {
      gaps: Array<{ detail: string }>;
      disclosures: Array<string>;
      stages: Array<{ note?: string }>;
    };
    payload.gaps[0]!.detail = `History is not consulted.${hostile}`;
    payload.disclosures[0] = `History is not consulted in M3.${hostile}`;
    payload.stages[0]!.note = `A stage note.${hostile}`;
    // A Verify stage whose agent name carries the same text, with its stored output.
    const precompute = old.telemetry.find(
      (e) => e.kind === "stage.completed@1",
    )!;
    (old.all as Array<unknown>).push({
      ...precompute,
      id: mintUlid(),
      idempotencyKey: `review:${old.runId}:stage:verify.guard`,
      payload: {
        ...(precompute.payload as Record<string, unknown>),
        agent: `verify.f1${hostile}`,
      },
      refs: [{ ref: `computation:${verifyKey}`, role: "output" }],
    });
  });
  await runOn(
    location,
    Effect.gen(function* () {
      const store = yield* Computations.ComputationStore;
      yield* store.run(
        verifySpec,
        Effect.succeed({
          bytes: new TextEncoder().encode(
            JSON.stringify({
              decision: "keep",
              reason: "Supported.",
              finding: "F1",
              lens: "correctness",
              source: "agent",
            }),
          ),
          mediaType: "application/json",
        }),
      );
    }).pipe(Effect.provide(contentLayer(location))),
  );

  // A real request in the same store, whose cycle's scope snapshot names a hostile source.
  // `neuve review` refuses a repository until setup has run there.
  await markSetUp(repo);
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
  };
  for (const name of [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "NEUVE_OPENAI_TOKEN_COMMAND",
  ])
    delete env[name];
  const requested = Bun.spawnSync(
    [
      process.execPath,
      "--no-env-file",
      CLI,
      "review",
      "HEAD~1..HEAD",
      "--detach",
      "--repo",
      repo,
    ],
    { env, stdout: "pipe", stderr: "pipe" },
  );
  if (requested.exitCode !== 0) throw new Error(requested.stderr.toString());
  const db = new Database(location.database);
  const request = (() => {
    try {
      return JSON.parse(
        db
          .query<{ envelope: string }, []>(
            "SELECT envelope FROM events WHERE kind = 'review.requested@1' ORDER BY seq DESC LIMIT 1",
          )
          .get()!.envelope,
      ) as { id: string; attribution: { cycleId: string } };
    } finally {
      db.close();
    }
  })();
  const cycleId = request.attribution.cycleId;
  const capture = `Masked text.${hostile}\nSecond line.`;
  const snapshot = {
    cycleId,
    fetchedAt: "2026-11-12T00:00:00Z",
    ms: 0,
    range: { baseOid: "base", headOid: "head", mergeBase: "base" },
    integrations: { file: "absent", detail: null, servers: [] },
    named: [],
    sources: [] as Array<unknown>,
    strata: { strongest: "plan-inside-range", present: ["plan-inside-range"] },
    gaps: [`A scope gap.${hostile}`],
  };
  await runOn(
    location,
    Effect.gen(function* () {
      const blobs = yield* Blobs.BlobStore;
      const held = yield* blobs.put({
        bytes: new TextEncoder().encode(capture),
        mediaType: "text/plain; charset=utf-8",
        retention: "raw-capture",
      });
      snapshot.sources = [
        {
          id: "S1",
          kind: "repository-document",
          stratum: "plan-inside-range",
          fetchedAt: "2026-11-12T00:00:00Z",
          ms: 0,
          status: "fetched",
          ref: { found: "test", path: `docs/plan.md${hostile}` },
          title: `The plan${hostile}`,
          sections: [],
          capture: { blob: held.blob.hash, masked: {} },
          gap: `A source gap.${hostile}`,
        },
      ];
      const parsed = Scope.ScopeSnapshot.parse(snapshot);
      const store = yield* Computations.ComputationStore;
      yield* store.run(
        Scope.snapshotSpec(cycleId),
        Effect.succeed({
          bytes: new TextEncoder().encode(JSON.stringify(parsed)),
          mediaType: "application/json",
        }),
      );
    }).pipe(Effect.provide(contentLayer(location))),
  );

  return { repo, home, location, old, request, capture };
};

// Why: the same defect as in the packet section, in the sections around it. A receipt's gaps,
// disclosures and stage notes, a stage output's agent, and a scope source's title, path, gap and
// masked capture are text a model or a repository wrote; `review show` must not let any of it
// drive the terminal, while `--json` keeps it exactly as stored and clean text prints as before.
test("review show's whole text output is guarded, its JSON is not, and clean text prints as before", async () => {
  const hostile = "\u001b[2J\u001b]0;owned\u0007\u202e";
  const { repo, home, old, request, capture } = await guardedStore(hostile);
  const control =
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
  // The receipt, its gaps, disclosures and stage notes, and the stage outputs, with the packet.
  const reviewed = show(home, repo, old.runId, false);
  expect(control.test(reviewed)).toBeFalse();
  expect(reviewed).toContain("History is not consulted.");
  expect(reviewed).toContain("History is not consulted in M3.");
  expect(reviewed).toContain("A stage note.");
  expect(reviewed).toContain("verify.f1: keep.");
  // The run log, the scope snapshot and its masked capture, for the request with no receipt.
  const scoped = show(home, repo, request.id, false);
  expect(control.test(scoped)).toBeFalse();
  expect(scoped).toContain("docs/plan.md");
  expect(scoped).toContain("  gap: A scope gap.");
  expect(scoped).toContain("gap: A source gap.");
  expect(scoped).toContain("    | Masked text.");
  expect(scoped).toContain("    | Second line.");

  // `--json` keeps every stored string as stored.
  const json = JSON.parse(show(home, repo, old.runId, true)) as {
    gaps: Array<{ detail: string }>;
    disclosures: Array<string>;
    stageOutputs: Array<string>;
  };
  expect(json.gaps[0]!.detail).toBe(`History is not consulted.${hostile}`);
  expect(json.disclosures[0]).toBe(`History is not consulted in M3.${hostile}`);
  expect(json.stageOutputs).toContain(`verify.f1${hostile}: keep.`);
  const scopeJson = JSON.parse(show(home, repo, request.id, true)) as {
    scope: { sources: Array<{ title: string }>; gaps: Array<string> };
    captures: Record<string, string>;
  };
  expect(scopeJson.scope.sources[0]!.title).toBe(`The plan${hostile}`);
  expect(scopeJson.scope.gaps[0]).toBe(`A scope gap.${hostile}`);
  expect(scopeJson.captures["S1"]).toBe(capture);

  // A clean store prints exactly the lines `review show` assembles before the guard.
  const clean = await scratch();
  const plain = show(clean.home, clean.repo, clean.old.runId, false);
  const unguarded = await showOutput(clean.repo, clean.old.runId, false);
  if (!("lines" in unguarded)) throw new Error("expected text lines");
  const text = unguarded.lines.join("\n");
  expect(plain).toBe(text.endsWith("\n") ? text : `${text}\n`);
  expect(plain).toContain("records    ");
}, 240_000);

// Why: the guard must never delete text that is not an escape sequence. An OSC left open in an
// early receipt gap, a stage output or a scope source once removed everything after it: the
// disclosures, the packet, the stage outputs, the manifest and the scope. Each now loses at most
// the rest of its own line, and the command prints every line it assembles.
test("an unterminated OSC removes at most the rest of its own line", async () => {
  const open = "\u001b]0;never terminated ";
  const { repo, home, old, request } = await guardedStore(open);
  for (const runId of [old.runId, request.id]) {
    const printed = show(home, repo, runId, false);
    const assembled = await showOutput(repo, runId, false);
    if (!("lines" in assembled)) throw new Error("expected text lines");
    // As many lines as `review show` assembles, none of them lost.
    expect(printed.replace(/\n$/, "").split("\n")).toHaveLength(
      assembled.lines.join("\n").split("\n").length,
    );
    expect(printed).not.toContain("\u001b");
  }
  const reviewed = show(home, repo, old.runId, false).split("\n");
  // The line that held each OSC keeps the text before it.
  expect(
    reviewed.some((line) => line.endsWith("History is not consulted.")),
  ).toBeTrue();
  expect(reviewed).toContain("verify.f1");
  // And every section heading after them is still printed.
  for (const heading of [
    "disclosed",
    "stages",
    "records    ",
    "packet (packet.published@1 ",
    "gaps disclosed by the run (gap.disclosed@1)",
    "stored content not decoded (disclosed; the rest of the packet reads as stored)",
    "No range manifest is stored for this run yet.",
    "No scope snapshot is stored for this run's cycle yet.",
  ])
    expect(reviewed.some((line) => line.startsWith(heading))).toBeTrue();
  const scoped = show(home, repo, request.id, false).split("\n");
  expect(
    scoped.some((line) => line.startsWith("scope snapshot for cycle ")),
  ).toBeTrue();
  expect(scoped.some((line) => line.endsWith("docs/plan.md"))).toBeTrue();
  expect(scoped).toContain("  gap: A scope gap.");
  expect(scoped).toContain("    | Masked text.");
  expect(scoped).toContain("    | Second line.");
  expect(
    scoped.some((line) => line.startsWith("No packet is published")),
  ).toBeTrue();
}, 240_000);

// Why: `review`'s follow mode prints run-log records as they arrive, and a progress message, a
// stage note, a failed attempt's error or an abandon reason can carry a provider's or a tool's
// text. Its formatting function, through the guard; driving a live follow needs a worker.
test("follow mode's run-log lines go through the guard", () => {
  const hostile = "\u001b[2J\u001b]0;owned\u0007\u202e";
  expect(
    followLine({
      type: "run.attempt-failed",
      at: "2026-11-12T00:00:00.000Z",
      attempt: 1,
      final: false,
      error: `Provider said no.${hostile}`,
    }),
  ).toBe(
    "2026-11-12T00:00:00.000Z attempt 1 failed; the queue retries it: Provider said no.",
  );
  expect(
    followLine({ type: "progress", message: `Reading.\u001b]0;open\nNext.` }),
  ).toBe(" Reading.\nNext.");
  expect(followLine({ type: "run.abandoned", reason: "Gone." })).toBe(
    " run abandoned: Gone.",
  );
  expect(terminalGuard(["a\tb", "c…d"])).toBe("a\tb\nc…d");
});

// Why: `review show` resolves the store before it looks the run up, so a folder outside git is
// refused with the store's own sentence, not a git error from the run lookup.
test("review show outside a git repository says so and exits 2", async () => {
  const folder = await realpath(
    await mkdtemp(join(tmpdir(), "neuve-not-git-")),
  );
  directories.push(folder);
  const result = Bun.spawnSync(
    [
      process.execPath,
      "--no-env-file",
      CLI,
      "review",
      "show",
      "HEAD~1..HEAD",
      "--repo",
      folder,
    ],
    {
      env: {
        ...process.env,
        HOME: folder,
        GIT_CEILING_DIRECTORIES: dirname(folder),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(result.exitCode).toBe(2);
  expect(result.stderr.toString()).toBe(
    "neuve: --repo must name a folder inside a Git repository.\n",
  );
}, 60_000);
