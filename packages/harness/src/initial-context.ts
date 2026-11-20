import { capCommitTitle, reviewMessage } from "./git.ts";
import { dataBlock } from "./data-block.ts";
import type { Frame } from "./frame.ts";
import type { CommitText } from "./git-objects.ts";
import type { ManifestHunk } from "./manifest.ts";
import { mapExclusion } from "./review-map.ts";

/**
 * The finders' opening (12.49, amended 12 November 2026): built by code from what the range view
 * already holds, never from Map, Graph or a new Git read, and byte-identical for the same range,
 * Frame and scope. In order:
 *
 * 1. **Frame:** the goal, stratum, sources, gaps and done-when rows, whole, as before.
 * 2. **Scope:** the scope sections the done-when rows cite, once, so no lens fetches them. Whole
 *    sections in done-when order within `SCOPE_SHARE` of the limit; a section that does not fit
 *    whole is cut at a line and says so; the rest are listed by ID.
 * 3. **Index:** every changed file, with status, lines added and deleted, hunk count and what to
 *    ask for it. Files whose diffs follow are always named; the others fold into counted folders
 *    when the index outgrows `INDEX_SHARE` (parts fold with counts and are never dropped).
 * 4. **Diff:** the files that fit, in `fileOrder`, each whole: old and new line numbers, deleted
 *    lines shown, owned changed lines marked, each hunk under its ID and enclosing symbols. When no
 *    file fits whole, the first in order is cut at a hunk and says so.
 * 5. **Log:** 12.49's commit list within `LOG_SHARE`.
 *
 * One limit, `OPENING_CHARS`, sizes it all; the shares are fractions of it, and the diff takes
 * whatever the other parts leave.
 */
export const OPENING_CHARS = 50_000;
export const INITIAL_LOG_CHARS = 16_000;
export const SCOPE_SHARE = 0.15;
export const INDEX_SHARE = 0.15;
export const LOG_SHARE = 0.1;

/** A scope section a done-when row cites, as the find step read it from the snapshot. */
export interface OpeningSection {
  readonly id: string;
  /** Absent when the snapshot holds no section of that ID. */
  readonly header?: string | undefined;
  readonly text?: string | undefined;
  readonly disclosure?: string | undefined;
}
export interface OpeningInput {
  readonly frame: Frame;
  readonly hunks: ReadonlyMap<string, ManifestHunk>;
  readonly sections?: ReadonlyArray<OpeningSection>;
  /** Newest first, in Git log order. */
  readonly commits?: ReadonlyArray<CommitText>;
  readonly mergeFiles?: ReadonlyMap<string, ReadonlyArray<string>> | undefined;
  readonly commitFiles?: ReadonlyMap<string, ReadonlyArray<string>> | undefined;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const line = (text: string) => text.replace(/[\r\n\t\u2028\u2029]/g, " ");
const number = (n: number) => n.toLocaleString("en-US");
const status = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  "type-changed": "T",
};
type File = { path: string; added: number; deleted: number; status: string };

// Record 0015, "What hottest means": architecture/decisions/0015-range-snapshot-and-git-reader.md.
// Without Graph facts the rank is lines changed alone, with path breaking ties.
export const rankInitialFiles = <F extends File>(files: ReadonlyArray<F>) =>
  [...files].sort(
    (a, b) =>
      b.added + b.deleted - a.added - a.deleted || compare(a.path, b.path),
  );

const initialLogLines = (commits: ReadonlyArray<CommitText>) =>
  commits.map(
    (c) =>
      `${c.oid.slice(0, 8)} ${line(reviewMessage(capCommitTitle(c.subject)))}`,
  );

