import { dumpJournalLines } from "./fixture.ts";
import { exportWhileOpen } from "./open-source.ts";
import { captureSdk } from "./sdk-fixture.ts";
import { expect, test } from "bun:test";
import { z } from "zod";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Effect } from "effect";
import {
  exportPortableSnapshot,
  readSessionDump,
} from "@neuve/harness/session-dump";
import { createRouteModels } from "../../../src/pi/providers/agent-route-provider.ts";
import { OPUS_ROUTE, SOL_ROUTE } from "../../../src/route.ts";
import {
  deriveCapture,
  type RawCaptureSources,
} from "../../../src/pi/capture/canonical.ts";
import {
  readDump,
  writeDump,
  encodeManifest,
} from "../../../src/pi/capture/archive.ts";
import {
  readBackup,
  ProjectionRecipe,
} from "../../../src/pi/capture/sources.ts";
import {
  openCaptureJournal,
  sha256Of,
} from "../../../src/pi/capture/journal.ts";
import { Json } from "../../../src/pi/capture/types.ts";
import {
  created,
  completed,
  messageItem,
  openEndpoint,
  sse,
  tokenCommand,
} from "../providers/fixture.ts";

for (const family of ["openai", "anthropic"] as const) {
  test(`${family} original response facts reconcile every token bucket, identity and finish through the pinned decoder`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "original-response-"));
    const runId = family;
    const endpoint = openEndpoint();
    const variable = "NEUVE_ORIGINAL_RESPONSE_SYNTHETIC_KEY";
    const prior = process.env[variable];
    process.env[variable] = "synthetic-local-key";
    const journal = openCaptureJournal(join(directory, "capture"), runId);
    const route =
      family === "openai"
        ? SOL_ROUTE
        : { ...OPUS_ROUTE, credentialVariable: variable };
    const token = tokenCommand(directory, "synthetic-lease");
    journal.capture({
      type: "run.start",
      scope: { runId },
      runKind: "coding",
      sourceRevision: "synthetic",
      route: route.provider,
      pricing: family === "openai" ? "subscription" : "metered",
    });
    const database = join(directory, "pi.sqlite");
    const harness = await Harness.open(
      await openNodeSqliteStorage(database),
      {
        models: createRouteModels({
          credentialInspection: "ephemeral" as const,
          route,
          runId,
          sessionAffinity: runId,
          ...(family === "openai"
            ? { auth: { tokenCommand: token.path } }
            : {}),
          fetch: endpoint.fetch,
          capture: journal.capture,
        }),
        registry: createRegistry(),
        settings: { retry: { enabled: false }, compaction: { enabled: false } },
      },
      context,
    );
    try {
      const conversation = await harness.root(context, {
        agent: { model: { provider: family, modelId: route.model } },
      });
      journal.capture({
        type: "session.bind",
        scope: { runId, conversationId: conversation.id },
      });
      const frames =
        family === "openai"
          ? [
              created("original-response-id"),
              ...messageItem(
                0,
                "original-item",
                "final_answer",
                "ordinary answer",
              ),
              completed("original-response-id", {
                input_tokens: 49,
                output_tokens: 17,
                total_tokens: 66,
                input_tokens_details: {
                  cached_tokens: 7,
                  cache_write_tokens: 11,
                },
                output_tokens_details: { reasoning_tokens: 3 },
              }),
            ]
          : [
              {
                type: "message_start",
                message: {
                  id: "original-response-id",
                  type: "message",
                  role: "assistant",
                  model: route.model,
                  content: [],
                  usage: {
                    input_tokens: 31,
                    output_tokens: 1,
                    cache_read_input_tokens: 7,
                    cache_creation_input_tokens: 11,
                    cache_creation: { ephemeral_1h_input_tokens: 5 },
                  },
                  input_transformations: [
                    {
                      type: "synthetic",
                      path: "original-path",
                      reason: "synthetic",
                    },
                  ],
                },
              },
              {
                type: "content_block_start",
                index: 0,
                content_block: { type: "text", text: "" },
              },
              {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: "ordinary answer" },
              },
              { type: "content_block_stop", index: 0 },
              {
                type: "message_delta",
                delta: { stop_reason: "end_turn" },
                usage: {
                  output_tokens: 17,
                  output_tokens_details: { thinking_tokens: 3 },
                },
              },
              { type: "message_stop" },
            ];
      endpoint.respond(() => sse(frames));
      expect(
        (
          await (
            await conversation.submit(
              { type: "input", content: "ordinary input" },
              context,
            )
          ).wait(context)
        ).status,
      ).toBe("done");
      await harness.close(context);
      journal.capture({
        type: "run.end",
        scope: { runId },
        status: "completed",
      });
      journal.close();
      const root = join(directory, "datasets");
      await mkdir(root);
      const snapshot = await exportWhileOpen({
        runId,
        journal: journal.directory,
        nativeDatabase: database,
        root,
        retention: { policy: "synthetic response relation" },
      });
      const read = await Effect.runPromise(readSessionDump(snapshot.directory));
      expect(read.run.complete).toBe(true);
      expect(read.sessions[0]!.turns[0]!.tokens).toEqual({
        input: 31,
        output: 17,
        cacheRead: 7,
        cacheWrite: 11,
        reasoning: 3,
        totalTokens: 66,
      });
      const portable = await exportPortableSnapshot({
        directory: snapshot.directory,
        root,
        retention: { policy: "synthetic response relation" },
      });
      expect(
        (await Effect.runPromise(readSessionDump(portable.directory))).run
          .complete,
      ).toBe(true);
      const publicBundle = await readDump(portable.directory);
      const metadataMutations = [
        "withheld-empty",
        "withheld-missing",
        "withheld-extra",
        "withheld-duplicate",
        "withheld-changed",
        "withheld-absent",
        "inventory-empty",
        "inventory-missing",
        "inventory-extra",
        "inventory-duplicate",
        "inventory-hash",
        "inventory-name",
        "inventory-size",
        "inventory-media",
        "inventory-absent",
        "inspection-only",
        "source",
      ];
      for (const mutation of metadataMutations) {
        const parent = join(directory, `metadata-${mutation}`);
        await mkdir(parent);
        const changed = join(parent, basename(portable.directory));
        await cp(portable.directory, changed, { recursive: true });
        const record = structuredClone(publicBundle.record);
        if (record.redaction.mode !== "portable")
          throw new Error("expected portable metadata");
        const redaction = record.redaction;
        switch (mutation) {
          case "withheld-empty":
            redaction.withheld = [];
            break;
          case "withheld-missing":
            redaction.withheld.pop();
            break;
          case "withheld-extra":
            redaction.withheld.push("native-backup");
            break;
          case "withheld-duplicate":
            redaction.withheld[0] = "native-backup";
            break;
          case "withheld-changed":
            redaction.withheld[0] = "raw-journal";
            break;
          case "inventory-empty":
            redaction.restrictedFiles = [];
            break;
          case "inventory-missing":
            redaction.restrictedFiles.pop();
            break;
          case "inventory-extra":
            redaction.restrictedFiles.push({
              ...redaction.restrictedFiles[0]!,
              name: "invented.json",
            });
            break;
          case "inventory-duplicate":
            redaction.restrictedFiles.push(redaction.restrictedFiles[0]!);
            break;
          case "inventory-hash":
            redaction.restrictedFiles[0]!.sha256 = "0".repeat(64);
            break;
          case "inventory-name":
            redaction.restrictedFiles[0]!.name = "invented.json";
            break;
          case "inventory-size":
            redaction.restrictedFiles[0]!.size += 1;
            break;
          case "inventory-media":
            redaction.restrictedFiles[0]!.mediaType = "invented/type";
            break;
          case "source":
            record.source = `records:${record.snapshotId}`;
            break;
        }
        const serialized = JSON.stringify(record, (key, value) =>
          (mutation === "withheld-absent" && key === "withheld") ||
          (mutation === "inventory-absent" && key === "restrictedFiles")
            ? undefined
            : mutation === "inspection-only" && key === "inspectionOnly"
              ? false
              : value,
        );
        await writeFile(join(changed, "export.json"), serialized);
        await expect(readDump(changed)).rejects.toThrow();
        await expect(
          Effect.runPromise(readSessionDump(changed)),
        ).rejects.toThrow();
      }
      const copyParent = join(directory, "copied-parent");
      await mkdir(copyParent);
      const copied = join(copyParent, basename(portable.directory));
      await cp(portable.directory, copied, { recursive: true });
      expect(
        (await Effect.runPromise(readSessionDump(copied))).run.complete,
      ).toBe(true);
      for (const mutation of [
        "snapshot",
        "old-policy",
        "prior-error-policy",
      ] as const) {
        const files = new Map(publicBundle.files);
        const validation = JSON.parse(
          new TextDecoder().decode(files.get("source/validation.json")),
        );
        if (mutation === "snapshot")
          validation.restrictedSnapshot = "0".repeat(64);
        else if (mutation === "prior-error-policy") {
          validation.version = 6;
          validation.basis = "public-source-metadata-binding-v1";
        } else {
          validation.version = 3;
          validation.basis = "original-sdk-response-facts-v1";
        }
        files.set(
          "source/validation.json",
          new TextEncoder().encode(JSON.stringify(validation)),
        );
        const manifest = {
          ...publicBundle.manifest,
          files: publicBundle.manifest.files.map((file) => ({
            ...file,
            sha256: sha256Of(files.get(file.name)!),
            size: files.get(file.name)!.byteLength,
          })),
        };
        const manifestBytes = encodeManifest(manifest);
        await mkdir(join(directory, mutation));
        const changed = await writeDump({
          root: join(directory, mutation),
          manifest,
          manifestBytes,
          files,
          record: { ...publicBundle.record, manifest: sha256Of(manifestBytes) },
        });
        await expect(
          Effect.runPromise(readSessionDump(changed.directory)),
        ).rejects.toThrow(
          mutation === "snapshot"
            ? "names another restricted snapshot"
            : "policy is insufficient",
        );
      }
      const bundle = await readDump(snapshot.directory);
      const raw: RawCaptureSources = {
        native: await readBackup(bundle.files.get("native/pi.sqlite")!),
        lines: dumpJournalLines(bundle.files),
        tornLines: 0,
        backup: read.run.backup,
        journal: read.run.journal,
        artifacts: [],
      };
      const recipe = ProjectionRecipe.parse(
        JSON.parse(
          new TextDecoder().decode(bundle.files.get("source/projection.json")),
        ),
      );
      for (const sourceValidationVersion of [2, 3, 4] as const)
        expect(
          (
            await deriveCapture(runId, raw, {
              ...recipe,
              sourceValidationVersion,
            })
          ).run.complete,
        ).toBe(true);
      // These are raw-journal mutations of the actual HTTP/native control above.
      for (const type of [
        "model.request",
        "model.response",
        "model.end",
      ] as const) {
        for (const position of ["earlier", "later"] as const) {
          for (const identical of [false, true]) {
            const changed = {
              ...structuredClone(raw),
              lines: structuredClone([...raw.lines]),
            };
            const index = changed.lines.findIndex(
              ({ event }) => event.type === type,
            );
            const fact = structuredClone(changed.lines[index]!);
            if (!identical) {
              if (fact.event.type === "model.request")
                fact.event.model = "contradiction";
              if (fact.event.type === "model.response")
                fact.event.responseId = "contradiction";
              if (fact.event.type === "model.end")
                fact.event.outcome = "failed";
            }
            changed.lines = changed.lines.toSpliced(
              index + (position === "later" ? 1 : 0),
              0,
              fact,
            );
            await expect(
              deriveCapture(runId, changed, recipe),
              `${type} ${position} duplicate`,
            ).rejects.toThrow();
          }
        }
      }
      for (const outcome of ["failed", "aborted"] as const) {
        const changed = {
          ...structuredClone(raw),
          lines: structuredClone([...raw.lines]),
        };
        for (const { event } of changed.lines)
          if (event.type === "model.end") {
            event.outcome = outcome;
            delete event.stopReason;
          }
        await expect(
          deriveCapture(runId, changed, recipe),
          `terminal outcome ${outcome}`,
        ).rejects.toThrow("contradicts");
      }
      const reordered = {
        ...structuredClone(raw),
        lines: structuredClone([...raw.lines]),
      };
      const responseIndex = reordered.lines.findIndex(
        ({ event }) => event.type === "model.response",
      );
      const endIndex = reordered.lines.findIndex(
        ({ event }) => event.type === "model.end",
      );
      const end = reordered.lines.splice(endIndex, 1)[0]!;
      reordered.lines.splice(responseIndex, 0, end);
      await expect(deriveCapture(runId, reordered, recipe)).rejects.toThrow(
        "reordered response",
      );
      const orphan = {
        ...structuredClone(raw),
        lines: structuredClone([...raw.lines]),
      };
      orphan.lines = orphan.lines.filter(
        ({ event }) => event.type !== "model.request",
      );
      await expect(deriveCapture(runId, orphan, recipe)).rejects.toThrow(
        "never requested",
      );
      for (const name of [
        family === "openai" ? "response.created" : "message_start",
        family === "openai" ? "response.completed" : "message_stop",
      ]) {
        const repeated = {
          ...structuredClone(raw),
          lines: structuredClone([...raw.lines]),
        };
        const index = repeated.lines.findIndex(
          ({ event }) => event.type === "model.event" && event.name === name,
        );
        repeated.lines.splice(
          index,
          0,
          structuredClone(repeated.lines[index]!),
        );
        await expect(deriveCapture(runId, repeated, recipe)).rejects.toThrow(
          "provider lifecycle output",
        );
      }
      const afterEnd = {
        ...structuredClone(raw),
        lines: structuredClone([...raw.lines]),
      };
      afterEnd.lines.push(
        structuredClone(
          afterEnd.lines.find(
            ({ event }) =>
              event.type === "model.event" &&
              event.name ===
                (family === "openai" ? "response.completed" : "message_stop"),
          )!,
        ),
      );
      await expect(deriveCapture(runId, afterEnd, recipe)).rejects.toThrow(
        "event after its end",
      );
      const trailingMetadata = {
        ...structuredClone(raw),
        lines: structuredClone([...raw.lines]),
      };
      const last = trailingMetadata.lines.find(
        ({ event }) => event.type === "model.end",
      )!;
      if (last.event.type !== "model.end")
        throw new Error("missing actual terminal");
      trailingMetadata.lines.push({
        ...last,
        event: {
          type: "model.event",
          scope: last.event.scope,
          callId: last.event.callId,
          name: "credential_redactions",
          data: { name: "model.end", bodyRedactions: [] },
        },
      });
      expect(
        (await deriveCapture(runId, trailingMetadata, recipe)).run.complete,
      ).toBe(true);
      const changes =
        family === "openai"
          ? [
              ["response identity", "original-response-id", "contradiction"],
              ["input", '"input_tokens":49', '"input_tokens":50'],
              ["output", '"output_tokens":17', '"output_tokens":18'],
              ["cache read", '"cached_tokens":7', '"cached_tokens":8'],
              [
                "cache write",
                '"cache_write_tokens":11',
                '"cache_write_tokens":12',
              ],
              ["reasoning", '"reasoning_tokens":3', '"reasoning_tokens":4'],
              ["total", '"total_tokens":66', '"total_tokens":67'],
              [
                "finish",
                '"status":"completed"',
                '"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}',
              ],
            ]
          : [
              ["response identity", "original-response-id", "contradiction"],
              [
                "response model",
                `"model":"${route.model}"`,
                '"model":"fallback-contradiction"',
              ],
              ["input", '"input_tokens":31', '"input_tokens":32'],
              ["output", '"output_tokens":17', '"output_tokens":18'],
              [
                "cache read",
                '"cache_read_input_tokens":7',
                '"cache_read_input_tokens":8',
              ],
              [
                "cache write",
                '"cache_creation_input_tokens":11',
                '"cache_creation_input_tokens":12',
              ],
              [
                "one hour cache write",
                '"ephemeral_1h_input_tokens":5',
                '"ephemeral_1h_input_tokens":6',
              ],
              ["reasoning", '"thinking_tokens":3', '"thinking_tokens":4'],
              [
                "raw finish with same normalized stop",
                '"stop_reason":"end_turn"',
                '"stop_reason":"stop_sequence"',
              ],
              ["diagnostic details", "original-path", "contradiction"],
            ];
      for (const [name, from, to] of changes) {
        const changed = {
          ...structuredClone(raw),
          lines: structuredClone([...raw.lines]),
        };
        let count = 0;
        for (const { event } of changed.lines)
          if (event.type === "model.event") {
            const before = JSON.stringify(event.data);
            const after = before.replaceAll(from!, to!);
            if (before !== after) count++;
            event.data = Json.parse(JSON.parse(after));
          }
        expect(count, name).toBeGreaterThan(0);
        await expect(
          deriveCapture(runId, changed, recipe),
          name,
        ).rejects.toThrow("contradicts");
      }
      for (const onlyTerminal of [false, true]) {
        const changed = {
          ...structuredClone(raw),
          lines: raw.lines.filter(
            ({ event }) =>
              event.type !== "model.event" ||
              (onlyTerminal &&
                event.name !==
                  (family === "openai"
                    ? "response.completed"
                    : "message_stop")),
          ),
        };
        await expect(deriveCapture(runId, changed, recipe)).rejects.toThrow(
          "lacks required original provider",
        );
      }
      for (const mutation of [
        "missing-http-and-frames",
        "http500",
        "http401",
        "wrong-api",
        "missing-opening",
        "opening-id",
        "late-opening",
        "opening-status",
        "progress-id",
        "terminal-id",
        "initial-model",
      ] as const) {
        const changed = {
          ...structuredClone(raw),
          lines: structuredClone([...raw.lines]),
        };
        const openingIndex = changed.lines.findIndex(
          ({ event }) =>
            event.type === "model.event" &&
            event.name ===
              (family === "openai" ? "response.created" : "message_start"),
        );
        const opening = changed.lines[openingIndex]!;
        if (mutation === "missing-http-and-frames")
          changed.lines = changed.lines.filter(
            ({ event }) =>
              event.type !== "model.response" &&
              !(
                event.type === "model.event" &&
                (event.name.startsWith("response.") ||
                  event.name.startsWith("message_") ||
                  event.name.startsWith("content_block_"))
              ),
          );
        if (mutation === "http500" || mutation === "http401")
          for (const { event } of changed.lines)
            if (event.type === "model.response")
              event.status = mutation === "http500" ? 500 : 401;
        if (mutation === "wrong-api")
          for (const { event } of changed.lines)
            if (event.type === "model.request") event.api = "native-only";
        if (mutation === "missing-opening")
          changed.lines.splice(openingIndex, 1);
        if (mutation === "late-opening") {
          changed.lines.splice(openingIndex, 1);
          changed.lines.splice(openingIndex + 2, 0, opening);
        }
        if (mutation === "opening-id" && opening.event.type === "model.event")
          opening.event.data = Json.parse(
            JSON.parse(
              JSON.stringify(opening.event.data).replaceAll(
                "original-response-id",
                "contradiction",
              ),
            ),
          );
        if (mutation === "terminal-id") {
          const terminal = changed.lines.find(
            ({ event }) =>
              event.type === "model.event" &&
              event.name === "response.completed",
          );
          if (family === "anthropic") continue;
          if (terminal?.event.type === "model.event")
            terminal.event.data = Json.parse(
              JSON.parse(
                JSON.stringify(terminal.event.data).replaceAll(
                  "original-response-id",
                  "contradiction",
                ),
              ),
            );
        }
        if (mutation === "opening-status") {
          if (family === "anthropic") continue;
          if (opening.event.type === "model.event")
            opening.event.data = Json.parse(
              JSON.parse(
                JSON.stringify(opening.event.data).replace(
                  '"status":"in_progress"',
                  '"status":"failed"',
                ),
              ),
            );
        }
        if (mutation === "progress-id" || mutation === "initial-model") {
          if (family === "anthropic") continue;
          if (opening.event.type !== "model.event")
            throw new Error("missing opening");
          const progress = structuredClone(opening);
          if (progress.event.type !== "model.event")
            throw new Error("missing opening");
          progress.event.name = "response.in_progress";
          progress.event.data = {
            type: "response.in_progress",
            response: {
              id:
                mutation === "progress-id"
                  ? "contradiction"
                  : "original-response-id",
              model: "model-b",
              status: "in_progress",
            },
          };
          if (mutation === "initial-model")
            opening.event.data = {
              type: "response.created",
              response: {
                id: "original-response-id",
                model: "model-a",
                status: "in_progress",
              },
            };
          changed.lines.splice(openingIndex + 1, 0, progress);
        }
        await expect(
          deriveCapture(runId, changed, recipe),
          mutation,
        ).rejects.toThrow();
      }
      for (const status of [200, 201]) {
        const changed = structuredClone(raw);
        for (const { event } of changed.lines)
          if (event.type === "model.response") {
            event.status = status;
            event.requestId = "independent-http-trace";
          }
        expect((await deriveCapture(runId, changed, recipe)).run.complete).toBe(
          true,
        );
      }
      const changedTime = structuredClone(raw);
      for (const conversation of changedTime.native.conversations)
        for (const entry of conversation.entries)
          if (entry.kind === "pi.assistant" && entry.model) {
            entry.model = JSON.parse(
              JSON.stringify(entry.model).replace(
                /"timestamp":\d+/g,
                '"timestamp":1',
              ),
            );
          }
      expect(
        (await deriveCapture(runId, changedTime, recipe)).run.complete,
      ).toBe(true);
    } finally {
      endpoint.stop();
      if (prior === undefined) delete process.env[variable];
      else process.env[variable] = prior;
    }
  }, 60_000);
}

