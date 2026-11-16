import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readGraphSnapshot,
  type GraphSnapshotFile,
  type GraphSnapshotRelation,
  type GraphSnapshotSymbol,
} from "../src/index.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const COMMIT = "1".repeat(40);
const TREE = "a".repeat(40);
const PINNED = "b".repeat(40);

/**
 * A fake engine: `version` and `capabilities` as the real one answers them, and `snapshot` writing
 * a compact stream shaped by `mode`. It records its arguments in `<root>/control/argv.json`.
 */
const engine = async (mode: string) => {
  const root = await mkdtemp(join(tmpdir(), "snapshot-test-"));
  roots.push(root);
  const repository = join(root, "repo");
  const control = join(root, "control");
  await mkdir(repository);
  await mkdir(control);
  const executable = join(root, "engine");
  await Bun.write(
    executable,
    `#!${process.execPath}
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
const args = process.argv.slice(2);
const mode = ${JSON.stringify(mode)};
const control = ${JSON.stringify(control)};
const out = (row) => process.stdout.write(JSON.stringify(row) + "\\n");
const schema = mode === "newer-minor" ? "1.9" : mode === "call-lines" ? "1.4" : "1.3";
const callLines = mode === "call-lines" ? { optional: { call_site_lines: true }, languages: { call_site_lines: ["TypeScript", "Go"] } } : { optional: {}, languages: {} };
if (args[0] === "version") out({version:"fixture",provider:"entire-graph",identity_revision:"4",build_identity:createHash("sha256").update(readFileSync(import.meta.path)).digest("hex")});
else if (args[0] === "capabilities") out({schema_version:schema,provider:"entire-graph",supported_file_extensions:[".ts"],supported_languages:["TypeScript"],semantic_languages:["TypeScript"],inventory_only_languages:[],supported_relation_types:["CALLS"],relation_support_by_language:{},relation_support_by_profile:{full:["CALLS"]},heuristic_relation_types:[],parser_versions:{},unsupported_but_detected_language_hints:[],optional_local_only_features:{compact_snapshot_ndjson_v1:true,exact_commit_bulk_streams:mode!=="no-capability",...callLines.optional},feature_languages:callLines.languages,features_requiring_network_access:{}});
else {
  writeFileSync(control + "/argv.json", JSON.stringify(args));
  const repo = args[args.indexOf("--repo") + 1];
  const commit = mode === "wrong-commit" ? "c".repeat(40) : args[args.indexOf("--commit") + 1];
  out(["h", 1, {schema_version: mode === "unknown-major" ? "2.0" : schema, provider:"entire-graph", provider_version:"fixture", identity_revision:"4", repo_root:repo, repo_key:"local/repo", commit, tree:${JSON.stringify(TREE)}, languages:[], profile:"full", relation_set:["CALLS","IMPORTS"], skipped_relation_families:null, stats:{files:0}}]);
  if (mode === "wait") {
    const child = spawn("sleep", ["60"], { stdio: "ignore" });
    writeFileSync(control + "/child-pid", String(child.pid));
    writeFileSync(control + "/engine-pid", String(process.pid));
    await new Promise((resolve) => setTimeout(resolve, 60000));
  }
  if (mode === "large") {
    const count = 20000;
    out(["d", 1, ["local/repo:file:src/a.ts", "src/a.ts", "function", "TypeScript"]]);
    out(["f", 1, 2, 0, 4, 10]);
    const ids = Array.from({ length: count }, (_, i) => "local/repo:TypeScript:src/a.ts:function:f" + i);
    out(["d", 5, ids]);
    for (let i = 0; i < count; i++) out(["s", 5 + i, 0, 3, 0, 0, 2, 1, 1, 0, 0, 4, 0, []]);
    while (!existsSync(control + "/release")) await new Promise((resolve) => setTimeout(resolve, 10));
    out(["m", {record_type:"summary",languages:["TypeScript"],language_tiers:{TypeScript:"semantic"},warnings:[],partial_failures:[],stats:{files:1,parsed_files:1,symbols:count,relations:0,partial_failures:0,completeness_level:"ok"},completeness:{languages:{},relations:{}}}]);
    process.exit(0);
  }
  if (mode === "malformed") console.log("{bad");
  out(["d", 1, ["local/repo:file:src/a.ts", "src/a.ts", "blob", "TypeScript"]]);
  if (mode === "second-header") out(["h", 1, {}]);
  out(["f", 1, 2, 3, mode === "out-of-range" ? 99 : 4, 10]);
  out(["d", 5, ["local/repo:TypeScript:src/a.ts:function:alpha", "compound-v1", "function", "alpha", "function alpha()", "hash"]]);
  out(mode === "newer-minor" ? ["s", 5, 6, 7, 8, 8, 2, 1, 3, 9, 10, 4, 0, [], "an added field"] : ["s", 5, 6, 7, 8, 8, 2, 1, 3, 9, 10, 4, 0, []]);
  if (mode === "newer-minor") out(["z", 1, 2]);
  out(["d", 11, ["CALLS", "reason", "module", "import_resolved", "symbol", "call_site", "external:import:x", "import", "x", "W_EVIDENCE"]]);
  if (mode === "call-lines") out(["d", 21, ["reference", "top_level_call_site"]]);
  out(["r", 1, 5, 11, 0.8, 12, 13, 14, 15, mode === "call-lines" ? [[22, 2, 2, 2, 8, 21]] : [[16, 2, 2, 3, 8], [16, 2, 4, 0, 0], [16, 2, 0, 0, 0], [16, 0, 0, 0, 0]], null]);
  out(["r", 5, 17, 11, 0.5, 12, 0, 0, 0, [], [20], 2]);
  out(["x", 17, 18, 19, 0, 0, 0, 0, 0, true, 0, 0]);
  if (mode !== "no-summary")
    out(["m", {record_type:"summary",languages:["TypeScript"],language_tiers:{TypeScript:"semantic",JSON:"inventory-only"},warnings:[{code:"W_SUBMODULE_NOT_READ",severity:"info",file_path:"vendor/lib",detail:"gitlink pins commit ${PINNED}"},{code:"W_GO_BUILD_EXCLUDED",severity:"info",file_path:"x_windows.go"},{code:"W_GO_BUILD_EXCLUDED",severity:"info",file_path:"a_windows.go"},{code:"W_OTHER",severity:"warning"}],partial_failures:[{code:"E_MINIFIED",severity:"warning",file_path:"src/a.ts"},{code:"E_PARSE_ERROR",severity:"warning",file_path:"src/a.ts"},{code:"E_MINIFIED",severity:"warning",file_path:"src/a.ts"},{code:"W_FILE_LIMIT",severity:"warning"}],stats:{files:1,parsed_files:1,symbols:1,relations:2,partial_failures:4,completeness_level:"ok"},completeness:{languages:{},relations:{},health:{status:"ok"}}}]);
  if (mode === "exit-after-summary") process.exit(3);
}
`,
  );
  await chmod(executable, 0o700);
  return {
    root,
    control,
    request: {
      repository,
      revision: COMMIT,
      profile: "full" as const,
      executable,
      cacheDirectory: join(root, "cache"),
    },
  };
};