// Scores in the heap are upper bounds. Only the next candidate is rescored after a pick.
// Equal scores retain Git log order, including when a stale candidate is reinserted.
export const initialLog = (
  commits: ReadonlyArray<CommitText>,
  files: ReadonlyArray<File>,
  commitFiles: OpeningInput["commitFiles"],
  limit = INITIAL_LOG_CHARS,
  mergeFiles: OpeningInput["mergeFiles"] = undefined,
  floorOnly = false,
  lines: ReadonlyArray<string> = initialLogLines(commits),
) => {
  const selected = new Set<number>();
  const render = () => {
    const out: string[] = [];
    let skipped = 0;
    for (let i = 0; i < commits.length; i++) {
      if (!selected.has(i)) {
        skipped++;
        continue;
      }
      if (skipped) out.push(`… ${skipped} commits`);
      skipped = 0;
      out.push(lines[i]!);
    }
    if (skipped) out.push(`… ${skipped} commits`);
    return out.join("\n");
  };
  if (!floorOnly && lines.join("\n").length <= limit) {
    commits.forEach((_, i) => selected.add(i));
  } else {
    const heat = new Map(
      rankInitialFiles(files).map((f, i) => [f.path, files.length - i]),
    );
    const uncovered = new Set(heat.keys());
    const paths = commits.map((c) =>
      mergeFiles?.has(c.oid) ? [] : [...new Set(commitFiles?.get(c.oid) ?? [])],
    );
    const reachable = new Set(paths.flat());
    const hottest = new Set(
      [...heat.keys()]
        .slice(0, Math.ceil(files.length / 10))
        .filter((path) => reachable.has(path)),
    );
    const score = (i: number) =>
      paths[i]!.reduce(
        (n, p) => n + (uncovered.has(p) ? (heat.get(p) ?? 0) : 0),
        0,
      );
    type Pick = { i: number; score: number };
    const heap: Pick[] = [];
    const ahead = (a: Pick, b: Pick) =>
      a.score > b.score || (a.score === b.score && a.i < b.i);
    const push = (pick: Pick) => {
      let at = heap.length;
      heap.push(pick);
      while (at > 0) {
        const parent = (at - 1) >> 1;
        if (!ahead(pick, heap[parent]!)) break;
        heap[at] = heap[parent]!;
        at = parent;
      }
      heap[at] = pick;
    };
    const pop = () => {
      const top = heap[0]!;
      const last = heap.pop()!;
      if (heap.length) {
        let at = 0;
        while (at * 2 + 1 < heap.length) {
          let child = at * 2 + 1;
          if (child + 1 < heap.length && ahead(heap[child + 1]!, heap[child]!))
            child++;
          if (!ahead(heap[child]!, last)) break;
          heap[at] = heap[child]!;
          at = child;
        }
        heap[at] = last;
      }
      return top;
    };
    // Account for an insertion by replacing its one gap with up to two gaps.
    // This avoids re-rendering the entire log for each candidate.
    const gap = (n: number) => (n > 0 ? `… ${n} commits`.length + 1 : 0);
    // Occupied leaves mark selected log positions. Neighbour searches and inserts
    // take logarithmic time, even for an uncapped coverage floor in reverse order.
    let width = 1;
    while (width < commits.length) width *= 2;
    const occupied = new Uint8Array(width * 2);
    const neighbour = (i: number, direction: -1 | 1) => {
      let at = width + i;
      while (at > 1) {
        if (at % 2 === (direction === -1 ? 1 : 0) && occupied[at + direction]) {
          at += direction;
          while (at < width) {
            const child = at * 2 + (direction === -1 ? 1 : 0);
            at = occupied[child] ? child : child + direction;
          }
          return at - width;
        }
        at = Math.floor(at / 2);
      }
      return direction === -1 ? -1 : commits.length;
    };
    let chars = gap(commits.length) - 1;
    const add = (i: number) => {
      const left = neighbour(i, -1),
        right = neighbour(i, 1);
      const cost =
        lines[i]!.length +
        1 +
        gap(i - left - 1) +
        gap(right - i - 1) -
        gap(right - left - 1);
      if (chars + cost > limit) return false;
      chars += cost;
      for (let at = width + i; at > 0 && !occupied[at]; at = Math.floor(at / 2))
        occupied[at] = 1;
      selected.add(i);
      return true;
    };
    commits.forEach((_, i) => {
      const value = score(i);
      if (value > 0) push({ i, score: value });
    });
    while (heap.length && (!floorOnly || hottest.size > 0)) {
      const pick = pop();
      const value = score(pick.i);
      if (value === 0) continue;
      const updated = { i: pick.i, score: value };
      if (heap[0] !== undefined && ahead(heap[0], updated)) {
        push(updated);
        continue;
      }
      if (add(pick.i))
        for (const path of paths[pick.i]!) {
          uncovered.delete(path);
          hottest.delete(path);
        }
    }
    // Once coverage is spent, merge titles summarise lanes before other zero-heat commits.
    for (const merges of floorOnly ? [] : [true, false])
      commits.forEach((c, i) => {
        if (!selected.has(i) && Boolean(mergeFiles?.has(c.oid)) === merges)
          add(i);
      });
  }
  return {
    text: render(),
    shown: new Set([...selected].map((i) => commits[i]!.oid)),
  };
};

