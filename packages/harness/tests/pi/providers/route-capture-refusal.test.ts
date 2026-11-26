// Why: a local capture refusal crosses an SDK that can report it as a connection error.
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryCredentialStore,
  isRetryableAssistantError,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { storeLocationIn } from "@neuve/records-core";
import { openRunLog } from "../../../src/run-log.ts";
import { SOL_ROUTE } from "../../../src/route.ts";
import { SourceOwnership } from "../../../src/pi/source-ownership.ts";
import { createPrivateInspection } from "../../../src/pi/capture/private-inspection.ts";
import {
  JOURNAL_FILE,
  IDLE_RELEASE_MS,
  readCaptureJournal,
  readCaptureLosses,
  openCaptureJournal,
} from "../../../src/pi/capture/journal.ts";
import { buildDump } from "../../../src/pi/capture/build.ts";
import {
  exportPortableSnapshot,
  exportSnapshot,
  readSessionDump,
  sealCapturedDump,
} from "../../../src/pi/capture/export.ts";
import { fileRawCapture, scanRawCapture } from "../../../src/pi/capture/raw.ts";
import { runIn, value } from "../capture/fixture.ts";
import { CaptureFailed } from "../../../src/pi/capture/types.ts";
import { createRouteModels } from "../../../src/pi/providers/agent-route-provider.ts";
import { captureNativeModels } from "../../../src/pi/providers/native-models-capture.ts";
import { routeFailureOf } from "../../../src/pi/providers/failure.ts";
import {
  completed,
  created,
  messageItem,
  sse,
  tokenCommand,
} from "./fixture.ts";

const prompt = {
  messages: [
    { role: "user" as const, content: "Check the work.", timestamp: 1 },
  ],
};

const answer = (text: string) =>
  sse([
    created("resp_note"),
    ...messageItem(0, "msg_note", "final_answer", text),
    completed("resp_note"),
  ]);

