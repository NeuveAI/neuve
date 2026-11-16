// Why (NEU-148, the worker's memory): publishing a 100 MB tree index it had just built took the
// review worker from 2.9 to 5.3 GB, because `publish` parsed a full copy of the value and then
// joined the magic and the envelope into one more buffer. The builder's own value is now published
// as it is when parsing it would give it back exactly, and the file is written in two parts. What
// must not change: every byte of the file (compared with what `60513de0` wrote: the magic, then
// the envelope with the schema's parse of the value); a value parsing would change (an extra key, a
// missing default, another key order, a wrong type) is handled exactly as before; the byte bound
// refuses at the same count; and readers still parse and reject what does not fit.
//
// No memory assertion: a heap figure in one test process is not stable enough to fail only on a
// copy. The evidence for the memory is a re-measurement of plant 201.
import { afterAll, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { deserialize, serialize } from "node:v8";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer } from "effect";
import { z } from "zod";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import { IndexSnapshot } from "../src/index-snapshot.ts";
import * as Real from "../src/shared-publication.ts";
import { publicationHost } from "./fixtures/publication-host.ts";

// Every `publish` call of the real callers, with the schema their publication was made with.
const published: Array<{ schema: z.ZodType; value: unknown }> = [];
const realPublication = Real.sharedPublication;
mock.module("../src/shared-publication.ts", () => ({
  ...Real,
  sharedPublication: ((input: Parameters<typeof realPublication>[0]) => {
    const copies = realPublication(input);
    return {
      ...copies,
      publish: (value: unknown) => {
        published.push({ schema: input.schema, value });
        return copies.publish(value);
      },
    };
  }) as typeof realPublication,
}));
const { treeIndex, releaseIndexCache } = await import("../src/search-index.ts");
const { readOutlines, captureOutlineSource, outlineExecutable } =
  await import("../src/graph-outline.ts");
const { CodeWork } = await import("../src/code-work.ts");
const {
  sharedPublication,
  fitsExactly,
  PUBLICATION_MAGIC,
  PublicationPolicy,
  PublicationTooLarge,
} = Real;

