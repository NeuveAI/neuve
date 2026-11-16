import { readData } from "@neuve/records-core";
import { callUsageOf } from "../providers/usage.ts";
export { callUsageOf } from "../providers/usage.ts";
import type { AssistantMessage, ToolCall, Usage } from "@earendil-works/pi-ai";
import { AssistantEntry, type EntryRecord } from "@earendil-works/pi-durable";
import type { z } from "zod";
import type { AgentStage } from "../../budget.ts";
import type { ContextFigures } from "../../pipeline.ts";
import {
  addUsage,
  zeroUsage,
  type CallUsage,
  type RouteEffort,
} from "../../route.ts";
import type { ToolSpec } from "../../toolkit.ts";
import { isRefusal } from "../providers/failure.ts";
import type { ToolState } from "./docs.ts";

/**
 * One agent context of a review stage on pi (0014): what it is told, the tools it reads with, the
 * strict tool it ends by calling, and code's checks, repair and backstop of what it submits. pi's
 * generation task makes every model call and its tool tasks run every tool call; the agent step
 * task (agent-step.ts) only decides, between pi's runs, whether the context is done, gets the open
 * items, or makes its final generation, by the same rules as before (§3.4, 10.11).
 */
export interface AgentSpec<O> {
  readonly stage: AgentStage;
  /** The agent context's ID within the run, such as `investigate.p1`. */
  readonly agent: string;
  readonly turnLimit: number;
  readonly retries?: number | undefined;
  /**
   * The effort this step runs at when it is not the one its stage gets from the route
   * (`stepEffortOf`): its key and its requests follow it. Frame, Map, the finders and Verify set
   * none; their kind is their `stage`. The readers' steps run under stage `verify` for now. Assess
   * and Lane review always set it (`readingStepEffort` in `readings/effort.ts`): their
   * `review.stepEffort` entry when there is one, else the lower of the route's effort and medium. A
   * claim check sets none and runs at its stage's effort. With effort by risk on, all three set
   * fixed levels.
   */
  readonly effort?: RouteEffort | undefined;
  readonly system: string;
  readonly task: string;
  readonly tools: ReadonlyArray<ToolSpec<unknown>>;
  readonly submit: {
    readonly description: string;
    readonly schema: z.ZodType<O>;
    /** The submit tool's name; `submit_<stage>` unless a stage has two kinds of agent. */
    readonly name?: string | undefined;
  };
  /** Builds the stage's output from what the agent recorded, when no generation produced one. */
  readonly backstop: () => O;
  /**
   * Code's checks of a schema-valid output (hard integrity rules, such as every hunk in exactly one
   * behaviour): each problem in words. A submission with problems is answered with them and not
   * accepted, as a schema error is.
   */
  readonly check?: ((output: O) => ReadonlyArray<string>) | undefined;
  /**
   * Advice on an output that passes its checks, returned to the agent once per context and then
   * accepted as it stands.
   */
  readonly advise?: ((output: O) => ReadonlyArray<string>) | undefined;
  /**
   * Makes a schema-valid output that still has problems pass its checks once the agent's chances
   * are used up, disclosing what it changed, rather than discarding the agent's work.
   */
  readonly repair?: ((output: O) => O) | undefined;
  /** The checks a repaired output must pass, when they differ from `check`. */
  readonly checkRepaired?: ((output: O) => ReadonlyArray<string>) | undefined;
  /** More of the budget line every tool result ends with, such as each hunk's allowance use. */
  readonly budgetNote?: (() => string) | undefined;
  /**
   * What the context's tools hold between calls (handles, findings, reading budget, head reads): restored from the
   * conversation's durable state before each call and stored with its result (docs.ts).
   */
  readonly state?: ToolStateHolder | undefined;
  /**
   * A model call the provider could not answer. Absent, it holds the step until the job resumes.
   * `"fail"`, the step ends failed with that failure, so its caller can record its part as not
   * done, unless the failure is the account's own (`isAccountFailure`), which still holds.
   */
  readonly unanswered?: "fail" | undefined;
}

export interface ToolStateHolder {
  /** Puts the durable state in the tools' objects, or their first state when there is none yet. */
  readonly load: (state: ToolState | undefined, turn: number) => void;
  readonly save: () => ToolState;
}

/**
 * An agent step: one context and its computation, as `agentStage` keyed and stored it. `compose`
 * turns the context's result into the stored output; `partial` is what a context cut off by the
 * run's cut-off keeps (10.42), stored under a key of this run only; `note` describes the stored
 * result on the receipt.
 */
