import { captureAuthority } from "./fixture.ts";
import { expect } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  Harness,
  createRegistry,
  defineExtension,
  defineTool,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Type } from "@earendil-works/pi-ai";
import {
  exportSnapshot,
  exportPortableSnapshot,
  readSessionDump,
  openCaptureJournal,
  type RestoredDump,
} from "@neuve/harness/session-dump";
import {
  readDump,
  writeDump,
  encodeManifest,
} from "../../../src/pi/capture/archive.ts";
import { sha256Of } from "../../../src/pi/capture/journal.ts";
import { SOL_ROUTE } from "../../../src/route.ts";
import { createRouteModels } from "../../../src/pi/providers/agent-route-provider.ts";
import {
  created,
  completed,
  functionCallItem,
  messageItem,
  openEndpoint,
  sse,
  tokenCommand,
} from "../providers/fixture.ts";
import type { Json } from "../../../src/pi/capture/types.ts";

type Path = ReadonlyArray<string | number>;
interface Mutation {
  readonly file: string;
  readonly path: Path;
  readonly operation: "replace" | "remove" | "duplicate";
  readonly value: Json;
}
const encode = (value: unknown) =>
  new TextEncoder().encode(`${JSON.stringify(value)}\n`);
const rows: Array<{
  file: string;
  path: Path;
  operation: string;
  result: string;
  reason: string;
}> = [];
const mutations = (
  file: string,
  value: Json,
  path: Path = [],
): Array<Mutation> => {
  if (Array.isArray(value))
    return [
      ...(value.length === 0
        ? []
        : [
            { file, path, operation: "remove" as const, value: value.slice(1) },
            {
              file,
              path,
              operation: "duplicate" as const,
              value: [...value, value[0]!],
            },
          ]),
      ...value.flatMap((item, index) =>
        mutations(file, item, [...path, index]),
      ),
    ];
  if (value !== null && typeof value === "object")
    return Object.entries(value).flatMap(([key, item]) =>
      mutations(file, item, [...path, key]),
    );
  return [
    {
      file,
      path,
      operation: "replace",
      value:
        typeof value === "number"
          ? value + 1
          : typeof value === "string"
            ? `${value}_changed`
            : typeof value === "boolean"
              ? !value
              : "changed",
    },
  ];
};
const replace = (value: Json, path: Path, changed: Json): Json => {
  const [key, ...rest] = path;
  if (key === undefined) return changed;
  if (Array.isArray(value) && typeof key === "number")
    return value.map((item, index) =>
      index === key ? replace(item, rest, changed) : item,
    );
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof key === "string"
  )
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        name,
        name === key ? replace(item, rest, changed) : item,
      ]),
    );
  throw new Error("mutation path does not exist");
};
const Tool = defineExtension({
  name: "matrix",
  tools: [
    defineTool({
      name: "echo",
      description: "Echo a synthetic input.",
      parameters: Type.Object({ text: Type.String() }),
      execute: async (args) => ({
        content: [{ type: "text", text: args.text }],
      }),
    }),
  ],
});

