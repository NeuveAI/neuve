import { Context, type Effect, type Scope, type Stream } from "effect";
import type { CodexSpawnFailed } from "./errors.ts";

export interface CodexExit {
  readonly exitCode: number | null;
  readonly signal: string | null;
}

/** One started program, seen as bytes: what the client reads and writes, and how it ends. */
export interface CodexChild {
  /** Standard output in the chunks it arrives in. It ends when the program closes it. */
  readonly stdout: Stream.Stream<Uint8Array>;
  readonly stderr: Stream.Stream<Uint8Array>;
  /** Writes one whole line in one write, so lines never interleave. False once input is closed. */
  readonly write: (line: string) => Effect.Effect<boolean>;
  readonly endInput: Effect.Effect<void>;
  /** Waits for the program to end. */
  readonly exited: Effect.Effect<CodexExit>;
  readonly kill: (signal: "SIGTERM" | "SIGKILL") => Effect.Effect<void>;
}

/** Starts the program. Closing the scope stops whatever is still running. */
export class CodexProcess extends Context.Service<
  CodexProcess,
  {
    readonly start: (
      command: readonly [string, ...string[]],
      options: {
        readonly env: Readonly<Record<string, string | undefined>>;
        readonly cwd: string;
      },
    ) => Effect.Effect<CodexChild, CodexSpawnFailed, Scope.Scope>;
  }
>()("@neuve/runtime-codex/CodexProcess") {}
