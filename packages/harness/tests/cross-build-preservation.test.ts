import { captureOutlineSource } from "../src/graph-outline.ts";
// Cross-build metadata updates must keep newer fields while normal work continues.
import { randomUUID } from "node:crypto";
import { afterAll, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { copyJson } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  Harness,
  createRegistry,
  ToolTask,
  AssistantEntry,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Effect, Layer } from "effect";
import { z } from "zod";
import { SqlClient } from "effect/sql/SqlClient";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import { defaultConfig } from "../src/config.ts";
import { mcpClientsLayer } from "../src/mcp-client.ts";
import { authFilePath, readAuth, writeAuth } from "../src/openai-auth.ts";
import { openRouteAdmission } from "../src/pi/providers/route-admission.ts";
import {
  RawCapture,
  readRawManifest,
  RAW_CAPTURE_MEDIA_TYPE,
} from "../src/pi/capture/raw.ts";
import {
  decodeManifest,
  DEFAULT_LIMITS,
  DUMP_FORMAT,
  DumpManifest,
} from "../src/pi/capture/archive.ts";
import { CAPTURE_VERSION } from "../src/pi/capture/types.ts";
import { kindExtension } from "../src/pi/stages/tools.ts";
import { AgentContextDoc } from "../src/pi/stages/docs.ts";
import type { AgentStep } from "../src/pi/stages/agent.ts";
import type { StageRequirements } from "../src/pi/stages/services.ts";
import { ensureRunFolder, runFolder } from "../src/run-folder.ts";
import { snapshotByKey, type ScopeSnapshot } from "../src/scope.ts";
import {
  emptyRepoStack,
  readRepoStack,
  repoStackPath,
  writeRepoStack,
} from "../src/stack/repo-state.ts";
import {
  readCatalog,
  evict,
  readHolds,
  recordHold,
  storeLayout,
  writeCatalog,
} from "../src/stack/store.ts";
import { stackIndexRecipeKey } from "../src/stack/index-store.ts";
import { STACK_LIMITS } from "../src/stack/settings.ts";

const root = mkdtempSync(join(tmpdir(), "cross-build-preservation-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const location = storeLocationIn(root);
const records = Computations.layer.pipe(
  Layer.provideMerge(Blobs.layer(location)),
  Layer.provideMerge(Store.layer(location, { create: true })),
  Layer.provideMerge(BunFileSystem.layer),
);
const services = Layer.merge(
  records,
  mcpClientsLayer({ status: "absent", path: "(none)" }),
);
const run = <A, E>(effect: Effect.Effect<A, E, StageRequirements>) =>
  Effect.runPromise(
    Effect.andThen(Store.prepareForWrite, effect).pipe(
      Effect.provide(services),
    ),
  );
const encode = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));

// A split scope key can still point to a full snapshot written before the split.
test("a stored version 2 scope snapshot reads on its own and in split scope", async () => {
  const cycleId = "before-scope-split";
  const baseOid = "a".repeat(40);
  const headOid = "b".repeat(40);
  const legacy = {
    cycleId,
    fetchedAt: "2026-11-01T00:00:00.000Z",
    ms: 7,
    range: { baseOid, headOid: baseOid, mergeBase: baseOid },
    integrations: { file: "absent", detail: null, servers: [] },
    named: [],
    sources: [],
    strata: { strongest: "nothing", present: [] },
    gaps: ["A gap from the stored cycle."],
  } satisfies ScopeSnapshot;
  const range = { baseOid, headOid, mergeBase: baseOid };
  const result = await run(
    Effect.gen(function* () {
      const store = yield* Computations.ComputationStore;
      const cycle = yield* store.run(
        {
          op: "harness.scope-snapshot",
          opVersion: 2,
          inputs: { cycle: `cycle:${cycleId}` },
          config: { recipe: "neuve-scope-v1" },
        },
        Effect.succeed({
          bytes: encode(legacy),
          mediaType: "application/json",
        }),
      );
      const commitRange = yield* store.run(
        {
          op: "harness.range-scope",
          opVersion: 1,
          inputs: {
            base: `git-commit:${baseOid}`,
            head: `git-commit:${headOid}`,
          },
          config: { recipe: "neuve-scope-v1" },
        },
        Effect.succeed({
          bytes: encode({
            fetchedAt: legacy.fetchedAt,
            ms: 3,
            range,
            named: [],
            sources: [],
            gaps: [],
          }),
          mediaType: "application/json",
        }),
      );
      const cycleKey = cycle.computation.key;
      return {
        full: yield* snapshotByKey(cycleKey),
        split: yield* snapshotByKey(
          `scope:${cycleId}:${cycleKey}:${commitRange.computation.key}`,
        ),
      };
    }),
  );
  expect(result.full).toEqual(legacy);
  expect(result.split).toEqual({ ...legacy, range, ms: 10 });
});

