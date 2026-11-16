import type { CallRecord } from "./dump.ts";
import { DumpFailed } from "./sources.ts";
import { compatibleScope, type nativeScopes } from "./scope.ts";
import { sameTokens } from "./usage.ts";
import type { CaptureScope, CapturedEvent, JournalLine } from "./types.ts";

type Call = Omit<CallRecord, "role">;
type Request = Extract<CapturedEvent, { type: "model.request" }> & {
  readonly credentialCoverage: Call["credentialCoverage"];
};
type Lifecycle =
  | { readonly kind: "requested" }
  | {
      readonly kind: "responded";
      readonly response: NonNullable<Call["response"]>;
    }
  | {
      readonly kind: "ended";
      readonly response: Call["response"];
      readonly end: NonNullable<Call["end"]>;
    };
interface ObservedCall {
  readonly request: Request;
  readonly at: number;
  scope: CaptureScope;
  lifecycle: Lifecycle;
  readonly events: Call["events"];
}

export const outcomeOfStop = (stopReason: string) =>
  ["stop", "length", "toolUse", "deferred"].includes(stopReason)
    ? "completed"
    : stopReason === "aborted"
      ? "aborted"
      : "failed";

export const callsOf = (
  lines: ReadonlyArray<JournalLine>,
  retainScopes: boolean,
  validateScope: ReturnType<typeof nativeScopes>,
): Map<string, Call> => {
  const observed = new Map<string, ObservedCall>();
  const reject: (callId: string, reason: string) => never = (
    callId,
    reason,
  ) => {
    throw new DumpFailed({ reason: `call ${callId} ${reason}` });
  };
  for (const { at, event } of lines) {
    if (event.type === "model.request") {
      if (event.credentialCoverage === undefined)
        reject(event.callId, "lacks its credential coverage declaration");
      if (observed.has(event.callId))
        reject(event.callId, "was requested twice");
      observed.set(event.callId, {
        request: { ...event, credentialCoverage: event.credentialCoverage },
        at,
        scope: event.scope,
        lifecycle: { kind: "requested" },
        events: [],
      });
      continue;
    }
    if (
      event.type !== "model.response" &&
      event.type !== "model.event" &&
      event.type !== "model.end"
    )
      continue;
    const call = observed.get(event.callId);
    if (call === undefined)
      reject(event.callId, `${event.type} was never requested`);
    if (!compatibleScope(call.scope, event.scope))
      reject(event.callId, "changed capture scope");
    call.scope = { ...call.scope, ...event.scope };
    validateScope(call.scope);
    const lifecycle = call.lifecycle;
    if (event.type === "model.response") {
      if (lifecycle.kind !== "requested")
        reject(event.callId, "has a repeated or reordered response");
      call.lifecycle = {
        kind: "responded",
        response: {
          at,
          ...(retainScopes ? { scope: event.scope } : {}),
          status: event.status,
          requestId: event.requestId,
          responseId: event.responseId,
        },
      };
    } else if (event.type === "model.event") {
      if (
        lifecycle.kind === "requested" &&
        (event.name.startsWith("response.") ||
          event.name.startsWith("message_") ||
          event.name.startsWith("content_block_") ||
          event.name === "error")
      )
        reject(event.callId, "has provider output before its response");
      // Credential exclusion can report redactions immediately after recording the end.
      if (lifecycle.kind === "ended" && event.name !== "credential_redactions")
        reject(event.callId, "has a model event after its end");
      call.events.push({
        at,
        ...(retainScopes ? { scope: event.scope } : {}),
        name: event.name,
        data: event.data,
      });
    } else {
      if (lifecycle.kind === "ended") reject(event.callId, "ended twice");
      if (
        event.sdkUsage !== undefined &&
        event.usage !== undefined &&
        (!sameTokens(event.sdkUsage, event.usage) ||
          event.sdkUsage.reasoning !== event.usage.reasoning)
      )
        reject(event.callId, "contradicts its SDK usage");
      if (
        event.stopReason !== undefined &&
        event.outcome !== outcomeOfStop(event.stopReason)
      )
        reject(event.callId, "outcome contradicts its terminal stop reason");
      if (event.outcome === "completed" && event.error !== undefined)
        reject(event.callId, "completed with a retained failure");
      const response =
        lifecycle.kind === "responded" ? lifecycle.response : null;
      if (
        response?.responseId !== undefined &&
        event.responseId !== undefined &&
        response.responseId !== event.responseId
      )
        reject(event.callId, "response identities disagree");
      call.lifecycle = {
        kind: "ended",
        response,
        end: {
          at,
          ...(retainScopes ? { scope: event.scope } : {}),
          outcome: event.outcome,
          responseId: event.responseId,
          messageTimestamp: event.messageTimestamp,
          stopReason: event.stopReason,
          usage: event.usage,
          sdkUsage: event.sdkUsage,
          error: event.error,
        },
      };
    }
  }
  return new Map(
    [...observed].map(([callId, call]) => {
      const { type: _type, callId: _id, ...request } = call.request;
      return [
        callId,
        {
          ...request,
          callId,
          requestedAt: call.at,
          response:
            call.lifecycle.kind === "requested"
              ? null
              : call.lifecycle.response,
          events: call.events,
          end: call.lifecycle.kind === "ended" ? call.lifecycle.end : null,
        },
      ];
    }),
  );
};
