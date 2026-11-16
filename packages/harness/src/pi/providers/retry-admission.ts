import { safeRead } from "@neuve/records-schema";
import type { RunLog } from "../../run-log.ts";
import { logTimed } from "../../log-span.ts";
import type { Context } from "@earendil-works/chord";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import {
  isContextOverflow,
  isRetryableAssistantError,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Model,
  type Api,
  type Provider,
} from "@earendil-works/pi-ai";
import { lazyStream } from "@earendil-works/pi-ai/api/lazy";
import {
  defineDoc,
  LiveDoc,
  type ConversationId,
  type Harness,
  type HarnessSettings,
} from "@earendil-works/pi-durable";
import { Effect } from "effect";
import { z } from "zod";
import { routeFailureOf } from "./failure.ts";

export const NativeAttemptsDoc = defineDoc<{
  generations: { [id: string]: number[] };
}>({
  kind: "neuve.native-attempts",
  version: 1,
  scope: "session",
  initial: () => ({ generations: {} }),
});

const RetryAdmissionDoc = defineDoc<{ until: number }>({
  kind: "neuve.retry-admission",
  version: 1,
  scope: "task",
  initial: () => ({ until: 0 }),
});

const GenerationRequest = z.object({
  phase: z.literal("request"),
  attempt: z.number().int().positive(),
});

type AdmissionTarget = {
  readonly log?: RunLog | undefined;
  readonly harness: Harness;
  readonly conversationId: ConversationId;
  readonly onReport?: ((error: unknown) => void) | undefined;
};

/** Keep the native attempt policy and its provider admission together; neither adds another retry loop. */
export const nativeRetryAdmission = (settings: HarnessSettings) => ({
  settings: {
    ...settings,
    retry: { ...settings.retry, baseDelayMs: 0 },
  } satisfies HarnessSettings,
  provider: (provider: Provider, target: AdmissionTarget): Provider =>
    retryAdmissionProvider(provider, { ...target, policy: settings.retry }),
});

/** Retry-After is measured at receipt, so reopening never starts its wait over. */
export const retryAfterAt = (
  header: string | null,
  receivedAt: number,
): number | undefined => {
  if (header === null) return undefined;
  const value = header.trim();
  if (/^\d+(?:\.\d+)?$/.test(value))
    return Math.min(
      Number.MAX_SAFE_INTEGER,
      receivedAt + Number(value) * 1_000,
    );
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(receivedAt, at) : undefined;
};

const waitUntil = async (until: number, signal: AbortSignal | undefined) => {
  let remaining = until - Date.now();
  while (remaining > 0) {
    await Effect.runPromise(Effect.sleep(Math.min(remaining, 2_147_483_647)), {
      ...(signal === undefined ? {} : { signal }),
    });
    remaining = until - Date.now();
  }
};

/** Wrap outside the call-slot boundary, so native retry waits hold no model-call slot. */
const retryAdmissionProvider = (
  provider: Provider,
  input: AdmissionTarget & {
    readonly policy: HarnessSettings["retry"];
  },
): Provider => {
  const required = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (cause) {
      input.onReport?.(cause);
      throw new Error("Native retry admission failed", { cause });
    }
  };
  const admitted = (
    model: Model<Api>,
    signal: AbortSignal | undefined,
    start: () => AssistantMessageEventStream,
  ) =>
    lazyStream(model, async () => {
      const context: Context =
        signal === undefined
          ? BACKGROUND_CONTEXT
          : withAbortSignal(signal, BACKGROUND_CONTEXT);
      const live = await required(() =>
        input.harness.snapshot(LiveDoc, input.conversationId, context),
      );
      if (live?.run === undefined || live.generation === undefined)
        throw new Error("Native retry admission has no running generation");
      const taskId = live.run.taskId;
      const task = await required(() => input.harness.getTask(taskId, context));
      const request =
        task?.state.status === "running"
          ? safeRead(GenerationRequest, task.state.checkpoint)
          : undefined;
      if (
        task?.kind !== "pi.generation" ||
        request?.success !== true ||
        request.data.attempt !== live.generation.attempt
      )
        throw new Error("Native retry admission is not a generation request");
      const attempt = request.data.attempt;
      const deadline = await required(() =>
        input.harness.snapshot(RetryAdmissionDoc, taskId, context),
      );
      if ((deadline?.until ?? 0) > Date.now())
        await logTimed(
          input.log,
          "harness.retry-after.wait",
          {
            "harness.conversation_id": input.conversationId,
            "harness.task_id": taskId,
          },
          () => waitUntil(deadline?.until ?? 0, signal),
        );
      signal?.throwIfAborted();
      await required(() =>
        input.harness.commit(async (tx) => {
          const doc = await tx.doc(NativeAttemptsDoc);
          const attempts = doc.generations[String(taskId)] ?? [];
          if (!attempts.includes(attempt))
            doc.generations[String(taskId)] = [...attempts, attempt];
        }, context),
      );
      const forward =
        async function* (): AsyncGenerator<AssistantMessageEvent> {
          for await (const event of start()) {
            if (
              event.type === "error" &&
              event.error.stopReason === "error" &&
              !isContextOverflow(event.error) &&
              isRetryableAssistantError(event.error) &&
              input.policy?.enabled !== false
            ) {
              const jittered =
                Math.min(
                  (input.policy?.baseDelayMs ?? 2_000) *
                    2 ** Math.max(0, attempt - 1),
                  input.policy?.maxAgentDelayMs ?? 60_000,
                ) *
                (0.8 + 0.4 * Math.random());
              const until = Math.max(
                Date.now() + jittered,
                routeFailureOf(event.error)?.retryAfterAt ?? 0,
              );
              await required(() =>
                input.harness.commit(async (tx) => {
                  const doc = await tx.doc(RetryAdmissionDoc, taskId);
                  doc.until = Math.max(doc.until, until);
                }, context),
              );
            }
            yield event;
          }
        };
      return forward();
    });
  return {
    ...provider,
    stream: (model, transcript, options) =>
      admitted(model, options?.signal, () =>
        provider.stream(model, transcript, options),
      ),
    streamSimple: (model, transcript, options) =>
      admitted(model, options?.signal, () =>
        provider.streamSimple(model, transcript, options),
      ),
  };
};
