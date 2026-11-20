import { describe, expect, test } from "bun:test";
import { Effect, Fiber, Layer, Logger, Stream, type Scope } from "effect";
import {
  connect,
  INTERNAL,
  UNSUPPORTED,
  type ConnectOptions,
  type Method,
} from "../src/client.ts";
import { RELEASE } from "../src/generated/methods.ts";
import type { Recording } from "../src/recorder.ts";
import type { CodexProcess } from "../src/services.ts";
import { fake, replay, type Fake } from "./replay.ts";

const options = (overrides: Partial<ConnectOptions> = {}): ConnectOptions => ({
  program: "codex",
  args: [],
  env: {},
  cwd: "/",
  clientInfo: { name: "neuve-test", title: null, version: "0" },
  answer: () => Effect.succeed({ result: {} }),
  ...overrides,
});
const answerHandshake = (message: Record<string, unknown>, io: Fake) => {
  if (message.method === "initialize")
    io.send({
      id: message.id,
      result: {
        userAgent: "neuve-test/0.0.0",
        codexHome: "/codex-home",
        platformFamily: "unix",
        platformOs: "macos",
      },
    });
};
const run = <A, E>(
  layer: Layer.Layer<CodexProcess>,
  body: Effect.Effect<A, E, CodexProcess | Scope.Scope>,
  logs?: Array<string>,
) =>
  Effect.runPromise(
    Effect.scoped(body).pipe(
      Effect.provide(layer),
      Effect.provide(
        Logger.layer(
          logs === undefined
            ? []
            : [
                Logger.make(({ message }) =>
                  logs.push(String(JSON.stringify(message))),
                ),
              ],
        ),
      ),
    ),
  );
/** Waits until the client has written a message that matches, instead of guessing a delay. */
const writtenSoon = (
  io: Fake,
  match: (message: Record<string, unknown>) => boolean,
) =>
  Effect.gen(function* () {
    while (!io.written.some(match)) yield* Effect.sleep("1 millis");
  });
const fixture = async (name: string) =>
  (await Bun.file(
    new URL(`./fixtures/${name}`, import.meta.url),
  ).json()) as Recording;

/** Sends each recorded request of a fixture again, in order, keeping the answers by method. */
const drive = (recording: Recording) =>
  Effect.gen(function* () {
    const connection = yield* connect(options());
    const seen: Array<string> = [];
    const reader = yield* Stream.runForEach(connection.notifications, (n) =>
      Effect.sync(() => seen.push(n.method)),
    ).pipe(Effect.forkScoped);
    const answers = new Map<string, Array<unknown>>();
    for (const { direction, message } of recording.entries) {
      const { id, method, params } = message as Record<string, unknown>;
      if (direction !== "out" || id === undefined || method === "initialize")
        continue;
      const answer = yield* (
        connection.request as (m: Method, p?: unknown) => Effect.Effect<unknown>
      )(method as Method, params);
      answers.set(String(method), [
        ...(answers.get(String(method)) ?? []),
        answer,
      ]);
    }
    yield* connection.close;
    yield* Fiber.join(reader);
    return { initialize: connection.initialize, answers, seen };
  });

