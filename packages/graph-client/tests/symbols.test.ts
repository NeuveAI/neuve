import { createHash } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import * as fsModule from "node:fs";
import { afterEach, expect, spyOn, test } from "bun:test";
import { chmod, mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { readGraphSymbols } from "../src/index.ts";
import { parseSymbolStream } from "../src/symbols.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const fixture = async (mode = "valid", outlines = true) => {
  // The engine reports resolved paths (macOS puts the default temporary folder under a symlink).
  const root = await realpath(await mkdtemp(join(tmpdir(), "symbols-test-")));
  roots.push(root);
  const executable = join(root, "engine");
  await Bun.write(
    executable,
    `#!${process.execPath}
import { createHash } from "node:crypto";
import {readFileSync,chmodSync,writeFileSync} from "node:fs";
const args=process.argv.slice(2), repo=args[args.indexOf("--repo")+1];
const mode=${JSON.stringify(mode)};
const emit=x=>console.log(JSON.stringify(x));
if(args[0]==="version") emit({version:"fixture",provider:"entire-graph",identity_revision:"4",build_identity:createHash("sha256").update(readFileSync(import.meta.path)).digest("hex")});
else if(args[0]==="capabilities") emit({schema_version:"1.3",provider:"entire-graph",supported_file_extensions:[".ts"],supported_languages:["TypeScript"],semantic_languages:["TypeScript"],inventory_only_languages:[],supported_relation_types:["DEFINES","CONTAINS"],relation_support_by_language:{},relation_support_by_profile:{"syntax-only":["DEFINES","CONTAINS"]},heuristic_relation_types:[],parser_versions:{},unsupported_but_detected_language_hints:[],optional_local_only_features:{symbols_outline:${outlines}},features_requiring_network_access:{}});
else {
 if(mode==="exit") process.exit(3);
 if(mode==="wait") await new Promise(resolve=>setTimeout(resolve,60000));
 emit({schema_version:"1.3",provider:"entire-graph",provider_version:"fixture",identity_revision:"4",repo_root:repo,profile:"syntax-only"});
 if(mode==="malformed") console.log("{bad");
 else if(mode==="unknown") emit({record_type:"surprise"});
 else emit({record_type:"symbol",id:"f",kind:"function",name:"alpha",qualified_name:"alpha",signature:mode==="threads"?process.env.GOMAXPROCS:"function alpha()",file_path:mode==="outside"?"outside.ts":"src/a.ts",start_line:1,end_line:1,language:"TypeScript"});
 if(mode==="overload") emit({record_type:"symbol",id:"f",kind:"function",name:"alpha",qualified_name:"alpha",file_path:"src/a.ts",start_line:2,end_line:2,language:"TypeScript"});
 if(mode==="mutate"){chmodSync(import.meta.path,0o700);writeFileSync(import.meta.path,readFileSync(import.meta.path,"utf8")+"\\n");}
 if(${outlines}) emit({record_type:"file_outline",file_path:"src/a.ts",language:"TypeScript",top_level:[{start_line:1,end_line:1,type:"function_declaration"}],identifiers:[[1,"alpha"]]});
 emit({record_type:"summary",partial_failures:[]});
}`,
  );
  await chmod(executable, 0o700);
  const input = {
    executable,
    temporaryParent: root,
    cacheDirectory: join(root, "cache"),
    files: [
      {
        path: "src/a.ts",
        bytes: new TextEncoder().encode("function alpha() {}\n"),
      },
    ],
  };
  return { root, input };
};

// These tests exercise the untrusted executable boundary and cleanup, where a bad receipt can poison chunk keys.
test("normalizes outline and symbols-only streams and removes per-read directories", async () => {
  for (const outlines of [true, false]) {
    const { root, input } = await fixture("valid", outlines);
    const result = await readGraphSymbols(input);
    expect(result.outlinesAvailable).toBe(outlines);
    expect(result.files.get("src/a.ts")?.symbols[0]?.name).toBe("alpha");
    expect(result.files.get("src/a.ts")?.symbols[0]?.signature).toBe(
      "function alpha()",
    );
    expect(result.files.get("src/a.ts")?.outline?.identifiers ?? null).toEqual(
      outlines ? [[1, "alpha"]] : null,
    );
    expect((await readdir(root)).sort()).toEqual(["cache", "engine"]);
  }
});

