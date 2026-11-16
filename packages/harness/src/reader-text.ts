/**
 * Text a reviewer reads, written by code (the owner, 23 October 2026): the briefing's recorded
 * limitations carried milestone codes, decision numbers and entry handles, which mean nothing to a
 * reader. A disclosure says what the reviewer can't see or rely on, and why, in product words; its
 * technical cause (an error message, a schema complaint, the handles involved) stays in the run log
 * as the gap record's `cause`, which Records never receives.
 */

/** The step of the review a stage or agent is, as a reader names it (lower case, mid-sentence). */
export const stepName = (stage: string, agent?: string | undefined) => {
  const name = agent ?? stage;
  if (stage === "precompute") return "reading the change";
  if (stage === "frame") return "the frame step";
  if (stage === "map") return "the map step";
  if (stage === "find") {
    const lens = name.split(".")[1];
    if (lens === "scope-fit") return "the scope fit finder";
    if (lens === "correctness") return "the correctness finder";
    if (lens === "risky-edges") return "the risky edges finder";
    if (lens === "tests") return "the tests finder";
    return "the finders";
  }
  if (stage === "verify") return "the verify step";
  if (stage === "link") return "the link step";
  if (stage === "understand") return "mapping the change";
  if (name === "investigate.plan") return "planning the context search";
  if (stage === "investigate") return "gathering context";
  if (stage === "assemble") {
    if (name.endsWith(".confirm")) return "confirming the batch";
    if (name.endsWith(".digest")) return "writing the batch briefing";
    if (name.endsWith(".units")) return "grouping the units";
    return "assessing the units";
  }
  if (stage === "dispose") return "the agent review";
  if (stage === "publish") return "publishing the review";
  return "a step of the review";
};

/** The sentence-initial form of `stepName`. */
export const StepName = (stage: string, agent?: string | undefined) => {
  const name = stepName(stage, agent);
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
};

/** What a stage the run's cut-off stopped, or never started, leaves out of the review (10.42). */
export const cutOffDisclosure = (
  stage: string,
  agent: string | undefined,
  status: "interrupted" | "skipped",
) =>
  status === "skipped"
    ? `${StepName(stage, agent)} didn't start: the review reached its time limit first, so its part of the review is missing.`
    : `${StepName(stage, agent)} was cut off at the review's time limit, so its part of the review is incomplete.`;

/** Why the review rules give a hunk no owned lines, in a reader's words (its qualifications). */
export const qualificationWords = (
  qualifications: ReadonlyArray<{
    readonly kind: string;
    readonly detail: string;
  }>,
) => {
  const words = [
    ...new Set(
      qualifications.map((q) =>
        q.kind === "binary"
          ? "it is a binary file"
          : q.kind === "metadata"
            ? "it changes only the file's mode or name"
            : q.kind === "context-only"
              ? "its diff has no changed lines, only context"
              : q.kind === "missing-patch"
                ? "its patch is missing"
                : q.detail.charAt(0).toLowerCase() + q.detail.slice(1),
      ),
    ),
  ];
  return words.length === 0 ? undefined : words.join("; ");
};
