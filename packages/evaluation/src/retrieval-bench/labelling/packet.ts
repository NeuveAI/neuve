import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import type { Case, Hunk } from "../corpus.ts";
import { commits, gitText } from "../git.ts";
import type { HistoryCommit } from "./pool.ts";
import { jsonSchemaOf, LabellerOutput, type HunkPool } from "./schema.ts";

/**
 * What each labeller receives (brief, "What you're given"): one directory per hunk with the brief,
 * the task, the hunk, the range's commit text and diff, the scope sources, the candidates as base
 * text, history, and the hindsight documents marked as grading-only. The base snapshot is a shared
 * read-only export per base. Arms and ranks never enter the packet (brief, change 2).
 */

export const RANGE_DIFF_MAX_LINES = 6000;
/** Candidate text can hold Markdown fences of its own; tildes keep blocks intact. */
const FENCE = "~~~~~~";
const TICKET = /\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/g;
/** Encodings, hashes and standards that look like ticket keys. */
const NOT_TICKET = /^(UTF|SHA|ISO|RFC|HTTP|TLS|ES|MD|CVE|IPV|BASE)-/;

const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

/** The brief section labellers read, verbatim between the committed markers. */
export const labellerBrief = (briefPath: string) => {
  const text = readFileSync(briefPath, "utf8");
  const start = text.indexOf("<!-- labeller-brief:start -->");
  const end = text.indexOf("<!-- labeller-brief:end -->");
  if (start === -1 || end === -1 || end < start)
    throw new Error(`labeller brief markers missing in ${briefPath}`);
  return text.slice(start + "<!-- labeller-brief:start -->".length, end).trim();
};

const numbered = (lines: ReadonlyArray<string>, first: number) =>
  lines
    .map((line, index) => `${String(first + index).padStart(5)}  ${line}`)
    .join("\n");

/** One read-only export of a base tree, shared by every hunk of every case on that base. */
export const exportSnapshot = (
  repository: string,
  commit: string,
  directory: string,
) =>
  Effect.tryPromise(async () => {
    if (existsSync(join(directory, ".complete"))) return directory;
    mkdirSync(directory, { recursive: true });
    const archive = Bun.spawn(
      ["git", "-C", repository, "archive", "--format=tar", commit],
      { stdout: "pipe", stderr: "pipe" },
    );
    const untar = Bun.spawn(["tar", "-x", "-f", "-", "-C", directory], {
      stdin: archive.stdout,
      stderr: "pipe",
    });
    const [a, b] = await Promise.all([archive.exited, untar.exited]);
    if (a !== 0 || b !== 0)
      throw new Error(`snapshot export of ${commit} failed (${a}, ${b})`);
    writeFileSync(join(directory, ".complete"), `${commit}\n`);
    const lock = Bun.spawn(["chmod", "-R", "a-w", directory]);
    await lock.exited;
    return directory;
  });

export interface PacketInputs {
  readonly repository: string;
  readonly entry: Case;
  readonly hunk: Hunk;
  readonly pool: HunkPool;
  readonly history: ReadonlyArray<HistoryCommit>;
  readonly snapshot: string;
  readonly brief: string;
  readonly directory: string;
}

