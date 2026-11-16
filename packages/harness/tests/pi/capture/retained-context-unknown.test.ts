import type { SdkInvocation } from "../../../src/pi/capture/types.ts";
import { expect, test } from "bun:test";
import type { Model } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import type { CallRecord } from "../../../src/pi/capture/dump.ts";
import {
  retainedContext,
  sdkContextSnapshot,
} from "../../../src/pi/capture/retained-context.ts";
import { retainedSdk } from "../../../src/pi/capture/retained-sdk.ts";
import { credentialSources } from "../../../src/pi/capture/safety.ts";
import {
  openCaptureJournal,
  readCaptureJournal,
} from "../../../src/pi/capture/journal.ts";
import { mkdtempSync, rmSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Json } from "../../../src/pi/capture/types.ts";

import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SourceOwnership } from "../../../src/pi/source-ownership.ts";
import { createPrivateInspection } from "../../../src/pi/capture/private-inspection.ts";
import {
  CredentialEpochId,
  InspectionBudget,
} from "../../../src/pi/capture/credential-detectors.ts";
import { exportSnapshot } from "../../../src/session-dump.ts";

const capturedInvocation = (api: string): SdkInvocation =>
  api === "anthropic-messages"
    ? {
        version: 1,
        api: "anthropic-messages",
        authMode: "non-oauth",
        options: { cacheRetention: "none" },
      }
    : {
        version: 1,
        api: "openai-responses",
        options: { cacheRetention: "none" },
      };
const native = { conversations: [], session: [] };
const model: Model<"openai-responses"> = {
  id: "synthetic",
  name: "synthetic",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://capture.invalid",
  reasoning: true,
  input: ["text"],
  contextWindow: 1000,
  maxTokens: 20,
  cost: { input: 2, output: 3, cacheRead: 1, cacheWrite: 4 },
  compat: { supportsOpenAIGrammarTools: true },
};
const frames = [
  { type: "response.created", response: { id: "r", status: "in_progress" } },
  {
    type: "response.output_item.added",
    output_index: 0,
    item: {
      type: "custom_tool_call",
      id: "i",
      call_id: "c",
      name: "grammar",
      input: "",
    },
  },
  {
    type: "response.custom_tool_call_input.delta",
    output_index: 0,
    delta: "safe body",
  },
  {
    type: "response.output_item.done",
    output_index: 0,
    item: {
      type: "custom_tool_call",
      id: "i",
      call_id: "c",
      name: "grammar",
      input: "safe body",
    },
  },
];
const fixture = (body: CallRecord["body"]): Omit<CallRecord, "role"> => ({
  callId: "unknown-call",
  scope: { runId: "unknown-run" },
  route: "synthetic",
  provider: "openai",
  model: "synthetic",
  api: "openai-responses",
  headerNames: [],
  credentialCoverage: "required",
  body,
  requestedAt: 0,
  response: null,
  end: null,
  events: frames.map((frame) => ({
    at: 0,
    name: frame.type,
    data: Json.parse(frame),
  })),
});
const bodies: CallRecord["body"][] = [
  { status: "missing", reason: "body unavailable" },
  { status: "sent", json: {} },
  { status: "sent", json: { model: "synthetic" } },
  {
    status: "sent",
    json: { tools: [{ type: "function", name: "grammar" }], input: [] },
  },
  {
    status: "sent",
    json: {
      input: [
        {
          type: "tool_search_output",
          additional_tools: [{ type: "custom", name: "grammar" }],
        },
      ],
    },
  },
];
for (const [index, body] of bodies.entries())
  test(`missing call-specific semantics ${index} refuse before SDK scalars and credential publication`, async () => {
    const call = fixture(body);
    const scalars: string[] = [];
    await expect(
      retainedSdk(call, native, (value) => scalars.push(value), undefined, {
        purpose: "scalar-enumeration",
      }),
    ).rejects.toThrow("original call-specific SDK context was not captured");
    expect(scalars).toEqual([]);
    const root = mkdtempSync(join(tmpdir(), "unknown-context-"));
    const source = join(root, "source");
    const datasets = join(root, "datasets");
    mkdirSync(source);
    mkdirSync(datasets);
    const ownership = SourceOwnership.acquire(source);
    const authority = createPrivateInspection({
      ownership,
      source,
      directory: join(root, "private"),
      excludedRoots: [source, datasets],
    });
    const storage = await openNodeSqliteStorage(join(source, "pi.sqlite"));
    try {
      await authority.register({
        epoch: CredentialEpochId.parse("unknown-call"),
        headers: new Headers({ authorization: "synthetic-secret" }),
        budget: new InspectionBudget(),
      });
      const journalPath = join(source, "capture");
      const journal = openCaptureJournal(journalPath, "unknown-run");
      journal.capture({
        type: "run.start",
        scope: call.scope,
        runKind: "coding",
        sourceRevision: { status: "not-applicable", reason: "synthetic" },
        route: "synthetic",
        pricing: "subscription",
      });
      journal.capture({
        type: "credential.registration",
        scope: call.scope,
        callId: call.callId,
        epochId: "unknown-call",
        policy: "whole-source-credential-epochs-v1",
      });
      journal.capture({
        type: "model.request",
        scope: call.scope,
        callId: call.callId,
        route: call.route,
        provider: call.provider,
        model: call.model,
        api: "openai-responses",
        headerNames: [],
        credentialCoverage: "required",
        body,
      });
      journal.capture({
        type: "model.event",
        scope: call.scope,
        callId: call.callId,
        name: "credential_guard",
        data: { status: "pending" },
      });
      journal.capture({
        type: "model.response",
        scope: call.scope,
        callId: call.callId,
        status: 200,
      });
      for (const event of call.events)
        journal.capture({
          type: "model.event",
          scope: call.scope,
          callId: call.callId,
          name: event.name,
          data: event.data,
        });
      openCaptureJournal(journalPath, "unknown-run");
      const read = readCaptureJournal(journalPath);
      if (read._tag !== "Read") throw Error("journal unavailable");
      await expect(
        credentialSources(native, undefined, read.lines, [], read.frames),
      ).rejects.toMatchObject({
        reason: "retained-stream-prefix",
        message: "Credential source inspection unavailable",
      });
      await expect(
        exportSnapshot({
          runId: "unknown-run",
          journal: journalPath,
          nativeDatabase: join(source, "pi.sqlite"),
          credentialInspection: authority,
          root: datasets,
          retention: { policy: "synthetic-negative" },
        }),
      ).rejects.toMatchObject({
        reason: expect.stringContaining("unavailable credential source census"),
      });
      expect(readdirSync(datasets)).toEqual([]);
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
      authority.close();
      ownership.release();
      rmSync(root, { recursive: true, force: true });
    }
  });

