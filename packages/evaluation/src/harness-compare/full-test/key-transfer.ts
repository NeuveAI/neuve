import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { proximityUnits } from "../../../../harness/src/units.ts";
import type { ManifestHunk as HarnessHunk } from "../../../../harness/src/manifest.ts";
import { FULL_TEST_RESULTS } from "./config.ts";
import { LANES_RESULTS, rangeIdentity, type LaneCall } from "./lanes.ts";
import { runFileOf, type LoadedSet } from "./lanes-eval.ts";
import {
  ownedLineKeys,
  packetUnits,
  readShownFile,
  READS_SECTIONS,
  type Lane,
  type PacketLite,
} from "./packets.ts";

/**
 * Whether the lanes answer key carries over to another unit shape (NEU-148). The key is kept per
 * changed line (`<path>:<side>:<line>`), so it moves to any unit that owns the same lines; what can
 * change is which lines a unit owns and how many units a labelled range is spread over. This reads,
 * per case, each labelled range against the units of a target shape:
 *
 * - the replay key: each maximal run of consecutive labelled lines of one class in one file side;
 * - the owner's key: each unit the owner answered on the older shape, with its owned lines.
 *
 * The target is either today's proximity units (`units.ts`, computed here by code from the case's
 * manifest hunks, every hunk of a file together: Map's groups can only split them further), or a
 * stored run's own units (`run/<folder>/show.json`). Nothing here runs a review or writes a file.
 */

interface TextHunk {
  readonly hunkId: string;
  readonly kind: string;
  readonly path: string;
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly oldStart: number;
  readonly newStart: number;
  readonly added: number;
  readonly deleted: number;
  readonly text: string;
}

/** A hunk's changed lines as line keys, as `ownedLineKeys` writes an owner of all of them. */
export const hunkLineKeys = (hunk: TextHunk): Array<string> => {
  if (hunk.kind !== "text")
    return [
      `${hunk.newPath ?? hunk.path}:new:whole`,
      `${hunk.oldPath ?? hunk.path}:old:whole`,
    ];
  const keys: Array<string> = [];
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  for (const row of hunk.text.split("\n").slice(1)) {
    if (row === "" || row.startsWith("\\")) continue;
    if (row.startsWith("-")) {
      keys.push(`${hunk.oldPath ?? hunk.path}:old:${oldLine++}`);
      continue;
    }
    if (row.startsWith("+")) {
      keys.push(`${hunk.newPath ?? hunk.path}:new:${newLine++}`);
      continue;
    }
    oldLine++;
    newLine++;
  }
  return keys;
};

/** A target shape's units, each with the line keys it owns. */
export interface TargetUnit {
  readonly unit: string;
  readonly lines: ReadonlySet<string>;
}

/** Today's proximity units over a manifest's hunks, every hunk of a file together. */
export const proximityTarget = (
  id: string,
  hunks: ReadonlyArray<TextHunk>,
): Array<TargetUnit> => {
  const byId = new Map(hunks.map((hunk) => [hunk.hunkId, hunk]));
  return proximityUnits(id, hunks as unknown as ReadonlyArray<HarnessHunk>).map(
    (unit) => ({
      unit: unit.id,
      lines: new Set(
        unit.hunkIds.flatMap((hunkId) => hunkLineKeys(byId.get(hunkId)!)),
      ),
    }),
  );
};

/**
 * A shown run's manifest hunks whole: the lanes reader's `hunksOf` keeps only what the lane
 * candidates read, without hunk IDs or old sides, which proximity units need.
 */
export const manifestHunks = (shownFile: string): Array<TextHunk> =>
  (
    JSON.parse(readFileSync(shownFile, "utf8")) as {
      manifest?: { hunks?: Array<TextHunk> } | null;
    }
  ).manifest?.hunks ?? [];

/** A stored run's own units, through the guard (packets.ts `readablePacket`), named by `where`. */
export const packetTarget = (
  packet: PacketLite | null,
  where = "a stored run",
): Array<TargetUnit> =>
  packetUnits(packet, { where, reads: READS_SECTIONS }).map(({ unit }) => ({
    unit: unit.unitId,
    lines: ownedLineKeys(unit),
  }));

/** Where one labelled range lands among a target's units. */
export type Landing = "one" | "several" | "none";

