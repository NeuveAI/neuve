// This runs against the real engine's `snapshot --commit`, where it is built (`bun run build:graph`).
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer, ManagedRuntime } from "effect";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import { graphTestPrerequisite } from "../../../scripts/graph-test-prerequisite.ts";
import { captureOutlineSource } from "../src/graph-outline.ts";
import {
  declaredTestFiles,
  importTarget,
  isRelationsGap,
  readRelationsIndex,
  relationSlices,
  relationsComputation,
  relationsReadsInFlight,
  relationsRound,
} from "../src/relations.ts";
import {
  RELATIONS_FIXTURE_TIMEOUT_MS,
  relation,
  shownCallers,
  sliceSymbol,
  useRelationsFixture,
} from "./fixtures/relations-real-fixture.ts";

const source = captureOutlineSource();
const capable = (() => {
  if (!("sha256" in source.key)) return false;
  const result = Bun.spawnSync([source.executable, "capabilities", "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) return false;
  try {
    const parsed: unknown = JSON.parse(result.stdout.toString());
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      "optional_local_only_features" in parsed &&
      typeof parsed.optional_local_only_features === "object" &&
      parsed.optional_local_only_features !== null &&
      "exact_commit_bulk_streams" in parsed.optional_local_only_features &&
      parsed.optional_local_only_features.exact_commit_bulk_streams === true
    );
  } catch {
    return false;
  }
})();
const graphPrerequisite = graphTestPrerequisite({
  available: capable,
  message:
    "Graph engine is missing or stale: apps/neuve-graph/entire-graph must declare exact_commit_bulk_streams. Run `bun run build:graph` from the workspace root.",
});

const root = mkdtempSync(join(tmpdir(), "relations-real-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const fixture = useRelationsFixture();

// Why: the whole path on real Graph output — exact-commit reads of the merge base and the head
// while HEAD is on the base branch's tip, the support rule on real edges, and the slice a review
// would get, with test files from the repository's own declarations.
test.skipIf(graphPrerequisite.skip)(
  "the real engine reads the merge base and the head by commit while HEAD is on the base branch's tip, and the slice shows the real callers, the declared test callers, and counts the name match as dropped",
  async () => {
    graphPrerequisite.require();
    const prepared = await fixture.prepared();
    expect(prepared.outcomes).toEqual({ base: "computed", head: "computed" });
    expect(fixture.git("rev-parse", "HEAD")).toBe(fixture.baseTip);
    expect(fixture.git("status", "--porcelain")).toBe("");
    expect(prepared.base.coverage.commit).toBe(fixture.base);
    expect(prepared.head.coverage.commit).toBe(fixture.head);
    expect(prepared.head.coverage.tree).toBe(fixture.headTree);

    const slices = await fixture.slices();
    const target = relation("summary-total").target;
    const changed = sliceSymbol(slices, "total", "head", target);
    expect(changed?.counterpart.rule).toBe("same-id");
    expect(changed?.callers).toMatchObject({
      evidence: "supported",
      total: 5,
      trusted: 4,
    });
    // Asserted by lookup, not by position: the two rows of the test file sort by their site line,
    // which is the call's own line on an engine with call lines (the named function's call first)
    // and none for the file-level caller on one without (the file first).
    const rows = shownCallers(changed).map((caller) => [
      caller.caller.path,
      caller.caller.kind,
      caller.support,
      caller.test,
    ]);
    expect(rows).toHaveLength(5);
    for (const row of [
      ["packages/direct/src/report.ts", "symbol", "resolved", false],
      ["packages/direct/tests/math.test.ts", "file", "resolved", true],
      ["packages/direct/tests/math.test.ts", "symbol", "resolved", true],
      ["packages/wrapped/tests/wrapped.test.ts", "file", "resolved", false],
    ])
      expect(rows.slice(0, 4)).toContainEqual(row);
    // The one name-only row comes last, after every trusted one.
    expect(rows[4]).toEqual([
      "packages/direct/src/late.ts",
      "symbol",
      "import-backed",
      false,
    ]);
    // The wrapper package's test is a caller, but no declared test. Both declared test callers
    // show their place where the read's engine declares call lines for TypeScript.
    expect(changed?.testCallers).toEqual({
      evidence: "supported",
      total: 2,
      trusted: 2,
      placed: prepared.head.coverage.callSiteLineLanguages?.includes(
        "TypeScript",
      )
        ? 2
        : 0,
    });
    // A loop variable named `total` in a file that does not import it: matched, not kept.
    expect(changed?.unsupportedMatchesNotUsed).toBe(1);
    expect(
      slices
        .find((slice) => slice.key === "total")
        ?.base.symbols.map((entry) => entry.symbol.name),
    ).toEqual(["total"]);
  },
  RELATIONS_FIXTURE_TIMEOUT_MS,
);

// Why: where each import resolves, on real Graph output, read at an exact commit while HEAD is
// elsewhere: the answers are the base's (its manifest, its files), not HEAD's.
test.skipIf(graphPrerequisite.skip)(
  "the real engine says where each import of a commit resolves while HEAD is elsewhere",
  async () => {
    graphPrerequisite.require();
    const repository = join(root, "imports");
    mkdirSync(repository, { recursive: true });
    const run = (...args: string[]) => {
      const result = Bun.spawnSync(
        [
          "git",
          "-C",
          repository,
          "-c",
          "user.name=t",
          "-c",
          "user.email=t@example.test",
          "-c",
          "core.hooksPath=/dev/null",
          ...args,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return result.stdout.toString().trim();
    };
    const put = (path: string, text: string) => {
      mkdirSync(join(repository, path, ".."), { recursive: true });
      writeFileSync(join(repository, path), text);
    };
    run("init", "-q");
    put(
      "package.json",
      '{"name":"fixture","dependencies":{"@scope/pkg":"1.0.0"}}\n',
    );
    put("src/b.ts", "export const b = 1;\n");
    put(
      "src/a.ts",
      [
        'import { b } from "./b";',
        'import { deep } from "@scope/pkg/sub/path";',
        'import { readFileSync } from "node:fs";',
        'import pad from "left-pad";',
        'import { gone } from "./missing";',
        "export const all = [b, deep, readFileSync, pad, gone];",
        "",
      ].join("\n"),
    );
    // Python relative `from` imports: a package with its `__init__.py`, and a folder without one.
    put("pkg/__init__.py", "");
    put("pkg/x.py", "X = 1\n");
    put("pkg/mod.py", "from . import x\n");
    put("loose/y.py", "Y = 1\n");
    put("loose/mod.py", "from . import y\n");
    // TypeScript `"."` and `".."`: ordinary entries, sharing their relation's kind.
    put("src/dir/index.ts", "export const i = 1;\n");
    put("src/dir/use.ts", 'import { i } from ".";\nexport const u = i;\n');
    put("src/dir/sub/use.ts", 'import { i } from "..";\nexport const v = i;\n');
    run("add", ".");
    run("commit", "-qm", "base");
    const base = run("rev-parse", "HEAD");
    // HEAD moves on: the package is no longer declared, b is gone, a imports something new.
    put("package.json", '{"name":"fixture","dependencies":{}}\n');
    run("rm", "-q", "src/b.ts");
    put("src/a.ts", 'import { c } from "./c";\nexport const all = [c];\n');
    put("src/c.ts", "export const c = 1;\n");
    run("add", ".");
    run("commit", "-qm", "later");
    const later = run("rev-parse", "HEAD");

    const index = await readRelationsIndex({
      repository,
      revision: base,
      profile: "full",
      executable: source.executable,
    });
    expect(run("rev-parse", "HEAD")).toBe(later);
    expect(run("status", "--porcelain")).toBe("");
    expect(index.coverage.commit).toBe(base);
    expect(index.coverage.importTargets).toMatchObject({
      status: "classified",
    });
    const at = (specifier: string) =>
      importTarget(index, "src/a.ts", specifier);
    expect(at("./b")).toEqual({ kind: "file", path: "src/b.ts" });
    expect(at("@scope/pkg/sub/path")).toEqual({
      kind: "declared-package",
      name: "@scope/pkg",
      manifest: "package.json",
    });
    expect(at("node:fs")).toEqual({ kind: "builtin" });
    expect(at("left-pad")).toEqual({ kind: "unresolved" });
    expect(at("./missing")).toEqual({ kind: "unresolved" });
    // HEAD's import is not the base's.
    expect(at("./c")).toEqual({ kind: "not-found" });
    // `.` itself: the package's `__init__.py`, or unresolved without one.
    expect(importTarget(index, "pkg/mod.py", ".")).toEqual({
      kind: "file",
      path: "pkg/__init__.py",
    });
    expect(importTarget(index, "loose/mod.py", ".")).toEqual({
      kind: "unresolved",
    });
    // A TypeScript directory specifier resolves to the directory's `index.ts`, an ordinary entry.
    expect(importTarget(index, "src/dir/use.ts", ".")).toEqual({
      kind: "file",
      path: "src/dir/index.ts",
    });
    expect(importTarget(index, "src/dir/sub/use.ts", "..")).toEqual({
      kind: "file",
      path: "src/dir/index.ts",
    });
  },
  120_000,
);

// Why: Graph records a top-level call and a call inside a Bun `test(...)` callback as file-level
// callers; when a change removes a function with its call and its test, none of them may be listed
// as still pointing at it, and with only the function removed both must be.
test.skipIf(graphPrerequisite.skip)(
  "on the real engine, file-level callers removed with a function are not still pointing at it, and untouched ones are",
  async () => {
    graphPrerequisite.require();
    const directory = join(root, "removal");
    mkdirSync(directory, { recursive: true });
    const run = (...args: string[]) => {
      const result = Bun.spawnSync(
        [
          "git",
          "-C",
          directory,
          "-c",
          "user.name=t",
          "-c",
          "user.email=t@example.test",
          "-c",
          "core.hooksPath=/dev/null",
          ...args,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return result.stdout.toString().trim();
    };
    const put = (path: string, text: string) => {
      mkdirSync(join(directory, path, ".."), { recursive: true });
      writeFileSync(join(directory, path), text);
    };
    run("init", "-q");
    put("src/gone.ts", "export function gone(): number {\n  return 1;\n}\n");
    put(
      "src/main.ts",
      'import { gone } from "./gone";\nconsole.log("start");\ngone();\n',
    );
    put(
      "tests/gone.test.ts",
      'import { expect, test } from "bun:test";\nimport { gone } from "../src/gone";\ntest("gone", () => {\n  expect(gone()).toBe(1);\n});\n',
    );
    run("add", ".");
    run("commit", "-qm", "base");
    const base = run("rev-parse", "HEAD");
    rmSync(join(directory, "src/gone.ts"));
    rmSync(join(directory, "tests/gone.test.ts"));
    put("src/main.ts", 'console.log("start");\n');
    run("add", "-A");
    run("commit", "-qm", "head");
    const head = run("rev-parse", "HEAD");

    const location = storeLocationIn(join(root, "removal-records"));
    const runtime = ManagedRuntime.make(
      Computations.layer.pipe(
        Layer.provideMerge(Blobs.layer(location)),
        Layer.provideMerge(
          Layer.effectDiscard(Store.prepareForWrite).pipe(
            Layer.provideMerge(Store.layer(location, { create: true })),
          ),
        ),
        Layer.provideMerge(BunFileSystem.layer),
      ),
    );
    try {
      const round = await runtime.runPromise(
        relationsRound({
          repository: directory,
          graphDirectory: join(root, "removal-records", "graph"),
          base,
          head,
          source,
          waitMs: 60_000,
        }),
      );
      expect(round.outcomes).toEqual({ base: "computed", head: "computed" });
      const declared = {
        byPath: new Map([
          ["tests/gone.test.ts", [{ kind: "test" as const, by: "fixture" }]],
        ]),
        readers: [],
        gaps: [],
      };
      const tests = declaredTestFiles(declared, declared);
      const old = (path: string, startLine: number, lineCount: number) =>
        ({ side: "old", path, startLine, lineCount }) as const;
      const removedSymbol = (subjects: Parameters<typeof relationSlices>[1]) =>
        relationSlices(round, subjects, tests)[0]?.base.symbols.find(
          (entry) => entry.symbol.name === "gone",
        );
      const pointing = (
        entry: ReturnType<typeof removedSymbol>,
      ): readonly string[] =>
        entry?.stillPointingOnBase === undefined ||
        entry.stillPointingOnBase.evidence === "none"
          ? []
          : entry.stillPointingOnBase.shown.map((caller) => caller.caller.path);

      const all = removedSymbol([
        { key: "function", ranges: [old("src/gone.ts", 1, 3)] },
        {
          key: "call",
          ranges: [old("src/main.ts", 1, 1), old("src/main.ts", 3, 1)],
        },
        { key: "test", ranges: [old("tests/gone.test.ts", 1, 5)] },
      ]);
      expect(all?.counterpart.rule).toBe("none");
      // Both callers are file-level on the real engine, and both are in the base's callers.
      expect(all?.callers).toMatchObject({
        evidence: "supported",
        shown: [
          {
            caller: { kind: "file", path: "src/main.ts" },
            changedIn: ["call"],
          },
          {
            caller: { kind: "file", path: "tests/gone.test.ts" },
            changedIn: ["test"],
            test: true,
          },
        ],
      });
      expect(pointing(all)).toEqual([]);

      const functionOnly = removedSymbol([
        { key: "function", ranges: [old("src/gone.ts", 1, 3)] },
      ]);
      expect(pointing(functionOnly)).toEqual([
        "src/main.ts",
        "tests/gone.test.ts",
      ]);
    } finally {
      const deadline = Date.now() + 20_000;
      while (
        Effect.runSync(relationsReadsInFlight) > 0 &&
        Date.now() < deadline
      )
        await Bun.sleep(10);
      await runtime.dispose();
    }
  },
  120_000,
);

/**
 * A repository and a store under a short path in /tmp: a Unix socket path is at most 104 bytes on
 * macOS, and the worker keeps its socket in the Git directory only when the path fits. `remove`
 * undoes everything, however the test ends.
 */
const shortFixture = () => {
  const top = mkdtempSync("/tmp/nrel-");
  const repository = join(top, "r");
  mkdirSync(repository);
  const run = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync(
      [
        "git",
        "-C",
        cwd,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.test",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  const put = (path: string, text: string) => {
    mkdirSync(join(repository, path, ".."), { recursive: true });
    writeFileSync(join(repository, path), text);
  };
  const commit = (message: string) => {
    run(repository, "add", "-A");
    run(repository, "commit", "-qm", message);
    return run(repository, "rev-parse", "HEAD");
  };
  run(repository, "init", "-q");
  put(
    "src/paths.ts",
    'export function home(): string {\n  return "/home";\n}\n',
  );
  put(
    "src/use.ts",
    'import { home } from "./paths";\nexport function where() {\n  return home() + "/x";\n}\n',
  );
  const base = commit("base");
  put(
    "src/paths.ts",
    'export function home(): string {\n  return "/users";\n}\n',
  );
  const head = commit("head");
  const runtimes: Array<{ dispose: () => Promise<void> }> = [];
  /** A store of its own; every store of the fixture shares one Graph folder. */
  const store = (name: string) => {
    const location = storeLocationIn(join(top, name));
    const runtime = ManagedRuntime.make(
      Computations.layer.pipe(
        Layer.provideMerge(Blobs.layer(location)),
        Layer.provideMerge(
          Layer.effectDiscard(Store.prepareForWrite).pipe(
            Layer.provideMerge(Store.layer(location, { create: true })),
          ),
        ),
        Layer.provideMerge(BunFileSystem.layer),
      ),
    );
    runtimes.push(runtime);
    return runtime;
  };
  const graphDirectory = join(top, "graph");
  const clones = () =>
    existsSync(join(graphDirectory, "clones"))
      ? readdirSync(join(graphDirectory, "clones"))
      : [];
  const servers: Server[] = [];
  return {
    repository,
    graphDirectory,
    base,
    head,
    put,
    commit,
    run,
    store,
    clones,
    /** The worker's socket, bound where the worker binds it when the path is short enough. */
    bindWorkerSocket: async () => {
      const path = join(repository, ".git", "neuve", "worker.sock");
      mkdirSync(join(path, ".."), { recursive: true });
      const server = createServer();
      servers.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(path, () => resolve());
      });
      if (!lstatSync(path).isSocket())
        throw new Error("the worker socket was not bound");
      return path;
    },
    remove: async () => {
      const deadline = Date.now() + 20_000;
      while (
        Effect.runSync(relationsReadsInFlight) > 0 &&
        Date.now() < deadline
      )
        await Bun.sleep(10);
      for (const runtime of runtimes) await runtime.dispose();
      for (const server of servers)
        await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(top, { recursive: true, force: true });
    },
  };
};

const indexSha = (repository: string) =>
  createHash("sha256")
    .update(readFileSync(join(repository, ".git", "index")))
    .digest("hex");

// Why: the worker keeps its socket in the repository's Git directory, where the engine refuses to
// start Git; the read must go through the store's private clone, and leave the repository alone.
test.skipIf(graphPrerequisite.skip)(
  "with the worker's socket in the repository's Git directory, both sides are read from the store's private clone and the repository is untouched",
  async () => {
    graphPrerequisite.require();
    const fixture = shortFixture();
    try {
      const socket = await fixture.bindWorkerSocket();
      const { repository, base, head } = fixture;
      const state = () => ({
        head: fixture.run(repository, "rev-parse", "HEAD"),
        branch: fixture.run(repository, "symbolic-ref", "HEAD"),
        index: indexSha(repository),
        status: fixture.run(repository, "status", "--porcelain"),
      });
      const before = state();
      const round = await fixture.store("records").runPromise(
        relationsRound({
          repository,
          graphDirectory: fixture.graphDirectory,
          base,
          head,
          source,
          waitMs: 60_000,
        }),
      );
      expect(round.outcomes).toEqual({ base: "computed", head: "computed" });
      if (isRelationsGap(round.base) || isRelationsGap(round.head))
        throw new Error("a side was not read");
      expect(round.base.coverage.commit).toBe(base);
      expect(round.head.coverage.commit).toBe(head);
      // The engine was given the clone: its repository key is the clone folder's name, where a
      // read of the repository itself names the repository's folder.
      const [clone, ...others] = fixture.clones();
      expect(others).toEqual([]);
      expect(round.head.coverage.repoKey).toBe(`local/${clone}`);
      expect(round.base.coverage.repoKey).toBe(`local/${clone}`);
      expect(lstatSync(socket).isSocket()).toBe(true);
      expect(state()).toEqual(before);
    } finally {
      await fixture.remove();
    }
  },
  120_000,
);

// Why: the clone reads the repository's objects through alternates, so a commit made after the
// clone exists is read without the clone being made again.
test.skipIf(graphPrerequisite.skip)(
  "a commit made after the private clone exists is read from it",
  async () => {
    graphPrerequisite.require();
    const fixture = shortFixture();
    try {
      const { repository, base, head, graphDirectory } = fixture;
      const runtime = fixture.store("records");
      const first = await runtime.runPromise(
        relationsRound({
          repository,
          graphDirectory,
          base,
          head,
          source,
          waitMs: 60_000,
        }),
      );
      expect(first.outcomes).toEqual({ base: "computed", head: "computed" });
      expect(fixture.clones()).toHaveLength(1);
      fixture.put(
        "src/later.ts",
        'import { home } from "./paths";\nexport function later() {\n  return home();\n}\n',
      );
      const later = fixture.commit("later");
      const second = await runtime.runPromise(
        relationsRound({
          repository,
          graphDirectory,
          base: head,
          head: later,
          source,
          waitMs: 60_000,
        }),
      );
      expect(second.outcomes).toEqual({ base: "stored", head: "computed" });
      if (isRelationsGap(second.head)) throw new Error("the head was not read");
      expect(second.head.coverage.commit).toBe(later);
      const { strings } = second.head;
      expect(second.head.symbols.name.map((at) => strings[at])).toContain(
        "later",
      );
      expect(fixture.clones()).toHaveLength(1);
    } finally {
      await fixture.remove();
    }
  },
  120_000,
);

// Why: a search's preparation moves the clone's HEAD; an exact-commit read names its commit and
// never reads HEAD, so where HEAD points cannot change what it reads.
test.skipIf(graphPrerequisite.skip)(
  "moving the private clone's HEAD between two reads of one commit gives the same index",
  async () => {
    graphPrerequisite.require();
    const fixture = shortFixture();
    try {
      const { repository, base, head, graphDirectory } = fixture;
      const read = (store: string) =>
        fixture
          .store(store)
          .runPromise(
            relationsComputation(repository, base, source, graphDirectory),
          );
      const first = await read("one");
      expect(first.read.status).toBe("computed");
      const [clone] = fixture.clones();
      if (clone === undefined) throw new Error("no clone");
      const clonePath = join(graphDirectory, "clones", clone);
      // The first read ran with the clone's HEAD at the head commit; the second runs with it at
      // the base, detached, as a preparation leaves it.
      expect(fixture.run(clonePath, "rev-parse", "HEAD")).toBe(head);
      fixture.run(clonePath, "update-ref", "--no-deref", "HEAD", base);
      expect(fixture.run(clonePath, "rev-parse", "HEAD")).toBe(base);
      // A second store, so the read runs again rather than being found.
      const second = await read("two");
      expect(second.read.status).toBe("computed");
      expect(second.read.index.coverage.commit).toBe(base);
      expect(second.read.index).toEqual(first.read.index);
    } finally {
      await fixture.remove();
    }
  },
  120_000,
);

// Why: `from . import *` makes `.` a specifier with a relation of its own, which `..sub` joins and
// `..` rides on, so one relation carries two relative modules. A reader allowing one refused the
// whole commit, leaving that side of the round a gap; each specifier must answer its own target.
test.skipIf(graphPrerequisite.skip)(
  "on the real engine, Python relative modules sharing one relation are read on both sides of a round, and each answers its own target",
  async () => {
    graphPrerequisite.require();
    const fixture = shortFixture();
    try {
      const { repository, graphDirectory, put, commit, run } = fixture;
      put("pkg/__init__.py", "");
      put("pkg/sub/__init__.py", "");
      put("pkg/sub/mod.py", "from . import *\nfrom .. import sub\n");
      const base = commit("python base");
      // Without `pkg/__init__.py`, `..` is unresolved beside two file entries on mod.py's relation;
      // deep.py adds a wildcard parent, `.` riding on `.mod`, and a module above the root.
      run(repository, "rm", "-q", "pkg/__init__.py");
      put(
        "pkg/sub/deep.py",
        "from .. import *\nfrom . import mod\nfrom ... import *\n",
      );
      const head = commit("python head");
      const round = await fixture.store("records").runPromise(
        relationsRound({
          repository,
          graphDirectory,
          base,
          head,
          source,
          waitMs: 60_000,
        }),
      );
      expect(round.outcomes).toEqual({ base: "computed", head: "computed" });
      if (isRelationsGap(round.base) || isRelationsGap(round.head))
        throw new Error("a side was not read");
      expect(round.base.coverage.commit).toBe(base);
      expect(round.head.coverage.commit).toBe(head);
      const answers = (
        side: typeof round.head,
        path: string,
        specifiers: string[],
      ) =>
        Object.fromEntries(
          specifiers.map((specifier) => [
            specifier,
            importTarget(side, path, specifier),
          ]),
        );
      const init = { kind: "file", path: "pkg/sub/__init__.py" } as const;
      expect(
        answers(round.base, "pkg/sub/mod.py", [".", "..", "..sub"]),
      ).toEqual({
        ".": init,
        "..": { kind: "file", path: "pkg/__init__.py" },
        "..sub": init,
      });
      expect(
        answers(round.head, "pkg/sub/mod.py", [".", "..", "..sub"]),
      ).toEqual({ ".": init, "..": { kind: "unresolved" }, "..sub": init });
      expect(
        answers(round.head, "pkg/sub/deep.py", [".", "..", ".mod", "..."]),
      ).toEqual({
        ".": init,
        "..": { kind: "unresolved" },
        ".mod": { kind: "file", path: "pkg/sub/mod.py" },
        "...": { kind: "unresolved" },
      });
    } finally {
      await fixture.remove();
    }
  },
  120_000,
);
