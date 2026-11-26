// Why: a local capture refusal crosses an SDK that can report it as a connection error.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryCredentialStore,
  isRetryableAssistantError,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { storeLocationIn } from "@neuve/records-core";
import { openRunLog } from "../../../src/run-log.ts";
import { SOL_ROUTE } from "../../../src/route.ts";
import { SourceOwnership } from "../../../src/pi/source-ownership.ts";
import { createPrivateInspection } from "../../../src/pi/capture/private-inspection.ts";
import {
  JOURNAL_FILE,
  openCaptureJournal,
} from "../../../src/pi/capture/journal.ts";
import { CaptureFailed } from "../../../src/pi/capture/types.ts";
import { createRouteModels } from "../../../src/pi/providers/agent-route-provider.ts";
import { captureNativeModels } from "../../../src/pi/providers/native-models-capture.ts";
import { routeFailureOf } from "../../../src/pi/providers/failure.ts";
import { created, sse, tokenCommand } from "./fixture.ts";

test("capture exhaustion fails the first call, the next call, and a reopened call", async () => {
  const directory = await mkdtemp(join(tmpdir(), "neuve-full-capture-"));
  const runId = "full-capture";
  const limits = {
    objectBytes: 16384,
    totalBytes: 16384,
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
      let sent = 0;
      const open = () => {
        const journal = openCaptureJournal(join(directory, "capture"), runId, {
          limits,
          log,
        });
        const models = createRouteModels({
          route: SOL_ROUTE,
          log,
          runId,
          sessionAffinity: runId,
          auth: { tokenCommand: token.path },
          credentialInspection: inspection,
          capture: journal.capture,
          fetch: Object.assign(
            async () => {
              sent++;
              const size = statSync(join(journal.directory, JOURNAL_FILE)).size;
              return sse([
                created("resp_full"),
                {
                  type: "response.output_text.delta",
                  delta: "x".repeat(
                    Math.max(0, limits.journalBytes - size - 925),
                  ),
                },
                { type: "response.output_text.delta", delta: "x".repeat(4096) },
              ]);
            },
            { preconnect() {} },
          ),
        });
        const model = models.getModel(SOL_ROUTE.provider, SOL_ROUTE.model);
        if (!model) throw new Error("Expected coding route model");
        return () =>
          models.complete(model, {
            systemPrompt: "Review the code.",
            messages: [
              { role: "user", content: "Check the work.", timestamp: 1 },
            ],
          });
      };
      const complete = open();
      const first = await complete();
      const next = await complete();
      const reopened = await open()();
      const failures = [first, next, reopened].map(routeFailureOf);
      console.log(JSON.stringify({ failures, sent }));
      expect(failures.map((failure) => failure?.kind)).toEqual([
        "capture",
        "capture",
        "capture",
      ]);
      for (const [index, result] of [first, next, reopened].entries()) {
        expect(failures[index]?.detail).toContain(
          "would grow over the 4096-byte limit",
        );
        expect(failures[index]?.code).toBe("capture_full");
        expect(result.errorMessage).toBe(
          "OpenAI API error: the capture journal is full",
        );
        expect(isRetryableAssistantError(result)).toBe(false);
      }
      expect(sent).toBe(1);
      await log.flush?.();
      const calls = log.read().filter(({ type }) => type === "model.call");
      expect(
        calls.map(({ failureKind, sentAt }) => [
          failureKind,
          typeof sentAt === "string",
        ]),
      ).toEqual([
        ["capture", true],
        ["capture", false],
        ["capture", false],
      ]);
      for (const row of log.read())
        if (row.type === "model.call" || row.name === "harness.journal.append")
          console.log(JSON.stringify(row));
    } finally {
      await inspection.close();
      ownership.release();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a native provider does not retry a full capture as a connection error", async () => {
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
      capture(event) {
        if (event.type === "model.request") dispatches++;
        journal.capture(event);
      },
      fetch: Object.assign(
        async () => {
          sent++;
          return sse([]);
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
    expect(routeFailureOf(result)).toEqual({
      kind: "capture",
      code: "capture_full",
      detail: "events.jsonl would grow over the 400-byte limit",
    });
    expect(result.errorMessage).toBe(
      "Model error: the capture journal is full",
    );
    expect(isRetryableAssistantError(result)).toBe(false);
    expect([dispatches, sent]).toEqual([1, 0]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a full capture journal during credential registration ends before send", async () => {
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
