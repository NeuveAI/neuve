import type { ReviewDeskLoad } from "@workspace/ui/neuve/types"

/**
 * The person's own current disposition, as Records holds it, opens the dock
 * decided, with Undo retracting it. Nothing else is restored: a comment is
 * not a decision and Records cannot withdraw it, so a unit whose only
 * recorded item is the reader's comment opens with the dock at rest, ready
 * for another (decision 10.102).
 */
export function recordedDecision(load: ReviewDeskLoad) {
  if (load.status !== "ready") return {}
  const decision = load.data.currentDecision
  if (!decision) return {}
  return {
    decisionReceipt: {
      commandId: decision.commandId,
      kind: "disposition" as const,
    },
    initialState: {
      dock:
        decision.decision === "request-changes"
          ? ("changes-requested" as const)
          : load.data.unit.lane === "human-required"
            ? ("approved" as const)
            : ("agreed" as const),
    },
  }
}