const evictionFixture = async (name: string) => {
  const directory = join(root, name);
  const catalog = await readCatalog(directory);
  const at = new Date().toISOString();
  catalog.packages.one = {
    key: "one",
    ecosystem: "npm",
    name: "one",
    version: "1",
    integrity: "hash",
    tree: "a".repeat(40),
    commit: "b".repeat(40),
    folder: "src/one",
    files: 1,
    fileBytes: 1,
    objectBytes: 1,
    fetchedAt: at,
    lastUsedAt: at,
  };
  await writeCatalog(directory, catalog);
  mkdirSync(join(directory, "src/one"), { recursive: true });
  writeFileSync(join(directory, "src/one/source.ts"), "source");
  return { directory, catalog, at, tree: "a".repeat(40) };
};

test("capacity eviction retains newer index metadata and reports that its reservation cannot fit", async () => {
  const { directory, catalog, at, tree } = await evictionFixture(
    "newer-index-eviction",
  );
  const folder = storeLayout(directory).indexFolder(tree);
  mkdirSync(folder, { recursive: true });
  const path = join(folder, "meta.json");
  const text = JSON.stringify({
    tree,
    recipe: stackIndexRecipeKey(),
    docs: 0,
    totalLength: 0,
    files: 0,
    excluded: {},
    builtAt: at,
    future: { keep: true },
  });
  writeFileSync(path, text);
  const lines: string[] = [];
  const context = {
    now: Date.now(),
    cap: 64 * 1024 ** 2,
    pinnedAt: new Map<string, number>(),
    holds: [],
    log: (line: string) => lines.push(line),
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(await evict(directory, catalog, context.cap, context)).toEqual({
      fits: false,
      heldFull: false,
      evicted: [],
      deferredIndexes: [tree],
    });
    expect(readFileSync(path, "utf8")).toBe(text);
    expect(readFileSync(join(directory, "src/one/source.ts"), "utf8")).toBe(
      "source",
    );
  }
  expect(lines).toEqual(
    Array(2).fill(
      "stack eviction deferred: leaving index metadata and its source to a newer build",
    ),
  );
});

test("an expired compatible hold retains its bytes without blocking capacity eviction", async () => {
  for (const expired of [false, true]) {
    const { directory, catalog } = await evictionFixture(
      `expired-hold-${expired}`,
    );
    const text = JSON.stringify({
      version: 1,
      holds: [
        {
          store: "fixture",
          cycleId: "cycle",
          packages: ["one"],
          upstream: [],
          future: true,
          lastRunAt: new Date(
            Date.now() - (expired ? STACK_LIMITS.holdMs + 1000 : 0),
          ).toISOString(),
        },
      ],
    });
    const path = storeLayout(directory).holds;
    writeFileSync(path, text);
    const result = await evict(directory, catalog, 64 * 1024 ** 2, {
      now: Date.now(),
      cap: 64 * 1024 ** 2,
      pinnedAt: new Map(),
      holds: await readHolds(directory),
    });
    expect(result.fits).toBe(expired);
    expect(result.evicted).toEqual(expired ? ["one"] : []);
    expect(readFileSync(path, "utf8")).toBe(text);
  }
});

