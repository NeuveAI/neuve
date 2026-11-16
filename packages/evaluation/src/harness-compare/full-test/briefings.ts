import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { z } from "zod";
import {
  claudeCredential,
  isLimitFailure,
} from "../../retrieval-bench/labelling/credentials.ts";
import {
  auditClaudeLog,
  claudePrintCommand,
  LIMIT_BACKOFF_MS,
  OPUS_MODEL,
} from "../../retrieval-bench/labelling/routes.ts";
import { jsonSchemaOf } from "../../retrieval-bench/labelling/schema.ts";
import {
  benchmark,
  repositories,
} from "../../retrieval-bench/scoring-inputs.ts";
import { root } from "../common.ts";
import { FULL_TEST_RESULTS } from "./config.ts";
import { readKnownCases } from "./known-cases.ts";
import { referenceItem } from "./measures.ts";
import { packetUnits, type StoredRun } from "./packets.ts";
import { readStored } from "./phases.ts";
import { readFullTestSelection } from "./select.ts";
import { SheetFile, sheetMarkdown, type SheetItem } from "./sheet.ts";

/**
 * The sheet's neutral briefings (FT13, 9.38, 10.71): for each unit, phase-A unit and margin card,
 * a separate context (headless Claude Code, Opus, on the owner's subscription token, 9.55) gathers
 * the code around the item's lines, its callers or callees and related tests or docs, and points at
 * the lines and questions worth thinking about. It never proposes an answer: `checkSheetBriefing`
 * refuses any briefing that uses an answer word or recommends one, and a refused briefing is retried
 * once with the reason, then left empty and reported.
 *
 * Isolation (2.16): each session runs in a fresh item directory that holds only `item.md` (the
 * question side: title, owned lines or region, the harness's Facts, the range and its commit text),
 * `change.diff` (the range's diff for those files) and the output schema, with read-only file tools
 * (Read, Grep, Glob; restricted and safe mode) confined to that directory and the range's base and
 * head trees, extracted from a scratch `git clone --shared --no-checkout` that is deleted
 * afterwards. No git history, Records store, packet, reveal, gold, score or hills report is in
 * reach, and the logged tool calls are audited for paths outside those roots.
 */

export const BRIEFED_KINDS = ["unit", "phase-a-unit", "margin-card"] as const;
type BriefedKind = (typeof BRIEFED_KINDS)[number];
type BriefedItem = Extract<SheetItem, { kind: BriefedKind }>;
const isBriefed = (item: SheetItem): item is BriefedItem =>
  (BRIEFED_KINDS as ReadonlyArray<string>).includes(item.kind);

export const RECEIPTS_FILE = join(FULL_TEST_RESULTS, "sheet-briefings.json");
const SCHEMA_FILE = "briefing.schema.json";
export const ATTEMPTS = 2;
export const MAX_CONCURRENCY = 3;
const SESSION_TIMEOUT_MS = 15 * 60_000;
const DIFF_LIMIT = 40_000;

// The guard

/** Words that are an answer on the sheet: lanes, axis levels used as grades, verdicts, margin grades. */
const ANSWER_WORDS: ReadonlyArray<readonly [string, RegExp]> = [
  [
    "lane",
    /\b(static[\s-]+automation|agentic|human[\s-]+suggested|human[\s-]+required|lanes?)\b/i,
  ],
  [
    "axis level",
    /\b((low|high)[\s-]+complexity|complexity\s+(is|was|seems|looks|appears)\s+(low|high)|(easy|easier|hard|harder|difficult)\s+to\s+(validate|verify|check|test|confirm|review)|easily\s+(validated|verified|checked|tested|confirmed)|(low|high)[\s-]+(easy|hard))\b/i,
  ],
  [
    "verdict",
    /\b(approv\w*|request(s|ed|ing)?[\s-]+changes|changes[\s-]+requested|verdicts?)\b/i,
  ],
  [
    "grade",
    /\b(necessary|unnecessary|relevant|irrelevant|relevance|irrelevance|useful|useless|usefulness|misleading|mislead\w*|grades?|graded|grading)\b/i,
  ],
];

