import type { Context } from "@earendil-works/chord";
import type { Provider } from "@earendil-works/pi-ai";
import type { ConversationId, ModelRef } from "@earendil-works/pi-durable";
import type { AgentStage } from "../budget.ts";
import type { ReadingStage } from "./priority.ts";
import type { ReviewRequest } from "../request.ts";
import type { RouteConfig, RouteEffort } from "../route.ts";
import type { Json } from "./capture/types.ts";

/** The review task's durable input: the claimed job's run and the request it froze. */
export type ReviewRunInput = Pick<
  ReviewRequest,
  "range" | "config" | "runKey" | "generation" | "cycleId"
> & {
  readonly runId: string;
};

/**
 * Whether an agent conversation's next request is an ordinary turn or its final generation, which
 * carries the existing structured-output schema.
 */
export type AgentRouteMode =
  | { readonly kind: "normal" }
  | {
      readonly kind: "final";
      readonly schema: Readonly<Record<string, Json>>;
    };

/**
 * One agent conversation's route. The logical provider is the stable id the conversation's model
 * ref names, for normal and final generation alike; the physical provider and model are what the
 * run's frozen route actually calls, and what captures and the UI attribute.
 */
export type AgentRouteBinding = {
  readonly runId: string;
  readonly stage: AgentStage;
  readonly agent: string;
  readonly conversationId: ConversationId;
  readonly logicalProvider: string;
  readonly physicalProvider: RouteConfig["provider"];
  readonly physicalModel: string;
  /**
   * The effort the conversation's requests are made at, only when it is not the run route's: a
   * binding stored without one runs at the route's. It is stored JSON, so never `undefined`.
   */
  readonly effort?: RouteEffort;
  readonly mode: AgentRouteMode;
  /** A section reading's scheduling advice (NEU-148); absent for every other conversation. */
  readonly reading?: AgentReading;
};

/**
 * A section reading's calls as the scheduler takes them: its kind, its group's risk rank, and
 * whether it is a re-read, which goes as a continuation. Advice only: never the route's identity.
 */
export type AgentReading = {
  readonly kind: ReadingStage;
  readonly rank: number;
  readonly reread?: boolean;
};

/**
 * Builds the routed provider for one binding; its id must be the binding's logical provider. It
 * reads the binding again at dispatch, so a final mode committed later reaches the request.
 */
export type CreateRouteProvider = (
  binding: AgentRouteBinding,
  readBinding: () => Promise<AgentRouteBinding>,
) => Provider;

/**
 * The run's agent routes. `bindAgentRoute` commits the binding and registers its provider before
 * the conversation's first submission; `prepareFinalGeneration` commits final mode before the stage
 * submits its final-generation prompt; `restoreAgentRoutes` registers every persisted binding and
 * runs before the harness resumes. A conversation without a binding fails `readBinding`.
 */
export type AgentRouteRuntime = {
  readonly bindAgentRoute: (
    input: {
      readonly conversationId: ConversationId;
      readonly stage: AgentStage;
      readonly agent: string;
      readonly route: RouteConfig;
      readonly reading?: AgentReading | undefined;
      /** The step's effort; stored only when it is not the route's. */
      readonly effort?: RouteEffort | undefined;
    },
    context: Context,
  ) => Promise<ModelRef>;
  readonly prepareFinalGeneration: (
    input: {
      readonly conversationId: ConversationId;
      readonly schema: Readonly<Record<string, Json>>;
    },
    context: Context,
  ) => Promise<void>;
  readonly readBinding: (
    conversationId: ConversationId,
    context: Context,
  ) => Promise<AgentRouteBinding>;
  readonly restoreAgentRoutes: (context: Context) => Promise<void>;
};
