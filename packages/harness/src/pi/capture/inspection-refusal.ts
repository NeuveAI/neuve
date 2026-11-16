import { DumpFailed } from "./sources.ts";
import type {
  InspectionBudget,
  InspectionUnavailable,
} from "./credential-detectors.ts";

export const inspectionBudgetRefusal = (
  failure: InspectionUnavailable,
  budget: InspectionBudget,
  phase: "source-census" | "projection" | "finalization",
) => {
  const counters = (values: Readonly<Record<string, number>>) =>
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join(", ");
  return new DumpFailed({
    failureKind:
      failure.reason === "worker" || failure.reason === "cancelled"
        ? failure.reason
        : undefined,
    reason: `credential inspection unavailable (${failure.reason}${failure.reason === "budget" && budget.exhausted !== undefined ? `:${budget.exhausted}` : ""}); phase ${phase}; usage ${counters(budget.usage)}; limits ${counters({ ...budget.limits })}; source retained privately, export refused`,
  });
};