/** One changed file of the range, from the manifest's hunks (which never split a hunk across files). */
type ChangedFile = File & {
  readonly hunks: ReadonlyArray<ManifestHunk>;
  /** 0 source, 1 declared tests, 2 declared documentation, 3 lockfiles and declared-generated files. */
  readonly rank: 0 | 1 | 2 | 3;
  readonly reviewed: boolean;
};

const filesOf = (hunks: ReadonlyMap<string, ManifestHunk>): ChangedFile[] => {
  const byPath = new Map<string, ManifestHunk[]>();
  for (const h of hunks.values())
    byPath.set(h.path, [...(byPath.get(h.path) ?? []), h]);
  return [...byPath].map(([path, list]) => {
    const ordered = [...list].sort(
      (a, b) =>
        a.oldStart - b.oldStart ||
        a.newStart - b.newStart ||
        compare(a.hunkId, b.hunkId),
    );
    const kinds = new Set(
      ordered.flatMap((h) => h.declared.map((d) => d.kind)),
    );
    // The files no Map group holds (`mapExclusion`), last in the diff order and marked not reviewed.
    const light = mapExclusion(path, ordered) !== undefined;
    return {
      path,
      status: status[ordered[0]!.status],
      added: ordered.reduce((n, h) => n + h.added, 0),
      deleted: ordered.reduce((n, h) => n + h.deleted, 0),
      hunks: ordered,
      rank: light ? 3 : kinds.has("doc") ? 2 : kinds.has("test") ? 1 : 0,
      reviewed: !light,
    };
  });
};

/**
 * Which files' diffs go in, and in which order: source before declared tests, tests before
 * declared documentation, lockfiles and declared-generated files last (test and documentation
 * only as the repository declares them, never by name, 10.23); within a class by lines changed,
 * most first, path breaking ties. A file goes in whole or not at all, taken in this order while it
 * fits (a file that does not fit is skipped and the next tried). Only when no file fits whole does
 * the first in order go in cut at a hunk, and it says so.
 */
export const fileOrder = <F extends ChangedFile>(files: ReadonlyArray<F>) =>
  [...files].sort(
    (a, b) =>
      a.rank - b.rank ||
      b.added + b.deleted - a.added - a.deleted ||
      compare(a.path, b.path),
  );

const owned = (h: ManifestHunk, side: "old" | "new", n: number) =>
  h.ownedRanges.some(
    (r) =>
      r.side === side &&
      r.lineCount > 0 &&
      n >= r.startLine &&
      n < r.startLine + r.lineCount,
  );

const pad = (n: number | undefined) =>
  (n === undefined ? "" : String(n)).padStart(5, " ");

type HunkLines = {
  readonly text: string;
  readonly added: number;
  readonly deleted: number;
  readonly context: number;
  readonly ownedAdded: number;
  readonly ownedDeleted: number;
  /** The new-side lines the hunk shows, which count as read (`recordingHeadReads`). */
  readonly head?: { startLine: number; endLine: number } | undefined;
  /** The old-side and new-side lines the hunk shows, first to last, for the run log only. */
  readonly old?: readonly [number, number] | undefined;
  readonly new?: readonly [number, number] | undefined;
};

