import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  CATEGORIES,
  categoryDefinitions,
  firstAndLaterDiffs,
  type Category,
} from "./concerns.ts";
import { labelOf, type ConcernRow } from "./evidence.ts";
import { shuffled } from "./matching.ts";
import {
  MESSAGE_LIMIT,
  beforeLabellingDigest,
  labellingDigest,
  laterChangeOf,
  matchedCases,
  opaqueId,
  threadTexts,
  writeJson,
} from "./parity.ts";
import { rubricChunks } from "../harness-compare/full-test/title-rubric.ts";

/**
 * A category relabel (10.142): the concerns the labelling put in one category, judged again, blind,
 * on the categories' one-line definitions, two passes and a third on ties. Its first use is
 * "performance", which now holds only concerns resting on runtime-informed data; runtime behaviour
 * visible in the code is runtime best practice and stays in the parity aim. The case's labelling is
 * left as it was: the relabel is written beside it, as `labels/category-relabel.json`, for the headline
 * to read. Relabels of several categories share the file, merged by thread; a thread the relabel
 * left unsure is not in it, so it keeps its label. The file names the labelling it read: a case
 * labelled again leaves it stale, read as absent.
 */

const CHUNK = 10;

export const RecategorizeItem = z.strictObject({
  id: z.string().regex(/^k[0-9a-f]{12}$/),
  concern: z.strictObject({
    /** The file and line the thread is anchored to on the first revision, when it has one. */
    at: z.string().nullable(),
    thread: z.array(z.string()),
  }),
  laterChange: z.string(),
});

/** The categories a relabel can give: every category but none, which the judge cannot answer. */
const Relabelled = z.enum(
  Object.keys(CATEGORIES).filter((name) => name !== "none") as [
    Category,
    ...Array<Category>,
  ],
);
const Answered = z.enum([...Relabelled.options, "unsure"]);

export const RecategorizeAnswer = z.strictObject({
  id: z.string().regex(/^k[0-9a-f]{12}$/),
  category: Answered,
  reason: z.string(),
});

export const RecategorizeDecided = z.strictObject({
  version: z.literal(1),
  promptDigest: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  answers: z.array(RecategorizeAnswer),
});

export const RECATEGORIZE_QUESTIONS = [
  `category: the main kind of the CONCERN, one of:\n${categoryDefinitions("  ")
    .split("\n")
    .filter((line) => !line.startsWith("  - none:"))
    .join("\n")}\n(or unsure)`,
] as const;

/**
 * A case's relabels, beside its concern labels: each relabelled thread's category before and after,
 * and the wording it was judged under; `labelling` is the digest of the concern labels they read.
 */
export const CategoryRelabel = z.strictObject({
  version: z.literal(1),
  labelling: z.string().regex(/^[0-9a-f]{64}$/),
  categories: z.record(
    z.string(),
    z.strictObject({
      was: z.string(),
      now: Relabelled,
      promptDigest: z.string().regex(/^[0-9a-f]{64}$/),
    }),
  ),
});

/**
 * The relabel's items and key into `<folder>`, which must be new or empty: every thread of the matched
 * cases (development and pilot) whose majority label is in `category`, as the judge's item, with no
 * case, run or label. An item's ID names the seed and what the judge is shown.
 */