/** Wording that recommends an answer without naming it. */
const RECOMMENDING: ReadonlyArray<RegExp> = [
  /\b(recommend\w*|(i|we)\s+(would\s+)?(suggest|advise))\b/i,
  /\bshould\s+(be\s+)?(approved|merged|accepted|rejected|landed|shipped|automated|escalated)\b/i,
  /\b(safe|ready|fine|ok|okay)\s+to\s+(merge|ship|land|accept)\b/i,
  /\blooks?\s+(good|fine|correct|right|safe|sound|ok|okay|clean)\b/i,
  /\blgtm\b/i,
  /\bno\s+(real\s+|obvious\s+|apparent\s+)?(issues?|concerns?|problems?|defects?|bugs?|risks?)\b/i,
  /\b(seems|appears|looks|is\s+clearly|is\s+definitely)\s+(correct|incorrect|wrong|fine|safe|sound|buggy|broken|complete)\b/i,
  /\b(bugs?|buggy|defects?|defective|flaws?|flawed)\b/i,
  /\b(trivial\w*|straightforward)\b/i,
  /\b((low|high|minimal|little)[\s-]+risk|risky)\b/i,
  /\b(has|have)\s+no\s+bearing\b/i,
  /\bcan\s+(safely\s+)?be\s+ignored\b/i,
  /\b(is|are)\s+(essential|crucial|critical|central|important)\s+(to|for)\b/i,
  // Who should look at it points at a lane; whether the change leans on the cited lines states a grade.
  /\bwho\b[^.?!\n]{0,80}?\b(judges?|judging|reviews?|reviewing|knows?|knowing)\b/i,
  /\b(rel(y|ies|ied|ying)|depends?|depending|depended)\s+((only|solely|entirely|mainly|largely)\s+)?(up)?on\s+(these|those|the\s+cited)\s+(lines|region|code)\b/i,
  /\bonly\s+evidence\b/i,
  /\bneeds?\s+(a\s+)?humans?\b/i,
  /\bcan\s+be\s+automated\b/i,
  /\b(complex|simple)\b/i,
];

/**
 * The text the patterns read: typographic hyphens and dashes become "-", non-breaking and narrow
 * spaces become spaces, and zero-width characters are dropped, so "human‑required" written with a
 * non-breaking hyphen, or a word split by a zero-width space, is still caught.
 */
export const normaliseForGuard = (text: string) =>
  text
    .normalize("NFKC")
    .replace(/[\u00AD\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, "-")
    .replace(/[\u00A0\u2007\u202F\u2060]/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "");

export const BRIEFING_WORDS = { min: 90, max: 300 } as const;

/**
 * Refuses a briefing that names or recommends an answer, falls outside the length, or cites no
 * `path:line`; returns the trimmed text otherwise. The reason names the rule and the matched words
 * only, so a receipt never carries a refused briefing's text.
 */
export const checkSheetBriefing = (raw: string) => {
  const text = raw.trim();
  const read = normaliseForGuard(text);
  for (const [rule, pattern] of ANSWER_WORDS) {
    const match = pattern.exec(read);
    if (match !== null)
      throw new Error(`uses the ${rule} word "${match[0].toLowerCase()}"`);
  }
  for (const pattern of RECOMMENDING) {
    const match = pattern.exec(read);
    if (match !== null)
      throw new Error(`recommends an answer ("${match[0].toLowerCase()}")`);
  }
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words < BRIEFING_WORDS.min || words > BRIEFING_WORDS.max)
    throw new Error(
      `${words} words, outside ${BRIEFING_WORDS.min}-${BRIEFING_WORDS.max}`,
    );
  if (!/[\w./-]+\.[A-Za-z0-9]+:\d+/.test(text))
    throw new Error("cites no file and line as path:line");
  return text;
};

export const BriefingOutput = z.strictObject({ briefing: z.string().min(1) });

// What the session sees

/** The question side of one item, and nothing else: the only input to the item directory. */
export interface BriefQuestion {
  readonly id: string;
  readonly kind: BriefedKind;
  readonly caseId: string;
  readonly title: string;
  /** The unit's owned lines, or the margin card's region with the tree it is read from. */
  readonly lines: ReadonlyArray<string>;
  readonly facts: string | null;
  readonly range: {
    readonly repository: string;
    readonly base: string;
    readonly head: string;
    readonly subjects: ReadonlyArray<string>;
  };
  /** For a margin card: the change the region is judged against. */
  readonly hunk: {
    readonly path: string;
    readonly oldStart: number;
    readonly oldLines: number;
    readonly newStart: number;
    readonly newLines: number;
  } | null;
  /** The files whose range diff goes into `change.diff`. */
  readonly paths: ReadonlyArray<string>;
}

const ManifestCases = z.object({
  cases: z.array(
    z.object({
      id: z.string(),
      repository: z.string(),
      base: z.string(),
      head: z.string(),
      subjects: z.array(z.string()),
      hunks: z.array(
        z.object({
          id: z.string(),
          path: z.string(),
          oldPath: z.string(),
          old: z.object({ start: z.number(), lines: z.number() }),
          new: z.object({ start: z.number(), lines: z.number() }),
        }),
      ),
    }),
  ),
});
type ManifestCase = z.infer<typeof ManifestCases>["cases"][number];

const readManifestCases = () =>
  new Map(
    ManifestCases.parse(
      JSON.parse(readFileSync(join(benchmark, "manifest.json"), "utf8")),
    ).cases.map((entry) => [entry.id, entry]),
  );

/** `path (side) a-b` or `path (side, whole file)` as the sheet writes owned lines. */
const pathOf = (line: string) =>
  line.replace(/ \((?:old|new|base|head)[^)]*\).*$/, "");

/** The tree a margin card's region is read from (phase C's packet); the rest is on the card. */
export interface MarginContext {
  readonly side: "base" | "head" | null;
}