/** One hunk as the diff shows it: under its ID and enclosing symbols, each line numbered on both sides. */
const hunkLines = (h: ManifestHunk): HunkLines => {
  const symbols = h.enclosing?.symbols ?? [];
  const title = `${h.hunkId}${symbols.length ? ` in ${symbols.map(line).join(", ")}` : ""}`;
  if (h.kind !== "text")
    return {
      text: `${title} ${h.kind} change, no text lines`,
      added: 0,
      deleted: 0,
      context: 0,
      ownedAdded: 0,
      ownedDeleted: 0,
    };
  const [header = "", ...body] = h.text.split("\n");
  const at = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
  let oldLine = Number(at?.[1] ?? h.oldStart);
  let newLine = Number(at?.[3] ?? h.newStart);
  const out = [`${title} ${at?.[0] ?? line(header)}`];
  let added = 0,
    deleted = 0,
    context = 0,
    ownedAdded = 0,
    ownedDeleted = 0,
    first: number | undefined,
    last: number | undefined,
    firstOld: number | undefined,
    lastOld: number | undefined;
  for (const raw of body) {
    const sign = raw[0];
    const text = line(raw.slice(1));
    if (sign === "-") {
      const mark = owned(h, "old", oldLine);
      out.push(
        `${pad(oldLine)} ${pad(undefined)} -${mark ? "*" : " "} ${text}`,
      );
      deleted++;
      if (mark) ownedDeleted++;
      firstOld ??= oldLine;
      lastOld = oldLine;
      oldLine++;
    } else if (sign === "+") {
      const mark = owned(h, "new", newLine);
      out.push(
        `${pad(undefined)} ${pad(newLine)} +${mark ? "*" : " "} ${text}`,
      );
      added++;
      if (mark) ownedAdded++;
      first ??= newLine;
      last = newLine;
      newLine++;
    } else if (sign === " ") {
      out.push(`${pad(oldLine)} ${pad(newLine)}    ${text}`);
      context++;
      first ??= newLine;
      last = newLine;
      firstOld ??= oldLine;
      lastOld = oldLine;
      oldLine++;
      newLine++;
    } else if (sign === "\\") out.push(`            ${line(raw)}`);
  }
  return {
    text: out.join("\n"),
    added,
    deleted,
    context,
    ownedAdded,
    ownedDeleted,
    head:
      h.status === "deleted" || first === undefined || last === undefined
        ? undefined
        : { startLine: first, endLine: last },
    old:
      firstOld === undefined || lastOld === undefined
        ? undefined
        : [firstOld, lastOld],
    new: first === undefined || last === undefined ? undefined : [first, last],
  };
};

const fileHeader = (f: ChangedFile) => {
  const h = f.hunks[0]!;
  const renamed =
    h.oldPath !== null && h.newPath !== null && h.oldPath !== h.newPath;
  return `${line(f.path)} ${f.status}${renamed ? ` from ${line(h.oldPath!)}` : ""}`;
};

const cutLine = (file: ChangedFile, count: number) =>
  `[diff cut: ${count} of ${file.hunks.length} hunks shown; the others are ${file.hunks
    .slice(count)
    .map((h) => h.hunkId)
    .join(" ")}, from read_many with fromHunk ${file.hunks[count]!.hunkId}]`;

type Shown = {
  readonly file: ChangedFile;
  readonly hunks: ReadonlyArray<{ hunk: ManifestHunk; lines: HunkLines }>;
  readonly cut: boolean;
};

/** The diff that fits in `budget`, files in `fileOrder`, each whole, or the first oversize one cut at a hunk. */
const selectDiff = (
  ordered: ReadonlyArray<ChangedFile>,
  rendered: ReadonlyMap<string, ReadonlyArray<HunkLines>>,
  budget: number,
) => {
  const shown: Shown[] = [];
  let used = "Diff".length;
  // Exactly what `renderDiff` adds for the file: each line after a newline.
  const sizeOf = (f: ChangedFile, count: number) =>
    1 +
    fileHeader(f).length +
    rendered
      .get(f.path)!
      .slice(0, count)
      .reduce((n, h) => n + h.text.length + 1, 0) +
    (count < f.hunks.length ? 1 + cutLine(f, count).length : 0);
  for (const file of ordered) {
    const whole = sizeOf(file, file.hunks.length);
    if (used + whole <= budget) {
      shown.push({
        file,
        hunks: file.hunks.map((hunk, i) => ({
          hunk,
          lines: rendered.get(file.path)![i]!,
        })),
        cut: false,
      });
      used += whole;
    }
  }
  // No file fits whole: the first in order goes in cut at a hunk, said to be cut, rather than none.
  // (Measured on the ladder ranges, cutting every oversize file as it came spent the share on the
  // head of one huge file; whole files fit there.)
  const first = ordered.find((file) => file.hunks.length > 0);
  if (shown.length === 0 && first !== undefined) {
    let count = 0;
    while (
      count < first.hunks.length &&
      used + sizeOf(first, count + 1) <= budget
    )
      count++;
    if (count > 0)
      shown.push({
        file: first,
        hunks: first.hunks.slice(0, count).map((hunk, i) => ({
          hunk,
          lines: rendered.get(first.path)![i]!,
        })),
        cut: true,
      });
  }
  return shown;
};