const raw = RawCapture.parse({
  version: 1,
  runId: "newer-manifest",
  close: null,
  source: "scratch",
  checkpoint: null,
  counts: { records: 0, bytes: 0, calls: 0, frames: 0 },
  lifecycle: { runEnded: false, workInFlight: false },
  unscannable: null,
  rate: null,
  declared: [],
  backup: { status: "unavailable", reason: "fixture" },
  files: [],
});

test("raw manifest additive fields read through BlobStore but invalid hashes and sizes still fail", async () => {
  const result = await run(
    Effect.gen(function* () {
      const blobs = yield* Blobs.BlobStore;
      const newer = yield* blobs.put({
        bytes: encode({
          ...raw,
          future: true,
          lifecycle: { ...raw.lifecycle, future: true },
        }),
        mediaType: RAW_CAPTURE_MEDIA_TYPE,
        retention: "raw-capture",
      });
      const decoded = yield* readRawManifest(newer.blob.hash);
      const size = yield* Effect.result(
        readRawManifest(newer.blob.hash, {
          ...DEFAULT_LIMITS,
          manifestBytes: 1,
        }),
      );
      const invalid = yield* blobs.put({
        bytes: encode({
          ...raw,
          future: true,
          files: [
            {
              name: "native/pi.sqlite",
              sha256: "bad",
              size: 1,
              mediaType: "application/octet-stream",
            },
          ],
        }),
        mediaType: RAW_CAPTURE_MEDIA_TYPE,
        retention: "raw-capture",
      });
      const hash = yield* Effect.result(readRawManifest(invalid.blob.hash));
      const sql = yield* SqlClient;
      const badHash = "c".repeat(64);
      yield* sql`INSERT INTO blobs (hash,size,media_type,retention,placement,captured_at,pruned_at,content) SELECT ${badHash},size,media_type,retention,placement,captured_at,pruned_at,content FROM blobs WHERE hash=${newer.blob.hash}`;
      const integrity = yield* Effect.result(readRawManifest(badHash));
      return { decoded, size: size._tag, hash: hash._tag };
    }),
  );
  expect(result).toEqual({ decoded: raw, size: "Failure", hash: "Failure" });
});

test("dump manifests accept additive keys while hashes, sizes and portable inspection requirements remain checked", () => {
  const manifest: DumpManifest = {
    format: DUMP_FORMAT,
    version: CAPTURE_VERSION,
    runId: "newer-manifest",
    runKind: null,
    redaction: "restricted",
    files: [],
  };
  expect(
    decodeManifest(encode({ ...manifest, future: true }), DEFAULT_LIMITS),
  ).toEqual(manifest);
  const file = {
    name: "run.json",
    sha256: "a".repeat(64),
    size: 1,
    mediaType: "application/json",
  };
  expect(
    typeof decodeManifest(
      encode({
        ...manifest,
        files: [{ ...file, sha256: "bad", future: true }],
      }),
      DEFAULT_LIMITS,
    ),
  ).toBe("string");
  expect(
    typeof decodeManifest(
      encode({ ...manifest, files: [{ ...file, size: -1, future: true }] }),
      DEFAULT_LIMITS,
    ),
  ).toBe("string");
  expect(
    typeof decodeManifest(
      encode({
        ...manifest,
        files: [
          { ...file, size: DEFAULT_LIMITS.objectBytes + 1, future: true },
        ],
      }),
      DEFAULT_LIMITS,
    ),
  ).toBe("string");
  expect(
    typeof decodeManifest(
      encode({ ...manifest, redaction: "portable", future: true }),
      DEFAULT_LIMITS,
    ),
  ).toBe("string");
});