const collect = () => {
  const records = {
    files: [] as GraphSnapshotFile[],
    symbols: [] as GraphSnapshotSymbol[],
    relations: [] as GraphSnapshotRelation[],
  };
  return {
    records,
    sink: {
      file: (file: GraphSnapshotFile) => records.files.push(file),
      symbol: (symbol: GraphSnapshotSymbol) => records.symbols.push(symbol),
      relation: (relation: GraphSnapshotRelation) =>
        records.relations.push(relation),
    },
  };
};

// Why: the positional decoder is the only reader of this format in Neuve; every field it hands on
// and every coverage field must be the one the row and the summary hold.
test("a valid compact stream decodes to its records and its coverage", async () => {
  const { request, control } = await engine("valid");
  const { records, sink } = collect();
  const coverage = await readGraphSnapshot(request, sink);
  expect(
    JSON.parse(await readFile(join(control, "argv.json"), "utf8")),
  ).toEqual([
    "snapshot",
    "--repo",
    realpathSync(request.repository),
    "--commit",
    COMMIT,
    "--format",
    "compact-ndjson",
    "--profile",
    "full",
    "--no-cache",
  ]);
  expect(records.files).toEqual([
    {
      id: "local/repo:file:src/a.ts",
      path: "src/a.ts",
      language: "TypeScript",
      bytes: 10,
    },
  ]);
  expect(records.symbols).toEqual([
    {
      id: "local/repo:TypeScript:src/a.ts:function:alpha",
      name: "alpha",
      qualifiedName: "alpha",
      kind: "function",
      language: "TypeScript",
      path: "src/a.ts",
      startLine: 1,
      endLine: 3,
      containerId: null,
      signature: "function alpha()",
    },
  ]);
  // Compared as plain data: the expected paths are strings, the records' branded paths.
  expect<unknown>(records.relations).toEqual([
    {
      relation: "CALLS",
      fromId: "local/repo:file:src/a.ts",
      toId: "local/repo:TypeScript:src/a.ts:function:alpha",
      targetKind: "symbol",
      resolution: "import_resolved",
      confidence: 0.8,
      scope: "module",
      evidence: [
        {
          kind: "call_site",
          location: {
            kind: "range",
            path: "src/a.ts",
            startLine: 2,
            endLine: 3,
          },
          detail: "alpha",
        },
        {
          kind: "call_site",
          location: { kind: "point", path: "src/a.ts", line: 4 },
          detail: null,
        },
        {
          kind: "call_site",
          location: { kind: "path", path: "src/a.ts" },
          detail: null,
        },
        { kind: "call_site", location: { kind: "absent" }, detail: null },
      ],
      warningCodes: [],
      evidenceDropped: 0,
    },
    {
      relation: "CALLS",
      fromId: "local/repo:TypeScript:src/a.ts:function:alpha",
      toId: "external:import:x",
      targetKind: null,
      resolution: null,
      confidence: 0.5,
      scope: null,
      evidence: [],
      warningCodes: ["W_EVIDENCE"],
      evidenceDropped: 2,
    },
  ]);
  expect(coverage).toEqual({
    provider: {
      name: "entire-graph",
      version: "fixture",
      identityRevision: "4",
      executable: {
        sha256: expect.any(String),
        buildIdentity: "verified",
      },
    },
    repoKey: "local/repo",
    schema: { version: "1.3", newerMinor: false, skippedRows: 0 },
    commit: COMMIT,
    tree: TREE,
    profile: "full",
    relationSet: ["CALLS", "IMPORTS"],
    skippedRelationFamilies: [],
    languageTiers: { JSON: "inventory-only", TypeScript: "semantic" },
    counts: {
      files: 1,
      parsedFiles: 1,
      symbols: 1,
      relations: 2,
      externals: 1,
    },
    partialFailures: [
      { path: null, codes: ["W_FILE_LIMIT"] },
      { path: "src/a.ts", codes: ["E_MINIFIED", "E_PARSE_ERROR"] },
    ],
    warnings: [
      { code: "W_GO_BUILD_EXCLUDED", count: 2 },
      { code: "W_OTHER", count: 1 },
      { code: "W_SUBMODULE_NOT_READ", count: 1 },
    ],
    gitlinksNotRead: [{ path: "vendor/lib", commit: PINNED }],
    goBuildExcluded: [{ path: "a_windows.go" }, { path: "x_windows.go" }],
    health: "ok",
    completenessLevel: "ok",
    importTargets: { status: "not-declared" },
    callSiteLineLanguages: [],
  });
});