export const marginContext = (
  item: Extract<SheetItem, { kind: "margin-card" }>,
  base: string,
): MarginContext => {
  const run = readStored<StoredRun>(item.caseId, "C");
  const unit = packetUnits(run?.packet ?? null).find(
    (entry) => entry.unit.unitId === item.unitId,
  )?.unit;
  const reference =
    unit === undefined || run?.manifest == null
      ? undefined
      : unit.references.find((r) => {
          const placed = referenceItem(r, run.manifest!.hunks, [base]);
          return (
            placed !== null &&
            `${placed.path} ${placed.startLine}-${placed.endLine}` ===
              item.question.region
          );
        });
  const provenance = reference?.payload.provenance as
    { kind: string; revision?: string } | undefined;
  return {
    side:
      provenance?.kind !== "git"
        ? null
        : provenance.revision === base
          ? "base"
          : "head",
  };
};

/** Builds the question from an item's question fields, its range and (for cards) the region's tree. */
export const questionOf = (
  item: BriefedItem,
  range: ManifestCase,
  margin?: MarginContext,
): BriefQuestion => {
  const common = {
    id: item.id,
    kind: item.kind,
    caseId: item.caseId,
    range: {
      repository: range.repository,
      base: range.base,
      head: range.head,
      subjects: range.subjects,
    },
  };
  if (item.kind !== "margin-card")
    return {
      ...common,
      title: item.question.title,
      lines: item.question.ownedLines,
      facts: item.question.facts,
      hunk: null,
      paths: [...new Set(item.question.ownedLines.map(pathOf))],
    };
  const hunk = range.hunks.find((entry) => entry.id === item.hunkId);
  if (hunk === undefined)
    throw new Error(`${item.id}: hunk ${item.hunkId} is not in ${range.id}`);
  const regionPath = item.question.region.replace(/ \d+-\d+$/, "");
  return {
    ...common,
    title: item.question.citingUnit.title,
    lines: [
      `${item.question.region} (${margin?.side ?? "base or head; check both trees"})`,
    ],
    facts: item.question.citingUnit.facts,
    hunk: {
      path: hunk.path,
      oldStart: hunk.old.start,
      oldLines: hunk.old.lines,
      newStart: hunk.new.start,
      newLines: hunk.new.lines,
    },
    paths: [...new Set([hunk.oldPath, hunk.path, regionPath])],
  };
};

const BANNED = [
  'the lane words "static automation", "agentic", "human-suggested", "human-required" and the word "lane";',
  '"low complexity", "high complexity", "easy to validate", "hard to validate" (or easy or hard to verify, check, test, confirm or review);',
  'any form of "approve" ("approval", "approved"), "request changes" and "verdict";',
  '"necessary", "unnecessary", "relevant", "irrelevant", "relevance", "useful", "useless", "misleading", "mislead" and "grade";',
  'the words "complex" and "simple", "who … should review" (or judge, knows), "needs a human", "can be automated", "relies on these lines" (or depends on), "only evidence";',
  'and wording that recommends an answer: "recommend", "I suggest", "should be merged" (or approved, accepted, rejected), "safe to merge", "looks good" (or fine, correct, safe), "LGTM", "no issues" (or concerns, problems, risk), "seems correct" (or wrong, broken), "bug", "defect", "flaw", "trivial", "straightforward", "low risk", "high risk", "risky", "has no bearing", "can be ignored", "is essential for".',
];

const taskOf = (question: BriefQuestion, trees: string) =>
  [
    "# Briefing task",
    "",
    "A reviewer will look at one item of a code-review sheet and decide about it on their own. Write a short, neutral briefing that gathers the context they need and points at what to think about. You never give or hint at an answer.",
    "",
    "`item.md` in this directory is what the reviewer is shown, and `change.diff` is the range's diff for the files involved.",
    `The repository is checked out read-only at the range's base in \`${trees}/base\` and at its head in \`${trees}/head\`. Use them to read the code around the lines, callers and callees, and related tests or docs.`,
    "",
    question.kind === "margin-card"
      ? "The item is a context reference: lines elsewhere in the repository that a review of the change cited. The reviewer decides how much these lines matter for judging whether the change under review is correct."
      : "The item is a unit of review: a part of the change with its owned lines. The reviewer forms their own assessment of it, including how much there is to understand in it and what it would take to validate it.",
    "",
    "Write `briefing`: 120-250 words of plain prose (short bullet lines are fine), with file and line references written as `path:line` (repository-relative; say head or base where it matters). It:",
    "",
    "- says what the lines do and what surrounds them: callers or callees, related tests or docs, and what the code shows about the item's title, facts and commit text;",
    "- points at the specific lines and open questions worth thinking about for complexity, for ease of validation, for what could go wrong, and for whether the change does what its text says.",
    "",
    "Phrase every judgement as an open question for the reviewer. Do not answer the questions, and do not say how complex, how hard to check, how risky or how sound the change is.",
    "Do not say or ask who should review, judge or check it, or what knowledge or expertise that takes. Do not say whether the change depends on, relies on, or only has evidence in the cited lines; describe what the code does and leave that to the reviewer.",
    "",
    "The briefing is rejected if it contains any of these, in any form or case, even quoted from code:",
    "",
    ...BANNED.map((line) => `- ${line}`),
    "",
    "Before answering, reread the text and rephrase anything on that list. Use only this directory and the two trees. Your final answer must be the JSON object only.",
  ].join("\n");