test("refuses unsafe, non-normalized and duplicate paths before running", async () => {
  const { root, input } = await fixture();
  for (const path of [
    "/a",
    "../a",
    "a/../b",
    "a//b",
    "./a",
    "a/",
    "a\0b",
    "a\\b",
    ".git/config",
    "C:/a",
  ]) {
    await expect(
      readGraphSymbols({
        ...input,
        files: [{ path, bytes: new Uint8Array() }],
      }),
    ).rejects.toMatchObject({ reason: "input" });
  }
  await expect(
    readGraphSymbols({ ...input, files: [...input.files, ...input.files] }),
  ).rejects.toMatchObject({ reason: "input" });
  expect(await readdir(root)).toEqual(["engine"]);
});

for (const mode of ["malformed", "unknown", "outside", "exit", "mutate"])
  test(`refuses ${mode} and removes temporary directories`, async () => {
    const { root, input } = await fixture(mode);
    await expect(readGraphSymbols(input)).rejects.toMatchObject({
      reason: mode === "exit" ? "command" : "invalid-output",
    });
    expect((await readdir(root)).sort()).toEqual(["cache", "engine"]);
  });

test("cancels a running process and cleans up; reports a deadline separately", async () => {
  const { root, input } = await fixture("wait");
  const controller = new AbortController();
  const reading = readGraphSymbols({ ...input, signal: controller.signal });
  setTimeout(() => controller.abort(), 300);
  await expect(reading).rejects.toMatchObject({ reason: "cancelled" });
  expect((await readdir(root)).sort()).toEqual(["cache", "engine"]);
  await expect(
    readGraphSymbols({ ...input, deadlineMs: 300 }),
  ).rejects.toMatchObject({ reason: "deadline" });
  expect((await readdir(root)).sort()).toEqual(["cache", "engine"]);
});

test("reports missing executable", async () => {
  const { root, input } = await fixture();
  await expect(
    readGraphSymbols({ ...input, executable: join(root, "absent") }),
  ).rejects.toMatchObject({ reason: "executable-unavailable" });
});

test("keeps declarations that share a provider id, such as overloads", async () => {
  const { input } = await fixture("overload", false);
  const result = await readGraphSymbols({
    ...input,
    files: [
      {
        path: "src/a.ts",
        bytes: new TextEncoder().encode(
          "function alpha(x: string): string;\nfunction alpha(x: string) { return x; }\n",
        ),
      },
    ],
  });
  expect(
    result.files.get("src/a.ts")?.symbols.map((item) => item.startLine),
  ).toEqual([1, 2]);
});