const checkProjectionIn = async (
  partition: number,
  directory: string,
  privateTmp: string,
) => {
  const endpoint = openEndpoint();
  const runId = "canonical-matrix";
  const source = join(directory, "channel");
  const database = join(source, "pi.sqlite");
  const journalPath = join(source, "capture");
  const datasets = join(directory, "datasets");
  await mkdir(datasets);
  const journal = openCaptureJournal(journalPath, runId);
  using authority = captureAuthority(source);
  journal.capture({
    type: "run.start",
    scope: { runId },
    runKind: "coding",
    sourceRevision: "synthetic-canonical-matrix",
    route: "chatgpt",
    pricing: "subscription",
  });
  const token = tokenCommand(directory, "synthetic-lease");
  const registry = createRegistry();
  registry.install(Tool);
  const harness = await Harness.open(
    await openNodeSqliteStorage(database),
    {
      models: createRouteModels({
        credentialInspection: authority.inspection,
        route: SOL_ROUTE,
        runId,
        sessionAffinity: runId,
        auth: { tokenCommand: token.path },
        fetch: endpoint.fetch,
        capture: journal.capture,
      }),
      registry,
      settings: {
        retry: { enabled: false },
        compaction: { enabled: false, keepRecentTokens: 1 },
      },
    },
    context,
  );
  try {
    const conversation = await harness.root(context, {
      agent: {
        model: { provider: "openai", modelId: SOL_ROUTE.model },
        extensions: [Tool],
      },
    });
    journal.capture({
      type: "session.bind",
      scope: {
        runId,
        conversationId: conversation.id,
        stage: "investigate",
        agent: "matrix",
      },
    });
    endpoint.respond(
      () =>
        sse([
          created("matrix-tool"),
          ...functionCallItem(0, {
            id: "tool-item",
            callId: "tool-call",
            name: "echo",
            arguments: '{"text":"matrix content"}',
          }),
          completed("matrix-tool"),
        ]),
      () =>
        sse([
          created("matrix-answer"),
          ...messageItem(0, "answer-item", "final_answer", "matrix answer"),
          completed("matrix-answer"),
        ]),
    );
    expect(
      (
        await (
          await conversation.submit(
            { type: "input", content: "matrix input" },
            context,
          )
        ).wait(context)
      ).status,
    ).toBe("done");
    endpoint.respond(() =>
      sse([
        created("matrix-summary"),
        ...messageItem(0, "summary-item", "final_answer", "matrix compaction"),
        completed("matrix-summary"),
      ]),
    );
    await harness.waitForTask(
      await conversation.compact(undefined, context),
      context,
    );
    endpoint.respond(
      () =>
        new Response(
          '{"error":{"message":"synthetic failure","type":"server_error"}}',
          { status: 500, headers: { "content-type": "application/json" } },
        ),
    );
    await (
      await conversation.submit(
        { type: "input", content: "fail synthetically" },
        context,
      )
    ).wait(context);
    journal.capture({
      type: "model.request",
      purpose: "caption",
      callId: "matrix-caption",
      scope: { runId, conversationId: conversation.id },
      route: "chatgpt",
      provider: "openai",
      model: SOL_ROUTE.model,
      credentialCoverage: "none",
      headerNames: [],
      body: { status: "sent", json: { input: "caption synthetic" } },
    });
    journal.capture({
      type: "model.end",
      callId: "matrix-caption",
      scope: { runId, conversationId: conversation.id },
      outcome: "completed",
      usage: {
        input: 2,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 3,
      },
    });
    journal.capture({
      type: "lead.fate",
      scope: { runId, stage: "investigate" },
      leadId: "lead-1",
      handoff: "rank",
      fate: "below-cut",
      rank: 4,
      cut: 2,
      reason: "synthetic cut",
    });
    journal.capture({
      type: "stage.end",
      scope: { runId, stage: "investigate" },
      status: "completed",
      reason: "synthetic end",
    });
    journal.capture({
      type: "run.end",
      scope: { runId },
      status: "completed",
      publicationId: "matrix-publication",
    });
  } finally {
    await harness.close(context);
    journal.close();
    endpoint.stop();
  }
  const storage = await openNodeSqliteStorage(database);
  let snapshot;
  try {
    snapshot = await exportSnapshot({
      credentialInspection: authority.inspection,
      runId,
      journal: journalPath,
      native: { reads: storage, context },
      nativeDatabase: database,
      root: datasets,
      retention: { policy: "synthetic matrix" },
      declared: ["matrix input"],
    });
  } finally {
    await storage.close(context);
  }
  const original = await Effect.runPromise(readSessionDump(snapshot.directory));
  expect(original.sessions[0]?.offeredTools.length).toBeGreaterThan(0);
  expect(original.sessions[0]?.compactions.length).toBe(1);
  expect(original.sessions[0]?.totals.auxiliary?.tokens.totalTokens).toBe(3);
  expect(original.unjoined.some((call) => call.role === "non-turn")).toBe(true);
  const held = await readDump(snapshot.directory);
  const rawHashes = ["native/pi.sqlite", "journal/events.jsonl"].map((name) =>
    sha256Of(held.files.get(name)!),
  );
  const filesToMutate = held.manifest.files.filter(
    (file) =>
      file.name === "run.json" ||
      file.name === "calls/unjoined.json" ||
      file.name.startsWith("sessions/"),
  );
  const matrix = filesToMutate.flatMap((file) =>
    mutations(
      file.name,
      JSON.parse(new TextDecoder().decode(held.files.get(file.name))),
    ),
  );
  for (const [index, mutation] of matrix.entries()) {
    if (index % 4 !== partition) continue;
    if (index % 100 === 0)
      console.log(
        JSON.stringify({
          canonicalProjection: { partition, checked: index, of: matrix.length },
        }),
      );
    const files = new Map(held.files);
    const value: Json = JSON.parse(
      new TextDecoder().decode(files.get(mutation.file)),
    );
    files.set(
      mutation.file,
      encode(replace(value, mutation.path, mutation.value)),
    );
    const manifest = {
      ...held.manifest,
      files: held.manifest.files.map((file) => ({
        ...file,
        sha256: sha256Of(files.get(file.name)!),
        size: files.get(file.name)!.byteLength,
      })),
    };
    const bytes = encodeManifest(manifest);
    const hash = sha256Of(bytes);
    const destination = join(directory, `mutation-${index}`);
    await mkdir(destination);
    const written = await writeDump({
      root: destination,
      manifest,
      manifestBytes: bytes,
      files,
      record: { ...held.record, snapshotId: hash, manifest: hash },
    });
    const result = await Effect.runPromise(
      Effect.result(readSessionDump(written.directory)),
    );
    rows.push({
      file: mutation.file,
      path: mutation.path,
      operation: mutation.operation,
      result: result._tag,
      reason: result._tag === "Failure" ? result.failure.reason : "accepted",
    });
    expect(
      result._tag,
      `${mutation.file} ${JSON.stringify(mutation.path)} ${mutation.operation}`,
    ).toBe("Failure");
    expect(
      ["native/pi.sqlite", "journal/events.jsonl"].map((name) =>
        sha256Of(files.get(name)!),
      ),
    ).toEqual(rawHashes);
  }
  const mapUsage = (value: Json): Json => {
    if (Array.isArray(value)) return value.map(mapUsage);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          key === "input" && typeof item === "number"
            ? item + 7
            : mapUsage(item),
        ]),
      );
    return value;
  };
  const renameModel = (value: Json): Json => {
    if (Array.isArray(value)) return value.map(renameModel);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          key === "models" &&
          item !== null &&
          typeof item === "object" &&
          !Array.isArray(item)
            ? Object.fromEntries(
                Object.entries(item).map(([, usage]) => [
                  "invented/model",
                  usage,
                ]),
              )
            : renameModel(item),
        ]),
      );
    return value;
  };
  const probe = async (
    name: string,
    bundle: typeof held,
    change: (files: Map<string, Uint8Array>) => void,
    rawUnchanged = true,
  ) => {
    const files = new Map(bundle.files);
    change(files);
    const manifest = {
      ...bundle.manifest,
      files: bundle.manifest.files.map((file) => ({
        ...file,
        sha256: sha256Of(files.get(file.name)!),
        size: files.get(file.name)!.byteLength,
      })),
    };
    const bytes = encodeManifest(manifest);
    const hash = sha256Of(bytes);
    const destination = join(directory, name);
    await mkdir(destination);
    const written = await writeDump({
      root: destination,
      manifest,
      manifestBytes: bytes,
      files,
      record: { ...bundle.record, snapshotId: hash, manifest: hash },
    });
    const result = await Effect.runPromise(
      Effect.result(readSessionDump(written.directory)),
    );
    rows.push({
      file: name,
      path: [],
      operation: "coupled",
      result: result._tag,
      reason: result._tag === "Failure" ? result.failure.reason : "accepted",
    });
    expect(result._tag, name).toBe("Failure");
    if (rawUnchanged && bundle.manifest.redaction === "restricted")
      expect(
        ["native/pi.sqlite", "journal/events.jsonl"].map((file) =>
          sha256Of(files.get(file)!),
        ),
      ).toEqual(rawHashes);
    if (bundle.manifest.redaction === "restricted")
      expect(
        await Effect.runPromise(
          Effect.result(
            Effect.tryPromise(() =>
              exportPortableSnapshot({
                directory: written.directory,
                root: datasets,
                retention: { policy: "synthetic" },
              }),
            ),
          ),
        ),
      ).toHaveProperty("_tag", "Failure");
  };
  await probe("coupled-usage", held, (files) => {
    for (const file of filesToMutate)
      files.set(
        file.name,
        encode(
          mapUsage(JSON.parse(new TextDecoder().decode(files.get(file.name)))),
        ),
      );
  });
  await probe("model-membership", held, (files) => {
    for (const file of filesToMutate.filter((file) =>
      file.name.startsWith("sessions/"),
    ))
      files.set(
        file.name,
        encode(
          renameModel(
            JSON.parse(new TextDecoder().decode(files.get(file.name))),
          ),
        ),
      );
  });
  await probe(
    "malformed-native",
    held,
    (files) => {
      const bytes = new TextEncoder().encode("not a SQLite backup");
      files.set("native/pi.sqlite", bytes);
      const run = JSON.parse(new TextDecoder().decode(files.get("run.json")));
      run.backup.sha256 = sha256Of(bytes);
      run.backup.size = bytes.byteLength;
      files.set("run.json", encode(run));
    },
    false,
  );
  const portable = await exportPortableSnapshot({
    directory: snapshot.directory,
    root: datasets,
    retention: { policy: "synthetic matrix" },
  });
  const portableRead: RestoredDump = await Effect.runPromise(
    readSessionDump(portable.directory),
  );
  expect(portableRead.run.backup.status).toBe("withheld");
  const portableHeld = await readDump(portable.directory);
  await probe("portable-model-membership", portableHeld, (files) => {
    for (const file of filesToMutate.filter((file) =>
      file.name.startsWith("sessions/"),
    ))
      files.set(
        file.name,
        encode(
          renameModel(
            JSON.parse(new TextDecoder().decode(files.get(file.name))),
          ),
        ),
      );
  });
  expect(
    portableRead.manifest.files.some(
      (file) => file.name === "source/projection.json",
    ),
  ).toBe(false);
  expect(
    (await readdir(privateTmp)).filter((name) =>
      name.startsWith("neuve-capture-read-"),
    ),
  ).toEqual([]);
  const reread = await readDump(snapshot.directory);
  expect(
    ["native/pi.sqlite", "journal/events.jsonl"].map((name) =>
      sha256Of(reread.files.get(name)!),
    ),
  ).toEqual(rawHashes);
  if (process.env["NEUVE_CANONICAL_MATRIX_KEEP"] === "1") {
    await writeFile(
      join(directory, "matrix.json"),
      JSON.stringify({ sourceHashes: rawHashes, mutations: rows }, null, 2),
    );
    console.log(
      JSON.stringify({
        fixture: directory,
        matrix: rows.length,
        leafAndMembershipCases: matrix.length,
        refused: rows.filter((row) => row.result === "Failure").length,
        httpRequests: endpoint.received.length,
        originalComplete: original.run.complete,
        portable: portableRead.run.complete,
        sourceHashes: rawHashes,
      }),
    );
  } else await rm(directory, { recursive: true, force: true });
};

// The native read stages its copy in tmpdir(), which other test processes in the pool
// share. Bun's tmpdir() reads TMPDIR at each call, and this file's tests run one at a
// time, so a private TMPDIR holds only this test's staging folders.
export const checkProjection = async (partition: number) => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-projection-"));
  const privateTmp = join(directory, "tmp");
  await mkdir(privateTmp);
  const sharedTmp = process.env["TMPDIR"];
  process.env["TMPDIR"] = privateTmp;
  try {
    await checkProjectionIn(partition, directory, privateTmp);
  } finally {
    if (sharedTmp === undefined) delete process.env["TMPDIR"];
    else process.env["TMPDIR"] = sharedTmp;
  }
};
