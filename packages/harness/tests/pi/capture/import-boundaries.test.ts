import * as CaptureRecords from "../../../src/pi/capture/records.ts";
// These fixtures cross the native, folder and Records boundaries because per-file schemas and
// checksum checks alone cannot prove portable withholding, provenance or bounded reads.
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit } from "effect";
import { Blobs, Log, storeLocationIn } from "@neuve/records-core";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import {
  Harness,
  createRegistry,
  defineExtension,
  defineTool,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  DumpManifest,
  ExportRecord,
  encodeManifest,
} from "../../../src/pi/capture/archive.ts";
import { SessionDump } from "../../../src/pi/capture/dump.ts";
import {
  exportSnapshot,
  exportPortableSnapshot,
  readSessionDump,
  readCapturedDump,
  type RestoredDump,
} from "../../../src/pi/capture/export.ts";
import {
  openCaptureJournal,
  sha256Of,
} from "../../../src/pi/capture/journal.ts";
import { maskRecord } from "../../../src/pi/capture/mask.ts";
import { DEFAULT_LIMITS } from "../../../src/pi/capture/types.ts";
import { MODEL, route, runIn, usage, value } from "./fixture.ts";

const directory = mkdtempSync(join(tmpdir(), "harness-import-boundaries-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const root = join(directory, "dataset");
const originalArtifact = new TextEncoder().encode(
  ' {"type":"reasoning","summary":[{"type":"summary_text","text":"SYNTHETIC_SUMMARY"}],"encrypted_content":"SYNTHETIC_CONTINUATION"} \n',
);
const reasoning = JSON.parse(new TextDecoder().decode(originalArtifact));
const serializedReasoning = JSON.stringify(reasoning);
const wrappedReasoning = JSON.stringify(serializedReasoning);
const nestedArtifact = new TextEncoder().encode(
  JSON.stringify({
    structured: reasoning,
    serialized: serializedReasoning,
    wrapped: wrappedReasoning,
    ordinary:
      "The words encrypted_content and summary describe protocol fields.",
  }),
);
let restored: RestoredDump;
let source: string;
const schema = Type.Object({
  recipient: Type.String({
    default: "ann@example.com",
    examples: ["ann@example.com"],
  }),
});

beforeAll(async () => {
  mkdirSync(root);
  const scope = { runId: "BOUNDARIES" };
  const at = join(directory, "journal");
  const journal = openCaptureJournal(at, scope.runId);
  journal.capture({
    type: "run.start",
    scope,
    runKind: "coding",
    sourceRevision: "fixture",
    route: "chatgpt",
    pricing: "subscription",
  });
  const routed = route(journal.capture, scope);
  routed.faux.setResponses([
    routed.step(
      fauxAssistantMessage("done", { responseId: "boundary-response" }),
      usage(17, 3),
    ),
  ]);
  const Extension = defineExtension({
    name: "schema.fixture",
    tools: [
      defineTool({
        name: "notify",
        description: "Fixture",
        parameters: schema,
        execute: async () => ({ content: [{ type: "text", text: "unused" }] }),
      }),
    ],
  });
  const registry = createRegistry();
  registry.install(Extension);
  const database = join(directory, "pi.sqlite");
  const harness = await Harness.open(
    await openNodeSqliteStorage(database),
    { registry, models: routed.models },
    BACKGROUND_CONTEXT,
  );
  const conversation = await harness.root(BACKGROUND_CONTEXT, {
    agent: { model: MODEL, extensions: [Extension] },
  });
  journal.capture({
    type: "session.bind",
    scope: { ...scope, conversationId: conversation.id },
  });
  await (
    await conversation.submit(
      {
        type: "input",
        content: wrappedReasoning,
        requestId: "boundary-submit",
      },
      BACKGROUND_CONTEXT,
    )
  ).wait(BACKGROUND_CONTEXT);
  journal.capture({
    type: "artifact",
    scope,
    name: "reasoning.json",
    mediaType: "application/json",
    bytes: originalArtifact,
  });
  for (const mediaType of ["application/json", "text/plain"])
    journal.capture({
      type: "artifact",
      scope,
      name: `nested.${mediaType === "text/plain" ? "txt" : "json"}`,
      mediaType,
      bytes: nestedArtifact,
    });
  journal.capture({ type: "run.end", scope, status: "completed" });
  await harness.close(BACKGROUND_CONTEXT);
  journal.close();
  const storage = await openNodeSqliteStorage(database);
  try {
    const exported = await exportSnapshot({
      runId: scope.runId,
      journal: at,
      native: { reads: storage, context: BACKGROUND_CONTEXT },
      nativeDatabase: database,
      root,
      retention: { policy: "fixture" },
    });
    source = exported.directory;
    restored = await Effect.runPromise(readSessionDump(source));
  } finally {
    await storage.close(BACKGROUND_CONTEXT);
  }
});

test("portable JSON artifacts withhold reasoning and carry their transformed checksums while restricted originals stay exact", async () => {
  const originalManifest = readFileSync(join(source, "manifest.json"));
  const portable = await exportPortableSnapshot({
    directory: source,
    root,
    retention: { policy: "fixture" },
  });
  const read = await Effect.runPromise(readSessionDump(portable.directory));
  const artifact = read.run.artifacts[0]!;
  const bytes = read.artifacts.get(artifact.file!)!;
  const parsed = JSON.parse(new TextDecoder().decode(bytes));
  expect(parsed).toEqual({
    type: "reasoning",
    summary: [
      {
        type: "summary_text",
        text: "<withheld: reasoning summary, 17 characters>",
      },
    ],
    encrypted_content: expect.stringContaining(
      "<withheld: encrypted reasoning",
    ),
  });
  expect([artifact.sha256, artifact.size]).toEqual([
    sha256Of(bytes),
    bytes.byteLength,
  ]);
  expect(artifact.original).toEqual({
    file: null,
    sha256: sha256Of(originalArtifact),
    size: originalArtifact.byteLength,
  });
  const restrictedArtifact = restored.run.artifacts[0]!;
  expect(
    new Uint8Array(
      readFileSync(join(source, "objects", restrictedArtifact.original.sha256)),
    ),
  ).toEqual(originalArtifact);
  expect(readFileSync(join(source, "manifest.json"))).toEqual(originalManifest);
});

test("portable native content and artifacts withhold structured, serialized and wrapped reasoning while originals stay exact", async () => {
  const portable = await exportPortableSnapshot({
    directory: source,
    root,
    retention: { policy: "fixture" },
  });
  const read = await Effect.runPromise(readSessionDump(portable.directory));
  expect(JSON.stringify(read.sessions)).not.toContain("SYNTHETIC_");
  expect(JSON.stringify(restored.sessions)).toContain("SYNTHETIC_SUMMARY");
  expect(JSON.stringify(restored.sessions)).toContain("SYNTHETIC_CONTINUATION");
  for (const artifact of read.run.artifacts.slice(1)) {
    const bytes = read.artifacts.get(artifact.file!)!;
    const text = new TextDecoder().decode(bytes);
    expect(text).not.toContain("SYNTHETIC_");
    const payload = JSON.parse(text);
    expect(JSON.parse(payload.serialized)).toEqual(payload.structured);
    expect(JSON.parse(JSON.parse(payload.wrapped))).toEqual(payload.structured);
    expect(payload.ordinary).toBe(
      "The words encrypted_content and summary describe protocol fields.",
    );
    expect(artifact.sha256).toBe(sha256Of(bytes));
    const original = restored.run.artifacts.find(
      (a) => a.name === artifact.name,
    )!;
    expect(
      new Uint8Array(
        readFileSync(join(source, "objects", original.original.sha256)),
      ),
    ).toEqual(nestedArtifact);
  }
});

test("native offered-schema defaults and examples are content while schema tokens and source inputs stay exact", () => {
  expect(restored.sessions[0]!.offeredTools[0]!.added[0]).toMatchObject({
    parameters: {
      type: "object",
      required: ["recipient"],
      properties: {
        recipient: {
          type: "string",
          default: "<email>",
          examples: ["<email>"],
        },
      },
    },
  });
  expect(schema.properties.recipient).toMatchObject({
    default: "ann@example.com",
    examples: ["ann@example.com"],
  });
  expect(
    maskRecord(
      {
        parameters: {
          type: "object",
          properties: {
            default: {
              type: "string",
              default: { name: "ann@example.com", type: "ann@example.com" },
              examples: [{ id: "ann@example.com" }],
              enum: ["token"],
            },
          },
          required: ["default"],
          $defs: { examples: { type: "string", default: "ann@example.com" } },
        },
      },
      ["string", "object", "token", "default"],
    ),
  ).toEqual({
    parameters: {
      type: "object",
      properties: {
        default: {
          type: "string",
          default: { name: "<email>", type: "<email>" },
          examples: [{ id: "<email>" }],
          enum: ["token"],
        },
      },
      required: ["default"],
      $defs: { examples: { type: "string", default: "<email>" } },
    },
  });
});

test("the restricted native backup restores the original offered schema without a model", async () => {
  expect(restored.run.backup.status).toBe("captured");
  if (restored.run.backup.status !== "captured")
    throw new Error("missing native backup");
  const database = join(directory, "restored.sqlite");
  writeFileSync(
    database,
    readFileSync(join(source, "objects", restored.run.backup.sha256)),
  );
  const storage = await openNodeSqliteStorage(database);
  try {
    const conversation = (
      await storage.scanConversations({}, 100, undefined, BACKGROUND_CONTEXT)
    ).items[0]!;
    expect(Number(conversation.id)).toBe(restored.sessions[0]!.conversationId);
    const entries = await storage.scanEntries(
      { conversationId: conversation.id },
      100,
      undefined,
      BACKGROUND_CONTEXT,
    );
    const system = entries.items.find((entry) => entry.kind === "pi.system");
    expect(system?.model).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolsAdded: [
            expect.objectContaining({
              parameters: expect.objectContaining({
                properties: {
                  recipient: {
                    type: "string",
                    default: "ann@example.com",
                    examples: ["ann@example.com"],
                  },
                },
              }),
            }),
          ],
        }),
      ]),
    );
  } finally {
    await storage.close(BACKGROUND_CONTEXT);
  }
});