const root = mkdtempSync(join(tmpdir(), "publication-bytes-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const files = (folder: string): string[] =>
  existsSync(folder)
    ? readdirSync(folder, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? files(join(folder, entry.name))
          : [join(folder, entry.name)],
      )
    : [];
const payloads = (folder: string) =>
  files(folder).filter((name) => /^[0-9a-f-]{36}$/.test(basename(name)));
const HEADER = [
  "version",
  "store",
  "key",
  "requestKey",
  "publication",
  "previous",
  "host",
] as const;
/** What `60513de0`'s `publish` wrote for this value: the magic, then the envelope of its parse. */
const before = (file: Buffer, schema: z.ZodType, value: unknown) => {
  const stored = deserialize(file.subarray(PUBLICATION_MAGIC.length)) as Record<
    string,
    unknown
  >;
  const header = Object.fromEntries(HEADER.map((name) => [name, stored[name]]));
  return Buffer.concat([
    PUBLICATION_MAGIC,
    serialize({ ...header, value: schema.parse(value) }),
  ]);
};
/**
 * Serialized bytes, decoded and serialized again. JSC holds an integer either as an int32 or as a
 * double, and `serialize` writes each with its own tag and length; once zod's parse code is compiled
 * hot, its copy can hold as doubles integers the value holds as int32s, so two paths that write the
 * same value can differ in those bytes alone. Decoding holds every integer one way, so this keeps
 * every key, entry, order, type and shared reference and drops only that difference. The engine
 * test compares a value the builder made across the two paths, so it compares these; the small
 * tests, whose numbers are all literals, compare the raw bytes.
 */
const settled = (bytes: Uint8Array) =>
  Buffer.from(serialize(deserialize(bytes)));
const withBudget = async <A>(
  name: string,
  run: (budget: string) => Promise<A>,
) => {
  const budget = join(root, name),
    prior = process.env.NEUVE_BUDGET_DIRECTORY;
  process.env.NEUVE_BUDGET_DIRECTORY = budget;
  try {
    return await run(budget);
  } finally {
    if (prior === undefined) delete process.env.NEUVE_BUDGET_DIRECTORY;
    else process.env.NEUVE_BUDGET_DIRECTORY = prior;
  }
};

const ENGINE = existsSync(outlineExecutable());

test.skipIf(!ENGINE)(
  "a tree index and an outline read publish the bytes 60513de0 wrote; the index without a parse",
  // The build gives one `declared` array to every chunk of a file under a declaration, and, built
  // from stored chunkings, the same decoded chunking to two files of the same text, so their chunks
  // share `headingPath` and `callables`. The published value must still fit exactly and give the
  // parse's bytes, so this tree has a declared file of several chunks and two files of one text,
  // and the index is built a second time from the stored chunkings.
  async () => {
    await withBudget("callers", async (budget) => {
      const authority = publicationHost(budget);
      const policy = {
        ...PublicationPolicy.defaultValue(),
        authority: authority.authority,
      };
      try {
        const repository = join(root, "repo");
        const git = (args: string[], input?: string) => {
          const child = Bun.spawnSync(["git", "-C", repository, ...args], {
            ...(input === undefined
              ? {}
              : { stdin: new TextEncoder().encode(input) }),
          });
          if (child.exitCode !== 0) throw new Error(child.stderr.toString());
          return child.stdout.toString().trim();
        };
        Bun.spawnSync(["git", "init", "-q", repository]);
        const generated = Array.from(
          { length: 4 },
          (_, n) =>
            `export function generated${n}() {\n${"  const x = 1;\n".repeat(40)}  return ${n};\n}\n`,
        ).join("\n");
        const entries = Object.entries({
          ".gitattributes":
            "gen.ts linguist-generated=true\nlong.md linguist-documentation=true\n",
          "README.md": "# Readme\n\nSome text about `one`.\n",
          "gen.ts": generated,
          "long.md": `# Long\n\n## Section\n\n${"A line of prose that runs the section past one chunk.\n".repeat(240)}`,
          "one.ts":
            "import { two } from './two';\nexport function one() {\n  return two() + 1;\n}\n",
          "one-copy.ts":
            "import { two } from './two';\nexport function one() {\n  return two() + 1;\n}\n",
          "two.ts": "export function two() {\n  return 2;\n}\n",
        });
        const tree = git(
          ["mktree"],
          entries
            .map(
              ([path, text]) =>
                `100644 blob ${git(["hash-object", "-w", "--stdin"], text)}\t${path}\n`,
            )
            .join(""),
        );
        const location = storeLocationIn(join(root, "records"));
        const layer = Computations.layer.pipe(
          Layer.provideMerge(Blobs.layer(location)),
          Layer.provideMerge(
            Layer.effectDiscard(Store.prepareForWrite).pipe(
              Layer.provideMerge(Store.layer(location, { create: true })),
            ),
          ),
          Layer.provideMerge(BunFileSystem.layer),
        );
        const build = (codeWork: string) =>
          Effect.runPromiseExit(
            treeIndex(repository, tree, captureOutlineSource()).pipe(
              Effect.provideService(CodeWork, {
                directory: join(root, codeWork),
                background: false,
              }),
              Effect.provideService(PublicationPolicy, policy),
              Effect.provide(layer),
            ),
          );
        await build("code-work");
        // Again from the stored chunkings: a fresh code-work folder, so no local snapshot is read,
        // and without the first build's publication, which the second would otherwise read.
        releaseIndexCache();
        rmSync(join(budget, "shared-indexes-v4"), {
          recursive: true,
          force: true,
        });
        await build("code-work-reused");
        // The build's own snapshot, as `serialize` kept it in the local snapshot file: its chunks
        // reach some arrays twice, which is what the published value must not.
        const [local] = files(join(root, "code-work-reused")).filter((name) =>
          name.endsWith(".index"),
        );
        if (local === undefined) throw new Error("no local snapshot");
        const reachedTwice = (value: unknown) => {
          const met = new Set<unknown>(),
            twice = new Set<string>();
          for (const chunk of (
            value as { chunks: Array<Record<string, unknown>> }
          ).chunks)
            for (const [field, item] of Object.entries(chunk))
              if (Array.isArray(item))
                if (met.has(item)) twice.add(field);
                else met.add(item);
          return [...twice].sort();
        };
        expect(reachedTwice(deserialize(readFileSync(local)))).toEqual(
          expect.arrayContaining(["callables", "declared", "headingPath"]),
        );
        const outline = await readOutlines(
          [
            {
              path: "three.ts",
              bytes: new TextEncoder().encode(
                "export class Three {\n  value() {\n    return 3;\n  }\n}\n",
              ),
            },
          ],
          captureOutlineSource(),
          undefined,
          (run) => run(1),
          false,
          policy,
        );
        expect(outline.context("three.ts").kind).toBe("available");
        type Built = {
          publication: string;
          outcome: {
            value: {
              chunks?: unknown[];
            };
          };
        };
        const isIndex = (value: unknown) =>
          (value as Built).outcome.value.chunks !== undefined;
        const captured = published.findLast((p) => isIndex(p.value));
        if (captured === undefined) throw new Error("no tree index publish");
        // The built index as it was published, under a fresh publication id.
        const index = {
          ...(captured.value as Built),
          publication: randomUUID(),
        };
        expect(index.outcome.value.chunks!.length).toBeGreaterThan(3);
        expect(
          (index.outcome.value as unknown as { chunksReused: number })
            .chunksReused,
        ).toBeGreaterThan(0);
        expect(reachedTwice(index.outcome.value)).toEqual([]);
        // Several chunks of one declared file: the build gave them one `declared` array.
        const generatedChunks = (
          index.outcome.value.chunks as Array<{
            path: string;
            declared: unknown;
          }>
        ).filter((chunk) => chunk.path === "gen.ts");
        expect(generatedChunks.length).toBeGreaterThan(1);
        expect(Array.isArray(generatedChunks[0]!.declared)).toBe(true);
        const indexCopies = realPublication({
          namespace: "shared-indexes-v4",
          scope: "bytes",
          key: "tree-index-bytes",
          group: "g",
          schema: captured.schema as z.ZodType<{
            readonly publication: string;
          }>,
          reusable: () => true,
          authority: authority.authority,
        });
        await indexCopies.publish(index);
        const checked = [
          { schema: captured.schema, value: index as unknown },
          ...published.filter((p) => !isIndex(p.value)),
        ];
        const written = payloads(budget);
        const kinds = new Set<string>();
        for (const { schema, value } of checked) {
          const id = (value as { publication: string }).publication;
          const path = written.find((name) => basename(name) === id);
          // A publish that met a standing copy of its key writes nothing and returns that copy.
          if (path === undefined) continue;
          // The tree index is published without a parse. An outline's observation has its
          // provider's keys in another order than the schema's, so it is parsed, as before.
          const kind = path.includes("/shared-indexes-v4/")
            ? "index"
            : "outline";
          const fits = fitsExactly(schema, value);
          if (kind === "index") expect(fits).toBe(true);
          if (fits)
            expect(
              settled(serialize(value)).equals(
                settled(serialize(schema.parse(value))),
              ),
            ).toBe(true);
          // Either way, every byte is what the parse of it gave before, up to how an integer is held.
          const file = readFileSync(path),
            earlier = before(file, schema, value);
          expect(
            file
              .subarray(0, PUBLICATION_MAGIC.length)
              .equals(earlier.subarray(0, PUBLICATION_MAGIC.length)),
          ).toBe(true);
          expect(
            settled(file.subarray(PUBLICATION_MAGIC.length)).equals(
              settled(earlier.subarray(PUBLICATION_MAGIC.length)),
            ),
          ).toBe(true);
          kinds.add(kind);
        }
        expect([...kinds].sort()).toEqual(["index", "outline"]);
      } finally {
        authority.host.close();
      }
    });
  },
  60_000,
);

const Loose = z.object({
  publication: z.uuid(),
  outcome: z.object({
    kind: z.literal("succeeded"),
    value: z.object({ count: z.number(), label: z.string().default("none") }),
  }),
});
const Strict = z.strictObject({
  publication: z.uuid(),
  outcome: z.strictObject({
    kind: z.literal("succeeded"),
    value: z.strictObject({ count: z.number() }),
  }),
});
const publishOne = (
  budget: string,
  schema: z.ZodType<{ readonly publication: string }>,
  key: string,
  extra: Partial<{ maximumBytes: number }> = {},
) => {
  const authority = publicationHost(budget);
  return {
    authority,
    copies: sharedPublication({
      namespace: "shared-indexes-v4",
      scope: "s",
      key,
      group: "g",
      schema,
      reusable: () => true,
      authority: authority.authority,
      ...extra,
    }),
  };
};

test("a value that parsing would change is parsed, or refused before anything is written, as before", async () => {
  const cases: Array<{
    name: string;
    schema: z.ZodType<{ readonly publication: string }>;
    value: (publication: string) => unknown;
    refused?: boolean;
  }> = [
    {
      name: "an extra key, stripped",
      schema: Loose,
      value: (publication) => ({
        publication,
        outcome: {
          kind: "succeeded",
          value: { count: 1, label: "x", extra: true },
        },
      }),
    },
    {
      name: "a missing default, applied",
      schema: Loose,
      value: (publication) => ({
        publication,
        outcome: { kind: "succeeded", value: { count: 1 } },
      }),
    },
    {
      name: "keys in another order, put in the schema's order",
      schema: Loose,
      value: (publication) => ({
        outcome: { value: { label: "x", count: 1 }, kind: "succeeded" },
        publication,
      }),
    },
    {
      name: "an extra key on a strict schema, refused",
      schema: Strict,
      value: (publication) => ({
        publication,
        outcome: { kind: "succeeded", value: { count: 1, extra: true } },
      }),
      refused: true,
    },
    {
      name: "a wrong type, refused",
      schema: Strict,
      value: (publication) => ({
        publication,
        outcome: { kind: "succeeded", value: { count: "1" } },
      }),
      refused: true,
    },
  ];
  for (const [at, item] of cases.entries())
    await withBudget(`changed-${at}`, async (budget) => {
      const { authority, copies } = publishOne(budget, item.schema, `k${at}`);
      try {
        const value = item.value(randomUUID());
        expect(fitsExactly(item.schema, value)).toBe(false);
        if (item.refused) {
          await expect(copies.publish(value)).rejects.toBeInstanceOf(
            z.ZodError,
          );
          expect(existsSync(join(budget, "shared-indexes-v4"))).toBe(false);
          return;
        }
        const result = await copies.publish(value);
        const [path] = payloads(budget);
        if (path === undefined) throw new Error(`${item.name}: no file`);
        const file = readFileSync(path);
        expect(file.equals(before(file, item.schema, value))).toBe(true);
        const parsed = item.schema.parse(value) as unknown as {
          outcome: { value: object };
        };
        const returned = result as unknown as {
          outcome: { value: object };
        };
        expect(returned.outcome).toEqual(parsed.outcome);
        expect(Object.keys(returned.outcome.value)).toEqual(["count", "label"]);
      } finally {
        authority.host.close();
      }
    });
});

test("the byte bound refuses at the same count, and a reader rejects a publication that does not fit", async () => {
  await withBudget("bound", async (budget) => {
    const value = {
      publication: randomUUID(),
      outcome: { kind: "succeeded" as const, value: { count: 7 } },
    };
    expect(fitsExactly(Strict, value)).toBe(true);
    const seed = publishOne(budget, Strict, "seed");
    let size: number;
    try {
      await seed.copies.publish(value);
      const [path] = payloads(budget);
      if (path === undefined) throw new Error("no seed");
      const file = readFileSync(path);
      expect(file.equals(before(file, Strict, value))).toBe(true);
      size = file.length;
    } finally {
      seed.authority.host.close();
    }
    // The same value in a fresh folder: its file has the same length, so the same bound.
    await withBudget("bound-exact", async (folder) => {
      const exact = publishOne(folder, Strict, "seed", { maximumBytes: size });
      try {
        await exact.copies.publish(value);
        expect(payloads(folder)).toHaveLength(1);
        expect(readFileSync(payloads(folder)[0]!).length).toBe(size);
      } finally {
        exact.authority.host.close();
      }
    });
    await withBudget("bound-small", async (folder) => {
      const small = publishOne(folder, Strict, "seed", {
        maximumBytes: size - 1,
      });
      try {
        const refused = await small.copies.publish(value).catch((e) => e);
        expect(refused).toBeInstanceOf(PublicationTooLarge);
        expect(
          (refused as InstanceType<typeof PublicationTooLarge>).bytes,
        ).toBe(size);
        expect(existsSync(join(folder, "shared-indexes-v4"))).toBe(false);
      } finally {
        small.authority.host.close();
      }
    });
  });
  await withBudget("malformed", async (budget) => {
    const { authority, copies } = publishOne(budget, Strict, "malformed");
    try {
      const value = {
        publication: randomUUID(),
        outcome: { kind: "succeeded" as const, value: { count: 7 } },
      };
      await copies.publish(value);
      const first = (await copies.read()) as unknown as
        { outcome: unknown } | undefined;
      expect(first?.outcome).toEqual(value.outcome);
      const [path] = payloads(budget);
      if (path === undefined) throw new Error("no file");
      const stored = deserialize(
        readFileSync(path).subarray(PUBLICATION_MAGIC.length),
      ) as { value: { outcome: { value: unknown } } };
      stored.value.outcome.value = { count: "seven" };
      writeFileSync(
        path,
        Buffer.concat([PUBLICATION_MAGIC, serialize(stored)]),
      );
      expect(await copies.read()).toBeUndefined();
    } finally {
      authority.host.close();
    }
  });
});

// The outline's observation is a discriminated union: the option its tag names decides alone, as
// in zod's parse, so a large observation is walked rather than copied to be compared.
test("a discriminated union fits exactly only by the option its tag names", () => {
  const Observed = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("unavailable") }),
    z.strictObject({
      kind: z.literal("available"),
      files: z.map(z.string(), z.strictObject({ lines: z.number() })),
    }),
  ]);
  const files = new Map([["a.ts", { lines: 3 }]]);
  expect(fitsExactly(Observed, { kind: "available", files })).toBe(true);
  expect(fitsExactly(Observed, { kind: "unavailable" })).toBe(true);
  // Another key order, an extra key, a tag no option names, a wrong value: parsed as before.
  expect(fitsExactly(Observed, { files, kind: "available" })).toBe(false);
  expect(fitsExactly(Observed, { kind: "unavailable", files })).toBe(false);
  expect(fitsExactly(Observed, { kind: "other" })).toBe(false);
  expect(
    fitsExactly(Observed, {
      kind: "available",
      files: new Map([["a.ts", { lines: "3" }]]),
    }),
  ).toBe(false);
  // Wherever it answers true, the parse gives the same bytes.
  const value = { kind: "available", files };
  expect(
    Buffer.from(serialize(Observed.parse(value))).equals(
      Buffer.from(serialize(value)),
    ),
  ).toBe(true);
});