export interface RangeLanding {
  readonly landing: Landing;
  readonly lines: number;
  /** Its lines no target unit owns: they drop out of every measure. */
  readonly unowned: number;
  readonly units: ReadonlyArray<string>;
}

export const land = (
  lines: ReadonlyArray<string>,
  target: ReadonlyArray<TargetUnit>,
): RangeLanding => {
  const holders = new Set<string>();
  let unowned = 0;
  for (const line of lines) {
    const owners = target.filter((unit) => unit.lines.has(line));
    if (owners.length === 0) unowned++;
    for (const owner of owners) holders.add(owner.unit);
  }
  return {
    landing:
      holders.size === 0 ? "none" : holders.size === 1 ? "one" : "several",
    lines: lines.length,
    unowned,
    units: [...holders],
  };
};

/** The replay key's labelled ranges: consecutive lines of one class in one file side. */
export const labelledRanges = (
  lines: Readonly<Record<string, { readonly class: string }>>,
) => {
  const parsed = Object.entries(lines).map(([key, entry]) => {
    const match = /^(.+):(new|old):(\d+|whole)$/.exec(key)!;
    return {
      key,
      file: `${match[1]}:${match[2]}`,
      line: match[3] === "whole" ? -1 : Number(match[3]),
      cls: entry.class,
    };
  });
  parsed.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.cls.localeCompare(b.cls) ||
      a.line - b.line,
  );
  const ranges: Array<{ cls: string; lines: Array<string> }> = [];
  let last: (typeof parsed)[number] | undefined;
  for (const entry of parsed) {
    const joins =
      last !== undefined &&
      entry.line !== -1 &&
      last.line !== -1 &&
      last.file === entry.file &&
      last.cls === entry.cls &&
      entry.line === last.line + 1;
    if (joins) ranges.at(-1)!.lines.push(entry.key);
    else ranges.push({ cls: entry.cls, lines: [entry.key] });
    last = entry;
  }
  return ranges;
};

const tally = (landings: ReadonlyArray<RangeLanding>) => ({
  ranges: landings.length,
  one: landings.filter((l) => l.landing === "one").length,
  several: landings.filter((l) => l.landing === "several").length,
  none: landings.filter((l) => l.landing === "none").length,
  lines: landings.reduce((sum, l) => sum + l.lines, 0),
  unownedLines: landings.reduce((sum, l) => sum + l.unowned, 0),
});

/**
 * Each case of a loaded set: its replay key's labelled ranges (all, and the needs-a-person ones the
 * escalation recall reads) against the target, and the labelled run's own units holding labelled
 * lines, as one, several or no target units. `target` gives a case's units; by default today's
 * proximity units over the case's manifest hunks.
 */
export const replayTransfer = (
  loaded: LoadedSet,
  target: (entry: LoadedSet["cases"][number]) => ReadonlyArray<TargetUnit> = (
    entry,
  ) =>
    proximityTarget(entry.meta.caseId, manifestHunks(entry.meta.packet.path)),
) =>
  loaded.cases.map((entry) => {
    const units = target(entry);
    const ranges = labelledRanges(entry.evidence.lines);
    const all = ranges.map((range) => land(range.lines, units));
    const needs = ranges
      .filter((range) => range.cls === "needs-person")
      .map((range) => land(range.lines, units));
    const labelled = new Set(Object.keys(entry.evidence.lines));
    // Ownership only, so the sections shape reads too.
    const readAs = {
      where: `case ${entry.meta.caseId}`,
      reads: READS_SECTIONS,
    } as const;
    // The labelled run's units, by the labelled lines they owned.
    const older = packetUnits(entry.packet, readAs)
      .map(({ unit }) =>
        [...ownedLineKeys(unit)].filter((l) => labelled.has(l)),
      )
      .filter((lines) => lines.length > 0)
      .map((lines) => land(lines, units));
    // Target units holding labelled lines of more than one older unit: joined answers.
    const olderOf = new Map<string, string>();
    for (const { unit } of packetUnits(entry.packet, readAs))
      for (const line of ownedLineKeys(unit))
        if (labelled.has(line)) olderOf.set(line, unit.unitId);
    const joining = units.filter(
      (unit) =>
        new Set([...unit.lines].flatMap((l) => olderOf.get(l) ?? [])).size > 1,
    ).length;
    // Lines the labelled run owned that no target unit owns, labelled or not.
    const targetLines = new Set(units.flatMap((unit) => [...unit.lines]));
    const olderLines = new Set(
      packetUnits(entry.packet, readAs).flatMap(({ unit }) => [
        ...ownedLineKeys(unit),
      ]),
    );
    const olderOnly = [...olderLines].filter((l) => !targetLines.has(l)).length;
    return {
      caseId: entry.meta.caseId,
      era: entry.meta.era,
      split: entry.meta.split,
      units: units.length,
      olderUnits: packetUnits(entry.packet, readAs).length,
      olderOnly,
      ranges: tally(all),
      needsPerson: tally(needs),
      olderLabelledUnits: tally(older),
      joining,
    };
  });