const alteredFile = (name: string, value: unknown) => {
  const manifest = DumpManifest.parse(
    JSON.parse(readFileSync(join(source, "manifest.json"), "utf8")),
  );
  const record = ExportRecord.parse(
    JSON.parse(readFileSync(join(source, "export.json"), "utf8")),
  );
  const sessionFile = manifest.files.find((file) => file.name === name)!;
  const bytes = new TextEncoder().encode(JSON.stringify(value) + "\n");
  const files = manifest.files.map((file) =>
    file === sessionFile
      ? { ...file, sha256: sha256Of(bytes), size: bytes.byteLength }
      : file,
  );
  const manifestBytes = encodeManifest({ ...manifest, files });
  const snapshotId = sha256Of(manifestBytes);
  const target = join(directory, snapshotId);
  mkdirSync(join(target, "objects"), { recursive: true });
  for (const file of files)
    writeFileSync(
      join(target, "objects", file.sha256),
      file.name === sessionFile.name
        ? bytes
        : readFileSync(join(source, "objects", file.sha256)),
    );
  writeFileSync(join(target, "manifest.json"), manifestBytes);
  writeFileSync(
    join(target, "export.json"),
    JSON.stringify({ ...record, snapshotId, manifest: snapshotId }),
  );
  return target;
};

