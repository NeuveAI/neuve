import { Effect, Layer, Stream } from "effect";
import type { Recording } from "../src/recorder.ts";
import { CodexProcess, type CodexExit } from "../src/services.ts";

/** The test's side of a fake program: what it reads from the client and what it sends back. */
export interface Fake {
  readonly written: Array<Record<string, unknown>>;
  /** Lines the client tried to write after the program stopped taking input. */
  readonly refused: Array<Record<string, unknown>>;
  readonly started: Array<ReadonlyArray<string>>;
  /** Raw text onto standard output as one chunk, newlines included by the caller. */
  readonly emit: (text: string) => void;
  /** Raw bytes onto standard output as one chunk, so a test can split anything anywhere. */
  readonly emitBytes: (bytes: Uint8Array) => void;
  readonly send: (message: unknown) => void;
  readonly stderr: (text: string) => void;
  /** Ends the program; `stderrOpen` leaves its error stream open, as a lingering child would. */
  readonly exit: (
    exit?: Partial<CodexExit>,
    options?: { readonly stderrOpen?: boolean },
  ) => void;
  readonly exited: () => boolean;
  /** Closes standard output while the program keeps running. */
  readonly closeOutput: () => void;
  /** Makes reading standard output fail, as a broken pipe would. */
  readonly breakOutput: () => void;
  /** How the program was asked to stop, in order: `input` for its input ending, or the signal. */
  readonly stops: Array<string>;
  /** From now on the program refuses input but keeps running. */
  readonly refuseInput: () => void;
  /** From now on the program ignores the termination signal; only a kill ends it. */
  readonly ignoreTerm: () => void;
}

const stream = () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({
    start: (c) => {
      controller = c;
    },
  });
  return { readable, controller };
};

/**
 * A fake program behind the process service. `onWrite` sees each line the client writes, parsed.
 * It ends on a signal, and not at the end of its input, so a test sees each step of a stop.
 */
export const fake = (
  onWrite: (message: Record<string, unknown>, fake: Fake) => void,
) => {
  const out = stream();
  const err = stream();
  const encoder = new TextEncoder();
  let ended: CodexExit | undefined;
  let refusing = false;
  let ignoringTerm = false;
  let resolveExit!: (exit: CodexExit) => void;
  const exitPromise = new Promise<CodexExit>((resolve) => {
    resolveExit = resolve;
  });
  const io: Fake = {
    written: [],
    refused: [],
    started: [],
    emit: (text) => io.emitBytes(encoder.encode(text)),
    emitBytes: (bytes) => {
      if (ended === undefined) out.controller.enqueue(bytes);
    },
    send: (message) => io.emit(`${JSON.stringify(message)}\n`),
    stderr: (text) => {
      if (ended === undefined) err.controller.enqueue(encoder.encode(text));
    },
    exit: (exit, options) => {
      if (ended !== undefined) return;
      ended = { exitCode: exit?.exitCode ?? 0, signal: exit?.signal ?? null };
      try {
        out.controller.close();
      } catch {}
      if (options?.stderrOpen !== true) err.controller.close();
      resolveExit(ended);
    },
    exited: () => ended !== undefined,
    closeOutput: () => out.controller.close(),
    breakOutput: () => out.controller.error(new Error("broken pipe")),
    stops: [],
    refuseInput: () => {
      refusing = true;
    },
    ignoreTerm: () => {
      ignoringTerm = true;
    },
  };
  const bytes = (readable: ReadableStream<Uint8Array>) =>
    Stream.fromReadableStream({
      evaluate: () => readable,
      onError: () => undefined,
    }).pipe(Stream.catchCause(() => Stream.empty));
  const layer = Layer.succeed(CodexProcess, {
    start: (command) =>
      Effect.sync(() => {
        io.started.push(command);
        let open = true;
        return {
          // A failed read reaches the client as a defect, so a test can see the reader die.
          stdout: Stream.fromReadableStream({
            evaluate: () => out.readable,
            onError: (error) => error,
          }).pipe(Stream.orDie),
          stderr: bytes(err.readable),
          write: (line: string) =>
            Effect.sync(() => {
              const message = JSON.parse(line) as Record<string, unknown>;
              if (!open || refusing || ended !== undefined) {
                io.refused.push(message);
                return false;
              }
              io.written.push(message);
              onWrite(message, io);
              return true;
            }),
          endInput: Effect.sync(() => {
            open = false;
            io.stops.push("input");
          }),
          exited: Effect.promise(() => exitPromise),
          kill: (signal: "SIGTERM" | "SIGKILL") =>
            Effect.sync(() => {
              io.stops.push(signal);
              if (signal === "SIGTERM" && ignoringTerm) return;
              io.exit({ exitCode: null, signal });
            }),
        };
      }),
  });
  return { io, layer };
};

/**
 * Plays a recorded conversation back: each line the client writes must match the next recorded
 * outgoing one (the same method, or the same id for an answer to Codex's request), and then the
 * recorded incoming lines up to the next outgoing one are sent. Request ids are mapped, so the
 * client may number its requests differently.
 */
export const replay = (recording: Recording) => {
  const entries = recording.entries;
  const mismatches: Array<string> = [];
  const ids = new Map<unknown, unknown>();
  let at = 0;
  const flush = (io: Fake) => {
    while (at < entries.length && entries[at]!.direction === "in") {
      const message = entries[at++]!.message as Record<string, unknown>;
      io.send(
        message.method === undefined && ids.has(message.id)
          ? { ...message, id: ids.get(message.id) }
          : message,
      );
    }
  };
  const played = fake((message, io) => {
    const expected = entries[at]?.message as
      Record<string, unknown> | undefined;
    const same =
      expected !== undefined &&
      entries[at]!.direction === "out" &&
      (expected.method !== undefined
        ? expected.method === message.method
        : expected.id === message.id);
    if (!same) {
      mismatches.push(`at ${at}: ${String(message.method ?? message.id)}`);
      return;
    }
    if (expected.method !== undefined && expected.id !== undefined)
      ids.set(expected.id, message.id);
    at++;
    queueMicrotask(() => flush(io));
  });
  return { ...played, mismatches, done: () => at === entries.length };
};