test("the original SDK failure reconciles with retained route details after scheduler normalization", async () => {
  const { providerOutput, reconcileProviderOutput, ResponseMessage } =
    await import("../../../src/pi/capture/provider-output.ts");
  const { CallRecord } = await import("../../../src/pi/capture/dump.ts");
  for (const api of ["openai-responses", "anthropic-messages"] as const) {
    for (const code of ["synthetic_failure", undefined]) {
      const label = api === "openai-responses" ? "OpenAI" : "Anthropic";
      const detail = `${label} API error (HTTP 200${code === undefined ? "" : `, ${code}`}): original wire failure (request request-id)`;
      const call = await captureSdk(
        CallRecord.parse({
          callId: "original-error",
          role: "turn",
          scope: { runId: "original-error" },
          route: "synthetic",
          provider: api === "anthropic-messages" ? "anthropic" : "openai",
          model: "synthetic",
          api,
          credentialCoverage: "none",
          headerNames: [],
          body: { status: "sent", json: {} },
          requestedAt: 1,
          response: {
            at: 2,
            status: 200,
            requestId: "request-id",
            responseId: "response-id",
          },
          events: (api === "openai-responses"
            ? [
                created("response-id"),
                {
                  type: "response.failed",
                  response: {
                    id: "response-id",
                    status: "failed",
                    error: { code, message: "original wire failure" },
                  },
                },
              ]
            : [
                {
                  type: "message_start",
                  message: { id: "response-id", model: "synthetic", usage: {} },
                },
                {
                  type: "error",
                  error: { type: code, message: "original wire failure" },
                },
              ]
          ).map((event) => ({
            at: 3,
            name: event.type,
            data: JSON.parse(JSON.stringify(event)),
          })),
          end: {
            at: 4,
            outcome: "failed",
            responseId: "response-id",
            stopReason: "error",
            error: { type: code ?? "stream", message: detail },
          },
        }),
      );
      const output = await providerOutput(call);
      if (output === null) throw new Error("missing original error fixture");
      const message = ResponseMessage.parse({
        content: [],
        responseId: "response-id",
        usage: { ...output.usage, cost: { total: 0 } },
        stopReason: "error",
        rawStopReason: api === "openai-responses" ? "failed" : undefined,
        errorMessage: `${label} API error: the stream failed or ended without a terminal event`,
        diagnostics: [
          {
            type: "neuve.route_failure",
            timestamp: 99,
            details: {
              kind: "stream",
              status: 200,
              ...(code === undefined ? {} : { code }),
              requestId: "request-id",
              detail,
            },
          },
        ],
      });
      expect(() =>
        reconcileProviderOutput(call, output, message),
      ).not.toThrow();
      const changed = structuredClone(call);
      changed.events[1]!.data = Json.parse(
        JSON.parse(
          JSON.stringify(changed.events[1]!.data).replace(
            "original wire failure",
            "contradictory wire failure",
          ),
        ),
      );
      const contradiction = await providerOutput(changed);
      if (contradiction === null)
        throw new Error("missing contradictory error fixture");
      expect(() =>
        reconcileProviderOutput(call, contradiction, message),
      ).toThrow("contradicts native assistant output");
      const nativeChange = structuredClone(message);
      nativeChange.diagnostics![0]!.details = {
        kind: "stream",
        status: 200,
        code: code ?? null,
        requestId: "request-id",
        detail: "contradictory retained detail",
      };
      expect(() => reconcileProviderOutput(call, output, nativeChange)).toThrow(
        "contradicts native assistant output",
      );
    }
  }
});

