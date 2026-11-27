import type { JsonValue } from "@earendil-works/chord";
import { defineDoc, type JsonObject } from "@earendil-works/pi-durable";
import type { SubmissionOutcome } from "./agent.ts";
import type { AgentKind } from "./contract-schema.ts";

export { ToolState, AGENT_KINDS, AgentKind } from "./contract-schema.ts";

/**
 * The review stages' durable state in pi's storage (0004, 0014). pi keeps every transcript entry
 * and task checkpoint; these documents keep what the stages' tools and tasks know beyond them, so a
 * resumed run finds it without replaying a model call or a tool call.
 */

/**
 * One tool call as it was answered: the text the agent read and whether it ended the round; for a
 * call of the submit tool, what the answer was (absent in a conversation an older build stored).
 */
export type AppliedCall = {
  readonly text: string;
  readonly terminate: boolean;
  readonly submission?: SubmissionOutcome;
};

/**
 * One agent conversation's own state, written by its agent step when it binds the conversation.
 *
 * - `step`: the agent step task that owns it, which a tool or a section resolves the agent from.
 * - `system`: the system prompt, as the stage wrote it, which the kind's section renders.
 * - `applied`: by pi's call ID, every call that changed state or recorded something, committed with
 *   the state it left: a call rerun after a crash finds its answer and changes nothing again.
 * - `final`: the conversation is in its final generation, which its model calls are recorded as.
 * - `stopped`: the tool round the stage's policy ended when pi could not (tools.ts).
 */
export const AgentContextDoc = defineDoc<{
  step: {
    taskId: number;
    kind: AgentKind;
    agent: string;
    /** The step task's input, which its agent is prepared from. */
    input: JsonValue;
  } | null;
  system: string;
  /** The tool round the stage's policy ended through `endRound`: its assistant entry. */
  stopped: { assistant: number } | null;
  applied: { [callId: string]: AppliedCall };
  state: JsonValue;
  final: boolean;
}>({
  kind: "neuve.agent-context",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({
    step: null,
    system: "",
    stopped: null,
    applied: {},
    state: null,
    final: false,
  }),
});

/**
 * One tool as an agent kind offers it: what pi sends the provider (name, description and the
 * JSON Schema zod produced), whether the provider samples it strictly, and whether a call a crash
 * interrupted may run again.
 */
export type ToolDeclaration = {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonObject;
  readonly strict: boolean;
  readonly replay: "safe" | "unsafe";
};

/**
 * The run's tool declarations by agent kind, stored by the kind's first agent. They depend only on
 * the run (its search settings, the E0 coverage, the connected integrations), so every later agent
 * of the kind is checked against them, and a reopened run installs the kinds' extensions from them
 * before it resumes, with the input schemas of the step that froze them.
 */
export const RunToolsDoc = defineDoc<{
  /** By kind: its declarations and the step that froze them, which a reopened run prepares first. */
  kinds: {
    [kind: string]: { step: number; tools: Array<ToolDeclaration> };
  };
}>({
  kind: "neuve.run-tools",
  version: 1,
  scope: "session",
  initial: () => ({ kinds: {} }),
});

/**
 * The children a stage task owns, by name, written in the commit that creates each one: a phase
 * that runs again after a crash finds its child instead of starting a second.
 */
export const ChildrenDoc = defineDoc<{ children: { [name: string]: number } }>({
  kind: "neuve.stage-children",
  version: 1,
  scope: "task",
  initial: () => ({ children: {} }),
});

/**
 * The run's setup as Front settled it, which every later stage reads the range through. Its
 * external parts (the freshness check of the pinned sources, 11.18, and the stack freeze) were read
 * once; a resumed run, or a batch in another process, reads the same snapshot and pins.
 * `additions` records scope items captured before the snapshot freezes.
 */
export const RunSetupDoc = defineDoc<{
  setup: JsonValue;
  additions: Array<string>;
}>({
  kind: "neuve.run-setup",
  version: 1,
  scope: "session",
  initial: () => ({ setup: null, additions: [] }),
});

/** Contract execution stays in the owning task's SQLite document, with no pi conversation. */
export const ContractContextDoc = defineDoc<{ data: JsonValue }>({
  kind: "neuve.contract-context",
  version: 1,
  scope: "task",
  initial: () => ({ data: null }),
});

/** Terminal contract contexts, including failed partials, outlive task-document retirement. */
export const ContractPartialsDoc = defineDoc<{
  contexts: { [taskId: string]: JsonValue };
}>({
  kind: "neuve.contract-partials",
  version: 1,
  scope: "session",
  initial: () => ({ contexts: {} }),
});