describe("recorded conversations with Codex", () => {
  // The real program's handshake, replayed through framing, id matching and the handshake.
  test("the handshake answers with the release the types came from", async () => {
    const played = replay(await fixture("handshake.json"));
    const { initialize, seen } = await run(
      played.layer,
      drive(await fixture("handshake.json")),
    );
    expect(played.mismatches).toEqual([]);
    expect(played.done()).toBe(true);
    expect(initialize.userAgent).toContain(`/${RELEASE} `);
    expect(played.io.written[0]).toMatchObject({
      method: "initialize",
      params: { capabilities: { experimentalApi: false } },
    });
    expect(played.io.written[1]).toEqual({ method: "initialized" });
    // remoteControl/status/changed is known to the release and unread: neither delivered nor logged.
    expect(seen).toEqual([]);
  });

  // The read-only requests under the launch configuration: the evidence PROTOCOL.md cites for
  // what the check at open can and cannot read back, replayed so the client decodes all of it.
  test("the read-only requests read back the launch configuration", async () => {
    const recording = await fixture("read-only.json");
    const played = replay(recording);
    const { answers, seen } = await run(played.layer, drive(recording));
    expect(played.mismatches).toEqual([]);
    expect(played.done()).toBe(true);
    const one = (method: string) => answers.get(method)?.[0] as any;

    const config = one("config/read");
    expect(config.layers[0].name.type).toBe("sessionFlags");
    expect(config.layers[0].config.features.shell_tool).toBe(false);
    expect(config.config.features.unified_exec).toBe(false);

    const features = (answers.get("experimentalFeature/list") as any[]).flatMap(
      (p) => p.data,
    );
    const enabled = (name: string) =>
      features.find((f) => f.name === name)?.enabled;
    // Every feature switched off on the command line reads back off, but one.
    const switchedOff = Object.entries(config.layers[0].config.features)
      .filter(([, value]) => value === false)
      .map(([name]) => name);
    expect(switchedOff.length).toBeGreaterThan(30);
    expect(switchedOff.filter((name) => enabled(name) !== false)).toEqual([
      "unified_exec",
    ]);
    expect(enabled("shell_tool")).toBe(false);
    expect(enabled("hooks")).toBe(false);
    // OpenAI's reference: "User opt-outs are ignored." The feature list says so too.
    expect(enabled("unified_exec")).toBe(true);

    expect(one("hooks/list").data[0].hooks).toEqual([]);
    const skills = one("skills/list").data[0].skills as any[];
    expect(skills.length).toBeGreaterThan(0);
    expect(skills.every((s) => !s.enabled)).toBe(true);
    const servers = one("mcpServerStatus/list").data as any[];
    expect(servers.every((s) => Object.keys(s.tools).length === 0)).toBe(true);
    expect(one("app/list").data).toEqual([]);

    const models = one("model/list").data as any[];
    expect(models.filter((m) => m.isDefault)).toHaveLength(1);
    for (const model of models) {
      expect(model.supportedReasoningEfforts.length).toBeGreaterThan(0);
      expect(typeof model.defaultReasoningEffort).toBe("string");
    }
    expect(one("account/read").account).toMatchObject({
      type: "chatgpt",
      email: "<redacted>",
    });
    expect(seen).toContain("account/updated");
  });
});

