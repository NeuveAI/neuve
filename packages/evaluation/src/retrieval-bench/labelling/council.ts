import { createHash } from "node:crypto";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  ADJUDICATOR_GRADES,
  writeFirstStep,
  type PageItem,
  type PageSide,
} from "./adjudicator.ts";
import { jsonSchemaOf } from "./schema.ts";

/**
 * The adjudication council (decision 9.52): four models adjudicate in place of the owner. Each member
 * deliberates alone and anonymously under 9.38 (blind grade, then the two labellers in the page's
 * order), investigates the base and the range read-only, then joins a round table where it sees all
 * four positions as shuffled Member labels and may revise, until three of four agree (at most three
 * rounds). A 2–2 split, or any split left after the last round, goes to the owner as a council tie.
 *
 * Members never learn which model they or the others are: nothing shared names a family, model or
 * effort, and member-authored text is scrubbed of model names before it is shared.
 */

export interface Member {
  readonly id: string;
  readonly family: "opus" | "codex";
  /** null leaves the family's default effort. */
  readonly effort: "medium" | "high" | null;
}
export const MEMBERS: ReadonlyArray<Member> = [
  { id: "opus-medium", family: "opus", effort: "medium" },
  { id: "opus-high", family: "opus", effort: "high" },
  { id: "sol-medium", family: "codex", effort: "medium" },
  { id: "sol-high", family: "codex", effort: "high" },
];
export const MAX_ROUNDS = 3;
export const INVESTIGATION_TOOL_CALLS = 15;
export const COUNCIL_SEED = "neuve-m4-b3-council-v1";

/** The owner's page hash (FNV-1a, 32-bit, over UTF-16 code units), for the same left/right order. */
export const fnv1a = (text: string) => {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};
/** Labeller 1 and 2 exactly as the page shows them. */
export const pageOrder = (id: string, A: PageSide, B: PageSide) =>
  fnv1a(`${id}|lr`) % 2 === 0 ? [A, B] : [B, A];

/** A seeded shuffle of the members for one viewer in one round: label k is `order[k-1]`. */
export const memberLabels = (
  itemId: string,
  viewer: string,
  round: number,
  members: ReadonlyArray<{ readonly id: string }> = MEMBERS,
) => {
  const keyed = members.map((member) => ({
    member: member.id,
    key: createHash("sha256")
      .update(`${COUNCIL_SEED}|${itemId}|${viewer}|${round}|${member.id}`)
      .digest("hex"),
  }));
  return keyed
    .sort((a, b) => (a.key < b.key ? -1 : 1))
    .map((entry) => entry.member);
};

/**
 * Model and family names a member might write about itself; scrubbed from anything shared. A name
 * that already appears in the item's own material (the change or the code may be about a model) is
 * content, not identity, and is kept.
 */
const MODEL_NAMES =
  /\b(claude|opus|sonnet|haiku|anthropic|openai|chatgpt|gpt[-\w.]*|codex|sol[-\s]?\d[\w.-]*|gemini)\b/gi;
/** The model names an item's material itself contains (lower case). */
export const namesIn = (material: string) =>
  new Set(
    (material.match(MODEL_NAMES) ?? []).map((name) => name.toLowerCase()),
  );
export const scrub = (
  text: string,
  allowed: ReadonlySet<string> = new Set(),
) => {
  let count = 0;
  const cleaned = text.replace(MODEL_NAMES, (name) => {
    if (allowed.has(name.toLowerCase())) return name;
    count++;
    return "[model]";
  });
  return { text: cleaned, count };
};

const Grade = z.enum(ADJUDICATOR_GRADES);
export const Blind = z.strictObject({
  grade: Grade,
  reason: z.string().min(1),
});
export const Reveal = z.strictObject({
  decision: z.enum(["keep", "revise"]),
  grade: Grade,
  reason: z.string().min(1),
});
export const Evidence = z.strictObject({
  path: z.string(),
  lines: z.string(),
  note: z.string(),
});
export const Investigation = z.strictObject({
  grade: Grade,
  reasons: z.string().min(1),
  evidence: z.array(Evidence).max(12),
});
export const Round = z.strictObject({
  critique: z.string().min(1),
  decision: z.enum(["keep", "revise"]),
  grade: Grade,
  reason: z.string().min(1),
});
export type Investigation = z.infer<typeof Investigation>;

export const SCHEMAS = {
  "blind.schema.json": Blind,
  "reveal.schema.json": Reveal,
  "investigation.schema.json": Investigation,
  "round.schema.json": Round,
} as const;

/** Three of four on one grade (never "unsure") decides; otherwise null. */
export const majority = (votes: ReadonlyArray<string>, needed = 3) => {
  const counts = new Map<string, number>();
  for (const vote of votes) counts.set(vote, (counts.get(vote) ?? 0) + 1);
  for (const [grade, count] of counts)
    if (count >= needed && grade !== "unsure") return grade;
  return null;
};

