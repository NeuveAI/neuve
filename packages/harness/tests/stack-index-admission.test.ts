import { afterAll, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initTreeRepository,
  writePackageTree,
  resolveGitBinary,
} from "../src/stack/git-store.ts";
import { scrubbedEnvironment } from "../src/stack/transport.ts";
import {
  buildTreeIndex,
  stackIndexRecipeKey,
  isIndexed,
  searchTrees,
} from "../src/stack/index-store.ts";
import {
  readCatalog,
  writeCatalog,
  storeLayout,
  storeUsage,
} from "../src/stack/store.ts";
import { runStackIndex } from "../src/stack/fetch.ts";
import { resolveStackSettings } from "../src/stack/settings.ts";
import { emptyRepoStack, repoStackPath } from "../src/stack/repo-state.ts";
import legacy from "./fixtures/stack/legacy-index/provenance.json";
import { captureOutlineSource } from "../src/graph-outline.ts";
import { STACK_EVENTS } from "../src/stack/telemetry.ts";

const root = mkdtempSync(join(tmpdir(), "stack-index-admission-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const gitPath = resolveGitBinary();
if (gitPath === undefined) throw new Error("git required");
const git = {
  gitPath,
  env: scrubbedEnvironment({ gitPath, home: join(root, "home") }),
};
const fixture = async (name: string, content?: string) => {
  const directory = join(root, name);
  const files = join(directory, "files");
  mkdirSync(files, { recursive: true });
  writeFileSync(
    join(files, "one.ts"),
    content ?? `export const one = ${JSON.stringify(directory)};\n`,
  );
  const seed = join(directory, "seed.git");
  await initTreeRepository(git, seed);
  const { tree, commit } = await writePackageTree(
    git,
    seed,
    files,
    ["one.ts"],
    "fixture",
  );
  const store = join(directory, "store");
  mkdirSync(join(store, "trees"), { recursive: true });
  cpSync(seed, storeLayout(store).treeRepository(tree), { recursive: true });
  const catalog = await readCatalog(store);
  const at = new Date().toISOString();
  catalog.packages.one = {
    key: "one",
    ecosystem: "npm",
    name: "one",
    version: "1",
    integrity: "hash",
    tree,
    commit,
    folder: "src/one",
    files: 1,
    fileBytes: 1,
    objectBytes: 1,
    fetchedAt: at,
    lastUsedAt: at,
  };
  await writeCatalog(store, catalog);
  return { directory, store, tree, catalog, at };
};

for (const initial of ["absent", "known"] as const) {
  for (const additive of [true, false]) {
    test(`index admission preserves a ${additive ? "newer" : "changed known"} index published after the ${initial} guard`, async () => {
      const f = await fixture(`race-${initial}-${additive}`);
      const published = join(f.directory, "published");
      mkdirSync(join(published, "trees"), { recursive: true });
      cpSync(
        storeLayout(f.store).treeRepository(f.tree),
        storeLayout(published).treeRepository(f.tree),
        { recursive: true },
      );
      const seedBuild = await buildTreeIndex(
        git,
        published,
        f.tree,
        captureOutlineSource(),
      );
      expect(seedBuild.status).toBe("built");
      const source = storeLayout(published).indexFolder(f.tree);
      const target = storeLayout(f.store).indexFolder(f.tree);
      if (initial === "known") cpSync(source, target, { recursive: true });
      const meta = JSON.stringify({
        ...JSON.parse(readFileSync(join(source, "meta.json"), "utf8")),
        builtAt: "another-writer",
        ...(additive
          ? { retryable: true, future: { keep: "newer writer" } }
          : {}),
      });
      const wrapper = join(f.directory, "git-gated");
      // Real Git publishes via the store's existing lock after the first guard, before replacement.
      writeFileSync(
        wrapper,
        `#!${process.execPath}\nimport { cpSync, writeFileSync } from 'node:fs';\nimport { withStoreLock } from ${JSON.stringify(join(import.meta.dir, "../src/stack/store.ts"))};\nconst args = Bun.argv.slice(2);\nif (args.includes('ls-tree')) await withStoreLock(${JSON.stringify(f.store)}, async () => { cpSync(${JSON.stringify(source)}, ${JSON.stringify(target)}, { recursive: true }); writeFileSync(${JSON.stringify(join(target, "meta.json"))}, ${JSON.stringify(meta)}); });\nconst child = Bun.spawn([${JSON.stringify(gitPath)}, ...args], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit', env: process.env });\nprocess.exitCode = await child.exited;\n`,
        { mode: 0o700 },
      );
      const lines: string[] = [];
      if (initial === "known") {
        const result = await buildTreeIndex(
          { ...git, gitPath: wrapper },
          f.store,
          f.tree,
          captureOutlineSource(),
        );
        expect(result).toEqual({ status: "deferred", reason: "newer-build" });
        expect(readFileSync(join(target, "meta.json"), "utf8")).toBe(meta);
        expect(readdirSync(join(f.store, "index"))).toEqual([f.tree]);
        return;
      }
      const result = await runStackIndex({
        storeRoot: f.store,
        registryPath: join(root, "absent-registry"),
        settings: resolveStackSettings(undefined),
        trees: [f.tree],
        git: { ...git, gitPath: wrapper },
        log: (line) => lines.push(line),
      });
      expect(result.built).toEqual([]);
      expect(result.deferred).toEqual([
        { tree: f.tree, reason: "newer-build", deferredIndexes: [] },
      ]);
      expect(readFileSync(join(target, "meta.json"), "utf8")).toBe(meta);
      expect(result.events.map((event) => event.name)).toEqual([
        STACK_EVENTS.gap,
      ]);
      expect(
        lines.some((line) => line.includes("discarded staged build")),
      ).toBe(true);
      expect(readdirSync(join(f.store, "index"))).toEqual([f.tree]);
    });
  }
}

for (const protection of ["index", "pins", "known"] as const) {
  const additive = protection !== "known";
  test(`capacity admission with ${protection} metadata ${additive ? "reports a gap and keeps newer data" : "evicts known data and builds"} at the cap`, async () => {
    const f = await fixture(`capacity-${protection}`);
    const cap = 64 * 1024 ** 2;
    const other = "f".repeat(40);
    f.catalog.packages.newer = {
      ...f.catalog.packages.one!,
      key: "newer",
      tree: other,
      folder: "src/newer",
      fileBytes: cap - 2,
      objectBytes: 0,
    };
    await writeCatalog(f.store, f.catalog);
    const protectedFolder = storeLayout(f.store).indexFolder(other);
    mkdirSync(protectedFolder, { recursive: true });
    const meta = JSON.stringify({
      tree: other,
      recipe: stackIndexRecipeKey(),
      docs: 0,
      totalLength: 0,
      files: 0,
      excluded: {},
      builtAt: f.at,
      ...(protection === "index" ? { future: true } : {}),
    });
    writeFileSync(join(protectedFolder, "meta.json"), meta);
    writeFileSync(
      storeLayout(f.store).holds,
      JSON.stringify({
        version: 1,
        holds: [
          {
            store: "fixture",
            cycleId: "cycle",
            packages: ["one"],
            upstream: [],
            lastRunAt: f.at,
          },
        ],
      }),
    );
    expect(storeUsage(f.catalog).total).toBe(cap);
    let indexGit = git;
    const registryPath = join(f.directory, "registry.json");
    let pinText: string | undefined;
    if (protection === "pins") {
      const repoStore = join(f.directory, "repo-records");
      mkdirSync(repoStore);
      const state = emptyRepoStack(true);
      writeFileSync(repoStackPath(repoStore), JSON.stringify(state));
      writeFileSync(
        registryPath,
        JSON.stringify({
          version: 1,
          repositories: [{ store: repoStore, repository: f.directory }],
        }),
      );
      pinText = JSON.stringify({ ...state, future: { protect: "newer" } });
      const wrapper = join(f.directory, "git-pins");
      // A registered repository publishes additive pins during the build, after any old preflight.
      writeFileSync(
        wrapper,
        `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nimport { withStoreLock } from ${JSON.stringify(join(import.meta.dir, "../src/stack/store.ts"))};\nconst args = Bun.argv.slice(2);\nif (args.includes('ls-tree')) await withStoreLock(${JSON.stringify(f.store)}, async () => { writeFileSync(${JSON.stringify(repoStackPath(repoStore))}, ${JSON.stringify(pinText)}); });\nconst child = Bun.spawn([${JSON.stringify(gitPath)}, ...args], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit', env: process.env });\nprocess.exitCode = await child.exited;\n`,
        { mode: 0o700 },
      );
      indexGit = { ...git, gitPath: wrapper };
    }
    const result = await runStackIndex({
      storeRoot: f.store,
      registryPath,
      settings: resolveStackSettings({ totalBytes: cap }),
      trees: [f.tree],
      git: indexGit,
      log: () => {},
    });
    expect(result.usage.total).toBeLessThanOrEqual(cap);
    expect(storeUsage(await readCatalog(f.store))).toEqual(result.usage);
    if (additive) {
      expect(result.built).toEqual([]);
      expect(result.evicted).toEqual([]);
      expect(result.deferred).toEqual([
        {
          tree: f.tree,
          reason: "over-cap",
          deferredIndexes: protection === "index" ? [other] : [],
        },
      ]);
      expect(result.events.map((event) => event.name)).toEqual([
        STACK_EVENTS.gap,
      ]);
      expect(result.events[0]?.attributes).toMatchObject({
        "harness.stack.reason": "over-cap",
        "harness.stack.kind": "index",
      });
      expect(readFileSync(join(protectedFolder, "meta.json"), "utf8")).toBe(
        meta,
      );
      expect(existsSync(storeLayout(f.store).indexFolder(f.tree))).toBe(false);
      expect((await readCatalog(f.store)).indexes[f.tree]).toBeUndefined();
      expect(readdirSync(join(f.store, "index"))).toEqual([other]);
    } else {
      expect(result.built).toEqual([f.tree]);
      expect(result.deferred).toEqual([]);
      expect(result.evicted).toEqual(["newer"]);
      expect(result.events.map((event) => event.name)).toEqual([
        STACK_EVENTS.indexBuilt,
        STACK_EVENTS.evicted,
      ]);
      expect(existsSync(protectedFolder)).toBe(false);
    }
  });
}

// These index fixtures were captured from the actual historical writers.
for (const variant of [
  "available",
  "unavailable",
  "source-bound-graph",
] as const) {
  test(`upgrades the real ${variant} index fixture through admission`, async () => {
    const f = await fixture(`legacy-${variant}`, legacy.files["one.ts"]);
    expect(f.tree).toBe(legacy.tree);
    const folder = storeLayout(f.store).indexFolder(f.tree);
    cpSync(
      join(import.meta.dir, "fixtures/stack/legacy-index", variant),
      folder,
      { recursive: true },
    );
    const result = await runStackIndex({
      storeRoot: f.store,
      registryPath: join(root, "absent-registry"),
      settings: resolveStackSettings(undefined),
      trees: [f.tree],
      git,
      log: () => {},
    });
    expect(result.built).toEqual([f.tree]);
    expect(await isIndexed(f.store, f.tree, captureOutlineSource())).toBe(true);
    const search = await searchTrees(
      f.store,
      [f.tree],
      "one",
      1,
      captureOutlineSource(),
    );
    expect(search.notIndexed).toEqual([]);
    expect(search.hits[0]?.path).toBe("one.ts");
    expect(search.hits[0]?.capability).toBe("graph-symbols");
    expect(
      JSON.parse(readFileSync(join(folder, "meta.json"), "utf8")).recipe,
    ).toBe(stackIndexRecipeKey());
  });
}

test.skipIf(!process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE)(
  "retryable stack index recovers through normal locked admission",
  async () => {
    const f = await fixture("retryable");
    const previous = process.env.TMPDIR;
    try {
      process.env.TMPDIR = join(root, "missing-parent");
      expect(
        (await buildTreeIndex(git, f.store, f.tree, captureOutlineSource()))
          .status,
      ).toBe("built");
      expect(await isIndexed(f.store, f.tree, captureOutlineSource())).toBe(
        false,
      );
      process.env.TMPDIR = previous;
      const result = await runStackIndex({
        storeRoot: f.store,
        registryPath: join(root, "absent-registry"),
        settings: resolveStackSettings(undefined),
        trees: [f.tree],
        git,
        log: () => {},
      });
      expect(result.built).toEqual([f.tree]);
      expect(await isIndexed(f.store, f.tree, captureOutlineSource())).toBe(
        true,
      );
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    }
  },
);

for (const through of ["build", "admission"] as const)
  test(`stack ${through} cancellation during Graph work never publishes`, async () => {
    const f = await fixture(`cancel-graph-${through}`);
    // The Graph read makes its engine folder under `TMPDIR` when it starts and removes it when it
    // ends (`readGraphSymbols`). This test's own `TMPDIR` holds only this read's folder, never one
    // another process sharing the pool's `TMPDIR` made.
    const temporary = join(f.directory, "tmp");
    mkdirSync(temporary);
    const engineFolders = () =>
      readdirSync(temporary).filter((name) =>
        name.startsWith("neuve-graph-symbols-engine-"),
      );
    const cancellation = new Error("job cancelled");
    const controller = new AbortController();
    let atAbort: string[] | undefined;
    const timer = setInterval(() => {
      const engines = engineFolders();
      if (atAbort !== undefined || !engines.length) return;
      atAbort = engines;
      controller.abort(cancellation);
    }, 1);
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = temporary;
    try {
      const ended = await (
        through === "build"
          ? buildTreeIndex(
              { ...git, signal: controller.signal },
              f.store,
              f.tree,
              captureOutlineSource(),
            )
          : runStackIndex({
              storeRoot: f.store,
              registryPath: join(root, "absent-registry"),
              settings: resolveStackSettings(undefined),
              trees: [f.tree],
              git,
              signal: controller.signal,
              log: () => {},
            })
      ).then(
        (finished) => ({ finished }),
        (rejected: unknown) => ({ rejected }),
      );
      expect(
        atAbort?.length,
        "the abort fires while this test's own Graph engine folder exists, so during its Graph read",
      ).toBe(1);
      // The read's cleanup may finish just after the caller has its cancellation.
      const settled = Date.now() + 10_000;
      while (engineFolders().length && Date.now() < settled) await Bun.sleep(5);
      expect(
        engineFolders(),
        "the engine folder at the abort was this test's Graph read's: the read removed it on its way out",
      ).toEqual([]);
      expect(
        existsSync(storeLayout(f.store).indexFolder(f.tree)),
        "a cancelled build publishes no index",
      ).toBe(false);
      expect(
        (await readCatalog(f.store)).indexes[f.tree],
        "a cancelled build records no index in the catalog",
      ).toBeUndefined();
      expect(
        "rejected" in ended ? ended.rejected : ended,
        "the run ends in this test's cancellation, not a normal finish or another error",
      ).toBe(cancellation);
    } finally {
      clearInterval(timer);
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    }
  });

// A matching shape alone never gives this build authority over an unknown recipe.
test("an unknown recipe remains untouched", async () => {
  const f = await fixture("unknown-recipe");
  await buildTreeIndex(git, f.store, f.tree, captureOutlineSource());
  const path = join(storeLayout(f.store).indexFolder(f.tree), "meta.json");
  const metadata = JSON.stringify({
    ...JSON.parse(readFileSync(path, "utf8")),
    recipe: "future-recipe",
  });
  writeFileSync(path, metadata);
  let admitted = false;
  expect(
    await buildTreeIndex(
      git,
      f.store,
      f.tree,
      captureOutlineSource(),
      async () => {
        admitted = true;
        return true;
      },
    ),
  ).toEqual({ status: "deferred", reason: "newer-build" });
  expect(admitted).toBe(false);
  expect(readFileSync(path, "utf8")).toBe(metadata);
});

// Source freshness must not turn an understood recipe into a newer build's data.
test.skipIf(!process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE)(
  "missing executable recovers through runStackIndex admission",
  async () => {
    const f = await fixture("missing-executable");
    const previous = process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE;
    const index = () =>
      runStackIndex({
        storeRoot: f.store,
        registryPath: join(root, "absent-registry"),
        settings: resolveStackSettings(undefined),
        trees: [f.tree],
        git,
        log: () => {},
      });
    try {
      process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE = join(root, "missing-graph");
      expect((await index()).built).toEqual([f.tree]);
      const before = JSON.parse(
        readFileSync(
          join(storeLayout(f.store).indexFolder(f.tree), "meta.json"),
          "utf8",
        ),
      );
      expect(before.retryable).toBe(true);
      process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE = previous;
      expect((await index()).built).toEqual([f.tree]);
      expect(await isIndexed(f.store, f.tree, captureOutlineSource())).toBe(
        true,
      );
      const after = JSON.parse(
        readFileSync(
          join(storeLayout(f.store).indexFolder(f.tree), "meta.json"),
          "utf8",
        ),
      );
      expect(after.recipe).toBe(before.recipe);
      expect(after.source).toEqual({
        kind: "available",
        ...captureOutlineSource().key,
      });
      expect(after.retryable).toBe(false);
    } finally {
      if (previous === undefined)
        delete process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE;
      else process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE = previous;
    }
  },
);

test.skipIf(!process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE)(
  "a different executable SHA refreshes an understood stack index",
  async () => {
    const f = await fixture("changed-executable");
    const previous = process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE;
    const index = () =>
      runStackIndex({
        storeRoot: f.store,
        registryPath: join(root, "absent-registry"),
        settings: resolveStackSettings(undefined),
        trees: [f.tree],
        git,
        log: () => {},
      });
    try {
      expect((await index()).built).toEqual([f.tree]);
      const source = captureOutlineSource().key;
      const recipe = stackIndexRecipeKey();
      const fixtureExecutable = join(f.directory, "graph-fixture");
      writeFileSync(
        fixtureExecutable,
        `#!${process.execPath}
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
const args=Bun.argv.slice(2);
const emit=value=>console.log(JSON.stringify(value));
const repo=args[args.indexOf("--repo")+1];
if(args[0]==="version") emit({provider:"entire-graph",version:"source-change-fixture",identity_revision:"4",build_identity:createHash("sha256").update(readFileSync(import.meta.path)).digest("hex")});
else if(args[0]==="capabilities") emit({schema_version:"1.3",provider:"entire-graph",supported_file_extensions:[".ts"],supported_languages:["TypeScript"],semantic_languages:["TypeScript"],inventory_only_languages:[],supported_relation_types:["DEFINES","CONTAINS"],relation_support_by_language:{},relation_support_by_profile:{"syntax-only":["DEFINES","CONTAINS"]},heuristic_relation_types:[],parser_versions:{},unsupported_but_detected_language_hints:[],optional_local_only_features:{symbols_outline:true},features_requiring_network_access:{}});
else {
 emit({schema_version:"1.3",provider:"entire-graph",provider_version:"source-change-fixture",identity_revision:"4",repo_root:repo,profile:"syntax-only"});
 emit({record_type:"symbol",id:"one",kind:"variable",name:"one",qualified_name:"one",file_path:"one.ts",start_line:1,end_line:1,language:"TypeScript"});
 emit({record_type:"file_outline",file_path:"one.ts",language:"TypeScript",top_level:[{start_line:1,end_line:1,type:"lexical_declaration"}],identifiers:[[1,"one"]]});
 emit({record_type:"summary",partial_failures:[]});
}
`,
        { mode: 0o700 },
      );
      process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE = fixtureExecutable;
      expect(captureOutlineSource().key).not.toEqual(source);
      expect(await isIndexed(f.store, f.tree, captureOutlineSource())).toBe(
        false,
      );
      expect((await index()).built).toEqual([f.tree]);
      expect(await isIndexed(f.store, f.tree, captureOutlineSource())).toBe(
        true,
      );
      const after = JSON.parse(
        readFileSync(
          join(storeLayout(f.store).indexFolder(f.tree), "meta.json"),
          "utf8",
        ),
      );
      expect(after.recipe).toBe(recipe);
      expect(after.source).toEqual({
        kind: "available",
        ...captureOutlineSource().key,
      });
    } finally {
      if (previous === undefined)
        delete process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE;
      else process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE = previous;
    }
  },
);

// Additive fields inside the new source metadata belong to the newer writer too.
test("newer source metadata remains untouched when its index is stale", async () => {
  const f = await fixture("newer-source");
  await buildTreeIndex(git, f.store, f.tree, captureOutlineSource());
  const path = join(storeLayout(f.store).indexFolder(f.tree), "meta.json");
  const value = JSON.stringify({
    ...JSON.parse(readFileSync(path, "utf8")),
    source: { kind: "unavailable", path: "old-executable", future: true },
  });
  writeFileSync(path, value);
  const result = await runStackIndex({
    storeRoot: f.store,
    registryPath: join(root, "absent-registry"),
    settings: resolveStackSettings(undefined),
    trees: [f.tree],
    git,
    log: () => {},
  });
  expect(result.built).toEqual([]);
  expect(result.deferred).toEqual([
    { tree: f.tree, reason: "newer-build", deferredIndexes: [] },
  ]);
  expect(readFileSync(path, "utf8")).toBe(value);
});

// The old recipe has the same understood format but did not bind chunks to their producing engine.
test("the previous unverified Graph recipe upgrades through admission", async () => {
  const f = await fixture("pre-source-binding");
  expect(
    (await buildTreeIndex(git, f.store, f.tree, captureOutlineSource())).status,
  ).toBe("built");
  const path = join(storeLayout(f.store).indexFolder(f.tree), "meta.json");
  writeFileSync(
    path,
    JSON.stringify({
      ...JSON.parse(readFileSync(path, "utf8")),
      recipe: "f48ea78fea37c65eea4b83cbdaff1184",
    }),
  );
  expect(await isIndexed(f.store, f.tree, captureOutlineSource())).toBe(false);
  const result = await runStackIndex({
    storeRoot: f.store,
    registryPath: join(root, "absent-registry"),
    settings: resolveStackSettings(undefined),
    trees: [f.tree],
    git,
    log: () => {},
  });
  expect(result.built).toEqual([f.tree]);
  expect(await isIndexed(f.store, f.tree, captureOutlineSource())).toBe(true);
  expect(JSON.parse(readFileSync(path, "utf8")).recipe).toBe(
    stackIndexRecipeKey(),
  );
  expect(
    (await searchTrees(f.store, [f.tree], "one", 1, captureOutlineSource()))
      .hits[0]?.capability,
  ).toBe("graph-symbols");
});