test("a real pi tool commit updates used and keeps futureRoot and reading.futureNested", async () => {
  const registry = createRegistry();
  const harness = await Harness.open(
    await openNodeSqliteStorage(join(root, "pi.sqlite")),
    { registry, models: createModels() },
    context,
  );
  try {
    const conversation = await harness.root(context);
    await harness.commit(async (tx) => {
      const doc = await tx.doc(AgentContextDoc, conversation.id);
      doc.state = {
        reading: { used: 0, futureNested: true },
        futureRoot: { keep: "newer data" },
      };
    }, context);
    let used = 0;
    const tool = {
      name: "read_one",
      description: "Read once",
      input: z.strictObject({}),
      hints: {
        readOnly: true,
        destructive: false,
        idempotent: true,
        openWorld: false,
      },
      handle: () =>
        Effect.sync(() => {
          used++;
          return { text: "one" };
        }),
    };
    const step: AgentStep<unknown, unknown> = {
      op: "fixture",
      opVersion: 1,
      inputs: {},
      compose: (result) => result.output,
      schema: z.unknown(),
      spec: {
        stage: "find",
        agent: "find",
        turnLimit: 20,
        system: "",
        task: "",
        tools: [tool],
        submit: {
          description: "submit",
          schema: z.strictObject({}),
          name: "submit_find",
        },
        backstop: () => ({}),
        state: {
          load: (value) => {
            used = value?.reading?.used ?? 0;
          },
          save: () => ({ reading: { used } }),
        },
      },
    };
    const extension = kindExtension(
      "find",
      [
        {
          name: tool.name,
          description: tool.description,
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          strict: false,
          replay: "safe",
        },
      ],
      {
        route: defaultConfig().route,
        ceiling: 100000,
        log: {
          path: join(root, "tool.jsonl"),
          write: () => {},
          read: () => [],
        },
        run,
        resolve: async () => ({ step, vent: { ...tool, name: "vent" } }),
        endRound: async () => {},
        inputOf: () => tool.input,
      },
    );
    registry.install(extension);
    await conversation.configure({ extensions: [extension] }, context);
    const taskId = await harness.commit(async (tx) => {
      const entry = await tx.appendEntry(AssistantEntry, conversation.id, {
        model: [
          fauxAssistantMessage([fauxToolCall(tool.name, {}, { id: "read" })], {
            stopReason: "toolUse",
          }),
        ],
      });
      return tx.createTask(
        ToolTask,
        { assistant: entry.id, callId: "read" },
        {
          conversationId: conversation.id,
          ownership: { kind: "conversation" },
        },
      );
    }, context);
    harness.resume();
    const outcome = await harness.waitForTask(taskId, context);
    expect(outcome.state.outcome.status).toBe("completed");
    const stored = await harness.commit(
      async (tx) =>
        copyJson((await tx.doc(AgentContextDoc, conversation.id)).state),
      context,
    );
    expect(stored).toEqual({
      reading: { used: 1, futureNested: true },
      futureRoot: { keep: "newer data" },
    });
  } finally {
    await harness.close(context);
  }
});

