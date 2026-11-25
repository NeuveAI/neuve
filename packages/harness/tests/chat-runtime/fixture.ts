import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  fauxProvider,
  Type,
  type Models,
  type Message,
} from "@earendil-works/pi-ai";
import {
  Harness,
  MemoryStorage,
  createRegistry,
  defineExtension,
  defineTool,
  section,
  type Conversation,
  type ConversationId,
  type ToolExecutionResult,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import {
  Account,
  AccountDirectory,
  RuntimeRegistry,
  TurnFailed,
  inMemoryAccountDirectory,
  runtimeRegistryLayer,
  type RuntimeCapabilities,
  type RuntimeShape,
  type SessionPolicy,
  type SessionStart,
  RuntimeEvent,
  type ToolOutcome,
  type AccountStatus,
  type RuntimeRegistryShape,
  type RuntimeSession,
  type RuntimeModel,
} from "@neuve/runtime";
import {
  Cause,
  Context,
  Effect,
  Exit,
  Layer,
  Queue,
  Scope,
  Stream,
} from "effect";
import {
  ChatRuntimeBridge,
  NativeHeads,
  accountModels,
  chatRuntimeExtension,
  type AccountStatusSource,
} from "../../src/chat-runtime/index.ts";

export const testModels: RuntimeModel[] = [
  {
    id: "sonnet",
    resolvedModel: "claude-sonnet-test",
    displayName: "Sonnet default",
    description: "Default coding model",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "real",
    displayName: "Real",
    description: "Another coding model",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high"],
  },
];

export const context = BACKGROUND_CONTEXT;
export const account = (name = "subscription", folder = "shared") =>
  Account.parse({
    name,
    kind: "claude-subscription",
    runtime: "claude-code",
    credential: { kind: "claude-config-folder", folder: `/${folder}` },
  });
export const caps: RuntimeCapabilities = {
  ownsLoop: true,
  toolEndsTurn: true,
  resumeInTurn: true,
  perMessageUsage: true,
  resume: true,
  fork: true,
  steering: true,
  interrupt: true,
  modelSwitchInSession: true,
  structuredOutput: false,
  approvals: false,
  perRequestTelemetry: true,
  ownTools: false,
  byteExactCapture: false,
  nativeToolServer: true,
  statusProbe: true,
  internalRetries: true,
};
type FrameEvent<E = RuntimeEvent> = E extends RuntimeEvent
  ? Omit<E, "turnId" | "at">
  : never;
export type Frame = {
  beforeMessage?: () => void;
  text?: string;
  calls?: Extract<RuntimeEvent, { type: "message.finished" }>["toolCalls"];
  failure?: import("@neuve/runtime").RuntimeFailure;
  disposition?: "reusable" | "broken";
  retry?: import("@neuve/runtime").RetryEligibility;
  delayHandler?: () => Promise<void>;
  resumePoint?: string;
  finishAfterResults?: string;
  /** On a runtime without resumeInTurn, end the turn without the resume point the contract requires. */
  omitTurnPoint?: true;
  modelUsage?: Pick<
    Extract<RuntimeEvent, { type: "usage" }>,
    "model" | "contextWindow" | "maxOutputTokens"
  > &
    Partial<Pick<Extract<RuntimeEvent, { type: "usage" }>, "scope">>;
};
export class FakeRuntime {
  readonly frames: Frame[] = [];
  readonly opened: {
    account: string;
    policy: SessionPolicy;
    start: SessionStart;
    session: FakeSession;
  }[] = [];
  readonly requests: { session: string; input: unknown }[] = [];
  admitted = 0;
  unrecordedRequests = 0;
  readonly order: string[] = [];
  readonly results: { id: string; outcome: ToolOutcome }[] = [];
  readonly logs: {
    event: string;
    fields: Readonly<Record<string, unknown>>;
  }[] = [];
  capabilities = { ...caps };
  failOpen: (start: SessionStart) => boolean = () => false;
  failures: SessionStart[] = [];
  readonly shape: RuntimeShape = {
    kind: "claude-code",
    continuation: (account) => ({
      runtime: "claude-code",
      key:
        account.credential.kind === "claude-config-folder"
          ? (account.credential.folder ?? "default")
          : account.name,
    }),
    capabilities: () => Effect.succeed(this.capabilities),
    probe: () =>
      Effect.succeed({
        signIn: { state: "signed-in" },
        limits: [],
        checkedAt: "2026-11-10T12:00:00Z",
      }),
    signOut: () => Effect.void,
    openSession: (account, policy, start) =>
      Effect.gen({ self: this }, function* () {
        if (this.failOpen(start)) {
          this.failures.push(start);
          return yield* new TurnFailed({
            account: account.name,
            reason: "protocol-error",
          });
        }
        const queue = yield* Queue.unbounded<RuntimeEvent, Cause.Done>();
        const session = new FakeSession(
          this,
          policy,
          queue,
          `session-${this.opened.length + 1}`,
        );
        this.opened.push({ account: account.name, policy, start, session });
        yield* Effect.addFinalizer(() => Effect.promise(() => session.close()));
        return session;
      }),
  };
}
export class FakeSession {
  id: string;
  closed = 0;
  interrupted = 0;
  readonly approvalAnswers: Parameters<
    RuntimeSession["respondToApproval"]
  >[0][] = [];
  readonly models: NonNullable<SessionPolicy["model"]>[] = [];
  readonly jobs = new Set<Promise<void>>();
  readonly abort = new AbortController();
  private turnId = "none";
  readonly events: Stream.Stream<RuntimeEvent>;
  constructor(
    readonly fake: FakeRuntime,
    readonly policy: SessionPolicy,
    readonly queue: Queue.Queue<RuntimeEvent, Cause.Done>,
    id: string,
  ) {
    this.id = id;
    this.events = Stream.fromQueue(queue);
  }
  get nativeSessionId() {
    return this.id;
  }
  emit(event: FrameEvent) {
    Queue.offerUnsafe(
      this.queue,
      RuntimeEvent.parse({
        ...event,
        turnId: this.turnId,
        at: "2026-11-10T12:00:00Z",
      }),
    );
  }
  startTurn = (input: { turnId: string; message: unknown }) =>
    Effect.sync(() => {
      this.turnId = input.turnId;
      this.fake.order.push("start");
      this.request(input.message);
    });
  steerTurn = (input: { message: unknown }) =>
    Effect.sync(() => {
      this.fake.order.push("steer");
      this.fake.requests.push({
        session: this.id,
        input: { steer: input.message },
      });
    });
  interruptTurn = () =>
    Effect.sync(() => {
      this.interrupted++;
    });
  setModel = (model: NonNullable<SessionPolicy["model"]>) =>
    Effect.sync(() => {
      this.models.push(model);
    });
  respondToApproval: RuntimeSession["respondToApproval"] = (answer) =>
    Effect.sync(() => {
      this.approvalAnswers.push(answer);
      return { delivered: true };
    });
  private record(input: unknown) {
    if (this.fake.admitted === 0) this.fake.unrecordedRequests++;
    else this.fake.admitted--;
    this.fake.requests.push({ session: this.id, input });
  }
  private request(input: unknown) {
    this.record(input);
    const job = this.run().catch((error) => {
      if (!this.abort.signal.aborted) throw error;
    });
    this.jobs.add(job);
    void job.finally(() => this.jobs.delete(job));
  }
  private async run() {
    while (!this.abort.signal.aborted) {
      const frame = this.fake.frames.shift();
      if (!frame) throw new Error("Unexpected model request");
      frame.beforeMessage?.();
      if (frame.failure) {
        this.emit({
          type: "turn.finished",
          outcome: {
            status: "failed",
            failure: frame.failure,
            disposition: frame.disposition ?? "broken",
            ...(frame.retry ? { retry: frame.retry } : {}),
          },
          ...(frame.resumePoint ? { resumePoint: frame.resumePoint } : {}),
        });
        return;
      }
      if (frame.text) this.emit({ type: "text", text: frame.text });
      // A runtime without resumeInTurn names a point only at a completed turn's end.
      const point = frame.resumePoint ?? `point-${this.fake.requests.length}`;
      const inTurn = this.fake.capabilities.resumeInTurn;
      this.emit({
        type: "message.finished",
        messageId: `message-${this.fake.requests.length}`,
        ...(inTurn ? { resumePoint: point } : {}),
        stopReason: frame.calls?.length ? "tool-use" : "end-turn",
        toolCalls: frame.calls ?? [],
        // A runtime without perMessageUsage reports usage only for the turn.
        ...(this.fake.capabilities.perMessageUsage
          ? {
              usage: {
                input: 10,
                output: 4,
                cacheRead: 2,
                cacheWrite5m: 1,
                cacheWrite1h: 0,
              },
            }
          : {}),
      });
      if (!this.fake.capabilities.perMessageUsage)
        this.emit({
          type: "usage",
          scope: "turn",
          usage: {
            input: 10,
            output: 4,
            cacheRead: 2,
            cacheWrite5m: 1,
            cacheWrite1h: 0,
          },
          costUsd: null,
        });
      if (frame.modelUsage) {
        this.emit({
          type: "usage",
          scope: "turn",
          usage: {
            input: 10,
            output: 4,
            cacheRead: 2,
            cacheWrite5m: 1,
            cacheWrite1h: 0,
          },
          costUsd: null,
          ...frame.modelUsage,
        });
      }
      if (!frame.calls?.length) {
        this.emit({
          type: "turn.finished",
          outcome: { status: "completed" },
          ...(inTurn || frame.omitTurnPoint ? {} : { resumePoint: point }),
        });
        return;
      }
      await frame.delayHandler?.();
      for (const call of frame.calls) {
        const tool = this.policy.tools.find(
          (tool) => tool.name === call.toolName,
        );
        if (!tool) continue;
        this.fake.order.push(`handler:${call.callId}`);
        const outcome = await Effect.runPromise(
          tool.handle(call.input, {
            callId: call.callId,
            signal: this.abort.signal,
          }),
        );
        this.fake.results.push({ id: call.callId, outcome });
        this.fake.order.push(`result:${call.callId}`);
      }
      if (this.abort.signal.aborted) return;
      if (frame.finishAfterResults) {
        this.emit({
          type: "turn.finished",
          outcome: { status: "completed" },
          resumePoint: frame.finishAfterResults,
        });
        return;
      }
      this.record({ results: this.fake.results.map((result) => result.id) });
    }
  }
  async close() {
    if (this.closed) return;
    this.closed++;
    this.abort.abort();
    await Promise.all(this.jobs);
    Queue.endUnsafe(this.queue);
  }
}
export class Statuses implements AccountStatusSource {
  private readonly listeners = new Set<
    (values: readonly AccountStatus[]) => void
  >();
  constructor(public values: AccountStatus[]) {}
  current = () => this.values;
  subscribe = (listener: (values: readonly AccountStatus[]) => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  set(values: AccountStatus[]) {
    this.values = values;
    for (const listener of this.listeners) listener(values);
  }
}
export async function fixture(
  options: {
    accounts?: Account[];
    storage?: MemoryStorage;
    conversationId?: ConversationId;
    fake?: FakeRuntime;
    idleMs?: number;
    now?: () => number;
    recovery?: import("../../src/chat-runtime/recovery.ts").TurnRecoveryDriver;
    headsDirectory?: string;
    statusModels?: readonly RuntimeModel[];
    native?: ReturnType<typeof createModels>;
    toolName?: string;
    executionMode?: "parallel" | "sequential";
    approvals?: Parameters<typeof chatRuntimeExtension>[2];
    execute?: (
      n: number,
      conversation: () => Conversation,
      signal: AbortSignal | undefined,
      api: ToolExecutionApi,
    ) => Promise<ToolExecutionResult>;
    registry?: (
      value: RuntimeRegistryShape,
      fake: FakeRuntime,
    ) => RuntimeRegistryShape;
  } = {},
) {
  const accounts = options.accounts ?? [account()];
  const fake = options.fake ?? new FakeRuntime();
  const scope = Scope.makeUnsafe();
  const built = await Effect.runPromise(
    Layer.buildWithScope(
      runtimeRegistryLayer([fake.shape]).pipe(
        Layer.provide(
          Layer.succeed(AccountDirectory, inMemoryAccountDirectory(accounts)),
        ),
      ),
      scope,
    ),
  );
  const runtime =
    options.registry?.(Context.get(built, RuntimeRegistry), fake) ??
    Context.get(built, RuntimeRegistry);
  const statuses = new Statuses(
    accounts.map((account) => ({
      name: account.name,
      kind: account.kind,
      models: [...(options.statusModels ?? testModels)],
      signIn: { state: "signed-in" },
      limits: [],
      checkedAt: "2026-11-10T12:00:00Z",
    })),
  );
  const native = options.native ?? createModels();
  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "coder" }],
    tokensPerSecond: 100_000,
  });
  native.setProvider(faux.provider);
  const heads = await NativeHeads.open(options.headsDirectory);
  const bridge = new ChatRuntimeBridge({
    registry: runtime,
    heads,
    ...(options.recovery ? { recovery: options.recovery } : {}),
    ...(options.now ? { now: options.now } : {}),
    log: (event, fields) => fake.logs.push({ event, fields }),
    ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
  });
  const layer = await accountModels(native, {
    registry: runtime,
    statuses,
    bridge,
    log: (event, fields) => fake.logs.push({ event, fields }),
  });
  const models: Models = {
    ...layer.models,
    streamSimple: (...args) => {
      if (layer.owns(args[0].provider)) fake.admitted++;
      return layer.models.streamSimple(...args);
    },
  };
  const extension = chatRuntimeExtension(bridge, layer.owns, options.approvals);
  const pi = createRegistry();
  const executed: number[] = [];
  let conversation: Conversation;
  pi.install(
    defineExtension({
      name: "tools",
      sections: [
        section("prompt", () => "You are a test assistant.", { tag: false }),
      ],
      tools: [
        defineTool({
          name: options.toolName ?? "probe",
          description: "Record a number.",
          parameters: Type.Object({ n: Type.Number() }),
          replay: "safe",
          ...(options.executionMode
            ? { executionMode: options.executionMode }
            : {}),
          execute: async ({ n }, api, toolContext) => {
            executed.push(n);
            return options.execute
              ? options.execute(
                  n,
                  () => conversation,
                  toolContext.abortSignal,
                  api,
                )
              : { content: [{ type: "text", text: `result-${n}` }] };
          },
        }),
      ],
    }),
  );
  for (const item of extension.extensions) pi.install(item);
  const harness = await Harness.open(
    options.storage ?? new MemoryStorage(),
    {
      registry: pi,
      models,
      settings: {
        retry: { maxRetries: 0 },
        compaction: { enabled: false, keepRecentTokens: 1 },
      },
    },
    context,
  );
  let stopApprovals: ((chat: ConversationId) => Promise<void>) | undefined;
  await extension.attach(harness, {
    onStop: (listener) => {
      stopApprovals = listener;
    },
  });
  conversation =
    (options.conversationId &&
      (await harness.conversation(options.conversationId, context))) ||
    (await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: { provider: accounts[0]!.name, modelId: "sonnet" } },
      },
      context,
    ));
  const submit = async (content: string) =>
    (await conversation.submit({ type: "input", content }, context)).wait(
      context,
    );
  const messages = async (): Promise<Message[]> => [
    ...(await conversation.context(context)).messages,
  ];
  return {
    fake,
    native,
    faux,
    statuses,
    models,
    bridge,
    heads,
    harness,
    pi,
    conversation,
    executed,
    submit,
    messages,
    stopApprovals: () => stopApprovals?.(conversation.id),
    close: async () => {
      await extension.close();
      await layer.close();
      await harness.close(context);
      await Effect.runPromise(Scope.close(scope, Exit.void));
    },
  };
}
export async function until(check: () => boolean | Promise<boolean>) {
  for (let n = 0; n < 1000; n++) {
    if (await check()) return;
    await Bun.sleep(2);
  }
  throw new Error("Timed out waiting for fake session");
}