test("an initial OpenAI error reconciles its wire code and bounded detail without a successful opening", async () => {
  const { providerOutput, reconcileProviderOutput } =
    await import("../../../src/pi/capture/provider-output.ts");
  const { CallRecord } = await import("../../../src/pi/capture/dump.ts");
  const message = "initial failure ".repeat(30);
  const call = await captureSdk(
    CallRecord.parse({
      callId: "initial-error",
      role: "unjoined",
      scope: { runId: "initial-error" },
      route: "synthetic",
      provider: "openai",
      model: "synthetic",
      api: "openai-responses",
      credentialCoverage: "none",
      headerNames: [],
      body: { status: "sent", json: {} },
      requestedAt: 1,
      response: { at: 2, status: 200, requestId: "trace" },
      events: [
        {
          at: 3,
          name: "error",
          data: { type: "error", code: "synthetic_error", message },
        },
      ],
      end: {
        at: 4,
        outcome: "failed",
        stopReason: "error",
        error: {
          type: "synthetic_error",
          message: `OpenAI API error (HTTP 200, synthetic_error): ${message.slice(0, 300)} (request trace)`,
        },
      },
    }),
  );
  const output = await providerOutput(call);
  if (output === null) throw new Error("missing initial error output");
  expect(output.responseId).toBeNull();
  expect(() => reconcileProviderOutput(call, output)).not.toThrow();
  const changed = structuredClone(call);
  changed.events[0]!.data = { type: "error", code: "contradiction", message };
  const contradiction = await providerOutput(changed);
  if (contradiction === null) throw new Error("missing changed initial error");
  expect(() => reconcileProviderOutput(changed, contradiction)).toThrow(
    "contradicts",
  );
});