test("stack pins, catalog and holds retain newer fields during updates, including reordered holds", async () => {
  const directory = join(root, "stack");
  await writeRepoStack(directory, emptyRepoStack(true));
  const state = { ...emptyRepoStack(true), futureRoot: true };
  writeFileSync(repoStackPath(directory), JSON.stringify(state));
  const loaded = await readRepoStack(directory);
  if (loaded === undefined) throw new Error("stack state absent");
  loaded.enabled = false;
  await writeRepoStack(directory, loaded);
  expect(
    JSON.parse(readFileSync(repoStackPath(directory), "utf8")),
  ).toMatchObject({ enabled: false, futureRoot: true });
  const catalog = await readCatalog(directory);
  await writeCatalog(directory, catalog);
  writeFileSync(
    storeLayout(directory).catalog,
    JSON.stringify({
      ...catalog,
      futureCatalog: true,
      indexes: {
        tree: {
          tree: "tree",
          recipe: "old",
          bytes: 1,
          docs: 1,
          builtAt: "now",
          futureIndex: true,
        },
      },
    }),
  );
  const heldCatalog = await readCatalog(directory);
  heldCatalog.indexes["tree"]!.bytes = 2;
  await writeCatalog(directory, heldCatalog);
  expect(
    JSON.parse(readFileSync(storeLayout(directory).catalog, "utf8")),
  ).toMatchObject({
    futureCatalog: true,
    indexes: { tree: { bytes: 2, futureIndex: true } },
  });
  const hold = {
    store: "store",
    cycleId: "one",
    packages: [],
    upstream: [],
    lastRunAt: "old",
  };
  await recordHold(directory, hold);
  writeFileSync(
    storeLayout(directory).holds,
    JSON.stringify({
      version: 1,
      futureRoot: true,
      holds: [
        { ...hold, futureHold: true },
        { ...hold, cycleId: "two", futureHold: "second" },
      ],
    }),
  );
  await recordHold(directory, { ...hold, lastRunAt: "new" });
  expect(await readHolds(directory)).toHaveLength(2);
  expect(
    JSON.parse(readFileSync(storeLayout(directory).holds, "utf8")),
  ).toEqual({
    version: 1,
    futureRoot: true,
    holds: [
      { ...hold, cycleId: "two", futureHold: "second" },
      { ...hold, lastRunAt: "new", futureHold: true },
    ],
  });
});

test("sign-in updates and route-admission writes keep newer durable metadata", () => {
  const directory = join(root, "auth");
  const auth = {
    version: 1 as const,
    issuer: "http://local.test",
    hostId: "urn:uuid:00000000-0000-0000-0000-000000000000",
    registration: { clientId: "client" },
  };
  writeAuth(directory, auth);
  writeFileSync(
    authFilePath(directory),
    JSON.stringify({
      ...auth,
      future: true,
      registration: { ...auth.registration, future: true },
    }),
  );
  const loaded = readAuth(directory);
  if (loaded === undefined) throw new Error("auth absent");
  writeAuth(directory, {
    ...loaded,
    registration: { ...loaded.registration!, name: "updated" },
  });
  expect(
    JSON.parse(readFileSync(authFilePath(directory), "utf8")),
  ).toMatchObject({
    future: true,
    registration: { name: "updated", future: true },
  });
  const path = join(directory, "admission.json");
  const input = { path, route: defaultConfig().route };
  openRouteAdmission(input).observe("1", Date.now(), 429);
  writeFileSync(
    path,
    JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), future: true }),
  );
  openRouteAdmission(input).observe("10", Date.now(), 429);
  expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
    future: true,
  });
});

test("ensuring an existing run folder preserves newer manifest fields", async () => {
  const manifest = {
    runId: "preserve",
    runKey: "key",
    pipelineVersion: 1,
    jobSeq: 1,
    range: {
      baseRef: "main",
      baseOid: "a".repeat(40),
      headOid: "b".repeat(40),
    },
  };
  await run(ensureRunFolder(location, manifest));
  const path = join(runFolder(location, manifest.runId), "run.json");
  writeFileSync(
    path,
    JSON.stringify({
      ...manifest,
      future: true,
      range: { ...manifest.range, future: true },
    }),
  );
  await run(ensureRunFolder(location, { ...manifest, jobSeq: 2 }));
  expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
    jobSeq: 2,
    future: true,
    range: { future: true },
  });
});

test("stack eviction leaves newer metadata and its source files for the newer build", async () => {
  const directory = join(root, "eviction");
  mkdirSync(join(directory, "src", "one"), { recursive: true });
  const source = join(directory, "src", "one", "source.ts");
  writeFileSync(source, "newer source");
  const catalog = await readCatalog(directory);
  catalog.packages["one"] = {
    key: "one",
    ecosystem: "npm",
    name: "one",
    version: "1",
    integrity: "hash",
    tree: "tree",
    commit: "commit",
    folder: "src/one",
    files: 1,
    fileBytes: 1,
    objectBytes: 1,
    fetchedAt: "2000-01-01",
    lastUsedAt: "2000-01-01",
  };
  await writeCatalog(directory, catalog);
  const newer = { ...catalog, future: true };
  writeFileSync(storeLayout(directory).catalog, JSON.stringify(newer));
  const loaded = await readCatalog(directory);
  const result = await evict(directory, loaded, 0, {
    now: Date.now(),
    cap: 0,
    pinnedAt: new Map(),
    holds: [],
  });
  expect(result.evicted).toEqual([]);
  expect(readFileSync(source, "utf8")).toBe("newer source");
  expect(loaded.packages["one"]).toEqual(catalog.packages["one"]);
  expect(
    JSON.parse(readFileSync(storeLayout(directory).catalog, "utf8")),
  ).toEqual(newer);
});

