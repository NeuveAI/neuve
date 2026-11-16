import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { repositories } from "../../retrieval-bench/scoring-inputs.ts";
import { loadScoringInputs } from "../../retrieval-bench/scoring-inputs.ts";
import { ensureDir } from "../common.ts";
import { DEFAULT_GOLD, loadViews } from "../score.ts";
import { FULL_TEST_RESULTS, type PhaseId } from "./config.ts";
import { packetUnits, type StoredRun } from "./packets.ts";
import { readStored } from "./phases.ts";
import { readFullTestSelection } from "./select.ts";

/**
 * FT11's later fixes. The dev gold holds later-commit items graded useful (hindsight for grading
 * only, 9.12); some are fixes of a defect the reviewed range introduced. Three steps, kept apart:
 *
 * 1. `listLaterFixes` (code): for each such item on a scored hunk, the lines its commit changed that
 *    the reviewed hunk had touched. The hunk's head-side lines are carried forward to the commit's
 *    parent through `git diff -U0 <head> <commit>^` (a line inside a later change is lost and said
 *    so), then intersected with the lines the commit itself changed. Written to `later-fixes.json`.
 * 2. The owner confirms which are fixes of a defect present in the range, in
 *    `later-fixes-confirmed.json`, beside the results and outside the gold, which never changes.
 * 3. `laterFixFindings` (code): for each confirmed fix, whether a phase's review raised a finding
 *    anchored on the head lines the fix changed.
 */

export const LATER_FIXES_FILE = join(FULL_TEST_RESULTS, "later-fixes.json");
export const LATER_FIXES_CONFIRMED = join(
  FULL_TEST_RESULTS,
  "later-fixes-confirmed.json",
);

/** A `git diff -U0` hunk header: old start and count, new start and count. */
export interface DiffHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
}

export const parseHeaders = (diff: string): Array<DiffHunk> =>
  diff.split("\n").flatMap((line) => {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    return m === null
      ? []
      : [
          {
            oldStart: Number(m[1]),
            oldLines: m[2] === undefined ? 1 : Number(m[2]),
            newStart: Number(m[3]),
            newLines: m[4] === undefined ? 1 : Number(m[4]),
          },
        ];
  });

/**
 * Where an old-side line lands on the new side of a diff, or null when a hunk changed it. A hunk
 * with no old lines (`-a,0`) inserts after line a, so lines after a shift.
 */
export const carryLine = (hunks: ReadonlyArray<DiffHunk>, line: number) => {
  let offset = 0;
  for (const hunk of [...hunks].sort((a, b) => a.oldStart - b.oldStart)) {
    if (hunk.oldLines > 0) {
      const last = hunk.oldStart + hunk.oldLines - 1;
      if (line < hunk.oldStart) break;
      if (line <= last) return null;
    } else if (line <= hunk.oldStart) break;
    offset += hunk.newLines - hunk.oldLines;
  }
  return line + offset;
};

/** The old-side lines a diff changes; an insertion touches the line it follows. */
export const changedOldLines = (hunks: ReadonlyArray<DiffHunk>) => {
  const lines = new Set<number>();
  for (const hunk of hunks)
    if (hunk.oldLines > 0)
      for (
        let line = hunk.oldStart;
        line < hunk.oldStart + hunk.oldLines;
        line++
      )
        lines.add(line);
    else lines.add(Math.max(1, hunk.oldStart));
  return lines;
};

