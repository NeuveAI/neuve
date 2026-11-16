import type { AgentStage } from "../budget.ts";
import type { Priority } from "../budget/scheduler.ts";

/** The readings that judge a changed section, and the briefing written from them. */
export type ReadingStage = "assess" | "lane-review" | "brief";
export type CallStage = AgentStage | ReadingStage;

const order = {
  frame: 10,
  map: 20,
  find: 30,
  assess: 40,
  "lane-review": 50,
  brief: 60,
  verify: 90,
} satisfies Record<CallStage, number>;

const isReading = (stage: CallStage): stage is ReadingStage =>
  stage === "assess" || stage === "lane-review" || stage === "brief";

/**
 * A reading waits in the readings band by `rank` (its owner's risk rank, higher first); a reading's
 * follow-up turn (`continued`) goes before its owner's unstarted readings, while its conversation
 * and the provider's prompt cache are still warm.
 */
export const reviewPriority = (
  stage: CallStage,
  continued: boolean,
  rank = 0,
): Priority =>
  isReading(stage)
    ? {
        class: "interactive",
        position: continued ? "continuation" : "new",
        stage: order[stage],
        reading: { rank },
      }
    : {
        class: "interactive",
        stage: order[stage],
        // The socket protocol retains this position literal until its separate migration.
        position:
          stage === "frame" || stage === "map"
            ? "understand"
            : continued
              ? "continuation"
              : stage === "find"
                ? "new"
                : "started",
      };