// Pin the recursive bound. Bad
// nested ranges must fail at the reader rather than corrupt stored boundaries.
test("validates nested outline fields and bounds before normalization", async () => {
  const { input } = await fixture();
  const { provider } = await readGraphSymbols(input);
  const leaf = {
    start_line: 2,
    end_line: 3,
    type: "body",
  };
  const wrap = (child: object) => ({
    start_line: 1,
    end_line: 4,
    type: "wrapper",
    children: [child],
  });
  const parse = (node: object) =>
    parseSymbolStream(
      [
        {
          schema_version: "1.3",
          provider: provider.name,
          provider_version: provider.version,
          identity_revision: provider.identityRevision,
          repo_root: "/fixture",
          profile: "syntax-only",
        },
        {
          record_type: "file_outline",
          file_path: "a.ts",
          language: "TypeScript",
          top_level: [node],
          identifiers: [],
        },
        { record_type: "summary", partial_failures: [] },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n"),
      ["a.ts"],
      provider,
      "/fixture",
    );
  const nested = (edges: number) => {
    let value: object = leaf;
    for (let i = 0; i < edges; i++) value = wrap(value);
    return value;
  };
  let value = (await parse(nested(16))).files.get("a.ts")?.outline?.topLevel[0];
  for (let i = 0; i < 16; i++) value = value?.children?.[0];
  expect(value).toEqual({
    startLine: 2,
    endLine: 3,
    type: "body",
    imports: false,
  });
  // Round-2 providers may still send these fields; they do not enter our observations.
  expect(
    (await parse({ ...leaf, label: "unused", callback: true })).files.get(
      "a.ts",
    )?.outline?.topLevel[0],
  ).toEqual({ startLine: 2, endLine: 3, type: "body", imports: false });
  for (const invalid of [
    nested(17),
    { ...leaf, children: "invalid" },
    { ...leaf, start_line: 4 },
    wrap({ ...leaf, end_line: 5 }),
    wrap({ ...leaf, start_line: 0 }),
  ])
    await expect(parse(invalid)).rejects.toMatchObject({
      reason: "invalid-output",
    });
});

// The reader must isolate one explosive record without sacrificing good files in the batch.
test("bounds batches and falls back per file when output is oversized", async () => {
  const { input, root } = await fixture();
  const { provider } = await readGraphSymbols(input);
  const {
    readSymbolBatches,
    SYMBOL_BATCH_BYTES,
    SYMBOL_FILE_OUTPUT_BYTES,
    GraphSymbolsError,
  } = await import("../src/symbols.ts");
  const { readFile } = await import("node:fs/promises");
  const batches: number[] = [];
  let overflows = 0;
  const result = await readSymbolBatches(
    {
      ...input,
      concurrency: 2,
      files: [
        { path: "a.ts", bytes: new Uint8Array(SYMBOL_BATCH_BYTES / 2) },
        { path: "big.ts", bytes: new Uint8Array(SYMBOL_BATCH_BYTES / 2) },
        { path: "b.ts", bytes: new Uint8Array(SYMBOL_BATCH_BYTES / 2) },
        { path: "record.ts", bytes: new Uint8Array(1) },
      ],
    },
    {
      provider,
      init: async () => {},
      run: async (repo) => {
        const names = await readdir(repo);
        let bytes = 0;
        for (const name of names)
          bytes += (await readFile(join(repo, name))).length;
        batches.push(bytes);
        if (names.includes("big.ts")) {
          overflows++;
          throw new GraphSymbolsError({
            reason: "invalid-output",
            message: "Graph command exceeded its output byte bound.",
          });
        }
        return [
          {
            schema_version: "1.3",
            provider: provider.name,
            provider_version: provider.version,
            identity_revision: provider.identityRevision,
            repo_root: repo,
            profile: "syntax-only",
          },
          ...names.map((path) => ({
            record_type: "file_outline",
            file_path: path,
            language: "TypeScript",
            top_level: [],
            identifiers: [],
            ...(path === "record.ts"
              ? { padding: "x".repeat(SYMBOL_FILE_OUTPUT_BYTES) }
              : {}),
          })),
          { record_type: "summary", partial_failures: [] },
        ]
          .map((r) => JSON.stringify(r))
          .join("\n");
      },
    },
  );
  expect(Math.max(...batches)).toBeLessThanOrEqual(SYMBOL_BATCH_BYTES);
  expect(overflows).toBe(2);
  expect(result.files.get("a.ts")?.partialFailure).toBeNull();
  expect(result.files.get("b.ts")?.partialFailure).toBeNull();
  expect(result.files.get("big.ts")?.partialFailure).toBe(
    "symbols-output-limit",
  );
  expect(result.files.get("record.ts")?.partialFailure).toBe(
    "symbols-output-limit",
  );
  expect((await readdir(root)).filter((n) => n !== "engine")).toEqual([
    "cache",
  ]);
});

// Batch concurrency is bounded by permits, preserves order, and cancels every active child.
test("parallel symbol batches equal sequential observations and stop every active batch", async () => {
  const { input, root } = await fixture();
  const { provider } = await readGraphSymbols(input);
  const { readSymbolBatches, SYMBOL_BATCH_FILES } =
    await import("../src/symbols.ts");
  const files = Array.from(
    { length: SYMBOL_BATCH_FILES * 3 + 1 },
    (_, index) => ({ path: `f${index}.ts`, bytes: new Uint8Array(1) }),
  );
  let active = 0,
    peak = 0,
    stopped = 0;
  const permits = 3;
  let arrive: (() => Promise<void>) | undefined;
  const runtime = {
    provider,
    init: async () => {},
    run: async (repo: string, _outlines: boolean, signal: AbortSignal) => {
      active++;
      peak = Math.max(peak, active);
      try {
        await arrive?.();
        return [
          {
            schema_version: "1.3",
            provider: provider.name,
            provider_version: provider.version,
            identity_revision: provider.identityRevision,
            repo_root: repo,
            profile: "syntax-only",
          },
          ...(await readdir(repo)).sort().map((path) => ({
            record_type: "file_outline",
            file_path: path,
            language: "TypeScript",
            top_level: [],
            identifiers: [],
          })),
          { record_type: "summary", partial_failures: [] },
        ]
          .map((row) => JSON.stringify(row))
          .join("\n");
      } finally {
        active--;
      }
    },
  };
  const sequential = await readSymbolBatches({ ...input, files }, runtime);
  peak = 0;
  let arrivals = 0;
  let release = () => {};
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  arrive = async () => {
    if (++arrivals === permits) release();
    await ready;
  };
  const parallel = await readSymbolBatches(
    { ...input, files, concurrency: permits },
    runtime,
  );
  expect(parallel.files).toEqual(sequential.files);
  expect(peak).toBe(permits);
  const controller = new AbortController();
  let started = 0;
  stopped = 0;
  await expect(
    readSymbolBatches(
      { ...input, files, concurrency: permits, signal: controller.signal },
      {
        ...runtime,
        run: async (_repo, _outlines, signal) => {
          started++;
          if (started === permits)
            controller.abort(new Error("cancel every batch"));
          await new Promise<void>((_resolve, reject) => {
            if (signal.aborted) {
              stopped++;
              reject(signal.reason);
              return;
            }
            signal.addEventListener(
              "abort",
              () => {
                stopped++;
                reject(signal.reason);
              },
              { once: true },
            );
          });
          return "";
        },
      },
    ),
  ).rejects.toThrow("cancel every batch");
  expect(started).toBe(permits);
  expect(stopped).toBe(permits);
  expect((await readdir(root)).filter((name) => name !== "engine")).toEqual([
    "cache",
  ]);
  // Alone 0.52-0.86 s; 10x slowest, at least 30 s; child processes and disk I/O under load.
}, 30_000);

// Real Graph must preserve its IDs and outline positions when batches overlap.
test.skipIf(!process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE)(
  "real parallel Graph observations equal sequential reads",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "symbols-parallel-"));
    roots.push(root);
    const { SYMBOL_BATCH_FILES } = await import("../src/symbols.ts");
    const executable = process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE;
    if (!executable) throw new Error("Graph executable required");
    const input = {
      executable,
      temporaryParent: root,
      cacheDirectory: join(root, "cache"),
      files: Array.from({ length: SYMBOL_BATCH_FILES + 1 }, (_, index) => ({
        path: `f${index}.ts`,
        bytes: new TextEncoder().encode(
          `export function f${index}() { return ${index}; }\n`,
        ),
      })),
    };
    const sequential = await readGraphSymbols({ ...input, concurrency: 1 });
    const parallel = await readGraphSymbols({ ...input, concurrency: 2 });
    expect(parallel.files).toEqual(sequential.files);
    expect(parallel.provider).toEqual(sequential.provider);
    expect(parallel.batchOutputBytes?.length).toBe(2);
    expect(await readdir(root)).toEqual(["cache"]);

    // A fresh process catches a false compatibility notice even if another read already disclosed one.
    const workspaceEngine = resolve(
      import.meta.dir,
      "../../../apps/neuve-graph/entire-graph",
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        join(import.meta.dir, "fixtures/symbols-provider-read.ts"),
        workspaceEngine,
        root,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code, stderr).toBe(0);
      expect(JSON.parse(stdout)).toEqual({
        provider: "entire-graph",
        symbols: ["reviewed"],
        outline: true,
      });
      expect(stderr).not.toContain("compatibility mode");
      expect(await readdir(root)).toEqual(["cache"]);
    } finally {
      if (child.exitCode === null) child.kill();
      await child.exited;
    }
  },
  // Two real reads of 513 files and a child process; the full check runs under load.
  60_000,
);