test("nested OpenAI stream errors reconcile the SDK, production route and native capture", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nested-stream-error-"));
  const runId = "synthetic-nested-error";
  const endpoint = openEndpoint();
  const journal = openCaptureJournal(join(directory, "capture"), runId);
  const database = join(directory, "pi.sqlite");
  const token = tokenCommand(directory, "synthetic-lease");
  journal.capture({
    type: "run.start",
    scope: { runId },
    runKind: "coding",
    sourceRevision: "synthetic",
    route: SOL_ROUTE.provider,
    pricing: "subscription",
  });
  const harness = await Harness.open(
    await openNodeSqliteStorage(database),
    {
      models: createRouteModels({
        credentialInspection: "ephemeral" as const,
        route: SOL_ROUTE,
        runId,
        sessionAffinity: runId,
        auth: { tokenCommand: token.path },
        fetch: endpoint.fetch,
        capture: journal.capture,
      }),
      registry: createRegistry(),
      settings: { retry: { enabled: false }, compaction: { enabled: false } },
    },
    context,
  );
  try {
    const conversation = await harness.root(context, {
      agent: { model: { provider: "openai", modelId: SOL_ROUTE.model } },
    });
    journal.capture({
      type: "session.bind",
      scope: { runId, conversationId: conversation.id },
    });
    endpoint.respond(() =>
      sse([
        created("synthetic-nested-response"),
        {
          type: "response.in_progress",
          response: { id: "synthetic-nested-response", status: "in_progress" },
        },
        {
          type: "error",
          sequence_number: 2,
          error: {
            code: "synthetic_failure",
            message: "synthetic nested provider failure",
          },
        },
      ]),
    );
    const settled = await (
      await conversation.submit(
        { type: "input", content: "synthetic input" },
        context,
      )
    ).wait(context);
    expect(settled.status).toBe("unanswered");
    await harness.close(context);
    journal.capture({ type: "run.end", scope: { runId }, status: "failed" });
    journal.close();
    const root = join(directory, "datasets");
    await mkdir(root);
    const snapshot = await exportWhileOpen({
      runId,
      journal: journal.directory,
      nativeDatabase: database,
      root,
      retention: { policy: "synthetic nested error regression" },
    });
    const read = await Effect.runPromise(readSessionDump(snapshot.directory));
    expect(read.run.complete).toBe(true);
    const bundle = await readDump(snapshot.directory);
    const raw: RawCaptureSources = {
      native: await readBackup(bundle.files.get("native/pi.sqlite")!),
      lines: dumpJournalLines(bundle.files),
      tornLines: 0,
      backup: read.run.backup,
      journal: read.run.journal,
      artifacts: [],
    };
    const recipe = ProjectionRecipe.parse(
      JSON.parse(
        new TextDecoder().decode(bundle.files.get("source/projection.json")),
      ),
    );
    const { callsOf } =
      await import("../../../src/pi/capture/call-lifecycle.ts");
    const { nativeScopes } = await import("../../../src/pi/capture/scope.ts");
    const { providerOutput } =
      await import("../../../src/pi/capture/provider-output.ts");
    const call = [
      ...callsOf(raw.lines, true, nativeScopes(raw.native, runId)).values(),
    ][0]!;
    const output = await providerOutput(call);
    expect(output?.content).toEqual([]);
    expect(output?.finish).toEqual({
      stopReason: "error",
      rawStopReason: null,
      errorMessage: "synthetic nested provider failure",
    });
    expect(output?.usage).toMatchObject({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
    });
    const assistant = z
      .record(z.string(), Json)
      .parse(
        raw.native.conversations
          .flatMap(({ entries }) => entries)
          .find(({ kind }) => kind === "pi.assistant")?.model?.[0],
      );
    const diagnostics = z
      .array(z.object({ type: z.string(), details: Json.optional() }))
      .parse(assistant["diagnostics"]);
    const original = diagnostics.findLast(
      ({ type }) => type === "neuve.route_failure",
    );
    if (original === undefined) throw new Error("missing native route failure");
    const originalDetails = z.record(z.string(), Json).parse(original.details);
    const contradictory = {
      type: "neuve.route_failure",
      timestamp: 0,
      details: {
        kind: "auth",
        status: 403,
        code: "contradictory_code",
        detail: "contradictory final diagnostic",
      },
    };
    const diagnosticCases = [
      {
        label: "earlier failure then valid final failure",
        values: [contradictory, original],
        valid: true,
      },
      {
        label: "unrelated diagnostic after valid final failure",
        values: [
          contradictory,
          original,
          { type: "synthetic.other", details: { kind: "auth" } },
        ],
        valid: true,
      },
      {
        label: "repeated valid failures",
        values: [original, original],
        valid: true,
      },
      {
        label: "contradictory final failure",
        values: [original, contradictory],
        valid: false,
      },
      ...[
        null,
        [],
        "malformed",
        { kind: "unknown_kind" },
        { kind: "stream" },
        { ...originalDetails, status: "200" },
        { ...originalDetails, code: 7 },
        { ...originalDetails, requestId: 7 },
        { ...originalDetails, detail: 7 },
      ].map((details) => ({
        label: `malformed final diagnostic ${JSON.stringify(details)}`,
        values: [original, { type: "neuve.route_failure", details }],
        valid: false,
      })),
    ];
    for (const { label, values, valid } of diagnosticCases) {
      const changed = structuredClone(raw);
      for (const conversation of changed.native.conversations)
        for (const entry of conversation.entries) {
          if (entry.kind !== "pi.assistant" || !entry.model) continue;
          const message = z.record(z.string(), Json).parse(entry.model[0]);
          entry.model[0] = Json.parse({ ...message, diagnostics: values });
        }
      if (valid)
        expect(
          (await deriveCapture(runId, changed, recipe)).run.complete,
          label,
        ).toBe(true);
      else
        await expect(
          deriveCapture(runId, changed, recipe),
          label,
        ).rejects.toThrow("contradicts");
    }
    for (const mutation of [
      "message",
      "code",
      "end",
      "diagnostic",
      "native-message",
    ] as const) {
      const changed = structuredClone(raw);
      for (const { event } of changed.lines) {
        if (event.type === "model.event" && event.name === "error") {
          if (mutation === "message")
            event.data = {
              type: "error",
              error: {
                code: "synthetic_failure",
                message: "contradictory nested provider failure",
              },
            };
          if (mutation === "code")
            event.data = {
              type: "error",
              error: {
                code: "contradictory_code",
                message: "synthetic nested provider failure",
              },
            };
        }
        if (mutation === "end" && event.type === "model.end" && event.error)
          event.error.message = "contradictory terminal failure";
      }
      for (const conversation of changed.native.conversations)
        for (const entry of conversation.entries) {
          if (entry.kind !== "pi.assistant" || !entry.model) continue;
          entry.model = JSON.parse(
            JSON.stringify(entry.model).replace(
              mutation === "diagnostic"
                ? "synthetic nested provider failure"
                : mutation === "native-message"
                  ? "the stream failed or ended without a terminal event"
                  : "never-present",
              "contradictory native failure",
            ),
          );
        }
      await expect(
        deriveCapture(runId, changed, recipe),
        mutation,
      ).rejects.toThrow("contradicts");
    }
    const portable = await exportPortableSnapshot({
      directory: snapshot.directory,
      root,
      retention: { policy: "synthetic nested error regression" },
    });
    expect(
      (await Effect.runPromise(readSessionDump(portable.directory))).run
        .complete,
    ).toBe(true);
  } finally {
    endpoint.stop();
  }
}, 60_000);

