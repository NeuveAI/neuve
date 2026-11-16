import { captureOutlineSource } from "../src/graph-outline.ts";
// Serialized snapshots retain Map/Set/typed-array containers across builds.
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serialize, deserialize } from "node:v8";
import { Effect, Layer } from "effect";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import { safeRead } from "@neuve/records-schema";
import { IndexSnapshot } from "../src/index-snapshot.ts";
import { treeIndex, indexRecipe } from "../src/search-index.ts";
import { CodeWork } from "../src/code-work.ts";

const privateKey = "neu130privateidentifier";
const directory = mkdtempSync(join(tmpdir(), "snapshot-compatibility-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const base = {
  tree: "a".repeat(40),
  chunks: [],
  byId: new Map(),
  byPath: new Map(),
  lengths: new Uint32Array(),
  averageLength: 0,
  postings: new Map([
    [
      privateKey,
      { docs: new Uint32Array([0]), tfs: new Uint32Array([1]), future: true },
    ],
  ]),
  identifierFrequency: new Map(),
  specificThreshold: 0,
  declarations: {
    byPath: new Map(),
    readers: [],
    gaps: [],
    undecided: new Map(),
    asked: new Set(),
  },
  partial: new Set(),
  excluded: {},
  files: 0,
  blobsComputed: 0,
  blobsReused: 0,
  chunksComputed: 0,
  chunksReused: 0,
  buildMs: 0,
};

test("a newer postings value reads compatibly from the real snapshot cache without rebuilding or changing stored bytes", async () => {
  const bytes = serialize(base);
  const read = safeRead(IndexSnapshot, deserialize(bytes), { notice: false });
  expect(read.success).toBe(true);
  if (!read.success) throw read.error;
  expect(read.droppedKeys).toEqual(["postings.[entry].future"]);
  expect(read.droppedPaths).toEqual([["postings", privateKey, "future"]]);
  expect(read.data.postings).toBeInstanceOf(Map);
  expect(read.data.postings.get(privateKey)).toEqual({
    docs: new Uint32Array([0]),
    tfs: new Uint32Array([1]),
  });
  const snapshots = join(directory, "code-work", "indexes");
  mkdirSync(snapshots, { recursive: true });
  const key = createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        tree: base.tree,
        recipe: indexRecipe(captureOutlineSource()),
      }),
    )
    .digest("hex");
  const filename = join(snapshots, `${key}.index`);
  writeFileSync(filename, bytes);
  const result = await Effect.runPromise(
    treeIndex(
      join(directory, "absent-repository"),
      base.tree,
      captureOutlineSource(),
    ).pipe(
      Effect.provideService(CodeWork, { directory, background: false }),
      Effect.provide(
        Computations.layer.pipe(
          Layer.provideMerge(
            Blobs.layer(storeLocationIn(join(directory, "records"))),
          ),
          Layer.provideMerge(
            Layer.effectDiscard(Store.prepareForWrite).pipe(
              Layer.provideMerge(
                Store.layer(storeLocationIn(join(directory, "records")), {
                  create: true,
                }),
              ),
            ),
          ),
          Layer.provideMerge(BunFileSystem.layer),
        ),
      ),
    ),
  );
  expect(result.cached).toBe(true);
  expect(readFileSync(filename)).toEqual(bytes);
  // A fresh process exercises the once-only stderr notice from the production cache reader.
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "-e",
      `
    import { Effect } from "effect";
    import { treeIndex } from ${JSON.stringify(join(import.meta.dir, "../src/search-index.ts"))};
    import { captureOutlineSource } from ${JSON.stringify(join(import.meta.dir, "../src/graph-outline.ts"))};
    import { CodeWork } from ${JSON.stringify(join(import.meta.dir, "../src/code-work.ts"))};
    const result = await Effect.runPromise(treeIndex(${JSON.stringify(join(directory, "absent-repository"))}, ${JSON.stringify(base.tree)},captureOutlineSource()).pipe(
      Effect.provideService(CodeWork, { directory: ${JSON.stringify(directory)}, background: false })
    ));
    console.log(JSON.stringify({cached: result.cached}));
  `,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  try {
    const output = new Response(child.stdout).text();
    const errors = new Response(child.stderr).text();
    expect(await child.exited).toBe(0);
    expect(JSON.parse(await output)).toEqual({ cached: true });
    const notice = await errors;
    expect(notice).toContain("postings.[entry].future");
    expect(notice).not.toContain(privateKey);
    // Shared tree-index reads also disclose an unreachable-host floor; the compatibility notice stays singular.
    expect(
      notice
        .trim()
        .split("\n")
        .filter((line) => !line.startsWith('{"type":"shared-work.floor",')),
    ).toHaveLength(1);
    expect(readFileSync(filename)).toEqual(bytes);
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
});

for (const value of [
  { docs: new Uint32Array([0]), future: true },
  { docs: "wrong", tfs: new Uint32Array([1]), future: true },
]) {
  test(`a ${"tfs" in value ? "wrongly typed" : "missing"} postings field remains corrupt despite an additive key`, () => {
    expect(
      safeRead(
        IndexSnapshot,
        deserialize(
          serialize({ ...base, postings: new Map([[privateKey, value]]) }),
        ),
      ).success,
    ).toBe(false);
  });
}