// Why (records review of `b9c0deda`): the tree index gives one `declared` array to every chunk of a
// file and one `headingPath` to every window of a section. `serialize` writes an object reachable
// from two places once and points back to it, while the parse copies it at each place, so publishing
// such a value as it is wrote fewer bytes than `60513de0` and the byte bound counted fewer. Such a
// value must take the parse: the same bytes, and the bound refusing at the same count.
const TreePublication = z.strictObject({
  publication: z.uuid(),
  outcome: z.strictObject({
    kind: z.literal("succeeded"),
    value: IndexSnapshot,
  }),
});
const sharedIndex = (publication: string) => {
  const declared = ["generated" as const],
    headingPath = ["Plan", "Big"];
  const chunk = (n: number) => ({
    chunkId: `c${n}`,
    path: "gen.md",
    blobOid: "b".repeat(40),
    kind: "window" as const,
    symbol: null,
    headingPath,
    startLine: n * 10 + 1,
    endLine: n * 10 + 10,
    capability: "structural",
    language: "markdown",
    fallback: null,
    declared,
    callables: [],
    parsedIdentifiers: null,
    tokens: 10,
    textSha256: "f".repeat(64),
    previous: n === 0 ? null : `c${n - 1}`,
    next: n === 2 ? null : `c${n + 1}`,
  });
  return {
    publication,
    outcome: {
      kind: "succeeded" as const,
      value: {
        tree: "a".repeat(40),
        chunks: [chunk(0), chunk(1), chunk(2)],
        byId: new Map([
          ["c0", 0],
          ["c1", 1],
          ["c2", 2],
        ]),
        byPath: new Map([["gen.md", [0, 1, 2]]]),
        lengths: new Uint32Array([10, 10, 10]),
        averageLength: 10,
        postings: new Map([
          [
            "plan",
            { docs: new Uint32Array([0, 1]), tfs: new Uint32Array([1, 2]) },
          ],
        ]),
        identifierFrequency: new Map<string, number>(),
        specificThreshold: 3,
        declarations: {
          byPath: new Map([
            [
              "gen.md",
              [{ kind: "generated" as const, by: "gitattributes: generated" }],
            ],
          ]),
          readers: ["gitattributes"],
          gaps: [],
          undecided: new Map([["notes.md", "no reader decided it"]]),
          asked: new Set(["gen.md"]),
        },
        partial: new Set<string>(),
        excluded: {},
        files: 1,
        blobsComputed: 1,
        blobsReused: 0,
        chunksComputed: 3,
        chunksReused: 0,
        buildMs: 1,
      },
    },
  };
};
test("a value reaching one array from two places is parsed: the bytes and the bound of 60513de0", async () => {
  const value = sharedIndex(randomUUID());
  // Valid, and with each place given its own array it fits: only the sharing sends it to the parse.
  expect(TreePublication.safeParse(value).success).toBe(true);
  expect(fitsExactly(TreePublication, TreePublication.parse(value))).toBe(true);
  expect(fitsExactly(TreePublication, value)).toBe(false);
  // What `60513de0` wrote is the parse's copy, which no longer shares the array, so it is longer.
  expect(serialize(TreePublication.parse(value)).length).toBeGreaterThan(
    serialize(value).length,
  );
  // A shared object, and a shared map, also take the parse.
  const Pair = z.strictObject({
    a: z.strictObject({ n: z.number() }),
    b: z.strictObject({ n: z.number() }),
  });
  const one = { n: 1 };
  expect(fitsExactly(Pair, { a: one, b: one })).toBe(false);
  expect(fitsExactly(Pair, { a: { n: 1 }, b: { n: 1 } })).toBe(true);
  const Maps = z.strictObject({
    a: z.map(z.string(), z.number()),
    b: z.map(z.string(), z.number()),
  });
  const map = new Map([["x", 1]]);
  expect(fitsExactly(Maps, { a: map, b: map })).toBe(false);
  let size: number;
  await withBudget("shared", async (budget) => {
    const { authority, copies } = publishOne(budget, TreePublication, "shared");
    try {
      await copies.publish(value);
      const [path] = payloads(budget);
      if (path === undefined) throw new Error("no file");
      const file = readFileSync(path);
      expect(file.equals(before(file, TreePublication, value))).toBe(true);
      size = file.length;
    } finally {
      authority.host.close();
    }
  });
  await withBudget("shared-exact", async (folder) => {
    const exact = publishOne(folder, TreePublication, "shared", {
      maximumBytes: size,
    });
    try {
      await exact.copies.publish(sharedIndex(randomUUID()));
      expect(readFileSync(payloads(folder)[0]!).length).toBe(size);
    } finally {
      exact.authority.host.close();
    }
  });
  await withBudget("shared-small", async (folder) => {
    const small = publishOne(folder, TreePublication, "shared", {
      maximumBytes: size - 1,
    });
    try {
      const refused = await small.copies
        .publish(sharedIndex(randomUUID()))
        .catch((e) => e);
      expect(refused).toBeInstanceOf(PublicationTooLarge);
      expect((refused as InstanceType<typeof PublicationTooLarge>).bytes).toBe(
        size,
      );
      expect(existsSync(join(folder, "shared-indexes-v4"))).toBe(false);
    } finally {
      small.authority.host.close();
    }
  });
});

