import type {
  AccountInfo,
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Context, Data, type Effect, type Scope, type Stream } from "effect";

export class ClaudeSdkError extends Data.TaggedError("ClaudeSdkError")<{
  readonly method: string;
  readonly errorClass?: string;
  readonly exitCode?: number;
  readonly signal?: string;
}> {}
export interface QuerySession {
  readonly messages: Stream.Stream<SDKMessage, ClaudeSdkError>;
  readonly offer: (
    message: SDKUserMessage,
  ) => Effect.Effect<void, ClaudeSdkError>;
  readonly interrupt: Effect.Effect<void, ClaudeSdkError>;
  readonly setModel: (model?: string) => Effect.Effect<void, ClaudeSdkError>;
  readonly applyFlagSettings: (
    settings: Parameters<Query["applyFlagSettings"]>[0],
  ) => Effect.Effect<void, ClaudeSdkError>;
  readonly close: Effect.Effect<void, ClaudeSdkError>;
  readonly initializationResult: Effect.Effect<
    { readonly account: AccountInfo; readonly models?: unknown },
    ClaudeSdkError
  >;
}
export interface ErrorPrefixes {
  readonly usage: ReadonlyArray<string>;
  readonly organization: ReadonlyArray<string>;
}
export class ClaudeSdk extends Context.Service<
  ClaudeSdk,
  {
    readonly prefixes: ErrorPrefixes;
    readonly open: (
      options: Options,
    ) => Effect.Effect<QuerySession, ClaudeSdkError, Scope.Scope>;
  }
>()("@neuve/runtime-claude/ClaudeSdk") {}
export class ClaudeExecutable extends Context.Service<
  ClaudeExecutable,
  {
    readonly resolve: (explicit?: string) => Effect.Effect<string | undefined>;
  }
>()("@neuve/runtime-claude/ClaudeExecutable") {}
export class ClaudeProcess extends Context.Service<
  ClaudeProcess,
  {
    readonly run: (
      command: readonly [string, ...string[]],
      env: Record<string, string | undefined>,
    ) => Effect.Effect<void, ClaudeSdkError>;
  }
>()("@neuve/runtime-claude/ClaudeProcess") {}
