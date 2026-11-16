import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { jsonSchemaOf, GRADES } from "./schema.ts";

/**
 * A model adjudicator under the owner's protocol (9.50, 9.38): the same material the owner's page
 * shows (change, wider context, links, scope, commit text, neutral briefing), a blind first grade
 * with one sentence, then the two labellers revealed in the page's order and a keep-or-revise answer.
 *
 * The order is enforced mechanically: the labeller file is written into the run folder only after
 * the first step has finished and its grade is on disk; the second step resumes the same session.
 */

export const ADJUDICATOR_GRADES = [...GRADES, "unsure"] as const;
export type AdjudicatorGrade = (typeof ADJUDICATOR_GRADES)[number];

export const FirstStep = z.strictObject({
  grade: z.enum(ADJUDICATOR_GRADES),
  reason: z.string().min(1),
});
export const FinalStep = z.strictObject({
  decision: z.enum(["keep", "revise"]),
  finalGrade: z.enum(ADJUDICATOR_GRADES),
  reason: z.string().min(1),
});

/** The brief's grade definitions (kept in the private archive), plus "unsure". */
const DEFINITIONS = [
  "- **necessary**: without it you can't confirm the change is correct.",
  "- **useful**: it speeds understanding, but you could decide without it.",
  "- **misleading**: it looks related but would steer a reviewer wrong, for example code that shares wording with the change but not its rule.",
  "- **irrelevant**: none of the above.",
  "- **unsure**: you cannot decide from what you were given.",
].join("\n");

export interface PageItem {
  readonly id: string;
  readonly hunkPath: string;
  readonly commitSubject: string;
  readonly hunkDiff: string;
  readonly region: string;
  readonly kind: string;
  readonly regionContext: {
    readonly text: string;
    readonly truncated: boolean;
  };
  readonly links: ReadonlyArray<{
    token: string;
    path: string;
    lines: string;
    excerpt: string;
  }>;
  readonly scope: {
    readonly source: string;
    readonly heading: string | null;
    readonly text: string;
  };
  readonly commitText: string;
  readonly briefing: unknown;
}

export interface PageSide {
  readonly role: string;
  readonly grade: string;
  readonly whyItApplies: string | null;
  readonly checkBeforeDeciding: string | null;
  readonly whyItMisleads: string | null;
  /** For a grader side: why it found the addition invalid (never shown as "why it misleads"). */
  readonly whyInvalid?: string | null;
}

/** Step one: the item's material and the blind task. No labeller material exists yet. */
export const writeFirstStep = (directory: string, item: PageItem) => {
  writeFileSync(
    join(directory, "item.md"),
    [
      `# Context item ${item.id}`,
      "",
      `Change: \`${item.hunkPath}\` (${item.commitSubject})`,
      "",
      "## The change (hunk diff)",
      "",
      "~~~~~~",
      item.hunkDiff,
      "~~~~~~",
      "",
      `## The context item: ${item.region} (${item.kind})`,
      "",
      "Lines marked `>` are the item; the rest is surrounding context.",
      "",
      "~~~~~~",
      item.regionContext.text,
      "~~~~~~",
      item.regionContext.truncated ? "\n(truncated)\n" : "",
      "## Links (identifiers shared by the item and the change, found elsewhere)",
      "",
      item.links.length === 0
        ? "None found."
        : item.links
            .map(
              (link) =>
                `### \`${link.token}\` in ${link.path}:${link.lines}\n\n~~~~~~\n${link.excerpt}\n~~~~~~`,
            )
            .join("\n\n"),
      "",
      "## Scope",
      "",
      `Commit text:\n\n${item.commitText}`,
      "",
      item.scope.source === "commit text"
        ? "No plan or ticket section matched the change."
        : `Best-matching section of ${item.scope.source} (chosen mechanically; it may not apply):\n\n${item.scope.text}`,
      "",
      "## Neutral briefing",
      "",
      "~~~~~~json",
      JSON.stringify(item.briefing, null, 1),
      "~~~~~~",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(directory, "first.schema.json"),
    `${JSON.stringify(jsonSchemaOf(FirstStep), null, 2)}\n`,
  );
  writeFileSync(
    join(directory, "final.schema.json"),
    `${JSON.stringify(jsonSchemaOf(FinalStep), null, 2)}\n`,
  );
  return [
    "You are adjudicating one context item for a code-review retrieval benchmark.",
    `Work only inside \`${directory}\`. Read \`item.md\`: a change, one context item with its surroundings, links, scope and a neutral briefing.`,
    "",
    "Decide how much a reviewer needs this context item to judge whether the change is correct. Grades:",
    "",
    DEFINITIONS,
    "",
    "Give your grade and one sentence of reason. Your final answer must be the JSON object only.",
  ].join("\n");
};

/** Step two: written only after the first grade is on disk; left and right in the page's order. */
export const writeSecondStep = (
  directory: string,
  left: PageSide,
  right: PageSide,
) => {
  const side = (name: string, value: PageSide) =>
    [
      `## ${name} (${value.role === "grader" ? "a second model that checked this item" : "a labeller"})`,
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
    `# Two earlier judgements of this item\n\n${side("Left", left)}\n${side("Right", right)}`,
  );
  return [
    "Your first grade is recorded in `first-grade.json`.",
    "Now read `labellers.md`: two earlier judgements of the same item, left and right.",
    "Decide whether to keep your grade or revise it. Give your final grade (same grades as before) and one sentence.",
    "Your final answer must be the JSON object only.",
  ].join("\n");
};
