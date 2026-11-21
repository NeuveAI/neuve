/**
 * The line-based client for `codex app-server` over standard input and output: one JSON message
 * per line each way, with no `jsonrpc` field ([app server](https://learn.chatgpt.com/docs/app-server),
 * "Protocol"). It matches responses to requests by id, delivers the notifications it reads in
 * order, answers Codex's requests through the caller, and does the handshake on the stable
 * surface. It maps nothing onto the runtime contract.
 */
import {
  type Cause,
  Deferred,
  type Duration,
  Effect,
  Fiber,
  Queue,
  Stream,
} from "effect";
import {
  CodexBacklog,
  CodexClosed,
  CodexExited,
  CodexHandshakeTimeout,
  CodexInputRefused,
  CodexMalformedLine,
  CodexOutputEnded,
  CodexOversizedLine,
  CodexRequestFailed,
  CodexUnknownMessage,
  type CodexFailure,
  type CodexTermination,
} from "./errors.ts";
import type { ClientInfo } from "./generated/ClientInfo";
import type { InitializeResponse } from "./generated/InitializeResponse";
import type { RequestId } from "./generated/RequestId";
import {
  READ_NOTIFICATIONS,
  SERVER_NOTIFICATIONS,
  SERVER_REQUESTS,
  type ClientMethods,
  type Notifications,
  type ServerRequests,
} from "./generated/methods.ts";
import { CodexProcess, type CodexChild } from "./services.ts";

export type Method = keyof ClientMethods;
export type Notification = {
  [K in keyof Notifications]: {
    readonly method: K;
    readonly params: Notifications[K];
  };
}[keyof Notifications];
export type ServerRequest = {
  [K in keyof ServerRequests]: {
    readonly id: RequestId;
    readonly method: K;
    readonly params: ServerRequests[K];
  };
}[keyof ServerRequests];
/** The client's answer to one of Codex's requests. */
export type Answer =
  | { readonly result: unknown }
  | { readonly error: { readonly code: number; readonly message: string } };

/** JSON-RPC's "method not found", the answer to a request this release does not have. */
export const UNSUPPORTED = -32601;
/** JSON-RPC's "internal error", the answer when the caller's own answer fails. */
export const INTERNAL = -32603;
/** A thread's history comes back whole in one line, so the limit is generous but finite. */
export const MAX_LINE_BYTES = 64 * 1024 * 1024;
/**
 * Unread notifications held before the connection ends. A busy turn sends a few thousand; the
 * bound is for a reader that has stopped, about 100 MB at the size of the reviewer's measurement.
 */
export const MAX_QUEUED_NOTIFICATIONS = 200_000;
const STDERR_TAIL_CHARS = 4000;
/** How long output that ended cleanly waits for the exit, which then ends the connection itself. */
const EXIT_GRACE = "1 second";

export interface Line {
  readonly direction: "out" | "in";
  readonly message: unknown;
}

export interface ConnectOptions {
  readonly program: string;
  /** Arguments after `app-server`, such as `-c key=value` pairs. */
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly clientInfo: ClientInfo;
  readonly answer: (request: ServerRequest) => Effect.Effect<Answer>;
  readonly maxLineBytes?: number;
  readonly maxQueued?: number;
  /**
   * Sees every line each way as it passes, parsed (or, for a line that is not JSON, its length),
   * before anything else is done with it: the runtime's protocol log and the recorder use it.
   */
  readonly onLine?: (line: Line) => void;
  readonly handshakeTimeout?: Duration.Input;
  /** How long a program asked to stop has before it is killed; five seconds by default. */
  readonly stopWait?: Duration.Input;
}

export interface CodexConnection {
  readonly initialize: InitializeResponse;
  readonly request: <M extends Method>(
    method: M,
    ...params: ClientMethods[M]["params"] extends undefined
      ? []
      : [ClientMethods[M]["params"]]
  ) => Effect.Effect<ClientMethods[M]["response"], CodexFailure>;
  /**
   * The notifications the client reads, in the order they arrived; one reader. The reader is never
   * held back, since the one pipe carries responses too and a caller may be waiting for one before
   * it reads notifications. Past `maxQueued` unread, the connection ends with `CodexBacklog`.
   */
  readonly notifications: Stream.Stream<Notification, CodexTermination>;
  /**
   * Ends input and asks the program to stop, then kills it if it is still running after the stop
   * wait. Closing the scope does the same, whether the connection was open or had ended.
   */
  readonly close: Effect.Effect<void>;
  /** Whether the connection is still open: false once the program ended or was closed. */
  readonly open: () => boolean;
}