// Why (re-review of the cache round, latent): the parse hands a `z.unknown`, `z.any`, `z.custom` or
// `z.instanceof` value back as it is, so the walk does not see the objects inside it. One of them
// also reached from a walked field, which the parse copies, gave fewer bytes than the parse while
// the fit check said it fits. Such a value must take the parse; a typed array, which holds no object
// a walked field can reach, keeps the value as it is.
test("an object inside a value the parse hands back as it is takes the parse when shared", async () => {
  const O = z.strictObject({ x: z.number() });
  const shared = { x: 1 },
    numbers = [1];
  const withValue = (value: z.ZodType) =>
    z.strictObject({
      publication: z.uuid(),
      outcome: z.strictObject({ kind: z.literal("succeeded"), value }),
    }) as z.ZodType<{ readonly publication: string }>;
  const cases: Array<{ name: string; schema: z.ZodType; value: unknown }> = [
    {
      name: "unknown, then a walked field",
      schema: z.strictObject({ u: z.unknown(), o: O }),
      value: { u: { inner: shared }, o: shared },
    },
    {
      name: "a walked field, then unknown",
      schema: z.strictObject({ o: O, u: z.unknown() }),
      value: { o: shared, u: { inner: shared } },
    },
    {
      name: "any over an array",
      schema: z.strictObject({ u: z.any(), a: z.array(z.number()) }),
      value: { u: [numbers], a: numbers },
    },
    {
      name: "a custom array",
      schema: z.strictObject({
        c: z.custom<unknown[]>((item) => Array.isArray(item)),
        o: O,
      }),
      value: { c: [shared], o: shared },
    },
  ];
  for (const [at, item] of cases.entries()) {
    const schema = withValue(item.schema);
    const input = {
      publication: randomUUID(),
      outcome: { kind: "succeeded", value: item.value },
    };
    // The parse copies the walked field, so its bytes differ from the value's.
    expect(
      Buffer.from(serialize(schema.parse(input))).equals(
        Buffer.from(serialize(input)),
      ),
    ).toBe(false);
    expect(fitsExactly(schema, input)).toBe(false);
    await withBudget(`passed-${at}`, async (budget) => {
      const { authority, copies } = publishOne(budget, schema, `u${at}`);
      try {
        await copies.publish(input);
        const [path] = payloads(budget);
        if (path === undefined) throw new Error(`${item.name}: no file`);
        const file = readFileSync(path);
        expect(file.equals(before(file, schema, input))).toBe(true);
      } finally {
        authority.host.close();
      }
    });
  }
  // Typed arrays, also two views on one buffer, are handed back as they are and still fit.
  const Views = z.strictObject({
    a: z.instanceof(Uint32Array),
    b: z.instanceof(Uint32Array),
  });
  const buffer = new ArrayBuffer(16);
  for (const value of [
    { a: new Uint32Array([1]), b: new Uint32Array([2]) },
    { a: new Uint32Array(buffer, 0, 2), b: new Uint32Array(buffer, 8, 2) },
  ]) {
    expect(fitsExactly(Views, value)).toBe(true);
    expect(
      Buffer.from(serialize(Views.parse(value))).equals(
        Buffer.from(serialize(value)),
      ),
    ).toBe(true);
  }
});