const git = (repository: string, args: ReadonlyArray<string>) => {
  const result = Bun.spawnSync(["git", "-C", repository, ...args], {
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  return { ok: result.exitCode === 0, out: result.stdout.toString() };
};

export const LaterFix = z.strictObject({
  key: z.string(),
  caseId: z.string(),
  hunkId: z.string(),
  itemId: z.string(),
  commit: z.string(),
  path: z.string(),
  /** The reviewed hunk's head-side lines. */
  hunkLines: z.tuple([z.int(), z.int()]),
  /** The hunk's head lines the commit changed (carried to its parent and back). */
  headLinesChanged: z.array(z.int()),
  touches: z.boolean(),
  note: z.string(),
});
export type LaterFix = z.infer<typeof LaterFix>;

export const listLaterFixes = async (
  options: { readonly gold?: string | undefined } = {},
) => {
  const { raw } = await loadViews(options.gold ?? DEFAULT_GOLD);
  const selection = readFullTestSelection();
  const inputs = await loadScoringInputs();
  const scored = new Map(
    selection.selected.flatMap((range) =>
      range.scoredHunks.map((hunkId) => [hunkId, range] as const),
    ),
  );
  const m4 = new Map(
    inputs.cases.flatMap((entry) =>
      entry.hunks.map((hunk) => [hunk.id, hunk] as const),
    ),
  );
  const out: Array<LaterFix> = [];
  for (const [hunkId, gold] of raw) {
    const range = scored.get(hunkId);
    const hunk = m4.get(hunkId);
    if (range === undefined || hunk === undefined) continue;
    const repo = repositories[range.repository as "neuve" | "neuve_effect"];
    for (const item of gold.items) {
      const region =
        (item as { region?: string; availability?: string }).region ?? "";
      const availability = (item as { availability?: string }).availability;
      const commit = /^commit ([0-9a-f]{7,40})$/.exec(region)?.[1];
      if (
        availability !== "commit-later" ||
        item.grade !== "useful" ||
        commit === undefined
      )
        continue;
      const start = hunk.new.start;
      const end = hunk.new.start + Math.max(hunk.new.lines, 1) - 1;
      const base = {
        key: `${hunkId}:${item.id}`,
        caseId: range.caseId,
        hunkId,
        itemId: item.id,
        commit,
        path: hunk.path,
        hunkLines: [start, end] as [number, number],
      };
      const forward = git(repo, [
        "diff",
        "--no-color",
        "--no-renames",
        "-U0",
        range.head,
        `${commit}^`,
        "--",
        hunk.path,
      ]);
      const own = git(repo, [
        "diff",
        "--no-color",
        "--no-renames",
        "-U0",
        `${commit}^`,
        commit,
        "--",
        hunk.path,
      ]);
      if (!forward.ok || !own.ok) {
        out.push({
          ...base,
          headLinesChanged: [],
          touches: false,
          note: "git could not compare the commit with the range's head",
        });
        continue;
      }
      const changed = changedOldLines(parseHeaders(own.out));
      const carried = parseHeaders(forward.out);
      const headLinesChanged: Array<number> = [];
      let lost = 0;
      for (let line = start; line <= end; line++) {
        const at = carryLine(carried, line);
        if (at === null) lost++;
        else if (changed.has(at)) headLinesChanged.push(line);
      }
      out.push({
        ...base,
        headLinesChanged,
        touches: headLinesChanged.length > 0,
        note:
          lost === 0
            ? ""
            : `${lost} of the hunk's lines were changed between the head and the commit's parent and are not carried`,
      });
    }
  }
  ensureDir(FULL_TEST_RESULTS);
  writeFileSync(
    LATER_FIXES_FILE,
    `${JSON.stringify({ schemaVersion: 1, note: "Later-commit items graded useful on scored hunks, with the lines each commit changed that the reviewed hunk had touched. Hindsight for grading only (9.12); the owner confirms which are fixes in later-fixes-confirmed.json.", items: out }, null, 2)}\n`,
  );
  return out;
};

export const Confirmations = z.strictObject({
  schemaVersion: z.literal(1),
  /** Keyed by a listing's `key`: the owner's reading of whether the commit fixes a defect in the range. */
  confirmations: z.record(z.string(), z.enum(["fix", "not-a-fix", "unsure"])),
});

/** For each confirmed fix, whether each phase's review raised a finding on the lines it changed. */
export const laterFixFindings = (
  phases: ReadonlyArray<PhaseId> = ["A", "A2", "C"],
) => {
  if (!existsSync(LATER_FIXES_FILE))
    return {
      measured: false as const,
      note: "not measured: the later fixes are not listed yet (full-test later-fixes)",
    };
  if (!existsSync(LATER_FIXES_CONFIRMED))
    return {
      measured: false as const,
      note: "not measured: the owner has not confirmed which later commits are fixes",
    };
  const listed = z
    .array(LaterFix)
    .parse(
      (JSON.parse(readFileSync(LATER_FIXES_FILE, "utf8")) as { items: unknown })
        .items,
    );
  const confirmed = Confirmations.parse(
    JSON.parse(readFileSync(LATER_FIXES_CONFIRMED, "utf8")),
  ).confirmations;
  const fixes = listed.filter((entry) => confirmed[entry.key] === "fix");
  return {
    measured: true as const,
    confirmed: fixes.length,
    results: fixes.map((fix) => ({
      key: fix.key,
      caseId: fix.caseId,
      byPhase: Object.fromEntries(
        phases.map((phase) => {
          const run = readStored<StoredRun>(fix.caseId, phase);
          if (run === undefined) return [phase, null];
          const lines = new Set(fix.headLinesChanged);
          const raised = packetUnits(run.packet).some(({ unit }) =>
            unit.comments.some((comment) => {
              const anchor = comment.payload.anchor;
              if (comment.payload.finding === undefined || anchor === undefined)
                return false;
              if (anchor.side !== "new" || anchor.path !== fix.path)
                return false;
              for (let line = anchor.startLine; line <= anchor.endLine; line++)
                if (lines.has(line)) return true;
              return false;
            }),
          );
          return [phase, raised];
        }),
      ),
    })),
  };
};
