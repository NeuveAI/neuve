import type { StageRecord } from "../pipeline.ts";
import { defineDoc } from "@earendil-works/pi-durable";
import type { CrossBatchClaim } from "../readings/answers.ts";

export type CrossBatchReport = {
  readonly key: string;
  readonly target: { readonly batch: string; readonly section: string };
  readonly comment: CrossBatchClaim;
  readonly from: string;
  readonly answer: string;
};

export type RegisteredCrossBatchClaim = CrossBatchReport & {
  readonly task: number | null;
};

/** The Verify child and its report are registered in the reading's checkpoint commit. */
export const CrossBatchClaimsDoc = defineDoc<{
  claims: Record<string, RegisteredCrossBatchClaim>;
}>({
  kind: "neuve.cross-batch-claims",
  version: 1,
  scope: "session",
  initial: () => ({ claims: {} }),
});

export type CheckedCrossBatchClaim = CrossBatchReport & {
  readonly verifyKey: string | null;
};

export const checkRecord = (
  report: RegisteredCrossBatchClaim,
  record: StageRecord | undefined,
): CheckedCrossBatchClaim => {
  const { task: _task, ...claim } = report;
  return {
    ...claim,
    verifyKey:
      record?.status === "computed" || record?.status === "reused"
        ? (record.key ?? null)
        : null,
  };
};
