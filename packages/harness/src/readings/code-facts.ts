import type { PlanSection } from "./plan.ts";

/**
 * What code writes into a section's Assess judgement from the plan alone, so the model never
 * writes it: a `size` factor (the changed-line counts), a `declared-kind` factor (the kind the
 * repository declares the file as) and a `removal` factor (a declaration only the base has), each
 * citing the plan's change fact it came from, and the `removed` impact entry of a removed
 * declaration.
 *
 * A factor is written only when the plan holds the fact it comes from (the plan holds none when the
 * facts could not be computed). Code's factors are stored beside the model's (`codeFactors`), never
 * among the factors the lane rule reads: a fact written for every section is not evidence that a
 * level is high, so it must not make the "cited evidence" rule a constant. The `removed` impact entry follows
 * the one rule `removesDeclaration`, which also decides code's own removal comment and facts line
 * (`settled.ts`, in `removalSentence`'s words),
 * so the entry and the comment are the same removal and the comment is not doubled.
 *
 * Takes only types from `plan.ts`, and nothing imports it at module load but `reading.ts` and
 * `settled.ts`.
 */

/** The parts of a plan section code's facts are read from. */
export type CodeFactsSection = Pick<
  PlanSection,
  "key" | "kind" | "declared" | "identity" | "owned" | "facts"
>;

export interface CodeFactor {
  readonly factor: "size" | "declared-kind" | "removal";
  readonly finding: string;
  /** The plan's change fact IDs it came from (`<identity key>.<fact>`). */
  readonly cites: ReadonlyArray<string>;
}

export interface CodeImpact {
  readonly effect: "removed";
  readonly text: string;
  readonly cites: ReadonlyArray<string>;
}

export interface CodeFacts {
  readonly factors: ReadonlyArray<CodeFactor>;
  readonly impact: ReadonlyArray<CodeImpact>;
}

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/** Whether code shows the section removes a declaration: a declaration or member only the base has. */
export const removesDeclaration = (
  section: Pick<PlanSection, "kind" | "identity" | "owned">,
) =>
  (section.kind === "declaration" || section.kind === "member") &&
  section.identity.parts.side === "old" &&
  section.owned.length > 0 &&
  section.owned.every((range) => range.side === "old");

/**
 * The words of code's `removed` impact entry: one sentence, the same for every removed declaration.
 * Like `removalSentence`, it says only what `removesDeclaration` checked; whether the change adds
 * something in its place elsewhere is never checked, so it is never said (NEU-446).
 */
export const REMOVED_TEXT = "The change removes this declaration.";

/**
 * What a person reads of a removed declaration, on its facts line and in code's removal comment:
 * its title and the lines it had. One sentence, built here only.
 */
export const removalSentence = (title: string, lines: number) =>
  `This change removes ${title} (${plural(lines, "line")}).`;

const lines = (section: CodeFactsSection, side: "old" | "new") =>
  section.owned
    .filter((range) => range.side === side)
    .reduce((sum, range) => sum + range.endLine - range.startLine + 1, 0);

/** Code's factors and impact entries for one section; see the module comment. */
export const codeFactsOf = (section: CodeFactsSection): CodeFacts => {
  const fact = (name: string) =>
    section.facts.find((f) => f.id === `${section.key}.${name}`);
  const factors: Array<CodeFactor> = [];
  const size = fact("size");
  if (size !== undefined)
    factors.push({
      factor: "size",
      finding: `${plural(lines(section, "new"), "line")} added and ${plural(lines(section, "old"), "line")} removed.`,
      cites: [size.id],
    });
  const declared = fact("declared-kind");
  if (section.declared !== null && declared !== undefined)
    factors.push({
      factor: "declared-kind",
      finding: `The repository declares the file ${section.declared}.`,
      cites: [declared.id],
    });
  const removes = removesDeclaration(section);
  const removal = removes
    ? [fact("declaration"), fact("old-side-only")].flatMap((f) =>
        f === undefined ||
        (f.id.endsWith(".declaration") && !f.statement.startsWith("removed"))
          ? []
          : [f.id],
      )
    : [];
  if (removal.length > 0)
    factors.push({
      factor: "removal",
      finding: `It removes a ${section.kind} that only the base has.`,
      cites: removal,
    });
  return {
    factors,
    impact: removes
      ? [{ effect: "removed", text: REMOVED_TEXT, cites: removal }]
      : [],
  };
};