const span = (start: number, lines: number) =>
  lines === 0 ? "none" : `${start}-${start + lines - 1}`;

const itemMarkdown = (question: BriefQuestion, trees: string) =>
  [
    `# Sheet item ${question.id}`,
    "",
    `Range: ${question.range.repository} ${question.range.base}..${question.range.head}`,
    `Trees: base at \`${trees}/base\`, head at \`${trees}/head\` (old lines are in base, new lines in head).`,
    "",
    "## The range's commit text",
    "",
    ...question.range.subjects.map((subject) => `- ${subject}`),
    "",
    question.kind === "margin-card"
      ? "## The unit that cited the lines"
      : "## The unit",
    "",
    `Title: ${question.title}`,
    "",
    `Facts (the review harness's factual summary of the unit): ${question.facts ?? "(none)"}`,
    "",
    ...(question.hunk === null
      ? []
      : [
          "## The change under review",
          "",
          `${question.hunk.path}: old lines ${span(question.hunk.oldStart, question.hunk.oldLines)}, new lines ${span(question.hunk.newStart, question.hunk.newLines)}`,
          "",
        ]),
    question.kind === "margin-card"
      ? "## The context lines the reviewer judges"
      : "## Owned lines (old = base tree, new = head tree)",
    "",
    ...question.lines.map((line) => `- ${line}`),
    "",
  ].join("\n");

/** Writes the item directory (only the question side) and returns the session's task. */
export const writeItemDir = (
  directory: string,
  question: BriefQuestion,
  trees: string,
  diff: string,
) => {
  writeFileSync(join(directory, "item.md"), itemMarkdown(question, trees));
  writeFileSync(
    join(directory, "change.diff"),
    diff.length > DIFF_LIMIT
      ? `${diff.slice(0, DIFF_LIMIT)}\n(truncated; read the trees for the rest)\n`
      : diff,
  );
  writeFileSync(
    join(directory, SCHEMA_FILE),
    `${JSON.stringify(jsonSchemaOf(BriefingOutput), null, 2)}\n`,
  );
  return taskOf(question, trees);
};

// The sheet

/** Eligible item IDs still to brief, once each (a card cited by several units repeats its ID). */
export const pendingIds = (
  sheet: SheetFile,
  force: ReadonlyArray<string> = [],
) => {
  for (const id of force) {
    const item = sheet.items.find((entry) => entry.id === id);
    if (item === undefined) throw new Error(`--force ${id}: no such item`);
    if (!isBriefed(item))
      throw new Error(`--force ${id}: a ${item.kind} item takes no briefing`);
  }
  const ids: Array<string> = [];
  for (const item of sheet.items)
    if (
      isBriefed(item) &&
      !ids.includes(item.id) &&
      (item.briefing.text === null || force.includes(item.id))
    )
      ids.push(item.id);
  return ids;
};

/** The sheet with every item of that ID briefed. */
export const applyBriefing = (
  sheet: SheetFile,
  id: string,
  briefing: { readonly text: string; readonly by: string },
): SheetFile => ({
  ...sheet,
  items: sheet.items.map((item) =>
    item.id === id ? { ...item, briefing: { ...briefing } } : item,
  ),
});

const SHEET_FILE = join(FULL_TEST_RESULTS, "sheet.json");
export const readSheetFile = (path = SHEET_FILE) =>
  existsSync(path)
    ? SheetFile.parse(JSON.parse(readFileSync(path, "utf8")))
    : undefined;
const writeSheetFiles = (sheet: SheetFile) => {
  writeFileSync(SHEET_FILE, `${JSON.stringify(sheet, null, 2)}\n`);
  writeFileSync(join(FULL_TEST_RESULTS, "sheet.md"), sheetMarkdown(sheet));
};

// Receipts