// The owner's key

const readJson = (path: string) =>
  JSON.parse(
    path.endsWith(".gz")
      ? gunzipSync(readFileSync(path)).toString("utf8")
      : readFileSync(path, "utf8"),
  ) as unknown;

/** A sheet range's manifest hunks, from the full test's stored run of it. */
const storedHunks = (range: string): Array<TextHunk> | null => {
  const runs = join(FULL_TEST_RESULTS, "runs");
  if (!existsSync(runs)) return null;
  for (const folder of readdirSync(runs).filter((name) => name.endsWith(range)))
    for (const file of readdirSync(join(runs, folder))
      .filter((name) => /\.json(\.gz)?$/.test(name))
      .sort()) {
      const stored = readJson(join(runs, folder, file)) as {
        manifest?: { hunks?: Array<TextHunk> };
      } | null;
      const hunks = stored?.manifest?.hunks;
      if (Array.isArray(hunks) && hunks.length > 0 && "text" in hunks[0]!)
        return hunks;
    }
  return null;
};

/**
 * A range's hunks from Git, as Neuve's manifest diffs it (`git diff --no-renames` against the merge
 * base, three lines of context): for desk ranges whose stored run is not in this checkout.
 */
export const gitHunks = (repository: string, range: string) => {
  const [base, head] = range.split("..");
  const git = (args: ReadonlyArray<string>) =>
    execFileSync("git", ["-C", repository, ...args], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
  const from = git([
    "merge-base",
    `${base}^{commit}`,
    `${head}^{commit}`,
  ]).trim();
  const to = git(["rev-parse", `${head}^{commit}`]).trim();
  const out = git([
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--no-color",
    from,
    to,
  ]);
  const hunks: Array<TextHunk> = [];
  let oldPath: string | null = null;
  let newPath: string | null = null;
  let current: { header: string; rows: Array<string> } | undefined;
  const flush = () => {
    if (current === undefined) return;
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(
      current.header,
    )!;
    hunks.push({
      hunkId: `g${hunks.length}`,
      kind: "text",
      path: newPath ?? oldPath!,
      oldPath,
      newPath,
      oldStart: Number(match[1]),
      newStart: Number(match[2]),
      added: current.rows.filter((r) => r.startsWith("+")).length,
      deleted: current.rows.filter((r) => r.startsWith("-")).length,
      text: [current.header, ...current.rows].join("\n"),
    });
    current = undefined;
  };
  for (const row of out.split("\n")) {
    if (row.startsWith("diff --git ")) {
      flush();
      oldPath = null;
      newPath = null;
      continue;
    }
    if (current === undefined && row.startsWith("--- "))
      oldPath = row === "--- /dev/null" ? null : row.slice(6);
    else if (current === undefined && row.startsWith("+++ "))
      newPath = row === "+++ /dev/null" ? null : row.slice(6);
    else if (row.startsWith("@@ ")) {
      flush();
      current = { header: row, rows: [] };
    } else if (current !== undefined) current.rows.push(row);
  }
  flush();
  return hunks;
};

/**
 * Every unit the owner answered in the rounds written so far, each as its owned lines, against
 * today's proximity units over its range's hunks (the full test's stored run, else Git in
 * `repository`). Ranges with neither are named, not guessed.
 */
export const ownerTransfer = (
  repository: string,
  directory: string = LANES_RESULTS,
) => {
  const answered = new Map<string, LaneCall>();
  for (const name of readdirSync(directory).filter((n) =>
    n.endsWith(".json"),
  )) {
    const round = JSON.parse(readFileSync(join(directory, name), "utf8")) as {
      calls?: ReadonlyArray<LaneCall>;
    };
    for (const call of round.calls ?? [])
      if (call.owner !== null && call.owner !== undefined)
        answered.set(`${call.range}|${call.unit}|${name}`, call);
  }
  const ranges = [...new Set([...answered.values()].map((c) => c.range))];
  const targets = new Map<string, Array<TargetUnit> | null>();
  for (const range of ranges) {
    let hunks = storedHunks(range);
    if (hunks === null)
      try {
        hunks = gitHunks(repository, rangeIdentity(range));
      } catch {
        hunks = null;
      }
    targets.set(range, hunks === null ? null : proximityTarget(range, hunks));
  }
  const rows = [...answered.entries()].map(([id, call]) => {
    const target = targets.get(call.range);
    const landing = target == null ? null : land(call.lines, target);
    // A target unit that also holds lines the owner answered differently on another unit.
    const mixed =
      landing === null || target == null
        ? null
        : landing.units.some((unit) => {
            const lines = target.find((t) => t.unit === unit)!.lines;
            return [...answered.values()].some(
              (other) =>
                other !== call &&
                other.range === call.range &&
                other.owner !== call.owner &&
                other.lines.some((line) => lines.has(line)),
            );
          });
    return {
      round: id.split("|")[2]!.replace(/\.json$/, ""),
      range: call.range,
      unit: call.unit,
      title: call.title,
      owner: call.owner as Lane,
      lines: call.lines.length,
      landing,
      mixed,
    };
  });
  return {
    rows,
    missingRanges: [...targets].filter(([, t]) => t === null).map(([r]) => r),
  };
};

/** A stored run's units for each case: `run/<run>/show.json` beside the pinned packet, or under `runRoot`. */
export const runTarget =
  (run: string, runRoot?: string) =>
  (entry: LoadedSet["cases"][number]): Array<TargetUnit> => {
    const file = runFileOf(entry.meta, run, runRoot);
    if (!existsSync(file)) throw new Error(`${file} is missing`);
    const where = `case ${entry.meta.caseId} (${file})`;
    return packetTarget(
      readShownFile<{ packet?: PacketLite | null }>(file, where, READS_SECTIONS)
        .packet ?? null,
      where,
    );
  };

/** The transfer in a few plain lines. */
export const describeTransfer = (
  replay: ReturnType<typeof replayTransfer>,
  owner: ReturnType<typeof ownerTransfer>,
) => {
  const sum = (key: "ranges" | "needsPerson" | "olderLabelledUnits") =>
    replay.reduce(
      (total, row) => ({
        ranges: total.ranges + row[key].ranges,
        one: total.one + row[key].one,
        several: total.several + row[key].several,
        none: total.none + row[key].none,
        unownedLines: total.unownedLines + row[key].unownedLines,
      }),
      { ranges: 0, one: 0, several: 0, none: 0, unownedLines: 0 },
    );
  const line = (what: string, t: ReturnType<typeof sum>) =>
    `${what}: ${t.ranges}; one unit ${t.one}, several ${t.several}, none ${t.none} (${t.unownedLines} line(s) no unit owns).`;
  const required = owner.rows.filter((row) => row.owner === "human-required");
  return [
    `Replay key over ${replay.length} case(s), ${replay.reduce((s, r) => s + r.units, 0)} target unit(s):`,
    `  ${line("labelled ranges", sum("ranges"))}`,
    `  ${line("needs-a-person ranges", sum("needsPerson"))}`,
    `  ${line("labelled older units", sum("olderLabelledUnits"))}`,
    `  target units joining labelled lines of several older units: ${replay.reduce((s, r) => s + r.joining, 0)}; older owned lines no target unit owns: ${replay.reduce((s, r) => s + r.olderOnly, 0)}.`,
    `Owner's key: ${owner.rows.length} answered unit(s), ${required.length} sent to a person; ${owner.rows.filter((r) => r.landing?.landing === "one").length} land in one unit, ${owner.rows.filter((r) => r.landing?.landing === "several").length} in several, ${owner.rows.filter((r) => r.landing?.landing === "none").length} in none; of those sent to a person, ${required.filter((r) => r.landing?.landing === "several").length} in several.${owner.missingRanges.length === 0 ? "" : ` No hunks for ${owner.missingRanges.join(", ")}.`}`,
  ].join("\n");
};
