import { expect, test } from "bun:test";
import type {
  ModelInfo,
  Options,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  Account,
  AccountProbe,
  RuntimeEvent,
  TurnLimit,
  type SessionPolicy,
} from "@neuve/runtime";
import { Effect, Layer, Queue, Stream } from "effect";
import { makeRuntime } from "../src/runtime.ts";
import {
  ClaudeExecutable,
  ClaudeProcess,
  ClaudeSdk,
  ClaudeSdkError,
} from "../src/services.ts";
import { assistant, result, usage } from "./frames.ts";

const account = Account.parse({
  name: "test",
  kind: "claude-subscription",
  runtime: "claude-code",
  credential: { kind: "claude-config-folder" },
});
const policy: SessionPolicy = {
  systemPrompt: "fixture",
  tools: [],
  approvalPolicy: "allow",
  turnLimit: TurnLimit.parse(8),
  outputSchema: { type: "object" },
};
const row = (value: string, fields: Partial<ModelInfo> = {}): ModelInfo => ({
  value,
  displayName: value,
  description: "fixture",
  ...fields,
});
const levels = ["low", "medium", "high", "xhigh", "max"] as const;
const refusal = {
  _tag: "TurnFailed",
  account: "test",
  reason: "protocol-error",
};
function run(
  body: (
    f: Effect.Success<ReturnType<typeof fixture>>,
  ) => Effect.Effect<void, unknown, import("effect").Scope.Scope>,
  config: Parameters<typeof fixture>[0] = {},
) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* body(yield* fixture(config));
      }),
    ).pipe(Effect.timeout("3 seconds")),
  );
}
function fixture(
  config: {
    lists?: unknown[];
    initFail?: boolean;
    installed?: boolean;
    modelsFail?: boolean;
  } = {},
) {
  return Effect.gen(function* () {
    const children: Array<{
      options: Options;
      frames: Queue.Queue<SDKMessage>;
      closed: boolean;
    }> = [];
    const sends: SDKUserMessage[] = [];
    const controls: unknown[] = [];
    const layer = Layer.mergeAll(
      Layer.succeed(ClaudeExecutable, {
        resolve: () =>
          Effect.succeed(
            config.installed === false ? undefined : "/test/claude",
          ),
      }),
      Layer.succeed(ClaudeProcess, {
        run: () => Effect.die("No process allowed"),
      }),
      Layer.succeed(ClaudeSdk, {
        prefixes: { usage: [], organization: [] },
        open: (options) =>
          Effect.gen(function* () {
            const models = config.lists?.[children.length];
            const child = {
              options,
              frames: yield* Queue.unbounded<SDKMessage>(),
              closed: false,
            };
            children.push(child);
            const close = Effect.sync(() => {
              child.closed = true;
            }).pipe(Effect.andThen(Queue.shutdown(child.frames)));
            yield* Effect.addFinalizer(() => close);
            return {
              messages: Stream.fromQueue(child.frames),
              close,
              offer: (message: SDKUserMessage) =>
                Effect.sync(() => {
                  sends.push(message);
                }),
              interrupt: Effect.void,
              setModel: (model?: string) =>
                Effect.sync(() => {
                  controls.push(["model", model]);
                }),
              applyFlagSettings: (
                settings: Parameters<
                  import("../src/services.ts").QuerySession["applyFlagSettings"]
                >[0],
              ) =>
                Effect.sync(() => {
                  controls.push(["flags", settings]);
                }),
              initializationResult: config.initFail
                ? Effect.fail(
                    new ClaudeSdkError({ method: "initializationResult" }),
                  )
                : Effect.succeed({
                    account: { tokenSource: "oauth" },
                    get models() {
                      if (config.modelsFail)
                        throw new Error("model list unavailable");
                      return models;
                    },
                  }),
            };
          }),
      }),
    );
    const runtime = yield* makeRuntime({ cwd: "/test", environment: {} }).pipe(
      Effect.provide(layer),
    );
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        expect(children.every((child) => child.closed)).toBe(true);
      }),
    );
    const open = (
      model?: SessionPolicy["model"],
      start: Parameters<typeof runtime.openSession>[2] = { kind: "new" },
    ) =>
      Effect.gen(function* () {
        const s = yield* runtime.openSession(
          account,
          { ...policy, ...(model === undefined ? {} : { model }) },
          start,
        );
        const events: RuntimeEvent[] = [];
        const queue = yield* Queue.unbounded<RuntimeEvent>();
        yield* Stream.runForEach(s.events, (event) =>
          Effect.sync(() => {
            RuntimeEvent.parse(event);
            events.push(event);
            Queue.offerUnsafe(queue, event);
          }),
        ).pipe(Effect.forkScoped);
        const next = (
          type: RuntimeEvent["type"],
        ): Effect.Effect<RuntimeEvent> =>
          Effect.gen(function* () {
            while (true) {
              const event = yield* Queue.take(queue);
              if (event.type === type) return event;
            }
          });
        return { s, events, next };
      });
    const send = (frames: SDKMessage[]) =>
      Effect.forEach(
        frames,
        (frame) => Queue.offer(children.at(-1)!.frames, frame),
        { discard: true },
      );
    return { runtime, children, sends, controls, open, send };
  });
}