/** Two sentences per side of a tie: the first sentence of each member's reason on that side. */
export const tieSummary = (
  positions: ReadonlyArray<{ grade: string; reason: string }>,
  allowed: ReadonlySet<string> = new Set(),
) => {
  const sides = new Map<string, Array<string>>();
  for (const position of positions) {
    const first =
      position.reason.match(/^.*?[.!?](\s|$)/)?.[0]?.trim() ?? position.reason;
    const list = sides.get(position.grade) ?? [];
    list.push(scrub(first, allowed).text);
    sides.set(position.grade, list);
  }
  return Object.fromEntries(
    [...sides.entries()].map(([grade, sentences]) => [
      grade,
      sentences.slice(0, 2).join(" "),
    ]),
  );
};

export const writeSchemas = (directory: string) => {
  for (const [file, schema] of Object.entries(SCHEMAS))
    writeFileSync(
      join(directory, file),
      `${JSON.stringify(jsonSchemaOf(schema), null, 2)}\n`,
    );
};

/** Step 1, blind: the page material only. */
export const blindPrompt = (directory: string, item: PageItem) => {
  const base = writeFirstStep(directory, item);
  writeSchemas(directory);
  return `${base.replace(
    "Give your grade and one sentence of reason.",
    "Give your grade and a short reason (one or two sentences).",
  )}\n\nYou are one of four independent reviewers; work alone.`;
};

/** Step 2, reveal: the two labellers in the page's order, written only after the blind grade. */
export const revealPrompt = (
  directory: string,
  id: string,
  A: PageSide,
  B: PageSide,
) => {
  const [first, second] = pageOrder(id, A, B);
  const side = (name: string, value: PageSide) =>
    [
      `## ${name}`,
      "",
      `Grade: **${value.grade}**`,
      value.whyItApplies === null
        ? ""
        : `\nWhy it applies: ${value.whyItApplies}`,
      value.checkBeforeDeciding === null
        ? ""
        : `\nCheck before deciding: ${value.checkBeforeDeciding}`,
      value.whyItMisleads === null
        ? ""
        : `\nWhy it misleads: ${value.whyItMisleads}`,
      value.whyInvalid === undefined || value.whyInvalid === null
        ? ""
        : `\nWhy the grader found it invalid: ${value.whyInvalid}`,
      "",
    ].join("\n");
  writeFileSync(
    join(directory, "labellers.md"),
    `# Two earlier judgements of this item\n\n${side("Labeller 1", first!)}\n${side("Labeller 2", second!)}`,
  );
  return [
    "Your blind grade is recorded in `blind.json`.",
    "Now read `labellers.md`: two earlier judgements of the same item.",
    "Keep or revise your grade, with a short reason. Your final answer must be the JSON object only.",
  ].join("\n");
};

/** Step 3, investigation: the range copied in, the base snapshot named, read-only, bounded. */
export const investigationPrompt = (
  directory: string,
  packet: string,
  snapshot: string,
) => {
  for (const part of ["range", "head"]) {
    const source = join(packet, part);
    if (existsSync(source))
      cpSync(source, join(directory, part), { recursive: true });
  }
  return [
    "Now investigate to validate your view. You may read, without changing anything:",
    `- the repository as it was before the change, read-only, at \`${snapshot}\`;`,
    "- the whole change set in `range/` (commit text, file list, full diff) and the changed file after the change in `head/`.",
    "",
    `Look at callers, tests, history or whatever you need, but use at most about ${INVESTIGATION_TOOL_CALLS} tool calls.`,
    "Then give your individual grade, your reasons, and the evidence you used (path, lines, a few words each).",
    "Your final answer must be the JSON object only.",
  ].join("\n");
};

export interface Position {
  readonly member: string;
  readonly grade: string;
  readonly reason: string;
  readonly evidence: ReadonlyArray<z.infer<typeof Evidence>>;
  readonly critique: string | null;
}