const alteredSession = (change: (session: SessionDump) => unknown) =>
  alteredFile(
    restored.run.sessions[0]!.file,
    change(structuredClone(restored.sessions[0]!)),
  );

// Why: checksums and two equally deleted projections do not establish native coverage or totals.
test("public reads reject inverse native coverage and contradictory session aggregates", async () => {
  const changes: Array<(session: SessionDump) => unknown> = [
    (session) => ({ ...session, turns: [], calls: [] }),
    (session) => {
      session.totals.turns.tokens.totalTokens = 999999;
      return session;
    },
    (session) => {
      session.totals.ledger!.tokens.totalTokens = 999999;
      return session;
    },
    (session) => ({ ...session, totals: { ...session.totals, ledger: null } }),
    (session) => {
      session.turns[0]!.cost.recorded = {
        status: "recorded",
        currency: "USD",
        total: 42,
      };
      return session;
    },
    (session) => {
      session.totals.turns.cost.recorded = {
        status: "recorded",
        currency: "USD",
        total: 42,
      };
      return session;
    },
    (session) => {
      session.totals.ledger!.cost.estimate = { rate: "invented@1", total: 42 };
      return session;
    },
    (session) => {
      session.calls[0]!.end!.usage!.output += 1;
      return session;
    },
    (session) => ({
      ...session,
      totals: { ...session.totals, auxiliary: session.totals.turns },
    }),
  ];
  for (const change of changes)
    await expect(
      Effect.runPromise(readSessionDump(alteredSession(change))),
    ).rejects.toMatchObject({ _tag: "DumpRejected" });
});

