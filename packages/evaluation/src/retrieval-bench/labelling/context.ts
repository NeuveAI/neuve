import { Effect } from "effect";
import type { Case, Hunk } from "../corpus.ts";
import { gitText } from "../git.ts";

/**
 * Wider context for one adjudication item (9.38), gathered mechanically from git at the case's base
 * (or head for code the range changed): the region with surrounding lines, links between the region
 * and the hunk through identifiers they share, the scope excerpt, and the hunk's diff with context.
 * Everything is bounded so an item stays under about 30 KB. Nothing here depends on a programming
 * language: links are shared identifier-like tokens found with `git grep`, not parsed symbols.
 */

export const CONTEXT_LINES = 30;
export const LINK_MAX = 3;
export const LINK_EXCERPT_LINES = 2;
/** Tokens in more files than this are too common to link anything specific. */
export const LINK_MAX_FILES = 40;
export const SCOPE_MAX_LINES = 80;
export const DIFF_CONTEXT_LINES = 8;
export const ITEM_BUDGET_BYTES = 30 * 1024;

export interface RegionSpec {
  readonly source: string;
  readonly path: string | null;
  readonly startLine: number | null;
  readonly endLine: number | null;
  readonly commit: string | null;
}

export interface Link {
  readonly token: string;
  readonly path: string;
  readonly lines: string;
  readonly excerpt: string;
}

export interface ItemContext {
  /** Numbered lines around the region; the region's own lines are marked with `>`. */
  readonly region: {
    readonly text: string;
    readonly startLine: number | null;
    readonly endLine: number | null;
    readonly truncated: boolean;
  };
  readonly links: ReadonlyArray<Link>;
  readonly scope: {
    readonly source: string;
    readonly heading: string | null;
    readonly text: string;
    readonly truncated: boolean;
  };
  /** The range's commit text, always included as stated intent (capped). */
  readonly commitText: string;
  readonly hunkDiff: string;
}