/** Round table: all four positions as shuffled Member labels for this viewer; returns scrub count. */
export const roundPrompt = (
  directory: string,
  itemId: string,
  viewer: string,
  round: number,
  positions: ReadonlyArray<Position>,
  allowed: ReadonlySet<string> = new Set(),
) => {
  const labels = memberLabels(itemId, viewer, round);
  let scrubbed = 0;
  const blocks = labels.map((member, index) => {
    const position = positions.find((p) => p.member === member)!;
    const reason = scrub(position.reason, allowed);
    const critique =
      position.critique === null ? null : scrub(position.critique, allowed);
    scrubbed += reason.count + (critique?.count ?? 0);
    const evidence = position.evidence
      .map((e) => {
        const note = scrub(e.note, allowed);
        scrubbed += note.count;
        return `- ${e.path}:${e.lines} — ${note.text}`;
      })
      .join("\n");
    return [
      `## Member ${index + 1}${member === viewer ? " (you)" : ""}`,
      "",
      `Grade: **${position.grade}**`,
      "",
      `Reasons: ${reason.text}`,
      critique === null ? "" : `\nLast critique: ${critique.text}`,
      "",
      evidence === "" ? "Evidence: none listed." : `Evidence:\n${evidence}`,
      "",
    ].join("\n");
  });
  writeFileSync(
    join(directory, `round-${round}.md`),
    `# Round table, round ${round}\n\nFour reviewers judged this item independently. They do not agree yet.\n\n${blocks.join("\n")}`,
  );
  return {
    prompt: [
      `Read \`round-${round}.md\`: the current position of all four reviewers, including yours.`,
      "Write a short critique of the other positions (where you think they are right or wrong, and why),",
      "then keep or revise your grade with a reason. The council decides when three of four agree.",
      "Your final answer must be the JSON object only.",
    ].join("\n"),
    scrubbed,
  };
};

/** Anonymity audit: model names in anything written into a member's folder by the council. */
export const auditShared = (
  directory: string,
  files: ReadonlyArray<string>,
  allowed: ReadonlySet<string> = new Set(),
) => {
  let found = 0;
  for (const file of files) {
    const path = join(directory, file);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    // labellers.md and round files are council-authored; code excerpts live in item.md only.
    found += (text.match(MODEL_NAMES) ?? []).filter(
      (hit) => !allowed.has(hit.toLowerCase()),
    ).length;
  }
  return found;
};

/**
 * A member step that produced no valid answer. It is never turned into an "unsure" vote: the item
 * stops and is retried in a later run. `limit` marks credit, quota or rate-limit failures, which
 * stop the whole run because further items would fail the same way.
 */
export class CouncilStepFailed extends Error {
  constructor(
    readonly member: string,
    readonly step: string,
    readonly reason: string,
    readonly limit: boolean,
  ) {
    super(`${member} ${step} failed${limit ? " (limit)" : ""}: ${reason}`);
  }
}

/** The step's answer, or CouncilStepFailed; `notes` are the attempts' failure notes. */
export const requireStep = <T>(
  value: T | null,
  member: string,
  step: string,
  notes: ReadonlyArray<string>,
  isLimit: (text: string) => boolean,
): T => {
  if (value !== null) return value;
  const reason =
    notes.filter(Boolean).join(" | ").slice(0, 300) || "no valid answer";
  throw new CouncilStepFailed(
    member,
    step,
    reason,
    notes.some((note) => isLimit(note)),
  );
};

/**
 * 9.56: how contested a council decision was, to pick the few items the owner verifies.
 * score = 2 × rounds of round table
 *       + members whose final grade differs from their blind grade
 *       + 2 × margin penalty (4–0: 0, 3–1: 1, 2–2: 2)
 *       + 3 if the council's grade differs from both labellers' grades
 *       + 3 if a re-run tie tied again (resolved by the lower-grade rule), 1 if it was a re-run at all
 */
export const CONTESTED_SCORE =
  "2 × rounds + members whose final grade differs from their blind grade + 2 × margin penalty (4–0: 0, 3–1: 1, 2–2: 2) + 3 if the council grade differs from both labellers + 3 if a re-run tie tied again, 1 if it was a re-run";

export const contestedScore = (input: {
  readonly grade: string;
  readonly round: number;
  readonly blind: Readonly<Record<string, string | null>>;
  readonly finals: Readonly<Record<string, string>>;
  readonly labels: ReadonlyArray<string>;
  readonly rerun: boolean;
  readonly tiedAgain: boolean;
}) => {
  const finals = Object.values(input.finals);
  const top = Math.max(
    ...[...new Set(finals)].map(
      (grade) => finals.filter((g) => g === grade).length,
    ),
  );
  const margin = top >= finals.length ? 0 : top === finals.length - 1 ? 1 : 2;
  const changed = Object.entries(input.finals).filter(
    ([member, grade]) =>
      input.blind[member] !== null && input.blind[member] !== grade,
  ).length;
  const differsFromBoth = input.labels.every((label) => label !== input.grade);
  const parts = {
    rounds: input.round,
    changed,
    margin,
    differsFromBoth,
    rerun: input.rerun,
    tiedAgain: input.tiedAgain,
  };
  const score =
    2 * input.round +
    changed +
    2 * margin +
    (differsFromBoth ? 3 : 0) +
    (input.tiedAgain ? 3 : input.rerun ? 1 : 0);
  return { score, parts };
};