const renderDiff = (shown: ReadonlyArray<Shown>) =>
  shown.length === 0
    ? ""
    : [
        "Diff",
        ...shown.flatMap(({ file, hunks, cut }) => [
          fileHeader(file),
          ...hunks.map((h) => h.lines.text),
          ...(cut ? [cutLine(file, hunks.length)] : []),
        ]),
      ].join("\n");

const fileRow = (f: ChangedFile, shown: Shown | undefined) =>
  `${f.status} ${line(f.path)} +${number(f.added)} -${number(f.deleted)} ${f.hunks.length} hunk${f.hunks.length === 1 ? "" : "s"} [${
    shown === undefined
      ? !f.reviewed
        ? "not reviewed"
        : f.hunks.length <= 3
          ? `read_many: ${f.hunks.map((h) => h.hunkId).join(" ")}`
          : "read_many by path"
      : `${shown.cut ? "diff cut below" : "diff below"}${f.reviewed ? "" : ", not reviewed"}`
  }]`;

const parentFolder = (path: string) => {
  const slash = path.lastIndexOf("/");
  return slash <= 0 ? "." : path.slice(0, slash);
};
/** A path's folder cut to `depth` segments; "." at depth 0 or for a top-level file. */
const folderAt = (path: string, depth: number) => {
  const folder = parentFolder(path);
  if (folder === "." || depth === 0) return ".";
  return folder.split("/").slice(0, depth).join("/");
};

/**
 * The index: a total, then a row per file whose diff follows and, while they fit `share`, every
 * other file; otherwise the other files fold into counted folders at the deepest level that fits.
 * Every changed file is counted exactly once.
 */
const renderIndex = (
  files: ReadonlyArray<ChangedFile>,
  shown: ReadonlyArray<Shown>,
  share: number,
) => {
  const byPath = new Map(shown.map((s) => [s.file.path, s]));
  const total = `Index: ${number(files.length)} files +${number(files.reduce((n, f) => n + f.added, 0))} -${number(files.reduce((n, f) => n + f.deleted, 0))}, ${number(files.reduce((n, f) => n + f.hunks.length, 0))} hunks; the diffs of ${number(shown.length)} files follow${shown.some((s) => s.cut) ? ", one of them cut" : ""}.`;
  const all = [total, ...files.map((f) => fileRow(f, byPath.get(f.path)))];
  const whole = all.join("\n");
  if (whole.length <= share)
    return { text: whole, named: files.length, folded: 0 };
  const named = files.filter((f) => byPath.has(f.path));
  const rest = files.filter((f) => !byPath.has(f.path));
  const depth = Math.max(
    0,
    ...rest.map((f) => parentFolder(f.path).split("/").length),
  );
  let text = "";
  for (let d = depth; d >= 0; d--) {
    const folders = new Map<string, ChangedFile[]>();
    for (const f of rest) {
      const key = folderAt(f.path, d);
      const list = folders.get(key);
      if (list) list.push(f);
      else folders.set(key, [f]);
    }
    const rows = [...folders]
      .sort(([a], [b]) => compare(a, b))
      .map(([folder, list]) => {
        const inner = new Set(list.map((f) => parentFolder(f.path))).size;
        const unreviewed = list.filter((f) => !f.reviewed).length;
        return `${line(folder)}/** ${number(inner)} folder${inner === 1 ? "" : "s"}, ${number(list.length)} files +${number(list.reduce((n, f) => n + f.added, 0))} -${number(list.reduce((n, f) => n + f.deleted, 0))} ${number(list.reduce((n, f) => n + f.hunks.length, 0))} hunks [read_many by path${unreviewed ? `; ${number(unreviewed)} not reviewed` : ""}]`;
      });
    text = [
      total,
      ...named.map((f) => fileRow(f, byPath.get(f.path))),
      ...rows,
    ].join("\n");
    if (text.length <= share) break;
  }
  return { text, named: named.length, folded: rest.length };
};

