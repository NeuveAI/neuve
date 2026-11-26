import { preserveUnknown } from "@neuve/records-schema";
import { readData } from "@neuve/records-core";
import { scopedLogSpan, startLogSpan } from "../../log-span.ts";
import { copyJson, type Context } from "@earendil-works/chord";
import {
  Type,
  type AssistantMessage,
  type TSchema,
  type Tool,
} from "@earendil-works/pi-ai";
import {
  GenerationTask,
  LiveDoc,
  ToolResultEntry,
  defineExtension,
  hook,
  section,
  type ConversationId,
  type DocumentReader,
  type EntryRecord,
  type Extension,
  type JsonObject,
  type RegistrySnapshot,
  type Task,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
  type Tx,
} from "@earendil-works/pi-durable";
import { Effect } from "effect";
import type { z } from "zod";
import { canonicalJson, sha256Hex } from "@neuve/records-core";
import {
  BUDGET_LINE_BYTES,
  MAX_INVALID_SUBMISSIONS,
  REMINDER_SHARE,
  TOOL_RESULT_TOKENS,
  clipBytes,
  estimateTokens,
  type AgentStage,
} from "../../budget.ts";
import { dropAddedNulls } from "../providers/wire.ts";
import { stepName } from "../../reader-text.ts";
import { costOf, type RouteConfig, type RouteEffort } from "../../route.ts";
import { boundEffort } from "../bindings.ts";
import type { RunLog } from "../../run-log.ts";
import { TOOL_CALL_SPAN } from "../../telemetry.ts";
import {
  capResult,
  nearCap,
  toolInputRefusal,
  wireSchema,
  type ChildRequest,
  type ResultCap,
  type ToolOutcome,
  type ToolSpec,
} from "../../toolkit.ts";
import {
  callUsageOf,
  isRefusal,
  reminderText,
  scanSubmissions,
  submissionOfError,
  submitNameOf,
  transcriptFacts,
  type AgentSpec,
  type AgentStep,
} from "./agent.ts";
import { childId } from "./children.ts";
import { registerClaim } from "../claim-settlement.ts";
import {
  AgentContextDoc,
  ChildrenDoc,
  ToolState,
  type AgentKind,
  type AppliedCall,
  type ToolDeclaration,
} from "./docs.ts";
import type { StageRunner, StageServices } from "./services.ts";

/**
 * Neuve's agent tools as pi tool registrations (0014), one extension per agent kind. An agent's
 * conversation selects its kind's extension and names the tools it offers, in order; the extension
 * is the same for every agent of the kind, so a reopened run installs it before it resumes and
 * finds every conversation's tools whatever runs first.
 *
 * - **Declarations.** What the provider sees of a tool (name, description, the JSON Schema zod
 *   produces) depends only on the run, so the kind's first agent stores it (`RunToolsDoc`) and
 *   every later one is checked against it (agent-step.ts).
 * - **Resolution.** A call finds its agent through its conversation's `AgentContextDoc`: the agent
 *   step task that owns it, whose durable input prepares the step. The process only caches that.
 * - **Strict tools.** A strict schema makes the model write null for a property that was optional.
 *   pi validates before the tool runs, so `prepareArguments`, which runs first, removes those nulls
 *   with the declared schema (`dropAddedNulls`). A property that accepted null keeps it; the
 *   arguments in the transcript stay as the model wrote them.
 * - **State.** A context's tools share state (handles, ledger, head reads) that lives in its
 *   `AgentContextDoc`. A call reads it, runs outside pi's commit line, and stores the state it left
 *   with its answer in one commit, keyed by pi's call ID: a call rerun after a crash answers what it
 *   answered and changes nothing again. Every round runs one call at a time
 *   (`executionMode: "sequential"`), so the state never races and ledger IDs follow the order the
 *   model wrote the calls in; separate contexts still run in parallel.
 * - **Children.** An answer may ask for a child task of another task (`ChildRequest`, such as the
 *   Verify of a recorded finding, owned by its finder): it starts in the commit that stores the
 *   answer, named in its owner's `ChildrenDoc`, so it starts once (`startChild`).
 * - **Answer.** The text with the budget line (turn, cap, allowance use) under the 3,000-token cap,
 *   as before. A call that ends the context's tool use (its submission accepted, its chances used
 *   up, the turn limit or the context ceiling reached) asks pi to end the run (`terminate`); the
 *   agent step task then decides what follows.
 */

/** What pi and the provider see of a tool: its name, description and input schema. */
type ToolShape = Pick<
  ToolSpec<unknown>,
  "name" | "description" | "input" | "strict"
>;