/** Bounded for a log line: Codex chooses these names. */
const printable = (method: string) =>
  method.replace(/[^\x21-\x7e]/g, "?").slice(0, 100);
const isId = (value: unknown): value is RequestId =>
  typeof value === "string" || typeof value === "number";
const key = (id: RequestId) => `${typeof id}:${id}`;

/** Starts `<program> app-server <args>` and completes the handshake. */
export const connect = Effect.fnUntraced(function* (options: ConnectOptions) {
  const codex = yield* CodexProcess;
  const scope = yield* Effect.scope;
  const child: CodexChild = yield* codex.start(
    [options.program, "app-server", ...options.args],
    { env: options.env, cwd: options.cwd },
  );
  const limit = options.maxLineBytes ?? MAX_LINE_BYTES;
  const queueLimit = options.maxQueued ?? MAX_QUEUED_NOTIFICATIONS;
  const seeLine = (direction: Line["direction"], message: unknown) => {
    try {
      options.onLine?.({ direction, message });
    } catch {}
  };
  const notifications = yield* Queue.unbounded<
    Notification,
    CodexTermination | Cause.Done
  >();
  const pending = new Map<
    string,
    {
      readonly method: string;
      readonly deferred: Deferred.Deferred<unknown, CodexFailure>;
    }
  >();
  let state:
    | { readonly kind: "open" }
    | { readonly kind: "closed" }
    | {
        readonly kind: "ended";
        readonly failure: (method: string) => CodexTermination;
      } = { kind: "open" };
  let nextId = 0;
  let stderrTail = "";
  const logged = new Set<string>();
  const logOnce = (kind: CodexUnknownMessage["kind"], method: string) => {
    const label = `${kind}:${method}`;
    return logged.has(label)
      ? Effect.void
      : Effect.sync(() => logged.add(label)).pipe(
          Effect.andThen(
            Effect.logWarning(
              "codex-app-server ignored",
              new CodexUnknownMessage({ kind, method: printable(method) }),
            ),
          ),
        );
  };

  /**
   * Stops the program the way a terminal would: input closed, then a request to stop, then, if it
   * is still running after the stop wait, a kill. The signal goes to the process the client
   * started. With the ChatGPT desktop app's wrapper script, that script hands itself over to the
   * real program (`exec`), so the signal reaches Codex, which can stop its own children. Another
   * install's entry point may not do that, and then only the kill reaches past it.
   */
  const askToStop = child.endInput.pipe(Effect.andThen(child.kill("SIGTERM")));
  const killIfStill = child.exited.pipe(
    Effect.timeoutOption(options.stopWait ?? "5 seconds"),
    Effect.flatMap((exited) =>
      exited._tag === "None" ? child.kill("SIGKILL") : Effect.void,
    ),
  );
  const end = (failure: (method?: string) => CodexTermination) =>
    Effect.gen(function* () {
      if (state.kind !== "open") return;
      state = { kind: "ended", failure };
      yield* askToStop;
      yield* Effect.forkIn(killIfStill, scope);
      for (const entry of pending.values())
        yield* Deferred.fail(entry.deferred, failure(entry.method));
      pending.clear();
      yield* Queue.fail(notifications, failure());
    });
  /** A write the program refuses ends the connection: what it did not take is lost. */
  const send = (message: Record<string, unknown>): Effect.Effect<boolean> =>
    Effect.sync(() => seeLine("out", message)).pipe(
      Effect.andThen(child.write(`${JSON.stringify(message)}\n`)),
      Effect.tap((written) =>
        written
          ? Effect.void
          : end((method) =>
              method === undefined
                ? new CodexInputRefused({})
                : new CodexInputRefused({ method }),
            ),
      ),
    );
  // Suspended, so an answer that throws before it returns an effect is caught like one that fails.
  const answerOf = (request: ServerRequest) =>
    Effect.suspend(() => options.answer(request)).pipe(
      Effect.catchCause(() =>
        Effect.succeed<Answer>({
          error: { code: INTERNAL, message: "the client could not answer" },
        }),
      ),
    );

  const onMessage = (message: Record<string, unknown>) =>
    Effect.gen(function* () {
      const { id, method } = message;
      if (typeof method === "string" && isId(id)) {
        if (!SERVER_REQUESTS.has(method)) {
          yield* logOnce("request", method);
          yield* send({
            id,
            error: { code: UNSUPPORTED, message: "unsupported request" },
          });
          return;
        }
        yield* answerOf({
          id,
          method,
          params: message.params,
        } as ServerRequest).pipe(
          Effect.flatMap((answer) =>
            state.kind === "open" ? send({ id, ...answer }) : Effect.void,
          ),
          Effect.forkIn(scope),
        );
        return;
      }
      if (typeof method === "string" && id === undefined) {
        if (!SERVER_NOTIFICATIONS.has(method))
          yield* logOnce("notification", method);
        else if (READ_NOTIFICATIONS.has(method)) {
          if ((yield* Queue.size(notifications)) >= queueLimit)
            return yield* end(() => new CodexBacklog({ limit: queueLimit }));
          yield* Queue.offer(notifications, {
            method,
            params: message.params,
          } as Notification);
        }
        return;
      }
      if (
        method === undefined &&
        isId(id) &&
        ("result" in message || "error" in message)
      ) {
        const entry = pending.get(key(id));
        if (entry === undefined)
          return yield* logOnce("response", "no-pending-request");
        pending.delete(key(id));
        const error = message.error as
          | { code?: unknown; message?: unknown; data?: { type?: unknown } }
          | undefined;
        const type = error?.data?.type;
        if (error !== undefined && error !== null)
          yield* Deferred.fail(
            entry.deferred,
            CodexRequestFailed.of(
              {
                method: entry.method,
                code: typeof error.code === "number" ? error.code : 0,
                ...(typeof type === "string" ? { type: printable(type) } : {}),
              },
              typeof error.message === "string"
                ? error.message.slice(0, 500)
                : "",
            ),
          );
        else yield* Deferred.succeed(entry.deferred, message.result);
        return;
      }
      yield* end(
        () =>
          new CodexMalformedLine({
            reason: "shape",
            bytes: JSON.stringify(message).length,
          }),
      );
    });

  const decoder = new TextDecoder();
  const onLine = (bytes: Uint8Array) => {
    const text = decoder.decode(bytes).trim();
    if (text === "") return Effect.void;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      seeLine("in", { unparsed: bytes.length });
      return end(
        () => new CodexMalformedLine({ reason: "json", bytes: bytes.length }),
      );
    }
    seeLine("in", parsed);
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? onMessage(parsed as Record<string, unknown>)
      : end(
          () =>
            new CodexMalformedLine({ reason: "shape", bytes: bytes.length }),
        );
  };

  // Frames lines from chunks, refusing a line past the limit before buffering more of it. Lines
  // are split on the newline byte, which never occurs inside a UTF-8 character, and decoded whole.
  let parts: Array<Uint8Array> = [];
  let size = 0;
  const onChunk = (chunk: Uint8Array) =>
    Effect.gen(function* () {
      let rest = chunk;
      while (state.kind === "open") {
        const newline = rest.indexOf(10);
        const taken = newline === -1 ? rest : rest.subarray(0, newline);
        if (size + taken.length > limit)
          return yield* end(() => new CodexOversizedLine({ limit }));
        if (newline === -1) {
          parts.push(taken);
          size += taken.length;
          return;
        }
        const line = new Uint8Array(size + taken.length);
        let at = 0;
        for (const part of [...parts, taken]) {
          line.set(part, at);
          at += part.length;
        }
        parts = [];
        size = 0;
        rest = rest.subarray(newline + 1);
        yield* onLine(line);
      }
    });

  const stderrDecoder = new TextDecoder();
  const stderr = yield* Stream.runForEach(child.stderr, (chunk) =>
    Effect.sync(() => {
      stderrTail = (
        stderrTail + stderrDecoder.decode(chunk, { stream: true })
      ).slice(-STDERR_TAIL_CHARS);
    }),
  ).pipe(Effect.forkIn(scope));
  // The reader ending for any reason ends the connection, so no caller waits on output that will
  // never come. Output that ended cleanly gives the exit a moment, since a program that exits
  // closes its output first and the exit below then ends the connection with how it exited; output
  // closing while the program lingers, or the reader failing, ends it here. Either way the program
  // is stopped.
  const outputEnded = (reason: CodexOutputEnded["reason"]) =>
    end((method) =>
      CodexOutputEnded.of(
        { reason, ...(method === undefined ? {} : { method }) },
        stderrTail,
      ),
    );
  const reader = yield* Stream.runForEach(child.stdout, onChunk).pipe(
    Effect.exit,
    Effect.flatMap((read) =>
      read._tag === "Failure"
        ? outputEnded("defect")
        : child.exited.pipe(
            Effect.timeoutOption(EXIT_GRACE),
            Effect.flatMap((exited) =>
              exited._tag === "Some" ? Effect.void : outputEnded("closed"),
            ),
          ),
    ),
    Effect.forkIn(scope),
  );
  // The exit ends the connection, whatever pipe a child of Codex may still hold open; the
  // streams get a moment to drain first, so the tail holds the program's last words.
  yield* child.exited.pipe(
    Effect.tap(() =>
      Effect.all([Fiber.await(reader), Fiber.await(stderr)]).pipe(
        Effect.timeoutOption("1 second"),
      ),
    ),
    Effect.flatMap((exit) =>
      end((method) =>
        CodexExited.of(
          { ...exit, ...(method === undefined ? {} : { method }) },
          stderrTail,
        ),
      ),
    ),
    Effect.forkIn(scope),
  );

  const request = <M extends Method>(
    method: M,
    ...params: ClientMethods[M]["params"] extends undefined
      ? []
      : [ClientMethods[M]["params"]]
  ) =>
    Effect.gen(function* () {
      if (state.kind === "closed") return yield* new CodexClosed({ method });
      if (state.kind === "ended") return yield* state.failure(method);
      const id = nextId++;
      const deferred = yield* Deferred.make<unknown, CodexFailure>();
      pending.set(key(id), { method, deferred });
      const written = yield* send({
        id,
        method,
        ...(params.length === 0 ? {} : { params: params[0] }),
      });
      if (!written) {
        pending.delete(key(id));
        // The refusal has just ended the connection, which TypeScript cannot see from here.
        const after = state as
          | typeof state
          | {
              readonly kind: "ended";
              readonly failure: (method: string) => CodexTermination;
            };
        return yield* after.kind === "ended"
          ? after.failure(method)
          : new CodexClosed({ method });
      }
      return (yield* Deferred.await(deferred).pipe(
        Effect.ensuring(Effect.sync(() => pending.delete(key(id)))),
      )) as ClientMethods[M]["response"];
    });

  const close = Effect.gen(function* () {
    if (state.kind !== "open") return;
    state = { kind: "closed" };
    for (const entry of pending.values())
      yield* Deferred.fail(
        entry.deferred,
        new CodexClosed({ method: entry.method }),
      );
    pending.clear();
    yield* Queue.end(notifications);
    yield* askToStop;
    yield* killIfStill;
  });
  // After a failure the program was asked to stop and a kill is waiting in the scope, which closing
  // the scope would interrupt: the finalizer waits the same stop wait itself, so the program has
  // time to stop its own children before the process service kills it.
  yield* Effect.addFinalizer(() =>
    state.kind === "open" ? close : killIfStill,
  );

  const answered = yield* request("initialize", {
    clientInfo: options.clientInfo,
    capabilities: { experimentalApi: false, requestAttestation: false },
  }).pipe(Effect.timeoutOption(options.handshakeTimeout ?? "30 seconds"));
  if (answered._tag === "None") {
    yield* end(() =>
      CodexExited.of({ exitCode: null, signal: null }, stderrTail),
    );
    return yield* CodexHandshakeTimeout.of(stderrTail);
  }
  yield* send({ method: "initialized" });
  return {
    initialize: answered.value,
    request,
    notifications: Stream.fromQueue(notifications),
    close,
    open: () => state.kind === "open",
  } satisfies CodexConnection as CodexConnection;
});