describe("each failure ends in its own typed failure", () => {
  const connected = <A, E>(
    onWrite: (message: Record<string, unknown>, io: Fake) => void,
    body: (
      connection: Effect.Success<ReturnType<typeof connect>>,
      io: Fake,
    ) => Effect.Effect<A, E, Scope.Scope>,
    overrides: Partial<ConnectOptions> = {},
    logs?: Array<string>,
  ) => {
    const played = fake((message, io) => {
      answerHandshake(message, io);
      onWrite(message, io);
    });
    return run(
      played.layer,
      connect(options(overrides)).pipe(
        Effect.flatMap((connection) => body(connection, played.io)),
      ),
      logs,
    ).then((value) => ({ value, io: played.io }));
  };
  const onRequest =
    (
      method: string,
      reply: (message: Record<string, unknown>, io: Fake) => void,
    ) =>
    (message: Record<string, unknown>, io: Fake) => {
      if (message.method === method) reply(message, io);
    };

  // A line that is not JSON: the stream cannot be trusted after it, so the request and the
  // notifications end with the failure instead of waiting forever.
  test("a malformed line", async () => {
    const { value } = await connected(
      onRequest("model/list", (_, io) => io.emit("not json\n")),
      (c) =>
        Effect.all([
          Effect.flip(c.request("model/list", {})),
          Effect.flip(Stream.runDrain(c.notifications)),
        ]),
    );
    expect(value[0]).toMatchObject({
      _tag: "CodexMalformedLine",
      reason: "json",
    });
    expect(value[1]).toMatchObject({
      _tag: "CodexMalformedLine",
      reason: "json",
    });
  });

  // JSON that is no message: a response with neither result nor error must not pass as success.
  test("a message of no known shape", async () => {
    const { value } = await connected(
      onRequest("model/list", (message, io) => io.send({ id: message.id })),
      (c) => Effect.flip(c.request("model/list", {})),
    );
    expect(value).toMatchObject({
      _tag: "CodexMalformedLine",
      reason: "shape",
    });
  });

  // The limit is enforced before more of the line is buffered: the newline never arrives here.
  test("an oversized line", async () => {
    const { value, io } = await connected(
      onRequest("model/list", (_, io) => {
        io.emit("x".repeat(150));
        io.emit("x".repeat(150));
      }),
      (c) => Effect.flip(c.request("model/list", {})),
      { maxLineBytes: 256 },
    );
    expect(value).toMatchObject({ _tag: "CodexOversizedLine", limit: 256 });
    expect(io.exited()).toBe(true);
  });

  // A newer Codex may send notifications this release does not have: logged once, then ignored,
  // and the connection carries on.
  test("an unknown notification", async () => {
    const logs: Array<string> = [];
    const { value } = await connected(
      onRequest("model/list", (message, io) => {
        io.send({ method: "future/thing", params: {} });
        io.send({ method: "future/thing", params: {} });
        io.send({ id: message.id, result: { data: [], nextCursor: null } });
      }),
      (c) => c.request("model/list", {}),
      {},
      logs,
    );
    expect(value).toEqual({ data: [], nextCursor: null });
    expect(logs.filter((line) => line.includes("future/thing"))).toHaveLength(
      1,
    );
    expect(logs[0]).toContain("CodexUnknownMessage");
  });

  // An unknown request is answered, so Codex never waits on it, and logged once.
  test("an unknown request", async () => {
    const logs: Array<string> = [];
    const { io } = await connected(
      onRequest("model/list", (message, io) => {
        io.send({ id: "s1", method: "future/ask", params: {} });
        io.send({ id: message.id, result: { data: [], nextCursor: null } });
      }),
      (c, io) =>
        c
          .request("model/list", {})
          .pipe(Effect.andThen(writtenSoon(io, (m) => m.id === "s1"))),
      {},
      logs,
    );
    expect(io.written).toContainEqual({
      id: "s1",
      error: { code: UNSUPPORTED, message: "unsupported request" },
    });
    expect(logs.filter((line) => line.includes("future/ask"))).toHaveLength(1);
  });

  // A known request is answered by the caller, echoing Codex's id with its type.
  test("a request from Codex is answered by the caller", async () => {
    const { io } = await connected(
      onRequest("model/list", (message, io) => {
        io.send({
          id: 7,
          method: "item/commandExecution/requestApproval",
          params: { threadId: "t", turnId: "u", itemId: "i" },
        });
        io.send({ id: message.id, result: { data: [], nextCursor: null } });
      }),
      (c, io) =>
        c
          .request("model/list", {})
          .pipe(Effect.andThen(writtenSoon(io, (m) => m.id === 7))),
      {
        answer: (request) =>
          Effect.succeed({
            result: {
              decision:
                request.method === "item/commandExecution/requestApproval"
                  ? "decline"
                  : "accept",
            },
          }),
      },
    );
    expect(io.written).toContainEqual({
      id: 7,
      result: { decision: "decline" },
    });
  });

  // Codex refusing a request is the caller's to handle, with Codex's code and message.
  test("a request answered with an error", async () => {
    const { value } = await connected(
      onRequest("thread/read", (message, io) =>
        io.send({
          id: message.id,
          error: {
            code: -32600,
            message: "no such thread",
            data: { type: "threadNotFound", detail: "kept out" },
          },
        }),
      ),
      (c) => Effect.flip(c.request("thread/read", { threadId: "missing" })),
    );
    expect(value).toMatchObject({
      _tag: "CodexRequestFailed",
      method: "thread/read",
      code: -32600,
      message: "no such thread",
      type: "threadNotFound",
    });
  });

  // The process dying under a pending request fails it with the exit and the stderr tail.
  test("the process exits mid-request", async () => {
    const { value } = await connected(
      onRequest("model/list", (_, io) => {
        io.stderr("panicked: boom\n");
        io.exit({ exitCode: 101 });
      }),
      (c) => Effect.flip(c.request("model/list", {})),
    );
    expect(value).toMatchObject({
      _tag: "CodexExited",
      method: "model/list",
      exitCode: 101,
    });
    expect((value as { stderrTail: string }).stderrTail).toContain("boom");
  });

  // A child of Codex can hold a pipe open after Codex itself has gone: the exit still ends it.
  test("the process exits while its error stream stays open", async () => {
    const { value } = await connected(
      onRequest("model/list", (_, io) =>
        io.exit({ exitCode: 1 }, { stderrOpen: true }),
      ),
      (c) => Effect.flip(c.request("model/list", {})),
    );
    expect(value).toMatchObject({ _tag: "CodexExited", exitCode: 1 });
  });

  // A program that never answers the handshake is stopped, not waited on.
  test("a handshake that never answers", async () => {
    const played = fake(() => {});
    // Seen inside the scope, before its finalizer could stop the program instead.
    const { failure, stops } = await run(
      played.layer,
      Effect.flip(connect(options({ handshakeTimeout: "30 millis" }))).pipe(
        Effect.map((failure) => ({ failure, stops: [...played.io.stops] })),
      ),
    );
    expect(failure).toMatchObject({ _tag: "CodexHandshakeTimeout" });
    expect(stops).toEqual(["input", "SIGTERM"]);
  });

  // After close nothing more is written: a pending request and a later one both fail closed.
  test("a write after close", async () => {
    const { value, io } = await connected(
      () => {},
      (c) =>
        Effect.gen(function* () {
          const pending = yield* Effect.forkScoped(
            Effect.flip(c.request("model/list", {})),
          );
          yield* Effect.yieldNow;
          yield* c.close;
          const later = yield* Effect.flip(c.request("model/list", {}));
          return [yield* Fiber.join(pending), later];
        }),
    );
    expect(value[0]).toMatchObject({
      _tag: "CodexClosed",
      method: "model/list",
    });
    expect(value[1]).toMatchObject({
      _tag: "CodexClosed",
      method: "model/list",
    });
    expect(io.written.filter((m) => m.method === "model/list")).toHaveLength(1);
  });

  // Responses are matched by id whatever their order; notifications keep theirs.
  test("responses by id, notifications in order", async () => {
    const held: Array<Record<string, unknown>> = [];
    const { value } = await connected(
      (message, io) => {
        if (message.method !== "model/list" && message.method !== "thread/read")
          return;
        held.push(message);
        if (held.length < 2) return;
        io.send({ method: "turn/started", params: { n: 1 } });
        io.send({ method: "item/agentMessage/delta", params: { n: 2 } });
        io.send({ method: "item/agentMessage/delta", params: { n: 3 } });
        for (const request of held.reverse())
          io.send({ id: request.id, result: { for: request.method } });
      },
      (c) =>
        Effect.gen(function* () {
          const [models, thread] = yield* Effect.all(
            [
              c.request("model/list", {}),
              c.request("thread/read", { threadId: "t" }),
            ],
            { concurrency: "unbounded" },
          );
          const order = yield* c.notifications.pipe(
            Stream.take(3),
            Stream.runCollect,
          );
          return {
            models,
            thread,
            order: [...order].map(
              (n) => (n.params as unknown as { n: number }).n,
            ),
          };
        }),
    );
    expect(value.models as unknown).toEqual({ for: "model/list" });
    expect(value.thread as unknown).toEqual({ for: "thread/read" });
    expect(value.order).toEqual([1, 2, 3]);
  });
});