export const buildRecategorize = (
  folder: string,
  seed: number,
  category: Category,
) => {
  if (category === "none")
    throw new Error(
      "a relabel of none is refused: the judge cannot answer none",
    );
  if (existsSync(folder) && readdirSync(folder).length > 0)
    throw new Error(
      `${folder} is not empty: a relabel is built into a folder of its own`,
    );
  const built = matchedCases().flatMap(({ record, caseLabels }) => {
    const rows = readFileSync(join(caseLabels, "concerns.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as ConcernRow)
      .filter((row) => labelOf(row)?.category === category);
    if (rows.length === 0) return [];
    const threads = threadTexts(record);
    const diffs = firstAndLaterDiffs(record);
    const labelling = labellingDigest(caseLabels);
    return rows.map((row) => {
      const key = row.firstRevisionKey;
      // A key is <path>:<side>:<line>; the path may hold colons.
      const parts = key === null ? null : key.split(":");
      const path = parts === null ? null : parts.slice(0, -2).join(":");
      const shown = {
        concern: {
          at:
            parts === null
              ? null
              : `${path}${parts.at(-2) === "old" ? " (before the change)" : ""}: line ${parts.at(-1)}`,
          thread: (threads.get(row.id) ?? []).map((text) =>
            text.slice(0, MESSAGE_LIMIT),
          ),
        },
        laterChange:
          path === null
            ? "(the thread has no file)"
            : laterChangeOf(diffs, path),
      };
      const id = opaqueId(
        "k",
        `${record.caseId}|${row.id}|${seed}|${JSON.stringify(shown)}`,
      );
      return {
        item: RecategorizeItem.parse({ id, ...shown }),
        key: {
          id,
          caseId: record.caseId,
          ref: row.id,
          labels: caseLabels,
          labelling,
          was: category,
        },
      };
    });
  });
  const items = shuffled(
    built.map((one) => one.item),
    seed,
  );
  mkdirSync(folder, { recursive: true });
  writeJson(join(folder, "items.json"), {
    version: 1,
    questions: [...RECATEGORIZE_QUESTIONS],
    chunks: rubricChunks(items, CHUNK),
  });
  writeJson(join(folder, "key.json"), {
    version: 1,
    seed,
    category,
    keys: built.map((one) => one.key),
  });
  return { concerns: built.length };
};

/** A case's relabel file, or a clear refusal: one from before the labelling digest, or no relabel. */
const readRelabel = (path: string) => {
  const held = JSON.parse(readFileSync(path, "utf8")) as Record<
    string,
    unknown
  >;
  if (typeof held["labelling"] !== "string") throw beforeLabellingDigest(path);
  const parsed = CategoryRelabel.safeParse(held);
  if (!parsed.success)
    throw new Error(
      `${path} is not a category relabel: ${parsed.error.message.slice(0, 300)}`,
    );
  return parsed.data;
};

/**
 * Each judged thread's category as parity reads it, from a case's concern labels folder: its labelling's
 * majority category ("none" where the passes named different ones), replaced by its relabel's when the
 * case's category-relabel.json was written over the labelling as it stands. A relabel of an earlier
 * labelling is not read. Unjudged threads are left out. The parity readers (the headline, the lanes
 * floor and candidate compares) all read categories through this.
 */
export const concernCategories = (caseLabels: string) => {
  const categories = new Map<string, string>();
  for (const line of readFileSync(join(caseLabels, "concerns.jsonl"), "utf8")
    .split("\n")
    .filter((one) => one !== "")) {
    const row = JSON.parse(line) as ConcernRow;
    const label = labelOf(row);
    if (label !== null) categories.set(row.id, label.category);
  }
  const relabel = relabelState(caseLabels);
  if (relabel.state === "current")
    for (const [ref, entry] of Object.entries(relabel.file.categories))
      if (categories.has(ref)) categories.set(ref, entry.now);
  return categories;
};

/**
 * A case's category relabel and whether parity reads it: "none" when the case has none, "current" when
 * it was written over the labelling as it stands, "stale" when over an earlier one (read as absent,
 * the labeller's categories standing, and counted by the readers so a stale relabel cannot hide). A
 * file that is no relabel, or one from before the labelling digest, is refused, as readRelabel does.
 */
export const relabelState = (caseLabels: string) => {
  const path = join(caseLabels, "category-relabel.json");
  if (!existsSync(path)) return { state: "none" as const, file: null };
  const file = readRelabel(path);
  return file.labelling === labellingDigest(caseLabels)
    ? { state: "current" as const, file }
    : { state: "stale" as const, file };
};

/** What moved: each category the relabel put the threads in, and those it left unsure. */
export const recategorizeReport = (
  keys: ReadonlyArray<{ id: string; was: string }>,
  answers: ReadonlyArray<{ id: string; category: string }>,
) => {
  const byId = new Map(answers.map((answer) => [answer.id, answer.category]));
  const moved: Record<string, number> = {};
  for (const key of keys) {
    const now = byId.get(key.id);
    if (now === undefined) continue;
    const name = now === key.was ? `stays ${now}` : `${key.was} -> ${now}`;
    moved[name] = (moved[name] ?? 0) + 1;
  }
  return {
    concerns: keys.length,
    decided: keys.filter((key) => byId.has(key.id)).length,
    moved,
  };
};

/**
 * Reads the decided answers against the key: writes report.json, and, once every thread is decided,
 * merges them into each case's category-relabel.json beside its concern labels: this build's threads
 * replace their earlier entries, others' stay, a thread left unsure is left out. Entries of an earlier
 * labelling are dropped; a case labelled again since this build is not written.
 */
export const settleRecategorize = (folder: string) => {
  const key = JSON.parse(readFileSync(join(folder, "key.json"), "utf8")) as {
    keys: Array<{
      id: string;
      caseId: string;
      ref: string;
      labels: string;
      labelling: string;
      was: string;
    }>;
  };
  if (key.keys.some((one) => typeof one.labelling !== "string"))
    throw beforeLabellingDigest(join(folder, "key.json"));
  const decided = RecategorizeDecided.parse(
    JSON.parse(readFileSync(join(folder, "decided.json"), "utf8")),
  );
  const report = recategorizeReport(key.keys, decided.answers);
  const complete = report.decided === report.concerns;
  const stale: Array<string> = [];
  if (complete && decided.promptDigest !== undefined) {
    const byId = new Map(decided.answers.map((answer) => [answer.id, answer]));
    for (const labels of new Set(key.keys.map((one) => one.labels))) {
      if (!existsSync(labels)) continue;
      const mine = key.keys.filter((one) => one.labels === labels);
      const labelling = labellingDigest(labels);
      if (mine.some((one) => one.labelling !== labelling)) {
        stale.push(mine[0]!.caseId);
        continue;
      }
      const path = join(labels, "category-relabel.json");
      // A held file of an earlier labelling is dropped; one that is no relabel at all is refused,
      // never overwritten.
      const held = existsSync(path) ? readRelabel(path) : null;
      const categories: Record<
        string,
        z.infer<typeof CategoryRelabel>["categories"][string]
      > =
        held !== null && held.labelling === labelling
          ? { ...held.categories }
          : {};
      for (const one of mine) {
        delete categories[one.ref];
        const now = byId.get(one.id)!.category;
        if (now !== "unsure")
          categories[one.ref] = {
            was: one.was,
            now,
            promptDigest: decided.promptDigest,
          };
      }
      writeJson(
        path,
        CategoryRelabel.parse({ version: 1, labelling, categories }),
      );
    }
  }
  writeJson(join(folder, "report.json"), {
    ...report,
    complete,
    promptDigest: decided.promptDigest ?? null,
    staleCases: stale,
  });
  return { ...report, complete, staleCases: stale };
};