test("custom output evidence includes delta-only and terminal-only retained prefixes", () => {
  for (const event of fixture(bodies[0]!).events.slice(1))
    expect(() =>
      retainedContext({ ...fixture(bodies[0]!), events: [event] }, native),
    ).toThrow("original call-specific SDK context was not captured");
});

test("request custom tools and additional tools refuse even when output is ordinary", () => {
  for (const json of [
    { tools: [{ type: "custom", name: "grammar" }] },
    { input: [{ additional_tools: [{ type: "custom", name: "grammar" }] }] },
  ])
    expect(() =>
      retainedContext(
        {
          ...fixture({ status: "sent", json }),
          events: fixture(bodies[0]!).events.slice(0, 1),
        },
        native,
      ),
    ).toThrow("original call-specific SDK context was not captured");
});

test("captured query property remains exact and snapshot payload stays immutable", async () => {
  const context = normalizeContext({
    messages: [
      {
        role: "system",
        content: "system",
        timestamp: 1,
        toolsAdded: [
          {
            name: "grammar",
            description: "grammar",
            parameters: {
              type: "object",
              required: ["query"],
              properties: { query: { type: "string" } },
            },
            constrainedSampling: {
              type: "grammar",
              variants: { openai_regex: ".*" },
            },
          },
        ],
      },
    ],
  });
  const snapshot = sdkContextSnapshot(
    "unknown-call",
    model,
    context,
    capturedInvocation("openai-responses"),
  );
  context.messages.length = 0;
  expect(Object.isFrozen(snapshot.messages[0])).toBe(true);
  const call = {
    ...fixture({ status: "sent", json: { model: "synthetic", stream: true } }),
    sdkContext: snapshot,
  };
  const before = structuredClone(call);
  expect(
    await retainedSdk(call, native, undefined, undefined, {
      purpose: "scalar-enumeration",
    }),
  ).toMatchObject({
    content: [{ type: "toolCall", arguments: { query: "safe body" } }],
  });
  expect(call).toEqual(before);
});

test("captured known default is distinct from absent or explicitly unavailable context", async () => {
  const snapshot = sdkContextSnapshot(
    "unknown-call",
    { ...model, compat: {} },
    normalizeContext({ messages: [] }),
    capturedInvocation("openai-responses"),
  );
  const call = fixture({
    status: "sent",
    json: { model: "synthetic", stream: true },
  });
  expect(
    await retainedSdk(
      { ...call, sdkContext: snapshot },
      native,
      undefined,
      undefined,
      { purpose: "scalar-enumeration" },
    ),
  ).toMatchObject({
    content: [{ type: "toolCall", arguments: { input: "safe body" } }],
  });
  await expect(
    retainedSdk(call, native, undefined, undefined, {
      purpose: "scalar-enumeration",
    }),
  ).rejects.toThrow("was not captured");
  await expect(
    retainedSdk(
      {
        ...call,
        sdkContext: {
          ...snapshot,
          unavailableReason: "unsupported original context",
        },
      },
      native,
      undefined,
      undefined,
      { purpose: "scalar-enumeration" },
    ),
  ).rejects.toThrow("unsupported original context");
});