// The real writer reuses one declared array for every chunk in a file. V8 retains that alias.
test("V8 snapshots retain every known chunk field when declared arrays are shared and a field is added", () => {
  const declared: import("zod").infer<
    typeof IndexSnapshot
  >["chunks"][number]["declared"] = ["test"];
  const chunk: import("zod").infer<typeof IndexSnapshot>["chunks"][number] = {
    chunkId: "first",
    path: "file",
    blobOid: "b".repeat(40),
    kind: "symbol",
    symbol: "entry",
    headingPath: ["heading"],
    startLine: 1,
    endLine: 2,
    capability: "semantic",
    language: "fixture",
    declared,
    callables: ["entry"],
    parsedIdentifiers: ["used"],
    tokens: 1,
    textSha256: "c".repeat(64),
    previous: null,
    next: "second",
  };
  const chunks = [
    chunk,
    { ...chunk, chunkId: "second", previous: "first", next: null },
  ];
  const bytes = serialize({ ...base, chunks });
  const stored = deserialize(bytes);
  expect(stored.chunks[0].declared).toBe(stored.chunks[1].declared);
  const read = safeRead(IndexSnapshot, stored, { notice: false });
  expect(read.success).toBe(true);
  if (!read.success) throw read.error;
  expect(read.data.chunks).toEqual(chunks);
  expect(read.data.lengths).toBe(stored.lengths);
  expect(read.droppedKeys).toEqual(["postings.[entry].future"]);
  expect(serialize(stored)).toEqual(bytes);
});

// Traverse the live event/operational schema exports, projection registry and V8 reader root.
// A new container must be accounted for here rather than silently becoming an opaque leaf.
test("stored schema registries stay within the compatible reader's traversed nodes", async () => {
  const { z } = await import("zod");
  const records = await import("@neuve/records-schema");
  const { PROJECTIONS } = await import("../../records-core/src/rebuild.ts");
  const seen = new Set<import("zod").core.$ZodType>();
  const visit = (schema: import("zod").core.$ZodType) => {
    if (seen.has(schema)) return;
    seen.add(schema);
    if (schema instanceof z.ZodObject) {
      Object.values(schema.shape).forEach(visit);
      if (schema.def.catchall) visit(schema.def.catchall);
    } else if (schema instanceof z.ZodArray) visit(schema.element);
    else if (schema instanceof z.ZodTuple) {
      schema.def.items.forEach(visit);
      if (schema.def.rest) visit(schema.def.rest);
    } else if (schema instanceof z.ZodRecord || schema instanceof z.ZodMap) {
      visit(schema.keyType);
      visit(schema.valueType);
    } else if (schema instanceof z.ZodSet) visit(schema.def.valueType);
    else if (schema instanceof z.ZodUnion) schema.options.forEach(visit);
    else if (schema instanceof z.ZodIntersection) {
      visit(schema.def.left);
      visit(schema.def.right);
    } else if (schema instanceof z.ZodPipe) {
      visit(schema.in);
      visit(schema.out);
    } else if (
      schema instanceof z.ZodOptional ||
      schema instanceof z.ZodNullable ||
      schema instanceof z.ZodDefault ||
      schema instanceof z.ZodPrefault ||
      schema instanceof z.ZodCatch ||
      schema instanceof z.ZodReadonly ||
      schema instanceof z.ZodNonOptional ||
      schema instanceof z.ZodLazy
    )
      visit(schema.unwrap());
    else
      expect([
        "string",
        "number",
        "boolean",
        "bigint",
        "symbol",
        "undefined",
        "null",
        "void",
        "never",
        "any",
        "unknown",
        "date",
        "enum",
        "literal",
        "nan",
        "custom",
        "transform",
        "template_literal",
        "file",
      ]).toContain(schema._zod.def.type);
  };
  for (const schema of Object.values(records))
    if (schema instanceof z.ZodType) visit(schema);
  for (const projection of PROJECTIONS) {
    visit(projection.view);
    Object.values(projection.jsonColumns ?? {}).forEach(visit);
  }
  visit(IndexSnapshot);
  expect(seen.size).toBeGreaterThan(100);
});

// The CLI's diagnostic reader must survive counters and phases added by a newer worker.
test("CloseDiagnostic reads additive partial-record counters and phases with schema-role notices", async () => {
  const { CloseDiagnostic } =
    await import("../src/pi/capture/close-diagnostic.ts");
  const diagnostic = {
    version: 1,
    phase: "read",
    outcome: "complete",
    inventory: { records: 0, bytes: 0, calls: 0, frames: 0 },
    ceilingMs: 100,
    elapsedMs: 1,
    phases: { read: 1 },
    usage: { units: 1 },
    limits: { units: 100 },
  };
  expect(CloseDiagnostic.safeParse(diagnostic).success).toBe(true);
  const newer = {
    ...diagnostic,
    phases: { read: 1, privatePhase: 2 },
    usage: { units: 1, privateCounter: 2 },
  };
  const read = safeRead(CloseDiagnostic, newer, { notice: false });
  expect(read).toMatchObject({
    success: true,
    data: diagnostic,
    droppedKeys: ["phases.[entry]", "usage.[entry]"],
  });
  expect(
    safeRead(
      CloseDiagnostic,
      { ...newer, usage: { units: "wrong", privateCounter: 2 } },
      { notice: false },
    ).success,
  ).toBe(false);
  expect(newer.usage.privateCounter).toBe(2);
});