test("R14 probe maps rows, filters future effort, drops invalid rows and puts default first without prompts", () =>
  run(
    (f) =>
      Effect.gen(function* () {
        const probe = AccountProbe.parse(yield* f.runtime.probe(account));
        expect(probe.signIn.state).toBe("signed-in");
        expect(probe.models).toEqual([
          {
            id: "default",
            displayName: "Default",
            description: "fixture",
            resolvedModel: "wire",
            supportsEffort: true,
            supportedEffortLevels: ["low", "max"],
          },
          { id: "second", displayName: "second", description: "fixture" },
          {
            id: "third",
            displayName: "third",
            description: "fixture",
            supportsEffort: false,
          },
        ]);
        expect(f.sends).toEqual([]);
      }),
    {
      lists: [
        [
          row("second"),
          {
            ...row("default", {
              displayName: "Default",
              resolvedModel: "wire",
              supportsEffort: true,
              supportsFastMode: true,
            }),
            supportedEffortLevels: ["low", "future", "max"],
          },
          row(""),
          null,
          { value: "bad" },
          row("third", { supportsEffort: false }),
        ],
      ],
    },
  ));
for (const list of [undefined, null, "unreadable"])
  test(`R14 unavailable model list ${String(list)} preserves sign-in`, () =>
    run(
      (f) =>
        Effect.gen(function* () {
          const probe = yield* f.runtime.probe(account);
          expect(probe.signIn.state).toBe("signed-in");
          expect(probe).not.toHaveProperty("models");
          expect(f.sends).toEqual([]);
        }),
      { lists: [list] },
    ));
test("R14 probe preserves SDK ordering without a default row", () =>
  run(
    (f) =>
      Effect.gen(function* () {
        expect(
          AccountProbe.parse(yield* f.runtime.probe(account)).models?.map(
            (m) => m.id,
          ),
        ).toEqual(["b", "a"]);
      }),
    { lists: [[row("b"), row("a")]] },
  ));
for (const config of [{ installed: false }, { initFail: true }])
  test(`R14 unavailable or failed probe has no models ${JSON.stringify(config)}`, () =>
    run(
      (f) =>
        Effect.gen(function* () {
          const probe = yield* f.runtime.probe(account);
          expect(probe.signIn.state).toBe(
            config.installed === false ? "runtime-unavailable" : "unknown",
          );
          expect(probe).not.toHaveProperty("models");
        }),
      config,
    ));

test("R14 default selection omits SDK model at open, switch and final reopen", () =>
  run((f) =>
    Effect.gen(function* () {
      const { s, next } = yield* f.open({ id: "default" });
      expect(f.children[0]!.options).not.toHaveProperty("model");
      expect(f.children[0]!.options).not.toHaveProperty("effort");
      yield* s.setModel({ id: "default" });
      expect(f.controls).toEqual([
        ["model", undefined],
        ["flags", { effortLevel: null }],
      ]);
      yield* s.startTurn({ turnId: "one", message: "fixture", final: true });
      expect(f.children[1]!.options).not.toHaveProperty("model");
      expect(f.children[1]!.options).not.toHaveProperty("effort");
      yield* f.send([result({ structured_output: {} })]);
      yield* next("turn.finished");
    }),
  ));
