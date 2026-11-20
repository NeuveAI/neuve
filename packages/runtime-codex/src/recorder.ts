/**
 * Records a conversation with the real program for the replay tests: every line each way, as
 * parsed JSON, redacted before it is kept. A recording holds no credential, no email, no path of
 * the machine that made it, and no path into an app.
 */
import { writeFileSync } from "node:fs";
import { Effect, Layer, Stream } from "effect";
import { redact } from "./redact.ts";
import { CodexProcess } from "./services.ts";

export interface Recorded {
  readonly direction: "out" | "in";
  readonly message: unknown;
}
export interface Recording {
  readonly version: 1;
  /** The release that answered, from the handshake's user agent. */
  readonly codex: string;
  readonly note: string;
  readonly entries: ReadonlyArray<Recorded>;
}

/** Wraps a process service so that every line it carries is added to `into`. */
export const recordingLayer = (
  inner: CodexProcess["Service"],
  into: Array<Recorded>,
) =>
  Layer.succeed(CodexProcess, {
    start: (command, options) =>
      inner.start(command, options).pipe(
        Effect.map((child) => {
          const decoder = new TextDecoder();
          let buffered = "";
          const keep = (direction: Recorded["direction"], line: string) => {
            if (line.trim() === "") return;
            try {
              into.push({ direction, message: JSON.parse(line) });
            } catch {
              into.push({ direction, message: { unparsed: line.length } });
            }
          };
          return {
            ...child,
            stdout: child.stdout.pipe(
              Stream.tap((chunk) =>
                Effect.sync(() => {
                  buffered += decoder.decode(chunk, { stream: true });
                  const lines = buffered.split("\n");
                  buffered = lines.pop() ?? "";
                  for (const line of lines) keep("in", line);
                }),
              ),
            ),
            write: (line: string) =>
              Effect.sync(() => keep("out", line)).pipe(
                Effect.andThen(child.write(line)),
              ),
          };
        }),
      ),
  });

/** Writes a redacted recording to a new file; an existing one is never replaced. */
export const saveRecording = (
  path: string,
  recording: Recording,
  known: ReadonlyArray<readonly [string, string]>,
) =>
  writeFileSync(
    path,
    `${JSON.stringify(redact(recording, known), null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