const linesOf = (text: string) =>
  (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");

const cap = (text: string, maxBytes: number) =>
  Buffer.byteLength(text) <= maxBytes
    ? { text, truncated: false }
    : {
        text: Buffer.from(text).subarray(0, maxBytes).toString("utf8"),
        truncated: true,
      };

/** Identifier-like tokens: letters, digits and underscores, starting with a letter, 4+ long. */
const tokens = (text: string) =>
  new Set(text.match(/\b[A-Za-z][A-Za-z0-9_]{3,}\b/g) ?? []);

const blob = (repository: string, revision: string, path: string) =>
  gitText(repository, ["cat-file", "blob", `${revision}:${path}`]);

export const gatherContext = (
  repository: string,
  entry: Case,
  hunk: Hunk,
  region: RegionSpec,
) =>
  Effect.gen(function* () {
    // (d) the hunk's diff with a few more lines of context
    const wide = yield* gitText(repository, [
      "diff",
      "--no-color",
      "--no-ext-diff",
      `-U${DIFF_CONTEXT_LINES}`,
      "-M",
      entry.base,
      entry.head,
      "--",
      ...new Set([hunk.oldPath, hunk.path].map((path) => `:(literal)${path}`)),
    ]);
    const blocks = wide.split(/\n(?=@@ )/).slice(1);
    const covering =
      blocks.find((block) => {
        const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(
          block,
        );
        if (header === null) return false;
        const newStart = Number(header[3]);
        const newLines = header[4] === undefined ? 1 : Number(header[4]);
        const oldStart = Number(header[1]);
        const oldLines = header[2] === undefined ? 1 : Number(header[2]);
        return hunk.new.lines > 0
          ? newStart <= hunk.new.start &&
              hunk.new.start < newStart + Math.max(newLines, 1)
          : oldStart <= hunk.old.start &&
              hunk.old.start < oldStart + Math.max(oldLines, 1);
      }) ?? "";
    const hunkDiff = cap(covering, 8 * 1024).text;

    // (a) the region with surrounding lines, its own lines marked
    let regionText = "";
    let regionStart: number | null = null;
    let regionEnd: number | null = null;
    if (region.source === "commit" && region.commit !== null) {
      regionText = yield* gitText(repository, [
        "show",
        "--stat",
        "--date=short",
        "--format=%H %ad%n%s%n%n%b",
        region.commit,
      ]).pipe(Effect.orElseSucceed(() => "(commit not found)"));
    } else if (region.path !== null) {
      const revision = region.source === "base" ? entry.base : entry.head;
      const lines = linesOf(
        yield* blob(repository, revision, region.path).pipe(
          Effect.orElseSucceed(() => ""),
        ),
      );
      const start = region.startLine ?? 1;
      const end = Math.min(region.endLine ?? lines.length, lines.length);
      regionStart = Math.max(1, start - CONTEXT_LINES);
      regionEnd = Math.min(lines.length, end + CONTEXT_LINES);
      regionText = lines
        .slice(regionStart - 1, regionEnd)
        .map((line, index) => {
          const number = regionStart! + index;
          const mark = number >= start && number <= end ? ">" : " ";
          return `${mark}${String(number).padStart(5)}  ${line}`;
        })
        .join("\n");
    }
    const regionCapped = cap(regionText, 12 * 1024);

    // (b) links: tokens shared by the region and the hunk's changed lines, found elsewhere at the base
    const changed = covering
      .split("\n")
      .filter((line) => /^[+-][^+-]/.test(line))
      .join("\n");
    const shared = [...tokens(changed)].filter((token) =>
      tokens(regionText).has(token),
    );
    const links: Array<Link> = [];
    const seen = new Set<string>();
    const ranked: Array<{ token: string; files: number }> = [];
    // Longer tokens first: they are usually more specific.
    shared.sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
    for (const token of shared.slice(0, 15)) {
      const files = yield* gitText(repository, [
        "-c",
        "grep.threads=2",
        "grep",
        "-l",
        "-w",
        "-F",
        "-e",
        token,
        entry.base,
      ]).pipe(Effect.orElseSucceed(() => ""));
      const count = files.split("\n").filter(Boolean).length;
      if (count > 0 && count <= LINK_MAX_FILES)
        ranked.push({ token, files: count });
    }
    ranked.sort((a, b) => a.files - b.files || (a.token < b.token ? -1 : 1));
    for (const { token } of ranked) {
      if (links.length >= LINK_MAX) break;
      const hits = yield* gitText(repository, [
        "-c",
        "grep.threads=2",
        "grep",
        "-n",
        "-w",
        "-F",
        "--max-count=1",
        "-e",
        token,
        entry.base,
      ]).pipe(Effect.orElseSucceed(() => ""));
      for (const hit of hits.split("\n").filter(Boolean)) {
        if (links.length >= LINK_MAX) break;
        const match = /^[0-9a-f]+:(.+?):(\d+):/.exec(hit);
        if (match === null) continue;
        const path = match[1]!;
        const line = Number(match[2]);
        if (path === region.path || path === hunk.oldPath || seen.has(path))
          continue;
        seen.add(path);
        const fileLines = linesOf(yield* blob(repository, entry.base, path));
        const from = Math.max(1, line - LINK_EXCERPT_LINES);
        const to = Math.min(fileLines.length, line + LINK_EXCERPT_LINES);
        links.push({
          token,
          path,
          lines: `${from}-${to}`,
          excerpt: fileLines
            .slice(from - 1, to)
            .map(
              (text, index) => `${String(from + index).padStart(5)}  ${text}`,
            )
            .join("\n")
            .slice(0, 800),
        });
      }
    }

    // (c) scope: the scope document section at the base (or in the range) that best matches the hunk
    const docs = [
      ...entry.scopeDocsAtBase.map((path) => ({ path, revision: entry.base })),
      ...entry.inRangeDocs
        .filter((doc) => doc.class === "scope" && doc.status !== "deleted")
        .map((doc) => ({ path: doc.path, revision: entry.head })),
    ];
    const terms = [
      hunk.path
        .split("/")
        .at(-1)!
        .replace(/\.[^.]+$/, ""),
      ...[...tokens(changed)].slice(0, 30),
    ].filter((term) => term.length >= 4);
    // Score every heading-delimited section of every scope document by the distinct, specific
    // terms of the change it mentions (each weighted by 1 / the number of documents holding it);
    // keep the best section if it matches at least two terms, otherwise fall back to commit text.
    const texts: Array<{ path: string; lines: Array<string> }> = [];
    for (const doc of docs.slice(0, 120))
      texts.push({
        path: doc.path,
        lines: linesOf(
          yield* blob(repository, doc.revision, doc.path).pipe(
            Effect.orElseSucceed(() => ""),
          ),
        ),
      });
    const frequency = new Map(
      terms.map((term) => [
        term,
        texts.filter((doc) => doc.lines.some((line) => line.includes(term)))
          .length,
      ]),
    );
    const specific = terms.filter((term) => {
      const count = frequency.get(term) ?? 0;
      return count > 0 && count <= Math.max(2, texts.length / 4);
    });
    let best:
      | {
          path: string;
          lines: Array<string>;
          start: number;
          end: number;
          score: number;
        }
      | undefined;
    for (const { path, lines } of texts) {
      const starts = [
        0,
        ...lines.flatMap((line, index) =>
          index > 0 && /^#{1,6} /.test(line) ? [index] : [],
        ),
      ];
      starts.forEach((start, index) => {
        const end = starts[index + 1] ?? lines.length;
        const section = lines.slice(start, end).join("\n");
        const matched = specific.filter((term) => section.includes(term));
        const score = matched.reduce(
          (total, term) => total + 1 / frequency.get(term)!,
          0,
        );
        if (matched.length >= 2 && (best === undefined || score > best.score))
          best = { path, lines, start, end, score };
      });
    }
    const commitLog = yield* gitText(repository, [
      "log",
      "--reverse",
      "--format=%s%n%n%b",
      `${entry.base}..${entry.head}`,
    ]);
    const commitText = cap(commitLog.trim(), 2 * 1024).text;
    let scope: ItemContext["scope"];
    if (best !== undefined) {
      const { start, end, lines } = best;
      scope = {
        source: best.path,
        heading: /^#{1,6} /.test(lines[start] ?? "") ? lines[start]! : null,
        text: lines
          .slice(start, Math.min(end, start + SCOPE_MAX_LINES))
          .join("\n"),
        truncated: end - start > SCOPE_MAX_LINES,
      };
    } else {
      scope = {
        source: "commit text",
        heading: null,
        text: commitText,
        truncated: Buffer.byteLength(commitLog.trim()) > 2 * 1024,
      };
    }

    return {
      region: {
        text: regionCapped.text,
        startLine: regionStart,
        endLine: regionEnd,
        truncated: regionCapped.truncated,
      },
      links,
      scope,
      commitText,
      hunkDiff,
    } satisfies ItemContext;
  });