/** A tool without input advertises an object with no properties. */
const NO_INPUT: JsonObject = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A JSON Schema as pi stores it: a copy that must be a JSON object. */
const schemaObject = (schema: unknown): JsonObject => {
  const copy = copyJson(schema);
  if (!isJsonObject(copy))
    throw new TypeError("A tool's input schema must be a JSON object");
  return copy;
};

/** The zod-derived JSON Schema an agent is offered for a tool's input. */
const parametersOf = (spec: ToolShape): JsonObject =>
  spec.input === undefined
    ? NO_INPUT
    : schemaObject(
        wireSchema(spec.input, spec.strict ? "output" : "input").schema,
      );

/**
 * A tool as its agent kind declares it. A proxied integration read reaches outside the run, so a
 * call a crash interrupted is never run again; every other call either reads at a fixed revision or
 * finds its recorded answer, so it may.
 */
export const declarationOf = (
  spec: ToolShape,
  external: boolean,
): ToolDeclaration => ({
  name: spec.name,
  description: spec.description,
  parameters: parametersOf(spec),
  strict: spec.strict === true,
  replay: external ? "unsafe" : "safe",
});

/** The provider-facing declaration of a tool: what the agent is offered. */
const wireToolOf = (declaration: ToolDeclaration): Tool<TSchema> => ({
  name: declaration.name,
  description: declaration.description,
  parameters: Type.Unsafe<JsonObject>(declaration.parameters),
  ...(declaration.strict
    ? {
        // `prefer`: a schema the provider's strict subset cannot hold is sent non-strict; zod
        // still refuses invalid input.
        constrainedSampling: { type: "json_schema", strict: "prefer" } as const,
      }
    : {}),
});

export const wireTool = (spec: ToolShape): Tool<TSchema> =>
  wireToolOf(declarationOf(spec, false));

/**
 * Removes the nulls a strict schema made the model write, before pi validates. Pure, and it never
 * changes `args`: pi may run it again for the same call, and the transcript keeps what the model
 * wrote. Arguments that are not an object are left to pi's validation to refuse.
 */
export const strictArguments = (
  declaration: Pick<ToolDeclaration, "strict" | "parameters">,
): ((args: unknown) => unknown) | undefined =>
  declaration.strict
    ? (args) => dropAddedNulls(declaration.parameters, args)
    : undefined;

/**
 * The registration's `prepareArguments`, which pi runs before its own validation: the strict
 * nulls removed, then the tool's zod schema judges the model's arguments as they are. A call zod
 * refuses is refused here, so pi answers it as invalid and the tool never runs; one zod accepts
 * goes on unchanged, for the tool to parse once (`execute`). Pure: pi may run it again.
 */
const preparedArguments =
  (
    declaration: ToolDeclaration,
    schema: () => z.ZodType | undefined,
  ): ((args: unknown) => JsonObject) =>
  (args) => {
    const prepared = strictArguments(declaration)?.(args) ?? args;
    const input = schema();
    if (input !== undefined) {
      const parsed = input.safeParse(prepared);
      if (!parsed.success)
        throw new Error(
          toolInputRefusal(declaration.name, input, parsed.error, args),
        );
    }
    if (!isJsonObject(prepared))
      throw new TypeError("The tool's arguments must be a JSON object");
    return prepared;
  };

/**
 * A tool call's arguments as the tool receives them, from what the model wrote: strict nulls
 * removed, then zod, the tool's own schema. Never pi's validation, which coerces a null where a
 * number or a string is required into 0 or "": the tool, the submit tool and the agent step task
 * all judge a call from the model's own arguments, so each judges it as the others did.
 */
export const parseToolInput = (
  declaration: ToolDeclaration,
  schema: z.ZodType | undefined,
  raw: unknown,
):
  | { readonly success: true; readonly data: unknown }
  | { readonly success: false; readonly message: string } => {
  if (schema === undefined) return { success: true, data: undefined };
  const parsed = schema.safeParse(strictArguments(declaration)?.(raw) ?? raw);
  return parsed.success
    ? { success: true, data: parsed.data }
    : {
        success: false,
        message: toolInputRefusal(declaration.name, schema, parsed.error, raw),
      };
};

/** Zod's parse of a submission, then code's checks: a valid output has no problems. */
export const parseOutput =
  <O>(spec: AgentSpec<O>) =>
  (value: unknown) => {
    const parsed = spec.submit.schema.safeParse(value);
    if (!parsed.success)
      return {
        success: false as const,
        data: undefined,
        message: toolInputRefusal(
          submitNameOf(spec),
          spec.submit.schema,
          parsed.error,
          value,
        ),
      };
    const problems = spec.check?.(parsed.data) ?? [];
    return problems.length === 0
      ? { success: true as const, data: parsed.data, message: "" }
      : {
          success: false as const,
          data: parsed.data,
          message: problems.map((problem) => `- ${problem}`).join("\n"),
        };
  };