test("legacy ordinary text has context proof but lacks original invocation semantics", async () => {
  const call = fixture({ status: "sent", json: {} });
  call.events = [
    call.events[0]!,
    {
      at: 0,
      name: "response.output_item.done",
      data: {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "message",
          id: "i",
          content: [{ type: "output_text", text: "plain" }],
        },
      },
    },
  ];
  expect(retainedContext(call, native).model.id).toBe("synthetic");
  await expect(
    retainedSdk(call, native, undefined, undefined, {
      purpose: "scalar-enumeration",
    }),
  ).rejects.toThrow("isolated SDK replay unavailable");
  for (const data of [
    { type: "response.completed", response: { usage: { input_tokens: 1 } } },
    { type: "response.unknown_semantic_event" },
  ])
    await expect(
      retainedSdk(
        { ...call, events: [{ at: 0, name: data.type, data }] },
        native,
        undefined,
        undefined,
        { purpose: "scalar-enumeration" },
      ),
    ).rejects.toThrow("original SDK context is required");
});

test("unsupported SDK pin and uncaptured Anthropic metadata refuse explicitly", async () => {
  const snapshot = sdkContextSnapshot(
    "unknown-call",
    model,
    normalizeContext({ messages: [] }),
    capturedInvocation("openai-responses"),
  );
  const unsupported = JSON.parse(
    JSON.stringify({ ...snapshot, sdkPin: "unknown-sdk-pin" }),
  );
  await expect(
    retainedSdk(
      { ...fixture(bodies[0]!), sdkContext: unsupported },
      native,
      undefined,
      undefined,
      { purpose: "scalar-enumeration" },
    ),
  ).rejects.toThrow("unsupported captured SDK context");
  const call = {
    ...fixture(bodies[0]!),
    api: "anthropic-messages",
    provider: "anthropic",
    events: [
      {
        at: 0,
        name: "message_start",
        data: {
          type: "message_start",
          message: {
            id: "a",
            model: "synthetic",
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        },
      },
    ],
  };
  await expect(
    retainedSdk(call, native, undefined, undefined, {
      purpose: "scalar-enumeration",
    }),
  ).rejects.toThrow("original SDK context is required");
});

test("invocation options are copied, API bound and absent historical options stay unknown", () => {
  const invocation: SdkInvocation = {
    version: 1,
    api: "openai-responses",
    options: {
      cacheRetention: "none",
      serviceTier: "flex",
      metadata: { user_id: "fixture-user" },
    },
  };
  const snapshot = sdkContextSnapshot(
    "unknown-call",
    model,
    normalizeContext({ messages: [] }),
    invocation,
  );
  invocation.options.serviceTier = "priority";
  expect(snapshot.invocation).toEqual({
    version: 1,
    api: "openai-responses",
    options: {
      cacheRetention: "none",
      serviceTier: "flex",
      metadata: { user_id: "fixture-user" },
    },
  });
  expect(Object.isFrozen(snapshot.invocation?.options.metadata)).toBe(true);
  expect(() =>
    retainedContext(
      {
        ...fixture(bodies[0]!),
        sdkContext: sdkContextSnapshot(
          "unknown-call",
          model,
          normalizeContext({ messages: [] }),
        ),
      },
      native,
    ),
  ).toThrow("original SDK invocation options were not captured");
  expect(() =>
    retainedContext(
      {
        ...fixture(bodies[0]!),
        sdkContext: {
          ...snapshot,
          invocation: {
            version: 1,
            api: "anthropic-messages",
            authMode: "non-oauth",
            options: { cacheRetention: "none" },
          },
        },
      },
      native,
    ),
  ).toThrow("SDK invocation belongs to another API");
});

test("captured empty option arguments remain truthful but unknown ambient retention refuses replay", () => {
  const snapshot = sdkContextSnapshot(
    "unknown-call",
    model,
    normalizeContext({ messages: [] }),
    { version: 1, api: "openai-responses", options: {} },
  );
  expect(snapshot.invocation?.options).toEqual({});
  expect(() =>
    retainedContext({ ...fixture(bodies[0]!), sdkContext: snapshot }, native),
  ).toThrow("effective SDK cache retention was not captured");
});