test("stack eviction defers for newer hold metadata before deleting any protected source", async () => {
  const directory = join(root, "hold-eviction");
  const source = join(directory, "src/one/source.ts");
  mkdirSync(join(directory, "src/one"), { recursive: true });
  writeFileSync(source, "source");
  const catalog = await readCatalog(directory);
  catalog.packages["one"] = {
    key: "one",
    ecosystem: "npm",
    name: "one",
    version: "1",
    integrity: "hash",
    tree: "tree",
    commit: "commit",
    folder: "src/one",
    files: 1,
    fileBytes: 1,
    objectBytes: 1,
    fetchedAt: "2000-01-01",
    lastUsedAt: "2000-01-01",
  };
  await writeCatalog(directory, catalog);
  writeFileSync(
    storeLayout(directory).holds,
    JSON.stringify({ version: 1, holds: [], futureProtected: ["one"] }),
  );
  const result = await evict(directory, catalog, 0, {
    now: Date.now(),
    cap: 0,
    pinnedAt: new Map(),
    holds: await readHolds(directory),
  });
  expect(result.evicted).toEqual([]);
  expect(readFileSync(source, "utf8")).toBe("source");
  expect(catalog.packages["one"]).toBeDefined();
});

test("quarantine cleanup removes dead owners and leaves live owners and unknown directory formats", async () => {
  const { clearDeadQuarantines } = await import("../src/stack/store.ts");
  const { existsSync } = await import("node:fs");
  const directory = join(root, "quarantines");
  const unknown = join(storeLayout(directory).quarantine, "newer-layout");
  mkdirSync(unknown, { recursive: true });
  writeFileSync(join(unknown, "newer-state"), "keep");
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", ""], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "inherit",
  });
  expect(await child.exited).toBe(0);
  const dead = join(
    storeLayout(directory).quarantine,
    `${child.pid}-${randomUUID()}`,
  );
  const live = join(
    storeLayout(directory).quarantine,
    `${process.pid}-${randomUUID()}`,
  );
  mkdirSync(dead);
  mkdirSync(live);
  expect(await clearDeadQuarantines(directory)).toBe(1);
  expect(existsSync(dead)).toBe(false);
  expect(existsSync(live)).toBe(true);
  expect(existsSync(join(unknown, "newer-state"))).toBe(true);
});

test("claim cleanup keeps held-review metadata that needed a compatible read", async () => {
  const { onClaim } = await import("../src/handler.ts");
  const { heldReviewsPath } = await import("../src/held-reviews.ts");
  const path = heldReviewsPath(location);
  mkdirSync(join(location.directory, "harness"), { recursive: true });
  const text = JSON.stringify([
    {
      seq: 999,
      pid: 1,
      at: "now",
      provider: "openai",
      route: "fixture",
      credential: "fixture",
      future: true,
    },
  ]);
  writeFileSync(path, text);
  await run(onClaim(location));
  expect(readFileSync(path, "utf8")).toBe(text);
});

