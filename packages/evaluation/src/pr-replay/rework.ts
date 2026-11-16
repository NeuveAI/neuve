import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { gerritTime } from "./gerrit.ts";
import { git } from "./providers.ts";
import type { CaseRecord } from "./schema.ts";
import {
  SOURCES,
  caseDirectory,
  mirrorPath,
  type SourceName,
} from "./sources.ts";

/**
 * The rework map (design §3 step 2): which lines the first revision added were changed again
 * before the change merged, and which were changed or reverted within 90 days after it landed,
 * the history signal of reworked ranges (10.123, 10.128). Pure git over the source's mirror, the
 * evaluator's side only; no model. It records what changed and by which commit; whether a later
 * change was a fix is the labeller's call.
 *
 * Only the first revision's added lines (`<path>:new:<line>`) are tracked: a deleted line has no
 * later life to follow. Lines are followed through each step by `git diff -U0`, across renames
 * (`git diff -M`). A file deleted by the final revision counts all its lines as changed before
 * merge; a line that cannot be followed to the landed commit is counted in `untracked`. The window
 * starts when the provider recorded the landing (Gerrit's submit, GitHub's merge), and a mirror
 * older than the window's end is noted, since it cuts the window short. An upstream edit that a
 * rebase brings into the same lines would count as rework (rare, since the lines are the change's
 * own).
 */

export const REWORK_DAYS = 90;

export const ReworkMap = z.strictObject({
  version: z.literal(1),
  caseId: z.string().min(1),
  /** The first revision's added lines, the denominator. */
  firstLines: z.int().min(0),
  /** The commit the change landed as on its target branch, when found. */
  landed: z.string().nullable(),
  /** The target branch's last commit within the window after landing. */
  windowEnd: z.string().nullable(),
  untracked: z.int().min(0),
  lines: z.record(
    z.string(),
    z.strictObject({
      beforeMerge: z.boolean(),
      afterMerge: z
        .strictObject({
          commit: z.string(),
          subject: z.string(),
          days: z.number(),
          revert: z.boolean(),
        })
        .nullable(),
    }),
  ),
  notes: z.array(z.string()),
});
export type ReworkMap = z.infer<typeof ReworkMap>;

interface Hunk {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
}

/**
 * `git diff -U0` hunks of one path between two commits. A path renamed between them is named on
 * both sides (`renamedFrom`), so rename detection pairs the two files instead of reading the new
 * one as wholly added.
 */
export const hunks = (
  mirror: string,
  from: string,
  to: string,
  path: string,
  renamedFrom?: string,
) => {
  const out: Array<Hunk> = [];
  for (const line of git(mirror, [
    "diff",
    "-U0",
    "-M",
    "--no-color",
    from,
    to,
    "--",
    ...(renamedFrom === undefined ? [] : [renamedFrom]),
    path,
  ]).stdout.split("\n")) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match !== null)
      out.push({
        oldStart: Number(match[1]),
        oldCount: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newCount: match[4] === undefined ? 1 : Number(match[4]),
      });
  }
  return out;
};

/** A line of `from` in `to`, or null when a hunk changed or removed it. */
export const follow = (
  diff: ReadonlyArray<Hunk>,
  line: number,
): number | null => {
  let shift = 0;
  for (const hunk of diff) {
    // A zero-count old side is a pure insertion after `oldStart`.
    const first = hunk.oldCount === 0 ? hunk.oldStart + 1 : hunk.oldStart;
    if (line < first) break;
    if (hunk.oldCount > 0 && line < hunk.oldStart + hunk.oldCount) return null;
    shift += hunk.newCount - hunk.oldCount;
  }
  return line + shift;
};

/** `git diff --name-status -M -z` between two commits: NUL-separated, so any path survives. */
const nameStatus = (mirror: string, from: string, to: string) => {
  const fields = git(mirror, ["diff", "--name-status", "-M", "-z", from, to])
    .stdout.split("\0")
    .filter((field) => field !== "");
  const out: Array<{ status: string; oldPath: string; newPath: string }> = [];
  for (let at = 0; at < fields.length;) {
    const status = fields[at]!;
    const paired = status.startsWith("R") || status.startsWith("C");
    const oldPath = fields[at + 1]!;
    const newPath = paired ? fields[at + 2]! : oldPath;
    out.push({ status, oldPath, newPath });
    at += paired ? 3 : 2;
  }
  return out;
};

/** The first revision's added lines, by path. */
export const addedLines = (mirror: string, base: string, head: string) => {
  const byPath = new Map<string, Array<number>>();
  for (const entry of nameStatus(mirror, base, head)) {
    if (!/^[AMR]/.test(entry.status)) continue;
    const renamed = entry.status.startsWith("R");
    const lines: Array<number> = [];
    for (const hunk of hunks(
      mirror,
      base,
      head,
      entry.newPath,
      renamed ? entry.oldPath : undefined,
    ))
      for (let at = 0; at < hunk.newCount; at++) lines.push(hunk.newStart + at);
    if (lines.length > 0) byPath.set(entry.newPath, lines);
  }
  return byPath;
};

