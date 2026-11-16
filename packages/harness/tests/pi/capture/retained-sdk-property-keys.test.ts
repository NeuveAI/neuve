import { sdkContextSnapshot } from "../../../src/pi/capture/retained-context.ts";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  readdirSync,
  existsSync,
} from "node:fs";
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
import {
  Json,
  RETAINED_SDK_ASSEMBLY_POLICY,
} from "../../../src/pi/capture/types.ts";
import {
  exportSnapshot,
  exportPortableSnapshot,
  readSessionDump,
} from "../../../src/session-dump.ts";

type Frame = readonly [string, object];
const item = (type: string, fields: Record<string, unknown> = {}) => ({
  type,
  id: "item",
  ...fields,
});
const added = (value: unknown, index = 0): Frame => [
  "response.output_item.added",
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
  lifecycle = { observed: false, ended: false },
) => {
  const root = mkdtempSync(join(tmpdir(), "retained-sdk-property-keys-")),
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
      sdkContext,
      headerNames: ["authorization"],
      credentialCoverage: "required",
      body: {
        status: "sent",
        json: { model: "synthetic", stream: true },
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
        data: Json.parse({ type: name, ...data }),
      });
    if (lifecycle.observed || lifecycle.ended)
      capture.capture({
        type: "model.event",
        scope,
        callId: "old",
        name: "sdk_invocation_end",
        data: {
          version: 1,
          callId: "old",
          callbacks: frames.length + 1,
          abort: { status: "not-aborted" },
        },
      });
    if (lifecycle.observed)
      capture.capture({
        type: "model.event",
        scope,
        callId: "old",
        name: "credential_guard",
        data: { status: "observed" },
      });
    if (lifecycle.ended)
      capture.capture({
        type: "model.end",
        scope,
        callId: "old",
        outcome: "completed",
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

const credential = "synthetic-final-secret";
const escaped = (text: string) =>
  [...text]
    .map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)
    .join("");
const key = escaped(credential);
const cases: ReadonlyArray<readonly [string, readonly Frame[]]> = [
  [
    "incomplete escaped key",
    [
      added(item("function_call", { arguments: "" })),
      delta("response.function_call_arguments.delta", `{"${key}":1`),
    ],
  ],
  [
    "nested escaped keys and scalar values",
    [
      added(item("function_call", { arguments: "" })),
      delta(
        "response.function_call_arguments.delta",
        `{"parent":[{"${key}":{"safe":"preserved"}}]`,
      ),
    ],
  ],
  [
    "duplicate escaped property name",
    [
      added(item("function_call", { arguments: "" })),
      delta("response.function_call_arguments.delta", `{"${key}":1,"${key}":2`),
    ],
  ],
  [
    "superseded key",
    [
      added(item("function_call", { arguments: "" })),
      delta("response.function_call_arguments.delta", `{"${key}":1`),
      [
        "response.function_call_arguments.done",
        { output_index: 0, arguments: '{"safe":"replacement"}' },
      ],
    ],
  ],
  [
    "split escaped key",
    [
      added(item("function_call", { arguments: "" })),
      delta("response.function_call_arguments.delta", '{"\\u0073'),
      delta("response.function_call_arguments.delta", `${key.slice(6)}":1`),
    ],
  ],
  [
    "Anthropic repaired nested key",
    [
      start(item("tool_use", { input: {} })),
      anthropicDelta(
        "input_json_delta",
        "partial_json",
        `{"parent":{"${key}":1`,
      ),
    ],
  ],
];
for (const [name, frames] of cases)
  test(`generated ${name} is inspected and refuses publication`, () =>
    fixture(frames, async ({ journal, root, source, authority }) => {
      const retained = readCaptureJournal(journal);
      if (retained._tag !== "Read") throw Error("journal unavailable");
      const sources = await credentialSources(
        { conversations: [], session: [] },
        undefined,
        retained.lines,
        [],
        retained.frames,
      );
      const texts = [...sources.values()].flatMap((entry) =>
        entry.kind === "text" ? [entry.text] : [],
      );
      expect(texts).toContain(credential);
      if (name === "nested escaped keys and scalar values") {
        expect(texts).toContain("parent");
        expect(texts).toContain("safe");
        expect(texts).toContain("preserved");
      }
      if (name === "superseded key") {
        expect(texts).toContain("safe");
        expect(texts).toContain("replacement");
      }
      const before = readFileSync(join(journal, "events.jsonl"));
      await expect(
        exportSnapshot({
          runId: "synthetic",
          journal,
          nativeDatabase: join(source, "pi.sqlite"),
          credentialInspection: authority,
          root: join(root, "datasets"),
          retention: { policy: "synthetic" },
        }),
      ).rejects.toMatchObject({
        reason: expect.stringContaining("credential exposure"),
      });
      expect(readdirSync(join(root, "datasets"))).toEqual([]);
      expect(
        readFileSync(join(journal, "events.jsonl")).subarray(0, before.length),
      ).toEqual(before);
      expect(existsSync(join(root, "private", "authority.sqlite"))).toBe(true);
    }));

test("safe generated keys preserve scalar values and honest incomplete exports", () =>
  fixture(
    [
      added(item("function_call", { arguments: "" })),
      delta(
        "response.function_call_arguments.delta",
        '{"\\u0073afe":{"nested":["value",17,true,null]}',
      ),
    ],
    async ({ journal, root, source, authority }) => {
      const restricted = await exportSnapshot({
        runId: "synthetic",
        journal,
        nativeDatabase: join(source, "pi.sqlite"),
        credentialInspection: authority,
        root: join(root, "datasets"),
        retention: { policy: "synthetic" },
      });
      const portable = await exportPortableSnapshot({
        directory: restricted.directory,
        root: join(root, "datasets"),
        retention: { policy: "synthetic" },
      });
      for (const directory of [restricted.directory, portable.directory]) {
        const read = await Effect.runPromise(readSessionDump(directory));
        expect(read.run.complete).toBe(false);
        expect(read.run.gaps.some((gap) => gap.code === "calls-unended")).toBe(
          true,
        );
        expect(read.unjoined[0]?.end).toBeNull();
        expect(
          JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"))
            .retainedAssemblyPolicy,
        ).toBe(RETAINED_SDK_ASSEMBLY_POLICY);
      }
    },
  ));

for (const observed of [false, true])
  for (const ended of [false, true])
    test(`generated key inspection includes observed=${observed} ended=${ended}`, () =>
      fixture(
        [
          added(item("function_call", { arguments: "" })),
          delta("response.function_call_arguments.delta", `{"${key}":1`),
        ],
        async ({ journal }) => {
          const retained = readCaptureJournal(journal);
          if (retained._tag !== "Read") throw Error("journal unavailable");
          const sources = await credentialSources(
            { conversations: [], session: [] },
            undefined,
            retained.lines,
            [],
            retained.frames,
          );
          expect(
            [...sources.values()].some(
              (source) => source.kind === "text" && source.text === credential,
            ),
          ).toBe(true);
        },
        { observed, ended },
      ));
