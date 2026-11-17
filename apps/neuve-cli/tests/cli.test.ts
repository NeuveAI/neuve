import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { parseQueryInvocation } from "../src/boundary.ts";

// Built into a temporary directory, never dist/neuve, which an installed
// command may still be running.
const buildDirectory = await mkdtemp(join(tmpdir(), "neuve-cli-test-build-"));
const binary = join(buildDirectory, "neuve");
const roots: string[] = [];

beforeAll(async () => {
  const process = Bun.spawn(
    ["bun", "./scripts/build.ts", "--outfile", binary],
    {
      cwd: resolve(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stderr = await new Response(process.stderr).text();
  expect(await process.exited, stderr).toBe(0);
});

afterAll(async () => {
  await rm(buildDirectory, { recursive: true, force: true });
});

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const execute = (
  argv: readonly string[],
  cwd: string,
): Readonly<{ stdout: string; stderr: string; exitCode: number }> => {
  const process = Bun.spawnSync([...argv], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: process.stdout.toString(),
    stderr: process.stderr.toString(),
    exitCode: process.exitCode,
  };
};

const fixtureRepository = async () => {
  const root = await mkdtemp(join(tmpdir(), "neuve-cli-repository-"));
  roots.push(root);
  execute(["git", "init", "--quiet"], root);
  execute(["git", "config", "user.name", "Neuve CLI Test"], root);
  execute(["git", "config", "user.email", "cli@example.test"], root);
  await Bun.write(join(root, "source.custom"), "one\ntwo\nthree\nfour\n");
  await Bun.write(join(root, "other.custom"), "alpha\nbeta\ngamma\n");
  execute(["git", "add", "."], root);
  execute(["git", "commit", "--quiet", "-m", "fixture"], root);
  return {
    root,
    revision: execute(["git", "rev-parse", "HEAD"], root).stdout.trim(),
  };
};

const fakeGraph = async (
  mode:
    | "valid"
    | "legacy-selection"
    | "section-errors"
    | "hostile-streams"
    | "hostile-query-json"
    | "hostile-neighbor-json"
    | "delayed-neighbor"
    | "failing-delayed-neighbor"
    | "prepared"
    | "frontier-unsupported" = "valid",
) => {
  const root = await mkdtemp(join(tmpdir(), "neuve-cli-graph-"));
  roots.push(root);
  const executable = join(root, "graph");
  const log = join(root, "commands.jsonl");
  const neighborStarted = join(root, "neighbor-started");
  const neighborRelease = join(root, "neighbor-release");
  await Bun.write(
    executable,
    // Bun by its own path and the log by name: the engine runs with graph-client's fixed
    // environment, which holds neither this test's PATH nor its variables.
    `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const command = process.argv[2];
const args = process.argv.slice(3);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ command, args }) + "\\n");
const value = (flag) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
const repo = value("--repo") ?? "";
const git = (...parts) => Bun.spawnSync(["git", "-C", repo, ...parts]).stdout.toString().trim();
const revision = repo === "" ? "" : git("rev-parse", value("--commit") ?? "HEAD");
const tree = repo === "" ? "" : git("rev-parse", revision + "^{tree}");
const receiptFields = !args.includes("--prepared-only") ? {} : { prepared_read:{artifact_family:"search-snapshot",policy_id:"a".repeat(64),producer_build_id:createHash("sha256").update(readFileSync(import.meta.path)).digest("hex"),source:{common_dir:git("rev-parse","--path-format=absolute","--git-common-dir"),scope:git("rev-parse","--show-prefix").slice(0,-1)},external_policy_origin:"serving-directory-captured",gitignore_origin:"target-commit"} };
if (command === "version") console.log(JSON.stringify({ provider: "entire-graph", version: "fixture", identity_revision: "fixture-identity" }));
else if (command === "capabilities") console.log(JSON.stringify({ schema_version: "1.3", provider: "entire-graph", supported_file_extensions: [".custom"], supported_languages: ["Fixture"], semantic_languages: ["Fixture"], inventory_only_languages: [], parser_versions: { fixture: "1" }, supported_relation_types: ${JSON.stringify(mode)} === "prepared" ? ["CALLS", "CONSTRUCTS", "DEFINES", "CONTAINS"] : ["CALLS", "CONSTRUCTS"], ...(${JSON.stringify(mode)} === "legacy-selection" ? {} : {relation_selection_modes: ["exact", "family"], relation_families: { CALLS: ["CALLS", "CONSTRUCTS"], CONSTRUCTS: ["CONSTRUCTS"], ...(${JSON.stringify(mode)} === "prepared" ? {DEFINES:["DEFINES"],CONTAINS:["CONTAINS"]} : {}) }}), relation_support_by_language: { Fixture: ["CALLS", "CONSTRUCTS"] }, relation_support_by_profile: { ...(${JSON.stringify(mode)} === "prepared" ? {"syntax-only":["DEFINES","CONTAINS"]} : {}),full: ["CALLS", "CONSTRUCTS"] }, heuristic_relation_types: [], unsupported_but_detected_language_hints: [], optional_local_only_features: { ...(${JSON.stringify(mode)} === "prepared" ? { prepared_snapshot_query: true, exact_commit_prepared_read:true } : {}), ...(${JSON.stringify(mode)} === "frontier-unsupported" ? {} : { neighbor_frontier_summary: true }) }, features_requiring_network_access: {} }));
else if (command === "index") console.log(JSON.stringify({ format_version: 1, provider: "entire-graph", provider_version: "fixture", repo_root: repo, commit: revision, tree, profile: "full", index_cache_hit: false, index_latency_ms: 4 }));
else if (command === "query") {
  if (${JSON.stringify(mode)} === "hostile-streams") {
    console.log("HOSTILE_STDOUT_RECEIPT");
    console.error("HOSTILE_STDERR_RECEIPT");
    process.exit(23);
  } else if (${JSON.stringify(mode)} === "hostile-query-json") {
    console.log(JSON.stringify({ format_version: 1, query: value("--query"), repo_root: "HOSTILE_QUERY_VALUE", commit: revision, tree, profile: value("--profile"),...receiptFields, results: [], warnings: [], partial_failures: [], completeness: { health: { status: "ok" } }, stats: { ...(args.includes("--prepared-only") ? { index_cache_hit: true, analysis_scope: "complete-prepared" } : {}), context_budget_bytes: 1, result_bytes: 0, query_constraints_truncated: false, results_dropped_by_budget: 0, snippets_truncated_by_budget: 0 } }));
  } else if (${JSON.stringify(mode)} === "section-errors") console.log("not-json");
  else console.log(JSON.stringify({ format_version: 1, query: value("--query"), repo_root: repo, commit: revision, tree, profile: value("--profile"),...receiptFields, results: [{ rank: 1, symbol_id: "target-id", language: "Fixture", file_path: "source.custom", symbol_name: "target", kind: "function", qualified_name: "target", start_line: 1, end_line: 4, snippet_start_line: 1, snippet_end_line: 4, contained_callables: [{ symbol_id: "nested-id", language: "Fixture", symbol_name: "nested", kind: "function", qualified_name: "nested", start_line: 2, end_line: 3 }] }, { rank: 2, language: "OtherFixture", file_path: "other.custom", kind: "function", qualified_name: "partial", start_line: 1, end_line: 3, snippet_start_line: 1, snippet_end_line: 3 }], warnings: [{ code: "W_QUERY", severity: "warning", effect_on_semantic_completeness: "limited fixture" }], partial_failures: [], completeness: { health: { status: "partial" } }, stats: { ...(args.includes("--prepared-only") ? { index_cache_hit: true, analysis_scope: "complete-prepared" } : {}), context_budget_bytes: Number(value("--max-context-bytes")), result_bytes: 50, query_constraints_truncated: false, results_dropped_by_budget: 0, snippets_truncated_by_budget: 0, contained_callables_status: "complete", contained_callables_emitted: 1, contained_callables_dropped_by_budget: 0 } }));
} else if (command === "neighbors") {
  if (${JSON.stringify(mode)} === "delayed-neighbor" || ${JSON.stringify(mode)} === "failing-delayed-neighbor") {
    await Bun.write(${JSON.stringify(neighborStarted)}, String(process.pid));
    while (!(await Bun.file(${JSON.stringify(neighborRelease)}).exists())) await Bun.sleep(10);
  }
  if (${JSON.stringify(mode)} === "failing-delayed-neighbor") console.log("not-json");
  else if (${JSON.stringify(mode)} === "hostile-neighbor-json") console.log(JSON.stringify({ format_version: 1, hostile: "HOSTILE_NEIGHBOR_VALUE" }));
  else if (${JSON.stringify(mode)} === "section-errors") console.log("not-json");
  else {
    const requested = value("--symbol");
    const endpoint = { id: "callee-id", name: "callee", qualified_name: "callee", kind: "function", file_path: "other.custom", language: "Fixture", start_line: 1, end_line: 3 };
    const evidence = [{ kind: "call_site", file_path: "source.custom", start_line: 2, end_line: 2 }];
    const observations = requested === "target-id" ? [{ relation: value("--selection") === "exact" ? "CALLS" : "CONSTRUCTS", direction: "out", endpoint, confidence: 0.75, resolution: "exact", reason: "fixture", evidence, warning_codes: ["W_EDGE"], evidence_dropped: 1 }] : [];
    const summary = value("--summary") === "frontier" ? { mode: "frontier", kind: "observed", selection: value("--selection"), selected_relations: value("--selection") === "exact" ? [value("--relation")] : ["CALLS", "CONSTRUCTS"], direction: value("--direction"), depth: 1, indexed_coverage: "ok", direct: { eligible_edges: observations.length, emitted_edges: observations.length, omitted_edges: 0, missing_endpoint_edges: 0 }, frontier: [{ kind: "indexed", endpoint_id: "callee-id", counts: [{ relation: "CALLS", resolution: "exact", edges: 1 }], external_edges: 0, missing_endpoint_edges: 0, returns_to_focus: 0, self_edges: 0 }] } : undefined;
    console.log(JSON.stringify({ ...(args.includes("--prepared-only") ? { index_cache_hit: true, analysis_scope: "complete-prepared" } : {}), format_version: 1, repo_root: repo, commit: revision, tree, profile: value("--profile"),...receiptFields, selection: value("--selection"), selected_relations: value("--selection") === "exact" ? [value("--relation")] : ["CALLS", "CONSTRUCTS"], relation: value("--relation"), direction: value("--direction"), query: requested, ...(value("--file") === undefined ? {} : { file: value("--file") }), truncated: false, focus_matches_truncated: false, disambiguation_required: false, matches: [{ symbol: { id: "target-id", name: "target", qualified_name: "target", kind: "function", file_path: "source.custom", language: "Fixture", start_line: 1, end_line: 4 }, incoming: [], outgoing: observations }], warnings: [], partial_failures: [], completeness: { health: { status: "ok" } }, ...(summary === undefined ? {} : { summary }) }));
  }
} else process.exit(64);
`,
  );
  await chmod(executable, 0o755);
  return { executable, log, neighborStarted, neighborRelease };
};

const run = async (
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = {},
) => {
  const child = Bun.spawn([binary, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...environment },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
};

const lineReader = (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    read: async (): Promise<string | undefined> => {
      while (!buffer.includes("\n")) {
        const chunk = await reader.read();
        if (chunk.done) {
          const final = buffer;
          buffer = "";
          return final.length === 0 ? undefined : final;
        }
        buffer += decoder.decode(chunk.value, { stream: true });
      }
      const newline = buffer.indexOf("\n");
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      return line;
    },
    cancel: async (): Promise<void> => reader.cancel(),
  };
};

const waitForFile = async (path: string): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (!(await Bun.file(path).exists())) {
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for ${path}.`);
    await Bun.sleep(10);
  }
};

const queryArgs = (
  repository: string,
  revision: string,
  question = "  Preserve this question exactly?  ",
  relationships: readonly unknown[] = [
    {
      request_id: "target-call-family",
      focus: { symbol: "target", path: "source.custom" },
      relation: "CALLS",
      selection: "family",
      direction: "out",
      depth: 1,
      limit: 5,
    },
  ],
): readonly string[] => [
  "query",
  "--repo",
  repository,
  "--revision",
  revision,
  "--question",
  question,
  "--max-results",
  "5",
  "--max-context-bytes",
  "4096",
  "--relationship-plan",
  JSON.stringify(relationships),
];

describe("neuve CLI boundary", () => {
  // Why: worktree creation for query must not execute the caller's post-checkout hook.
  test("query works with a Husky-style env sh post-checkout hook", async () => {
    const repository = await fixtureRepository();
    const graph = await fakeGraph();
    const hooks = join(repository.root, "hooks");
    await mkdir(hooks);
    const marker = join(repository.root, "hook-ran");
    const hook = join(hooks, "post-checkout");
    await Bun.write(hook, `#!/usr/bin/env sh\nprintf ran > '${marker}'\n`);
    await chmod(hook, 0o755);
    expect(
      execute(["git", "config", "core.hooksPath", hooks], repository.root)
        .exitCode,
    ).toBe(0);
    const result = await run(queryArgs(repository.root, repository.revision), {
      NEUVE_GRAPH_BINARY: graph.executable,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(
      JSON.parse(result.stdout).structural_observations.length,
    ).toBeGreaterThan(0);
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(
      execute(
        ["git", "worktree", "list", "--porcelain"],
        repository.root,
      ).stdout.match(/^worktree /gm),
    ).toHaveLength(1);
  });

  test("prepared CLI returns confirmed scope and never sends an index command", async () => {
    const repository = await fixtureRepository();
    const graph = await fakeGraph("prepared");
    const question = "  Preserve this prepared question exactly?  ";
    const result = await run(
      [
        ...queryArgs(repository.root, repository.revision, question),
        "--prepared-only",
      ],
      { NEUVE_GRAPH_BINARY: graph.executable, FAKE_GRAPH_LOG: graph.log },
    );
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.retrieval.analysis_scope).toBe("complete-prepared");
    expect(output.retrieval.profile).toBe("full");
    expect(output.retrieval.prepared_read).toMatchObject({
      artifact_family: "search-snapshot",
      source: {
        common_dir: await realpath(join(repository.root, ".git")),
        scope: "",
      },
      external_policy_origin: "serving-directory-captured",
      gitignore_origin: "target-commit",
    });
    expect(output.retrieval.prepared_read).not.toHaveProperty("generation_id");
    expect(output.structural_observations[0].analysis_scope).toBe(
      "complete-prepared",
    );
    const commands = (await Bun.file(graph.log).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(commands.some((command) => command.command === "index")).toBe(false);
    const reads = commands.filter((command) =>
      ["query", "neighbors"].includes(command.command),
    );
    expect(reads).toHaveLength(3);
    expect(
      reads.every((command) => command.args.includes("--prepared-only")),
    ).toBe(true);
    const query = commands.find((command) => command.command === "query");
    expect(query.args[query.args.indexOf("--query") + 1]).toBe(question);
    expect(query.args).not.toContain("--head");
    expect(query.args[query.args.indexOf("--commit") + 1]).toBe(
      repository.revision,
    );
  });

  test("prepared CLI reports unsupported capability without invoking query or index", async () => {
    const repository = await fixtureRepository();
    const graph = await fakeGraph();
    const result = await run(
      [...queryArgs(repository.root, repository.revision), "--prepared-only"],
      { NEUVE_GRAPH_BINARY: graph.executable, FAKE_GRAPH_LOG: graph.log },
    );
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.retrieval.prepared_failure).toBe("unsupported-provider");
    expect(output.structural_observations[0].prepared_failure).toBe(
      "unsupported-provider",
    );
    const commands = (await Bun.file(graph.log).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(commands.map((command) => command.command)).toEqual([
      "version",
      "capabilities",
    ]);
  });

  test("explicit syntax CLI preserves profile and refuses CALLS rather than replacing the request", async () => {
    const repository = await fixtureRepository();
    const graph = await fakeGraph("prepared");
    const result = await run(
      [
        ...queryArgs(repository.root, repository.revision),
        "--prepared-only",
        "--profile",
        "syntax-only",
      ],
      { NEUVE_GRAPH_BINARY: graph.executable, FAKE_GRAPH_LOG: graph.log },
    );
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.retrieval.profile).toBe("syntax-only");
    expect(output.structural_observations[0].status).toBe("error");
    const commands = (await Bun.file(graph.log).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(commands.filter((c) => c.command === "neighbors")).toEqual([]);
    expect(commands.find((c) => c.command === "query").args).toContain(
      "syntax-only",
    );
  });

  test("profile boundary is explicit", () => {
    const args = queryArgs("/absolute/repository", "a".repeat(40)).slice(1);
    expect(parseQueryInvocation(args).request).not.toHaveProperty("profile");
    expect(
      parseQueryInvocation([
        ...args,
        "--prepared-only",
        "--profile",
        "syntax-only",
      ]).request.profile,
    ).toBe("syntax-only");
    for (const flags of [
      ["--profile", "syntax-only"],
      ["--profile", "fast"],
      ["--profile", "full", "--profile", "full"],
    ])
      expect(() => parseQueryInvocation([...args, ...flags])).toThrow();
    expect(() =>
      parseQueryInvocation([
        ...queryArgs("/absolute/repository", "abcdef1").slice(1),
        "--prepared-only",
      ]),
    ).toThrow("exact full commit OID");
  });

  test("prepared public boundary rejects refresh, duplicate and valued flags", () => {
    const args = queryArgs("/repository", "a".repeat(40)).slice(1);
    for (const extra of [
      ["--prepared-only", "--refresh-cache"],
      ["--refresh-cache", "--prepared-only"],
      ["--prepared-only", "--prepared-only"],
      ["--prepared-only", "true"],
    ])
      expect(() => parseQueryInvocation([...args, ...extra])).toThrow();
    expect(
      parseQueryInvocation([...args, "--prepared-only"]).request.cache,
    ).toBe("prepared");
  });

  test("refresh flag rebuilds before retrieval and preserves the public schema", async () => {
    const repository = await fixtureRepository();
    const graph = await fakeGraph();
    const result = await run(
      [...queryArgs(repository.root, repository.revision), "--refresh-cache"],
      { NEUVE_GRAPH_BINARY: graph.executable, FAKE_GRAPH_LOG: graph.log },
    );
    expect(result.exitCode).toBe(0);
    const publicResult = JSON.parse(result.stdout);
    expect(publicResult).toMatchObject({
      schema_version: 2,
      retrieval: { status: "ok" },
      structural_observations: [
        { status: "ok", observations: [{ to: { name: "callee" } }] },
      ],
    });
    expect(Object.keys(publicResult.provider).sort()).toEqual([
      "capabilities",
      "identity_revision",
      "name",
      "version",
    ]);
    expect(publicResult.retrieval.cache).toBeUndefined();
    const commands = (await Bun.file(graph.log).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(commands.map(({ command }) => command)).toEqual([
      "version",
      "capabilities",
      "index",
      "query",
      "neighbors",
      "neighbors",
    ]);
    expect(commands[2].args).toEqual([
      "--repo",
      expect.any(String),
      "--head",
      "--profile",
      "full",
      "--format",
      "json",
      "--force",
      "--cache-dir",
      // The machine's shared Graph cache, as the reviews' Graph reads use, not the repository's.
      join(process.env["NEUVE_BUDGET_DIRECTORY"] ?? "", "graph", "cache"),
    ]);
    expect(
      commands
        .filter(({ command }) => command === "query" || command === "neighbors")
        .every(({ args }) => !args.includes("--no-cache")),
    ).toBe(true);
  });

  test.each([
    [
      ["--refresh-cache", "--refresh-cache"],
      "--refresh-cache may be supplied only once.",
    ],
    [["--refresh-cache", "true"], "Unknown query option: true."],
    [["--refresh-cache=false"], "Unknown query option: --refresh-cache=false."],
  ] as const)("rejects invalid refresh flags %j", async (extra, message) => {
    const result = await run(
      [...queryArgs("/tmp/repo", "abcdef0"), ...extra],
      {},
    );
    expect(result).toEqual({
      exitCode: 2,
      stdout: "",
      stderr: `neuve: ${message}\n`,
    });
  });

  test("exact public plan is passed to Graph and echoed in structural output", async () => {
    const repository = await fixtureRepository();
    const graph = await fakeGraph();
    const result = await run(
      queryArgs(repository.root, repository.revision, "question", [
        {
          request_id: "calls",
          focus: { symbol: "target", path: "source.custom" },
          relation: "CALLS",
          selection: "exact",
          direction: "out",
          depth: 1,
          limit: 5,
        },
      ]),
      { NEUVE_GRAPH_BINARY: graph.executable, FAKE_GRAPH_LOG: graph.log },
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).structural_observations).toMatchObject([
      {
        request_id: "calls",
        status: "ok",
        selection: "exact",
        selected_relations: ["CALLS"],
        observations: [{ relation: "CALLS" }],
      },
    ]);
    const commands = (await Bun.file(graph.log).text())
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(
      commands
        .filter(({ command }) => command === "neighbors")
        .map(({ args }) => args[args.indexOf("--selection") + 1]),
    ).toEqual(["exact", "exact"]);
  });

  test("serializes an explicit frontier and requests it only after focus resolution", async () => {
    const repository = await fixtureRepository();
    const graph = await fakeGraph();
    const result = await run(
      queryArgs(repository.root, repository.revision, "question", [
        {
          request_id: "calls",
          focus: { symbol: "target", path: "source.custom" },
          relation: "CALLS",
          selection: "exact",
          direction: "out",
          depth: 1,
          limit: 5,
          summary: "frontier",
        },
      ]),
      { NEUVE_GRAPH_BINARY: graph.executable, FAKE_GRAPH_LOG: graph.log },
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).structural_observations[0]).toMatchObject({
      status: "ok",
      observations: [{ relation: "CALLS" }],
      summary: {
        kind: "observed",
        expanded_depth: 1,
        indexed_coverage: "ok",
        direct: {
          eligible_edges: 1,
          emitted_edges: 1,
          omitted_edges: 0,
          missing_endpoint_edges: 0,
        },
        frontier: [
          {
            kind: "indexed",
            endpoint_id: "callee-id",
            counts: [{ relation: "CALLS", resolution: "exact", edges: 1 }],
          },
        ],
      },
    });
    const neighbors = (await Bun.file(graph.log).text())
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter(({ command }) => command === "neighbors");
    expect(neighbors).toHaveLength(2);
    expect(neighbors[0].args).not.toContain("--summary");
    expect(neighbors[1].args).toEqual(
      expect.arrayContaining(["--summary", "frontier"]),
    );
  });

  test("publishes an unavailable frontier without losing legacy direct edges", async () => {
    const repository = await fixtureRepository();
    const graph = await fakeGraph("frontier-unsupported");
    const result = await run(
      queryArgs(repository.root, repository.revision, "question", [
        {
          request_id: "calls",
          focus: { symbol: "target", path: "source.custom" },
          relation: "CALLS",
          selection: "exact",
          direction: "out",
          depth: 1,
          limit: 5,
          summary: "frontier",
        },
      ]),
      { NEUVE_GRAPH_BINARY: graph.executable, FAKE_GRAPH_LOG: graph.log },
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).structural_observations[0]).toMatchObject({
      status: "ok",
      observations: [{ relation: "CALLS" }],
      summary: { kind: "unavailable", reason: "unsupported_provider" },
    });
    expect(await Bun.file(graph.log).text()).not.toContain('"--summary"');
  });

  test.each([undefined, "automatic"])(
    "rejects invalid frontier opt-in %s before provider work",
    async (summary) => {
      const result = await run(
        queryArgs("/tmp/example", "a".repeat(40), "question", [
          {
            request_id: "calls",
            focus: { symbol: "target" },
            relation: "CALLS",
            selection: "exact",
            direction: "out",
            depth: 1,
            limit: 5,
            ...(summary === undefined ? { summary: null } : { summary }),
          },
        ]),
      );
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("summary must be frontier when present");
    },
  );

  test.each([undefined, "automatic"])(
    "rejects missing or invalid selection %s before provider work",
    async (selection) => {
      const result = await run(
        queryArgs("/tmp/example", "a".repeat(40), "question", [
          {
            request_id: "calls",
            focus: { symbol: "target" },
            relation: "CALLS",
            ...(selection === undefined ? {} : { selection }),
            direction: "out",
            depth: 1,
            limit: 5,
          },
        ]),
      );
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain(
        selection === undefined
          ? "missing selection"
          : "selection must be exact or family",
      );
    },
  );

  test("legacy selection produces a public unavailable result with retrieval and no neighbors", async () => {
    const repository = await fixtureRepository();
    const graph = await fakeGraph("legacy-selection");
    const result = await run(queryArgs(repository.root, repository.revision), {
      NEUVE_GRAPH_BINARY: graph.executable,
      FAKE_GRAPH_LOG: graph.log,
    });
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.retrieval.status).toBe("ok");
    expect(payload.structural_observations).toEqual([
      {
        request_id: "target-call-family",
        status: "unavailable",
        reason: "unsupported_selection",
        selection: "family",
        relation: "CALLS",
      },
    ]);
    expect(
      (await Bun.file(graph.log).text())
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line).command),
    ).toEqual(["version", "capabilities", "query"]);
  });
  test("reports its binary version", async () => {
    expect(await run(["--version"])).toEqual({
      stdout: "neuve 0.1.1\n",
      stderr: "",
      exitCode: 0,
    });
  });

  test("rejects an incomplete query before provider discovery", async () => {
    expect(await run(["query", "--repo", "/tmp/example"])).toEqual({
      stdout: "",
      stderr: "neuve: Missing required option --revision.\n",
      exitCode: 2,
    });
  });

  test.each([
    [
      "line without path",
      {
        request_id: "calls",
        focus: { symbol: "target", line: 2 },
        relation: "CALLS",
        selection: "family",
        direction: "out",
        depth: 1,
        limit: 5,
      },
      "focus.line requires focus.path",
    ],
    [
      "symbol kind without qualified name",
      {
        request_id: "calls",
        focus: { symbol: "target", symbol_kind: "function" },
        relation: "CALLS",
        selection: "family",
        direction: "out",
        depth: 1,
        limit: 5,
      },
      "focus.symbol_kind and focus.qualified_name must appear together",
    ],
    [
      "qualified name without symbol kind",
      {
        request_id: "calls",
        focus: { symbol: "target", qualified_name: "target" },
        relation: "CALLS",
        selection: "family",
        direction: "out",
        depth: 1,
        limit: 5,
      },
      "focus.symbol_kind and focus.qualified_name must appear together",
    ],
  ] as const)(
    "rejects %s in a relationship selector",
    async (_, plan, error) => {
      const result = await run(
        queryArgs("/tmp/example", "abcdef0", "q", [plan]),
      );
      expect(result).toEqual({
        stdout: "",
        stderr: expect.stringContaining(error),
        exitCode: 2,
      });
    },
  );

  test("rejects legacy top-level target selectors", async () => {
    const result = await run([
      ...queryArgs("/tmp/example", "abcdef0", "q", []),
      "--target-file",
      "source.custom",
      "--target-symbol",
      "target",
    ]);
    expect(result).toEqual({
      stdout: "",
      stderr: "neuve: Unknown query option: --target-file.\n",
      exitCode: 2,
    });
  });

  test("an explicit empty relationship plan performs retrieval without neighbors", async () => {
    const repository = await fixtureRepository();
    const graph = await fakeGraph();
    const result = await run(
      queryArgs(
        repository.root,
        repository.revision,
        "Where does target call another symbol?",
        [],
      ),
      {
        NEUVE_GRAPH_BINARY: graph.executable,
        FAKE_GRAPH_LOG: graph.log,
      },
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      query: "Where does target call another symbol?",
      source: {
        repository: repository.root,
        revision: repository.revision,
      },
      structural_observations: [],
    });
    const commands = (await Bun.file(graph.log).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).command);
    expect(commands).toEqual(["version", "capabilities", "query"]);
  });

  test.each([
    ["delayed-neighbor", "ok"],
    ["failing-delayed-neighbor", "error"],
  ] as const)(
    "streams retrieval before %s finishes with a %s relationship outcome",
    async (mode, relationshipStatus) => {
      const repository = await fixtureRepository();
      const graph = await fakeGraph(mode);
      const child = Bun.spawn(
        [
          binary,
          ...queryArgs(repository.root, repository.revision),
          "--stream",
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            NEUVE_GRAPH_BINARY: graph.executable,
            FAKE_GRAPH_LOG: graph.log,
          },
        },
      );
      const lines = lineReader(child.stdout);
      const firstLine = await Promise.race([
        lines.read(),
        Bun.sleep(2_000).then(() => "timeout"),
      ]);
      expect(firstLine).not.toBe("timeout");
      const retrieval = JSON.parse(firstLine ?? "null");
      expect(retrieval).toMatchObject({
        kind: "retrieval",
        sequence: 1,
        retrieval: { status: "ok" },
      });
      await waitForFile(graph.neighborStarted);
      await Bun.write(graph.neighborRelease, "release");
      const relationship = JSON.parse((await lines.read()) ?? "null");
      const complete = JSON.parse((await lines.read()) ?? "null");
      expect(relationship).toMatchObject({
        kind: "relationship",
        sequence: 2,
        outcome: { status: relationshipStatus },
      });
      expect(complete).toMatchObject({
        kind: "complete",
        sequence: 3,
        relationship_count: 1,
      });
      expect([
        retrieval.identity,
        relationship.identity,
        complete.identity,
      ]).toEqual([retrieval.identity, retrieval.identity, retrieval.identity]);
      expect(await child.exited).toBe(0);
      expect(await new Response(child.stderr).text()).toBe("");
      expect(
        execute(["git", "worktree", "list", "--porcelain"], repository.root)
          .stdout,
      ).not.toContain("neuve-graph-client-");
    },
  );

  test("a broken streaming stdout cleans the isolated view", async () => {
    const repository = await fixtureRepository();
    const graph = await fakeGraph("delayed-neighbor");
    const child = Bun.spawn(
      [binary, ...queryArgs(repository.root, repository.revision), "--stream"],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          NEUVE_GRAPH_BINARY: graph.executable,
          FAKE_GRAPH_LOG: graph.log,
        },
      },
    );
    const lines = lineReader(child.stdout);
    expect(JSON.parse((await lines.read()) ?? "null").kind).toBe("retrieval");
    await waitForFile(graph.neighborStarted);
    await lines.cancel();
    await Bun.write(graph.neighborRelease, "release");
    expect(await child.exited).not.toBe(0);
    expect(
      execute(["git", "worktree", "list", "--porcelain"], repository.root)
        .stdout,
    ).not.toContain("neuve-graph-client-");
  });

  test("SIGTERM during a blocked relationship emits no completion and cleans up", async () => {
    const repository = await fixtureRepository();
    const graph = await fakeGraph("delayed-neighbor");
    const child = Bun.spawn(
      [binary, ...queryArgs(repository.root, repository.revision), "--stream"],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          NEUVE_GRAPH_BINARY: graph.executable,
          FAKE_GRAPH_LOG: graph.log,
        },
      },
    );
    const lines = lineReader(child.stdout);
    expect(JSON.parse((await lines.read()) ?? "null").kind).toBe("retrieval");
    await waitForFile(graph.neighborStarted);
    const neighborPid = Number(
      (await Bun.file(graph.neighborStarted).text()).trim(),
    );
    child.kill("SIGTERM");
    expect(await child.exited).toBe(143);
    expect(await lines.read()).toBeUndefined();
    expect(await new Response(child.stderr).text()).toBe(
      "neuve: interrupted by SIGTERM\n",
    );
    expect(() => process.kill(neighborPid, 0)).toThrow();
    expect(
      execute(["git", "worktree", "list", "--porcelain"], repository.root)
        .stdout,
    ).not.toContain("neuve-graph-client-");
  });

  test("sends the unchanged question and explicit plan to Graph", async () => {
    const repository = await fixtureRepository();
    const graph = await fakeGraph();
    const result = await run(queryArgs(repository.root, repository.revision), {
      NEUVE_GRAPH_BINARY: graph.executable,
      FAKE_GRAPH_LOG: graph.log,
    });
    expect({ stderr: result.stderr, exitCode: result.exitCode }).toEqual({
      stderr: "",
      exitCode: 0,
    });
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({
      schema_version: 2,
      provider: {
        name: "entire-graph",
        version: "fixture",
        identity_revision: "fixture-identity",
        capabilities: {
          schema_version: "1.3",
          file_extensions: [".custom"],
          languages: {
            supported: ["Fixture"],
            semantic: ["Fixture"],
            inventory_only: [],
          },
          relations: {
            supported: ["CALLS", "CONSTRUCTS"],
            by_language: { Fixture: ["CALLS", "CONSTRUCTS"] },
            by_profile: { full: ["CALLS", "CONSTRUCTS"] },
          },
        },
      },
      query: "  Preserve this question exactly?  ",
      source: {
        repository: repository.root,
        revision: repository.revision,
      },
      retrieval: {
        status: "ok",
        coverage: "partial",
        contained_callable_coverage: "complete",
        candidates: [
          {
            kind: "symbol",
            language: "Fixture",
            symbol: "target",
            source: {
              kind: "range",
              path: "source.custom",
              start_line: 1,
              end_line: 4,
            },
            contained_callables: {
              status: "complete",
              items: [
                {
                  kind: "symbol",
                  language: "Fixture",
                  symbol: "nested",
                  symbol_kind: "function",
                  qualified_name: "nested",
                  source: {
                    kind: "range",
                    path: "source.custom",
                    start_line: 2,
                    end_line: 3,
                  },
                },
              ],
            },
          },
          {
            kind: "partial_symbol",
            language: "OtherFixture",
            symbol_kind: "function",
            qualified_name: "partial",
            source: {
              kind: "range",
              path: "other.custom",
              start_line: 1,
              end_line: 3,
            },
            contained_callables: { status: "complete", items: [] },
          },
        ],
        limitations: [
          {
            kind: "undeclared_language",
            subject: "query_result",
            language: "OtherFixture",
          },
        ],
        budget: {
          requested_top_k: 5,
          requested_max_context_bytes: 4096,
          query_constraints_truncated: false,
          results_dropped_by_budget: 0,
          snippets_truncated_by_budget: 0,
        },
      },
      structural_observations: [
        {
          request_id: "target-call-family",
          status: "ok",
          focus: { kind: "resolved" },
          observations: [
            {
              relation: "CONSTRUCTS",
              direction: "out",
              evidence: [
                {
                  kind: "call_site",
                  location: {
                    kind: "range",
                    path: "source.custom",
                    start_line: 2,
                    end_line: 2,
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(result.stdout).not.toContain("direct_support");
    expect(result.stdout).not.toContain("surrounding_context");

    const commands = (await Bun.file(graph.log).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const query = commands.find(({ command }) => command === "query");
    expect(query.args[query.args.indexOf("--query") + 1]).toBe(
      "  Preserve this question exactly?  ",
    );
    const firstNeighbor = commands.find(
      ({ command, args }) =>
        command === "neighbors" && args.includes("source.custom"),
    );
    expect(firstNeighbor.args).toEqual(
      expect.arrayContaining([
        "--symbol",
        "target",
        "--file",
        "source.custom",
        "--relation",
        "CALLS",
        "--direction",
        "out",
      ]),
    );
  });

  test("keeps independent provider section failures visible", async () => {
    const repository = await fixtureRepository();
    const graph = await fakeGraph("section-errors");
    const result = await run(queryArgs(repository.root, repository.revision), {
      NEUVE_GRAPH_BINARY: graph.executable,
      FAKE_GRAPH_LOG: graph.log,
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      retrieval: { status: "error", error: expect.any(String) },
      structural_observations: [{ status: "error", error: expect.any(String) }],
    });
  });

  test("does not expose Graph command streams in public JSON", async () => {
    const repository = await fixtureRepository();
    const graph = await fakeGraph("hostile-streams");
    const result = await run(queryArgs(repository.root, repository.revision), {
      NEUVE_GRAPH_BINARY: graph.executable,
      FAKE_GRAPH_LOG: graph.log,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("HOSTILE_STDOUT_RECEIPT");
    expect(result.stdout).not.toContain("HOSTILE_STDERR_RECEIPT");
    expect(JSON.parse(result.stdout)).toMatchObject({
      retrieval: {
        status: "error",
        error: "Neuve Graph query observation unavailable.",
      },
    });
  });

  test.each([
    ["hostile-query-json", "HOSTILE_QUERY_VALUE", "retrieval"],
    ["hostile-neighbor-json", "HOSTILE_NEIGHBOR_VALUE", "relationship"],
  ] as const)(
    "sanitizes exit-zero %s provider values from public section errors",
    async (mode, hostile, section) => {
      const repository = await fixtureRepository();
      const graph = await fakeGraph(mode);
      const result = await run(
        queryArgs(repository.root, repository.revision),
        {
          NEUVE_GRAPH_BINARY: graph.executable,
          FAKE_GRAPH_LOG: graph.log,
        },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain(hostile);
      const response = JSON.parse(result.stdout);
      if (section === "retrieval") {
        expect(response.retrieval).toEqual({
          status: "error",
          error: "Neuve Graph query observation unavailable.",
        });
      } else {
        expect(response.structural_observations[0]).toEqual({
          request_id: "target-call-family",
          status: "error",
          error: "Neuve Graph relationship observation unavailable.",
        });
      }
    },
  );

  test("does not fall back when the explicit graph binary is unavailable", async () => {
    const repository = await fixtureRepository();
    const missing = join(repository.root, "missing-graph");
    const result = await run(queryArgs(repository.root, repository.revision), {
      NEUVE_GRAPH_BINARY: missing,
    });
    expect(result).toEqual({
      stdout: "",
      stderr: `neuve: NEUVE_GRAPH_BINARY does not name an executable file: ${missing}\n`,
      exitCode: 2,
    });
  });
});