/**
 * Where a path of `from` is in `to`: its new name when renamed, null when deleted. A rename found
 * here is passed to `hunks` as `renamedFrom`, so a rename alone changes no line.
 */
const pathIn = (
  renames: ReadonlyArray<{ status: string; oldPath: string; newPath: string }>,
  path: string,
) => {
  const entry = renames.find((candidate) => candidate.oldPath === path);
  if (entry === undefined || entry.status.startsWith("M"))
    return { path, renamedFrom: undefined };
  if (entry.status.startsWith("D")) return null;
  if (entry.status.startsWith("R"))
    return { path: entry.newPath, renamedFrom: entry.oldPath };
  return { path, renamedFrom: undefined };
};

const exists = (mirror: string, commit: string, path: string) =>
  git(mirror, ["cat-file", "-e", `${commit}:${path}`], true).code === 0;

const commitTime = (mirror: string, commit: string) =>
  new Date(git(mirror, ["show", "-s", "--format=%cI", commit]).stdout.trim());

/**
 * Where the change landed on its target branch: the recorded merged commit when the branch
 * contains it, else (ghstack lands a copy) the branch's commit with the same subject within three
 * days of the pull request's merge.
 */
const landedCommit = (
  mirror: string,
  record: CaseRecord,
  notes: Array<string>,
) => {
  const merged = record.later?.merged ?? null;
  if (
    merged !== null &&
    git(mirror, ["merge-base", "--is-ancestor", merged, "HEAD"], true).code ===
      0
  )
    return merged;
  if (record.provider !== "github") return null;
  const pull = JSON.parse(
    readFileSync(
      join(
        caseDirectory(record.source as SourceName, record.number),
        "capture",
        "pull.json",
      ),
      "utf8",
    ),
  ) as { merged_at: string | null; title: string };
  if (pull.merged_at === null) return null;
  const since = new Date(
    new Date(pull.merged_at).getTime() - 86_400_000,
  ).toISOString();
  const until = new Date(
    new Date(pull.merged_at).getTime() + 3 * 86_400_000,
  ).toISOString();
  const found = git(mirror, [
    "log",
    "HEAD",
    "--first-parent",
    `--since=${since}`,
    `--until=${until}`,
    "--format=%H%x09%s",
  ])
    .stdout.split("\n")
    .map((line) => line.split("\t"))
    .filter(
      ([, subject]) =>
        subject !== undefined &&
        subject.startsWith(pull.title.split("\n")[0]!.slice(0, 60)),
    );
  if (found.length === 1) {
    notes.push("landed found by subject on the target branch");
    return found[0]![0]!;
  }
  notes.push(`landed commit not found (${found.length} subject matches)`);
  return null;
};

/** The new name `path` has in `to` when the step from `from` renamed it, else null. */
const renamedIn = (mirror: string, from: string, to: string, path: string) =>
  nameStatus(mirror, from, to).find(
    (entry) => entry.status.startsWith("R") && entry.oldPath === path,
  )?.newPath ?? null;

/** For each line of `landed`, the commit after it that changed the line before `end`, if any. */
const changedAfter = (
  mirror: string,
  landed: string,
  end: string,
  path: string,
  depth = 0,
): Map<number, string> => {
  const changed = new Map<number, string>();
  const porcelain = git(
    mirror,
    ["blame", "--reverse", "--porcelain", `${landed}..${end}`, "--", path],
    true,
  );
  if (porcelain.code !== 0) return changed;
  const lastSeen = new Map<string, Array<number>>();
  for (const line of porcelain.stdout.split("\n")) {
    const header = /^([0-9a-f]{40}) \d+ (\d+)/.exec(line);
    if (header === null) continue;
    if (header[1] === end) continue;
    const list = lastSeen.get(header[1]!) ?? [];
    list.push(Number(header[2]));
    lastSeen.set(header[1]!, list);
  }
  for (const [survivedUntil, lines] of lastSeen) {
    // The line's last version is `survivedUntil`; its child on the way to `end` changed or removed
    // it. The child is found without a path filter, since the path may be renamed there.
    const child = git(mirror, [
      "rev-list",
      "--ancestry-path",
      "--reverse",
      "--parents",
      `${survivedUntil}..${end}`,
    ])
      .stdout.split("\n")
      .map((line) => line.split(" "))
      .find((row) => row.slice(1).includes(survivedUntil))?.[0];
    if (child === undefined) continue;
    // A child that only renamed the file moved the line, not changed it: follow it under the new
    // name from there, a few renames deep at most.
    const renamed =
      depth < 5 ? renamedIn(mirror, survivedUntil, child, path) : null;
    if (renamed !== null) {
      const moved = hunks(mirror, survivedUntil, child, renamed, path);
      const followed = new Map<number, number>();
      for (const line of lines) {
        const at = follow(moved, line);
        if (at === null) changed.set(line, child);
        else followed.set(at, line);
      }
      if (followed.size > 0)
        for (const [at, commit] of changedAfter(
          mirror,
          child,
          end,
          renamed,
          depth + 1,
        ))
          if (followed.has(at)) changed.set(followed.get(at)!, commit);
      continue;
    }
    for (const line of lines) changed.set(line, child);
  }
  return changed;
};