const Attempt = z.strictObject({
  attempt: z.int(),
  at: z.string(),
  route: z.literal("claude-print"),
  model: z.string(),
  effort: z.string(),
  credentialRoute: z.literal("subscription-token"),
  credentialVariable: z.literal("CLAUDE_CODE_OAUTH_TOKEN"),
  wallSeconds: z.number(),
  inputTokens: z.int().nullable(),
  cachedInputTokens: z.int().nullable(),
  outputTokens: z.int().nullable(),
  toolCalls: z.int(),
  apiEquivalentUsd: z.number().nullable(),
  outsideReads: z.array(z.string()),
  /** Why the attempt was not written: the guard's rule and matched words, or the run's failure. */
  refused: z.string().nullable(),
});
type Attempt = z.infer<typeof Attempt>;
const ItemReceipt = z.strictObject({
  id: z.string(),
  kind: z.enum(BRIEFED_KINDS),
  caseId: z.string(),
  /** False once a rebuild drops the item; its spend stays in the totals for all spend. */
  onSheet: z.boolean().default(true),
  written: z.boolean(),
  attempts: z.array(Attempt),
});
type ItemReceipt = z.output<typeof ItemReceipt>;
const Totals = z.strictObject({
  items: z.int(),
  written: z.int(),
  emptyAfterRefusal: z.int(),
  attempts: z.int(),
  refusedAttempts: z.int(),
  inputTokens: z.int(),
  cachedInputTokens: z.int(),
  outputTokens: z.int(),
  wallSeconds: z.number(),
  apiEquivalentUsd: z.number(),
});
export const BriefingReceipts = z.strictObject({
  schemaVersion: z.literal(1),
  /** Receipts hold no briefing text and no prompts; the text lives only in sheet.json. */
  items: z.array(ItemReceipt),
  /** Items now on the sheet, and every session ever run (including items a rebuild dropped). */
  totals: z.strictObject({ onSheet: Totals, all: Totals }),
});
export type BriefingReceipts = z.infer<typeof BriefingReceipts>;

const totalsOf = (items: ReadonlyArray<ItemReceipt>) => {
  const attempts = items.flatMap((item) => item.attempts);
  return {
    items: items.length,
    written: items.filter((item) => item.written).length,
    emptyAfterRefusal: items.filter((item) => !item.written).length,
    attempts: attempts.length,
    refusedAttempts: attempts.filter((a) => a.refused !== null).length,
    inputTokens: attempts.reduce((sum, a) => sum + (a.inputTokens ?? 0), 0),
    cachedInputTokens: attempts.reduce(
      (sum, a) => sum + (a.cachedInputTokens ?? 0),
      0,
    ),
    outputTokens: attempts.reduce((sum, a) => sum + (a.outputTokens ?? 0), 0),
    wallSeconds: attempts.reduce((sum, a) => sum + a.wallSeconds, 0),
    apiEquivalentUsd: attempts.reduce(
      (sum, a) => sum + (a.apiEquivalentUsd ?? 0),
      0,
    ),
  };
};

/** The items only, so a receipts file written before a totals change still reads. */
const readReceipts = (): Array<ItemReceipt> =>
  existsSync(RECEIPTS_FILE)
    ? [
        ...z
          .object({ items: z.array(ItemReceipt) })
          .parse(JSON.parse(readFileSync(RECEIPTS_FILE, "utf8"))).items,
      ]
    : [];

/** Each entry marked on or off the current sheet, with totals for the sheet and for all spend. */
export const receiptsFile = (
  items: ReadonlyArray<ItemReceipt>,
  onSheet: ReadonlySet<string>,
): BriefingReceipts => {
  const marked = items.map((item) => ({
    ...item,
    onSheet: onSheet.has(item.id),
  }));
  return BriefingReceipts.parse({
    schemaVersion: 1,
    items: marked,
    totals: {
      onSheet: totalsOf(marked.filter((item) => item.onSheet)),
      all: totalsOf(marked),
    },
  });
};
const writeReceipts = (items: ReadonlyArray<ItemReceipt>) =>
  writeFileSync(
    RECEIPTS_FILE,
    `${JSON.stringify(receiptsFile(items, new Set((readSheetFile()?.items ?? []).map((item) => item.id))), null, 2)}\n`,
  );

// The scratch trees

const git = async (args: ReadonlyArray<string>) => {
  const child = Bun.spawn(["git", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0)
    throw new Error(`git ${args.join(" ")}: exit ${code}: ${stderr.trim()}`);
  return stdout;
};

const extract = async (clone: string, revision: string, into: string) => {
  mkdirSync(into, { recursive: true });
  const archive = Bun.spawn(["git", "-C", clone, "archive", revision], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const tar = Bun.spawn(["tar", "-x", "-f", "-", "-C", into], {
    stdin: archive.stdout,
    stdout: "ignore",
    stderr: "pipe",
  });
  const [a, t, archiveErr, tarErr] = await Promise.all([
    archive.exited,
    tar.exited,
    new Response(archive.stderr).text(),
    new Response(tar.stderr).text(),
  ]);
  if (a !== 0 || t !== 0)
    throw new Error(
      `extracting ${revision}: git archive ${a}, tar ${t}: ${`${archiveErr} ${tarErr}`.trim().slice(0, 400)}`,
    );
};

/** Directories and files under `path`, never following a symlink (a tree holds none by then). */
const walkTree = (path: string, visit: (at: string, mode: number) => void) => {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined || stat.isSymbolicLink()) return;
  if (stat.isDirectory())
    for (const name of readdirSync(path)) walkTree(join(path, name), visit);
  visit(path, stat.mode);
};

const makeWritable = (path: string) =>
  walkTree(path, (at, mode) => chmodSync(at, mode | 0o200));
const makeReadOnly = (path: string) =>
  walkTree(path, (at, mode) => chmodSync(at, mode & ~0o222));

/**
 * Replaces every symlink in an extracted tree with a text file naming its target, so no file tool
 * can follow a link out of the tree; returns how many were replaced.
 */
export const flattenSymlinks = (path: string): number => {
  let replaced = 0;
  const walk = (at: string) => {
    const stat = lstatSync(at);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(at);
      unlinkSync(at);
      writeFileSync(at, `(symbolic link to ${target})\n`);
      replaced++;
    } else if (stat.isDirectory())
      for (const name of readdirSync(at)) walk(join(at, name));
  };
  walk(path);
  return replaced;
};