test("OpenAI error envelope precedence refuses contradictory and unsupported forms", async () => {
  const { providerOutput, reconcileProviderOutput } =
    await import("../../../src/pi/capture/provider-output.ts");
  const { CallRecord } = await import("../../../src/pi/capture/dump.ts");
  const message = "synthetic bounded nested failure ".repeat(20);
  const detail = { code: "synthetic_code", message };
  const cases = [
    { data: { type: "error", ...detail }, valid: true },
    { data: { type: "error", ...detail, error: null }, valid: true },
    { data: { type: "error", error: detail }, valid: true },
    {
      data: {
        type: "error",
        code: "decoy",
        message: "flat decoy",
        error: detail,
      },
      valid: true,
    },
    {
      data: { type: "error", error: { type: "synthetic_code", message } },
      valid: true,
    },
    {
      data: {
        type: "error",
        ...detail,
        error: {
          code: "other",
          message: `Error Code synthetic_code: ${message}`,
        },
      },
      valid: false,
    },
    { data: { type: "error", ...detail, error: "unsupported" }, valid: false },
    { data: { type: "error", ...detail, error: [] }, valid: false },
    {
      data: { type: "error", ...detail, error: { code: 7, message } },
      valid: false,
    },
    {
      data: {
        type: "error",
        ...detail,
        error: { code: "synthetic_code", message: "" },
      },
      valid: false,
    },
    {
      data: {
        type: "error",
        ...detail,
        error: { code: "synthetic_code", message: { text: message } },
      },
      valid: false,
    },
  ];
  for (const { data, valid } of cases) {
    const call = await captureSdk(
      CallRecord.parse({
        callId: "synthetic-precedence",
        role: "unjoined",
        scope: { runId: "synthetic-precedence" },
        route: "synthetic",
        provider: "openai",
        model: "synthetic",
        api: "openai-responses",
        credentialCoverage: "none",
        headerNames: [],
        body: { status: "sent", json: {} },
        requestedAt: 1,
        response: { at: 2, status: 200, requestId: "synthetic-trace" },
        events: [{ at: 3, name: "error", data }],
        end: {
          at: 4,
          outcome: "failed",
          stopReason: "error",
          error: {
            type: "synthetic_code",
            message: `OpenAI API error (HTTP 200, synthetic_code): ${message.slice(0, 300)} (request synthetic-trace)`,
          },
        },
      }),
    );
    const output = await providerOutput(call);
    if (output === null) throw new Error("missing synthetic precedence output");
    if (valid) {
      expect(output.finish?.errorMessage).toBe(message);
      expect(() => reconcileProviderOutput(call, output)).not.toThrow();
    } else
      expect(() => reconcileProviderOutput(call, output)).toThrow(
        "contradicts",
      );
  }
});
