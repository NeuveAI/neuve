import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeJson } from "./parity.ts";
import { rubricChunks } from "../harness-compare/full-test/title-rubric.ts";

/**
 * The harness study (the lanes thread's reading, approved as analysis on 27 October): for a reviewer's
 * concern, the baseline run's record of it stage by stage (Understand's account of its hunk,
 * Investigate's leads, the task Dispose was handed with its tool calls and submission, and what was
 * delivered near the line), read blind by the labellers to find the first stage where the reviewer's
 * problem stops being carried forward. The lanes thread builds the items from the run's stores; an
 * item names no case, source, set, cause or score. Analysis only: nothing here reaches the harness.
 */

/** One concern and the run's record of it, as the lanes thread wrote it; the record is read, not checked. */
export const StudyItem = z.strictObject({
  id: z.string().regex(/^s[0-9a-f]{12}$/),
  concern: z.unknown(),
  understand: z.unknown(),
  investigate: z.unknown(),
  review: z.unknown(),
  delivered: z.unknown(),
});

const Understand = z.enum(["covered", "partly", "not-covered", "unsure"]);
const Lead = z.enum(["asks-the-case", "asks-nearby", "none", "unsure"]);
const Handoff = z.enum([
  "as-a-question",
  "shown-plainly",
  "framed-as-intended",
  "not-shown",
  "unsure",
]);
const Review = z.enum([
  "raised-the-concern",
  "raised-another-problem",
  "judged-fine-as-intended",
  "judged-fine-after-checking",
  "not-addressed",
  "unsure",
]);
const Delivered = z.enum(["yes", "partly", "no"]);
const FirstLost = z.enum([
  "understand",
  "investigate",
  "handoff",
  "review",
  "publish",
  "not-lost",
  "unsure",
]);

export const StudyAnswer = z.strictObject({
  id: z.string().regex(/^s[0-9a-f]{12}$/),
  understand: Understand,
  lead: Lead,
  handoff: Handoff,
  review: Review,
  delivered: Delivered,
  firstLost: FirstLost,
  reason: z.string(),
});

/** A decision may leave any question unsure, delivered included, when the passes find no majority. */
export const StudyDecided = z.strictObject({
  version: z.literal(1),
  promptDigest: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  answers: z.array(
    StudyAnswer.extend({ delivered: z.enum([...Delivered.options, "unsure"]) }),
  ),
});

export const STUDY_QUESTIONS = [
  "understand: does UNDERSTAND's account describe the behaviour the reviewer questioned? covered (it names that behaviour), partly (it names the code but not the aspect the reviewer raised), not-covered, or unsure",
  "lead: does any lead in INVESTIGATE ask about the reviewer's case (the input, state, platform or effect they raised)? asks-the-case, asks-nearby (a lead on the same code asks something else), none (no lead on that code), or unsure",
  "handoff: in REVIEW's task, how does the behaviour reach the reviewer? as-a-question (a note or reference asks about it), shown-plainly (the lines are there with no note on that aspect), framed-as-intended (something in the task presents it as intended or settled), not-shown, or unsure",
  "review: what did the review do with the concern's lines? raised-the-concern (a finding or the message states the reviewer's problem), raised-another-problem (a finding on these lines about something else), judged-fine-as-intended (it treats the behaviour as the change's intent), judged-fine-after-checking (it checked a different case or path and found it fine), not-addressed (it read the lines but says nothing about that behaviour), or unsure",
  "delivered: does anything in DELIVERED state the reviewer's problem? yes, partly or no",
  "firstLost: the first stage where the reviewer's problem is no longer carried forward: understand, investigate, handoff, review, publish, not-lost (it reached the desk), or unsure",
] as const;

/** Items per judge call: each item is tens of kilobytes. */
const CHUNK = 3;

/**
 * The lanes thread's items file (`{version, items}`) as the rubric's: every item checked, its ID
 * unique, chunked by three in the order given, under the study's questions.
 */
export const buildStudy = (itemsPath: string, folder: string) => {
  const file = z
    .object({ items: z.array(StudyItem).min(1) })
    .parse(JSON.parse(readFileSync(itemsPath, "utf8")));
  if (new Set(file.items.map((item) => item.id)).size !== file.items.length)
    throw new Error(`${itemsPath}: an item ID repeats`);
  mkdirSync(folder, { recursive: true });
  writeJson(join(folder, "rubric-items.json"), {
    version: 1,
    questions: [...STUDY_QUESTIONS],
    chunks: rubricChunks(file.items, CHUNK),
  });
  return {
    items: file.items.length,
    chunks: Math.ceil(file.items.length / CHUNK),
  };
};