/**
 * Paths that would carry a benchmark's gold, labels or results into a tree, removed after
 * extraction: the named files and folders, and under `validation/` or `research/` any file or
 * folder whose name mentions gold, labels or benchmarks.
 */
export const FORBIDDEN_IN_TREES = [
  "validation/benchmarks",
  "validation/review-quality/gold.jsonl",
  "research/pr-bench/benchmarks.json",
];
const FORBIDDEN_NAME = /gold|label|benchmark/i;

/** Removes the forbidden paths from one extracted tree; returns the removed paths, relative. */
export const stripForbidden = (tree: string): Array<string> => {
  const removed: Array<string> = [];
  const remove = (relativePath: string) => {
    rmSync(join(tree, relativePath), { recursive: true, force: true });
    removed.push(relativePath);
  };
  for (const path of FORBIDDEN_IN_TREES)
    if (lstatSync(join(tree, path), { throwIfNoEntry: false }) !== undefined)
      remove(path);
  const walk = (relativePath: string) => {
    const stat = lstatSync(join(tree, relativePath), { throwIfNoEntry: false });
    if (stat === undefined || !stat.isDirectory()) return;
    for (const name of readdirSync(join(tree, relativePath))) {
      const child = `${relativePath}/${name}`;
      if (FORBIDDEN_NAME.test(name)) remove(child);
      else walk(child);
    }
  };
  for (const top of ["validation", "research"]) walk(top);
  return removed.sort();
};

interface RangeTrees {
  readonly trees: string;
  readonly diff: (paths: ReadonlyArray<string>) => Promise<string>;
  readonly release: () => void;
}