// Why (re-review of the cache round's second fix, latent): a map reached through a schema that is
// parsed rather than walked (a refined, lazy or union map) was compared key by key on identity, so
// an object key the parse hands back as it is hid an object a walked field also reaches, and the
// fit check said it fits with fewer bytes than the parse. Such a key must take the parse; a key the
// parse copies still fits when its copy is equal.
test("a map key the parse hands back as it is takes the parse when it reaches a shared object", async () => {
  const O = z.strictObject({ x: z.number() });
  const withValue = (value: z.ZodType) =>
    z.strictObject({
      publication: z.uuid(),
      outcome: z.strictObject({ kind: z.literal("succeeded"), value }),
    }) as z.ZodType<{ readonly publication: string }>;
  const passed = z.map(z.unknown(), z.string());
  const forms: Array<[string, z.ZodType]> = [
    ["refined", passed.refine(() => true)],
    ["lazy", z.lazy(() => passed)],
    ["union", z.union([z.null(), passed])],
  ];
  for (const [at, [name, map]] of forms.entries()) {
    const shared = { x: 1 };
    const schema = withValue(z.strictObject({ m: map, o: O }));
    const input = {
      publication: randomUUID(),
      outcome: {
        kind: "succeeded",
        value: { m: new Map([[{ inner: shared }, "v"]]), o: shared },
      },
    };
    expect(
      Buffer.from(serialize(schema.parse(input))).equals(
        Buffer.from(serialize(input)),
      ),
    ).toBe(false);
    expect(fitsExactly(schema, input)).toBe(false);
    await withBudget(`map-key-${at}`, async (budget) => {
      const { authority, copies } = publishOne(budget, schema, `m${at}`);
      try {
        await copies.publish(input);
        const [path] = payloads(budget);
        if (path === undefined) throw new Error(`${name}: no file`);
        const file = readFileSync(path);
        expect(file.equals(before(file, schema, input))).toBe(true);
      } finally {
        authority.host.close();
      }
    });
  }
  // An object key the parse copies, equal to its copy, still fits, as in the walk of a plain map.
  const copied = z
    .map(z.strictObject({ a: z.number() }), z.string())
    .refine(() => true);
  const value = new Map([[{ a: 1 }, "v"]]);
  expect(fitsExactly(copied, value)).toBe(true);
  expect(
    Buffer.from(serialize(copied.parse(value))).equals(
      Buffer.from(serialize(value)),
    ),
  ).toBe(true);
});