export interface AgentStep<O, S> {
  readonly spec: AgentSpec<O>;
  readonly op: string;
  readonly opVersion: number;
  readonly inputs: Record<string, unknown>;
  readonly compose: (result: AgentResult<O>) => S;
  readonly partial?:
    ((summary: Omit<AgentResult<O>, "output">) => S) | undefined;
  readonly planned?: Readonly<Record<string, number>> | undefined;
  readonly note?:
    ((output: S, context: ContextFigures | undefined) => string) | undefined;
  readonly schema: z.ZodType<S>;
  /**
   * Tools whose effects reach outside the run (a proxied integration read that adds to the cycle's
   * snapshot): a call a crash interrupted is reported to the agent as interrupted, never run again.
   */
  readonly external?: ReadonlySet<string> | undefined;
}

/**
 * A step with its output types erased, for the one task that runs every kind: each value it hands
 * the step's own functions is parsed with the step's schemas first, so a stored or model-written
 * value reaches them only as the type they were written for. A typed repair retains its identity
 * for its checks and composition; it can discard every unit even when a model must submit one.
 */
export const erased = <O, S>(
  step: AgentStep<O, S>,
): AgentStep<unknown, unknown> => {
  const { spec } = step;
  let repaired: { readonly value: O } | undefined;
  const output = (value: unknown): O =>
    repaired !== undefined && Object.is(value, repaired.value)
      ? repaired.value
      : spec.submit.schema.parse(value);
  const withOutput = (value: unknown) =>
    value === undefined ? undefined : output(value);
  const lift = (judge: ((value: O) => ReadonlyArray<string>) | undefined) =>
    judge === undefined ? undefined : (value: unknown) => judge(output(value));
  const { repair, partial, note } = { ...spec, ...step };
  return {
    ...step,
    spec: {
      ...spec,
      check: lift(spec.check),
      advise: lift(spec.advise),
      checkRepaired: lift(spec.checkRepaired),
      repair:
        repair === undefined
          ? undefined
          : (value) => {
              const fixed = repair(output(value));
              repaired = { value: fixed };
              return fixed;
            },
    },
    compose: (result) =>
      step.compose({
        ...result,
        output:
          result.status === "backstop"
            ? spec.backstop()
            : withOutput(result.output),
        repairedFrom: withOutput(result.repairedFrom),
      }),
    partial:
      partial === undefined
        ? undefined
        : (summary) =>
            partial({
              ...summary,
              repairedFrom: withOutput(summary.repairedFrom),
            }),
    note:
      note === undefined
        ? undefined
        : (stored, context) => note(readData(step.schema, stored), context),
  };
};

export type EndedBy =
  | "submit"
  | "turn-limit"
  | "ceiling"
  | "continuations"
  | "overflow"
  | "timeout";

export interface AgentResult<O> {
  readonly agent: string;
  readonly stage: AgentStage;
  /** `interrupted`: the run's cut-off came first; `output` is then absent. */
  readonly status:
    "submitted" | "final-generation" | "backstop" | "interrupted";
  readonly output?: O | undefined;
  readonly endedBy: EndedBy;
  readonly turnsUsed: number;
  readonly turnLimit: number;
  readonly finalGeneration: boolean;
  readonly usage: CallUsage;
  /** Null when the route has no per-token price (the ChatGPT plan): unknown, never 0. */
  readonly costUsd: number | null;
  /** Turns the conversation already held when this process took the context up again. */
  readonly resumedTurns: number;
  /**
   * The context started again from its first turn. pi's storage keeps every committed turn, so a
   * context never restarts; the field stays for the receipt's earlier runs.
   */
  readonly restarted: boolean;
  readonly modelCalls: number;
  /** The agent's output before code repaired it, when it was repaired; never stored as a summary. */
  readonly repairedFrom?: O | undefined;
  /** Input tokens the provider counted on the first and the largest call of the context. */
  readonly context?:
    { readonly firstCall: number; readonly peak: number } | undefined;
  /**
   * What the step answered to each of the context's answers at the time, in order: its submit
   * tool's calls, then its final answers, as recorded with each answer when it was given. An
   * answer recorded without a label (by an older build) has no entry. Labels only; never stored
   * in the output or logged, so a stored summary has none, and a result no context produced (a
   * code fallback) has none.
   */
  readonly submissions?: ReadonlyArray<SubmissionOutcome> | undefined;
}

/**
 * An answer refused by the submit schema, refused by the step's checks, answered once with the
 * step's advice instead of accepted, or accepted.
 */
export type SubmissionOutcome = "schema" | "checks" | "advised" | "accepted";

/** How a judged final answer fared: accepted, else refused by the schema when it has no value. */
export const outcomeOf = (parsed: {
  readonly success: boolean;
  readonly data: unknown;
}): SubmissionOutcome =>
  parsed.success ? "accepted" : parsed.data === undefined ? "schema" : "checks";

/** The submit tool's answer as a label, from the error code of its outcome (tools.ts). */
export const submissionOfError = (
  error: string | undefined,
): SubmissionOutcome | undefined =>
  error === undefined
    ? "accepted"
    : error === "InvalidInput"
      ? "schema"
      : error === "CheckFailed"
        ? "checks"
        : error === "Advised"
          ? "advised"
          : undefined;