const prepareRange = async (
  work: string,
  range: ManifestCase,
): Promise<RangeTrees> => {
  const repository =
    repositories[range.repository as keyof typeof repositories];
  if (repository === undefined)
    throw new Error(`${range.id}: unknown repository ${range.repository}`);
  const slug = range.id.replace(/[^A-Za-z0-9._-]/g, "_");
  const clone = join(work, "clones", slug);
  const trees = join(work, "trees", slug);
  mkdirSync(join(work, "clones"), { recursive: true });
  await git([
    "clone",
    "--quiet",
    "--shared",
    "--no-checkout",
    repository,
    clone,
  ]);
  await extract(clone, range.base, join(trees, "base"));
  await extract(clone, range.head, join(trees, "head"));
  for (const side of ["base", "head"]) {
    const removed = stripForbidden(join(trees, side));
    if (removed.length > 0)
      console.log(
        `${new Date().toISOString()} ${range.id} ${side}: removed ${removed.length} gold, label or benchmark path(s)`,
      );
  }
  flattenSymlinks(trees);
  makeReadOnly(trees);
  return {
    trees,
    diff: (paths) =>
      git([
        "-C",
        clone,
        "diff",
        "--no-color",
        "--no-ext-diff",
        "-U3",
        range.base,
        range.head,
        "--",
        ...paths,
      ]),
    release: () => {
      try {
        rmSync(clone, { recursive: true, force: true });
        makeWritable(trees);
        rmSync(trees, { recursive: true, force: true });
      } catch (error) {
        console.log(
          `${new Date().toISOString()} could not remove ${trees}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
};

// One session

class LimitStop extends Error {}

/** One headless Opus session on the subscription token only; returns its receipt and output. */
const runSession = async (run: {
  readonly runDir: string;
  readonly trees: string;
  readonly prompt: string;
  readonly log: string;
}) => {
  const once = async () => {
    const credential = claudeCredential();
    if (credential === undefined || credential.route !== "subscription-token")
      throw new Error(
        "the owner's subscription token (CLAUDE_CODE_TOKEN in .env.local) is not available",
      );
    const schema = readFileSync(join(run.runDir, SCHEMA_FILE), "utf8");
    const { argv, env } = claudePrintCommand(
      run.runDir,
      run.trees,
      schema,
      null,
      undefined,
      credential,
    );
    const started = performance.now();
    const child = Bun.spawn(argv, {
      cwd: run.runDir,
      env,
      stdin: new TextEncoder().encode(run.prompt),
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), SESSION_TIMEOUT_MS);
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    clearTimeout(timer);
    const audited = auditClaudeLog(stdout, run.runDir, run.trees);
    const failed =
      code !== 0 || audited.result?.["is_error"] !== false
        ? `${String(audited.result?.["result"] ?? "")} ${stderr}`
        : "";
    return {
      stdout,
      stderr,
      code,
      audited,
      failed,
      wallSeconds: (performance.now() - started) / 1000,
    };
  };
  let attempt = await once();
  if (attempt.failed !== "" && isLimitFailure(attempt.failed)) {
    await new Promise((done) => setTimeout(done, LIMIT_BACKOFF_MS));
    attempt = await once();
    if (attempt.failed !== "" && isLimitFailure(attempt.failed))
      throw new LimitStop(
        "the subscription token hit its usage limit after one backoff",
      );
  }
  writeFileSync(run.log, attempt.stdout);
  writeFileSync(`${run.log}.stderr`, attempt.stderr);
  const { result, toolCalls, outside } = attempt.audited;
  const usage = (result?.["usage"] ?? {}) as Record<string, number>;
  const input =
    usage["input_tokens"] === undefined
      ? null
      : (usage["input_tokens"] ?? 0) +
        (usage["cache_read_input_tokens"] ?? 0) +
        (usage["cache_creation_input_tokens"] ?? 0);
  const structured = result?.["structured_output"];
  return {
    receipt: {
      route: "claude-print" as const,
      model: OPUS_MODEL,
      effort: "default",
      credentialRoute: "subscription-token" as const,
      credentialVariable: "CLAUDE_CODE_OAUTH_TOKEN" as const,
      wallSeconds: attempt.wallSeconds,
      inputTokens: input,
      cachedInputTokens: usage["cache_read_input_tokens"] ?? null,
      outputTokens: usage["output_tokens"] ?? null,
      toolCalls,
      apiEquivalentUsd:
        typeof result?.["total_cost_usd"] === "number"
          ? (result["total_cost_usd"] as number)
          : null,
      outsideReads: outside,
    },
    // The failure is reported by exit code only: its text could quote the session's answer.
    failure:
      attempt.failed === ""
        ? null
        : `the session failed (exit ${attempt.code})`,
    output: structured ?? null,
  };
};

const bounded = async (
  jobs: ReadonlyArray<() => Promise<void>>,
  limit: number,
) => {
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) await jobs[next++]!();
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, jobs.length) }, worker),
  );
};

/** The briefing work root: a fresh folder outside the repository. */
const workRoot = () => {
  const parent = process.env["HARNESS_COMPARE_SCRATCH"]
    ? join(resolve(process.env["HARNESS_COMPARE_SCRATCH"]), "ft-brief")
    : join(tmpdir(), "neuve-ft-brief");
  mkdirSync(parent, { recursive: true });
  const work = mkdtempSync(join(parent, "run-"));
  if (!relative(root, work).startsWith(".."))
    throw new Error(`the briefing work root ${work} is inside the repository`);
  // The sessions' private logs stay after the run, apart from every item directory and tree.
  const logs = join(parent, "logs");
  mkdirSync(logs, { recursive: true });
  return { work, logs };
};

/**
 * `full-test brief [--only id,…] [--force id,…] [--concurrency n]`: writes each pending item's
 * briefing into sheet.json and regenerates sheet.md, with receipts in sheet-briefings.json.
 */
export const briefSheet = async (
  options: {
    readonly only?: ReadonlyArray<string> | undefined;
    readonly force?: ReadonlyArray<string> | undefined;
    readonly concurrency?: number | undefined;
  } = {},
) => {
  let sheet = readSheetFile();
  if (sheet === undefined)
    throw new Error("no sheet.json; run `full-test sheet` first");
  const force = options.force ?? [];
  const pending = pendingIds(sheet, force).filter(
    (id) => options.only === undefined || options.only.includes(id),
  );
  const dev = new Set(readFullTestSelection().selected.map((r) => r.caseId));
  // Planted and real known cases are built as commits at a dev range's base; their heads never brief.
  const knownHeads = new Set(readKnownCases().map((entry) => entry.head));
  const manifest = readManifestCases();
  const firstOf = (id: string) =>
    sheet!.items.find((item) => item.id === id) as BriefedItem;
  for (const id of pending) {
    const item = firstOf(id);
    // Only the frozen dev ranges are briefed; a known or planted case never reaches a session.
    if (!dev.has(item.caseId))
      throw new Error(`${id}: ${item.caseId} is not a full-test dev range`);
    const range = manifest.get(item.caseId);
    if (range === undefined)
      throw new Error(`${id}: ${item.caseId} is not in M4's manifest`);
    if (knownHeads.has(range.head))
      throw new Error(`${id}: ${item.caseId}'s head is a known case's`);
  }
  const concurrency = Math.min(
    Math.max(1, options.concurrency ?? MAX_CONCURRENCY),
    MAX_CONCURRENCY,
  );
  const { work, logs } = workRoot();
  mkdirSync(join(work, "items"));
  const receipts = readReceipts();
  const ranges = new Map<string, Promise<RangeTrees>>();
  const left = new Map<string, number>();
  for (const id of pending) {
    const caseId = firstOf(id).caseId;
    left.set(caseId, (left.get(caseId) ?? 0) + 1);
  }
  const trees = (caseId: string) => {
    let entry = ranges.get(caseId);
    if (entry === undefined) {
      entry = prepareRange(work, manifest.get(caseId)!);
      ranges.set(caseId, entry);
    }
    return entry;
  };
  const done = async (caseId: string) => {
    const count = (left.get(caseId) ?? 1) - 1;
    left.set(caseId, count);
    if (count === 0)
      await ranges
        .get(caseId)
        ?.then((prepared) => prepared.release())
        .catch(() => undefined);
  };
  const date = new Date().toISOString().slice(0, 10);
  const by = `headless Claude Code (${OPUS_MODEL}) on the owner's subscription, ${date}`;
  let stopped: string | null = null;
  const errors: Array<{ id: string; error: string }> = [];
  const written: Array<string> = [];
  const refused: Array<{ id: string; reason: string }> = [];
  const jobs = pending.map((id) => async () => {
    const item = firstOf(id);
    if (stopped !== null) return;
    try {
      const range = manifest.get(item.caseId)!;
      const prepared = await trees(item.caseId);
      const question = questionOf(
        item,
        range,
        item.kind === "margin-card"
          ? marginContext(item, range.base)
          : undefined,
      );
      const diff = await prepared.diff(question.paths);
      const attempts: Array<Attempt> = [];
      let text: string | null = null;
      let reason: string | null = null;
      const earlier = receipts.find((r) => r.id === id)?.attempts.length ?? 0;
      for (let attempt = 1; attempt <= ATTEMPTS && text === null; attempt++) {
        const dir = mkdtempSync(join(work, "items", `${id}-`));
        const task = writeItemDir(dir, question, prepared.trees, diff);
        const prompt =
          reason === null
            ? task
            : `${task}\n\nAn earlier attempt was rejected: it ${reason}. Write the briefing again without that.`;
        const run = await runSession({
          runDir: dir,
          trees: prepared.trees,
          prompt,
          // The cumulative attempt number, so a forced rerun never overwrites an earlier log.
          log: join(logs, `${id}.${earlier + attempt}.jsonl`),
        });
        reason = run.failure;
        if (reason === null && run.receipt.outsideReads.length > 0)
          reason = `read outside its directory and trees (${run.receipt.outsideReads.length} path(s))`;
        if (reason === null) {
          try {
            text = checkSheetBriefing(
              BriefingOutput.parse(run.output).briefing,
            );
          } catch (error) {
            reason =
              error instanceof z.ZodError
                ? "returned no briefing in the schema"
                : String(error instanceof Error ? error.message : error);
          }
        }
        attempts.push({
          attempt: earlier + attempt,
          at: new Date().toISOString(),
          ...run.receipt,
          refused: text === null ? reason : null,
        });
        rmSync(dir, { recursive: true, force: true });
        console.log(
          `${new Date().toISOString()} ${id} attempt ${attempt}: ${run.receipt.wallSeconds.toFixed(0)}s, in ${run.receipt.inputTokens} (cached ${run.receipt.cachedInputTokens}), out ${run.receipt.outputTokens}, ${run.receipt.toolCalls} tool calls${text === null ? `, REFUSED: ${reason}` : ", written"}`,
        );
      }
      // Re-read before writing: other jobs may have written their briefings meanwhile.
      if (text !== null) {
        sheet = applyBriefing(readSheetFile()!, id, { text, by });
        writeSheetFiles(sheet);
        written.push(id);
      } else refused.push({ id, reason: reason ?? "unknown" });
      const previous = receipts.findIndex((r) => r.id === id);
      const entry: ItemReceipt = {
        id,
        kind: item.kind,
        caseId: item.caseId,
        onSheet: true,
        written: text !== null,
        attempts: [
          ...(previous === -1 ? [] : receipts[previous]!.attempts),
          ...attempts,
        ],
      };
      if (previous === -1) receipts.push(entry);
      else receipts[previous] = entry;
      writeReceipts(receipts);
    } catch (error) {
      if (error instanceof LimitStop) stopped = error.message;
      else {
        const message = error instanceof Error ? error.message : String(error);
        errors.push({ id, error: message });
        console.log(`${new Date().toISOString()} ${id} ERROR: ${message}`);
      }
    } finally {
      await done(item.caseId);
    }
  });
  try {
    await bounded(jobs, concurrency);
  } finally {
    for (const entry of ranges.values())
      await entry.then((prepared) => prepared.release()).catch(() => undefined);
    try {
      makeWritable(work);
      rmSync(work, { recursive: true, force: true });
    } catch (error) {
      console.log(
        `${new Date().toISOString()} could not remove ${work}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  // The final sheet.md matches sheet.json, and the receipts' marks match the sheet, even when
  // nothing was written in this call.
  writeSheetFiles(readSheetFile()!);
  writeReceipts(receipts);
  return {
    pending: pending.length,
    written,
    refused,
    errors,
    stopped,
    totals: receiptsFile(
      receipts,
      new Set(readSheetFile()!.items.map((item) => item.id)),
    ).totals,
  };
};
