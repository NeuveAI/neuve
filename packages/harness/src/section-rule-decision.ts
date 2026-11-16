import { z } from "zod";

/**
 * What a rule decision is (decision 14.17), apart from the rules that make it: the reading plan
 * reads this module only, so it loads no Graph, Git or Linguist code. `ruleDecisionsOf` in
 * `section-rules.ts` makes the decisions.
 */

/**
 * The recipe of which judgements decide a section. It changes whenever that changes: a rule added
 * to or taken from `DECIDING_RULE_NAMES`, an exclusion added or dropped, a limit reworded, or the
 * order that picks between two decisions. A rule's own version is carried in each decision, not
 * here.
 */
export const RULE_SKIPS_RECIPE = "neuve-rule-skips-v1";

/**
 * The rules whose holding judgement can decide a section, in the order that picks between two
 * decisions of one section. Each is a `SectionRuleName` (`section-rules.ts` checks it).
 */
export const DECIDING_RULE_NAMES = [
  "generated",
  "blank-rows-only",
  "whitespace-only",
  "imports-only",
  "moved-unchanged",
] as const;
export const DecidingRuleName = z.enum(DECIDING_RULE_NAMES);
export type DecidingRuleName = z.infer<typeof DecidingRuleName>;

/** Why code decides a section, so it gets no model reading. */
export const RuleDecision = z.strictObject({
  /** Which rule. */
  rule: DecidingRuleName,
  /** That rule's version, as the judgement gives it. */
  version: z.int().min(1),
  /** The judgement's id, `<section key>.rule:<rule>`. */
  judgement: z.string(),
  /** What the rule read, as the judgement says it. */
  statement: z.string(),
  /** A stated limit of the rule, when it has one. */
  limit: z.string().nullable(),
});
export type RuleDecision = z.infer<typeof RuleDecision>;