const frameText = (frame: Frame) =>
  [
    "Frame",
    `Goal: ${line(frame.goal)}`,
    `Stratum: ${frame.stratum}`,
    `Source ids: ${frame.sourceIds.map(line).join(" ")}`,
    `Source: ${frame.source}`,
    `Gaps: ${frame.gaps.map(line).join("; ")}`,
    `Inputs: sectionsInlined ${frame.inputs.sectionsInlined}, sectionsListed ${frame.inputs.sectionsListed}, commitsShown ${frame.inputs.commitsShown}, commitsTotal ${frame.inputs.commitsTotal}`,
    ...frame.doneWhen.flatMap((d) => [
      `${d.id} ${line(d.text)}`,
      `  basis: ${d.basis}`,
      ...(d.sectionId === null ? [] : [`  sectionId: ${line(d.sectionId)}`]),
      ...(d.candidateId === null
        ? []
        : [`  candidateId: ${line(d.candidateId)}`]),
    ]),
  ].join("\n");

/** The cited sections, whole in done-when order while they fit `share`; one cut at a line; the rest by ID. */
const scopeText = (sections: ReadonlyArray<OpeningSection>, share: number) => {
  if (sections.length === 0)
    return { text: "", inlined: 0, listed: 0, ids: [] };
  const out = ["Scope"];
  let used = "Scope".length;
  let inlined = 0;
  /** The sections inlined, in order, and whether each was cut. */
  const ids: Array<{ readonly id: string; readonly cut: boolean }> = [];
  // Set once a section did not fit whole: the ones after it are listed, so the order holds. A
  // section missing from the snapshot is listed and takes no room, so it never sets this.
  let full = false;
  const listed: string[] = [];
  for (const section of sections) {
    if (section.header === undefined) {
      listed.push(`${section.id} (not in this run's scope snapshot)`);
      continue;
    }
    const head = `${section.header}${section.disclosure === undefined ? "" : `\nNote: ${line(section.disclosure)}.`}`;
    const body = section.text ?? "Not available.";
    const whole = head.length + body.length + 2;
    if (!full && used + whole <= share) {
      out.push(head, body);
      used += whole;
      inlined++;
      ids.push({ id: section.id, cut: false });
      continue;
    }
    const room = share - used - head.length - 80;
    // Only the first section that does not fit whole may go in cut.
    const first = !full;
    full = true;
    if (first && room > 200) {
      const kept: string[] = [];
      let size = 0;
      const lines = body.split("\n");
      for (const l of lines) {
        if (size + l.length + 1 > room) break;
        kept.push(l);
        size += l.length + 1;
      }
      out.push(
        head,
        kept.join("\n"),
        `[section cut: ${kept.length} of ${lines.length} lines shown]`,
      );
      used = share;
      inlined++;
      ids.push({ id: section.id, cut: true });
      continue;
    }
    listed.push(section.id);
  }
  if (listed.length) out.push(`Not inlined: ${listed.join(", ")}`);
  return { text: out.join("\n"), inlined, listed: listed.length, ids };
};

