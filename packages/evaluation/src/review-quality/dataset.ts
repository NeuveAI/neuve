import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeInput, type Choice, type Input } from "./contract.ts";
import {
  ReviewQualityDatasetError,
  ReviewQualityGoldPending,
  ReviewQualityHoldoutSealed,
} from "./errors.ts";

export type Split = "development" | "calibration" | "holdout";
export type CaseMetadata = {
  caseId: string;
  family: string;
  variant: string;
  split: Split;
  sourceIdentityKind: "synthetic-content-sha1-not-git-commit";
  changedLines: number;
};
export type DraftGold = {
  caseId: string;
  status: "pending-independent-adjudication";
  draftChoice: Choice;
  draftRequiredSources: string[];
  reason: string;
  unknowns: string[];
};
export type AdjudicatedGold = {
  caseId: string;
  status: "adjudicated";
  acceptedChoices: Choice[];
  investigationRequired: boolean;
  requiredSources: string[];
  relevantSources: string[];
  reviewerIds: string[];
  evidence: string[];
  rationale: string;
};
export type Gold = DraftGold | AdjudicatedGold;
const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === "string" && s.length > 0);
const choices = (v: unknown): v is Choice[] =>
  strings(v) &&
  v.every((s) =>
    ["inspect", "no-additional-signal", "abstain", "ask-human"].includes(s),
  );
const keys = (v: Record<string, unknown>, allowed: string[]) =>
  Object.keys(v).length === allowed.length && allowed.every((k) => k in v);