// Why (review verdicts and review, latent): `undefined` under `.optional()` is kept as it is only
// when the inner schema takes no part in absence. Over a default or a prefault, zod's parse gives
// that value; `.exactOptional()` refuses `undefined`. Each must be published exactly as the parse
// gives it, or refused.
test("undefined under a defaulted, prefaulted or exact optional behaves exactly as the parse", async () => {
  const withLabel = (label: z.ZodType) =>
    z.strictObject({
      publication: z.uuid(),
      outcome: z.strictObject({
        kind: z.literal("succeeded"),
        value: z.strictObject({ count: z.number(), label }),
      }),
    }) as z.ZodType<{ readonly publication: string }>;
  const value = (publication: string) => ({
    publication,
    outcome: { kind: "succeeded", value: { count: 1, label: undefined } },
  });
  const Plain = withLabel(z.string().optional()),
    Defaulted = withLabel(z.string().default("x").optional()),
    Prefaulted = withLabel(z.string().prefault("y").optional()),
    Exact = withLabel(z.string().exactOptional());
  // Plain `.optional()` keeps `undefined`: it still fits.
  expect(fitsExactly(Plain, value(randomUUID()))).toBe(true);
  expect(fitsExactly(Defaulted, value(randomUUID()))).toBe(false);
  expect(fitsExactly(Prefaulted, value(randomUUID()))).toBe(false);
  expect(fitsExactly(Exact, value(randomUUID()))).toBe(false);
  for (const [name, schema, label] of [
    ["defaulted", Defaulted, "x"],
    ["prefaulted", Prefaulted, "y"],
  ] as const)
    await withBudget(name, async (budget) => {
      const { authority, copies } = publishOne(budget, schema, name);
      try {
        const input = value(randomUUID());
        const result = (await copies.publish(input)) as unknown as {
          outcome: { value: { label?: string } };
        };
        expect(result.outcome.value.label).toBe(label);
        const [path] = payloads(budget);
        if (path === undefined) throw new Error("no file");
        const file = readFileSync(path);
        expect(file.equals(before(file, schema, input))).toBe(true);
      } finally {
        authority.host.close();
      }
    });
  await withBudget("exact", async (budget) => {
    const { authority, copies } = publishOne(budget, Exact, "exact");
    try {
      await expect(copies.publish(value(randomUUID()))).rejects.toBeInstanceOf(
        z.ZodError,
      );
      expect(existsSync(join(budget, "shared-indexes-v4"))).toBe(false);
    } finally {
      authority.host.close();
    }
  });
});

