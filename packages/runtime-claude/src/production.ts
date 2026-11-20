// This is the only module that loads Agent SDK runtime values.
import {
  query,
  ORG_POLICY_LIMIT_PREFIXES,
  USAGE_LIMIT_ERROR_PREFIXES,
} from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { QuerySession } from "./services.ts";
import { findProgram } from "@neuve/runtime";
import { Effect, Layer, Queue, Stream } from "effect";
import {
  ClaudeExecutable,
  ClaudeProcess,
  ClaudeSdk,
  ClaudeSdkError,
} from "./services.ts";

const sdkError = (method: string, rejection?: unknown) => {
  const fields =
    rejection !== null && typeof rejection === "object" ? rejection : {};
  const read = (key: string) => {
    try {
      return Object.hasOwn(fields, key) ? Reflect.get(fields, key) : undefined;
    } catch {
      return undefined;
    }
  };
  const errorClass = read("errorClass");
  const exitCode = read("exitCode");
  const signal = read("signal");
  return new ClaudeSdkError({
    method,
    ...(typeof errorClass === "string" &&
    /^[a-z][a-z0-9_]{0,39}$/i.test(errorClass)
      ? { errorClass }
      : {}),
    ...(typeof exitCode === "number" && Number.isInteger(exitCode)
      ? { exitCode }
      : {}),
    ...(typeof signal === "string" && /^SIG[A-Z0-9]{1,8}$/.test(signal)
      ? { signal }
      : {}),
  });
};
export const executableLayer = Layer.succeed(ClaudeExecutable, {
  resolve: (explicit) => Effect.sync(() => findProgram("claude", explicit)),
});
export const processLayer = Layer.succeed(ClaudeProcess, {
  run: (command, env) =>
    Effect.scoped(
      Effect.gen(function* () {
        const child = yield* Effect.acquireRelease(
          Effect.try({
            try: () =>
              Bun.spawn([...command], {
                env,
                stdin: "ignore",
                stdout: "ignore",
                stderr: "ignore",
              }),
            catch: (error) => sdkError("logout", error),
          }),
          (child) =>
            Effect.promise(async () => {
              if (child.exitCode === null) child.kill("SIGKILL");
              await child.exited;
            }),
        );
        const code = yield* Effect.tryPromise({
          try: () => child.exited,
          catch: (error) => sdkError("logout", error),
        }).pipe(
          Effect.timeout("25 seconds"),
          Effect.mapError((error) => sdkError("logout", error)),
        );
        if (code !== 0) return yield* sdkError("logout");
      }),
    ),
});
export const sdkLayer = Layer.succeed(ClaudeSdk, {
  prefixes: {
    usage: USAGE_LIMIT_ERROR_PREFIXES,
    organization: ORG_POLICY_LIMIT_PREFIXES,
  },
  open: (options) =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<SDKUserMessage>();
      const abortController = options.abortController ?? new AbortController();
      const prompt = Stream.fromQueue(queue).pipe(Stream.toAsyncIterable);
      const q = yield* Effect.try({
        try: () => query({ prompt, options: { ...options, abortController } }),
        catch: (error) => sdkError("open", error),
      }).pipe(Effect.onError(() => Queue.shutdown(queue)));
      let disposal: Promise<void> | undefined;
      const close = Queue.shutdown(queue).pipe(
        Effect.andThen(
          Effect.tryPromise({
            try: () => {
              if (disposal === undefined) {
                abortController.abort();
                q.close();
                disposal = Promise.resolve(q[Symbol.asyncDispose]());
              }
              return disposal;
            },
            catch: (error) => sdkError("close", error),
          }),
        ),
        Effect.asVoid,
      );
      yield* Effect.addFinalizer(() => close.pipe(Effect.orDie));
      return {
        // Query.return queues behind a read on the generator itself; iterate the Query wrapper.
        messages: Stream.fromAsyncIterable(
          { [Symbol.asyncIterator]: () => q },
          (error) => sdkError("messages", error),
        ),
        offer: (message: SDKUserMessage) =>
          Effect.uninterruptibleMask((restore) =>
            restore(Queue.offer(queue, message)).pipe(
              Effect.flatMap((accepted) =>
                accepted ? Effect.void : Effect.fail(sdkError("offer")),
              ),
            ),
          ),
        interrupt: Effect.tryPromise({
          try: () => q.interrupt(),
          catch: (error) => sdkError("interrupt", error),
        }).pipe(Effect.asVoid),
        setModel: (model?: string) =>
          Effect.tryPromise({
            try: () => q.setModel(model),
            catch: (error) => sdkError("setModel", error),
          }),
        applyFlagSettings: (
          settings: Parameters<QuerySession["applyFlagSettings"]>[0],
        ) =>
          Effect.tryPromise({
            try: () => q.applyFlagSettings(settings),
            catch: (error) => sdkError("applyFlagSettings", error),
          }),
        initializationResult: Effect.tryPromise({
          try: () => q.initializationResult(),
          catch: (error) => sdkError("initializationResult", error),
        }),
        close,
      };
    }).pipe(Effect.uninterruptible),
});
