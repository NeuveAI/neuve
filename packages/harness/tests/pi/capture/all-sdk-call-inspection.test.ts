import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { sdkContextSnapshot } from "../../../src/pi/capture/retained-context.ts";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { exportSnapshot } from "../../../src/session-dump.ts";
import { expect, test } from "bun:test";
import {
  credentialSources,
  credentialSourceText,
} from "../../../src/pi/capture/safety.ts";
import {
  CAPTURE_VERSION,
  Json,
  type JournalLine,
} from "../../../src/pi/capture/types.ts";

const lines = (
  observed: boolean,
  ended: boolean,
  api: string | undefined,
): JournalLine[] => {
  const scope = { runId: "all-calls" };
  const events: JournalLine["event"][] = [
    {
      type: "model.request",
      scope,
      callId: "call",
      route: "synthetic",
      provider: "openai",
      model: "synthetic",
      ...(api === undefined ? {} : { api }),
      headerNames: ["authorization"],
      credentialCoverage: "required",
      body: { status: "sent", json: { model: "synthetic", stream: true } },
      sdkContext: sdkContextSnapshot(
        "call",
        {
          id: "synthetic",
          name: "synthetic",
          api: "openai-responses",
          provider: "openai",
          baseUrl: "https://capture.invalid",
          reasoning: true,
          input: ["text"],
          contextWindow: 1000,
          maxTokens: 100,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
        normalizeContext({ messages: [] }),
        {
          version: 1,
          api: "openai-responses",
          options: { cacheRetention: "none" },
        },
      ),
    },
    {
      type: "model.event",
      scope,
      callId: "call",
      name: "credential_guard",
      data: { status: "pending" },
    },
    { type: "model.response", scope, callId: "call", status: 200 },
  ];
  for (const data of [
    { type: "response.created", response: { id: "r", status: "in_progress" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "m", content: [] },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      delta: "synthetic-",
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      delta: "credential",
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        id: "m",
        content: [{ type: "output_text", text: "safe replacement" }],
      },
    },
  ])
    events.push({
      type: "model.event",
      scope,
      callId: "call",
      name: data.type,
      data: Json.parse(data),
    });
  events.push({
    type: "model.event",
    scope,
    callId: "call",
    name: "sdk_invocation_end",
    data: {
      version: 1,
      callId: "call",
      callbacks: 5,
      abort: { status: "not-aborted" },
    },
  });
  if (observed)
    events.push({
      type: "model.event",
      scope,
      callId: "call",
      name: "credential_guard",
      data: { status: "observed" },
    });
  if (ended)
    events.push({
      type: "model.end",
      scope,
      callId: "call",
      outcome: "completed",
    });
  return events.map((event, index) => ({
    v: CAPTURE_VERSION,
    seq: index + 1,
    at: index,
    event,
  }));
};

for (const observed of [true, false])
  for (const ended of [true, false]) {
    test(`authenticated generated views survive replacement with observed=${observed} ended=${ended}`, async () => {
      const sources = await credentialSources(
        { conversations: [], session: [] },
        undefined,
        lines(observed, ended, "openai-responses"),
        [],
      );
      expect([...sources.values()].map(credentialSourceText)).toContain(
        "synthetic-credential",
      );
    });
  }

test("captured SDK context establishes the assembler when call API metadata is absent", async () => {
  const sources = await credentialSources(
    { conversations: [], session: [] },
    undefined,
    lines(true, true, undefined),
    [],
  );
  expect([...sources.values()].map(credentialSourceText)).toContain(
    "synthetic-credential",
  );
});

test("unknown authenticated model assemblers refuse instead of bypassing SDK inspection", async () => {
  await expect(
    credentialSources(
      { conversations: [], session: [] },
      undefined,
      lines(true, true, "unknown-model-api"),
      [],
    ),
  ).rejects.toMatchObject({ reason: "retained-stream-prefix" });
});

