import { sdkContextSnapshot } from "../../../src/pi/capture/retained-context.ts";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SourceOwnership } from "../../../src/pi/source-ownership.ts";
import { createPrivateInspection } from "../../../src/pi/capture/private-inspection.ts";
import {
  CredentialEpochId,
  InspectionBudget,
} from "../../../src/pi/capture/credential-detectors.ts";
import {
  openCaptureJournal,
  readCaptureJournal,
} from "../../../src/pi/capture/journal.ts";
import { credentialSources } from "../../../src/pi/capture/safety.ts";
import { Json } from "../../../src/pi/capture/types.ts";
import {
  exportSnapshot,
  exportPortableSnapshot,
  readSessionDump,
} from "../../../src/session-dump.ts";

type Frame = readonly [string, unknown];
const item = (type: string, fields: Record<string, unknown> = {}) => ({
  type,
  id: "item",
  ...fields,
});
const added = (value: unknown, index = 0): Frame => [
  "response.output_item.added",
  { output_index: index, item: value },
];
const done = (value: unknown, index = 0): Frame => [
  "response.output_item.done",
  { output_index: index, item: value },
];
const delta = (type: string, value: string, index = 0): Frame => [
  type,
  { output_index: index, delta: value },
];
const start = (value: unknown, index = 0): Frame => [
  "content_block_start",
  { index, content_block: value },
];
const anthropicDelta = (
  type: string,
  field: string,
  value: string,
  index = 0,
): Frame => ["content_block_delta", { index, delta: { type, [field]: value } }];