export const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export async function readManifestHashes(directory: string): Promise<{
  inputsSha256: string;
  metadataSha256: string;
  goldSha256: string;
  adjudicationStatus:
    | "pending-independent-adjudication"
    | "partially-adjudicated"
    | "adjudicated";
}> {
  let value: unknown;
  try {
    value = JSON.parse(
      await readFile(join(directory, "manifest.json"), "utf8"),
    ) as unknown;
  } catch {
    throw new ReviewQualityDatasetError("Cannot read valid candidate manifest");
  }
  if (
    !record(value) ||
    !keys(value, [
      "schemaVersion",
      "pilotId",
      "caseCount",
      "familyCount",
      "changedLineInstances",
      "inputsSha256",
      "metadataSha256",
      "goldSha256",
      "sourceIdentityKind",
      "adjudicationStatus",
    ]) ||
    value.schemaVersion !== 1 ||
    value.pilotId !== "review-quality-synthetic-v1" ||
    value.caseCount !== 48 ||
    value.familyCount !== 12 ||
    value.changedLineInstances !== 124 ||
    value.sourceIdentityKind !== "synthetic-content-sha1-not-git-commit" ||
    (value.adjudicationStatus !== "pending-independent-adjudication" &&
      value.adjudicationStatus !== "partially-adjudicated" &&
      value.adjudicationStatus !== "adjudicated") ||
    typeof value.inputsSha256 !== "string" ||
    typeof value.metadataSha256 !== "string" ||
    typeof value.goldSha256 !== "string" ||
    ![value.inputsSha256, value.metadataSha256, value.goldSha256].every((s) =>
      /^[a-f0-9]{64}$/.test(s),
    )
  )
    throw new ReviewQualityDatasetError("Invalid frozen candidate manifest");
  return {
    inputsSha256: value.inputsSha256,
    metadataSha256: value.metadataSha256,
    goldSha256: value.goldSha256,
    adjudicationStatus: value.adjudicationStatus,
  };
}
async function rows(
  directory: string,
  file: string,
): Promise<{ text: string; values: unknown[] }> {
  let text: string;
  try {
    text = await readFile(join(directory, file), "utf8");
  } catch {
    throw new ReviewQualityDatasetError(`Cannot read ${file}`);
  }
  try {
    return {
      text,
      values: text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as unknown),
    };
  } catch {
    throw new ReviewQualityDatasetError(`Invalid JSONL in ${file}`);
  }
}
export function decodeMetadata(v: unknown): CaseMetadata {
  if (
    !record(v) ||
    !keys(v, [
      "caseId",
      "family",
      "variant",
      "split",
      "sourceIdentityKind",
      "changedLines",
    ]) ||
    typeof v.caseId !== "string" ||
    typeof v.family !== "string" ||
    typeof v.variant !== "string" ||
    !["development", "calibration", "holdout"].includes(String(v.split)) ||
    v.sourceIdentityKind !== "synthetic-content-sha1-not-git-commit" ||
    !Number.isSafeInteger(v.changedLines) ||
    (v.changedLines as number) < 1
  )
    throw new ReviewQualityDatasetError("Invalid case metadata");
  return v as CaseMetadata;
}
export function decodeGold(v: unknown): Gold {
  if (!record(v) || typeof v.caseId !== "string")
    throw new ReviewQualityDatasetError("Invalid gold record");
  if (v.status === "pending-independent-adjudication") {
    if (
      !keys(v, [
        "caseId",
        "status",
        "draftChoice",
        "draftRequiredSources",
        "reason",
        "unknowns",
      ]) ||
      !choices([v.draftChoice]) ||
      !strings(v.draftRequiredSources) ||
      typeof v.reason !== "string" ||
      !strings(v.unknowns)
    )
      throw new ReviewQualityDatasetError("Invalid draft gold");
    return v as DraftGold;
  }
  if (
    v.status !== "adjudicated" ||
    !keys(v, [
      "caseId",
      "status",
      "acceptedChoices",
      "investigationRequired",
      "requiredSources",
      "relevantSources",
      "reviewerIds",
      "evidence",
      "rationale",
    ]) ||
    !choices(v.acceptedChoices) ||
    v.acceptedChoices.length === 0 ||
    typeof v.investigationRequired !== "boolean" ||
    !strings(v.requiredSources) ||
    !strings(v.relevantSources) ||
    !strings(v.reviewerIds) ||
    v.reviewerIds.length === 0 ||
    !strings(v.evidence) ||
    v.evidence.length === 0 ||
    typeof v.rationale !== "string" ||
    v.rationale.length === 0
  )
    throw new ReviewQualityDatasetError(
      "Gold requires explicit adjudication provenance",
    );
  if (
    !v.requiredSources.every((id) =>
      (v.relevantSources as string[]).includes(id),
    )
  )
    throw new ReviewQualityDatasetError(
      "Required sources must be declared relevant",
    );
  return v as AdjudicatedGold;
}
export async function readInputs(
  directory: string,
): Promise<{ inputs: Input[]; sha256: string }> {
  const raw = await rows(directory, "inputs.jsonl");
  const inputs = raw.values.map(decodeInput);
  if (new Set(inputs.map((i) => i.caseId)).size !== inputs.length)
    throw new ReviewQualityDatasetError("Duplicate input case IDs");
  return { inputs, sha256: sha256(raw.text) };
}
export async function readMetadata(directory: string): Promise<CaseMetadata[]> {
  const metadata = (await rows(directory, "metadata.jsonl")).values.map(
    decodeMetadata,
  );
  if (new Set(metadata.map((m) => m.caseId)).size !== metadata.length)
    throw new ReviewQualityDatasetError("Duplicate metadata case IDs");
  const familySplits = new Map<string, Split>();
  for (const m of metadata) {
    const split = familySplits.get(m.family);
    if (split !== undefined && split !== m.split)
      throw new ReviewQualityDatasetError("Family leaks across dataset splits");
    familySplits.set(m.family, m.split);
  }
  return metadata;
}
/** Structural verification can inspect label status; this function is never part of model preparation. */
export async function readGoldStatus(directory: string): Promise<{
  pending: number;
  adjudicated: number;
  cases: { caseId: string; status: Gold["status"] }[];
}> {
  const labels = (await rows(directory, "gold.jsonl")).values.map(decodeGold);
  if (new Set(labels.map((l) => l.caseId)).size !== labels.length)
    throw new ReviewQualityDatasetError("Duplicate gold case IDs");
  return {
    pending: labels.filter(
      (l) => l.status === "pending-independent-adjudication",
    ).length,
    adjudicated: labels.filter((l) => l.status === "adjudicated").length,
    cases: labels.map((l) => ({ caseId: l.caseId, status: l.status })),
  };
}
export async function loadModelCases(
  directory: string,
  split: Split,
  authorizeHoldout = false,
): Promise<Input[]> {
  if (split === "holdout" && !authorizeHoldout)
    throw new ReviewQualityHoldoutSealed(
      "Holdout model inputs remain sealed until explicitly authorized",
    );
  const { inputs } = await readInputs(directory);
  const metadata = await readMetadata(directory);
  if (
    inputs.length !== metadata.length ||
    inputs.some((i) => !metadata.some((m) => m.caseId === i.caseId))
  )
    throw new ReviewQualityDatasetError(
      "Input/metadata case ownership mismatch",
    );
  const ids = new Set(
    metadata.filter((m) => m.split === split).map((m) => m.caseId),
  );
  return inputs.filter((i) => ids.has(i.caseId));
}
export async function loadScoringGold(
  directory: string,
  ids: readonly string[],
  authorizeHoldout = false,
): Promise<AdjudicatedGold[]> {
  const metadata = await readMetadata(directory);
  const selections = new Set(ids);
  if (
    !authorizeHoldout &&
    metadata.some((m) => selections.has(m.caseId) && m.split === "holdout")
  )
    throw new ReviewQualityHoldoutSealed(
      "Holdout gold remains sealed until explicitly authorized",
    );
  if (
    ids.length !== selections.size ||
    ids.some((id) => !metadata.some((m) => m.caseId === id))
  )
    throw new ReviewQualityDatasetError(
      "Unknown or duplicate scoring case IDs",
    );
  const labels = (await rows(directory, "gold.jsonl")).values
    .map(decodeGold)
    .filter((g) => selections.has(g.caseId));
  if (
    labels.length !== selections.size ||
    new Set(labels.map((g) => g.caseId)).size !== selections.size
  )
    throw new ReviewQualityDatasetError("Missing or duplicate scoring gold");
  if (labels.some((g) => g.status !== "adjudicated"))
    throw new ReviewQualityGoldPending(
      "Pending independent gold cannot produce a semantic quality score",
    );
  return labels as AdjudicatedGold[];
}
