import { INDEX_BOUNDS } from "../src/search-index.ts";
import {
  GitReadSnapshot,
  withGitReadSnapshot,
} from "../src/git-read-snapshot.ts";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Option, Metric } from "effect";
import {
  GitObjectProtocol,
  GIT_READ_RETAINED_BYTES,
  GIT_READ_IN_FLIGHT_BYTES,
  GIT_READ_TOTAL_BYTES,
  GitBatchObjectSource,
  type GitObjectSource,
  GitReadSession,
} from "@neuve/graph-client/git-read-session";
import {
  GitFailed,
  git,
  gitSubcommand,
  withGitReadSession,
} from "../src/git.ts";
import {
  diffTrees,
  lsTree,
  readBlobs,
  treeOf,
  mergeBase,
  commitTexts,
  type TreeEntry,
} from "../src/git-objects.ts";
import { DECLARATION_GAPS, readDeclarations } from "../src/declarations.ts";

const roots: string[] = [];
const readers: GitReadSession[] = [];
afterEach(async () => {
  await Promise.all(readers.splice(0).map((reader) => reader.close()));
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const fixture = (format: "sha1" | "sha256" = "sha1") => {
  const root = mkdtempSync(join(tmpdir(), "git-session-"));
  roots.push(root);
  const command = (...args: string[]) => {
    const out = Bun.spawnSync(["git", "-C", root, ...args]);
    if (out.exitCode !== 0) throw new Error("Fixture Git failed");
    return out.stdout.toString().trim();
  };
  command("init", "-q", `--object-format=${format}`);
  const blob = (body: Uint8Array | string, write = true) => {
    const out = Bun.spawnSync(
      ["git", "-C", root, "hash-object", ...(write ? ["-w"] : []), "--stdin"],
      { stdin: typeof body === "string" ? Buffer.from(body) : body },
    );
    if (out.exitCode !== 0) throw new Error("Fixture hash failed");
    return out.stdout.toString().trim();
  };
  const commit = () => {
    command("add", ".");
    command(
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-qm",
      "fixture",
    );
    return command("rev-parse", "HEAD");
  };
  return { root, command, blob, commit };
};
const open = async (root: string) => {
  const reader = await GitReadSession.open(root);
  readers.push(reader);
  return reader;
};
const signal = () => new AbortController().signal;
const decode = (bytes: Uint8Array | undefined) =>
  new TextDecoder().decode(bytes);
const held = Effect.map(GitReadSnapshot, (value) => {
  if (Option.isNone(value)) throw new Error("Expected snapshot");
  return value.value;
});
const deferred = () => {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

for (const format of ["sha1", "sha256"] as const) {
  // Why: one stream must preserve ordering and object width across concurrent, duplicated requests.
  test(`interleaved exact reads, duplicate ids and uncached missing objects in ${format}`, async () => {
    const f = fixture(format),
      a = f.blob("first"),
      b = f.blob("second");
    const missing = f.blob("arrives later", false),
      reader = await open(f.root);
    const signal = new AbortController().signal;
    const [one, two] = await Promise.all([
      reader.blobs([a, a, missing], undefined, signal),
      reader.blobs([b, a], undefined, signal),
    ]);
    expect([...one.keys()]).toEqual([a]);
    expect([...two.keys()]).toEqual([b, a]);
    expect(new TextDecoder().decode(two.get(b))).toBe("second");
    expect(new TextDecoder().decode(two.get(a))).toBe("first");
    f.blob("arrives later");
    expect(
      new TextDecoder().decode(
        (await reader.blobs([missing], undefined, signal)).get(missing),
      ),
    ).toBe("arrives later");
    expect(one.get(a)?.buffer).toBe(two.get(a)?.buffer);
    expect(
      new TextDecoder().decode(
        (await reader.blobs([a], undefined, signal)).get(a),
      ),
    ).toBe("first");
  });
  // Why: symlink data must remain literal and gitlinks must never become implicit submodule reads.
  test(`tree modes and non-blob handling in ${format}`, async () => {
    const f = fixture(format);
    writeFileSync(join(f.root, "plain"), "body");
    symlinkSync("plain", join(f.root, "link"));
    const commit = f.commit();
    f.command(
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${commit},submodule`,
    );
    const tree = f.command("write-tree");
    await Effect.runPromise(
      withGitReadSnapshot(
        f.root,
        INDEX_BOUNDS.maxFileBytes,
      )(
        Effect.gen(function* () {
          const entries = yield* lsTree(f.root, tree);
          const link = entries.find((entry) => entry.path === "link");
          expect(link?.mode).toBe("120000");
          expect(
            entries.find((entry) => entry.path === "submodule")?.mode,
          ).toBe("160000");
          const blobs = yield* readBlobs(
            f.root,
            entries.map((entry) => entry.oid),
          );
          expect(new TextDecoder().decode(blobs.get(link?.oid ?? ""))).toBe(
            "plain",
          );
          expect(blobs.has(commit)).toBe(false);
        }),
      ),
    );
  });
}

// Why: protocol corruption must fail rather than shifting later objects or publishing partial bytes.
test("strict headers, truncated bodies, separators and byte-split frames", async () => {
  const oid = "a".repeat(40);
  const protocol = (text: string) =>
    new GitObjectProtocol(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const byte of Buffer.from(text))
            controller.enqueue(Uint8Array.of(byte));
          controller.close();
        },
      }).getReader(),
    );
  for (const text of [
    `${oid} blob 3`,
    `${oid} blob -1\n`,
    `${"b".repeat(40)} blob 3\n`,
    `${oid} blob 9007199254740992\n`,
    "x".repeat(161),
  ])
    await expect(protocol(text).header(oid)).rejects.toThrow();
  const short = protocol(`${oid} blob 3\nab`);
  expect(await short.header(oid)).toEqual({ type: "blob", size: 3 });
  await expect(short.body(3)).rejects.toThrow();
  const bad = protocol(`${oid} blob 1\na!`);
  await bad.header(oid);
  await bad.body(1);
  await expect(bad.separator()).rejects.toThrow();
  const good = protocol(`${oid} blob 3\nabc\n${oid} missing\n`);
  await good.header(oid);
  expect(await good.body(3, 1)).toEqual(Uint8Array.of(97));
  await good.separator();
  expect(await good.header(oid)).toBeUndefined();
});

// Why: NUL stdin batching must preserve unusual paths, source-tree attributes and attribute order.
test("attributes batch unusual paths against the selected revision", async () => {
  const f = fixture();
  const paths = [
    "line\nbreak",
    "tab\tname",
    "-leading",
    ...Array.from({ length: 810 }, (_, i) => `file${i}`),
  ];
  writeFileSync(
    join(f.root, ".gitattributes"),
    "* linguist-generated=true linguist-documentation=true\n",
  );
  for (const path of paths) writeFileSync(join(f.root, path), "body");
  const head = f.commit();
  writeFileSync(join(f.root, ".gitattributes"), "* -linguist-generated\n");
  const result = await Effect.runPromise(
    withGitReadSnapshot(
      f.root,
      INDEX_BOUNDS.maxFileBytes,
    )(
      Effect.gen(function* () {
        return yield* readDeclarations({
          repository: f.root,
          revision: head,
          tree: yield* lsTree(f.root, head),
          paths,
        });
      }),
    ),
  );
  for (const path of paths)
    expect(result.byPath.get(path)?.map((item) => item.kind)).toEqual([
      "generated",
      "doc",
    ]);
});

// Why: 256 SHA-256 commands can fill stdin while Git fills stdout. Both pipes must advance together.
test("SHA-256 pipelining drains responses while commands flush", async () => {
  const f = fixture("sha256");
  const objects = Array.from({ length: 300 }, (_, i) => ({
    bytes: Buffer.from(`${i}:` + "x".repeat(4096)),
    oid: "",
  }));
  const paths = objects.map((object, i) => {
    const path = join(f.root, `object-${i}`);
    writeFileSync(path, object.bytes);
    return path;
  });
  const hashed = Bun.spawnSync(
    ["git", "-C", f.root, "hash-object", "-w", "--stdin-paths"],
    { stdin: Buffer.from(paths.join("\n") + "\n") },
  );
  expect(hashed.exitCode).toBe(0);
  const ids = hashed.stdout.toString().trim().split("\n");
  for (const [i, object] of objects.entries()) object.oid = ids[i] ?? "";
  const reader = await open(f.root);
  const result = await reader.blobs(
    objects.map((object) => object.oid),
    undefined,
    new AbortController().signal,
  );
  expect(result.size).toBe(300);
  for (const object of objects)
    expect(result.get(object.oid)).toEqual(new Uint8Array(object.bytes));
}, 60000);

// Why: worker scopes and expired captured contexts still need assessed native reads.
test("no snapshot and a straggler after close use native processes", async () => {
  const f = fixture(),
    oid = f.blob("native");
  const executable = Bun.which("git");
  if (executable === null) throw new Error("Git unavailable");
  const original = Bun.spawn,
    calls: string[][] = [];
  Bun.spawn = new Proxy(original, {
    apply(target, self, args) {
      calls.push([...args[0]]);
      return Reflect.apply(target, self, args);
    },
  });
  try {
    await Effect.runPromise(Effect.scoped(readBlobs(f.root, [oid])));
    expect(calls.filter((args) => args.includes("cat-file"))).toEqual([
      [
        executable,
        "-c",
        `safe.directory=${f.root}`,
        "--no-replace-objects",
        "--no-optional-locks",
        "--no-pager",
        "-C",
        f.root,
        "cat-file",
        "--batch",
      ],
    ]);
    const context = await Effect.runPromise(
      withGitReadSnapshot(
        f.root,
        INDEX_BOUNDS.maxFileBytes,
      )(Effect.context<never>()),
    );
    calls.length = 0;
    expect(
      decode(
        (await Effect.runPromiseWith(context)(readBlobs(f.root, [oid]))).get(
          oid,
        ),
      ),
    ).toBe("native");
    expect(calls.filter((args) => args.includes("cat-file"))).toEqual([
      [
        executable,
        "-c",
        `safe.directory=${f.root}`,
        "--no-replace-objects",
        "--no-optional-locks",
        "--no-pager",
        "-C",
        f.root,
        "cat-file",
        "--batch",
      ],
    ]);
  } finally {
    Bun.spawn = original;
  }
});

// Why: a review binds one physical repository and counts every foreign fallback.
test("physical aliases share one source and foreign repositories use main", async () => {
  const f = fixture(),
    foreign = fixture(),
    oid = f.blob("shared"),
    other = foreign.blob("foreign");
  const alias = `${f.root}-alias`;
  symlinkSync(f.root, alias);
  roots.push(alias);
  const original = Bun.spawn,
    calls: string[][] = [];
  Bun.spawn = new Proxy(original, {
    apply(target, self, args) {
      calls.push([...args[0]]);
      return Reflect.apply(target, self, args);
    },
  });
  try {
    await Effect.runPromise(
      withGitReadSnapshot(
        f.root,
        INDEX_BOUNDS.maxFileBytes,
      )(
        Effect.gen(function* () {
          yield* readBlobs(f.root, [oid]);
          expect(decode((yield* readBlobs(alias, [oid])).get(oid))).toBe(
            "shared",
          );
          expect(
            decode((yield* readBlobs(foreign.root, [other])).get(other)),
          ).toBe("foreign");
          const reader = yield* held;
          expect(reader.counters.foreignRepository).toBe(1);
          expect(reader.counters.hits).toBe(1);
        }),
      ),
    );
    expect(
      calls.filter((args) => args.includes("--batch-command")),
    ).toHaveLength(1);
    expect(calls.filter((args) => args.includes("--git-dir"))).toHaveLength(3);
    expect(calls.filter((args) => args.includes("--batch"))).toHaveLength(1);
    const objectArgs =
      calls.find((args) => args.includes("--batch-command")) ?? [];
    expect(objectArgs).not.toContain("--no-lazy-fetch");
    for (const option of [
      "--no-replace-objects",
      "--no-optional-locks",
      "--no-pager",
    ])
      expect(objectArgs).toContain(option);
  } finally {
    Bun.spawn = original;
  }
});

// Why: prefix probes must retain small full bodies for the chunker's subsequent full read.
test("prefix then full below the index cap has zero repeats and shares read-only storage", async () => {
  const f = fixture(),
    oid = f.blob("small body"),
    reader = await open(f.root);
  const prefix = await reader.blobs([oid], 2, signal());
  expect(decode(prefix.get(oid))).toBe("sm");
  const full = await reader.blobs([oid], undefined, signal());
  expect(decode(full.get(oid))).toBe("small body");
  expect(prefix.get(oid)?.buffer).toBe(full.get(oid)?.buffer);
  expect(decode((await reader.blobs([oid], 5, signal())).get(oid))).toBe(
    "small",
  );
  expect(reader.counters.repeatReads).toBe(0);
  expect(reader.counters.uniqueObjectsRead).toBe(1);
});

// Why: retained bytes must stay capped without eviction; unretained and prefix upgrades count repeats.
test("retained budget stops at its cap and later unretained reads count repeats", async () => {
  const f = fixture(),
    a = f.blob("a".repeat(100)),
    b = f.blob("b".repeat(100));
  const reader = await GitReadSession.open(f.root, { retainedBytes: 180 });
  readers.push(reader);
  await reader.blobs([a, b], undefined, signal());
  await reader.blobs([a, b], undefined, signal());
  expect(reader.retainedBytes).toBe(140);
  expect(reader.counters.peakRetainedBytes).toBe(140);
  expect(reader.counters.unretained).toBe(2);
  expect(reader.counters.hits).toBe(1);
  expect(reader.counters.repeatReads).toBe(1);
  let loads = 0;
  const load = async () => {
    loads++;
    return "c".repeat(100);
  };
  for (let i = 0; i < 2; i++)
    expect(await reader.command("command", load, signal())).toBe(
      "c".repeat(100),
    );
  expect(loads).toBe(2);
  expect(reader.retainedBytes).toBe(140);
  expect(reader.counters.unretained).toBe(4);
  expect(GIT_READ_RETAINED_BYTES + GIT_READ_IN_FLIGHT_BYTES).toBe(
    GIT_READ_TOTAL_BYTES,
  );
  const large = f.blob(new Uint8Array(1024 * 1024 + 1).fill(65));
  const normal = await open(f.root);
  expect((await normal.blobs([large], 7, signal())).get(large)?.length).toBe(7);
  expect(normal.retainedBytes).toBe(47);
  expect(
    (await normal.blobs([large], undefined, signal())).get(large)?.length,
  ).toBe(1024 * 1024 + 1);
  expect(normal.counters.repeatReads).toBe(1);
});

// Why: independent callers may decode one shared object without changing the next caller's bytes.
test("snapshot callers share read-only bytes across decoding", async () => {
  const f = fixture(),
    oid = f.blob("shared ✓ text"),
    reader = await open(f.root);
  const read = () =>
    Effect.runPromise(
      readBlobs(f.root, [oid]).pipe(
        Effect.provideService(GitReadSnapshot, Option.some(reader)),
      ),
    );
  const first = (await read()).get(oid);
  expect(decode(first)).toBe("shared ✓ text");
  const second = (await read()).get(oid);
  expect(second?.buffer).toBe(first?.buffer);
  expect(decode(second)).toBe("shared ✓ text");
  expect(first).toEqual(new TextEncoder().encode("shared ✓ text"));
  expect(reader.counters.uniqueObjectsRead).toBe(1);
  expect(reader.counters.hits).toBe(1);
});

// Why: one oversized object must not fail other reads or shift the next protocol response.
test("oversized full reads are omitted and oversized prefixes preserve framing", async () => {
  const f = fixture(),
    oid = f.blob(new Uint8Array(GIT_READ_IN_FLIGHT_BYTES + 1).fill(65)),
    tail = f.blob("tail"),
    reader = await open(f.root);
  const full = await reader.blobs([oid, tail], undefined, signal());
  expect(full.has(oid)).toBe(false);
  expect(decode(full.get(tail))).toBe("tail");
  expect(reader.counters.oversized).toBe(1);
  const prefix = await reader.blobs([oid, tail], 7, signal());
  expect(prefix.get(oid)).toEqual(new Uint8Array(7).fill(65));
  expect(decode(prefix.get(tail))).toBe("tail");
  expect(reader.retainedBytes).toBeLessThan(1024);
  expect((await reader.blobs([oid], undefined, signal())).has(oid)).toBe(false);
  expect(reader.counters.oversized).toBe(2);
  expect(reader.counters.sourceRestarts).toBe(0);
  const publicRead = await Effect.runPromise(
    readBlobs(f.root, [oid, tail]).pipe(
      Effect.provideService(GitReadSnapshot, Option.some(reader)),
    ),
  );
  expect(publicRead.has(oid)).toBe(false);
  expect(decode(publicRead.get(tail))).toBe("tail");
}, 30000);

// Why: the user's safe.directory approval must be checked before isolated Git gains its approval.
test("native ownership refusal is preserved and global safe.directory approval works", async () => {
  const f = fixture(),
    oid = f.blob("trusted");
  const global = join(f.root, "global-config");
  const probe = async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "--eval",
        `
      import { GitReadSession } from "@neuve/graph-client/git-read-session";
      const reader = await GitReadSession.open(${JSON.stringify(f.root)});
      let refused = false;
      try { await reader.blobs([${JSON.stringify(oid)}], undefined, new AbortController().signal); }
      catch(error) { if (!String(error).includes("dubious ownership")) throw error; refused = true; }
      finally { await reader.close(); }
      console.log(JSON.stringify({ refused }));
    `,
      ],
      {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...process.env,
          GIT_TEST_ASSUME_DIFFERENT_OWNER: "1",
          GIT_CONFIG_GLOBAL: global,
          GIT_CONFIG_NOSYSTEM: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe("");
    expect(exit).toBe(0);
    return JSON.parse(stdout).refused;
  };
  writeFileSync(global, "");
  expect(await probe()).toBe(true);
  writeFileSync(global, `[safe]\n\tdirectory = ${f.root}\n`);
  expect(await probe()).toBe(false);
});

// Why: only exact immutable argv are memoised, and native misses keep the same isolated policy.
test("commands memoise one answer by full argv, with isolated config and no attribute rechecks", async () => {
  const f = fixture();
  writeFileSync(join(f.root, "file"), "one\n");
  const base = f.commit();
  writeFileSync(join(f.root, "file"), "two\n");
  const head = f.commit();
  const global = join(f.root, "global-config");
  writeFileSync(global, "[diff]\n\talgorithm = histogram\n");
  const saved = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = global;
  const native = await Effect.runPromise(diffTrees(f.root, base, head));
  const original = Bun.spawn,
    calls: { args: string[]; env: unknown }[] = [];
  Bun.spawn = new Proxy(original, {
    apply(target, self, args) {
      calls.push({ args: [...args[0]], env: args[1]?.env });
      return Reflect.apply(target, self, args);
    },
  });
  try {
    await Effect.runPromise(
      withGitReadSnapshot(
        f.root,
        INDEX_BOUNDS.maxFileBytes,
      )(
        Effect.gen(function* () {
          expect(yield* diffTrees(f.root, base, head)).toEqual(native);
          writeFileSync(join(f.root, ".git/info/attributes"), "file -diff\n");
          expect(yield* diffTrees(f.root, base, head)).toEqual(native);
          expect(yield* treeOf(f.root, head)).toBe(yield* treeOf(f.root, head));
          expect(yield* mergeBase(f.root, base, head)).toBe(base);
          expect(yield* commitTexts(f.root, base, head)).toEqual(
            yield* commitTexts(f.root, base, head),
          );
          yield* git(f.root, ["rev-parse", "HEAD"]);
          yield* git(f.root, ["rev-parse", "HEAD"]);
          yield* git(f.root, ["grep", "-F", "two", head]);
          yield* git(f.root, ["grep", "-F", "two", head]);
        }),
      ),
    );
    expect(calls.filter((call) => call.args.includes("diff"))).toHaveLength(1);
    expect(calls.filter((call) => call.args.includes("HEAD"))).toHaveLength(2);
    expect(calls.filter((call) => call.args.includes("grep"))).toHaveLength(2);
    for (const call of calls.filter((call) => !call.args.includes("--git-dir")))
      expect(call.env).toMatchObject({
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_NO_LAZY_FETCH: "1",
        GIT_ALLOW_PROTOCOL: "",
      });
  } finally {
    Bun.spawn = original;
    if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = saved;
  }
});

// Why: all callers sharing a command own their cancellation and its span must reach the run tracer.
test("shared command survives its leader's cancellation and snapshot close reaps pending commands", async () => {
  const f = fixture();
  writeFileSync(join(f.root, "file"), "body");
  const head = f.commit();
  const { Tracer } = await import("effect");
  let spans = 0;
  const tracer = Tracer.make({
    span(options) {
      if (options.name === "harness.git") spans++;
      return Tracer.nativeTracer.span(options);
    },
  });
  await Effect.runPromise(
    withGitReadSnapshot(
      f.root,
      INDEX_BOUNDS.maxFileBytes,
    )(
      Effect.gen(function* () {
        const reader = yield* held,
          entered = deferred(),
          release = deferred();
        const context = yield* Effect.context<never>();
        const controller = new AbortController();
        let loads = 0;
        const load = async (abort: AbortSignal) => {
          loads++;
          entered.resolve();
          await release.promise;
          abort.throwIfAborted();
          return "shared";
        };
        const first = reader
          .command("controlled", load, controller.signal)
          .catch(() => undefined);
        yield* Effect.promise(() => entered.promise);
        const second = reader.command("controlled", load, signal());
        controller.abort();
        release.resolve();
        expect(yield* Effect.promise(() => second)).toBe("shared");
        yield* Effect.promise(() => first);
        expect(loads).toBe(1);
        const results = yield* Effect.promise(() =>
          Promise.all([
            Effect.runPromiseWith(context)(lsTree(f.root, head)),
            Effect.runPromiseWith(context)(lsTree(f.root, head)),
          ]),
        );
        for (const result of results)
          expect(result.map((entry) => entry.path)).toEqual(["file"]);
      }),
    ).pipe(Effect.provideService(Tracer.Tracer, tracer)),
  );
  expect(spans).toBe(1);
});

// Why: queues wait rather than refuse, and a cancelled active caller must drain for its sibling.
test("80 readers, active cancellation and queued cancellation leave siblings usable", async () => {
  const f = fixture(),
    oid = f.blob("body"),
    reader = await open(f.root);
  const entered = deferred(),
    release = deferred();
  const source = new GitBatchObjectSourceForTest();
  // Hold the actual source exchange before its first native spawn.
  const realSource = new (
    await import("@neuve/graph-client/git-read-session")
  ).GitBatchObjectSource(f.root, release.promise, 1024 * 1024);
  source.read = async (...args) => {
    entered.resolve();
    return realSource.read(...args);
  };
  source.close = () => realSource.close();
  const controlled = await GitReadSession.open(f.root, {
    source: () => source,
  });
  readers.push(controlled);
  const active = new AbortController(),
    queued = new AbortController();
  const run = (abort: AbortSignal) =>
    Effect.runPromise(
      readBlobs(f.root, [oid]).pipe(
        Effect.provideService(GitReadSnapshot, Option.some(controlled)),
      ),
      { signal: abort },
    );
  const a = run(active.signal).catch(() => undefined);
  await entered.promise;
  const b = run(queued.signal).catch(() => undefined);
  const sibling = run(signal());
  active.abort();
  queued.abort();
  release.resolve();
  await Promise.all([a, b]);
  expect(decode((await sibling).get(oid))).toBe("body");
  const results = await Promise.all(
    Array.from({ length: 80 }, () => reader.blobs([oid], undefined, signal())),
  );
  for (const result of results) expect(decode(result.get(oid))).toBe("body");
});
class GitBatchObjectSourceForTest implements GitObjectSource {
  read: GitObjectSource["read"] = async () => {
    throw new Error("Not configured");
  };
  close: GitObjectSource["close"] = async () => {};
}

// Why: protocol and child failures retry once without clearing previously verified objects.
test("a child failure restarts the source and preserves verified map entries", async () => {
  const f = fixture(),
    a = f.blob("first"),
    b = f.blob("second");
  const original = Bun.spawn;
  let objectChild: ReturnType<typeof Bun.spawn> | undefined;
  Bun.spawn = new Proxy(original, {
    apply(target, self, args) {
      const child = Reflect.apply(target, self, args);
      if (args[0].includes("--batch-command")) objectChild = child;
      return child;
    },
  });
  try {
    const reader = await open(f.root);
    await reader.blobs([a], undefined, signal());
    objectChild?.kill("SIGKILL");
    await objectChild?.exited;
    expect(
      decode((await reader.blobs([a, b], undefined, signal())).get(b)),
    ).toBe("second");
    expect(reader.counters.sourceRestarts).toBe(1);
    expect(reader.counters.hits).toBe(1);
    expect(decode((await reader.blobs([a], undefined, signal())).get(a))).toBe(
      "first",
    );
  } finally {
    Bun.spawn = original;
  }
});

// Why: verified bytes and counters must survive fresh stage runtimes with the captured review context.
test("captured context shares one snapshot and writes all counters to the attempt registry", async () => {
  const f = fixture(),
    oid = f.blob("stage bytes"),
    registry: Metric.MetricRegistry = new Map();
  await Effect.runPromise(
    withGitReadSnapshot(
      f.root,
      INDEX_BOUNDS.maxFileBytes,
    )(
      Effect.gen(function* () {
        const context = yield* Effect.context<never>();
        const results = yield* Effect.promise(() =>
          Promise.all(
            [1, 2].map(() =>
              Effect.runPromiseWith(context)(readBlobs(f.root, [oid])),
            ),
          ),
        );
        for (const result of results)
          expect(decode(result.get(oid))).toBe("stage bytes");
        expect((yield* held).counters.hits).toBe(1);
      }),
    ).pipe(Effect.provideService(Metric.MetricRegistry, registry)),
  );
  for (const [name, count] of Object.entries({
    requests: 2,
    hits: 1,
    unique_objects_read: 1,
    repeat_reads: 0,
    unretained: 0,
    oversized: 0,
    native_fallback: 0,
    foreign_repository: 0,
    source_restarts: 0,
    peak_retained_bytes: Buffer.byteLength("stage bytes") + 40,
  })) {
    expect(
      [...registry.keys()].some((key) =>
        String(key).includes(`snapshot.${name}`),
      ),
    ).toBe(true);
    const state = await Effect.runPromise(
      Metric.value(
        Metric.counter(`harness.git.snapshot.${name}`, { incremental: true }),
      ).pipe(Effect.provideService(Metric.MetricRegistry, registry)),
    );
    expect(state.count).toBe(count);
  }
});

// Why: telemetry must classify the command without reporting path or option values.
test("git subcommand skips global option values", () => {
  expect(gitSubcommand(["-c", "core.quotePath=true", "diff", "--"])).toBe(
    "diff",
  );
  expect(
    gitSubcommand(["--attr-source=private", "-c", "key=value", "diff"]),
  ).toBe("diff");
  expect(
    gitSubcommand(["--no-lazy-fetch", "--no-replace-objects", "ls-tree"]),
  ).toBe("ls-tree");
  expect(gitSubcommand(["unknown", "diff"])).toBe("other");
});

// Why: review reads directly after normal commits must tolerate automatic object maintenance.
test("a read immediately after a commit with 7000 loose objects and maintenance enabled", async () => {
  const f = fixture();
  for (let i = 0; i < 7000; i++)
    writeFileSync(join(f.root, `file-${i}`), `object ${i}\n`);
  f.command("config", "gc.auto", "1");
  f.command("config", "maintenance.auto", "true");
  const head = f.commit();
  await Effect.runPromise(
    withGitReadSnapshot(
      f.root,
      INDEX_BOUNDS.maxFileBytes,
    )(
      Effect.gen(function* () {
        const entries = yield* lsTree(f.root, head);
        expect(entries).toHaveLength(7000);
        const first = entries[0];
        if (first === undefined) throw new Error("Empty fixture");
        expect(
          (yield* readBlobs(f.root, [first.oid])).get(first.oid)?.length,
        ).toBeGreaterThan(0);
      }),
    ),
  );
}, 60000);

// Why: add/commit/status must not turn immutable review reads into filesystem-walk failures.
test("concurrent add commit status loop has no failed reads", async () => {
  const f = fixture();
  writeFileSync(join(f.root, "stable"), "stable");
  const head = f.commit(),
    oid = f.blob("stable");
  let done = false;
  const churn = (async () => {
    for (let i = 0; i < 12; i++) {
      writeFileSync(join(f.root, "changing"), String(i));
      for (const args of [
        ["add", "."],
        [
          "-c",
          "user.name=test",
          "-c",
          "user.email=test@example.invalid",
          "commit",
          "-qm",
          "churn",
        ],
        ["status", "--porcelain"],
      ]) {
        const child = Bun.spawn(["git", "-C", f.root, ...args], {
          stdout: "ignore",
          stderr: "pipe",
        });
        const [code, err] = await Promise.all([
          child.exited,
          new Response(child.stderr).text(),
        ]);
        if (code !== 0) throw new Error(err);
      }
    }
  })().finally(() => {
    done = true;
  });
  await Effect.runPromise(
    withGitReadSnapshot(
      f.root,
      INDEX_BOUNDS.maxFileBytes,
    )(
      Effect.gen(function* () {
        for (let i = 0; !done || i < 60; i++) {
          expect(decode((yield* readBlobs(f.root, [oid])).get(oid))).toBe(
            "stable",
          );
          expect((yield* lsTree(f.root, head)).length).toBe(1);
          yield* Effect.sleep("1 millis");
        }
        yield* Effect.promise(() => churn);
      }),
    ),
  );
}, 60000);

// Why: 30 cancelled review jobs must reap all children, restore descriptors and exit on their own.
test("30 cancelled snapshots return descriptors and children to baseline and exit", async () => {
  const f = fixture(),
    oid = f.blob("body"),
    uncached = f.blob("uncached");
  const code = `
    import { readdirSync } from "node:fs";
    import { Effect, Option } from "effect";
    import { readBlobs } from ${JSON.stringify(join(import.meta.dir, "../src/git-objects.ts"))};
    import { GitBatchObjectSource } from "@neuve/graph-client/git-read-session";
    import { GitReadSnapshot, withGitReadSnapshot } from ${JSON.stringify(join(import.meta.dir, "../src/git-read-snapshot.ts"))};
    const children=[];const spawn=Bun.spawn;
    Bun.spawn=(...args)=>{const child=spawn(...args);children.push(child);return child;};
    const baseline=readdirSync("/dev/fd").length;
    for(let i=0;i<30;i++){
      const originalRead=GitBatchObjectSource.prototype.read;
      let enter=()=>{},release=()=>{};
      const entered=new Promise(resolve=>{enter=resolve;});const gate=new Promise(resolve=>{release=resolve;});
      await Effect.runPromise(withGitReadSnapshot(${JSON.stringify(f.root)}, 1024 * 1024)(Effect.gen(function*(){
        const snapshot=yield* GitReadSnapshot;if(Option.isNone(snapshot))throw new Error("Missing snapshot");
        const reader=snapshot.value;
        if(i%2===0)yield* readBlobs(${JSON.stringify(f.root)},[${JSON.stringify(oid)}]);
        const read=GitBatchObjectSource.prototype.read;
        GitBatchObjectSource.prototype.read=async function(...args){enter();await gate;return read.apply(this,args);};
        const context=yield* Effect.context();const controller=new AbortController();
        const cancelled=Effect.runPromiseWith(context)(readBlobs(${JSON.stringify(f.root)},[${JSON.stringify(uncached)}]),{signal:controller.signal}).catch(()=>{});
        yield* Effect.promise(()=>entered);controller.abort();yield* Effect.promise(()=>cancelled);
      })));
      release();await Bun.sleep(0);
      GitBatchObjectSource.prototype.read=originalRead;
    }
    await Bun.sleep(50);
    console.log(JSON.stringify({baseline,after:readdirSync("/dev/fd").length,live:children.filter(child=>child.exitCode===null&&child.signalCode===null).length}));
  `;
  const child = Bun.spawn([process.execPath, "--no-env-file", "--eval", code], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe("");
    expect(exit).toBe(0);
    const counts = JSON.parse(stdout);
    expect(counts.live).toBe(0);
    expect(counts.after).toBeLessThanOrEqual(counts.baseline);
  } finally {
    clearTimeout(timer);
  }
}, 65000);

// Why: damaged bytes must fail identity verification, retry only once and never enter the map.
test("hash mismatch is never retained and verified entries survive it", async () => {
  const f = fixture(),
    good = f.blob("verified"),
    bad = f.blob("damage");
  const reader = await open(f.root);
  await reader.blobs([good], undefined, signal());
  const retained = reader.retainedBytes,
    original = GitObjectProtocol.prototype.body;
  let corruptions = 0;
  GitObjectProtocol.prototype.body = function (size, retained, consume) {
    return original.call(
      this,
      size,
      retained,
      consume === undefined
        ? undefined
        : (bytes) => {
            corruptions++;
            consume(new Uint8Array(bytes.length).fill(0));
          },
    );
  };
  try {
    await expect(reader.blobs([bad], undefined, signal())).rejects.toThrow(
      "identity mismatch",
    );
    expect(corruptions).toBeGreaterThanOrEqual(2);
    expect(reader.counters.sourceRestarts).toBe(1);
    expect(reader.retainedBytes).toBe(retained);
    expect(
      decode((await reader.blobs([good], undefined, signal())).get(good)),
    ).toBe("verified");
  } finally {
    GitObjectProtocol.prototype.body = original;
  }
  expect(
    decode((await reader.blobs([bad], undefined, signal())).get(bad)),
  ).toBe("damage");
});

// Why: recovered native command failures may not retire a sibling's object source.
test("public snapshot reads survive a sibling native command error", async () => {
  const f = fixture();
  writeFileSync(join(f.root, "file"), "body");
  const head = f.commit(),
    oid = f.blob("body");
  await Effect.runPromise(
    withGitReadSnapshot(
      f.root,
      INDEX_BOUNDS.maxFileBytes,
    )(
      Effect.gen(function* () {
        const context = yield* Effect.context<never>();
        const [bytes, recovered] = yield* Effect.promise(() =>
          Promise.all([
            Effect.runPromiseWith(context)(readBlobs(f.root, [oid])),
            Effect.runPromiseWith(context)(
              mergeBase(f.root, "1".repeat(40), head).pipe(
                Effect.orElseSucceed(() => "recovered"),
              ),
            ),
          ]),
        );
        expect(decode(bytes.get(oid))).toBe("body");
        expect(recovered).toBe("recovered");
        expect((yield* held).counters.sourceRestarts).toBe(0);
      }),
    ),
  );
});

// Why: a last-waiter cancellation must not leave a replaced native child outside snapshot ownership.
test("close reaps an aborted command after another waiter replaced it", async () => {
  const f = fixture(),
    reader = await open(f.root),
    entered = deferred();
  let children = 0,
    finished = 0;
  const load = async (abort: AbortSignal) => {
    children++;
    entered.resolve();
    if (!abort.aborted)
      await new Promise<void>((resolve) =>
        abort.addEventListener("abort", () => resolve(), { once: true }),
      );
    await Bun.sleep(10);
    finished++;
    throw new Error("cancelled");
  };
  const firstController = new AbortController();
  const first = reader
    .command("same", load, firstController.signal)
    .catch(() => undefined);
  await entered.promise;
  firstController.abort();
  await first;
  const next = reader.command("same", load, signal()).catch(() => undefined);
  await reader.close();
  await next;
  expect(children).toBe(2);
  expect(finished).toBe(2);
});

const probe = async (program: string, env: NodeJS.ProcessEnv = process.env) => {
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", "--eval", program],
    {
      cwd: join(import.meta.dir, ".."),
      env,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exit).toBe(0);
  expect(stderr).toBe("");
  return JSON.parse(stdout);
};

// Why: a full map plus one large call must bound live bodies, not just its retained-byte counter.
test("live arrayBuffers stay within the map plus 64 MiB for a large call", async () => {
  const f = fixture();
  const result = await probe(`
    import { GitReadSession, GIT_READ_RETAINED_BYTES } from "@neuve/graph-client/git-read-session";
    const root = ${JSON.stringify(f.root)};
    const fillCount = GIT_READ_RETAINED_BYTES / (1024 * 1024) - 1;
    const ids = [];
    let body = Buffer.alloc(1024 * 1024, 65);
    for (let i = 0; i < fillCount + 300; i++) {
      body.writeUInt32LE(i, 0);
      const result = Bun.spawnSync(["git", "-C", root, "-c", "core.compression=1", "hash-object", "-w", "--stdin"], { stdin: body });
      if (result.exitCode !== 0) throw new Error("Fixture hash failed");
      ids.push(result.stdout.toString().trim());
    }
    body = undefined;
    Bun.gc(true);
    const baseline = process.memoryUsage().arrayBuffers;
    const reader = await GitReadSession.open(root);
    const signal = new AbortController().signal;
    for (let i = 0; i < fillCount; i += 16) await reader.blobs(ids.slice(i, Math.min(i + 16, fillCount)), undefined, signal);
    Bun.gc(true);
    const filled = process.memoryUsage().arrayBuffers;
    const out = await reader.blobs(ids.slice(fillCount), undefined, signal);
    Bun.gc(true);
    const live = process.memoryUsage().arrayBuffers;
    console.log(JSON.stringify({ baseline, filled, live, size: out.size, counters: reader.counters }));
    await reader.close();
  `);
  console.log(
    JSON.stringify({
      kind: "snapshot-live-memory",
      baseline: result.baseline,
      filled: result.filled,
      live: result.live,
    }),
  );
  expect(result.size).toBe(64);
  expect(result.counters.oversized).toBe(236);
  expect(result.counters.unretained).toBe(64);
  expect(result.counters.uniqueObjectsRead).toBe(
    GIT_READ_RETAINED_BYTES / (1024 * 1024) - 1 + 64,
  );
  expect(result.counters.repeatReads).toBe(0);
  expect(result.live - result.filled).toBeLessThanOrEqual(
    GIT_READ_IN_FLIGHT_BYTES + 4 * 1024 * 1024,
  );
  expect(result.live - result.baseline).toBeLessThanOrEqual(
    GIT_READ_TOTAL_BYTES + 4 * 1024 * 1024,
  );
}, 60000);

// Why: full clones use old Git without the flag; isolation failures must not bypass assessment.
test("old Git uses assessed reads and unsupported isolated wrappers refuse", async () => {
  const f = fixture(),
    oid = f.blob("native shim");
  const executable = Bun.which("git");
  if (executable === null) throw new Error("Git unavailable");
  const tree = f.command("mktree");
  for (const wrapper of ["old", "env-bash"]) {
    const dir = mkdtempSync(join(tmpdir(), "git-shim-"));
    roots.push(dir);
    writeFileSync(
      join(dir, "git"),
      wrapper === "old"
        ? `#!/bin/sh\nif [ "$1" = "--no-lazy-fetch" ]; then exit 129; fi\nexec '${executable}' "$@"\n`
        : `#!/usr/bin/env bash\nexec '${executable}' "$@"\n`,
      { mode: 0o755 },
    );
    const result = await probe(
      `
      import { Effect, Option } from "effect";
      import { readBlobs } from "./src/git-objects.ts";
      import { GitReadSnapshot, withGitReadSnapshot } from "./src/git-read-snapshot.ts";
      import { git } from "./src/git.ts";
      const root = ${JSON.stringify(f.root)}, oid = ${JSON.stringify(oid)};
      let probes = 0, sources = 0, commands = 0;
      const original = Bun.spawn;
      Bun.spawn = new Proxy(original, { apply(target, self, args) {
        if (args[0].includes("--no-lazy-fetch") && args[0].at(-1) === "version") probes++;
        if (args[0].includes("--batch-command")) sources++;
        if (args[0].includes("ls-tree")) commands++;
        return Reflect.apply(target, self, args);
      }});
      await Effect.runPromise(withGitReadSnapshot(root, 1024 * 1024)(Effect.gen(function* () {
        for (let i = 0; i < 2; i++) {
          const bytes = (yield* readBlobs(root, [oid])).get(oid);
          if (new TextDecoder().decode(bytes) !== "native shim") throw new Error("Wrong body");
        }
        for (let i = 0; i < 2; i++) yield* git(root, ["ls-tree", "-r", "-z", "--full-tree", ${JSON.stringify(tree)}]);
        const held = yield* GitReadSnapshot;
        if (Option.isNone(held)) throw new Error("Missing snapshot");
        console.log(JSON.stringify({ probes, sources, commands, counters: held.value.counters }));
      })).pipe(Effect.catch(error => Effect.sync(() => console.log(JSON.stringify({ error: error.message, probes, sources, commands }))))));
    `,
      { ...process.env, PATH: dir + ":" + process.env.PATH },
    );
    if (wrapper === "env-bash") {
      expect(result.error).toContain("git-config");
      expect(result.probes).toBe(0);
      expect(result.sources).toBe(0);
      expect(result.commands).toBe(0);
    } else {
      expect(result.error).toBeUndefined();
      expect(result.probes).toBe(1);
      expect(result.sources).toBe(1);
      expect(result.commands).toBe(1);
      expect(result.counters.nativeFallback).toBe(0);
      expect(result.counters.requests).toBe(2);
      expect(result.counters.hits).toBe(1);
      expect(result.counters.sourceRestarts).toBe(0);
    }
  }
});

// Why: inherited hook variables must not let the trust check judge a different approved repository.
test("trust check clears inherited repository selectors", async () => {
  const f = fixture(),
    other = fixture(),
    oid = f.blob("unapproved");
  const result = await probe(
    `
    import { GitReadSession } from "@neuve/graph-client/git-read-session";
    const reader = await GitReadSession.open(${JSON.stringify(f.root)});
    let refused = false;
    try { await reader.blobs([${JSON.stringify(oid)}], undefined, new AbortController().signal); }
    catch (error) { refused = String(error).includes("dubious ownership"); }
    finally { await reader.close(); }
    console.log(JSON.stringify({ refused }));
  `,
    {
      ...process.env,
      GIT_TEST_ASSUME_DIFFERENT_OWNER: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_DIR: join(other.root, ".git"),
      GIT_WORK_TREE: other.root,
      GIT_COMMON_DIR: join(other.root, ".git"),
    },
  );
  expect(result.refused).toBe(true);
});

// Why: transient trust-check spawn failures must not poison the entire attempt.
test("a failed trust check is retried on the next read", async () => {
  const f = fixture(),
    oid = f.blob("retry trust"),
    reader = await open(f.root);
  const original = Bun.spawn;
  let checks = 0;
  Bun.spawn = new Proxy(original, {
    apply(target, self, args) {
      if (args[0].includes("--git-dir") && ++checks === 1)
        throw new Error("Transient trust failure");
      return Reflect.apply(target, self, args);
    },
  });
  try {
    await expect(reader.blobs([oid], undefined, signal())).rejects.toThrow(
      "Transient trust failure",
    );
    expect(
      decode((await reader.blobs([oid], undefined, signal())).get(oid)),
    ).toBe("retry trust");
    expect(checks).toBe(3);
    expect(reader.counters.uniqueObjectsRead).toBe(1);
    expect(reader.counters.nativeFallback).toBe(0);
  } finally {
    Bun.spawn = original;
  }
});

// Why: vanished repositories must fail through GitFailed, as main does, rather than defecting during acquisition.
test("snapshot acquisition and main both type a gone repository as GitFailed", async () => {
  const f = fixture();
  rmSync(f.root, { recursive: true, force: true });
  for (const work of [
    git(f.root, ["version"]),
    withGitReadSnapshot(f.root, INDEX_BOUNDS.maxFileBytes)(Effect.void),
  ]) {
    const error = await Effect.runPromise(work.pipe(Effect.flip));
    expect(error).toBeInstanceOf(GitFailed);
    expect(error._tag).toBe("GitFailed");
  }
});

// Why: closing an active read must let its uncancelled caller finish on main's path.
test("a public object read in flight at close falls back to main", async () => {
  const f = fixture(),
    oid = f.blob("straggler"),
    entered = deferred(),
    release = deferred();
  const source = new GitBatchObjectSourceForTest();
  source.read = async () => {
    entered.resolve();
    await release.promise;
    throw new Error("Closed source");
  };
  source.close = async () => {
    release.resolve();
  };
  const reader = await GitReadSession.open(f.root, { source: () => source });
  readers.push(reader);
  const result = Effect.runPromise(
    readBlobs(f.root, [oid]).pipe(
      Effect.provideService(GitReadSnapshot, Option.some(reader)),
    ),
  );
  await entered.promise;
  await reader.close();
  expect(decode((await result).get(oid))).toBe("straggler");
});

// Why: refusing a command result must avoid allocating a second full encoded copy.
test("unretained command stdout is never encoded", async () => {
  const f = fixture(),
    reader = await GitReadSession.open(f.root, { retainedBytes: 1 });
  readers.push(reader);
  const original = TextEncoder.prototype.encode;
  let encodes = 0;
  TextEncoder.prototype.encode = function (...args) {
    encodes++;
    return original.apply(this, args);
  };
  try {
    expect(
      await reader.command(
        "large",
        async () => "é".repeat(1024 * 1024),
        signal(),
      ),
    ).toHaveLength(1024 * 1024);
    expect(encodes).toBe(0);
    expect(reader.retainedBytes).toBe(0);
    expect(reader.counters.unretained).toBe(1);
  } finally {
    TextEncoder.prototype.encode = original;
  }
});

// Why: upgrading a prefix keeps its old allocation live until verification, so reserve the whole new body.
test("prefix upgrades cannot exceed a call's full unretained allowance", async () => {
  const f = fixture();
  const first = f.blob(Buffer.alloc(GIT_READ_IN_FLIGHT_BYTES, 65));
  const upgrade = f.blob(Buffer.alloc(GIT_READ_IN_FLIGHT_BYTES, 66));
  const reader = await GitReadSession.open(f.root, {
    retainedBytes: 64 * 1024 * 1024 + 40,
  });
  readers.push(reader);
  await reader.blobs([upgrade], 32 * 1024 * 1024, signal());
  const out = await reader.blobs([first, upgrade], undefined, signal());
  expect([...out.keys()]).toEqual([first]);
  expect(out.get(first)?.length).toBe(GIT_READ_IN_FLIGHT_BYTES);
  expect(reader.counters.oversized).toBe(1);
  expect(reader.counters.unretained).toBe(1);
  expect(reader.counters.uniqueObjectsRead).toBe(2);
  expect(reader.counters.repeatReads).toBe(0);
  expect(
    (await reader.blobs([upgrade], 32 * 1024 * 1024, signal())).get(upgrade)
      ?.length,
  ).toBe(32 * 1024 * 1024);
  expect(reader.counters.hits).toBe(1);
}, 30000);

// Why: prefix probes on a full map must hold only their prefixes and preserve every generated declaration.
test("300 generated files just below 1 MiB match main on a full map", async () => {
  const f = fixture();
  const tree: TreeEntry[] = [];
  for (let i = 0; i < 300; i++) {
    const bytes = Buffer.alloc(1024 * 1024 - 1, 65);
    bytes.write(`// @generated file ${i}\n`);
    tree.push({
      mode: "100644",
      type: "blob",
      oid: f.blob(bytes),
      size: bytes.length,
      path: `generated-${i}.ts`,
    });
  }
  const made = Bun.spawnSync(["git", "-C", f.root, "mktree"], {
    stdin: Buffer.from(
      tree
        .map((entry) => `${entry.mode} blob ${entry.oid}\t${entry.path}\n`)
        .join(""),
    ),
  });
  expect(made.exitCode).toBe(0);
  const revision = made.stdout.toString().trim();
  const reader = await GitReadSession.open(f.root, { retainedBytes: 128 });
  readers.push(reader);
  await reader.command("fill", async () => "x".repeat(124), signal());
  expect(reader.retainedBytes).toBe(128);
  const prefixes = await reader.blobs(
    tree.map((entry) => entry.oid),
    1024,
    signal(),
  );
  expect(prefixes.size).toBe(300);
  for (const bytes of prefixes.values()) {
    expect(bytes.length).toBe(1024);
    expect(bytes.buffer.byteLength).toBe(1024);
  }
  expect(reader.counters.unretained).toBe(300);
  expect(reader.counters.oversized).toBe(0);
  const options = {
    repository: f.root,
    revision,
    tree,
    paths: tree.map((entry) => entry.path),
  };
  const main = await Effect.runPromise(readDeclarations(options));
  const actual = await Effect.runPromise(
    readDeclarations(options).pipe(
      Effect.provideService(GitReadSnapshot, Option.some(reader)),
    ),
  );
  expect(actual).toEqual(main);
  expect([...actual.byPath.keys()]).toEqual(options.paths);
  expect(actual.byPath.size).toBe(300);
  expect(actual.gaps).toEqual(DECLARATION_GAPS);
  expect(reader.counters.oversized).toBe(0);
  expect(reader.retainedBytes).toBe(128);
}, 30000);

// Why: an omitted object must disclose the declaration readers that could not inspect it, using the stored string gaps.
test("declarations disclose missing manifests and marker prefixes", async () => {
  const f = fixture();
  writeFileSync(
    join(f.root, "package.json"),
    '{"scripts":{"test":"bun test"}}',
  );
  writeFileSync(join(f.root, "file.test.ts"), "// @generated\n");
  const revision = f.commit();
  const tree = await Effect.runPromise(lsTree(f.root, revision));
  for (const entry of tree)
    rmSync(
      join(
        f.root,
        ".git",
        "objects",
        entry.oid.slice(0, 2),
        entry.oid.slice(2),
      ),
    );
  const options = {
    repository: f.root,
    revision,
    tree,
    paths: tree.map((entry) => entry.path),
  };
  for (const work of [
    readDeclarations(options),
    withGitReadSnapshot(
      f.root,
      INDEX_BOUNDS.maxFileBytes,
    )(readDeclarations(options)),
  ]) {
    const declarations = await Effect.runPromise(work);
    expect(declarations.byPath.size).toBe(0);
    expect(declarations.gaps).toEqual([
      ...DECLARATION_GAPS,
      "package-scripts-bun-test: 1 package manifest(s) could not be read; their test roots were not checked",
      "generated-marker: 2 blob(s) could not be read; their generated markers were not checked",
    ]);
  }
});

// Why: admission for bodies lost with a killed child must not consume the retry's unretained allowance.
test("a killed source retries with only received unretained bytes charged", async () => {
  const f = fixture();
  const ids = Array.from({ length: 5 }, (_, i) =>
    f.blob(Buffer.alloc(16 * 1024 * 1024, 65 + i)),
  );
  const control = await GitReadSession.open(f.root, { retainedBytes: 0 });
  readers.push(control);
  const expected = await control.blobs(ids, undefined, signal());
  let killed = false;
  const reader = await GitReadSession.open(f.root, {
    retainedBytes: 0,
    source: () => {
      const source = new GitBatchObjectSource(
        f.root,
        Promise.resolve(),
        INDEX_BOUNDS.maxFileBytes,
      );
      return {
        read: (oids, head, receive, count, onRead, accept) =>
          source.read(
            oids,
            head,
            receive,
            count,
            (oid) => {
              onRead(oid);
              if (!killed && oid === ids[1]) {
                killed = true;
                void source.close();
              }
            },
            accept,
          ),
        close: () => source.close(),
      };
    },
  });
  readers.push(reader);
  const actual = await reader.blobs(ids, undefined, signal());
  expect(killed).toBe(true);
  expect([...actual.keys()]).toEqual([...expected.keys()]);
  expect(actual.size).toBe(4);
  for (const oid of expected.keys())
    expect(actual.get(oid)).toEqual(expected.get(oid));
  expect(reader.counters.sourceRestarts).toBe(1);
  expect(reader.counters.unretained).toBe(4);
  expect(reader.counters.oversized).toBe(control.counters.oversized);
}, 30000);

// Why: abandoned retention reservations must be released before retry or later commands can use the map.
test("failed source reservations leave all map capacity available", async () => {
  const f = fixture(),
    oid = f.blob("body");
  let sources = 0;
  const reader = await GitReadSession.open(f.root, {
    retainedBytes: 44,
    source: () => {
      sources++;
      if (sources > 1)
        return new GitBatchObjectSource(
          f.root,
          Promise.resolve(),
          INDEX_BOUNDS.maxFileBytes,
        );
      return {
        read: async (_oids, _head, _receive, _count, _onRead, accept) => {
          expect(accept?.(oid, 4)).toBe(4);
          throw new Error("Source failed after admission");
        },
        close: async () => {},
      };
    },
  });
  readers.push(reader);
  expect(
    decode((await reader.blobs([oid], undefined, signal())).get(oid)),
  ).toBe("body");
  expect(reader.retainedBytes).toBe(44);
  expect(reader.counters.unretained).toBe(0);
  await reader.blobs([oid], undefined, signal());
  expect(reader.counters.hits).toBe(1);
  expect(reader.counters.repeatReads).toBe(0);
});

// Why: a completed read remains valid if the snapshot closes before routing returns to its caller.
test("a successful read at close returns without repeating the native read", async () => {
  const f = fixture(),
    reader = await open(f.root);
  let fallbacks = 0;
  const result = await Effect.runPromise(
    withGitReadSession(
      f.root,
      () =>
        Effect.promise(async () => {
          await reader.close();
          return "completed";
        }),
      Effect.sync(() => {
        fallbacks++;
        return "repeated";
      }),
    ).pipe(Effect.provideService(GitReadSnapshot, Option.some(reader))),
  );
  expect(result).toBe("completed");
  expect(fallbacks).toBe(0);
});

// Why: declaration probes over an entire tree must split before one call could hold 64 MiB of prefixes.
test("declaration prefix groups preserve path order across a group boundary", async () => {
  const f = fixture(),
    oid = f.blob("// @generated\n");
  const tree: TreeEntry[] = Array.from({ length: 16_385 }, (_, i) => ({
    mode: "100644",
    type: "blob",
    oid,
    size: 14,
    path: `file-${i}.ts`,
  }));
  const made = Bun.spawnSync(["git", "-C", f.root, "mktree"], {
    stdin: Buffer.from(
      tree.map((entry) => `100644 blob ${oid}\t${entry.path}\n`).join(""),
    ),
  });
  expect(made.exitCode).toBe(0);
  let calls = 0;
  const reader = await GitReadSession.open(f.root, {
    retainedBytes: 0,
    source: () => {
      const source = new GitBatchObjectSource(
        f.root,
        Promise.resolve(),
        INDEX_BOUNDS.maxFileBytes,
      );
      return {
        read: (...args) => {
          calls++;
          return source.read(...args);
        },
        close: () => source.close(),
      };
    },
  });
  readers.push(reader);
  const options = {
    repository: f.root,
    revision: made.stdout.toString().trim(),
    tree,
    paths: tree.map((entry) => entry.path),
  };
  const main = await Effect.runPromise(readDeclarations(options));
  const actual = await Effect.runPromise(
    readDeclarations(options).pipe(
      Effect.provideService(GitReadSnapshot, Option.some(reader)),
    ),
  );
  expect(calls).toBe(2);
  expect([...actual.byPath]).toEqual([...main.byPath]);
  expect([...actual.byPath.keys()]).toEqual(options.paths);
  expect(actual.gaps).toEqual(main.gaps);
});