// Why (records review): a container with a refinement must never be walked as if it had none, or
// its refinement would not run and a value zod refuses would be published.
test("a refined container whose refinement refuses is refused, as by the parse", async () => {
  const withValue = (value: z.ZodType) =>
    z.strictObject({
      publication: z.uuid(),
      outcome: z.strictObject({ kind: z.literal("succeeded"), value }),
    }) as z.ZodType<{ readonly publication: string }>;
  const cases: Array<{ name: string; schema: z.ZodType; value: unknown }> = [
    {
      name: "refine on an array",
      schema: z.array(z.number()).refine((items) => items.length < 2),
      value: [1, 2],
    },
    {
      name: "superRefine on an object",
      schema: z.strictObject({ count: z.number() }).superRefine((item, ctx) => {
        if (item.count > 1) ctx.addIssue({ code: "custom", message: "big" });
      }),
      value: { count: 2 },
    },
    {
      name: "check on a map",
      schema: z.map(z.string(), z.number()).check((ctx) => {
        if (ctx.value.size > 0)
          ctx.issues.push({
            code: "custom",
            message: "not empty",
            input: ctx.value,
          });
      }),
      value: new Map([["a", 1]]),
    },
    {
      name: "refine on a set",
      schema: z.set(z.string()).refine((items) => !items.has("no")),
      value: new Set(["no"]),
    },
  ];
  for (const [at, item] of cases.entries())
    await withBudget(`refined-${at}`, async (budget) => {
      const schema = withValue(item.schema);
      const input = {
        publication: randomUUID(),
        outcome: { kind: "succeeded", value: item.value },
      };
      expect(schema.safeParse(input).success).toBe(false);
      expect(fitsExactly(schema, input)).toBe(false);
      const { authority, copies } = publishOne(budget, schema, `r${at}`);
      try {
        await expect(copies.publish(input)).rejects.toBeInstanceOf(z.ZodError);
        expect(existsSync(join(budget, "shared-indexes-v4"))).toBe(false);
      } finally {
        authority.host.close();
      }
    });
});