describe("framing: a line is a line however the pipe cuts it", () => {
  const line = (message: unknown) => `${JSON.stringify(message)}\n`;
  const page = { data: [], nextCursor: null };
  const answered = (
    reply: (id: unknown, io: Fake) => void,
    logs?: Array<string>,
  ) => {
    const played = fake((message, io) => {
      answerHandshake(message, io);
      if (message.method === "model/list") reply(message.id, io);
    });
    return run(
      played.layer,
      connect(options()).pipe(
        Effect.flatMap((c) =>
          c.request("model/list", {}).pipe(Effect.map((v) => v as unknown)),
        ),
      ),
      logs,
    );
  };

  // A message cut into three chunks: the parts buffered before the newline must be kept.
  test("a message split across chunks", async () => {
    const text = line({ id: 1, result: page });
    expect(
      await answered((_, io) => {
        io.emit(text.slice(0, 5));
        io.emit(text.slice(5, 20));
        io.emit(text.slice(20));
      }),
    ).toEqual(page);
  });

  // A cut inside a character: lines are split on bytes and decoded whole, so it survives.
  test("a multi-byte character split across chunks", async () => {
    const bytes = new TextEncoder().encode(
      line({ id: 1, result: { text: "café ✓" } }),
    );
    const cut = bytes.indexOf(0xc3) + 1;
    expect(
      await answered((_, io) => {
        io.emitBytes(bytes.subarray(0, cut));
        io.emitBytes(bytes.subarray(cut));
      }),
    ).toEqual({ text: "café ✓" });
  });

  // Two messages in one chunk: the rest of a chunk after its first line must not be dropped.
  test("two messages in one chunk", async () => {
    const played = fake((message, io) => {
      answerHandshake(message, io);
      if (message.method === "model/list")
        io.emit(
          line({ method: "turn/started", params: { n: 1 } }) +
            line({ id: message.id, result: page }),
        );
    });
    const value = await run(
      played.layer,
      connect(options()).pipe(
        Effect.flatMap((c) =>
          Effect.all([
            c.request("model/list", {}),
            c.notifications.pipe(Stream.take(1), Stream.runCollect),
          ]),
        ),
      ),
    );
    expect(value[0] as unknown).toEqual(page);
    expect([...value[1]].map((n) => n.method)).toEqual(["turn/started"]);
  });

  // A program writing CRLF line endings is still read.
  test("a CRLF line ending", async () => {
    expect(
      await answered((id, io) =>
        io.emit(`${JSON.stringify({ id, result: page })}\r\n`),
      ),
    ).toEqual(page);
  });

  // Blank lines carry nothing and end nothing.
  test("an empty line", async () => {
    expect(
      await answered((id, io) =>
        io.emit(`\n  \n${line({ id, result: page })}`),
      ),
    ).toEqual(page);
  });

  // The id is matched with its type: Codex echoes ours, so a string "1" is not the number 1.
  test("string and numeric ids are kept apart", async () => {
    expect(
      await answered((id, io) => {
        io.send({ id: String(id), result: "string" });
        io.send({ id, result: "number" });
      }),
    ).toBe("number");
  });

  // A response to no pending request is logged once and changes nothing.
  test("a response to an unknown id", async () => {
    const logs: Array<string> = [];
    expect(
      await answered((id, io) => {
        io.send({ id: 999, result: {} });
        io.send({ id: 998, result: {} });
        io.send({ id, result: page });
      }, logs),
    ).toEqual(page);
    expect(logs.filter((l) => l.includes("no-pending-request"))).toHaveLength(
      1,
    );
  });
});