/** The submit tool of a context: strict, answered by code's checks and advice (`submitted`). */
export const submitShape = <O>(spec: AgentSpec<O>): ToolShape => ({
  name: submitNameOf(spec),
  description: spec.submit.description,
  input: spec.submit.schema,
  strict: true,
});

/** A submission's value from its call as the model wrote it, judged as the submit tool judged it. */
export const submissionOf =
  <O>(spec: AgentSpec<O>) =>
  (raw: unknown) => {
    const shape = submitShape(spec);
    const input = parseToolInput(declarationOf(shape, false), shape.input, raw);
    return input.success
      ? parseOutput(spec)(input.data)
      : { success: false as const, data: undefined, message: input.message };
  };

/** Every entry of a conversation, oldest first. */
export const conversationEntries = async (
  tx: Tx,
  conversationId: ConversationId,
): Promise<ReadonlyArray<EntryRecord>> => {
  const entries: Array<EntryRecord> = [];
  let cursor: Parameters<Tx["scanEntries"]>[2];
  do {
    const page = await tx.scanEntries({ conversationId }, 256, cursor);
    entries.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  return entries.reverse();
};

/** One prepared agent context, as a call resolves it from its conversation. */
export interface ResolvedAgent {
  readonly deadline?: number | undefined;
  readonly step: AgentStep<unknown, unknown>;
  /** The stage's vent tool (2.15, 8.8), offered after the context's own tools. */
  readonly vent: ToolSpec<unknown>;
  /**
   * Keeps what a call of a tool reaching outside the run changed of the run's own state (the scope
   * additions of Understand's proxied reads, 10.53), in the commit that records the call.
   */
  readonly recordExternal?: ((tx: Tx) => Promise<void>) | undefined;
}

/** The tools an agent context offers, in order: its own, the vent tool, then its submit tool. */
export const offeredTools = (
  agent: ResolvedAgent,
): ReadonlyArray<ToolDeclaration> => [
  ...[...agent.step.spec.tools, agent.vent].map((spec) =>
    declarationOf(spec, agent.step.external?.has(spec.name) === true),
  ),
  declarationOf(submitShape(agent.step.spec), false),
];

/** What the kinds' extensions need of the run. */
export interface KindTools {
  /** Resolves once the step task holds its claim in this process (`step-claim.ts`). */
  readonly admitted?: (
    stepTask: number,
    signal: AbortSignal | undefined,
  ) => Promise<void>;
  readonly route: RouteConfig;
  readonly ceiling: number;
  readonly log: RunLog;
  readonly run: StageRunner;
  /**
   * The agent of a conversation: from its `AgentContextDoc`, the agent step task that owns it,
   * prepared from that task's durable input. Fails when the conversation has none.
   */
  readonly resolve: (
    read: DocumentReader,
    conversationId: ConversationId,
    context: Context,
  ) => Promise<ResolvedAgent>;
  /** The runtime's `endRound` (services.ts). */
  readonly endRound: StageServices["endRound"];
  /**
   * A kind's tool's zod input schema, as this process knows it from an agent of the kind it
   * prepared; a reopened run prepares one before it resumes (index.ts).
   */
  readonly inputOf: (kind: AgentKind, tool: string) => z.ZodType | undefined;
}

/** The stage an agent kind belongs to. */
export const stageOfKind = (kind: AgentKind): AgentStage =>
  kind === "scope-change"
    ? "frame"
    : // The readings run as Verify does (NEU-148); the receipt's stages stay the four.
      kind === "assess" ||
        kind === "lane-review" ||
        kind === "verify-claim" ||
        kind === "brief"
      ? "verify"
      : kind;

export const kindExtensionName = (kind: AgentKind) => `neuve.stage.${kind}`;

type Read =
  | { readonly applied: AppliedCall }
  | {
      readonly facts: ReturnType<typeof transcriptFacts>;
      readonly state: ToolState | undefined;
    };

/** The state a context's tools hold, as JSON to compare and store. */
const stateJson = (step: AgentStep<unknown, unknown>) => {
  const saved = step.spec.state?.save();
  return saved === undefined ? null : copyJson(saved);
};

/** One declared tool behind pi's durable tool task, run by the conversation's own agent. */
const registration = (
  tools: KindTools,
  kind: AgentKind,
  declaration: ToolDeclaration,
): ToolRegistration => {
  return {
    ...wireToolOf(declaration),
    replay: declaration.replay,
    executionMode: "sequential",
    prepareArguments: preparedArguments(declaration, () =>
      tools.inputOf(kind, declaration.name),
    ),
    execute: async (
      args: unknown,
      api: ToolExecutionApi,
      context: Context,
    ): Promise<ToolExecutionResult> => {
      using toolSpan = scopedLogSpan(tools.log, "harness.tool-call.dispatch", {
        "harness.stage": stageOfKind(kind),
        "harness.tool": declaration.name,
        "harness.conversation_id": api.conversationId,
        "harness.call_id": api.callId,
      });
      const read: Read = await api.commit(async (tx) => {
        const doc = await tx.doc(AgentContextDoc, api.conversationId);
        const applied = doc.applied[api.callId];
        if (applied !== undefined)
          return {
            applied: { text: applied.text, terminate: applied.terminate },
          };
        const stored = copyJson(doc.state);
        return {
          facts: transcriptFacts(
            await conversationEntries(tx, api.conversationId),
          ),
          state: stored === null ? undefined : readData(ToolState, stored),
        };
      }, context);
      if ("applied" in read) return answer(read.applied);

      const resolved = await tools.resolve(api, api.conversationId, context);
      const { step } = resolved;
      const agent = step.spec;
      const submitName = submitNameOf(agent);
      const isSubmit = declaration.name === submitName;
      const spec = isSubmit
        ? undefined
        : [...agent.tools, resolved.vent].find(
            (tool) => tool.name === declaration.name,
          );
      if (!isSubmit && spec === undefined) {
        // An integration's tool this attempt did not connect: offered as the run first read it
        // (RunToolsDoc), answered as unavailable rather than run with another schema.
        if (declaration.replay === "unsafe")
          return answer({
            text: `${declaration.name} is not connected in this attempt of the run; nothing was read.`,
            terminate: false,
          });
        throw new Error(
          `${agent.agent} does not offer ${declaration.name}; its conversation names a tool of another agent`,
        );
      }

      const { facts } = read;
      const turn = facts.turns;
      const at = facts.calls.findIndex((call) => call.id === api.callId);
      const earlier = (at === -1 ? facts.calls : facts.calls.slice(0, at))
        .filter((call) => call.name === submitName)
        .map((call) => call.arguments);
      agent.state?.load(read.state, turn);
      const before = canonicalJson(stateJson(step));

      const started = Date.now();
      // The arguments as the model wrote them, from the transcript, never the copy pi validated,
      // which coerces a null where a value is required.
      const raw = at === -1 ? args : facts.calls[at]?.arguments;
      const input = spec?.input ?? (isSubmit ? agent.submit.schema : undefined);
      const call = {
        stage: agent.stage,
        agent: agent.agent,
        turn,
        tool: declaration.name,
        callId: api.callId,
      };
      tools.log.write({ type: "tool.started", ...call });
      const parsed = parseToolInput(declaration, input, raw);
      const outcome: ToolOutcome = !parsed.success
        ? {
            text: parsed.message,
            error: "InvalidInput",
          }
        : spec === undefined
          ? submitted(agent, parsed.data, earlier)
          : await tools.run(
              spec.handle(parsed.data).pipe(
                Effect.tap((done) =>
                  done.error === undefined
                    ? Effect.void
                    : Effect.annotateCurrentSpan("error.type", done.error),
                ),
                // One span per call (10.97), with the GenAI tool attributes; never its input or
                // result.
                Effect.withSpan(TOOL_CALL_SPAN, {
                  attributes: {
                    "gen_ai.operation.name": "execute_tool",
                    "gen_ai.tool.name": declaration.name,
                    "harness.stage": agent.stage,
                    "harness.agent": agent.agent,
                    "harness.turn": turn,
                  },
                }),
              ),
              context.abortSignal,
            );
      tools.log.write({
        type: "tool.call",
        ...call,
        argsHash: sha256Hex(canonicalJson(copyJson(raw ?? null))).slice(0, 16),
        // UN9's estimate of the result before the budget line; the answer, line included, is held
        // to the 3,000-token cap, or to the larger cap its tool declares (`ResultCap`).
        resultBytes: Buffer.byteLength(outcome.text),
        resultTokensEstimate: estimateTokens(Buffer.byteLength(outcome.text)),
        latencyMs: Date.now() - started,
        paged: outcome.paged === true,
        empty: outcome.empty === true,
        // The child the answer asks for, named before the commit that may start it.
        ...(outcome.child === undefined ? {} : { child: outcome.child.name }),
        ...(nearCap(outcome.text, true, spec?.resultCap)
          ? { error: outcome.error ?? "NearOrOverCap" }
          : outcome.error === undefined
            ? {}
            : { error: outcome.error }),
      });

      // Whether this round ends the context's tool use, judged over every call of the round, so
      // every call of the round answers the same and pi ends the round (tools.ts, `roundEnds`).
      const terminate = roundEnds(
        agent,
        facts,
        tools.ceiling,
        resolved.deadline,
      );
      const line = budgetLine(agent, turn, spec?.resultCap);
      const submission = isSubmit
        ? submissionOfError(outcome.error)
        : undefined;
      const applied: AppliedCall = {
        text: capResult(outcome.text, line, spec?.resultCap),
        terminate,
        ...(submission === undefined ? {} : { submission }),
      };
      const after = stateJson(step);
      const changed = canonicalJson(after) !== before;
      const { child } = outcome;
      // A call that changed the context's state, or records something, keeps its answer with the
      // state it left, and starts the child its answer asks for in the same commit; a read at a
      // fixed revision that changed nothing answers the same if rerun.
      if (
        changed ||
        isSubmit ||
        spec?.hints.readOnly !== true ||
        child !== undefined
      ) {
        const started = await api.commit(async (tx) => {
          const doc = await tx.doc(AgentContextDoc, api.conversationId);
          if (doc.applied[api.callId] !== undefined) return undefined;
          doc.applied[api.callId] = applied;
          if (changed)
            doc.state =
              doc.state === null
                ? after
                : copyJson(
                    preserveUnknown(ToolState, copyJson(doc.state), after),
                  );
          const id =
            child === undefined
              ? undefined
              : await startChild(tx, api.registry, child);
          if (spec !== undefined && declaration.replay === "unsafe")
            await resolved.recordExternal?.(tx);
          return id;
        }, context);
        if (started !== undefined && child !== undefined) {
          startLogSpan(tools.log, CHILD_STARTED_SPAN, {
            ...child.attributes,
            "harness.child": child.name,
            "harness.task_id": started,
            "harness.owner_task_id": child.owner,
            "harness.asked_by": declaration.name,
            "harness.call_id": api.callId,
          })();
          // What the child reads, as every task's children record it (task.inputs).
          tools.log.write({
            type: "task.inputs",
            taskId: started,
            owner: child.owner,
            kind: child.kind,
            inputs: child.inputs,
            child: child.name,
            askedBy: declaration.name,
            callId: api.callId,
          });
        }
      }

      // The reminder at 85% of the turn limit (§3.4) joins the run after this round's results, as
      // the next request's first message; once per context.
      if (!terminate && turn >= Math.floor(agent.turnLimit * REMINDER_SHARE)) {
        const own = await api.conversation(api.conversationId, context);
        await own?.submit(
          {
            type: "input",
            content: reminderText(agent, turn),
            whenBusy: "steer",
            requestId: "reminder",
          },
          context,
        );
      }
      return answer(applied);
    },
  };
};

/**
 * Whether a tool round ends the context's tool use (§3.4): a submission accepted, more than two
 * that failed, the turn limit or the context ceiling reached. `facts` run through the round's
 * assistant entry; submissions are judged from the model's own arguments, so the answer is the
 * same whichever call of the round asks, and before or after the calls ran.
 */
export const roundEnds = (
  agent: AgentSpec<unknown>,
  facts: {
    readonly turns: number;
    readonly lastInput: number;
    readonly calls: ReadonlyArray<{
      readonly name: string;
      readonly arguments: unknown;
    }>;
  },
  ceiling: number,
  deadline?: number,
) => {
  const scan = scanSubmissions(
    facts.calls
      .filter((call) => call.name === submitNameOf(agent))
      .map((call) => call.arguments),
    submissionOf(agent),
    agent.advise,
  );
  return (
    (deadline !== undefined && Date.now() >= deadline) ||
    scan.accepted !== undefined ||
    scan.failed.length > (agent.retries ?? MAX_INVALID_SUBMISSIONS) ||
    facts.turns >= agent.turnLimit ||
    facts.lastInput >= ceiling
  );
};

/** The budget line; a result whose tool declares a larger cap says that one is its own. */
export const budgetLine = (
  agent: AgentSpec<unknown>,
  turn: number,
  cap?: ResultCap,
) => {
  const note = agent.budgetNote?.();
  const own =
    cap === undefined || cap.tokens === TOOL_RESULT_TOKENS
      ? ""
      : ` (this one at about ${cap.tokens.toLocaleString("en")})`;
  return `[turn ${turn} / ${agent.turnLimit}; results are capped at about ${TOOL_RESULT_TOKENS.toLocaleString("en")} tokens${own}${note === undefined ? "" : `; ${clipBytes(note, BUDGET_LINE_BYTES - 120)}`}]`;
};

/** A child task started for its owner, by a tool call's answer or by the owner itself. */
export const CHILD_STARTED_SPAN = "harness.child.started";

/**
 * Starts the child a call's answer asks for, in the commit that records the answer: created and
 * named in its owner's `ChildrenDoc` together, so that name is the child's one run (0016) and a
 * call rerun after a crash, which finds its answer, starts nothing. An owner that takes no new work
 * (terminal, completing or abort-marked) gets no child: what it composes decides without one.
 * Returns the task started, or undefined when the name was held or the owner took none.
 */
export const startChild = async (
  tx: Tx,
  registry: RegistrySnapshot,
  request: ChildRequest,
): Promise<number | undefined> => {
  // Reads first: a commit reads no task after it writes one.
  const owner = await tx.task(childId(request.owner));
  if (
    owner === undefined ||
    owner.abortRequested ||
    owner.state.status === "terminal" ||
    owner.state.status === "completing"
  ) {
    if (request.claimRegistration !== undefined)
      throw new Error(
        "A claim cannot be recorded after its producer stopped taking work",
      );
    return undefined;
  }
  if (request.claimRegistration !== undefined && owner.owner === undefined)
    throw new Error("A claim producer must belong to its review task");
  const children = await tx.doc(ChildrenDoc, owner.id);
  const held = children.children[request.name];
  if (held !== undefined) {
    if (request.claimRegistration !== undefined)
      await registerClaim(
        tx,
        owner.owner!,
        owner.id,
        request.claimRegistration,
        held,
      );
    return undefined;
  }
  const task = registry.task(request.task);
  if (task === undefined)
    throw new Error(
      `${request.task} is not registered, so ${request.name} cannot start`,
    );
  // The registry holds definitions erased; the request carries the input its kind takes.
  const id = await tx.createTask(
    task as unknown as Task<unknown, { phase: string }, unknown, object>,
    request.input,
    { ownership: { kind: "task", taskId: owner.id } },
  );
  children.children[request.name] = id;
  if (request.claimRegistration !== undefined)
    await registerClaim(
      tx,
      owner.owner!,
      owner.id,
      request.claimRegistration,
      id,
    );
  return id;
};

const answer = (applied: AppliedCall): ToolExecutionResult => ({
  content: [{ type: "text", text: applied.text }],
  ...(applied.terminate ? { control: { terminate: true } } : {}),
});

/**
 * The submit tool's answer (§3.4, §8.4): code's checks, then its advice once per context, then
 * acceptance. The context's earlier submissions say whether the advice was already given.
 */
export const submitted = <O>(
  agent: AgentSpec<O>,
  output: O,
  earlier: ReadonlyArray<unknown>,
): ToolOutcome => {
  const name = submitNameOf(agent);
  const problems = agent.check?.(output) ?? [];
  if (problems.length > 0)
    return {
      text: `Not submitted. Fix these and call ${name} again:\n${problems.map((problem) => `- ${problem}`).join("\n")}`,
      error: "CheckFailed",
    };
  const { advised } = scanSubmissions(
    earlier,
    submissionOf(agent),
    agent.advise,
  );
  const advice = advised ? [] : (agent.advise?.(output) ?? []);
  if (advice.length > 0)
    return {
      text: `Not submitted yet. Consider these, then call ${name} again (as it is, if you keep it):\n${advice.map((line) => `- ${line}`).join("\n")}`,
      error: "Advised",
    };
  return { text: "Submitted. The stage is complete." };
};

/**
 * One agent kind's extension: the system prompt of each conversation as its one untagged section,
 * exactly as the stage wrote it; one registration per declared tool; and the hook that records each
 * model call in the run log for the receipt (10.32).
 */
export const kindExtension = (
  kind: AgentKind,
  declarations: ReadonlyArray<ToolDeclaration>,
  tools: KindTools,
): Extension => {
  const stage = stageOfKind(kind);
  return defineExtension({
    name: kindExtensionName(kind),
    sections: [
      section(
        "stage",
        async ({ conversationId, read }, context) => {
          const doc = await read.snapshot(
            AgentContextDoc,
            conversationId,
            context,
          );
          if (doc === undefined || doc.step === null)
            throw new Error(
              `Conversation ${conversationId} has no agent of kind ${kind}`,
            );
          return doc.system;
        },
        { tag: false },
      ),
    ],
    tools: declarations.map((declaration) =>
      registration(tools, kind, declaration),
    ),
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async ({ messages }, api, context) => {
          const doc = await api.snapshot(
            AgentContextDoc,
            api.conversationId,
            context,
          );
          if (doc === undefined) return;
          const unavailable = new Set<string>();
          if (doc.step !== null) {
            await tools.admitted?.(doc.step.taskId, context.abortSignal);
            if (kind === "find") {
              const { step } = await tools.resolve(
                api,
                api.conversationId,
                context,
              );
              for (const tool of step.spec.tools)
                if (tool.available === false) unavailable.add(tool.name);
            }
          }
          // Only joined results of calls rejected by the original schema have an applied answer
          // here. The immutable native result retains pi's structured validation diagnostic.
          const rejected = new Set<string>();
          for (const message of messages) {
            if (message.role !== "assistant") continue;
            for (const call of message.content) {
              if (call.type !== "toolCall") continue;
              const declaration = declarations.find(
                (tool) => tool.name === call.name,
              );
              const schema = tools.inputOf(kind, call.name);
              if (declaration === undefined || schema === undefined) continue;
              const raw =
                strictArguments(declaration)?.(call.arguments) ??
                call.arguments;
              if (!schema.safeParse(raw).success) rejected.add(call.id);
            }
          }
          return {
            messages: messages.map((message) => {
              if (
                unavailable.size > 0 &&
                message.role === "system" &&
                message.toolsAdded !== undefined
              )
                return {
                  ...message,
                  toolsAdded: message.toolsAdded.filter(
                    (tool) => !unavailable.has(tool.name),
                  ),
                };
              if (
                message.role !== "toolResult" ||
                !message.isError ||
                !rejected.has(message.toolCallId)
              )
                return message;
              const applied = doc.applied[message.toolCallId];
              return applied === undefined
                ? message
                : {
                    ...message,
                    content: [{ type: "text" as const, text: applied.text }],
                  };
            }),
          };
        },
        /**
         * pi ends a round only when every call of it asks to; a call refused before it ran (its
         * arguments invalid) settles without asking. When the round ends the context's tool use
         * anyway, the runtime's `endRound` records it and aborts this generation before its next
         * request.
         */
        afterTools: async (assistant, results, api, context) => {
          const { step, deadline } = await tools.resolve(
            api,
            api.conversationId,
            context,
          );
          await tools.endRound(
            {
              generation: api.taskId,
              decide: async (tx) => {
                // pi ends the round itself when every call of it already asked to; a call refused
                // before it ran (invalid arguments) settles without that control.
                const slots =
                  (await tx.doc(LiveDoc, api.conversationId)).tools ?? [];
                const terminated = await Promise.all(
                  slots.map(async (slot) => {
                    if (slot.taskId === undefined) return false;
                    const task = await tx.task(slot.taskId);
                    if (task?.state.status !== "terminal") return false;
                    const outcome = task.state.outcome;
                    return (
                      outcome.status === "completed" &&
                      isJsonObject(outcome.result) &&
                      isJsonObject(outcome.result["control"]) &&
                      outcome.result["control"]["terminate"] === true
                    );
                  }),
                );
                if (slots.length > 0 && terminated.every(Boolean)) return false;
                const facts = transcriptFacts(
                  (await conversationEntries(tx, api.conversationId)).filter(
                    (entry) => entry.id <= assistant,
                  ),
                );
                const doc = await tx.doc(AgentContextDoc, api.conversationId);
                step.spec.state?.load(
                  doc.state === null
                    ? undefined
                    : readData(ToolState, copyJson(doc.state)),
                  facts.turns,
                );
                for (const id of results) {
                  const entry = await tx.entry(ToolResultEntry, id);
                  if (
                    !entry?.data?.diagnostics.some(
                      (diagnostic) => diagnostic.code === "invalid_arguments",
                    )
                  )
                    continue;
                  const result = entry.model?.[0];
                  if (
                    result?.role !== "toolResult" ||
                    doc.applied[result.toolCallId] !== undefined
                  )
                    continue;
                  const call = facts.calls.find(
                    (call) =>
                      call.id === result.toolCallId &&
                      call.name === result.toolName,
                  );
                  const declaration = declarations.find(
                    (tool) => tool.name === result.toolName,
                  );
                  const schema = tools.inputOf(kind, result.toolName);
                  if (
                    call === undefined ||
                    declaration === undefined ||
                    schema === undefined
                  )
                    continue;
                  const parsed = parseToolInput(
                    declaration,
                    schema,
                    call.arguments,
                  );
                  if (parsed.success) continue;
                  doc.applied[call.id] = {
                    text: capResult(
                      parsed.message,
                      budgetLine(step.spec, facts.turns),
                    ),
                    terminate: roundEnds(
                      step.spec,
                      facts,
                      tools.ceiling,
                      deadline,
                    ),
                    ...(call.name === submitNameOf(step.spec)
                      ? { submission: "schema" as const }
                      : {}),
                  };
                }
                if (!roundEnds(step.spec, facts, tools.ceiling, deadline))
                  return false;
                (await tx.doc(AgentContextDoc, api.conversationId)).stopped = {
                  assistant,
                };
                return true;
              },
            },
            context,
          );
        },
        afterResponse: async (message, api, context) => {
          const doc = await api.snapshot(
            AgentContextDoc,
            api.conversationId,
            context,
          );
          const agent = doc?.step?.agent ?? `${kind}?`;
          const refused = isRefusal(message);
          // pi runs the hook again when it replays a response after a reopen; the run log is the
          // receipt's durable record, so a response it already holds is not counted twice.
          const call = `${api.conversationId}:${message.responseId ?? message.timestamp}`;
          const records = tools.log.read();
          if (
            refused &&
            !records.some(
              (record) =>
                record.type === "gap" &&
                record["kind"] === "refusal" &&
                record["call"] === call,
            )
          )
            tools.log.write({
              type: "gap",
              stage,
              agent,
              call,
              kind: "refusal",
              detail: `The model declined one turn of ${stepName(stage, agent)}, which went on without it.`,
              cause: `category ${message.rawStopReason}`,
            });
          if (
            records.some(
              (record) =>
                record.type === "model.call" &&
                (record["call"] === call ||
                  (message.responseId !== undefined &&
                    record["responseId"] === message.responseId) ||
                  record["messageTimestamp"] === message.timestamp),
            )
          )
            return;
          // The effort the call was made at: its binding's, which its provider was built with.
          const effort = await boundEffort(
            api,
            api.conversationId,
            tools.route,
            context,
          );
          modelCall(
            tools,
            // The briefing's calls are labelled by their kind on this row only (round 27), so the
            // receipt and the benchmark count them apart; the stage itself stays Verify's.
            kind === "brief" ? "brief" : stage,
            agent,
            call,
            message,
            doc?.final === true,
            effort,
          );
        },
      }),
    ],
  });
};

