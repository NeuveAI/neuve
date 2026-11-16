import { CaptureScope } from "./types.ts";
import type { NativeSnapshot } from "./sources.ts";
import { DumpFailed } from "./sources.ts";

export const compatibleScope = (left: CaptureScope, right: CaptureScope) =>
  CaptureScope.keyof().options.every(
    (key) =>
      left[key] === undefined ||
      right[key] === undefined ||
      left[key] === right[key],
  );

/** Check observed ownership before any lifecycle fact or private identifier is reduced. */
export const nativeScopes = (native: NativeSnapshot, runId: string) => {
  const conversations = new Set(native.conversations.map((c) => c.id));
  const entries = new Map(
    native.conversations.flatMap((c) =>
      c.entries.map((e) => [e.id, e] as const),
    ),
  );
  const tasks = new Map(
    native.conversations.flatMap((c) => c.tasks.map((t) => [t.id, t] as const)),
  );
  return (
    scope: CaptureScope,
    owner?: { conversationId: number; taskId?: number },
  ) => {
    if (
      scope.conversationId !== undefined &&
      !conversations.has(scope.conversationId)
    )
      throw new DumpFailed({
        reason: "capture scope names no native conversation",
      });
    const entry =
      scope.entryId === undefined ? undefined : entries.get(scope.entryId);
    const task =
      scope.taskId === undefined ? undefined : tasks.get(scope.taskId);
    const conversationId =
      scope.conversationId ??
      owner?.conversationId ??
      entry?.conversationId ??
      task?.conversationId;
    if (
      scope.runId !== runId ||
      (scope.conversationId !== undefined &&
        !conversations.has(scope.conversationId)) ||
      (scope.entryId !== undefined && entry === undefined) ||
      (scope.taskId !== undefined && task === undefined) ||
      (owner !== undefined && conversationId !== owner.conversationId) ||
      (entry !== undefined && entry.conversationId !== conversationId) ||
      (task !== undefined && task.conversationId !== conversationId) ||
      (entry !== undefined &&
        task !== undefined &&
        entry.byTaskId !== task.id) ||
      (owner !== undefined &&
        scope.taskId !== undefined &&
        scope.taskId !== owner.taskId)
    )
      throw new DumpFailed({
        reason: "capture scope contradicts native ownership",
      });
  };
};