test("count-token registrations are not model streams", async () => {
  const scope = { runId: "all-calls" };
  const events: JournalLine[] = [
    {
      v: CAPTURE_VERSION,
      seq: 1,
      at: 0,
      event: {
        type: "credential.guard",
        scope,
        callId: "count",
        status: "pending",
      },
    },
  ];
  await expect(
    credentialSources(
      { conversations: [], session: [] },
      undefined,
      events,
      [],
    ),
  ).resolves.toBeInstanceOf(Map);
});

test("authenticated caption and recap calls inspect the same generated views", async () => {
  for (const purpose of ["caption", "recap"] as const) {
    const events = lines(true, true, "openai-responses").map(
      (line): JournalLine =>
        line.event.type === "model.request"
          ? {
              ...line,
              event: {
                ...line.event,
                scope: { runId: "all-calls", conversationId: 1 },
                purpose,
              },
            }
          : line,
    );
    const sources = await credentialSources(
      { conversations: [], session: [] },
      undefined,
      events,
      [],
    );
    expect([...sources.values()].map(credentialSourceText)).toContain(
      "synthetic-credential",
    );
    const missingConversation = events.map((line): JournalLine =>
      line.event.type === "model.request"
        ? { ...line, event: { ...line.event, scope: { runId: "all-calls" } } }
        : line,
    );
    await expect(
      credentialSources(
        { conversations: [], session: [] },
        undefined,
        missingConversation,
        [],
      ),
    ).rejects.toThrow(
      "an auxiliary call is non-turn and names its native conversation",
    );
  }
});

test("unauthenticated calls retain raw data without claiming credential SDK coverage", async () => {
  const events = lines(true, true, "unknown-model-api").map(
    (line): JournalLine =>
      line.event.type === "model.request"
        ? {
            ...line,
            event: {
              ...line.event,
              headerNames: [],
              credentialCoverage: "none",
            },
          }
        : line,
  );
  const sources = await credentialSources(
    { conversations: [], session: [] },
    undefined,
    events,
    [],
  );
  expect([...sources.values()].map(credentialSourceText)).not.toContain(
    "synthetic-credential",
  );
});

for (const ended of [true, false]) {
  test(`public export refuses overwritten SDK exposure with observed=true ended=${ended}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "all-sdk-calls-"));
    const source = join(root, "source");
    mkdirSync(source);
    const datasets = join(root, "datasets");
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
      const registration = await authority.register({
        epoch: CredentialEpochId.parse("call"),
        headers: new Headers({ authorization: "Bearer synthetic-credential" }),
        budget: new InspectionBudget(),
      });
      expect(registration.status).toBe("registered");
      const journal = openCaptureJournal(join(source, "capture"), "all-calls");
      journal.capture({
        type: "credential.registration",
        scope: { runId: "all-calls" },
        callId: "call",
        epochId: "call",
        policy: "whole-source-credential-epochs-v1",
      });
      for (const line of lines(true, ended, "openai-responses")) {
        if (
          line.event.type === "journal.open" ||
          line.event.type === "journal.close" ||
          line.event.type === "journal.failed" ||
          line.event.type === "artifact"
        )
          throw new Error("unexpected fixture mark");
        journal.capture(line.event);
      }
      journal.close();
      await expect(
        exportSnapshot({
          runId: "all-calls",
          journal: journal.directory,
          nativeDatabase: join(source, "pi.sqlite"),
          credentialInspection: authority,
          root: datasets,
          retention: { policy: "synthetic" },
        }),
      ).rejects.toThrow("credential exposure in exact source");
      expect(existsSync(join(datasets, "restricted"))).toBe(false);
      const kept = readCaptureJournal(journal.directory);
      if (kept._tag !== "Read") throw new Error("fixture journal unavailable");
      expect(
        kept.lines.some(
          ({ event }) =>
            event.type === "credential.guard" && event.status === "exposed",
        ),
      ).toBe(true);
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
      authority.close();
      ownership.release();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