for (const effort of levels)
  test(`R14 supported ${effort} effort passes at open and switch`, () =>
    run(
      (f) =>
        Effect.gen(function* () {
          const { s } = yield* f.open({ id: "alias", effort });
          expect(f.children[0]!.options.effort).toBe(effort);
          yield* s.setModel({ id: "wire", effort });
          expect(f.controls).toEqual([
            ["model", "wire"],
            ["flags", { effortLevel: effort }],
          ]);
        }),
      {
        lists: [
          [
            row("alias", {
              resolvedModel: "wire",
              supportsEffort: true,
              supportedEffortLevels: [...levels],
            }),
          ],
        ],
      },
    ));
for (const supportsEffort of [false, undefined])
  test(`R14 non-effort model ${String(supportsEffort)} clears policy and switch effort`, () =>
    run(
      (f) =>
        Effect.gen(function* () {
          const { s, next } = yield* f.open({ id: "plain", effort: "max" });
          expect(f.controls).toEqual([["flags", { effortLevel: null }]]);
          yield* s.startTurn({ turnId: "one", message: "fixture" });
          yield* f.send([result()]);
          yield* next("turn.finished");
          yield* s.setModel({ id: "plain", effort: "high" });
          expect(f.controls.slice(1)).toEqual([
            ["model", "plain"],
            ["flags", { effortLevel: null }],
          ]);
          yield* s.startTurn({
            turnId: "two",
            message: "fixture",
            final: true,
          });
          expect(f.children[1]!.options).not.toHaveProperty("effort");
          yield* f.send([result({ structured_output: {} })]);
          yield* next("turn.finished");
        }),
      {
        lists: [
          [
            row(
              "plain",
              supportsEffort === undefined ? {} : { supportsEffort },
            ),
          ],
          [
            row(
              "plain",
              supportsEffort === undefined ? {} : { supportsEffort },
            ),
          ],
        ],
      },
    ));
test("R14 unsupported switch effort refuses before controls and keeps saved selection", () =>
  run(
    (f) =>
      Effect.gen(function* () {
        const { s, next } = yield* f.open({ id: "alias", effort: "low" });
        expect(
          yield* s.setModel({ id: "wire", effort: "max" }).pipe(Effect.flip),
        ).toMatchObject(refusal);
        expect(f.controls).toEqual([]);
        yield* s.startTurn({ turnId: "one", message: "fixture", final: true });
        expect(f.children[1]!.options).toMatchObject({
          model: "alias",
          effort: "low",
        });
        yield* f.send([result({ structured_output: {} })]);
        yield* next("turn.finished");
      }),
    {
      lists: [
        [
          row("alias", {
            resolvedModel: "wire",
            supportsEffort: true,
            supportedEffortLevels: ["low"],
          }),
        ],
      ],
    },
  ));
test("R14 unsupported policy effort fails the turn with protocol-error before any prompt", () =>
  run(
    (f) =>
      Effect.gen(function* () {
        const { s, next } = yield* f.open({ id: "alias", effort: "max" });
        expect(
          yield* s
            .startTurn({ turnId: "one", message: "fixture" })
            .pipe(Effect.flip),
        ).toMatchObject(refusal);
        expect(yield* next("turn.finished")).toMatchObject({
          outcome: { status: "failed", failure: refusal },
        });
        expect(f.sends).toEqual([]);
        expect(f.controls).toEqual([]);
        yield* s.setModel({ id: "alias", effort: "low" });
        yield* s.startTurn({ turnId: "two", message: "fixture" });
        yield* f.send([result()]);
        yield* next("turn.finished");
      }),
    {
      lists: [
        [
          row("alias", {
            supportsEffort: true,
            supportedEffortLevels: ["low"],
          }),
        ],
      ],
    },
  ));
for (const lists of [undefined, [[row("other", { supportsEffort: false })]]])
  test(`R14 unknown model or list sends requested effort ${lists === undefined}`, () =>
    run(
      (f) =>
        Effect.gen(function* () {
          const { s } = yield* f.open({ id: "unlisted", effort: "xhigh" });
          expect(f.children[0]!.options.effort).toBe("xhigh");
          yield* s.setModel({ id: "unlisted", effort: "max" });
          expect(f.controls).toEqual([
            ["model", "unlisted"],
            ["flags", { effortLevel: "max" }],
          ]);
        }),
      lists === undefined ? {} : { lists },
    ));