/** The harness's own messages to an agent, unchanged from the loop they came from (§3.4, 10.11). */
export const MARK = {
  reminder: "[harness: reminder]",
  continue: "[harness: open items]",
  final: "[harness: final generation]",
  invalid: "[harness: output refused]",
} as const;

export const submitNameOf = (
  spec: Pick<AgentSpec<unknown>, "submit" | "stage">,
) => spec.submit.name ?? `submit_${spec.stage}`;

export const reminderText = (
  spec: Pick<AgentSpec<unknown>, "submit" | "stage" | "turnLimit">,
  used: number,
) =>
  `${MARK.reminder} ${spec.turnLimit - used} turn(s) left of ${spec.turnLimit}. Finish with ${submitNameOf(spec)}.`;

export const continueText = (
  spec: Pick<AgentSpec<unknown>, "submit" | "stage" | "turnLimit">,
  used: number,
) =>
  `${MARK.continue} A text reply does not end the stage. Open item: call ${submitNameOf(spec)} with the stage's output. ${spec.turnLimit - used} turn(s) left.`;

export const finalText = (endedBy: EndedBy) =>
  `${MARK.final} ${endedBy === "ceiling" ? "This context reached its size ceiling" : endedBy === "overflow" ? "The context is full" : endedBy === "continuations" ? "The open items were not submitted" : "You reached this stage's turn limit"}. Produce the stage's best-effort output now from the tool results you already have, as JSON matching the output schema. Tools are not available for this answer.`;

export const refusedText = (message: string) =>
  `${MARK.invalid} The output did not pass: ${message}. Answer again with JSON only.`;

/**
 * What a context's submissions amount to (§3.4, §8.4): the newest that passes, except the first
 * passing one that drew advice, which was answered instead; and the ones that failed.
 */
export const scanSubmissions = <O>(
  calls: ReadonlyArray<unknown>,
  parse: (params: unknown) => {
    readonly success: boolean;
    readonly data: O | undefined;
  },
  advise: ((output: O) => ReadonlyArray<string>) | undefined,
) => {
  let accepted: O | undefined;
  let advised = false;
  const failed: Array<unknown> = [];
  for (const params of calls) {
    const parsed = parse(params);
    if (!parsed.success || parsed.data === undefined) {
      failed.push(params);
      continue;
    }
    if (!advised && (advise?.(parsed.data) ?? []).length > 0) {
      advised = true;
      continue;
    }
    accepted = parsed.data;
  }
  return { accepted, advised, failed };
};

/** The input a response's provider counted: fresh, cached and written to the cache. */
export const inputOf = (usage: Usage) =>
  usage.input + usage.cacheRead + usage.cacheWrite;

export { isRefusal } from "../providers/failure.ts";

/** A response that answered or refused, rather than failed in transport. */
const isTurn = (message: AssistantMessage) =>
  message.stopReason === "stop" ||
  message.stopReason === "length" ||
  message.stopReason === "toolUse" ||
  isRefusal(message);

export interface TranscriptFacts {
  /** The context's turns: its model calls that answered. */
  readonly turns: number;
  /** Input of the newest turn, which the context ceiling is checked against. */
  readonly lastInput: number;
  readonly firstInput: number | undefined;
  readonly peakInput: number;
  readonly usage: CallUsage;
  /** Every tool call of every turn, in the order the model wrote them. */
  readonly calls: ReadonlyArray<ToolCall>;
  /** The newest assistant entry's message, whatever its stop reason. */
  readonly last: AssistantMessage | undefined;
}

export const assistantOf = (entry: EntryRecord) => {
  if (!AssistantEntry.is(entry)) return undefined;
  const message = entry.model?.[0];
  return message?.role === "assistant" ? message : undefined;
};

/** What a conversation's entries, oldest first, say about its agent context. */
export const transcriptFacts = (
  entries: ReadonlyArray<EntryRecord>,
): TranscriptFacts => {
  let turns = 0;
  let lastInput = 0;
  let firstInput: number | undefined;
  let peakInput = 0;
  let usage = zeroUsage;
  let last: AssistantMessage | undefined;
  const calls: Array<ToolCall> = [];
  for (const entry of entries) {
    const message = assistantOf(entry);
    if (message === undefined) continue;
    last = message;
    if (!isTurn(message)) continue;
    turns += 1;
    lastInput = inputOf(message.usage);
    firstInput ??= lastInput;
    peakInput = Math.max(peakInput, lastInput);
    usage = addUsage(usage, callUsageOf(message.usage));
    for (const part of message.content)
      if (part.type === "toolCall") calls.push(part);
  }
  return { turns, lastInput, firstInput, peakInput, usage, calls, last };
};

/** The text of an assistant answer: its text parts joined, as the final generation is read. */
export const answerText = (message: AssistantMessage | undefined) =>
  (message?.content ?? [])
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
