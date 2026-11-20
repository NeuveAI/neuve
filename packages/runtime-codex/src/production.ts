import { Effect, Layer, Stream } from "effect";
import { CodexSpawnFailed } from "./errors.ts";
import { CodexProcess } from "./services.ts";

const bytes = (stream: ReadableStream<Uint8Array>) =>
  Stream.fromReadableStream({
    evaluate: () => stream,
    onError: () => undefined,
  }).pipe(Stream.catchCause(() => Stream.empty));

/** The program as a child process over its standard input, output and error. */
export const processService: CodexProcess["Service"] = {
  start: (command, options) =>
    Effect.acquireRelease(
      Effect.try({
        try: () =>
          Bun.spawn([...command], {
            env: { ...options.env },
            cwd: options.cwd,
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
          }),
        catch: (error) =>
          new CodexSpawnFailed({
            reason: error instanceof Error ? error.name : "spawn",
          }),
      }),
      (child) =>
        Effect.promise(async () => {
          if (child.exitCode === null && child.signalCode === null)
            child.kill("SIGKILL");
          await child.exited;
        }),
    ).pipe(
      Effect.map((child) => {
        let open = true;
        return {
          stdout: bytes(child.stdout),
          stderr: bytes(child.stderr),
          write: (line: string) =>
            Effect.sync(() => {
              if (!open) return false;
              try {
                child.stdin.write(line);
                child.stdin.flush();
                return true;
              } catch {
                open = false;
                return false;
              }
            }),
          endInput: Effect.sync(() => {
            if (!open) return;
            open = false;
            try {
              child.stdin.end();
            } catch {}
          }),
          exited: Effect.promise(() => child.exited).pipe(
            Effect.map(() => ({
              exitCode: child.exitCode,
              signal:
                child.signalCode === null ? null : String(child.signalCode),
            })),
          ),
          kill: (signal: "SIGTERM" | "SIGKILL") =>
            Effect.sync(() => {
              if (child.exitCode === null && child.signalCode === null)
                child.kill(signal);
            }),
        };
      }),
    ),
};
export const processLayer = Layer.succeed(CodexProcess, processService);