/** One model call as the run log keeps it for the receipt: usage and shape, never content. */
const modelCall = (
  tools: KindTools,
  /** The row's label: the kind's stage, or `brief` for the briefing's calls. */
  stage: AgentStage | "brief",
  agent: string,
  call: string,
  message: AssistantMessage,
  final: boolean,
  effort: RouteEffort,
) => {
  const usage = callUsageOf(message.usage);
  tools.log.write({
    type: "model.call",
    stage,
    agent,
    call,
    kind: final ? "final" : "turn",
    model: tools.route.model,
    effort,
    maxTokens: tools.route.maxOutputTokens,
    startedAt: new Date(message.timestamp).toISOString(),
    latencyMs: Math.max(0, Date.now() - message.timestamp),
    finishReason: message.stopReason,
    stopReason: message.rawStopReason,
    refused: isRefusal(message),
    usage,
    costUsd: costOf(tools.route, usage),
    responseId: message.responseId,
    toolCalls: message.content.flatMap((part) =>
      part.type === "toolCall" ? [part.name] : [],
    ),
    assistantBlocks: message.content.map((part) =>
      part.type === "toolCall"
        ? "tool-call"
        : part.type === "thinking"
          ? "reasoning"
          : "text",
    ),
  });
};

const sameDeclaration = (a: ToolDeclaration, b: ToolDeclaration) =>
  canonicalJson(copyJson(a)) === canonicalJson(copyJson(b));