test("eviction leaves sources when registry or repository pins needed a compatible read", async () => {
  const { pinnedAcrossRepositories } = await import("../src/stack/fetch.ts");
  const directory = join(root, "pin-eviction");
  const repository = join(directory, "repo");
  await writeRepoStack(repository, emptyRepoStack(true));
  const registry = join(directory, "repositories.json");
  const catalog = await readCatalog(directory);
  catalog.packages["one"] = {
    key: "one",
    ecosystem: "npm",
    name: "one",
    version: "1",
    integrity: "hash",
    tree: "tree",
    commit: "commit",
    folder: "src/one",
    files: 1,
    fileBytes: 1,
    objectBytes: 1,
    fetchedAt: "2000-01-01",
    lastUsedAt: "2000-01-01",
  };
  await writeCatalog(directory, catalog);
  mkdirSync(join(directory, "src/one"), { recursive: true });
  const source = join(directory, "src/one/source.ts");
  writeFileSync(source, "keep");
  for (const boundary of ["registry", "pins"]) {
    writeFileSync(
      registry,
      JSON.stringify({
        version: 1,
        repositories: [{ store: repository, repository: "fixture" }],
        ...(boundary === "registry" ? { future: true } : {}),
      }),
    );
    writeFileSync(
      repoStackPath(repository),
      JSON.stringify({
        ...emptyRepoStack(true),
        ...(boundary === "pins" ? { future: true } : {}),
      }),
    );
    const pins = await pinnedAcrossRepositories(registry);
    expect(pins.pinsKnown).toBe(false);
    expect(
      (
        await evict(directory, catalog, 0, {
          now: Date.now(),
          cap: 0,
          ...pins,
          holds: [],
        })
      ).evicted,
    ).toEqual([]);
    expect(readFileSync(source, "utf8")).toBe("keep");
  }
});

test("stack index replacement defers before touching a newer metadata document", async () => {
  const { buildTreeIndex, stackIndexRecipeKey } =
    await import("../src/stack/index-store.ts");
  const directory = join(root, "newer-index");
  const folder = storeLayout(directory).indexFolder("tree");
  mkdirSync(folder, { recursive: true });
  const text = JSON.stringify({
    recipe: stackIndexRecipeKey(),
    tree: "tree",
    docs: 0,
    totalLength: 0,
    files: 0,
    excluded: {},
    builtAt: "now",
    future: { derived: true },
  });
  writeFileSync(join(folder, "meta.json"), text);
  writeFileSync(join(folder, "newer-state"), "keep");
  expect(
    await buildTreeIndex(
      { gitPath: "/no-git-must-run", env: {} },
      directory,
      "tree",
      captureOutlineSource(),
    ),
  ).toEqual({ status: "deferred", reason: "newer-build" });
  expect(readFileSync(join(folder, "meta.json"), "utf8")).toBe(text);
  expect(readFileSync(join(folder, "newer-state"), "utf8")).toBe("keep");
});

test("scope-copy idle retention counts newer event kinds as activity instead of absence", async () => {
  const { scopeCopySweep, scopeFolder } = await import("../src/scope.ts");
  const { mintUlid } = await import("@neuve/records-core");
  const { existsSync } = await import("node:fs");
  const cycleId = mintUlid();
  const folder = scopeFolder(location, cycleId);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "source.txt"), "newer work");
  await run(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const old = mintUlid();
      const newer = mintUlid();
      yield* sql`INSERT INTO events(id,kind,idempotency_key,fingerprint,actor_id,occurred_at,recorded_at,envelope) VALUES(${old},'cycle.opened@1',${old},'fixture','fixture','2000-01-01','2000-01-01',${JSON.stringify({ attribution: { cycleId } })})`;
      yield* sql`INSERT INTO event_cycles(event_seq,cycle_id) SELECT seq,${cycleId} FROM events WHERE id=${old}`;
      yield* sql`INSERT INTO events(id,kind,idempotency_key,fingerprint,actor_id,occurred_at,recorded_at,envelope) VALUES(${newer},'review.progress@99',${newer},'fixture','fixture',${new Date().toISOString()},${new Date().toISOString()},${JSON.stringify({ attribution: { cycleId } })})`;
      yield* scopeCopySweep(location).sweep;
    }),
  );
  expect(existsSync(join(folder, "source.txt"))).toBe(true);
});