test("public reads reject contradictory run totals, stage totals and pricing provenance", async () => {
  const changes = [
    {
      ...restored.run,
      totals: {
        ...restored.run.totals,
        tokens: { ...restored.run.totals.tokens, totalTokens: 999999 },
      },
    },
    {
      ...restored.run,
      stages: [
        {
          stage: "absent",
          status: "unknown",
          sessions: [],
          totals: restored.run.totals,
        },
      ],
    },
    { ...restored.run, pricing: "metered" },
    {
      ...restored.run,
      totals: {
        ...restored.run.totals,
        cost: {
          recorded: { status: "recorded", total: 42, currency: "USD" },
          estimate: null,
        },
      },
    },
  ];
  for (const run of changes)
    await expect(
      Effect.runPromise(readSessionDump(alteredFile("run.json", run))),
    ).rejects.toMatchObject({ _tag: "DumpRejected" });
});

test("the importer refuses checksummed but contradictory session, entry and call provenance", async () => {
  const changes: Array<(session: SessionDump) => unknown> = [
    (session) => ({ ...session, conversationId: 999 }),
    (session) => ({
      ...session,
      binding: { ...session.binding, taskId: 9999 },
    }),
    (session) => ({
      ...session,
      binding: { ...session.binding, inheritedFrom: 9999 },
    }),
    ...(
      [
        "input",
        "output",
        "cacheRead",
        "cacheWrite",
        "reasoning",
        "totalTokens",
      ] as const
    ).map((key) => (session: SessionDump) => ({
      ...session,
      turns: session.turns.map((turn) => ({
        ...turn,
        tokens: { ...turn.tokens, [key]: 9999 },
      })),
    })),
    (session) => ({
      ...session,
      entries: session.entries.map((entry) =>
        typeof entry === "object" && entry !== null && !Array.isArray(entry)
          ? { ...entry, head: 9999 }
          : entry,
      ),
    }),
    (session) => ({
      ...session,
      entries: session.entries.map((entry) =>
        typeof entry === "object" && entry !== null && !Array.isArray(entry)
          ? { ...entry, edits: [{ target: 9999, action: "omit" }] }
          : entry,
      ),
    }),
    (session) => ({
      ...session,
      owner: { conversationId: 9999, taskId: 9999 },
    }),
    (session) => ({ ...session, parent: { conversationId: 9999, at: 9999 } }),
    (session) => ({
      ...session,
      parent: {
        conversationId: session.conversationId,
        at: session.turns[0]!.entryId,
      },
    }),
    (session) => ({
      ...session,
      entries: session.entries.map((entry) =>
        typeof entry === "object" && entry !== null && !Array.isArray(entry)
          ? { ...entry, conversationId: 999 }
          : entry,
      ),
    }),
    (session) => ({
      ...session,
      turns: session.turns.map((turn) => ({ ...turn, entryId: 999 })),
    }),
    (session) => ({
      ...session,
      turns: session.turns.map((turn) => ({ ...turn, callId: "missing-call" })),
    }),
    (session) => ({
      ...session,
      calls: session.calls.map((call) => ({
        ...call,
        scope: { ...call.scope, entryId: 9999 },
      })),
    }),
    (session) => ({
      ...session,
      calls: session.calls.map((call) => ({
        ...call,
        scope: { ...call.scope, taskId: 9999 },
      })),
    }),
    (session) => ({
      ...session,
      calls: session.calls.map((call) => ({
        ...call,
        logicalRoute: "other-native-route",
      })),
    }),
    (session) => ({
      ...session,
      calls: session.calls.map((call) => ({
        ...call,
        scope: { ...call.scope, conversationId: 999 },
      })),
    }),
    (session) => ({
      ...session,
      calls: session.calls.map((call) => ({
        ...call,
        scope: { ...call.scope, runId: "other-run" },
      })),
    }),
    (session) => ({
      ...session,
      calls: session.calls.map((call) => ({
        ...call,
        end: call.end && { ...call.end, responseId: "other-response" },
      })),
    }),
    (session) => ({
      ...session,
      turns: session.turns.map((turn) => ({
        ...turn,
        responseId: "other-response",
      })),
      calls: session.calls.map((call) => ({
        ...call,
        response: call.response && {
          ...call.response,
          responseId: "other-response",
        },
        end: call.end && { ...call.end, responseId: "other-response" },
      })),
    }),
    (session) => ({
      ...session,
      tasks: session.tasks.map((task) =>
        typeof task === "object" && task !== null && !Array.isArray(task)
          ? { ...task, conversationId: 999 }
          : task,
      ),
    }),
    (session) => ({ ...session, calls: [...session.calls, ...session.calls] }),
    (session) => ({
      ...session,
      offeredTools: session.offeredTools.map((tools) => ({
        ...tools,
        entryId: 999,
      })),
    }),
    (session) => ({
      ...session,
      turns: session.turns.map((turn) => ({ ...turn, requestedAt: 999 })),
    }),
  ];
  for (const change of changes) {
    const result = await Effect.runPromiseExit(
      readSessionDump(alteredSession(change)),
    );
    expect(Exit.isFailure(result) && Cause.squash(result.cause)).toMatchObject({
      _tag: "DumpRejected",
      message: expect.stringMatching(/\S/),
    });
  }
  // Alone 0.19-0.30 s; 10x slowest, at least 30 s; SQLite and capture I/O under load.
}, 30_000);