/**
 * How an agent's declarations compare with its kind's frozen ones. The run offers the frozen ones:
 * a tool of the harness that differs is a fault, while an integration's tool that changed since the
 * run first read it (or is gone) keeps its first schema and is disclosed.
 */
export const compareDeclarations = (
  frozen: ReadonlyArray<ToolDeclaration>,
  own: ReadonlyArray<ToolDeclaration>,
):
  | { readonly status: "same" }
  | { readonly status: "external"; readonly changed: ReadonlyArray<string> }
  | { readonly status: "differs"; readonly detail: string } => {
  const ownOf = new Map(
    own.map((declaration) => [declaration.name, declaration]),
  );
  const changed: Array<string> = [];
  const internal = (list: ReadonlyArray<ToolDeclaration>) =>
    list
      .filter((declaration) => declaration.replay === "safe")
      .map((d) => d.name);
  if (internal(frozen).join("\0") !== internal(own).join("\0"))
    return {
      status: "differs",
      detail: `offers ${internal(own).join(", ")} where the kind offers ${internal(frozen).join(", ")}`,
    };
  for (const declaration of frozen) {
    const mine = ownOf.get(declaration.name);
    if (mine !== undefined && sameDeclaration(declaration, mine)) continue;
    if (declaration.replay === "safe")
      return {
        status: "differs",
        detail: `declares ${declaration.name} differently from the kind`,
      };
    changed.push(declaration.name);
  }
  for (const declaration of own)
    if (!frozen.some((held) => held.name === declaration.name))
      changed.push(declaration.name);
  return changed.length === 0
    ? { status: "same" }
    : { status: "external", changed };
};