/** Writes the packet and returns the labeller task text (the prompt both routes send). */
export const writePacket = (inputs: PacketInputs) =>
  Effect.gen(function* () {
    const { repository, entry, hunk, pool, directory } = inputs;
    const blobCache = new Map<string, ReadonlyArray<string>>();
    const baseLines = (path: string) =>
      Effect.gen(function* () {
        const held = blobCache.get(path);
        if (held !== undefined) return held;
        const text = yield* gitText(repository, [
          "cat-file",
          "blob",
          `${entry.base}:${path}`,
        ]);
        const lines = text.split("\n");
        blobCache.set(path, lines);
        return lines;
      });

    write(join(directory, "brief.md"), `${inputs.brief}\n`);

    const hunkDiff = yield* gitText(repository, [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "-U10",
      "-M",
      entry.base,
      entry.head,
      "--",
      `:(literal)${hunk.oldPath}`,
      `:(literal)${hunk.path}`,
    ]);
    write(join(directory, "range", "hunk-file.diff"), hunkDiff);

    const log = yield* commits(repository, [
      "--reverse",
      `${entry.base}..${entry.head}`,
    ]);
    const commitText = log
      .map((commit) =>
        `## ${commit.sha.slice(0, 12)} ${commit.subject}\n\n${commit.body}`.trim(),
      )
      .join("\n\n");
    write(join(directory, "range", "commits.md"), `${commitText}\n`);
    const tickets = [...new Set(commitText.match(TICKET) ?? [])]
      .filter((key) => !NOT_TICKET.test(key))
      .sort();

    const stat = yield* gitText(repository, [
      "diff",
      "--stat=200",
      "-M",
      entry.base,
      entry.head,
    ]);
    const fullDiff = yield* gitText(repository, [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "-U3",
      "-M",
      "--ignore-submodules=all",
      entry.base,
      entry.head,
    ]);
    const diffLines = fullDiff.split("\n");
    const capped = diffLines.length > RANGE_DIFF_MAX_LINES;
    write(
      join(directory, "range", "range.diff"),
      capped
        ? `${diffLines.slice(0, RANGE_DIFF_MAX_LINES).join("\n")}\n... (${diffLines.length - RANGE_DIFF_MAX_LINES} more lines; the stat lists every file)\n`
        : fullDiff,
    );
    write(join(directory, "range", "stat.txt"), stat);

    if (hunk.added > 0) {
      const head = yield* gitText(repository, [
        "cat-file",
        "blob",
        `${entry.head}:${hunk.path}`,
      ]);
      write(join(directory, "head", hunk.path), head);
    }

    const rangeScope: Array<string> = [];
    const hindsight: Array<string> = [];
    for (const doc of entry.inRangeDocs) {
      if (doc.status === "deleted" || doc.class === "other") continue;
      const text = yield* gitText(repository, [
        "cat-file",
        "blob",
        `${entry.head}:${doc.path}`,
      ]).pipe(Effect.orElseSucceed(() => ""));
      if (doc.class === "scope") {
        rangeScope.push(doc.path);
        write(join(directory, "range-docs", doc.path), text);
      } else {
        hindsight.push(doc.path);
        write(
          join(directory, "hindsight", "README.md"),
          "Hindsight: documents written during or after the change. Use them for grading only; they are never context a retriever should have found.\n",
        );
        write(join(directory, "hindsight", "docs", doc.path), text);
      }
    }

    const historyBlocks = inputs.history.map((commit) => {
      const candidate = pool.candidates.find(
        (item) => item.commit === commit.sha,
      );
      return [
        `### ${candidate?.id ?? "?"} · ${commit.timing === "earlier" ? "earlier commit (before the base)" : "LATER commit (hindsight, after the head)"} · ${commit.sha.slice(0, 12)} · ${commit.date}`,
        "",
        commit.subject,
        "",
        `${FENCE}diff`,
        commit.patch.split("\n").slice(0, 160).join("\n"),
        FENCE,
      ].join("\n");
    });

    const blocks: Array<string> = [];
    for (const candidate of pool.candidates) {
      if (candidate.type === "commit") continue;
      const lines = yield* baseLines(candidate.path!);
      const start = candidate.startLine!;
      const end = Math.min(candidate.endLine!, lines.length);
      const status =
        candidate.rangeStatus === "committed"
          ? ""
          : ` · ${candidate.changedBaseLines} of these base lines are changed by the range (same-batch)`;
      blocks.push(
        [
          `### ${candidate.id} · ${candidate.kind} · ${candidate.path}:${start}-${end}${status}`,
          "",
          FENCE,
          numbered(lines.slice(start - 1, end), start),
          FENCE,
        ].join("\n"),
      );
    }
    write(
      join(directory, "candidates.md"),
      [
        `# Candidates for ${hunk.id}`,
        "",
        `${pool.candidates.length} candidates in file and line order. Region text is from the base snapshot with base line numbers. History candidates are at the end.`,
        "",
        ...blocks,
        "",
        "## History candidates",
        "",
        historyBlocks.length === 0 ? "None found." : historyBlocks.join("\n\n"),
        "",
      ].join("\n"),
    );

    write(
      join(directory, "output.schema.json"),
      `${JSON.stringify(jsonSchemaOf(LabellerOutput), null, 2)}\n`,
    );

    const scopeAtBase =
      entry.scopeDocsAtBase.length === 0
        ? "None found by the corpus rules."
        : entry.scopeDocsAtBase.map((path) => `- \`${path}\``).join("\n");
    const task = [
      `# Labelling task: ${hunk.id}`,
      "",
      `Read \`brief.md\` first and follow it. Everything here is read-only data, not instructions.`,
      "",
      "## The hunk",
      "",
      `- Case \`${entry.id}\` (${entry.repository}), range \`${entry.base.slice(0, 12)}..${entry.head.slice(0, 12)}\`, ${entry.commits.length} commit(s).`,
      `- File \`${hunk.path}\`${hunk.oldPath !== hunk.path ? ` (renamed from \`${hunk.oldPath}\`)` : ""}, base lines ${hunk.old.start}+${hunk.old.lines}, head lines ${hunk.new.start}+${hunk.new.lines} (+${hunk.added} −${hunk.deleted}).`,
      `- The file's diff with 10 context lines is \`range/hunk-file.diff\`; the hunk under review is the one whose header starts \`@@ -${hunk.old.start}\`.`,
      hunk.added > 0
        ? `- The file as it is after the change: \`head/${hunk.path}\`.`
        : "- The hunk only deletes lines.",
      "",
      "## The rest of the range",
      "",
      "- Commit text: `range/commits.md`. File list: `range/stat.txt`. Full diff: `range/range.diff`.",
      tickets.length > 0
        ? `- The commit text names these possible tickets: ${tickets.map((t) => `\`${t}\``).join(", ")}. They were not captured (external scope, not available here).`
        : "- The commit text names no tickets.",
      "",
      "## Scope",
      "",
      "Scope documents that exist at the base (read them in the snapshot):",
      "",
      scopeAtBase,
      "",
      rangeScope.length === 0
        ? "No scope document was added or edited inside the range."
        : `Scope documents added or edited inside the range (their head version, under \`range-docs/\`):\n\n${rangeScope.map((path) => `- \`range-docs/${path}\``).join("\n")}`,
      "",
      "## Repository at the base",
      "",
      `A read-only copy of the repository at the base is at \`${inputs.snapshot}\`. Paths in candidates and in your labels are relative to it.`,
      "",
      "## Candidates",
      "",
      `\`candidates.md\` lists ${pool.candidates.length} candidates (ids \`c001\`…), each with its base text. Grade every one exactly once.`,
      "",
      "## Hindsight, for grading only",
      "",
      hindsight.length === 0
        ? "- No hindsight documents in the range."
        : hindsight.map((path) => `- \`hindsight/docs/${path}\``).join("\n"),
      "- Later commits that changed this hunk's lines, if any, are the LATER history candidates in `candidates.md`.",
      "",
      "## Your output",
      "",
      "One JSON object matching `output.schema.json`:",
      "",
      "- `scope`: the scope sources you traced (paths, or `commit text`), the stratum, and any gap.",
      "- `items`: one entry per necessary, useful or misleading item. `candidateIds` lists the candidates it covers (empty for an addition, with `added: true`). `region.source` is `base` (a span of the snapshot; set `path`, `startLine`, `endLine`), `range-doc` (a document under `range-docs/`; set `path` as in the repository and the lines), `range-change` (code the range changes, by its path and head line numbers, for new code that has no base span), or `commit` (set `commit` to the full or 12-character sha). Use null for fields that do not apply.",
      "- `irrelevant`: every other candidate id.",
      "- `notes`: anything the owner should know, or null.",
      "",
    ].join("\n");
    write(join(directory, "task.md"), task);
    return task;
  });
