import { captureOutlineSource } from "../src/graph-outline.ts";
// Why: `uses` now lets the tree's search index pick the files git greps (10.108). The answer must
// stay git's own, byte for byte: the index lowercases, splits identifiers, leaves out binary,
// non-UTF-8, over-size and symlinked files, and knows nothing of `.gitattributes`, so a candidate
// set that missed one of those, or a filter that dropped a file git keeps, would change what agents
// see with no other sign. This compares each lookup through the index with the same lookup forced
// to scan the whole tree (a `*` path), over a repository holding those cases, and checks the
// lookup's span names its route.
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer, Tracer } from "effect";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import * as L from "../src/lookups.ts";
import { defaultManifestSettings, rangeManifest } from "../src/manifest.ts";
import { runLogTracer, type RunLogRecord } from "../src/run-log.ts";
import { capResult } from "../src/toolkit.ts";

const directory = mkdtempSync(join(tmpdir(), "harness-uses-route-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const repository = join(directory, "repo");
const git = (...args: Array<string>) => {
  const result = Bun.spawnSync(["git", "-C", repository, ...args], {
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
};
const commit = (message: string) => {
  git("add", "-A");
  git(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.test",
    "commit",
    "-q",
    "-m",
    message,
  );
  return git("rev-parse", "HEAD");
};

let base = "";
let head = "";
beforeAll(() => {
  Bun.spawnSync(["git", "init", "-q", repository]);
  mkdirSync(join(repository, "src", "deep"), { recursive: true });
  mkdirSync(join(repository, "docs"), { recursive: true });
  writeFileSync(join(repository, "main.ts"), "export const main = 1;\n");
  base = commit("base");
  const write = (path: string, content: string | Uint8Array) =>
    writeFileSync(join(repository, path), content);
  // Parsed code: in a leading comment, a declaration, a string, a longer name, other cases.
  write(
    "src/parsed.ts",
    "// widgetCount is counted here\nexport const widgetCount = 1;\nexport const label = 'widgetCount';\nexport const widgetCountMax = widgetCount + 2;\nexport const WIDGETCOUNT = 0;\n",
  );
  write(
    "src/deep/windows.txt",
    "plain words\r\nthe widgetCount, again\r\nwidget_count and widgetcount\r\n",
  );
  write(
    "docs/guide.md",
    "# Guide\n\nCall `widgetCount` here.\n\n## Other\n\nnothing\n",
  );
  // Not UTF-8 but no NUL: the index leaves it out as binary, git reads it as text.
  write(
    "src/latin.txt",
    new Uint8Array([
      ...new TextEncoder().encode("caf"),
      0xe9,
      ...new TextEncoder().encode(" widgetCount\n"),
    ]),
  );
  // A NUL in its first bytes: binary to both, skipped by git's -I.
  write(
    "src/blob.bin",
    new Uint8Array([0, 1, 2, ...new TextEncoder().encode(" widgetCount\n")]),
  );
  // Over the index's 1 MiB bound: left out of the index, read by git.
  write(
    "src/huge.txt",
    `${"filler line\n".repeat(100_000)}the widgetCount at the end\n`,
  );
  // A symlink whose target names it: left out of the index; git decides whether to read it.
  symlinkSync("widgetCount-target", join(repository, "src", "link"));
  // Attributes the index knows nothing of: whatever git makes of them stays git's.
  write(".gitattributes", "*.lock -diff\n");
  write("src/deps.lock", "widgetCount 1.0.0\n");
  // Lines over the chunk size, which no chunk holds: a one-line bundle and a long line among others.
  mkdirSync(join(repository, "dist"), { recursive: true });
  write("dist/app.min.js", `${"var a=1;".repeat(640)}widgetCount();\n`);
  write(
    "src/long.ts",
    `export const short = 1;\nexport const table = "${"x".repeat(4_200)} widgetCount";\nexport const after = 2;\n`,
  );
  write("src/empty.ts", "");
  write("src/blank.ts", "\n\n\n");
  head = commit("cases");
});

const storeLayer = (location: ReturnType<typeof storeLocationIn>) =>
  Computations.layer.pipe(
    Layer.provideMerge(Blobs.layer(location)),
    Layer.provideMerge(
      Layer.effectDiscard(Store.prepareForWrite).pipe(
        Layer.provideMerge(Store.layer(location, { create: true })),
      ),
    ),
    Layer.provideMerge(BunFileSystem.layer),
  );

test("uses through the index answers as a whole-tree git grep does, and its span names the route", async () => {
  const records: Array<RunLogRecord> = [];
  const log = {
    path: "",
    write: (record: RunLogRecord) => {
      records.push(JSON.parse(JSON.stringify(record)) as RunLogRecord);
    },
    read: () => records,
  };
  const location = storeLocationIn(join(directory, "store"));
  const answers = await Effect.runPromise(
    Effect.gen(function* () {
      const manifest = (yield* rangeManifest(
        repository,
        { baseOid: base, headOid: head },
        defaultManifestSettings(1_000_000),
        captureOutlineSource(),
      )).value;
      const views = yield* L.revisionViews(repository, manifest);
      const ctx: L.LookupContext = {
        source: captureOutlineSource(),
        repository,
        location,
        cycleId: "cycle",
        manifest,
        head: views.head,
        base: views.base,
        hunks: new Map(manifest.hunks.map((hunk) => [hunk.hunkId, hunk])),
        commits: yield* L.rangeCommits(repository, manifest),
        snapshot: undefined,
        records: yield* Effect.context<
          Blobs.BlobStore | Computations.ComputationStore
        >(),
        handles: new L.HandleRegistry(),
        searchFrequency: new Map(),
      };
      const tool = L.usesTool(ctx);
      const uses = (params: Record<string, unknown>) =>
        Effect.map(tool.handle(tool.input?.parse(params)), (outcome) =>
          capResult(outcome.text, undefined),
        );
      // Both trees' indexes first: past `USES_INDEX_WAIT_MS` a lookup scans instead (index-wait).
      for (const tree of [views.head.tree, views.base.tree])
        yield* L.sharedTreeIndex(repository, tree, ctx.source);
      const pairs: Array<{ indexed: string; scanned: string }> = [];
      // Each lookup, and a glob path selecting the same files, which git matches itself.
      for (const [params, glob] of [
        [{ identifier: "widgetCount" }, "*"],
        [{ identifier: "WIDGETCOUNT" }, "*"],
        [{ identifier: "widget_count" }, "*"],
        [{ identifier: "absentName" }, "*"],
        [{ identifier: "widgetCount", paths: ["src/deep"] }, "src/deep/*"],
        [{ identifier: "widgetCount", paths: ["src/"] }, "src/*"],
        [{ identifier: "main", rev: "base" }, "*"],
        // Paths git normalizes go to the whole-tree scan, and still answer as git does.
        [{ identifier: "widgetCount", paths: ["src/../dist"] }, "dist/*"],
        [{ identifier: "widgetCount", paths: ["src//deep"] }, "src/deep/*"],
        [{ identifier: "widgetCount", paths: ["src/./deep"] }, "src/deep/*"],
      ] as const)
        pairs.push({
          indexed: yield* uses(params),
          scanned: yield* uses({ ...params, paths: [glob] }),
        });
      return pairs;
    }).pipe(
      Effect.provide(storeLayer(location)),
      Effect.provideService(Tracer.Tracer, runLogTracer(log)),
    ),
  );
  for (const { indexed, scanned } of answers)
    expect(indexed.replace(/ under \S+/, "")).toBe(
      scanned.replace(/ under \S+/, ""),
    );
  // The whole-word answer holds the files the index leaves out, and not the one git's -I skips.
  const all = answers[0]!.indexed;
  for (const path of [
    "src/parsed.ts",
    "src/deep/windows.txt",
    "docs/guide.md",
    "src/latin.txt",
    "src/huge.txt",
    "dist/app.min.js",
    "src/long.ts",
  ])
    expect(all).toContain(path);
  expect(all).not.toContain("src/blob.bin");
  expect(answers[3]!.indexed).toContain("No occurrence of absentName");

  const routes = records
    .filter(
      (record) => record.type === "span" && record["name"] === L.USES_SPAN,
    )
    .map((span) => span["attributes"] as Record<string, unknown>);
  expect(routes).toHaveLength(20);
  // Each pair is the lookup, through the index but for the paths git normalizes, then the
  // whole-tree scan its glob path forces.
  for (const [at, route] of routes.entries())
    expect(route).toMatchObject(
      at % 2 === 0 && at < 14
        ? { "harness.lookup.route": "index" }
        : {
            "harness.lookup.route": "git-grep",
            "harness.lookup.fallback_reason": "path-pattern",
          },
    );
  // The index named only the files that can hold the word, plus those it has no chunks for.
  const files = Number(routes[0]!["harness.lookup.files"]);
  expect(files).toBeGreaterThan(0);
  expect(files).toBeLessThan(
    Number(git("ls-tree", "-r", "--name-only", head).split("\n").length),
  );
  expect(routes[0]!["harness.git.cpu.user_ms"]).toBeGreaterThanOrEqual(0);
  // An absent word leaves only the files the index has no chunks for.
  expect(Number(routes[6]!["harness.lookup.files"])).toBeLessThan(files);
  // Real Graph has a slower cold start; measured at 10.2 s, with margin below 15 s.
}, 15_000);

test("a lookup the index cannot answer exactly scans the tree and says why", async () => {
  const records: Array<RunLogRecord> = [];
  const log = {
    path: "",
    write: (record: RunLogRecord) => {
      records.push(JSON.parse(JSON.stringify(record)) as RunLogRecord);
    },
    read: () => records,
  };
  const location = storeLocationIn(join(directory, "store-fallback"));
  const text = await Effect.runPromise(
    Effect.gen(function* () {
      const manifest = (yield* rangeManifest(
        repository,
        { baseOid: base, headOid: head },
        defaultManifestSettings(1_000_000),
        captureOutlineSource(),
      )).value;
      const views = yield* L.revisionViews(repository, manifest);
      const ctx: L.LookupContext = {
        source: captureOutlineSource(),
        repository,
        location,
        cycleId: "cycle",
        manifest,
        head: views.head,
        base: views.base,
        hunks: new Map(manifest.hunks.map((hunk) => [hunk.hunkId, hunk])),
        commits: yield* L.rangeCommits(repository, manifest),
        snapshot: undefined,
        records: yield* Effect.context<
          Blobs.BlobStore | Computations.ComputationStore
        >(),
        handles: new L.HandleRegistry(),
        searchFrequency: new Map(),
      };
      const tool = L.usesTool(ctx);
      const outcome = yield* tool.handle(
        tool.input?.parse({ identifier: "widgetCount, again" }),
      );
      return capResult(outcome.text, undefined);
    }).pipe(
      Effect.provide(storeLayer(location)),
      Effect.provideService(Tracer.Tracer, runLogTracer(log)),
    ),
  );
  expect(text).toContain("src/deep/windows.txt");
  const span = records.find(
    (record) => record.type === "span" && record["name"] === L.USES_SPAN,
  )!;
  expect(span["attributes"]).toMatchObject({
    "harness.lookup.route": "git-grep",
    "harness.lookup.fallback_reason": "not-a-word",
  });
});