test("capture exhaustion leaves the first call, later calls and a reopened call answered", async () => {
  const directory = await mkdtemp(join(tmpdir(), "neuve-full-capture-"));
  const runId = "full-capture";
  const limits = {
    objectBytes: 65536,
    totalBytes: 65536,
    manifestBytes: 4096,
    journalBytes: 4096,
  };
  try {
    const source = join(directory, "source");
    await mkdir(source, { mode: 0o700 });
    const ownership = SourceOwnership.acquire(source);
    const inspection = createPrivateInspection({
      ownership,
      source,
      directory: join(directory, "private"),
      excludedRoots: [source],
    });
    try {
      const token = tokenCommand(directory, "lease");
      const log = openRunLog(storeLocationIn(directory), "worker");
      const captureDirectory = join(directory, "capture");
      let sent = 0;
      const text = "x".repeat(4096);
      const retry = { maxRetries: 1, baseDelayMs: 1_000 };
      const open = () => {
        const journal = openCaptureJournal(captureDirectory, runId, {
          limits,
          log,
        });
        if (sent === 0)
          journal.capture({
            type: "run.start",
            scope: { runId },
            runKind: "coding",
            sourceRevision: {
              status: "not-applicable",
              reason: "Scratch chat",
            },
            route: SOL_ROUTE.provider,
            pricing: "subscription",
          });
        const models = createRouteModels({
          route: SOL_ROUTE,
          retry,
          log,
          runId,
          sessionAffinity: runId,
          auth: { tokenCommand: token.path },
          credentialInspection: inspection,
          capture: journal.capture,
          fetch: Object.assign(
            async () => {
              sent++;
              return answer(text);
            },
            { preconnect() {} },
          ),
        });
        const model = models.getModel(SOL_ROUTE.provider, SOL_ROUTE.model);
        if (!model) throw new Error("Expected coding route model");
        return { journal, complete: () => models.complete(model, prompt) };
      };
      const first = open();
      const firstResult = await first.complete();
      const started = performance.now();
      const results = [firstResult, await first.complete()];
      expect(performance.now() - started).toBeLessThan(retry.baseDelayMs);
      first.journal.close();
      const reopened = open();
      results.push(await reopened.complete());
      for (const result of results) {
        expect(result.content).toContainEqual(
          expect.objectContaining({ type: "text", text }),
        );
        expect(result.stopReason).toBe("stop");
        expect(routeFailureOf(result)).toBeUndefined();
      }
      expect(sent).toBe(3);
      await log.flush?.();
      const calls = log.read().filter(({ type }) => type === "model.call");
      expect(
        calls.map(({ failureKind, sentAt }) => [failureKind, typeof sentAt]),
      ).toEqual([
        [undefined, "string"],
        [undefined, "string"],
        [undefined, "string"],
      ]);
      const losses = readCaptureLosses(captureDirectory, limits);
      expect(
        losses.map(({ event, kind, reason }) => [event, kind, reason]),
      ).toEqual([
        ["model.event", "full", "journal limit"],
        ["credential.registration", "full", "journal limit"],
        ["model.request", "full", "journal limit"],
      ]);
      expect(losses.map(({ callId }) => callId)).toEqual(
        calls.map(({ call }) => String(call)),
      );
      const journal = readCaptureJournal(captureDirectory, limits);
      expect(journal._tag).toBe("Read");
      if (journal._tag !== "Read") throw new Error("Expected journal");
      const requests = journal.lines.flatMap(({ event }) =>
        event.type === "model.request" ? [event.callId] : [],
      );
      expect(requests).toEqual(losses.slice(0, 1).map(({ callId }) => callId));
      const { run, contents } = await buildDump({
        journal: captureDirectory,
        runId,
        limits,
        credentialInspection: inspection,
      });
      expect(run.complete).toBe(false);
      const gap = run.gaps.find(({ code }) => code === "journal-failed");
      expect(gap?.kind).toBe("capture");
      expect(gap?.count).toBe(3);
      for (const loss of losses)
        expect(gap?.detail).toContain(
          `call ${loss.callId} lost capture at ${loss.event}`,
        );
      expect(contents.map(({ name }) => name)).toEqual([
        "run.json",
        "source/projection.json",
        "calls/unjoined.json",
      ]);
      const root = join(directory, "dataset");
      await mkdir(root);
      const retention = { policy: "test" };
      const restricted = await exportSnapshot({
        journal: captureDirectory,
        runId,
        limits,
        root,
        retention,
        credentialInspection: inspection,
      });
      const portable = await exportPortableSnapshot({
        directory: restricted.directory,
        root,
        retention,
      });
      const read = await Effect.runPromise(readSessionDump(portable.directory));
      expect(read.run.gaps).toEqual(run.gaps);
      expect(read.run.complete).toBe(false);
      const location = storeLocationIn(join(directory, "records"));
      const useStore = runIn(location);
      const filed = value(
        await useStore(fileRawCapture({ runId, journal: captureDirectory })),
      );
      expect(filed.manifest.counts.calls).toBe(3);
      expect(filed.manifest.files.map(({ name }) => name)).toContain(
        "capture/capture-loss.json",
      );
      const scanned = value(
        await useStore(
          scanRawCapture({
            location,
            rawCapture: filed.rawCapture,
            seal: (sources, scan) => sealCapturedDump(sources, scan, false),
          }),
        ),
      );
      expect(scanned.run.gaps).toEqual(run.gaps);
    } finally {
      await inspection.close();
      ownership.release();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a transient write refusal retries the same request and keeps its capture", async () => {
  const directory = await mkdtemp(join(tmpdir(), "neuve-capture-retry-"));
  try {
    const runId = "capture-retry";
    const journal = openCaptureJournal(directory, runId);
    const path = join(directory, JOURNAL_FILE);
    // The journal releases its descriptor after an idle interval. chmod then affects the next open.
    await Bun.sleep(2 * IDLE_RELEASE_MS + 50);
    chmodSync(path, 0o400);
    let attempts = 0;
    let sent = 0;
    const token = tokenCommand(directory, "lease");
    const capture = Object.assign(
      (event: Parameters<typeof journal.capture>[0]) => {
        if (event.type === "model.request" && ++attempts === 1)
          setTimeout(() => chmodSync(path, 0o600), 0);
        journal.capture(event);
      },
      journal.capture,
    );
    const models = createRouteModels({
      capture,
      credentialInspection: "ephemeral",
      route: SOL_ROUTE,
      retry: { maxRetries: 1, baseDelayMs: 20 },
      runId,
      sessionAffinity: runId,
      auth: { tokenCommand: token.path },
      fetch: Object.assign(
        async () => {
          sent++;
          return answer("Done.");
        },
        { preconnect() {} },
      ),
    });
    const model = models.getModel(SOL_ROUTE.provider, SOL_ROUTE.model);
    if (!model) throw new Error("Expected coding route model");
    expect((await models.complete(model, prompt)).stopReason).toBe("stop");
    expect({ attempts, sent }).toEqual({ attempts: 2, sent: 1 });
    expect(readCaptureLosses(directory)).toEqual([]);
    journal.close();
    const recorded = readCaptureJournal(directory);
    expect(recorded._tag).toBe("Read");
    if (recorded._tag !== "Read") throw new Error("Expected journal");
    expect(
      recorded.lines.filter(({ event }) => event.type === "model.request"),
    ).toHaveLength(1);
    expect(
      recorded.lines.filter(({ event }) => event.type === "model.end"),
    ).toHaveLength(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a transient session bind write refusal leaves later calls captured whole", async () => {
  const directory = await mkdtemp(join(tmpdir(), "neuve-capture-bind-"));
  try {
    const runId = "capture-bind";
    const conversationId = ROOT_CONVERSATION_ID;
    const journal = openCaptureJournal(directory, runId);
    journal.capture({
      type: "run.start",
      scope: { runId },
      runKind: "coding",
      sourceRevision: { status: "not-applicable", reason: "Scratch chat" },
      route: SOL_ROUTE.provider,
      pricing: "subscription",
    });
    const path = join(directory, JOURNAL_FILE);
    await Bun.sleep(2 * IDLE_RELEASE_MS + 50);
    chmodSync(path, 0o400);
    try {
      expect(() =>
        journal.capture({
          type: "session.bind",
          scope: { runId, conversationId },
        }),
      ).toThrow(expect.objectContaining({ kind: "io", event: "session.bind" }));
    } finally {
      chmodSync(path, 0o600);
    }

    const models = createRouteModels({
      capture: journal.capture,
      credentialInspection: "ephemeral",
      route: SOL_ROUTE,
      retry: { maxRetries: 1, baseDelayMs: 1 },
      runId,
      conversationId,
      sessionAffinity: runId,
      auth: { tokenCommand: tokenCommand(directory, "lease").path },
      fetch: Object.assign(async () => answer("Done."), { preconnect() {} }),
    });
    const model = models.getModel(SOL_ROUTE.provider, SOL_ROUTE.model);
    if (!model) throw new Error("Expected coding route model");
    for (const result of [
      await models.complete(model, prompt),
      await models.complete(model, prompt),
    ]) {
      expect(result.stopReason).toBe("stop");
      expect(result.content).toContainEqual(
        expect.objectContaining({ type: "text", text: "Done." }),
      );
    }
    expect(readCaptureLosses(directory)).toEqual([]);
    expect(() => journal.close()).toThrow(
      expect.objectContaining({ kind: "io", event: "session.bind" }),
    );

    const recorded = readCaptureJournal(directory);
    if (recorded._tag !== "Read") throw new Error("Expected journal");
    const events = recorded.lines.map(({ event }) => event);
    expect(events.map(({ type }) => type)).not.toContain("journal.close");
    const requests = events.flatMap((event) =>
      event.type === "model.request" ? [event.callId] : [],
    );
    expect(requests).toHaveLength(2);
    expect(
      events.flatMap((event) =>
        event.type === "model.response" ? [event.callId] : [],
      ),
    ).toEqual(requests);
    expect(
      events.flatMap((event) =>
        event.type === "model.end" && event.outcome === "completed"
          ? [event.callId]
          : [],
      ),
    ).toEqual(requests);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a native provider answers with a full journal and no recorded request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "neuve-native-full-capture-"));
  try {
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("openai", async () => ({
      type: "api_key",
      key: "synthetic-key",
    }));
    const defaults = await builtinModels({ credentials });
    const model = defaults
      .getModels("openai")
      .find(({ api }) => api === "openai-responses");
    if (!model) throw new Error("Expected a native Responses model");
    const journal = openCaptureJournal(directory, "native-full", {
      limits: {
        journalBytes: 400,
        objectBytes: 4096,
        totalBytes: 4096,
        manifestBytes: 4096,
      },
    });
    let dispatches = 0;
    let sent = 0;
    const models = captureNativeModels(defaults, {
      runId: "native-full",
      credentialInspection: "ephemeral",
      retry: { maxRetries: 1, baseDelayMs: 1 },
      capture: Object.assign((event: Parameters<typeof journal.capture>[0]) => {
        if (event.type === "model.request") dispatches++;
        journal.capture(event);
      }, journal.capture),
      fetch: Object.assign(
        async () => {
          sent++;
          return answer("Done.");
        },
        { preconnect() {} },
      ),
    });
    const result = await models.complete(
      model,
      {
        messages: [{ role: "user", content: "Check the work.", timestamp: 1 }],
      },
      { maxRetries: 2 },
    );
    expect(result.stopReason).toBe("stop");
    expect(routeFailureOf(result)).toBeUndefined();
    expect([dispatches, sent]).toEqual([2, 1]);
    const [loss] = readCaptureLosses(directory);
    expect(loss).toMatchObject({
      event: "model.request",
      kind: "full",
      reason: "journal limit",
    });
    const { run } = await buildDump({
      journal: directory,
      runId: "native-full",
    });
    expect(run.complete).toBe(false);
    expect(run.gaps).toContainEqual({
      code: "journal-failed",
      count: 1,
      kind: "capture",
      detail: expect.stringContaining(
        `call ${loss?.callId} lost capture at model.request`,
      ),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("credential registration that cannot be recorded anywhere ends before send", async () => {
  const directory = await mkdtemp(join(tmpdir(), "neuve-capture-refusal-"));
  try {
    const source = join(directory, "source");
    await mkdir(source, { mode: 0o700 });
    const ownership = SourceOwnership.acquire(source);
    const inspection = createPrivateInspection({
      ownership,
      source,
      directory: join(directory, "private"),
      excludedRoots: [source],
    });
    try {
      const token = tokenCommand(directory, "lease");
      let sent = 0;
      const models = createRouteModels({
        route: SOL_ROUTE,
        runId: "capture-refusal",
        sessionAffinity: "capture-refusal",
        auth: { tokenCommand: token.path },
        credentialInspection: inspection,
        fetch: Object.assign(
          async () => {
            sent++;
            throw new Error("The provider must not be called");
          },
          { preconnect() {} },
        ),
        capture(event) {
          expect(event.type).toBe("credential.registration");
          throw new CaptureFailed({
            kind: "io",
            event: event.type,
            detail: "Call recording reached its cap.",
          });
        },
      });
      const model = models.getModel(SOL_ROUTE.provider, SOL_ROUTE.model)!;
      const result = await models.complete(model, {
        messages: [{ role: "user", content: "Check the work.", timestamp: 1 }],
      });
      expect(result.errorMessage).toBe(
        "OpenAI API error: capture failed, the call could not be recorded",
      );
      expect(routeFailureOf(result)).toEqual({
        kind: "capture",
        detail:
          "capture failed: credential registration was not recorded: io: Call recording reached its cap.",
      });
      expect(isRetryableAssistantError(result)).toBe(false);
      expect(result.usage.totalTokens).toBe(0);
      expect(sent).toBe(0);
      expect(token.runs()).toBe(1);
    } finally {
      await inspection.close();
      ownership.release();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
