import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ItemContext } from "./context.ts";
import { jsonSchemaOf } from "./schema.ts";

/**
 * The neutral briefing for one adjudication item (9.38): written in a separate context that sees
 * only the hunk, the region with its wider context, the links and the scope excerpt. It never sees
 * the labellers' grades or reasons, or which retriever found the region, and it must not propose a
 * grade: an output that uses any grade word is refused.
 */

export const Briefing = z.strictObject({
  change: z.string().min(1),
  relation: z.strictObject({
    kind: z.enum([
      "calls",
      "is-called-by",
      "shares-a-rule-with",
      "defines-data-used-by",
      "uses-data-defined-by",
      "none-found",
      "other",
    ]),
    text: z.string().min(1),
  }),
  lines: z
    .array(
      z.strictObject({
        // A line, a range, or a comma-separated list of them (the contract cannot carry the pattern).
        lines: z.string().regex(/^\d+(-\d+)?(,\s*\d+(-\d+)?)*$/),
        note: z.string().min(1),
      }),
    )
    .min(1)
    .max(8),
  questions: z.array(z.string().min(1)).min(1).max(3),
});
export type Briefing = z.infer<typeof Briefing>;

/** The grade words a briefing may not use, as whole words in any case. */
export const GRADE_WORDS = /\b(necessary|useful|misleading|irrelevant)\b/i;

/** Parses a briefing and refuses one that proposes a grade by using a grade word anywhere. */
export const checkBriefing = (value: unknown) => {
  const briefing = Briefing.parse(value);
  const text = JSON.stringify(briefing);
  const word = GRADE_WORDS.exec(text);
  if (word !== null)
    throw new Error(`briefing uses the grade word "${word[1]}"`);
  return briefing;
};

const BRIEF = [
  "# Briefing task",
  "",
  "A reviewer must decide how much the REGION matters for judging whether the HUNK (a code change) is correct.",
  "Your job is to give them neutral, factual context so they can decide for themselves.",
  "",
  "Read `hunk.diff` (the change), `region.md` (the region, with its own lines marked `>` and about 30 lines around it),",
  "`links.md` (places elsewhere in the repository that share an identifier with both the region and the change, if any)",
  "and `scope.md` (the plan, ticket or commit text that states what the change should do).",
  "",
  "Write:",
  "",
  "- `change`: 2-3 sentences on what the change does.",
  "- `relation`: how the region relates to the change. Pick the kind (calls, is-called-by, shares-a-rule-with,",
  "  defines-data-used-by, uses-data-defined-by, none-found, other) and explain it in 1-2 sentences.",
  "  Say none-found if the files show no relation.",
  "- `lines`: the specific lines in the region the reviewer should look at, as line numbers from `region.md`",
  "  (for example `42` or `40-45`) with a few words each.",
  "- `questions`: 1-3 concrete questions the reviewer must answer to decide, for example",
  '  "Can you confirm X without seeing Y?".',
  "",
  "Do not propose a grade or a verdict, and do not judge how much the region matters; the reviewer decides that.",
  'Never use the words "necessary", "useful", "misleading" or "irrelevant", in any field, in any form or case,',
  "not even when quoting code or the change. Before answering, reread every field; where one of those words",
  'appears, rephrase it (for example "has no bearing on", "needed", "helps", "could steer a reader wrong") or',
  "describe the code without quoting it. An answer containing any of the four words is rejected.",
  "Use only the files in this directory. Your final answer must be the JSON object only.",
].join("\n");

/** Writes the briefing run's files into its own fresh directory and returns the prompt. */
export const writeBriefingRun = (
  directory: string,
  hunkPath: string,
  regionLabel: string,
  context: ItemContext,
) => {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "hunk.diff"),
    `# ${hunkPath}\n${context.hunkDiff}\n`,
  );
  writeFileSync(
    join(directory, "region.md"),
    `# Region: ${regionLabel}\n\n~~~~~~\n${context.region.text}\n~~~~~~\n${context.region.truncated ? "\n(truncated)\n" : ""}`,
  );
  writeFileSync(
    join(directory, "links.md"),
    context.links.length === 0
      ? "# Links\n\nNone found.\n"
      : `# Links\n\n${context.links
          .map(
            (link) =>
              `## \`${link.token}\` in ${link.path}:${link.lines}\n\n~~~~~~\n${link.excerpt}\n~~~~~~`,
          )
          .join("\n\n")}\n`,
  );
  writeFileSync(
    join(directory, "scope.md"),
    `# Scope\n\n## Commit text\n\n${context.commitText}\n\n## ${context.scope.source === "commit text" ? "No plan or ticket section matched the change" : `Best-matching section of ${context.scope.source} (chosen mechanically by shared terms; it may not apply)`}\n\n${context.scope.source === "commit text" ? "" : context.scope.text}\n${context.scope.truncated ? "\n(truncated)\n" : ""}`,
  );
  writeFileSync(
    join(directory, "briefing.schema.json"),
    `${JSON.stringify(jsonSchemaOf(Briefing), null, 2)}\n`,
  );
  return BRIEF;
};
