import { admit, type Input } from "./contract.ts";
import { decodeGold, type AdjudicatedGold } from "./dataset.ts";
import {
  ReviewQualityDatasetError,
  ReviewQualityGoldPending,
} from "./errors.ts";

export type ProviderUsage =
  | {
      kind: "unavailable";
      reason: "model-not-invoked" | "provider-usage-not-reported";
    }
  | {
      kind: "reported";
      model: string;
      calls: number;
      inputTokens: number | null;
      outputTokens: number | null;
      costUsd: number | null;
      pricingSource: string | null;
    };
export type Prediction = {
  caseId: string;
  output: unknown;
  usage: ProviderUsage;
};
export function scorePredictions(
  inputs: readonly Input[],
  gold: readonly AdjudicatedGold[],
  predictions: readonly Prediction[],
) {
  const inputMap = new Map(inputs.map((i) => [i.caseId, i])),
    goldMap = new Map(gold.map((g) => [g.caseId, decodeGold(g)]));
  if (
    inputs.length === 0 ||
    inputMap.size !== inputs.length ||
    goldMap.size !== gold.length ||
    predictions.length !== inputs.length ||
    new Set(predictions.map((p) => p.caseId)).size !== inputs.length ||
    gold.length !== inputs.length
  )
    throw new ReviewQualityDatasetError(
      "Scoring requires exactly one input, gold and prediction per case",
    );
  let admitted = 0,
    rejected = 0,
    answered = 0,
    abstained = 0,
    unsafeFalseNegatives = 0,
    investigationObligations = 0,
    wrongChoices = 0,
    answeredWrongChoices = 0,
    unnecessaryInvestigation = 0,
    wrongAttribution = 0,
    missingAttribution = 0,
    duplicateCitations = 0,
    unavailableUsage = 0;
  let costUsd: number | null = 0,
    reportedCalls = 0;
  const cases = [];
  for (const prediction of predictions) {
    const input = inputMap.get(prediction.caseId),
      label = goldMap.get(prediction.caseId);
    if (!input || !label)
      throw new ReviewQualityDatasetError(
        "Prediction lacks exact input/gold ownership",
      );
    if (label.status !== "adjudicated")
      throw new ReviewQualityGoldPending(
        "Draft labels cannot produce a quality score",
      );
    if (
      [...label.requiredSources, ...label.relevantSources].some(
        (id) => !input.sources.some((s) => s.id === id),
      )
    )
      throw new ReviewQualityDatasetError(
        "Gold attribution names unprovided source",
      );
    if (prediction.usage.kind === "unavailable") {
      unavailableUsage++;
      costUsd = null;
    } else {
      const usage = prediction.usage;
      if (
        !Number.isSafeInteger(usage.calls) ||
        usage.calls < 1 ||
        [usage.inputTokens, usage.outputTokens].some(
          (n) => n !== null && (!Number.isSafeInteger(n) || n < 0),
        ) ||
        (usage.costUsd !== null &&
          (!Number.isFinite(usage.costUsd) ||
            usage.costUsd < 0 ||
            !usage.pricingSource ||
            !usage.model))
      )
        throw new ReviewQualityDatasetError("Invalid measured provider usage");
      reportedCalls += usage.calls;
      if (usage.costUsd === null) costUsd = null;
      else if (costUsd !== null) costUsd += usage.costUsd;
    }
    if (label.investigationRequired) investigationObligations++;
    const admission = admit(input, prediction.output);
    if (admission.kind === "rejected") {
      rejected++;
      cases.push({
        caseId: prediction.caseId,
        admission: "rejected",
        reason: admission.reason,
      });
      continue;
    }
    admitted++;
    const output = admission.output;
    const abstention =
      output.choice === "abstain" || output.choice === "ask-human";
    if (abstention) abstained++;
    else answered++;
    const falseNegative =
      label.investigationRequired && output.choice === "no-additional-signal";
    if (falseNegative) unsafeFalseNegatives++;
    const wrong = !label.acceptedChoices.includes(output.choice);
    if (wrong) wrongChoices++;
    if (wrong && !abstention) answeredWrongChoices++;
    if (!label.investigationRequired && output.choice === "inspect")
      unnecessaryInvestigation++;
    const linked = new Set(output.citations.map((c) => c.sourceId));
    const missing = label.requiredSources.filter((id) => !linked.has(id));
    const unrelated = output.citations.filter(
      (c) => !label.relevantSources.includes(c.sourceId),
    );
    const distinctCitations = new Set(
      output.citations.map((c) => JSON.stringify([c.sourceId, c.start, c.end])),
    );
    const duplicates = output.citations.length - distinctCitations.size;
    missingAttribution += missing.length;
    wrongAttribution += unrelated.length;
    duplicateCitations += duplicates;
    cases.push({
      caseId: prediction.caseId,
      admission: "admitted",
      choice: output.choice,
      abstention,
      unsafeFalseNegative: falseNegative,
      wrongChoice: wrong,
      missingSources: missing,
      unrelatedSources: unrelated.map((c) => c.sourceId),
      duplicateCitations: duplicates,
      humanDecisionRequired: admission.humanDecisionRequired,
      finalDisposition: admission.finalDisposition,
    });
  }
  return {
    cases,
    total: inputs.length,
    admitted,
    rejected,
    answered,
    abstained,
    unsafeFalseNegatives,
    investigationObligations,
    wrongChoices,
    unnecessaryInvestigation,
    wrongAttribution,
    missingAttribution,
    duplicateCitations,
    answerCoverage: answered / inputs.length,
    selectiveChoiceRisk: answered ? answeredWrongChoices / answered : null,
    unsafeFalseNegativeRate: investigationObligations
      ? unsafeFalseNegatives / investigationObligations
      : null,
    cost: {
      status: costUsd === null ? "unavailable" : "reported",
      usd: costUsd,
      reportedCalls,
      casesWithUnavailableUsage: unavailableUsage,
    },
    advisoryCommentNoise:
      "unmeasured: output contract contains source citations and choices, not generated comments",
    probabilityCalibration: "unmeasured: no provider probabilities supplied",
  };
}