test("Records manifest and object metadata are bounded before fetching bytes, with checksums still verified", async () => {
  const run = runIn(storeLocationIn(join(directory, "records")));
  const result = value(
    await run(
      Effect.gen(function* () {
        const blobs = yield* Blobs.BlobStore;
        const reads: Array<string> = [];
        const measured = {
          ...blobs,
          get: (hash: string) =>
            Effect.andThen(
              Effect.sync(() => reads.push(hash)),
              blobs.get(hash),
            ),
        };
        const put = (bytes: Uint8Array) =>
          blobs.put({
            bytes,
            mediaType: "application/json",
            retention: "raw-capture",
          });
        // Model a corrupt sealed record behind a recorded clean event, so the byte checks are reached.
        const mark = (hash: string) =>
          Effect.andThen(
            Log.append([
              CaptureRecords.captureFiledEvent({
                rawCapture: hash,
                runId: "BOUNDED",
                checkpoint: null,
                counts: { records: 0, bytes: 0, calls: 0, frames: 0 },
                sizes: { total: 2048, largest: 2048 },
              }),
            ]),
            CaptureRecords.appendMark({
              rawCapture: hash,
              detectorVersion: CaptureRecords.DETECTOR_VERSION,
              outcome: "clean",
              record: hash,
            }),
          );
        const huge = yield* put(new Uint8Array(2048));
        yield* mark(huge.blob.hash);
        const manifestResult = yield* Effect.exit(
          readCapturedDump(huge.blob.hash, {
            ...DEFAULT_LIMITS,
            manifestBytes: 1024,
          }).pipe(Effect.provideService(Blobs.BlobStore, measured)),
        );
        const manifestReads = [...reads];
        reads.length = 0;
        const object = yield* put(new Uint8Array(2048));
        const lyingManifest = encodeManifest({
          format: "neuve.session-dump",
          version: 1,
          runId: "BOUNDED",
          runKind: "coding",
          redaction: "restricted",
          files: [
            {
              name: "run.json",
              mediaType: "application/json",
              sha256: object.blob.hash,
              size: 1,
            },
          ],
        });
        const manifest = yield* put(lyingManifest);
        yield* mark(manifest.blob.hash);
        const objectResult = yield* Effect.exit(
          readCapturedDump(manifest.blob.hash, {
            ...DEFAULT_LIMITS,
            objectBytes: 1024,
          }).pipe(Effect.provideService(Blobs.BlobStore, measured)),
        );
        const objectReads = [...reads];
        reads.length = 0;
        const mismatchResult = yield* Effect.exit(
          readCapturedDump(manifest.blob.hash).pipe(
            Effect.provideService(Blobs.BlobStore, measured),
          ),
        );
        const mismatchReads = [...reads];
        const exactManifest = yield* put(
          encodeManifest({
            format: "neuve.session-dump",
            version: 1,
            runId: "BOUNDED",
            runKind: "coding",
            redaction: "restricted",
            files: [
              {
                name: "run.json",
                mediaType: "application/json",
                sha256: object.blob.hash,
                size: object.blob.size,
              },
            ],
          }),
        );
        yield* mark(exactManifest.blob.hash);
        const corruptResult = yield* Effect.exit(
          readCapturedDump(exactManifest.blob.hash).pipe(
            Effect.provideService(Blobs.BlobStore, {
              ...blobs,
              get: (hash) =>
                blobs.get(hash).pipe(
                  Effect.map((blob) =>
                    blob._tag === "Present" && hash === object.blob.hash
                      ? {
                          ...blob,
                          bytes: new Uint8Array(blob.bytes.length).fill(1),
                        }
                      : blob,
                  ),
                ),
            }),
          ),
        );
        return {
          manifestResult,
          manifestReads,
          objectResult,
          objectReads,
          mismatchResult,
          mismatchReads,
          manifestHash: manifest.blob.hash,
          corruptResult,
        };
      }),
    ),
  );
  expect(result.manifestReads).toEqual([]);
  expect(result.objectReads).toEqual([result.manifestHash]);
  expect(result.mismatchReads).toEqual([result.manifestHash]);
  for (const exit of [
    result.manifestResult,
    result.objectResult,
    result.mismatchResult,
    result.corruptResult,
  ])
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({
      _tag: "DumpRejected",
    });
  expect(
    Exit.isFailure(result.corruptResult) &&
      Cause.squash(result.corruptResult.cause),
  ).toMatchObject({ reason: "run.json: checksum mismatch" });
});

test("a copied clean folder mark cannot bypass provenance or portable derivation validation", async () => {
  const target = alteredSession((session) => ({
    ...session,
    conversationId: 999,
  }));
  const path = join(target, "export.json");
  const record = JSON.parse(readFileSync(path, "utf8"));
  const { mintUlid, sha256Hex } = await import("@neuve/records-core");
  record.captureMark = {
    id: mintUlid(),
    idempotencyKey: "synthetic-folder-mark",
    actor: sha256Hex("neuve/capture-scan/1"),
    occurredAt: new Date().toISOString(),
    kind: "capture.marked@1",
    payload: {
      rawCapture: "a".repeat(64),
      detectorVersion: "capture-scan-v1",
      outcome: "clean",
      record: record.snapshotId,
    },
    refs: [],
  };
  writeFileSync(path, JSON.stringify(record));
  expect(
    Exit.isFailure(await Effect.runPromiseExit(readSessionDump(target))),
  ).toBe(true);
  await expect(
    exportPortableSnapshot({
      directory: target,
      root,
      retention: { policy: "synthetic" },
    }),
  ).rejects.toThrow();
});