// Why: whether a line is a call's is the engine's promise for the languages it lists; the reader
// must take that list from the copy that wrote the stream and hand on each entry's form with it.
test("an engine that declares call lines gives their languages and each entry's form", async () => {
  const { request } = await engine("call-lines");
  const { records, sink } = collect();
  const coverage = await readGraphSnapshot(request, sink);
  expect(coverage.schema).toEqual({
    version: "1.4",
    newerMinor: false,
    skippedRows: 0,
  });
  expect(coverage.callSiteLineLanguages).toEqual(["TypeScript", "Go"]);
  expect<unknown>(records.relations[0]?.evidence).toEqual([
    {
      kind: "top_level_call_site",
      location: { kind: "range", path: "src/a.ts", startLine: 2, endLine: 2 },
      detail: "alpha",
      form: "reference",
    },
  ]);
});

// Why: each is a way a stream can be cut off or wrong; a partial answer must never be returned.
for (const [mode, reason] of [
  ["no-summary", "incomplete"],
  ["second-header", "invalid-output"],
  ["wrong-commit", "invalid-output"],
  ["malformed", "invalid-output"],
  ["out-of-range", "invalid-output"],
  ["unknown-major", "invalid-output"],
  ["exit-after-summary", "command"],
  ["no-capability", "unsupported-provider"],
] as const)
  test(`refuses ${mode} as ${reason}`, async () => {
    const { request } = await engine(mode);
    await expect(
      readGraphSnapshot(request, collect().sink),
    ).rejects.toMatchObject({ _tag: "GraphSnapshotError", reason });
  });