const fixture = async (
  frames: readonly Frame[],
  check: (input: {
    source: string;
    root: string;
    journal: string;
    authority: ReturnType<typeof createPrivateInspection>;
  }) => Promise<void>,
  requestTools: readonly Json[] = [],
) => {
  const root = mkdtempSync(join(tmpdir(), "retained-sdk-assembly-")),
    source = join(root, "source"),
    journal = join(source, "capture");
  mkdirSync(source);
  mkdirSync(join(root, "datasets"));
  const owner = SourceOwnership.acquire(source),
    authority = createPrivateInspection({
      ownership: owner,
      source,
      directory: join(root, "private"),
      excludedRoots: [source, join(root, "datasets")],
    });
  const storage = await openNodeSqliteStorage(join(source, "pi.sqlite"));
  try {
    const registration = await authority.register({
      epoch: CredentialEpochId.parse("old"),
      headers: new Headers({ "x-api-key": "synthetic-final-secret" }),
      budget: new InspectionBudget(),
    });
    expect(registration.status).toBe("registered");
    let capture = openCaptureJournal(journal, "synthetic");
    const scope = { runId: "synthetic" };
    capture.capture({
      type: "run.start",
      scope,
      runKind: "coding",
      sourceRevision: { status: "not-applicable", reason: "synthetic" },
      route: "chatgpt",
      pricing: "subscription",
    });
    capture.capture({
      type: "credential.registration",
      scope,
      callId: "old",
      epochId: "old",
      policy: "whole-source-credential-epochs-v1",
    });
    const api = frames.some(
      ([name]) =>
        name.startsWith("content_block_") || name.startsWith("message_"),
    )
      ? "anthropic-messages"
      : "openai-responses";
    const provider = api === "anthropic-messages" ? "anthropic" : "openai";
    const sdkContext = sdkContextSnapshot(
      "old",
      {
        id: "synthetic",
        name: "synthetic",
        api,
        provider,
        baseUrl: "https://capture.invalid",
        reasoning: true,
        input: ["text"],
        contextWindow: 1000,
        maxTokens: 100,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      normalizeContext({ messages: [] }),
      api === "anthropic-messages"
        ? {
            version: 1,
            api,
            authMode: "non-oauth",
            options: { cacheRetention: "none" },
          }
        : { version: 1, api, options: { cacheRetention: "none" } },
    );
    capture.capture({
      type: "model.request",
      scope,
      callId: "old",
      route: "chatgpt",
      provider,
      api,
      model: "synthetic",
      ...(requestTools.length === 0 ? { sdkContext } : {}),
      headerNames: ["authorization"],
      credentialCoverage: "required",
      body: {
        status: "sent",
        json: { model: "synthetic", stream: true, tools: requestTools },
      },
    });
    capture.capture({
      type: "model.event",
      scope,
      callId: "old",
      name: "credential_guard",
      data: { status: "pending" },
    });
    capture.capture({
      type: "model.response",
      scope,
      callId: "old",
      status: 200,
    });
    const family = frames.some(
      ([name]) =>
        name.startsWith("content_block_") || name.startsWith("message_"),
    )
      ? "anthropic"
      : "responses";
    if (
      !frames.some(
        ([name]) => name === "response.created" || name === "message_start",
      )
    )
      capture.capture({
        type: "model.event",
        scope,
        callId: "old",
        name: family === "anthropic" ? "message_start" : "response.created",
        data:
          family === "anthropic"
            ? {
                type: "message_start",
                message: {
                  id: "r",
                  model: "synthetic",
                  usage: { input_tokens: 0, output_tokens: 0 },
                },
              }
            : {
                type: "response.created",
                response: { id: "r", status: "in_progress" },
              },
      });
    for (const [name, data] of frames)
      capture.capture({
        type: "model.event",
        scope,
        callId: "old",
        name,
        data: Json.parse({ type: name, ...(data as object) }),
      });
    capture = openCaptureJournal(journal, "synthetic");
    capture.close();
    await check({ source, root, journal, authority });
  } finally {
    await storage.close(BACKGROUND_CONTEXT);
    authority.close();
    owner.release();
    rmSync(root, { recursive: true, force: true });
  }
};

const cases: ReadonlyArray<
  readonly [
    name: string,
    frames: readonly Frame[],
    expected: readonly string[],
    absent?: readonly string[],
  ]
> = [
  [
    "final message replaces deltas and joins text/refusal",
    [
      added(item("message")),
      delta("response.output_text.delta", "earlier"),
      done(
        item("message", {
          content: [
            { type: "output_text", text: "synthetic-final-" },
            { type: "refusal", refusal: "secret" },
          ],
        }),
      ),
    ],
    ["earlier", "synthetic-final-secret"],
  ],
  [
    "done-only final item creates its SDK slot",
    [
      done(
        item("message", {
          content: [
            { type: "output_text", text: "one" },
            { type: "output_text", text: "two" },
          ],
        }),
      ),
    ],
    ["onetwo"],
  ],
  [
    "repeated added index preserves previous slot without joining slots",
    [
      added(item("message")),
      delta("response.output_text.delta", "synthetic-final-"),
      added(item("message")),
      delta("response.refusal.delta", "secret"),
    ],
    ["synthetic-final-", "secret"],
    ["synthetic-final-secret"],
  ],
  [
    "done removes slot before late deltas",
    [
      done(
        item("message", {
          content: [{ type: "output_text", text: "synthetic-final-" }],
        }),
      ),
      delta("response.output_text.delta", "secret"),
    ],
    ["synthetic-final-"],
    ["synthetic-final-secret"],
  ],
  [
    "reasoning summary wins and joins with two newlines",
    [
      added(item("reasoning")),
      delta("response.reasoning_text.delta", "earlier"),
      done(
        item("reasoning", {
          summary: [{ text: "one" }, { text: "two" }],
          content: [{ text: "unused" }],
        }),
      ),
    ],
    ["earlier", "one\n\ntwo"],
    ["unused"],
  ],
  [
    "reasoning content fallback",
    [
      done(
        item("reasoning", {
          summary: [],
          content: [{ text: "one" }, { text: "two" }],
        }),
      ),
    ],
    ["one\n\ntwo"],
  ],
  [
    "reasoning keeps previous thinking for empty final arrays",
    [
      added(item("reasoning")),
      delta("response.reasoning_summary_text.delta", "kept"),
      done(item("reasoning", { summary: [], content: [] })),
    ],
    ["kept"],
  ],
  [
    "reasoning part boundaries",
    [
      added(item("reasoning")),
      delta("response.reasoning_text.delta", "one"),
      ["response.reasoning_summary_part.done", { output_index: 0 }],
      delta("response.reasoning_summary_text.delta", "two"),
    ],
    ["one\n\ntwo"],
  ],
  [
    "argument done replacement and item done fallback",
    [
      added(item("function_call", { arguments: '{"x":"old"}' })),
      [
        "response.function_call_arguments.done",
        { output_index: 0, arguments: '{"x":"\\u0073ynthetic-final-secret"}' },
      ],
      done(item("function_call", { arguments: "" })),
    ],
    ['{"x":"old"}', "synthetic-final-secret"],
  ],
  [
    "custom replacement preserves prior input",
    [
      added(item("custom_tool_call", { input: "old" })),
      delta("response.custom_tool_call_input.delta", "er"),
      [
        "response.custom_tool_call_input.done",
        { output_index: 0, input: "older" },
      ],
      done(item("custom_tool_call")),
    ],
    ["older", '{"input":"older', '"}'],
  ],
  [
    "tool IDs are assembled",
    [
      added(
        item("function_call", { call_id: "call", id: "id", arguments: "{}" }),
      ),
    ],
    ["call|id"],
  ],
  [
    "Anthropic thinking and signature have separate scalar state",
    [
      start(item("thinking", { thinking: "one", signature: "sig" })),
      anthropicDelta("thinking_delta", "thinking", "two"),
      anthropicDelta("signature_delta", "signature", "nature"),
    ],
    ["onetwo", "signature"],
  ],
  [
    "Anthropic duplicate indices target first active block",
    [
      start(item("text", { text: "first" })),
      start(item("text", { text: "second" })),
      anthropicDelta("text_delta", "text", "A"),
      ["content_block_stop", { index: 0 }],
      anthropicDelta("text_delta", "text", "B"),
    ],
    ["firstA", "secondB"],
    ["secondA"],
  ],
  [
    "Anthropic stop removes index",
    [
      start(item("text", { text: "synthetic-final-" })),
      ["content_block_stop", { index: 0 }],
      anthropicDelta("text_delta", "text", "secret"),
    ],
    ["synthetic-final-"],
    ["synthetic-final-secret"],
  ],
  [
    "Anthropic input JSON decoding",
    [
      start(item("tool_use", { input: { initial: "old" } })),
      anthropicDelta(
        "input_json_delta",
        "partial_json",
        '{"x":"\\u0073ynthetic-final-',
      ),
      anthropicDelta("input_json_delta", "partial_json", 'secret"}'),
      ["content_block_stop", { index: 0 }],
    ],
    ["synthetic-final-secret"],
  ],
  [
    "reasoning signature backfill",
    [
      done(item("reasoning", { summary: [] })),
      [
        "response.completed",
        {
          response: {
            output: [item("reasoning", { encrypted_content: "cipher" })],
          },
        },
      ],
    ],
    [
      '{"type":"reasoning","id":"item","summary":[],"encrypted_content":"cipher"}',
    ],
  ],
  [
    "provider failure text is assembled",
    [
      [
        "response.failed",
        { response: { error: { code: "one", message: "two" } } },
      ],
    ],
    ["one: two"],
  ],
];
for (const [name, frames, expected, absent = []] of cases)
  test(name, () =>
    fixture(frames, async ({ journal }) => {
      const read = readCaptureJournal(journal);
      if (read._tag !== "Read") throw Error("journal unavailable");
      const sources = await credentialSources(
        { conversations: [], session: [] },
        undefined,
        read.lines,
        [],
        read.frames,
        new InspectionBudget(),
      );
      const texts = [...sources.values()].flatMap((source) =>
        source.kind === "text" ? [source.text] : [],
      );
      for (const text of expected) expect(texts).toContain(text);
      for (const text of absent) expect(texts).not.toContain(text);
    }),
  );

for (const partial of [false, true])
  test(`public ${partial ? "partial" : "final-only"} reasoning remains incomplete through portable export`, () =>
    fixture(
      partial
        ? [
            added(item("reasoning")),
            delta(
              "response.reasoning_summary_text.delta",
              "private synthetic reasoning",
            ),
            ["response.reasoning_summary_part.done", { output_index: 0 }],
            delta(
              "response.reasoning_summary_text.delta",
              "second private reasoning",
            ),
          ]
        : [
            done(
              item("reasoning", {
                summary: [
                  { type: "summary_text", text: "private synthetic reasoning" },
                  { type: "summary_text", text: "second private reasoning" },
                ],
              }),
            ),
          ],
      async ({ root, journal, source, authority }) => {
        const restricted = await exportSnapshot({
          runId: "synthetic",
          journal,
          nativeDatabase: join(source, "pi.sqlite"),
          credentialInspection: authority,
          root: join(root, "datasets"),
          retention: { policy: "synthetic" },
        });
        expect(
          (await Effect.runPromise(readSessionDump(restricted.directory))).run
            .complete,
        ).toBe(false);
        const portable = await exportPortableSnapshot({
          directory: restricted.directory,
          root: join(root, "datasets"),
          retention: { policy: "synthetic" },
        });
        const read = await Effect.runPromise(
          readSessionDump(portable.directory),
        );
        expect(read.run.complete).toBe(false);
        expect(JSON.stringify(read)).not.toContain(
          "private synthetic reasoning",
        );
        expect(JSON.stringify(read)).not.toContain("second private reasoning");
      },
    ));

for (const unsafe of [false, true])
  test(`public final-item export ${unsafe ? "refuses assembled credential" : "preserves safe incomplete restricted and portable history"}`, () =>
    fixture(
      [
        added(item("message")),
        done(
          item("message", {
            content: [
              {
                type: "output_text",
                text: unsafe ? "synthetic-final-" : "safe final ",
              },
              { type: "output_text", text: unsafe ? "secret" : "content" },
            ],
          }),
        ),
      ],
      async ({ root, journal, source, authority }) => {
        const exporting = exportSnapshot({
          runId: "synthetic",
          journal,
          nativeDatabase: join(source, "pi.sqlite"),
          credentialInspection: authority,
          root: join(root, "datasets"),
          retention: { policy: "synthetic" },
        });
        if (unsafe) {
          await expect(exporting).rejects.toMatchObject({
            reason: expect.stringContaining("credential exposure"),
          });
          return;
        }
        const restricted = await exporting;
        const read = await Effect.runPromise(
          readSessionDump(restricted.directory),
        );
        expect(read.run.complete).toBe(false);
        expect(read.run.gaps.some((gap) => gap.code === "calls-unended")).toBe(
          true,
        );
        const portable = await exportPortableSnapshot({
          directory: restricted.directory,
          root: join(root, "datasets"),
          retention: { policy: "synthetic" },
        });
        expect(
          (await Effect.runPromise(readSessionDump(portable.directory))).run
            .complete,
        ).toBe(false);
        const retained = readCaptureJournal(journal);
        if (retained._tag !== "Read") throw Error("journal unavailable");
        expect(
          retained.lines.some(
            ({ event }) =>
              event.type === "model.end" ||
              (event.type === "credential.guard" &&
                event.status === "observed"),
          ),
        ).toBe(false);
      },
    ));

test("unsupported argument Unicode remains unavailable", () =>
  fixture(
    [added(item("function_call", { arguments: '{"x":"\\u00' }))],
    async ({ journal }) => {
      const read = readCaptureJournal(journal);
      if (read._tag !== "Read") throw Error("journal unavailable");
      await expect(
        credentialSources(
          { conversations: [], session: [] },
          undefined,
          read.lines,
          [],
          read.frames,
          new InspectionBudget(),
        ),
      ).rejects.toMatchObject({ reason: "retained-argument-escape" });
    },
  ));

test("an incomplete Unicode escape may finish on the next argument delta", () =>
  fixture(
    [
      added(item("function_call")),
      delta("response.function_call_arguments.delta", '{"x":"\\u00'),
      delta("response.function_call_arguments.delta", '73afe"}'),
    ],
    async ({ journal }) => {
      const read = readCaptureJournal(journal);
      if (read._tag !== "Read") throw Error("journal unavailable");
      const sources = await credentialSources(
        { conversations: [], session: [] },
        undefined,
        read.lines,
        [],
        read.frames,
      );
      expect(
        [...sources.values()].some(
          (source) => source.kind === "text" && source.text === "safe",
        ),
      ).toBe(true);
    },
  ));

test("custom input without an effective request match is unavailable", () =>
  fixture(
    [
      added(item("custom_tool_call", { name: "grammar", input: "old" })),
      delta("response.custom_tool_call_input.delta", "er"),
      done(item("custom_tool_call", { name: "grammar" })),
    ],
    async ({ journal }) => {
      const read = readCaptureJournal(journal);
      if (read._tag !== "Read") throw Error("journal unavailable");
      const native = {
        conversations: [
          {
            id: 0,
            record: { id: 0 },
            entries: [
              {
                id: 0,
                conversationId: 0,
                kind: "pi.system",
                model: [
                  {
                    role: "system",
                    content: "",
                    toolsAdded: [
                      {
                        name: "grammar",
                        constrainedSampling: { type: "grammar" },
                        parameters: {
                          type: "object",
                          required: ["query"],
                          properties: { query: { type: "string" } },
                        },
                      },
                    ],
                  },
                ],
              },
            ],
            tasks: [],
            documents: [],
            taskDocuments: [],
          },
        ],
        session: [],
      };
      await expect(
        credentialSources(native, undefined, read.lines, [], read.frames),
      ).rejects.toMatchObject({ reason: "retained-stream-prefix" });
    },
    [{ type: "custom", name: "grammar" }],
  ));

test("advertised custom input without original grammar schema is unavailable", () =>
  fixture(
    [
      added(item("custom_tool_call", { name: "missing", input: "safe" })),
      done(item("custom_tool_call", { name: "missing" })),
    ],
    async ({ journal }) => {
      const read = readCaptureJournal(journal);
      if (read._tag !== "Read") throw Error("journal unavailable");
      await expect(
        credentialSources(
          { conversations: [], session: [] },
          undefined,
          read.lines,
          [],
          read.frames,
        ),
      ).rejects.toMatchObject({ reason: "retained-stream-prefix" });
    },
    [{ type: "custom", name: "missing" }],
  ));

test("malformed final content keeps the SDK diagnostic", () =>
  fixture(
    [done(item("message", { content: "unsupported" }))],
    async ({ journal }) => {
      const read = readCaptureJournal(journal);
      if (read._tag !== "Read") throw Error("journal unavailable");
      const sources = await credentialSources(
        { conversations: [], session: [] },
        undefined,
        read.lines,
        [],
        read.frames,
      );
      expect(
        [...sources.values()].some(
          (source) =>
            source.kind === "text" &&
            source.text.includes("map is not a function"),
        ),
      ).toBe(true);
    },
  ));