test("R14 child initialization replaces the session list", () =>
  run(
    (f) =>
      Effect.gen(function* () {
        const { s, next } = yield* f.open();
        yield* s.startTurn({ turnId: "one", message: "fixture", final: true });
        yield* f.send([result({ structured_output: {} })]);
        yield* next("turn.finished");
        expect(
          yield* s.setModel({ id: "model", effort: "max" }).pipe(Effect.flip),
        ).toMatchObject(refusal);
        expect(f.controls).toEqual([]);
      }),
    {
      lists: [
        [
          row("model", {
            supportsEffort: true,
            supportedEffortLevels: ["max"],
          }),
        ],
        [
          row("model", {
            supportsEffort: true,
            supportedEffortLevels: ["low"],
          }),
        ],
      ],
    },
  ));

test("R14 limits appear on result usage and stay per model before later results", () =>
  run((f) =>
    Effect.gen(function* () {
      const { s, events, next } = yield* f.open();
      yield* s.startTurn({ turnId: "one", message: "fixture" });
      const first = assistant(undefined);
      first.message.model = "a";
      yield* f.send([
        first,
        result({
          modelUsage: {
            a: { ...usage(10), contextWindow: 200000, maxOutputTokens: 32000 },
            b: { ...usage(5), contextWindow: 1000000, maxOutputTokens: 64000 },
          },
        }),
      ]);
      yield* next("turn.finished");
      expect(
        events
          .filter((e) => e.type === "usage")
          .map((e) => [e.model, e.contextWindow, e.maxOutputTokens]),
      ).toEqual([
        ["a", 200000, 32000],
        ["b", 1000000, 64000],
      ]);
      yield* s.startTurn({ turnId: "two", message: "fixture" });
      const a = assistant(undefined);
      a.message.id = "later-a";
      a.message.model = "a";
      const b = assistant(undefined);
      b.message.id = "later-b";
      b.message.model = "b";
      yield* f.send([
        a,
        b,
        {
          type: "rate_limit_event",
          uuid: crypto.randomUUID(),
          session_id: s.nativeSessionId,
          rate_limit_info: { status: "allowed" },
        },
      ]);
      yield* next("rate-limit");
      yield* s.interruptTurn({ turnId: "two" });
      yield* next("turn.finished");
      expect(
        events
          .filter((e) => e.type === "usage")
          .filter((e) => e.turnId === "two")
          .map((e) => [e.model, e.contextWindow, e.maxOutputTokens]),
      ).toEqual([
        ["a", 200000, 32000],
        ["b", 1000000, 64000],
      ]);
      for (const e of events)
        if (e.type === "usage") {
          expect(e.usage).not.toHaveProperty("contextWindow");
          expect(e.usage).not.toHaveProperty("maxOutputTokens");
        }
    }),
  ));
for (const figures of [
  { contextWindow: 0, maxOutputTokens: -1 },
  { contextWindow: 1.5, maxOutputTokens: Infinity },
  {},
])
  test(`R14 invalid or absent limits omitted ${JSON.stringify(figures)}`, () =>
    run((f) =>
      Effect.gen(function* () {
        const { s, events, next } = yield* f.open();
        yield* s.startTurn({ turnId: "one", message: "fixture" });
        const { contextWindow: _c, maxOutputTokens: _m, ...counts } = usage(1);
        const frame = JSON.parse(JSON.stringify(result()));
        frame.modelUsage = { a: { ...counts, ...figures } };
        yield* f.send([frame]);
        yield* next("turn.finished");
        const totals = events.filter((e) => e.type === "usage");
        expect(totals).toHaveLength(1);
        expect(totals[0]).not.toHaveProperty("contextWindow");
        expect(totals[0]).not.toHaveProperty("maxOutputTokens");
      }),
    ));

test("R14 reading the model list can fail without changing sign-in", () =>
  run(
    (f) =>
      Effect.gen(function* () {
        const probe = yield* f.runtime.probe(account);
        expect(probe.signIn.state).toBe("signed-in");
        expect(probe).not.toHaveProperty("models");
      }),
    { modelsFail: true },
  ));