// Why: a newer minor is readable by the additive rule, but what it added must be said, not hidden.
test("a newer minor decodes its known prefix, skips an unknown tag and says so", async () => {
  const { request } = await engine("newer-minor");
  const { records, sink } = collect();
  const coverage = await readGraphSnapshot(request, sink);
  expect(coverage.schema).toEqual({
    version: "1.9",
    newerMinor: true,
    skippedRows: 1,
  });
  expect(records.symbols.map((symbol) => symbol.name)).toEqual(["alpha"]);
  expect(records.relations).toHaveLength(2);
});

// Why: the reader refuses wrong input before any engine runs.
test("refuses a revision that is not an exact lowercase commit", async () => {
  const { request, control } = await engine("valid");
  for (const revision of ["HEAD", "1".repeat(39), "A".repeat(40)])
    await expect(
      readGraphSnapshot({ ...request, revision }, collect().sink),
    ).rejects.toMatchObject({ reason: "input" });
  expect(existsSync(join(control, "argv.json"))).toBe(false);
  await expect(
    readGraphSnapshot(
      { ...request, executable: join(request.repository, "absent") },
      collect().sink,
    ),
  ).rejects.toMatchObject({ reason: "executable-unavailable" });
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const pidIn = async (path: string) => {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const pid = existsSync(path) ? Number(await readFile(path, "utf8")) : 0;
    if (Number.isSafeInteger(pid) && pid > 0) return pid;
    if (Date.now() > deadline) throw new Error(`no pid in ${path}`);
    await Bun.sleep(10);
  }
};
const gone = async (pid: number) => {
  const deadline = Date.now() + 5_000;
  while (alive(pid) && Date.now() < deadline) await Bun.sleep(20);
  return !alive(pid);
};

// Why: an abandoned read must not leave the engine or its children running.
test("an abort stops the engine's whole process group", async () => {
  const { request, control } = await engine("wait");
  const controller = new AbortController();
  const reading = readGraphSnapshot(
    { ...request, signal: controller.signal },
    collect().sink,
  );
  const child = await pidIn(join(control, "child-pid"));
  const leader = await pidIn(join(control, "engine-pid"));
  try {
    expect(alive(child)).toBe(true);
    controller.abort();
    await expect(reading).rejects.toMatchObject({ reason: "cancelled" });
    expect(await gone(child)).toBe(true);
    expect(await gone(leader)).toBe(true);
  } finally {
    for (const pid of [child, leader])
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
  }
}, 20_000);

// Why: the real stream is about 41 MiB; the reader must hand records over while the engine still
// runs. The engine here writes its summary only after the sink has seen every symbol, so a reader
// that held stdout until the end would never finish (and the deadline would end it).
test("records reach the sink while the engine is still writing", async () => {
  const { request, control } = await engine("large");
  let seen = 0;
  const coverage = await readGraphSnapshot(
    { ...request, deadlineMs: 30_000 },
    {
      symbol: () => {
        if (++seen === 20_000) void writeFile(join(control, "release"), "");
      },
      relation: () => {},
    },
  );
  expect(seen).toBe(20_000);
  expect(coverage.counts.symbols).toBe(20_000);
}, 40_000);

const git = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(
    [
      "git",
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.test",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
};

/** The native NDJSON record's location, by the rules the compact decoder applies. */
const nativeLocation = (evidence: {
  file_path?: string;
  start_line?: number;
  end_line?: number;
}) =>
  !evidence.file_path
    ? { kind: "absent" }
    : !evidence.start_line
      ? { kind: "path", path: evidence.file_path }
      : !evidence.end_line
        ? { kind: "point", path: evidence.file_path, line: evidence.start_line }
        : {
            kind: "range",
            path: evidence.file_path,
            startLine: evidence.start_line,
            endLine: evidence.end_line,
          };

// Why: the positional decoder must match the engine's encoder exactly, field for field, for a
// commit that is not HEAD, and reading it must leave the checkout alone.
test.skipIf(!process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE)(
  "the real engine's compact snapshot of an older commit equals its native snapshot, and HEAD is untouched",
  async () => {
    const executable = process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE;
    if (!executable) throw new Error("Graph executable required");
    const root = await mkdtemp(join(tmpdir(), "snapshot-real-"));
    roots.push(root);
    const repository = join(root, "repo");
    await mkdir(join(repository, "src"), { recursive: true });
    git(root, "init", "-q", repository);
    await writeFile(
      join(repository, "src/a.ts"),
      "export function shared(x: number) {\n  return x + 1;\n}\nexport function onlyOld() {\n  return shared(1);\n}\n",
    );
    await writeFile(
      join(repository, "src/b.ts"),
      'import { shared, onlyOld } from "./a";\nexport const run = () => shared(2) + onlyOld();\nexport function mapped(xs: number[]) {\n  return xs.map(shared);\n}\n',
    );
    git(repository, "add", ".");
    git(repository, "commit", "-qm", "older");
    const older = git(repository, "rev-parse", "HEAD");
    await writeFile(
      join(repository, "src/a.ts"),
      "export function shared(x: number) {\n  return x + 2;\n}\n",
    );
    await writeFile(
      join(repository, "src/b.ts"),
      'import { shared } from "./a";\nexport const run = () => shared(2);\n',
    );
    git(repository, "commit", "-qam", "newer");
    const newer = git(repository, "rev-parse", "HEAD");
    const { records, sink } = collect();
    const coverage = await readGraphSnapshot(
      {
        repository,
        revision: older,
        profile: "full",
        executable,
        cacheDirectory: join(root, "cache"),
      },
      sink,
    );
    expect(coverage.commit).toBe(older);
    expect(coverage.tree).toBe(git(repository, "rev-parse", `${older}^{tree}`));
    expect(records.symbols.map((symbol) => symbol.name)).toContain("onlyOld");
    expect(git(repository, "rev-parse", "HEAD")).toBe(newer);
    expect(git(repository, "status", "--porcelain")).toBe("");

    const native = Bun.spawnSync(
      [
        executable,
        "snapshot",
        "--repo",
        realpathSync(repository),
        "--commit",
        older,
        "--format",
        "ndjson",
        "--profile",
        "full",
        "--no-cache",
      ],
      { cwd: repository, stdout: "pipe", stderr: "pipe" },
    );
    expect(native.exitCode, native.stderr.toString()).toBe(0);
    type NativeEvidence = {
      kind: string;
      file_path?: string;
      start_line?: number;
      end_line?: number;
      detail?: string;
      form?: string;
    };
    type NativeRow = {
      record_type?: string;
      id: string;
      path: string;
      language?: string;
      bytes: number;
      name: string;
      qualified_name: string;
      kind: string;
      file_path: string;
      start_line: number;
      end_line: number;
      container_id?: string;
      signature?: string;
      type: string;
      from_id: string;
      to_id: string;
      target_kind?: string;
      resolution?: string;
      confidence: number;
      relation_scope?: string;
      evidence?: NativeEvidence[];
      warning_codes?: string[] | null;
      evidence_dropped?: number;
    };
    const rows = native.stdout
      .toString()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as NativeRow);
    const nativeFiles = rows
      .filter((row) => row.record_type === "file")
      .map((row) => ({
        id: row.id,
        path: row.path,
        language: row.language || null,
        bytes: row.bytes,
      }));
    const nativeSymbols = rows
      .filter((row) => row.record_type === "symbol")
      .map((row) => ({
        id: row.id,
        name: row.name,
        qualifiedName: row.qualified_name,
        kind: row.kind,
        language: row.language,
        path: row.file_path,
        startLine: row.start_line,
        endLine: row.end_line,
        containerId: row.container_id || null,
        signature: row.signature || null,
      }));
    const nativeRelations = rows
      .filter((row) => row.record_type === "relation")
      .map((row) => ({
        relation: row.type,
        fromId: row.from_id,
        toId: row.to_id,
        targetKind: row.target_kind || null,
        resolution: row.resolution || null,
        confidence: row.confidence,
        scope: row.relation_scope || null,
        evidence: (row.evidence ?? []).map((item) => ({
          kind: item.kind,
          location: nativeLocation(item),
          detail: item.detail || null,
          ...(item.form === undefined ? {} : { form: item.form }),
          // The import targets this fixture has: a file, and nothing else.
          ...(item.kind === "import_target_file"
            ? {
                importTarget: {
                  specifier: item.detail ?? "",
                  target: { kind: "file", path: item.file_path },
                },
              }
            : {}),
        })),
        warningCodes: row.warning_codes ?? [],
        evidenceDropped: row.evidence_dropped ?? 0,
      }));
    // Compared as plain data: the native rows are typed loosely.
    expect<unknown>(records.files).toEqual(nativeFiles);
    expect<unknown>(records.symbols).toEqual(nativeSymbols);
    expect<unknown>(records.relations).toEqual(nativeRelations);
    expect(records.relations.length).toBeGreaterThan(0);
    // `mapped` hands `shared` over by name and never calls it: marked where call lines are declared.
    expect(
      records.relations.some((relation) =>
        relation.evidence.some((entry) => entry.form === "reference"),
      ),
    ).toBe(coverage.callSiteLineLanguages?.includes("TypeScript") === true);
  },
  60_000,
);
