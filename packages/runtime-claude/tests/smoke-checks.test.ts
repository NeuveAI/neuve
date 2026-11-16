import { expect, test } from "bun:test";
import { Effect, Stream } from "effect";
import { checkProbe, checkNormalAndFinal } from "../src/smoke-checks.ts";
import { assistant, errorResult, result, usage } from "./frames.ts";
import { inbound, out, type Entry } from "./replay.ts";
import { account, runReplay } from "./smoke-fixture.ts";

// Reason: the prompt-less probe must provide a first default row with a resolved model.
for (const mode of [
  "valid",
  "absent",
  "empty",
  "not-first",
  "unresolved",
] as const) {
  test(`smoke probe: ${mode}`, async () => {
    const row = {
      value: "default",
      resolvedModel: "test-model",
      displayName: "fixture",
      description: "fixture",
    };
    const counts = await runReplay(
      [
        out({
          type: "query.open",
          models:
            mode === "absent"
              ? undefined
              : mode === "empty"
                ? []
                : [
                    {
                      ...row,
                      ...(mode === "unresolved"
                        ? { resolvedModel: undefined }
                        : {}),
                    },
                  ],
          check: (options) => {
            expect(options.model).toBeUndefined();
            expect(options.persistSession).toBe(false);
          },
        }),
        out({ type: "query.close" }),
      ],
      (runtime) =>
        checkProbe(
          {
            ...runtime,
            probe: (account) =>
              runtime.probe(account).pipe(
                Effect.map((probe) =>
                  mode === "not-first"
                    ? {
                        ...probe,
                        models: [
                          {
                            id: "other",
                            displayName: "fixture",
                            description: "fixture",
                          },
                          ...(probe.models ?? []),
                        ],
                      }
                    : probe,
                ),
              ),
          },
          account,
        ),
    );
    expect(counts.counts).toEqual({
      modelsPresent: mode !== "absent" && mode !== "empty",
      defaultFirst: !["absent", "empty", "not-first"].includes(mode),
      resolvedModelPresent: mode === "valid",
      rows:
        mode === "absent" || mode === "empty"
          ? 0
          : mode === "not-first"
            ? 2
            : 1,
      requests: 0,
      withinPlan: true,
    });
  });
}

// Reason: each acceptance check must reject an independent bad observation from an unpinned run.
for (const mode of [
  "valid",
  "normal-failed",
  "final-failed",
  "invalid-output",
  "missing-output",
  "default-mismatch",
  "models-disagree",
  "model-absent",
  "context-missing",
  "output-limit-missing",
  "usage-missing",
  "protocol-error",
] as const) {
  test(`smoke normal and final: ${mode}`, async () => {
    const normal = assistant(undefined);
    normal.message.id = "normal";
    const final = assistant(undefined);
    final.message.id = "final";
    if (mode === "models-disagree") final.message.model = "different-model";
    const modelUsage =
      mode === "usage-missing"
        ? {}
        : {
            "test-model": {
              ...usage(10),
              contextWindow: mode === "context-missing" ? 0 : 1000,
              maxOutputTokens: mode === "output-limit-missing" ? 0 : 100,
            },
          };
    const entries: Entry[] = [
      out({
        type: "query.open",
        check: (options) => expect(options.model).toBeUndefined(),
      }),
      out({ type: "prompt.offer", message: "Reply briefly." }),
      inbound(normal),
      ...(mode === "protocol-error"
        ? [
            inbound({
              type: "stream_event",
              parent_tool_use_id: null,
              uuid: crypto.randomUUID(),
              session_id: normal.session_id,
              event: { type: "message_stop" },
            }),
            inbound(normal),
          ]
        : []),
      ...(mode === "protocol-error"
        ? []
        : [
            inbound(
              mode === "normal-failed"
                ? errorResult("error_max_turns", { modelUsage })
                : result({ modelUsage }),
            ),
          ]),
      out({ type: "query.close" }),
      ...(mode === "protocol-error"
        ? []
        : [
            out({
              type: "query.open",
              check: (options) => {
                expect(options.model).toBeUndefined();
                expect(options.outputFormat?.type).toBe("json_schema");
              },
            }),
            out({ type: "prompt.offer", message: "Return ok as true." }),
            inbound(final),
            inbound(
              mode === "final-failed"
                ? errorResult("error_max_turns", { modelUsage })
                : result({
                    modelUsage,
                    structured_output:
                      mode === "missing-output"
                        ? undefined
                        : mode === "invalid-output"
                          ? { ok: "true" }
                          : { ok: true },
                  }),
            ),
            out({ type: "query.close" }),
          ]),
    ];
    const counts = await runReplay(entries, (runtime) =>
      checkNormalAndFinal(
        {
          ...runtime,
          openSession: (account, policy, start) =>
            runtime.openSession(account, policy, start).pipe(
              Effect.map(
                (session) =>
                  new Proxy(session, {
                    get(target, key) {
                      return key === "events" && mode === "model-absent"
                        ? target.events.pipe(
                            Stream.map((event) =>
                              event.type === "message.finished" &&
                              event.turnId === "smoke-normal"
                                ? { ...event, model: undefined }
                                : event,
                            ),
                          )
                        : Reflect.get(target, key);
                    },
                  }),
              ),
            ),
        },
        account,
        mode === "default-mismatch" ? "different-model" : "test-model",
      ),
    );
    expect(counts.normalCompleted).toBe(
      !["normal-failed", "protocol-error"].includes(mode),
    );
    expect(counts.finalCompleted).toBe(
      !["final-failed", "missing-output", "protocol-error"].includes(mode),
    );
    expect(counts.structuredOutputParsed).toBe(
      ![
        "final-failed",
        "invalid-output",
        "missing-output",
        "protocol-error",
      ].includes(mode),
    );
    expect(counts.defaultModelMatches).toBe(
      !["default-mismatch", "model-absent"].includes(mode),
    );
    expect(counts.modelsAgree).toBe(
      !["models-disagree", "model-absent"].includes(mode),
    );
    expect(counts.distinctModels).toBe(mode === "models-disagree" ? 2 : 1);
    expect(counts.contextWindowPositive).toBe(
      !["context-missing", "usage-missing", "protocol-error"].includes(mode),
    );
    expect(counts.maxOutputTokensPositive).toBe(
      !["output-limit-missing", "usage-missing", "protocol-error"].includes(
        mode,
      ),
    );
    expect(counts.protocolError).toBe(mode === "protocol-error");
    expect(counts.requests).toBe(mode === "protocol-error" ? 1 : 2);
  });
}