test("R14 absent effort sends no open effort and clears a previous switch effort", () =>
  run(
    (f) =>
      Effect.gen(function* () {
        const { s } = yield* f.open({ id: "model" });
        expect(f.children[0]!.options).not.toHaveProperty("effort");
        expect(f.controls).toEqual([]);
        yield* s.setModel({ id: "model", effort: "max" });
        yield* s.setModel({ id: "model" });
        expect(f.controls).toEqual([
          ["model", "model"],
          ["flags", { effortLevel: "max" }],
          ["model", "model"],
          ["flags", { effortLevel: null }],
        ]);
      }),
    {
      lists: [
        [
          row("model", {
            supportsEffort: true,
            supportedEffortLevels: [...levels],
          }),
        ],
      ],
    },
  ));
test("R14 a changed child list refuses the saved policy before its next prompt", () =>
  run(
    (f) =>
      Effect.gen(function* () {
        const { s, next } = yield* f.open({ id: "model", effort: "low" });
        expect(
          yield* s
            .startTurn({ turnId: "one", message: "fixture", final: true })
            .pipe(Effect.flip),
        ).toMatchObject(refusal);
        expect(f.sends).toEqual([]);
        expect(yield* next("turn.finished")).toMatchObject({
          outcome: { failure: refusal },
        });
      }),
    {
      lists: [
        [
          row("model", {
            supportsEffort: true,
            supportedEffortLevels: ["low"],
          }),
        ],
        [
          row("model", {
            supportsEffort: true,
            supportedEffortLevels: ["high"],
          }),
        ],
      ],
    },
  ));
test("R14 usage before the first result has no model limits", () =>
  run((f) =>
    Effect.gen(function* () {
      const { s, events, next } = yield* f.open();
      yield* s.startTurn({ turnId: "one", message: "fixture" });
      yield* f.send([
        assistant(undefined),
        {
          type: "rate_limit_event",
          uuid: crypto.randomUUID(),
          session_id: s.nativeSessionId,
          rate_limit_info: { status: "allowed" },
        },
      ]);
      yield* next("rate-limit");
      yield* s.interruptTurn({ turnId: "one" });
      yield* next("turn.finished");
      const totals = events.filter((e) => e.type === "usage");
      expect(totals).toHaveLength(1);
      expect(totals[0]).not.toHaveProperty("contextWindow");
      expect(totals[0]).not.toHaveProperty("maxOutputTokens");
    }),
  ));
for (const figures of [
  { contextWindow: 200000, maxOutputTokens: 0 },
  { contextWindow: -1, maxOutputTokens: 32000 },
])
  test(`R14 each model limit validates independently ${JSON.stringify(figures)}`, () =>
    run((f) =>
      Effect.gen(function* () {
        const { s, events, next } = yield* f.open();
        yield* s.startTurn({ turnId: "one", message: "fixture" });
        yield* f.send([
          result({ modelUsage: { a: { ...usage(1), ...figures } } }),
        ]);
        yield* next("turn.finished");
        const totals = events.filter((e) => e.type === "usage");
        expect(totals).toHaveLength(1);
        if (figures.contextWindow > 0) {
          expect(totals[0]).toHaveProperty("contextWindow", 200000);
          expect(totals[0]).not.toHaveProperty("maxOutputTokens");
        } else {
          expect(totals[0]).toHaveProperty("maxOutputTokens", 32000);
          expect(totals[0]).not.toHaveProperty("contextWindow");
        }
      }),
    ));

test("R14 a new child restores requested effort when its updated row supports it", () =>
  run(
    (f) =>
      Effect.gen(function* () {
        const { s, next } = yield* f.open({ id: "model", effort: "max" });
        expect(f.controls).toEqual([["flags", { effortLevel: null }]]);
        yield* s.startTurn({ turnId: "one", message: "fixture", final: true });
        expect(f.children[1]!.options).not.toHaveProperty("effort");
        expect(f.controls).toEqual([
          ["flags", { effortLevel: null }],
          ["flags", { effortLevel: "max" }],
        ]);
        yield* f.send([result({ structured_output: {} })]);
        yield* next("turn.finished");
      }),
    {
      lists: [
        [row("model", { supportsEffort: false })],
        [
          row("model", {
            supportsEffort: true,
            supportedEffortLevels: ["max"],
          }),
        ],
      ],
    },
  ));