export const renderOpening = (o: OpeningInput, limit = OPENING_CHARS) => {
  const files = filesOf(o.hunks);
  const ordered = fileOrder(files);
  const frame = frameText(o.frame);
  const scope = scopeText(o.sections ?? [], Math.floor(limit * SCOPE_SHARE));
  const commits = o.commits ?? [];
  const log =
    commits.length === 0
      ? { text: "No commits in this range.", shown: new Set<string>() }
      : initialLog(
          commits,
          rankInitialFiles(files),
          o.commitFiles,
          Math.min(INITIAL_LOG_CHARS, Math.floor(limit * LOG_SHARE)),
          o.mergeFiles,
        );
  const logText = [
    "Log",
    ...(o.commitFiles === undefined
      ? ["Commit file lists unavailable; log selection uses log order."]
      : []),
    log.text,
  ].join("\n");
  const rendered = new Map(
    files.map((f) => [f.path, f.hunks.map(hunkLines)] as const),
  );
  const parts = (index: string, diff: string) =>
    [frame, scope.text, index, diff, logText].filter((part) => part !== "");
  const wrap = (body: string) => dataBlock("finder-input", {}, body);
  const fixed = wrap(parts("", "").join("\n\n")).length + "\n\n".length * 2;
  const indexShare = Math.floor(limit * INDEX_SHARE);
  // The index names every file whose diff follows, so its size depends on the selection: grow the
  // index's reservation until the selection fits beside it (each round can only shrink the diff).
  let reserve = renderIndex(ordered, [], indexShare).text.length;
  let shown: Shown[] = [];
  let index = renderIndex(ordered, shown, indexShare);
  for (;;) {
    shown = selectDiff(ordered, rendered, limit - fixed - reserve);
    index = renderIndex(ordered, shown, indexShare);
    if (index.text.length <= reserve) break;
    reserve = index.text.length;
  }
  const diff = renderDiff(shown);
  const body = parts(index.text, diff).join("\n\n");
  let text = wrap(body);
  if (text.length > limit) {
    // The whole Frame, the scope share, the index and the log count are kept: say by how much.
    let excess = text.length - limit;
    for (;;) {
      text = wrap(
        `${body}\n\nOpening exceeds limit by ${excess} characters to keep the whole Frame and the index.`,
      );
      const measured = text.length - limit;
      if (measured === excess) break;
      excess = measured;
    }
  }
  const handed = shown.flatMap((s) => s.hunks.map((h) => h.lines));
  return {
    text,
    openingOverLimit: Math.max(0, text.length - limit),
    /**
     * What the opening handed over, for the run log (`find.opening`, find-steps.ts): each hunk
     * whose diff it shows, in order, with the lines shown by side, and the scope sections inlined.
     * A hunk is shown whole or not at all; `cut` says its file's diff stops after a hunk, so some
     * of that file's later hunks are not shown. Hunk IDs and line numbers only, never a line.
     */
    handed: {
      hunks: shown.flatMap(({ hunks, cut }) =>
        hunks.map(({ hunk, lines }) => ({
          id: hunk.hunkId,
          cut,
          ...(lines.old === undefined ? {} : { old: lines.old }),
          ...(lines.new === undefined ? {} : { new: lines.new }),
        })),
      ),
      sections: scope.ids,
    },
    /** New-side lines the diff shows, by file: they count as read. */
    headReads: shown.flatMap(({ file, hunks }) =>
      hunks.flatMap(({ hunk, lines }) =>
        lines.head === undefined
          ? []
          : [{ path: hunk.newPath ?? file.path, ...lines.head }],
      ),
    ),
    counts: {
      chars: {
        frame: frame.length,
        scope: scope.text.length,
        index: index.text.length,
        diff: diff.length,
        log: logText.length,
      },
      sectionsInlined: scope.inlined,
      sectionsListed: scope.listed,
      files: files.length,
      filesNamed: index.named,
      filesFolded: index.folded,
      filesDiffed: shown.length,
      filesCut: shown.filter((s) => s.cut).length,
      hunks: files.reduce((n, f) => n + f.hunks.length, 0),
      hunksDiffed: handed.length,
      linesAdded: handed.reduce((n, h) => n + h.added, 0),
      linesDeleted: handed.reduce((n, h) => n + h.deleted, 0),
      linesContext: handed.reduce((n, h) => n + h.context, 0),
      ownedAddedShown: handed.reduce((n, h) => n + h.ownedAdded, 0),
      ownedDeletedShown: handed.reduce((n, h) => n + h.ownedDeleted, 0),
      ownedAdded: files.reduce(
        (n, f) =>
          n +
          f.hunks.reduce(
            (m, h) =>
              m +
              h.ownedRanges
                .filter((r) => r.side === "new")
                .reduce((k, r) => k + r.lineCount, 0),
            0,
          ),
        0,
      ),
      ownedDeleted: files.reduce(
        (n, f) =>
          n +
          f.hunks.reduce(
            (m, h) =>
              m +
              h.ownedRanges
                .filter((r) => r.side === "old")
                .reduce((k, r) => k + r.lineCount, 0),
            0,
          ),
        0,
      ),
      logLinesShown: log.shown.size,
      logLinesTotal: commits.length,
    },
  };
};
export type Opening = ReturnType<typeof renderOpening>;