// A pool's batch count must not multiply by the engine's default thread count.
test("each symbols command uses one engine thread per held permit", async () => {
  const { input } = await fixture("threads");
  const result = await readGraphSymbols(
    { ...input, concurrency: 3 },
    { cpuThreads: 8 },
  );
  expect(result.files.get("src/a.ts")?.symbols[0]?.signature).toBe("1");
});

// A later deterministic error must not erase a timeout or output-bound failure.
test("keeps every partial-failure code when normalizing a summary", async () => {
  const { input } = await fixture();
  const { provider } = await readGraphSymbols(input);
  const result = await parseSymbolStream(
    [
      {
        schema_version: "1.3",
        provider: provider.name,
        provider_version: provider.version,
        identity_revision: provider.identityRevision,
        repo_root: "/fixture",
        profile: "syntax-only",
      },
      {
        record_type: "summary",
        partial_failures: [
          { code: "E_PARSE_TIMEOUT", file_path: "a.ts" },
          { code: "E_PARSE_ERROR", file_path: "a.ts" },
        ],
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n"),
    ["a.ts"],
    provider,
    "/fixture",
  );
  expect(result.files.get("a.ts")?.partialFailures).toEqual([
    "E_PARSE_TIMEOUT",
    "E_PARSE_ERROR",
  ]);
});

// Accepted symbol-heavy input must not amplify copies or block delivery of a caller's abort.
const symbolStream = (
  provider: import("../src/domain.ts").GraphProviderObservation,
  count: number,
) =>
  [
    JSON.stringify({
      schema_version: provider.capabilities.schemaVersion,
      provider: provider.name,
      provider_version: provider.version,
      identity_revision: provider.identityRevision,
      repo_root: "/fixture",
      profile: "syntax-only",
    }),
    ...Array.from({ length: count }, (_, i) =>
      JSON.stringify({
        record_type: "symbol",
        id: `copy-regression-${i}`,
        kind: "function",
        name: `f${i}`,
        qualified_name: `f${i}`,
        file_path: "a.ts",
        start_line: i + 1,
        end_line: i + 1,
        language: "TypeScript",
      }),
    ),
    JSON.stringify({ record_type: "summary", partial_failures: [] }),
  ].join("\n");

test("symbol-heavy accepted streams copy prior symbols at most linearly", async () => {
  const { input } = await fixture();
  const { provider } = await readGraphSymbols(input);
  const iterator = Array.prototype[Symbol.iterator];
  for (const count of [1000, 2000]) {
    let copies = 0;
    Array.prototype[Symbol.iterator] = function (this: unknown[]) {
      const first = this[0];
      if (
        typeof first === "object" &&
        first !== null &&
        "id" in first &&
        typeof first.id === "string" &&
        first.id.startsWith("copy-regression-") &&
        "startLine" in first
      )
        copies += this.length;
      return iterator.call(this);
    };
    let parsed;
    try {
      parsed = await parseSymbolStream(
        symbolStream(provider, count),
        ["a.ts"],
        provider,
        "/fixture",
      );
    } finally {
      Array.prototype[Symbol.iterator] = iterator;
    }
    expect(parsed.files.get("a.ts")?.symbols).toHaveLength(count);
    expect(parsed.files.get("a.ts")?.symbols.at(-1)?.name).toBe(
      `f${count - 1}`,
    );
    console.info(JSON.stringify({ count, copies }));
    expect(copies).toBeLessThanOrEqual(2 * count);
  }
});

test("a pending abort is delivered while parsing a large accepted symbols stream", async () => {
  const { input } = await fixture();
  const { provider } = await readGraphSymbols(input);
  const wire = symbolStream(provider, 4000);
  const { SYMBOL_FILE_OUTPUT_BYTES } = await import("../src/symbols.ts");
  expect(Buffer.byteLength(wire)).toBeLessThan(SYMBOL_FILE_OUTPUT_BYTES);
  expect(
    (await parseSymbolStream(wire, ["a.ts"], provider, "/fixture")).files.get(
      "a.ts",
    )?.symbols,
  ).toHaveLength(4000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 0);
  try {
    await expect(
      Promise.resolve(
        parseSymbolStream(
          wire,
          ["a.ts"],
          provider,
          "/fixture",
          controller.signal,
        ),
      ),
    ).rejects.toMatchObject({ reason: "cancelled" });
    expect(controller.signal.aborted).toBe(true);
  } finally {
    clearTimeout(timer);
  }
});

// Stable engine identity and admission placement are observable at the filesystem/process boundary.
test("symbols reads copy once and verify executable bytes outside CPU admission", async () => {
  const { input } = await fixture();
  const copied: string[] = [],
    paths: string[] = [];
  let inside = false;
  const copyFile = fsPromises.copyFile,
    createReadStream = fsModule.createReadStream;
  const copySpy = spyOn(fsPromises, "copyFile").mockImplementation(
    async (...args) => {
      expect(inside).toBe(false);
      copied.push(String(args[0]));
      return copyFile(...args);
    },
  );
  const streamSpy = spyOn(fsModule, "createReadStream").mockImplementation(
    (...args) => {
      expect(inside).toBe(false);
      return createReadStream(...args);
    },
  );
  try {
    for (let n = 0; n < 3; n++) {
      const result = await readGraphSymbols(
        {
          ...input,
          execute: async (run) => {
            inside = true;
            try {
              return await run(1);
            } finally {
              inside = false;
            }
          },
        },
        {
          onCommand: (receipt) => {
            expect(inside).toBe(true);
            if (receipt.stage === "symbols") paths.push(receipt.argv[0] ?? "");
          },
        },
      );
      expect(result.files.get("src/a.ts")?.symbols.map((s) => s.name)).toEqual([
        "alpha",
      ]);
    }
    expect(copied).toEqual([input.executable]);
    expect(new Set(paths).size).toBe(1);
    expect(paths).toHaveLength(3);
    const sha = createHash("sha256")
      .update(await Bun.file(input.executable).bytes())
      .digest("hex");
    expect(await readdir(join(input.cacheDirectory, "executables"))).toEqual([
      sha,
    ]);
    expect(paths[0]).toBe(
      join(input.cacheDirectory, "executables", sha, "engine"),
    );
  } finally {
    copySpy.mockRestore();
    streamSpy.mockRestore();
  }
});

test("a rebuilt symbols engine uses a new digest directory and preserves the old copy", async () => {
  const { input } = await fixture();
  const first = await readGraphSymbols(input);
  const oldSha = first.provider.executable.sha256;
  await Bun.write(
    input.executable,
    (await Bun.file(input.executable).text()) + "\n// rebuilt\n",
  );
  const nextSha = createHash("sha256")
    .update(await Bun.file(input.executable).bytes())
    .digest("hex");
  let ran = "";
  const next = await readGraphSymbols(input, {
    onCommand: (receipt) => {
      if (receipt.stage === "symbols") ran = receipt.argv[0] ?? "";
    },
  });
  expect(next.files.get("src/a.ts")?.symbols[0]?.name).toBe("alpha");
  expect(next.provider.executable.sha256).toBe(nextSha);
  expect(nextSha).not.toBe(oldSha);
  expect(ran).toBe(
    join(input.cacheDirectory, "executables", nextSha, "engine"),
  );
  expect(
    (await readdir(join(input.cacheDirectory, "executables"))).sort(),
  ).toEqual([oldSha, nextSha].sort());
  expect(
    createHash("sha256")
      .update(
        await Bun.file(
          join(input.cacheDirectory, "executables", oldSha, "engine"),
        ).bytes(),
      )
      .digest("hex"),
  ).toBe(oldSha);
});

test("a corrupt symbols engine copy is replaced before it executes", async () => {
  const { input } = await fixture();
  const first = await readGraphSymbols(input);
  const copy = join(
    input.cacheDirectory,
    "executables",
    first.provider.executable.sha256,
    "engine",
  );
  const before = await stat(copy);
  await chmod(copy, 0o700);
  await Bun.write(copy, "#!/bin/sh\nexit 91\n");
  const next = await readGraphSymbols(input);
  expect(next.files.get("src/a.ts")?.symbols[0]?.name).toBe("alpha");
  expect(next.provider).toEqual(first.provider);
  expect(
    createHash("sha256")
      .update(await Bun.file(copy).bytes())
      .digest("hex"),
  ).toBe(first.provider.executable.sha256);
  expect((await stat(copy)).ino).not.toBe(before.ino);
  expect((await stat(copy)).mode & 0o777).toBe(0o500);
});

for (const processes of [false, true])
  test(`concurrent first symbols reads leave one complete copy across ${processes ? "processes" : "calls"}`, async () => {
    const { root, input } = await fixture();
    const sha = createHash("sha256")
      .update(await Bun.file(input.executable).bytes())
      .digest("hex");
    if (processes) {
      const children = Array.from({ length: 3 }, () =>
        Bun.spawn(
          [
            process.execPath,
            "--no-env-file",
            join(import.meta.dir, "fixtures/symbols-cache-read.ts"),
            input.executable,
            root,
            input.cacheDirectory,
          ],
          { stdout: "pipe", stderr: "pipe" },
        ),
      );
      try {
        const results = await Promise.all(
          children.map(async (child) => {
            const [exit, stdout, stderr] = await Promise.all([
              child.exited,
              new Response(child.stdout).text(),
              new Response(child.stderr).text(),
            ]);
            expect(exit, stderr).toBe(0);
            return JSON.parse(stdout);
          }),
        );
        expect(results).toEqual(
          Array.from({ length: 3 }, () => ({ sha, symbols: ["alpha"] })),
        );
      } finally {
        for (const child of children) {
          if (child.exitCode === null) child.kill();
          await child.exited;
        }
      }
    } else {
      const results = await Promise.all(
        Array.from({ length: 3 }, () => readGraphSymbols(input)),
      );
      expect(
        results.map((r) => ({
          sha: r.provider.executable.sha256,
          symbols: r.files.get("src/a.ts")?.symbols.map((s) => s.name),
        })),
      ).toEqual(Array.from({ length: 3 }, () => ({ sha, symbols: ["alpha"] })));
    }
    expect(await readdir(join(input.cacheDirectory, "executables"))).toEqual([
      sha,
    ]);
    expect(
      await readdir(join(input.cacheDirectory, "executables", sha)),
    ).toEqual(["engine"]);
    expect(
      createHash("sha256")
        .update(
          await Bun.file(
            join(input.cacheDirectory, "executables", sha, "engine"),
          ).bytes(),
        )
        .digest("hex"),
    ).toBe(sha);
  });

test("symbols reads reject an executable cache writable by another user", async () => {
  const { input } = await fixture();
  await readGraphSymbols(input);
  await chmod(join(input.cacheDirectory, "executables"), 0o777);
  await expect(readGraphSymbols(input)).rejects.toMatchObject({
    reason: "command",
  });
});

test("the default symbols cache persists without a Git checkout", async () => {
  const { root, input } = await fixture();
  const budgetDirectory = join(root, "budget");
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "fixtures/symbols-cache-read.ts"),
      input.executable,
      root,
    ],
    {
      cwd: root,
      env: { ...process.env, NEUVE_BUDGET_DIRECTORY: budgetDirectory },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exit, stderr).toBe(0);
    const sha = createHash("sha256")
      .update(await Bun.file(input.executable).bytes())
      .digest("hex");
    expect(JSON.parse(stdout)).toEqual({ sha, symbols: ["alpha"] });
    expect(
      await readdir(
        join(budgetDirectory, "graph", "cache", "executables", sha),
      ),
    ).toEqual(["engine"]);
    expect((await readdir(root)).sort()).toEqual(["budget", "engine"]);
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
});