describe("the client's own failures stay contained", () => {
  // If the caller's answer fails, Codex still gets an answer and the turn does not stall.
  test("a caller's answer that dies is answered as an internal error", async () => {
    const played = fake((message, io) => {
      answerHandshake(message, io);
      if (message.method === "model/list") {
        io.send({ id: 7, method: "item/tool/requestUserInput", params: {} });
        io.send({ id: message.id, result: { data: [], nextCursor: null } });
      }
    });
    await run(
      played.layer,
      connect(options({ answer: () => Effect.die("boom") })).pipe(
        Effect.flatMap((c) => c.request("model/list", {})),
        Effect.andThen(writtenSoon(played.io, (m) => m.id === 7)),
      ),
    );
    expect(played.io.written).toContainEqual({
      id: 7,
      error: { code: INTERNAL, message: "the client could not answer" },
    });
  });

  // Input refused while the program still runs fails the request now, not at some later exit.
  test("a request whose write is refused", async () => {
    const played = fake((message, io) => answerHandshake(message, io));
    const failure = await run(
      played.layer,
      connect(options()).pipe(
        Effect.tap(() => Effect.sync(() => played.io.refuseInput())),
        Effect.flatMap((c) => Effect.flip(c.request("model/list", {}))),
      ),
    );
    expect(failure).toMatchObject({
      _tag: "CodexClosed",
      method: "model/list",
    });
    expect(played.io.stops).toEqual(["input", "SIGTERM"]);
  });

  // After an internal failure the client asks the program to stop and returns at once; a program
  // that ignores that request must still be killed after the wait, or it outlives the client.
  test("a program that ignores the stop request is killed after the wait", async () => {
    const played = fake((message, io) => {
      answerHandshake(message, io);
      if (message.method === "model/list") {
        io.ignoreTerm();
        io.emit("not json\n");
      }
    });
    const stops = await run(
      played.layer,
      connect(options({ stopWait: "20 millis" })).pipe(
        Effect.flatMap((c) => Effect.flip(c.request("model/list", {}))),
        Effect.andThen(
          Effect.gen(function* () {
            while (!played.io.stops.includes("SIGKILL"))
              yield* Effect.sleep("2 millis");
          }).pipe(Effect.timeout("2 seconds")),
        ),
        Effect.map(() => [...played.io.stops]),
      ),
    );
    expect(stops).toEqual(["input", "SIGTERM", "SIGKILL"]);
  });

  // Close asks the program to stop before it is killed, so Codex can stop its own children.
  test("close ends input, then asks the program to stop", async () => {
    const played = fake((message, io) => answerHandshake(message, io));
    await run(
      played.layer,
      connect(options()).pipe(Effect.flatMap((c) => c.close)),
    );
    expect(played.io.stops).toEqual(["input", "SIGTERM"]);
  });

  // The standard-error tail may hold anything the program printed: it is redacted, and left out
  // of anything that serialises the failure.
  test("the error tail is redacted and not serialised", async () => {
    const played = fake((message, io) => {
      answerHandshake(message, io);
      if (message.method === "model/list") {
        io.stderr("signed in as a@b.co, home /Users/someone/.codex\n");
        io.exit({ exitCode: 1 });
      }
    });
    const failure = await run(
      played.layer,
      connect(options()).pipe(
        Effect.flatMap((c) => Effect.flip(c.request("model/list", {}))),
      ),
    );
    expect(failure).toMatchObject({ _tag: "CodexExited", exitCode: 1 });
    const tail = (failure as { stderrTail: string }).stderrTail;
    expect(tail).toContain("<email>");
    expect(tail).toContain("<path>");
    expect(tail).not.toContain("a@b.co");
    expect(JSON.stringify(failure)).not.toContain("signed in");
  });
});