/** When the provider recorded the change landing: Gerrit's submit time, GitHub's merge time. */
const capturedLandingTime = (record: CaseRecord): Date | null => {
  const directory = join(
    caseDirectory(record.source as SourceName, record.number),
    "capture",
  );
  if (record.provider === "gerrit") {
    const detail = JSON.parse(
      readFileSync(join(directory, "detail.json"), "utf8"),
    ) as { submitted?: string };
    return detail.submitted === undefined
      ? null
      : new Date(gerritTime(detail.submitted));
  }
  const pull = JSON.parse(
    readFileSync(join(directory, "pull.json"), "utf8"),
  ) as { merged_at: string | null };
  return pull.merged_at === null ? null : new Date(pull.merged_at);
};

export const reworkMap = (record: CaseRecord): ReworkMap => {
  if (record.firstRevision === null)
    throw new Error(`${record.caseId} has no first revision`);
  const mirror = mirrorPath(SOURCES[record.source as SourceName]);
  const { base, head } = record.firstRevision;
  const notes: Array<string> = [];
  const added = addedLines(mirror, base, head);
  const final = record.later?.finalHead ?? null;
  const landed = landedCommit(mirror, record, notes);
  let windowEnd: string | null = null;
  let landedAt: Date | null = null;
  if (landed !== null) {
    landedAt = capturedLandingTime(record) ?? commitTime(mirror, landed);
    const until = new Date(
      landedAt.getTime() + REWORK_DAYS * 86_400_000,
    ).toISOString();
    windowEnd =
      git(mirror, [
        "rev-list",
        "-1",
        "--first-parent",
        `--before=${until}`,
        "HEAD",
      ]).stdout.trim() || null;
    const newest = commitTime(mirror, "HEAD");
    if (newest.getTime() < new Date(until).getTime())
      notes.push(
        `the mirror's newest commit is ${newest.toISOString()}, before the window's end ${until}: the window is cut short`,
      );
  }
  const toFinal =
    final !== null && final !== head ? nameStatus(mirror, head, final) : [];
  const toLandedNames = landed !== null ? nameStatus(mirror, head, landed) : [];
  const lines: ReworkMap["lines"] = {};
  let untracked = 0;
  const subjects = new Map<string, string>();
  for (const [path, numbers] of added) {
    const inFinal =
      final !== null && final !== head ? pathIn(toFinal, path) : null;
    const beforeDiff =
      inFinal !== null && exists(mirror, final!, inFinal.path)
        ? hunks(mirror, head, final!, inFinal.path, inFinal.renamedFrom)
        : null;
    const inLandedPath = landed !== null ? pathIn(toLandedNames, path) : null;
    const toLanded =
      inLandedPath !== null && exists(mirror, landed!, inLandedPath.path)
        ? hunks(
            mirror,
            head,
            landed!,
            inLandedPath.path,
            inLandedPath.renamedFrom,
          )
        : null;
    const after =
      landed !== null && windowEnd !== null && toLanded !== null
        ? changedAfter(mirror, landed, windowEnd, inLandedPath!.path)
        : null;
    for (const line of numbers) {
      const beforeMerge =
        final !== null && final !== head
          ? beforeDiff === null || follow(beforeDiff, line) === null
          : false;
      let afterMerge: ReworkMap["lines"][string]["afterMerge"] = null;
      if (landed !== null) {
        const inLanded = toLanded === null ? null : follow(toLanded, line);
        if (inLanded === null) {
          if (!beforeMerge) untracked++;
        } else {
          const commit = after?.get(inLanded);
          if (commit !== undefined) {
            const subject =
              subjects.get(commit) ??
              git(mirror, ["show", "-s", "--format=%s", commit]).stdout.trim();
            subjects.set(commit, subject);
            afterMerge = {
              commit,
              subject,
              days:
                Math.round(
                  ((commitTime(mirror, commit).getTime() -
                    landedAt!.getTime()) /
                    86_400_000) *
                    10,
                ) / 10,
              revert: /^Revert\b/.test(subject),
            };
          }
        }
      }
      lines[`${path}:new:${line}`] = { beforeMerge, afterMerge };
    }
  }
  return ReworkMap.parse({
    version: 1,
    caseId: record.caseId,
    firstLines: Object.keys(lines).length,
    landed,
    windowEnd,
    untracked,
    lines: Object.fromEntries(
      Object.entries(lines).filter(
        ([, entry]) => entry.beforeMerge || entry.afterMerge !== null,
      ),
    ),
    notes,
  });
};

export const writeReworkMap = (record: CaseRecord) => {
  const map = reworkMap(record);
  const directory = join(
    caseDirectory(record.source as SourceName, record.number),
    "labels",
  );
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "rework.json"),
    `${JSON.stringify(map, null, 2)}\n`,
  );
  return map;
};
