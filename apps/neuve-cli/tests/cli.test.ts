import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { Effect, Layer } from "effect";
import {
  Ancestry,
  Blobs,
  Computations,
  Cycles,
  Identity,
  JobQueue,
  Registry,
  Sessions,
  storeLocationIn,
  WRITER_VERSION,
} from "@neuve/records-core";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { defaultConfig } from "../../../packages/harness/src/config.ts";
import { mcpClientsLayer } from "../../../packages/harness/src/mcp-client.ts";
import { requestReview } from "../../../packages/harness/src/request.ts";
import { settingsPath } from "../../../packages/harness/src/settings.ts";
import { SOL_ROUTE } from "../../../packages/harness/src/route.ts";
import { localStorageProfile } from "../../../scripts/pi-storage.ts";
import { HostConfigSchema } from "@ace/host/host-config";
import { planScopeRead } from "@ace/host/worker";
import {
  fetchCyclePart,
  readLocalScope,
  readScopeOpening,
  scopeFolder,
} from "../../../packages/harness/src/scope.ts";
import {
  readRunLog,
  runLogPath,
} from "../../../packages/harness/src/run-log.ts";

import { parseQueryInvocation } from "../src/boundary.ts";
import type {
  PublicQueryEvent,
  PublicQueryScopeSource,
  RepositoryPath,
  Revision,
} from "../src/domain.ts";
import { collectPublicQueryResult, runQueryGraph } from "../src/graph-query.ts";
import { execute as executeRecords, withStore } from "../src/records-cli.ts";
import { codingWorkerSetup } from "../src/workspace-cli.ts";
import { markSetUp } from "./fixtures/set-up.ts";

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
  cwd?: string,
) => {
  const child = Bun.spawn([binary, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...environment },
    ...(cwd === undefined ? {} : { cwd }),
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
};

const createRecords = async (
  root: string,
  env?: Readonly<Record<string, string>>,
) => {
  const result = await run(["records", "migrate", "--repo", root], env);
  expect(result.exitCode, result.stderr).toBe(0);
};

const queryHistory = async (root: string, kind = "query.recorded@1") => {
  const history = await run([
    "records",
    "history",
    "--kind",
    kind,
    "--repo",
    root,
    "--json",
  ]);
  expect(history.exitCode, history.stderr).toBe(0);
  return JSON.parse(history.stdout);
};

const scopeJobs = (root: string) => {
  using db = new Database(join(root, ".git", "neuve", "records.sqlite"), {
    readonly: true,
  });
  return db
    .query(
      "SELECT kind, dedupe_key, state FROM jobs WHERE dedupe_key LIKE 'scope.fetch:%' ORDER BY job_seq",
    )
    .all();
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
  // Setup reports independent flag errors together before writing any settings.
  test("setup reports invalid initial query, agents, and route together", async () => {
    expect(
      await run([
        "setup",
        "--initial-query",
        "",
        "--agents",
        "bogus",
        "--route",
        "bogus",
      ]),
    ).toEqual({
      stdout: "",
      stderr: [
        "neuve: --initial-query takes non-empty text.",
        "--agents takes claude-code, codex or none.",
        "neuve setup --route takes openai (ChatGPT), anthropic (an Anthropic API key) or claude (your Claude subscription, through Claude Code).",
        "",
      ].join("\n"),
      exitCode: 2,
    });
  });

  // A flag refusal must include independent path problems without echoing the paths.
  test("setup reports missing repository and binary paths with other problems", async () => {
    const { root } = await fixtureRepository();
    const missingRepo = join(root, "private-repository");
    const missingGraph = join(root, "private-graph");
    const missingCli = join(root, "private-cli");
    expect(
      await run(["setup", "--route", "private-route", "--repo", missingRepo]),
    ).toEqual({
      stdout: "",
      stderr: [
        "neuve: neuve setup --route takes openai (ChatGPT), anthropic (an Anthropic API key) or claude (your Claude subscription, through Claude Code).",
        "--repo takes a folder inside a Git working tree.",
        "",
      ].join("\n"),
      exitCode: 2,
    });
    expect(
      await run([
        "setup",
        "--repo",
        root,
        "--graph-binary",
        missingGraph,
        "--cli-binary",
        missingCli,
      ]),
    ).toEqual({
      stdout: "",
      stderr: [
        "neuve: --graph-binary takes the path to an executable Neuve Graph binary.",
        "--cli-binary takes the path to an executable Neuve binary.",
        "",
      ].join("\n"),
      exitCode: 2,
    });
  });

  // A missing scope value should tell the caller what a replacement must be.
  test("query explains what a missing scope value takes", async () => {
    expect(
      await run([...queryArgs("/tmp/example", "abcdef0"), "--scope"]),
    ).toEqual({
      stdout: "",
      stderr:
        "neuve: --scope takes a non-empty path without null bytes. No value was supplied.\n",
      exitCode: 2,
    });
  });

  // The stored failure tells the caller why the existing job ended. The dedupe key is input.
  test("a requeue refusal shows the recorded job error", async () => {
    const { root } = await fixtureRepository();
    const command = [
      "jobs",
      "enqueue",
      "capture.scan",
      "--repo",
      root,
      "--no-start",
      "--key",
      "private job key",
    ];
    expect((await run(command)).exitCode).toBe(0);
    expect((await run(["jobs", "drop", "1", "--repo", root])).exitCode).toBe(0);
    expect(await run(command)).toEqual({
      stdout:
        "Not requeued: the job for this --key already ended as failed (Dropped: dropped while waiting). Enqueue with another --key to run it again.\n",
      stderr: "",
      exitCode: 0,
    });
  });

  // A write refusal must identify the failed filesystem operation without displaying the hook path.
  test("setup hooks keeps the native hook-file write reason", async () => {
    const { root } = await fixtureRepository();
    const directory = join(root, "private hook directory");
    await mkdir(directory);
    const file = join(directory, "settings.json");
    await Bun.write(file, "{}");
    await chmod(directory, 0o500);
    try {
      const result = await run([
        "setup",
        "hooks",
        "--repo",
        root,
        "--agents",
        "claude-code",
        "--command",
        process.execPath,
        "--no-stack",
        "--claude-settings",
        file,
      ]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toMatch(/permission denied, copyfile/i);
      expect(result.stderr).toContain("--claude-settings");
      expect(result.stderr).not.toContain(directory);
    } finally {
      await chmod(directory, 0o700);
    }
  });

  // Doctor must recognize an unreadable bundle even when setup quotes an apostrophe in its path.
  test("doctor names the unreadable script in a quoted hook command", async () => {
    const { root } = await fixtureRepository();
    await markSetUp(root);
    const home = join(root, "author's home");
    const tools = join(home, "bin");
    const settings = join(home, ".claude", "settings.json");
    await mkdir(tools, { recursive: true });
    const claude = join(tools, "claude");
    await Bun.write(claude, "#!/bin/sh\necho '2.1.0 (Claude Code)'\n");
    await chmod(claude, 0o700);
    const env = {
      ...process.env,
      HOME: home,
      CLAUDE_CONFIG_DIR: dirname(settings),
      CODEX_HOME: join(home, ".codex"),
      XDG_CONFIG_HOME: join(home, ".config"),
      PATH: `${tools}:${process.env.PATH ?? ""}`,
    };
    const setup = Bun.spawnSync(
      [
        process.execPath,
        "--no-env-file",
        resolve(import.meta.dir, "../src/cli.ts"),
        "setup",
        "hooks",
        "--repo",
        root,
        "--agents",
        "claude-code",
        "--no-stack",
      ],
      { cwd: root, env },
    );
    expect(setup.exitCode, setup.stderr.toString()).toBe(0);
    const script = join(
      dirname(Registry.registryPath(home)),
      "hook",
      "neuve-hook.js",
    );
    await chmod(script, 0o000);
    const result = await run(["doctor", "--repo", root, "--json"], env);
    expect(result.exitCode).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        check: "capture",
        status: "warning",
        detail: expect.stringContaining(
          `${settings} needs an update: Neuve's claude-code hooks run ${script}`,
        ),
      }),
    );
  });

  // Semantic inputs must report filesystem causes and which validated field needs correction.
  test("semantic keeps input diagnostics without printing the input path", async () => {
    const { root } = await fixtureRepository();
    const file = join(root, "private semantic input");
    const command = [
      "semantic",
      "--input",
      file,
      "--python",
      process.execPath,
      "--snapshot",
      root,
      "--worker",
      process.execPath,
      "--variant",
      "BASE",
    ];
    const missing = await run(command);
    expect(missing.exitCode).toBe(2);
    expect(missing.stderr).toMatch(
      /ENOENT: no such file or directory, open --input/i,
    );
    expect(missing.stderr).not.toContain(file);
    await Bun.write(
      file,
      JSON.stringify({ version: 1, inputs: [{ id: "one", role: "document" }] }),
    );
    const invalid = await run(command);
    expect(invalid.exitCode).toBe(2);
    expect(invalid.stderr).toContain(
      "Invalid input: expected string, received undefined",
    );
    expect(invalid.stderr).toContain("inputs[0].text");
    await Bun.write(file, "{");
    const incomplete = await run(command);
    expect(incomplete.exitCode).toBe(2);
    expect(incomplete.stderr).toContain("--input is not valid JSON.");
    await Bun.write(file, "privateIdentifier");
    const badToken = await run(command);
    expect(badToken.exitCode).toBe(2);
    expect(badToken.stderr).toContain("--input is not valid JSON.");
    expect(badToken.stderr).not.toContain("privateIdentifier");
  });

  // Workspace refusals must keep Git's reason for a bad project and the filesystem reason for a missing source.
  test("workspace keeps storage diagnostics without printing supplied paths", async () => {
    const { root } = await fixtureRepository();
    const home = await mkdtemp(join(tmpdir(), "neuve-workspace-home-"));
    roots.push(home);
    const missing = join(root, "private checkout");
    const source = await run(
      ["workspace", "--source", missing, "--profile", "local"],
      { HOME: home },
    );
    expect(source.exitCode).toBe(2);
    expect(source.stderr).toMatch(
      /ENOENT: no such file or directory, realpath --source/i,
    );
    expect(source.stderr).not.toContain(missing);
    const project = await run(
      ["workspace", "--source", root, "--profile", "local", "--repo", missing],
      { HOME: home },
    );
    expect(project.exitCode).toBe(1);
    expect(project.stderr).toContain("fatal: cannot change to --repo");
    expect(project.stderr).not.toContain(missing);
  });

  // The first read opens a cycle and the next joins it. Neither may change JSON or NDJSON output.
  test("opens and joins a cycle in JSON and NDJSON with telemetry off", async () => {
    const { root, revision } = await fixtureRepository();
    const graph = await fakeGraph();
    const home = join(root, "home");
    const settings = settingsPath(home);
    await Bun.write(
      settings,
      JSON.stringify({ telemetry: { enabled: false } }),
    );
    const env = {
      HOME: home,
      NEUVE_GRAPH_BINARY: graph.executable,
      FAKE_GRAPH_LOG: graph.log,
    };
    const question = "  Preserve this question exactly?  ";
    const json = queryArgs(root, revision.slice(0, 12), question);
    const ndjson = [...json, "--stream"];
    const database = join(root, ".git", "neuve", "records.sqlite");
    const withoutJson = await run(json, env);
    const withoutNdjson = await run(ndjson, env);
    expect(withoutJson.exitCode).toBe(0);
    expect(withoutNdjson.exitCode).toBe(0);
    expect(withoutJson.stderr).toBe("");
    expect(withoutNdjson.stderr).toBe("");
    expect(Object.keys(JSON.parse(withoutJson.stdout))).toEqual([
      "schema_version",
      "provider",
      "query",
      "source",
      "retrieval",
      "structural_observations",
    ]);
    expect(
      Object.keys(
        JSON.parse(withoutNdjson.stdout.trimEnd().split("\n").at(-1)!),
      ),
    ).toEqual([
      "schema_version",
      "sequence",
      "identity",
      "kind",
      "relationship_count",
    ]);
    expect(await Bun.file(database).exists()).toBe(false);

    await createRecords(root);
    expect(await run(json, env)).toEqual(withoutJson);
    const branch = execute(
      ["git", "branch", "--show-current"],
      root,
    ).stdout.trim();
    const openings = await queryHistory(root, "cycle.opened@2");
    expect(openings).toHaveLength(1);
    const opening = openings[0].event;
    const cycleId = opening.attribution.cycleId;
    expect(opening.attribution).toEqual({ cycleId });
    expect(opening.payload).toEqual({
      baseOid: revision,
      baseRef: revision.slice(0, 12),
      branch,
      branchTipOid: revision,
    });
    const jobs = [
      {
        kind: "scope.fetch@2",
        dedupe_key: `scope.fetch:${cycleId}`,
        state: "waiting",
      },
    ];
    expect(scopeJobs(root)).toEqual(jobs);
    expect(await run(ndjson, env)).toEqual(withoutNdjson);
    expect(await queryHistory(root, "cycle.opened@2")).toEqual(openings);
    expect(scopeJobs(root)).toEqual(jobs);
    const history = await queryHistory(root);
    expect(history).toHaveLength(2);
    const [first, second] = history;
    expect(first.event.id).not.toBe(second.event.id);
    expect(await queryHistory(root, "actor.registered@1")).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({
          actor: first.event.actor,
          payload: {
            actorKind: "human",
            harness: "git",
            email: "cli@example.test",
            displayName: "Neuve CLI Test",
          },
        }),
      }),
    ]);
    for (const { event } of history) {
      expect(event.kind).toBe("query.recorded@1");
      expect(event.idempotencyKey).toBe(`query:${event.id}`);
      expect(event.actor).toBe(
        "a95c31428577cbc202767502c04ab7d0c623cb73d61d7e33991b1dfa07edb9d2",
      );
      expect(event.attribution).toEqual({ cycleId });
      expect(event.payload).toEqual({
        revision,
        maxResults: 5,
        maxContextBytes: 4096,
        cache: "reuse",
        profile: "full",
        relationshipPlanSize: 1,
        outcome: "completed",
        candidatesReturned: 2,
        relationships: 1,
        resultBytes: 50,
        resultsDroppedByBudget: 0,
        snippetsTruncatedByBudget: 0,
        startedAt: expect.any(String),
        elapsedMs: expect.any(Number),
      });
    }
    expect(first.event.refs).toEqual(second.event.refs);
    expect(first.event.refs).toEqual([
      { role: "question", ref: expect.stringMatching(/^blob:[0-9a-f]{64}$/) },
    ]);
    using db = new Database(database, { readonly: true });
    const blob = db
      .query("SELECT retention, content FROM blobs WHERE hash = ?")
      .get(first.event.refs[0].ref.slice("blob:".length));
    expect(blob).toEqual({
      retention: "raw-capture",
      content: new TextEncoder().encode(question),
    });
  });

  // A read attributed to an agent must hold the approved plan only on the branch whose cycle it opens.
  test("records the explicit agent and returns opened, joined and detached read states", async () => {
    const { root, revision } = await fixtureRepository();
    const planText = "# Approved plan\nKeep the original export scope.\n";
    const plan = join(root, "approved-plan.md");
    await Bun.write(plan, planText);
    const graph = await fakeGraph();
    const previousBinary = process.env.NEUVE_GRAPH_BINARY;
    process.env.NEUVE_GRAPH_BINARY = graph.executable;
    const requester = {
      _tag: "Agent" as const,
      harness: "neuve-pi",
      sessionId: "channel-scope",
      subagentId: "19",
    };
    const read = async (question: string, branch?: string) => {
      const events: PublicQueryEvent[] = [];
      const { state } = await runQueryGraph(
        {
          repository: root as RepositoryPath,
          revision: revision as Revision,
          ...(branch === undefined ? {} : { branch }),
          question,
          scope: [plan],
          maxResults: 8,
          maxContextBytes: 16_000,
          relationships: [],
        },
        {
          requester,
          emit: async (event) => {
            events.push(event);
          },
        },
      );
      return { state, answer: collectPublicQueryResult(events) };
    };
    try {
      const unrecorded = await read("Read before Records setup.");
      expect(unrecorded.state).toEqual({
        kind: "not_recorded",
        reason: "no Records store was found",
      });
      await createRecords(root, { NEUVE_TEST_PROCESS: "1" });
      const first = await read("Read the approved export plan.");
      const cycleId = first.answer.cycle_id!;
      expect(first.state).toEqual({
        kind: "cycle_opened",
        cycle_id: expect.any(String),
      });
      expect(first.state).toMatchObject({ cycle_id: cycleId });
      expect(first.answer.scope?.[0]).toMatchObject({
        title: "approved-plan.md",
        text: planText,
        sha256: createHash("sha256").update(planText).digest("hex"),
      });
      await Bun.write(plan, "Edited outside the cycle.");
      const next = await read("Read the held export plan.");
      expect(next.state).toEqual({ kind: "cycle_joined", cycle_id: cycleId });
      expect(next.answer.scope?.[0]?.text).toBe(planText);
      expect(
        execute(["git", "branch", "second-implementer"], root).exitCode,
      ).toBe(0);
      const second = await read(
        "Read on the second branch.",
        "second-implementer",
      );
      expect(second.state).toEqual({
        kind: "cycle_opened",
        cycle_id: expect.any(String),
      });
      expect(second.answer.cycle_id).not.toBe(cycleId);
      expect(second.answer.scope?.[0]?.text).toBe("Edited outside the cycle.");
      expect(
        execute(["git", "checkout", "--detach", revision], root).exitCode,
      ).toBe(0);
      const detached = await read("Read from detached HEAD.");
      expect(detached.state).toEqual({
        kind: "not_joined",
        reason: "HEAD is detached",
      });
      expect(await queryHistory(root, "actor.registered@1")).toEqual([
        expect.objectContaining({
          event: expect.objectContaining({
            actor: Identity.agentFingerprint(requester),
            payload: {
              actorKind: "agent",
              harness: "neuve-pi",
              sessionId: "channel-scope",
              subagentId: "19",
            },
          }),
        }),
      ]);
      const history = await queryHistory(root);
      expect(
        history.map(
          ({ event }: { event: { actor: string; attribution: unknown } }) => ({
            actor: event.actor,
            attribution: event.attribution,
          }),
        ),
      ).toEqual(
        [cycleId, cycleId, second.answer.cycle_id, undefined].map(
          (cycleId) => ({
            actor: Identity.agentFingerprint(requester),
            attribution: {
              sessionId: "channel-scope",
              ...(cycleId ? { cycleId } : {}),
            },
          }),
        ),
      );
    } finally {
      if (previousBinary === undefined) delete process.env.NEUVE_GRAPH_BINARY;
      else process.env.NEUVE_GRAPH_BINARY = previousBinary;
    }
  });

  test("worker query refuses a replaced plan before recording and pins the approved plan on retry", async () => {
    const { root, revision } = await fixtureRepository();
    const scratch = await mkdtemp(join(tmpdir(), "neuve-worker-scope-"));
    roots.push(scratch);
    await createRecords(root, { NEUVE_TEST_PROCESS: "1" });
    const graph = await fakeGraph();
    const worker = {
      sessionId: "worker-scope",
      stateDirectory: scratch,
      config: HostConfigSchema.parse({
        home: scratch,
        lanes: root,
        user: "owner",
        port: 0,
        environment: {},
        worker: [process.execPath],
      }),
    };
    const { query } = codingWorkerSetup(
      await localStorageProfile(root, scratch),
      SOL_ROUTE,
    );
    const plans = join(scratch, "plans");
    const text = "# Approved plan\nKeep the approved scope.\n";
    const plan = {
      file: `${crypto.randomUUID()}.md`,
      title: "Approved plan",
      text,
      hash: createHash("sha256").update(text).digest("hex"),
    };
    const read = planScopeRead(root, plans, async (request) => {
      if (request.question === "Read a linked plan") {
        const replacement = join(plans, "replacement.md");
        await symlink(join(root, "source.custom"), replacement);
        await rename(replacement, join(plans, plan.file));
      }
      if (request.question === "Read after replacement") {
        const replacement = join(plans, "replacement.md");
        await Bun.write(replacement, "Unapproved plan text.");
        await rename(replacement, join(plans, plan.file));
      }
      return query!(worker, request);
    });
    const request = {
      repository: root,
      revision,
      plan,
      scope: [],
      previousPlans: [],
      requester: {
        _tag: "Agent" as const,
        harness: "neuve-pi" as const,
        sessionId: worker.sessionId,
        subagentId: "8",
      },
    };
    const previousBinary = process.env.NEUVE_GRAPH_BINARY;
    process.env.NEUVE_GRAPH_BINARY = graph.executable;
    try {
      expect(
        await read({ ...request, question: "Read a linked plan" }),
      ).toEqual({
        isError: true,
        text: "The checked scope path could not be opened safely.",
      });
      expect(
        await read({ ...request, question: "Read after replacement" }),
      ).toEqual({
        isError: true,
        text: "The approved plan changed while the host read it. Retry the call.",
      });
      expect(await queryHistory(root)).toEqual([]);
      expect(await queryHistory(root, "cycle.opened@2")).toEqual([]);
      expect(await queryHistory(root, "cycle.local-scope-selected@1")).toEqual(
        [],
      );

      const retry = await read({
        ...request,
        question: "Retry approved plan read",
      });
      expect(retry.isError, retry.text).toBeUndefined();
      const [{ event: opening }] = await queryHistory(root, "cycle.opened@2");
      const cycleId = opening.attribution.cycleId;
      expect(JSON.parse(retry.text)).toMatchObject({
        state: { kind: "cycle_opened", cycle_id: cycleId },
        scope: [{ kind: "working-file", text, sha256: plan.hash }],
      });
      const [{ event: selection }] = await queryHistory(
        root,
        "cycle.local-scope-selected@1",
      );
      expect(selection).toMatchObject({
        attribution: { cycleId },
        payload: { sources: [{ kind: "working-file", sha256: plan.hash }] },
      });
    } finally {
      if (previousBinary === undefined) delete process.env.NEUVE_GRAPH_BINARY;
      else process.env.NEUVE_GRAPH_BINARY = previousBinary;
    }
  });

  test("worker query refuses an unknown base revision as the command line does", async () => {
    const { root } = await fixtureRepository();
    const scratch = await mkdtemp(join(tmpdir(), "neuve-worker-scope-"));
    roots.push(scratch);
    await createRecords(root, { NEUVE_TEST_PROCESS: "1" });
    const graph = await fakeGraph();
    const worker = {
      sessionId: "worker-scope",
      stateDirectory: scratch,
      config: HostConfigSchema.parse({
        home: scratch,
        lanes: root,
        user: "owner",
        port: 0,
        environment: {},
        worker: [process.execPath],
      }),
    };
    const { query } = codingWorkerSetup(
      await localStorageProfile(root, scratch),
      SOL_ROUTE,
    );
    const read = planScopeRead(root, join(scratch, "plans"), (request) =>
      query!(worker, request),
    );
    const revision = "f".repeat(40);
    const question = "Read from a missing base";
    const previousBinary = process.env.NEUVE_GRAPH_BINARY;
    process.env.NEUVE_GRAPH_BINARY = graph.executable;
    try {
      const text = "# Approved plan\n";
      const result = await read({
        repository: root,
        revision,
        question,
        scope: [],
        previousPlans: [],
        requester: {
          _tag: "Agent",
          harness: "neuve-pi",
          sessionId: worker.sessionId,
          subagentId: "8",
        },
        plan: {
          file: `${crypto.randomUUID()}.md`,
          title: "Approved plan",
          text,
          hash: createHash("sha256").update(text).digest("hex"),
        },
      });
      expect(result).toEqual({
        isError: true,
        text: "The revision names no commit in this repository.",
      });
      expect(await queryHistory(root)).toEqual([]);
      const cli = await run(queryArgs(root, revision, question, []), {
        NEUVE_TEST_PROCESS: "1",
      });
      expect(cli.exitCode, cli.stderr).toBe(2);
      expect(cli.stderr.trim()).toEndWith(result.text);
    } finally {
      if (previousBinary === undefined) delete process.env.NEUVE_GRAPH_BINARY;
      else process.env.NEUVE_GRAPH_BINARY = previousBinary;
    }
  });

  test("worker query gives cause-specific refusals for inaccessible and linked scope paths", async () => {
    const { root, revision } = await fixtureRepository();
    const scratch = await mkdtemp(join(tmpdir(), "neuve-worker-scope-"));
    roots.push(scratch);
    const worker = {
      sessionId: "worker-scope",
      stateDirectory: scratch,
      config: HostConfigSchema.parse({
        home: scratch,
        lanes: root,
        user: "owner",
        port: 0,
        environment: {},
        worker: [process.execPath],
      }),
    };
    const { query } = codingWorkerSetup(
      await localStorageProfile(root, scratch),
      SOL_ROUTE,
    );
    const read = planScopeRead(root, join(scratch, "plans"), (request) =>
      query!(worker, request),
    );
    const text = "# Approved plan\n";
    const request = {
      repository: root,
      revision,
      question: "Read scope",
      previousPlans: [],
      plan: {
        file: `${crypto.randomUUID()}.md`,
        title: "Approved plan",
        text,
        hash: createHash("sha256").update(text).digest("hex"),
      },
      requester: {
        _tag: "Agent" as const,
        harness: "neuve-pi" as const,
        sessionId: worker.sessionId,
        subagentId: "8",
      },
    };
    const locked = join(root, "locked");
    await mkdir(locked);
    await Bun.write(join(locked, "x.md"), "Scope text.");
    await symlink(join(root, "source.custom"), join(root, "link.md"));
    try {
      await chmod(locked, 0o000);
      expect(await read({ ...request, scope: ["locked/x.md"] })).toEqual({
        isError: true,
        text: 'scope[0] received "locked/x.md" but access to its path was denied (EACCES).',
      });
    } finally {
      await chmod(locked, 0o700);
    }
    expect(await read({ ...request, scope: ["link.md"] })).toEqual({
      isError: true,
      text: 'scope[0] received "link.md" through a link, so name each linked file by a path with no link in it.',
    });
  });

  test("worker query rejects a linked scope parent before keeping the file in Records", async () => {
    const { root, revision } = await fixtureRepository();
    const scratch = await mkdtemp(join(tmpdir(), "neuve-worker-scope-"));
    roots.push(scratch);
    await createRecords(root, { NEUVE_TEST_PROCESS: "1" });
    const graph = await fakeGraph();
    const worker = {
      sessionId: "worker-scope",
      stateDirectory: scratch,
      config: HostConfigSchema.parse({
        home: scratch,
        lanes: root,
        user: "owner",
        port: 0,
        environment: {},
        worker: [process.execPath],
      }),
    };
    const { query } = codingWorkerSetup(
      await localStorageProfile(root, scratch),
      SOL_ROUTE,
    );
    const notes = join(root, "notes");
    const outside = join(scratch, "outside");
    await mkdir(notes);
    await mkdir(outside);
    await Bun.write(join(notes, "watched.md"), "Original scope.");
    await link(join(notes, "watched.md"), join(outside, "watched.md"));
    await Bun.write(join(root, "file.txt"), "Regular file.");
    const unreadable = join(root, "unreadable.md");
    await Bun.write(unreadable, "Unreadable scope.");
    const read = planScopeRead(
      root,
      join(scratch, "plans"),
      async (request) => {
        await chmod(unreadable, 0o000);
        await rename(notes, join(root, "original-notes"));
        await symlink(outside, notes, "dir");
        return query!(worker, request);
      },
    );
    const text = "# Approved plan\nKeep the scope boundary.\n";
    const requester = {
      _tag: "Agent" as const,
      harness: "neuve-pi" as const,
      sessionId: worker.sessionId,
      subagentId: "8",
    };
    const previousBinary = process.env.NEUVE_GRAPH_BINARY;
    process.env.NEUVE_GRAPH_BINARY = graph.executable;
    try {
      const result = await read({
        repository: root,
        revision,
        question: "Read the approved plan and notes.",
        scope: ["file.txt/x.md", "unreadable.md", "notes/watched.md"],
        requester,
        previousPlans: [],
        plan: {
          file: `${crypto.randomUUID()}.md`,
          title: "Approved plan",
          text,
          hash: createHash("sha256").update(text).digest("hex"),
        },
      });
      expect(result.isError, result.text).toBeUndefined();
      const answer = JSON.parse(result.text);
      expect(answer.scope_gaps).toEqual([
        "file.txt/x.md: The path was absent from the working tree and the base revision.",
        "unreadable.md: The file could not be read.",
        "notes/watched.md: The checked scope path could not be opened safely.",
      ]);
      expect(result.text).not.toContain("Original scope.");
      const [{ event: selection }] = await queryHistory(
        root,
        "cycle.local-scope-selected@1",
      );
      expect(
        selection.payload.sources.map(({ kind }: { kind: string }) => kind),
      ).toEqual(["working-file", "gap", "gap", "gap"]);
      const held = scopeFolder(
        storeLocationIn(join(root, ".git")),
        answer.cycle_id,
      );
      expect(await readdir(held)).toEqual(["S1.txt"]);
      const [{ event }] = await queryHistory(root);
      expect(event).toMatchObject({
        actor: Identity.agentFingerprint(requester),
        attribution: { sessionId: worker.sessionId, cycleId: answer.cycle_id },
      });
    } finally {
      if (previousBinary === undefined) delete process.env.NEUVE_GRAPH_BINARY;
      else process.env.NEUVE_GRAPH_BINARY = previousBinary;
    }
  });

  // Linux walks directory descriptors through /proc. macOS rejects links in a single open.
  test.skipIf(process.platform !== "linux")(
    "Linux checked scope gets ELOOP at every linked depth and closes its handles",
    async () => {
      const { root, revision } = await fixtureRepository();
      const repository = await realpath(root);
      await mkdir(join(repository, "empty"));
      await mkdir(join(repository, "nested"));
      await symlink("empty", join(repository, "first-link"));
      await symlink("../empty", join(repository, "nested", "inner-link"));
      await symlink("source.custom", join(repository, "leaf-link"));
      const names = [
        "first-link/missing.md",
        "nested/inner-link/missing.md",
        "leaf-link",
      ];
      const opened: fs.FileHandle[] = [];
      const rejected: string[] = [];
      const open = fs.open;
      const spy = spyOn(fs, "open").mockImplementation(
        async (path, flags, mode) => {
          try {
            const file = await open(path, flags, mode);
            if (path === "/" || String(path).startsWith("/proc/self/fd/"))
              opened.push(file);
            return file;
          } catch (error) {
            if (
              error instanceof Error &&
              "code" in error &&
              error.code === "ELOOP"
            )
              rejected.push(basename(String(path)));
            throw error;
          }
        },
      );
      try {
        const answer = await Effect.runPromise(
          readLocalScope(
            repository,
            revision,
            names.map((name) => join(repository, name)),
            true,
          ),
        );
        expect(answer.sources.map(({ kind, path }) => [kind, path])).toEqual(
          names.map((name) => ["gap", name]),
        );
        expect(rejected.sort()).toEqual([
          "first-link",
          "inner-link",
          "leaf-link",
        ]);
        expect(opened.length).toBeGreaterThan(0);
        expect(opened.every((file) => file.fd === -1)).toBe(true);
      } finally {
        spy.mockRestore();
      }
    },
  );

  // Linux formerly compared the /proc descriptor pathname after open. macOS has no such check.
  test.skipIf(process.platform !== "linux")(
    "Linux checked scope reads the opened file after a rename",
    async () => {
      const { root, revision } = await fixtureRepository();
      const repository = await realpath(root);
      const name = "rename-after-open.md";
      const path = join(repository, name);
      const renamed = join(repository, "renamed.md");
      const text = "Scope held by an open descriptor.";
      await Bun.write(path, text);
      const open = fs.open;
      const spy = spyOn(fs, "open").mockImplementation(
        async (openedPath, flags, mode) => {
          const file = await open(openedPath, flags, mode);
          if (basename(String(openedPath)) === name) {
            try {
              await rename(path, renamed);
            } catch (error) {
              await file.close();
              throw error;
            }
          }
          return file;
        },
      );
      try {
        const answer = await Effect.runPromise(
          readLocalScope(repository, revision, [path], true),
        );
        expect(await Bun.file(renamed).text()).toBe(text);
        expect(answer.sources).toMatchObject([
          { kind: "working-file", path: name, bytes: Buffer.from(text) },
        ]);
      } finally {
        spy.mockRestore();
      }
    },
  );

  test.each(["was deleted from the worktree", "never existed"] as const)(
    "worker query keeps named scope that %s",
    async (scenario) => {
      const { root, revision: initial } = await fixtureRepository();
      const stateDirectory = await mkdtemp(
        join(tmpdir(), "neuve-worker-missing-"),
      );
      roots.push(stateDirectory);
      const path = "docs/exports/scope.md";
      const text = "# Export scope\nKeep the retry order.\n";
      const tracked = scenario === "was deleted from the worktree";
      let revision = initial;
      if (tracked) {
        await Bun.write(join(root, path), text);
        expect(execute(["git", "add", path], root).exitCode).toBe(0);
        expect(
          execute(["git", "commit", "-qm", "Export scope"], root).exitCode,
        ).toBe(0);
        revision = execute(["git", "rev-parse", "HEAD"], root).stdout.trim();
        await rm(join(root, "docs"), { recursive: true });
      }
      await createRecords(root, { NEUVE_TEST_PROCESS: "1" });
      const graph = await fakeGraph();
      const worker = {
        sessionId: "worker-missing-scope",
        stateDirectory,
        config: HostConfigSchema.parse({
          home: stateDirectory,
          lanes: root,
          user: "owner",
          port: 0,
          environment: {},
          worker: [process.execPath],
        }),
      };
      const { query } = codingWorkerSetup(
        await localStorageProfile(root, stateDirectory),
        SOL_ROUTE,
      );
      const read = planScopeRead(
        root,
        join(stateDirectory, "plans"),
        (request) => query!(worker, request),
      );
      const note = `Keep this path verbatim: ${join(stateDirectory, "plans")}\n`;
      await Bun.write(join(root, "notes.md"), note);
      const plan = "# Approved plan\nRead the export scope.\n";
      const previousBinary = process.env.NEUVE_GRAPH_BINARY;
      process.env.NEUVE_GRAPH_BINARY = graph.executable;
      try {
        const result = await read({
          repository: root,
          revision,
          question: "What is the export scope?",
          scope: [path, "notes.md"],
          previousPlans: [],
          requester: {
            _tag: "Agent",
            harness: "neuve-pi",
            sessionId: worker.sessionId,
            subagentId: "8",
          },
          plan: {
            file: `${crypto.randomUUID()}.md`,
            title: "Approved plan",
            text: plan,
            hash: createHash("sha256").update(plan).digest("hex"),
          },
        });
        expect(result.isError).toBeUndefined();
        const answer = JSON.parse(result.text);
        expect(answer.scope).toContainEqual(
          expect.objectContaining({
            ref: expect.objectContaining({ path: "notes.md" }),
            text: note,
            sha256: createHash("sha256").update(note).digest("hex"),
          }),
        );
        const reason =
          "The path was absent from the working tree and the base revision.";
        expect(answer.scope_gaps).toEqual(
          tracked ? [] : [`${path}: ${reason}`],
        );
        if (tracked) {
          expect(answer.scope).toContainEqual(
            expect.objectContaining({
              kind: "repository-document",
              ref: expect.objectContaining({ path, revision }),
              text,
            }),
          );
        }
        const [{ event }] = await queryHistory(
          root,
          "cycle.local-scope-selected@1",
        );
        expect(event.attribution.cycleId).toBe(answer.cycle_id);
        expect(event.payload.sources[1]).toMatchObject(
          tracked
            ? {
                kind: "repository-document",
                path,
                blob: execute(
                  ["git", "rev-parse", `${revision}:${path}`],
                  root,
                ).stdout.trim(),
              }
            : { kind: "gap", path, reason },
        );
      } finally {
        if (previousBinary === undefined) delete process.env.NEUVE_GRAPH_BINARY;
        else process.env.NEUVE_GRAPH_BINARY = previousBinary;
      }
    },
  );

  // A later tree can hide a pinned document or its linked context.
  test("holds named scope at the opening read and returns it on a join", async () => {
    const { root } = await fixtureRepository();
    const scratch = await mkdtemp(join(tmpdir(), "neuve-cli-scope-"));
    roots.push(scratch);
    const plan = join(await realpath(scratch), "approved-plan");
    const note =
      "# Done when\n- Preserve the approved text.\n\nRead also handbook/details.\n";
    const original = Buffer.from("\uFEFF" + note);
    const sha256 = createHash("sha256").update(original).digest("hex");
    await Bun.write(plan, original);
    await Bun.write(join(root, "AGENTS.md"), "Read [guide](guide).\n");
    await Bun.write(join(root, "guide"), "Guide context.\n");
    await Bun.write(join(root, "handbook", "details"), "Found context.\n");
    const committed = "# Approved decision\nUse the Git version.\n";
    await Bun.write(join(root, "decision"), committed);
    expect(
      execute(
        ["git", "add", "AGENTS.md", "guide", "handbook/details", "decision"],
        root,
      ).exitCode,
    ).toBe(0);
    expect(
      execute(["git", "commit", "--quiet", "-m", "scope documents"], root)
        .exitCode,
    ).toBe(0);
    const revision = execute(["git", "rev-parse", "HEAD"], root).stdout.trim();
    const blob = execute(
      ["git", "rev-parse", "HEAD:decision"],
      root,
    ).stdout.trim();
    await rm(join(root, "decision"));
    const graph = await fakeGraph();
    const env = {
      HOME: join(scratch, "home"),
      NEUVE_GRAPH_BINARY: graph.executable,
      NEUVE_TEST_PROCESS: "1",
    };
    await mkdir(env.HOME);
    await createRecords(root, env);

    const args = [
      ...queryArgs(root, revision),
      "--scope",
      plan,
      "--scope",
      "decision",
    ];
    const first = await run(args, env);
    expect(first.exitCode, first.stderr).toBe(0);
    const answer = JSON.parse(first.stdout);
    const pinEvents = await queryHistory(root, "cycle.local-scope-selected@1");
    expect(pinEvents).toHaveLength(1);
    const { event } = pinEvents[0];
    expect(event.attribution.cycleId).toBe(answer.cycle_id);
    const [pin] = event.payload.sources;
    expect(event.payload.sources).toEqual([
      {
        kind: "working-file",
        path: plan,
        namedAs: [plan],
        sourceId: "S1",
        fetchedAt: expect.any(String),
        sha256,
      },
      {
        kind: "repository-document",
        path: "decision",
        namedAs: ["decision"],
        blob,
      },
    ]);
    expect(new Date(pin.fetchedAt).toISOString()).toBe(pin.fetchedAt);
    const [opening] = await queryHistory(root, "cycle.opened@2");
    expect(opening.event.occurredAt).toBe(event.occurredAt);
    expect(scopeJobs(root)).toEqual([
      {
        kind: "scope.fetch@2",
        dedupe_key: `scope.fetch:${answer.cycle_id}`,
        state: "waiting",
      },
    ]);
    expect(answer.scope_gaps).toEqual([]);
    expect(
      answer.scope.map(({ ref }: { ref: { path: string } }) => ref.path),
    ).toEqual([plan, "decision", "AGENTS.md", "guide", "handbook/details"]);
    const [held, document, guide, linked, named] = answer.scope;
    expect(held).toMatchObject({
      kind: "working-file",
      fetchedAt: pin.fetchedAt,
      sha256,
      ref: { path: plan },
      text: note,
    });
    expect(document).toMatchObject({
      kind: "repository-document",
      ref: { path: "decision", blob, revision, found: "named by the request" },
      text: committed,
      sections: [
        {
          startLine: 1,
          endLine: 3,
          sha256: createHash("sha256").update(committed).digest("hex"),
        },
      ],
    });
    expect(
      [guide, linked, named].map(
        ({ ref, contextOnly, stratum }: PublicQueryScopeSource) => [
          ref.found,
          contextOnly,
          stratum,
        ],
      ),
    ).toEqual([
      ["agent guide (agents-md-root-v1)", true, "context only"],
      ["linked from AGENTS.md", true, "context only"],
      [`named in ${plan}`, true, "context only"],
    ]);
    const location = storeLocationIn(join(root, ".git"));
    const heldPath = join(scopeFolder(location, answer.cycle_id), "S1.txt");
    expect(await Bun.file(heldPath).bytes()).toEqual(new Uint8Array(original));
    await Bun.write(plan, "Changed after the first read.\n");

    const integrations = { status: "absent", path: "(none)" } as const;
    const readCycle = () =>
      executeRecords(
        withStore(
          root,
          "write",
          Effect.gen(function* () {
            const event = yield* readScopeOpening(answer.cycle_id);
            if (event === undefined)
              throw new Error("Expected a recorded cycle opening");
            return (yield* fetchCyclePart(
              {
                repository: root,
                location,
                cycleId: answer.cycle_id,
                integrations,
              },
              event,
            )).value;
          }).pipe(
            Effect.provide(mcpClientsLayer(integrations)),
            Effect.provide(
              Computations.layer.pipe(
                Layer.provideMerge(Blobs.layer(location)),
              ),
            ),
          ),
        ),
      );
    const cycle = await readCycle();
    expect(
      cycle.sources.map((source) => ({
        ...source,
        stratum: source.contextOnly ? "context only" : source.stratum,
      })),
    ).toEqual(
      answer.scope.map(
        ({ text: _text, ...source }: PublicQueryScopeSource) => source,
      ),
    );

    const late = join(await realpath(scratch), "late-plan");
    await Bun.write(late, "A later plan.\n");
    await Bun.write(join(root, "decision"), "# A later decision\n");
    await rm(join(root, "guide"));
    expect(
      execute(["git", "commit", "-qam", "Change scope documents"], root)
        .exitCode,
    ).toBe(0);
    const laterRevision = execute(
      ["git", "rev-parse", "HEAD"],
      root,
    ).stdout.trim();
    const branch = execute(
      ["git", "branch", "--show-current"],
      root,
    ).stdout.trim();
    const reviewer = join(scratch, "reviewer");
    expect(
      execute(
        ["git", "worktree", "add", "--detach", reviewer, laterRevision],
        root,
      ).exitCode,
    ).toBe(0);
    const joined = await run(
      [
        ...queryArgs(reviewer, laterRevision),
        "--branch",
        branch,
        "--scope",
        late,
        "--stream",
      ],
      env,
    );
    expect(joined.exitCode, joined.stderr).toBe(0);
    const events: PublicQueryEvent[] = joined.stdout
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.map(({ kind, sequence }) => [kind, sequence])).toEqual([
      ["retrieval", 1],
      ["relationship", 2],
      ["scope", 3],
      ["scope", 4],
      ["scope", 5],
      ["scope", 6],
      ["scope", 7],
      ["complete", 8],
    ]);
    expect(
      events.flatMap((event) => (event.kind === "scope" ? [event.source] : [])),
    ).toEqual(answer.scope);
    expect(events.at(-1)).toMatchObject({
      cycle_id: answer.cycle_id,
      scope_gaps: [expect.stringContaining(`${late}:`)],
    });
    expect(await queryHistory(root, "cycle.local-scope-selected@1")).toEqual(
      pinEvents,
    );

    await Bun.write(heldPath, "The copy has changed.\n");
    expect((await readCycle()).sources[0]).toMatchObject({
      id: "S1",
      status: "gap",
      gap: "The held copy's SHA-256 differs from its citation.",
    });
    const damaged = await run(args, env);
    expect(damaged.exitCode, damaged.stderr).toBe(0);
    const damagedAnswer = JSON.parse(damaged.stdout);
    expect(damagedAnswer.scope[0]).toMatchObject({
      id: "S1",
      status: "gap",
      sha256,
      gap: "The held copy's SHA-256 differs from its citation.",
    });
    expect(damagedAnswer.scope[0].text).toBeUndefined();
  });

  // Unavailable scope must leave code intact, and the scope text limit must leave citations intact.
  test("discloses unavailable scope and preserves citations outside a cycle", async () => {
    const { root, revision } = await fixtureRepository();
    const graph = await fakeGraph();
    const home = join(root, "home");
    await mkdir(home);
    await Bun.write(join(root, "working"), "See other.custom.\n");
    await Bun.write(join(root, "opaque"), new Uint8Array([0xff, 0x00]));
    await Bun.write(join(root, "large"), Buffer.alloc(262_145, 0x61));
    const env = {
      HOME: home,
      NEUVE_GRAPH_BINARY: graph.executable,
      NEUVE_TEST_PROCESS: "1",
    };
    const args = queryArgs(root, revision);
    const result = await run(
      [
        ...args.map((arg) => (arg === "4096" ? "8" : arg)),
        "--scope",
        "missing",
        "--scope",
        "source.custom",
        "--scope",
        "working",
        "--scope",
        "home",
        "--scope",
        "opaque",
        "--scope",
        "large",
      ],
      env,
    );
    expect(result.exitCode, result.stderr).toBe(0);
    const answer = JSON.parse(result.stdout);
    expect(answer.retrieval).toMatchObject({
      status: "ok",
      candidates: [{ symbol: "target" }, expect.any(Object)],
    });
    expect(answer.cycle_id).toBeUndefined();
    expect(answer.scope_gaps).toEqual([
      "missing: The path was absent from the working tree and the base revision.",
      expect.stringMatching(/^working: .*no Records store was found/),
      "home: The path is not a regular file.",
      "opaque: The file is not readable as text.",
      "large: The file exceeds 262144 bytes.",
    ]);
    expect(answer.scope).toEqual([
      expect.objectContaining({
        kind: "repository-document",
        ref: expect.objectContaining({ path: "source.custom", revision }),
        text_omitted: "max-context-bytes",
        sections: [expect.objectContaining({ startLine: 1, endLine: 5 })],
      }),
      expect.objectContaining({
        contextOnly: true,
        ref: expect.objectContaining({
          path: "other.custom",
          found: "named in working",
          revision,
        }),
        text_omitted: "max-context-bytes",
      }),
    ]);
    expect(answer.scope[0].text).toBeUndefined();
  });

  const scopeQueryFixture = async () => {
    const { root, revision } = await fixtureRepository();
    const graph = await fakeGraph();
    const scratch = await realpath(
      await mkdtemp(join(tmpdir(), "neuve-cli-scope-query-")),
    );
    roots.push(scratch);
    const env = {
      HOME: join(scratch, "home"),
      NEUVE_GRAPH_BINARY: graph.executable,
      NEUVE_TEST_PROCESS: "1",
    };
    await mkdir(env.HOME);
    await createRecords(root, env);
    const plan = join(scratch, "plan.md");
    await Bun.write(plan, "# Approved plan\n");
    await symlink(plan, join(root, "plan-link.md"));
    return {
      root,
      plan,
      query: (options: readonly string[], base = revision) =>
        run([...queryArgs(root, base), ...options], env),
    };
  };

  // A cycle with no pins or guide can silently ignore a file named on a later read.
  test("discloses late named scope in an empty cycle", async () => {
    const { root, plan, query } = await scopeQueryFixture();
    const first = await query([]);
    expect(first.exitCode, first.stderr).toBe(0);
    const [opening] = await queryHistory(root, "cycle.opened@2");

    const later = await query(["--scope", plan]);
    expect(later.exitCode, later.stderr).toBe(0);
    expect(JSON.parse(later.stdout)).toMatchObject({
      cycle_id: opening.event.attribution.cycleId,
      scope: [],
      scope_gaps: [
        `${plan}: Only the first query can add files to a review cycle's scope.`,
      ],
    });
  });

  // A later query can cache the wrong guide or report a lost blob as still fetched.
  test("builds scope from the opening guide and discloses a lost blob", async () => {
    const { root, query } = await scopeQueryFixture();
    const guide = join(root, "AGENTS.md");
    const text = "# Opening guide\n";
    await Bun.write(guide, text);
    expect(execute(["git", "add", "AGENTS.md"], root).exitCode).toBe(0);
    expect(execute(["git", "commit", "-qm", "Add guide"], root).exitCode).toBe(
      0,
    );
    const base = execute(["git", "rev-parse", "HEAD"], root).stdout.trim();
    const blob = execute(
      ["git", "rev-parse", "HEAD:AGENTS.md"],
      root,
    ).stdout.trim();
    const branch = execute(
      ["git", "branch", "--show-current"],
      root,
    ).stdout.trim();
    const { cycleId } = await executeRecords(
      withStore(
        root,
        "write",
        Cycles.openOrJoinCycle(
          { baseRef: base, baseOid: base, branch, branchTipOid: base },
          Identity.UNRESOLVED_ACTOR,
        ),
      ),
    );
    await Bun.write(guide, "# Current guide\n");
    expect(
      execute(["git", "commit", "-qam", "Edit guide"], root).exitCode,
    ).toBe(0);
    const head = execute(["git", "rev-parse", "HEAD"], root).stdout.trim();

    const result = await query([], head);
    expect(result.exitCode, result.stderr).toBe(0);
    const ref = { path: "AGENTS.md", blob, revision: base };
    expect(JSON.parse(result.stdout)).toMatchObject({
      cycle_id: cycleId,
      scope: [{ ref, text, contextOnly: true, stratum: "context only" }],
      scope_gaps: [],
    });

    await rm(join(root, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
    const missing = await query([], head);
    expect(missing.exitCode, missing.stderr).toBe(0);
    const gap = "The document's Git blob could not be read.";
    const answer = JSON.parse(missing.stdout);
    expect(answer).toMatchObject({
      cycle_id: cycleId,
      retrieval: { status: "ok" },
      scope: [{ ref, status: "gap", gap }],
      scope_gaps: [`AGENTS.md: ${gap}`],
    });
    expect(answer.scope[0].text).toBeUndefined();
  });

  // A failed scope copy must leave a plain gap and log the filesystem cause.
  test("logs the cause when a named scope copy cannot be written", async () => {
    const { root, plan, query } = await scopeQueryFixture();
    const location = storeLocationIn(join(root, ".git"));
    await Bun.write(join(location.directory, "scope"), "Blocks the folder");

    const result = await query(["--scope", plan]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      retrieval: { status: "ok" },
      scope_gaps: [
        `${plan}: The file was read but its copy could not be kept.`,
      ],
    });
    const [{ event }] = await queryHistory(root);
    expect(readRunLog(runLogPath(location, event.id))).toContainEqual(
      expect.objectContaining({
        type: "query.scope-write-failed",
        path: plan,
        cause: expect.stringContaining("ENOTDIR"),
      }),
    );
  });

  // A query that cannot read the branch tip must log Git's cause for leaving scope unheld.
  test("logs why a query with an unreadable branch tip could not hold scope", async () => {
    const { root, plan, query } = await scopeQueryFixture();
    expect(
      execute(["git", "symbolic-ref", "HEAD", "refs/heads/unborn"], root)
        .exitCode,
    ).toBe(0);

    const result = await query(["--scope", plan]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      retrieval: { status: "ok" },
      scope_gaps: [
        expect.stringContaining("the checked-out branch has no readable tip"),
      ],
    });
    const [{ event }] = await queryHistory(root);
    const location = storeLocationIn(join(root, ".git"));
    expect(readRunLog(runLogPath(location, event.id))).toContainEqual(
      expect.objectContaining({
        type: "query.branch-read-failed",
        cause: expect.stringContaining("refs/heads/unborn"),
      }),
    );
  });

  // A discovered Git link holds a path and cannot supply document text.
  test("cites a found committed symlink as a scope gap", async () => {
    const { root, query } = await scopeQueryFixture();
    await Bun.write(join(root, "AGENTS.md"), "[Policy](policy.md)\n");
    await Bun.write(join(root, "actual.md"), "# Policy\n");
    await symlink("actual.md", join(root, "policy.md"));
    expect(
      execute(["git", "add", "AGENTS.md", "actual.md", "policy.md"], root)
        .exitCode,
    ).toBe(0);
    expect(
      execute(["git", "commit", "--quiet", "-m", "add guide"], root).exitCode,
    ).toBe(0);
    const base = execute(["git", "rev-parse", "HEAD"], root).stdout.trim();

    const result = await query([], base);
    expect(result.exitCode, result.stderr).toBe(0);
    const answer = JSON.parse(result.stdout);
    expect(answer.scope[1]).toMatchObject({
      status: "gap",
      ref: {
        path: "policy.md",
        revision: base,
        found: "linked from AGENTS.md",
      },
      gap: "The Git path is a symbolic link.",
    });
    expect(answer.scope[1].text).toBeUndefined();
    expect(answer.scope_gaps).toEqual([
      "policy.md: The Git path is a symbolic link.",
    ]);
  });

  // The run log must retain the filesystem cause behind the public gap.
  test("logs the cause of a working-file read error", async () => {
    const { root, query } = await scopeQueryFixture();
    await symlink("loop", join(root, "loop"));

    const result = await query(["--scope", "loop"]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      retrieval: { status: "ok" },
      scope_gaps: ["loop: The file could not be read."],
    });
    const logs = join(root, ".git", "neuve", "run-logs");
    const [log] = await readdir(logs);
    const diagnostics = (await Bun.file(join(logs, log!)).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        type: "query.local-read-failed",
        path: "loop",
        cause: expect.stringContaining("ELOOP"),
      }),
    );
  });

  // A joining read must log the filesystem cause behind an unreadable held copy.
  test("logs the cause of a held-copy read error", async () => {
    const { root, plan, query } = await scopeQueryFixture();
    const first = await query(["--scope", plan]);
    expect(first.exitCode, first.stderr).toBe(0);
    const { cycle_id: cycleId } = JSON.parse(first.stdout);
    await rm(
      join(scopeFolder(storeLocationIn(join(root, ".git")), cycleId), "S1.txt"),
    );

    const joined = await query([]);
    expect(joined.exitCode, joined.stderr).toBe(0);
    const gap = `${plan}: The held copy could not be read.`;
    expect(JSON.parse(joined.stdout)).toMatchObject({
      cycle_id: cycleId,
      scope_gaps: [gap],
      scope: [{ status: "gap", gap: "The held copy could not be read." }],
    });
    const logs = join(root, ".git", "neuve", "run-logs");
    const entries = await Promise.all(
      (await readdir(logs)).map((file) => Bun.file(join(logs, file)).text()),
    );
    expect(
      entries.flatMap((log) =>
        log
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ),
    ).toContainEqual(
      expect.objectContaining({
        type: "query.scope-read-failed",
        gap,
        cause: expect.stringContaining("ENOENT"),
      }),
    );
  });

  // Scope parsing should explain gaps in the answer and keep decoder details in the run log.
  test("logs scope text and link decoding failures", async () => {
    const { root, query } = await scopeQueryFixture();
    const invalidUtf8 = new Uint8Array([0xff]);
    await Bun.write(join(root, "working.md"), invalidUtf8);
    await Bun.write(join(root, "committed.md"), invalidUtf8);
    await Bun.write(
      join(root, "AGENTS.md"),
      "[Document](committed.md) and [broken](100%.md)\n",
    );
    expect(
      execute(["git", "add", "AGENTS.md", "committed.md"], root).exitCode,
    ).toBe(0);
    expect(
      execute(["git", "commit", "--quiet", "-m", "add scope documents"], root)
        .exitCode,
    ).toBe(0);
    const base = execute(["git", "rev-parse", "HEAD"], root).stdout.trim();

    const result = await query(["--scope", "working.md"], base);
    expect(result.exitCode, result.stderr).toBe(0);
    const linkGap = 'AGENTS.md: A link could not be decoded ("100%.md").';
    const blobGap =
      "committed.md: The document's Git blob is not readable as text.";
    expect(JSON.parse(result.stdout).scope_gaps).toEqual([
      "working.md: The file is not readable as text.",
      linkGap,
      blobGap,
    ]);
    const logs = join(root, ".git", "neuve", "run-logs");
    const [log] = await readdir(logs);
    const records = (await Bun.file(join(logs, log!)).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "query.local-read-failed",
          path: "working.md",
          cause: expect.stringContaining("ERR_ENCODING_INVALID_ENCODED_DATA"),
        }),
        expect.objectContaining({
          type: "query.scope-read-failed",
          gap: linkGap,
          cause: expect.stringContaining("URIError"),
        }),
        expect.objectContaining({
          type: "query.scope-read-failed",
          gap: blobGap,
          cause: expect.stringContaining("ERR_ENCODING_INVALID_ENCODED_DATA"),
        }),
      ]),
    );
  });

  // The citation must name the file that supplied the bytes.
  test("cites the real path of a named symlink outside the repository", async () => {
    const { plan, query } = await scopeQueryFixture();
    const result = await query(["--scope", "plan-link.md"]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).scope[0]).toMatchObject({
      ref: { path: plan },
      text: "# Approved plan\n",
    });
  });

  // The citation must also identify the link the request named.
  test("cites the link used to reach a named document", async () => {
    const { query } = await scopeQueryFixture();
    const result = await query(["--scope", "plan-link.md"]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).scope[0]).toMatchObject({
      ref: { found: "named by the request through a link at plan-link.md" },
    });
  });

  // The cycle and answer keep both names in request order on one source.
  test.each([
    [
      "direct first",
      false,
      "named by the request and also named through a link at plan-link.md",
    ],
    [
      "link first",
      true,
      "named by the request through a link at plan-link.md and also named directly",
    ],
  ])(
    "keeps one ordered source when a file is named directly and through a link (%s)",
    async (_order, linkFirst, found) => {
      const { root, plan, query } = await scopeQueryFixture();
      const first = linkFirst ? "plan-link.md" : plan;
      const last = linkFirst ? plan : "plan-link.md";
      const result = await query([
        "--scope",
        first,
        "--scope",
        "other.custom",
        "--scope",
        last,
      ]);
      expect(result.exitCode, result.stderr).toBe(0);
      const answer = JSON.parse(result.stdout);
      expect(
        answer.scope.map(({ id, ref }: PublicQueryScopeSource) => [
          id,
          ref.path,
          ref.found,
        ]),
      ).toEqual([
        ["S1", plan, found],
        ["S2", "other.custom", "named by the request"],
      ]);
      const [selection] = await queryHistory(
        root,
        "cycle.local-scope-selected@1",
      );
      expect(selection.event.payload.sources[0].namedAs).toEqual([first, last]);
      expect(
        await readdir(
          join(
            scopeFolder(storeLocationIn(join(root, ".git")), answer.cycle_id),
          ),
        ),
      ).toEqual(["S1.txt"]);
    },
  );

  // A successful Graph read can hide that this build is too old to record the query.
  test("tells the person to update when Records refuses to record a query", async () => {
    const { root, query } = await scopeQueryFixture();
    const needs = WRITER_VERSION + 1;
    using db = new Database(storeLocationIn(join(root, ".git")).database);
    db.run(
      "UPDATE records_meta SET value = ? WHERE key = 'min_writer_version'",
      [needs],
    );

    const result = await query([]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toContain(
      `The installed neuve (writer ${WRITER_VERSION}) is older than this store (needs ${needs})`,
    );
    expect(result.stderr).toContain(
      `install a build with writer ${needs} or newer`,
    );
    expect(result.stderr).not.toContain("Run neuve query again.");
  });

  // An invalid Git email must leave schema details in the run log.
  test("returns a one-sentence scope gap when recording fails", async () => {
    const { root, revision } = await fixtureRepository();
    const graph = await fakeGraph();
    const home = join(root, "home");
    await mkdir(home);
    const env = {
      HOME: home,
      NEUVE_GRAPH_BINARY: graph.executable,
      NEUVE_TEST_PROCESS: "1",
      CLAUDE_CODE_SESSION_ID: "",
      CODEX_THREAD_ID: "",
    };
    await createRecords(root, env);
    expect(
      execute(["git", "config", "user.email", "invalid".repeat(128)], root)
        .exitCode,
    ).toBe(0);
    await Bun.write(join(root, "plan"), "# Scope\n");

    const result = await run(
      [...queryArgs(root, revision), "--scope", "plan"],
      env,
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      retrieval: { status: "ok" },
      scope_gaps: [
        expect.stringMatching(/^plan: .*the query could not be recorded/),
      ],
    });
    const logs = join(root, ".git", "neuve", "run-logs");
    const [log] = await readdir(logs);
    const logPath = join(logs, log!);
    expect(result.stderr).toBe(
      `neuve: The query was not recorded. See the run log at ${JSON.stringify(logPath)}.\n`,
    );
    expect(JSON.parse(await Bun.file(logPath).text())).toMatchObject({
      type: "query.record-failed",
      cause: expect.stringContaining("Invalid email address"),
    });
  });

  // A linked agent must own the cycle and the query even when Git names a human.
  test("attributes a query and its opening to the linked agent session", async () => {
    const { root, revision } = await fixtureRepository();
    await createRecords(root);
    const graph = await fakeGraph();
    const session = { harness: "claude-code", sessionId: "query-session" };
    const actor = Identity.agentFingerprint(session);
    const processRow = Ancestry.snapshotProcesses()?.get(process.pid);
    await executeRecords(
      withStore(
        root,
        "write",
        Sessions.writeSession(storeLocationIn(join(root, ".git")), {
          version: 1,
          ...session,
          actorId: actor,
          ...(processRow === undefined
            ? {}
            : { owner: Ancestry.identityOf(processRow) }),
        }),
      ),
    );
    const result = await run(queryArgs(root, revision), {
      NEUVE_GRAPH_BINARY: graph.executable,
      CLAUDE_CODE_SESSION_ID: session.sessionId,
      CODEX_THREAD_ID: "",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const openings = await queryHistory(root, "cycle.opened@2");
    expect(openings).toHaveLength(1);
    expect(openings[0].event.actor).toBe(actor);
    expect(await queryHistory(root)).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({
          actor,
          attribution: {
            cycleId: openings[0].event.attribution.cycleId,
            sessionId: session.sessionId,
          },
        }),
      }),
    ]);
    expect(await queryHistory(root, "actor.registered@1")).toEqual([]);
  });

  // Branches can share a base without sharing their review cycle or scope fetch.
  test("opens separate cycles for two branches at one base", async () => {
    const { root, revision } = await fixtureRepository();
    await createRecords(root);
    const graph = await fakeGraph();
    expect(execute(["git", "branch", "feature-a"], root).exitCode).toBe(0);
    expect(execute(["git", "switch", "-c", "feature-b"], root).exitCode).toBe(
      0,
    );
    expect(
      execute(
        ["git", "commit", "--allow-empty", "-m", "Advance feature-b"],
        root,
      ).exitCode,
    ).toBe(0);
    const featureBTip = execute(
      ["git", "rev-parse", "HEAD"],
      root,
    ).stdout.trim();
    expect(
      execute(["git", "switch", "--detach", revision], root).exitCode,
    ).toBe(0);
    for (const branch of ["feature-a", "feature-b"])
      expect(
        (
          await run([...queryArgs(root, revision), "--branch", branch], {
            NEUVE_GRAPH_BINARY: graph.executable,
          })
        ).exitCode,
      ).toBe(0);
    const openings = await queryHistory(root, "cycle.opened@2");
    expect(openings).toMatchObject([
      {
        event: {
          payload: {
            branch: "feature-a",
            baseOid: revision,
            branchTipOid: revision,
          },
        },
      },
      {
        event: {
          payload: {
            branch: "feature-b",
            baseOid: revision,
            branchTipOid: featureBTip,
          },
        },
      },
    ]);
    expect(openings[1].event.attribution.cycleId).not.toBe(
      openings[0].event.attribution.cycleId,
    );
    expect(scopeJobs(root)).toHaveLength(2);
  });

  // An explicit branch in another worktree must address the cycle in Git's common store.
  test("joins the named branch from a second worktree", async () => {
    const { root, revision } = await fixtureRepository();
    await createRecords(root);
    const graph = await fakeGraph();
    const env = { NEUVE_GRAPH_BINARY: graph.executable };
    const branch = execute(
      ["git", "branch", "--show-current"],
      root,
    ).stdout.trim();
    expect((await run(queryArgs(root, revision), env)).exitCode).toBe(0);
    const openings = await queryHistory(root, "cycle.opened@2");
    expect(openings).toHaveLength(1);
    expect(openings[0].event.payload.branchTipOid).toBe(revision);
    expect(
      execute(
        ["git", "commit", "--allow-empty", "-m", "Advance the branch"],
        root,
      ).exitCode,
    ).toBe(0);
    const worktree = join(root, "second");
    expect(
      execute(["git", "worktree", "add", "--detach", worktree, revision], root)
        .exitCode,
    ).toBe(0);
    const result = await run(
      [...queryArgs(worktree, revision), "--branch", branch],
      env,
    );
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    const history = await queryHistory(root);
    expect(history).toHaveLength(2);
    expect(history[1].event.attribution.cycleId).toBe(
      history[0].event.attribution.cycleId,
    );
    expect(await queryHistory(root, "cycle.opened@2")).toEqual(openings);
    expect(scopeJobs(root)).toHaveLength(1);
  });

  // A detached review can pick another task's scope unless it requires a branch.
  test("requires a branch holding the head when a detached review has open scope", async () => {
    const { root, revision } = await fixtureRepository();
    await markSetUp(root);
    await createRecords(root);
    const graph = await fakeGraph();
    const env = {
      HOME: join(root, "home"),
      ANTHROPIC_API_KEY: "",
      NEUVE_GRAPH_BINARY: graph.executable,
      NEUVE_TEST_PROCESS: "1",
    };
    await mkdir(env.HOME);
    expect(execute(["git", "branch", "unrelated"], root).exitCode).toBe(0);
    expect(
      execute(["git", "commit", "--allow-empty", "-qm", "Reviewed head"], root)
        .exitCode,
    ).toBe(0);
    const head = execute(["git", "rev-parse", "HEAD"], root).stdout.trim();
    for (const branch of ["feature", "followup"]) {
      expect(execute(["git", "branch", branch], root).exitCode).toBe(0);
      const read = await run(
        [...queryArgs(root, revision), "--branch", branch],
        env,
      );
      expect(read.exitCode, read.stderr).toBe(0);
    }
    const [feature] = await queryHistory(root, "cycle.opened@2");
    expect(
      execute(["git", "switch", "--detach", revision], root).exitCode,
    ).toBe(0);
    const args = [
      "review",
      `${revision}..${head}`,
      "--repo",
      root,
      "--detach",
      "--route",
      "anthropic",
    ];

    expect((await run(args, env)).exitCode).toBe(2);
    expect((await run([...args, "--branch", "unrelated"], env)).exitCode).toBe(
      2,
    );
    expect(await queryHistory(root, "review.requested@1")).toEqual([]);

    const review = await run([...args, "--branch", "feature"], env);
    expect(review.exitCode, review.stderr).toBe(0);
    expect(await queryHistory(root, "review.requested@1")).toMatchObject([
      {
        event: { attribution: { cycleId: feature.event.attribution.cycleId } },
      },
    ]);
  });

  // A query can silently keep using the previous scope while its review is queued.
  test("opens the next cycle after a review request", async () => {
    const { root, revision } = await fixtureRepository();
    await createRecords(root);
    const graph = await fakeGraph();
    const args = queryArgs(root, revision);
    const env = {
      NEUVE_GRAPH_BINARY: graph.executable,
      NEUVE_TEST_PROCESS: "1",
    };
    const before = await run(args, env);
    expect(before.exitCode, before.stderr).toBe(0);
    const [first] = await queryHistory(root, "cycle.opened@2");
    expect(
      execute(["git", "commit", "--allow-empty", "-qm", "Reviewed head"], root)
        .exitCode,
    ).toBe(0);
    const review = await executeRecords(
      withStore(root, "write", (location) =>
        requestReview({
          repository: root,
          location,
          range: `${revision}..HEAD`,
          requester: { _tag: "Unresolved" },
          frozenConfig: defaultConfig(),
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              JobQueue.layer,
              Computations.layer.pipe(
                Layer.provideMerge(Blobs.layer(location)),
              ),
            ),
          ),
        ),
      ),
    );
    expect(review.cycleId).toBe(first.event.attribution.cycleId);
    expect(await run(args, env)).toEqual(before);
    const openings = await queryHistory(root, "cycle.opened@2");
    expect(openings).toHaveLength(2);
    const next = openings[1].event.attribution.cycleId;
    expect(next).not.toBe(review.cycleId);
    expect(await queryHistory(root)).toMatchObject([
      { event: { attribution: { cycleId: review.cycleId } } },
      { event: { attribution: { cycleId: next } } },
    ]);
    expect(scopeJobs(root)).toHaveLength(2);
  });

  // Detached reads only need branch advice when they can record a cycle.
  test("warns once for detached HEAD without an explicit branch", async () => {
    const { root, revision } = await fixtureRepository();
    expect(
      execute(["git", "checkout", "--detach", revision], root).exitCode,
    ).toBe(0);
    const graph = await fakeGraph();
    const args = queryArgs(root, revision);
    const env = { NEUVE_GRAPH_BINARY: graph.executable };
    const without = await run(args, env);
    expect(without.stderr).toBe("");
    await createRecords(root);
    const result = await run(args, env);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(without.stdout);
    expect(JSON.parse(result.stdout).retrieval.status).toBe("ok");
    expect(result.stderr).toBe(
      "neuve: Query did not join a review cycle (HEAD is detached, so pass --branch <name>).\n",
    );
    const history = await queryHistory(root);
    expect(history).toHaveLength(1);
    expect(history[0].event.attribution).toBeUndefined();
    expect(await queryHistory(root, "cycle.opened@2")).toEqual([]);
  });

  // An invalid explicit branch must be refused before Graph or Records sees the request.
  test("rejects an unknown branch before invoking Graph", async () => {
    const { root, revision } = await fixtureRepository();
    await createRecords(root);
    const graph = await fakeGraph();
    expect(
      await run([...queryArgs(root, revision), "--branch", "missing"], {
        NEUVE_GRAPH_BINARY: graph.executable,
      }),
    ).toEqual({
      stdout: "",
      stderr: "neuve: --branch must name an existing local branch in --repo.\n",
      exitCode: 2,
    });
    expect(await Bun.file(graph.log).exists()).toBe(false);
    expect(await queryHistory(root)).toEqual([]);
  });

  // A cycle write can fail while the query and its run record both succeed.
  test("warns once when Records refuses the cycle opening", async () => {
    const { root, revision } = await fixtureRepository();
    await createRecords(root);
    {
      using db = new Database(join(root, ".git", "neuve", "records.sqlite"));
      db.exec(`CREATE TRIGGER reject_opening BEFORE INSERT ON events
        WHEN NEW.kind = 'cycle.opened@2'
        BEGIN SELECT RAISE(ABORT, 'cycle write refused'); END`);
    }
    const graph = await fakeGraph();
    const result = await run(queryArgs(root, revision), {
      NEUVE_GRAPH_BINARY: graph.executable,
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).retrieval.status).toBe("ok");
    expect(result.stderr).toMatch(
      /^neuve: Query did not join a review cycle \([^\n]+\)\.\n$/,
    );
    const history = await queryHistory(root);
    expect(history).toHaveLength(1);
    expect(history[0].event.attribution).toBeUndefined();
    expect(await queryHistory(root, "cycle.opened@2")).toEqual([]);
    expect(scopeJobs(root)).toEqual([]);
  });

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
      "--refresh-cache takes one occurrence, but was supplied more than once.",
    ],
    [
      ["--refresh-cache", "true"],
      "Unknown option. Run neuve query --help for accepted options.",
    ],
    [
      ["--refresh-cache=false"],
      "Unknown option '--refresh-cache'. Run neuve query --help for accepted options.",
    ],
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
      expect(result.stderr).toContain("selection must be exact or family");
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
      stdout: "neuve 0.2.1\n",
      stderr: "",
      exitCode: 0,
    });
  });

  // An arbitrary option name must not inject terminal control sequences into a refusal.
  test("only echoes unknown options with safe names", async () => {
    const help = "Run neuve auth --help for accepted options.";
    expect(await run(["auth", "list", "--not-an-option"])).toEqual({
      stdout: "",
      stderr: `neuve: Unknown option '--not-an-option'. ${help}\n`,
      exitCode: 2,
    });
    expect(await run(["auth", "list", "--bad\x1b[31m"])).toEqual({
      stdout: "",
      stderr: `neuve: Unknown option. ${help}\n`,
      exitCode: 2,
    });
  });

  // An unknown option can be a pasted credential. Its inline value has no place in the refusal.
  test("omits inline values from unknown setup and auth options", async () => {
    for (const command of ["setup", "auth"]) {
      expect(await run([command, "--token=sk-ant-SECRET123"])).toEqual({
        stdout: "",
        stderr: `neuve: Unknown option '--token'. Run neuve ${command} --help for accepted options.\n`,
        exitCode: 2,
      });
    }
  });

  // A bad kind must not hide a malformed range, and neither error requires a session.
  test("refuses malformed or missing proof ranges as usage errors", async () => {
    const { root } = await fixtureRepository();
    await createRecords(root);
    const flags = [
      "--claim",
      "claim",
      "--requirement",
      "requirement",
      "--text",
      "output",
      "--repo",
      root,
    ];
    const malformed = await run(
      ["proof", "record", "a b", "--kind", "bogus", ...flags],
      { NEUVE_SESSION: "" },
    );
    expect(malformed.exitCode).toBe(2);
    expect(malformed.stdout).toContain("kind: Invalid option");
    expect(malformed.stdout).toContain("range: Expected <base>..<head>");
    const missing = await run(
      ["proof", "record", "--kind", "test-run", ...flags],
      { NEUVE_SESSION: "" },
    );
    expect(missing.exitCode).toBe(2);
    expect(missing.stdout).toContain(
      "range: Invalid input: expected string, received undefined",
    );
  });

  // A plain shell can be outside capture even when the repository already has hooks installed.
  test("makes the hooks advice conditional for a plain shell", async () => {
    const { root } = await fixtureRepository();
    await createRecords(root);
    const home = join(root, "home");
    await mkdir(home);
    const hooks = join(root, "codex-hooks.json");
    const setup = await run(
      [
        "setup",
        "hooks",
        "--repo",
        root,
        "--agents",
        "codex",
        "--codex-hooks",
        hooks,
        "--no-stack",
      ],
      { HOME: home },
    );
    expect(setup.exitCode, setup.stderr).toBe(0);
    expect(await Bun.file(hooks).exists()).toBe(true);
    const ps = join(root, "ps");
    await Bun.write(
      ps,
      '#!/bin/sh\nprintf "%s 0 Mon Nov 23 18:00:00 2026 neuve\\n" "$PPID"\n',
    );
    await chmod(ps, 0o755);
    const env = {
      PATH: `${root}:${process.env.PATH ?? ""}`,
      NEUVE_SESSION: "",
    };
    const commands = [
      ["vent", "from a plain shell"],
      [
        "proof",
        "record",
        "HEAD..HEAD",
        "--kind",
        "test-run",
        "--claim",
        "claim",
        "--requirement",
        "requirement",
        "--text",
        "output",
      ],
    ];
    for (const args of commands) {
      expect(await run([...args, "--repo", root], env)).toEqual({
        stdout:
          "Not recorded: this call ran outside a captured agent session. If the agent hooks are not set up for this agent, ask the person to run neuve setup hooks.\n",
        stderr: "",
        exitCode: 1,
      });
    }
  });

  // Proof and vent must report independent problems without repeating pasted credentials.
  test("refuses invalid proof and vent inputs without a captured session", async () => {
    const { root } = await fixtureRepository();
    await createRecords(root);
    const proof = await run(
      [
        "proof",
        "record",
        "nosuch..HEAD",
        "--kind",
        "test-run",
        "--claim",
        "test output",
        "--requirement",
        "tests pass",
        "--revision",
        "sk-ant-SECRETREV",
        "--file",
        "sk-ant-SECRETPATH",
        "--repo",
        root,
      ],
      { NEUVE_SESSION: "" },
      root,
    );
    expect(proof.exitCode).toBe(1);
    expect(proof.stdout).toContain(
      "The range's base names no commit in this repository.",
    );
    expect(proof.stdout).toContain(
      "--revision takes a commit at the range's head or in its history. It names no commit in this repository.",
    );
    expect(proof.stdout).toContain(
      "--file is not a readable file. Use a readable file in the working tree or a temporary folder.",
    );
    expect(proof.stdout + proof.stderr).not.toMatch(
      /SECRETREV|SECRETPATH|nosuch/,
    );

    const vent = await run(
      ["vent", " ", "--reconciliation-id", "", "--repo", root],
      { NEUVE_SESSION: "" },
    );
    expect(vent.exitCode).toBe(1);
    expect(vent.stdout).toContain("Received blank text.");
    expect(vent.stdout).toContain(
      "--reconciliation-id takes the harness's review cycle ID of 1 to 256 characters. Received 0 characters.",
    );
    for (const output of [proof.stdout, vent.stdout]) {
      const hint = "ask the person to run neuve setup hooks";
      if (output.includes("the process table cannot be read here"))
        expect(output).not.toContain(hint);
      else {
        expect(output).toContain(
          "this call ran outside a captured agent session",
        );
        expect(output).toContain(hint);
      }
      expect(output).not.toContain("--session");
    }
  });

  // An absent store needs setup guidance without echoing the supplied repository path.
  test("review show reports a missing Records store", async () => {
    const { root } = await fixtureRepository();
    expect(await run(["review", "show", "--repo", root])).toEqual({
      stdout: "",
      stderr:
        "neuve: Neuve isn't set up in this repository. Run neuve setup there first.\n",
      exitCode: 2,
    });
  });

  // A queued review is a successful lookup. A fabricated ID must never look queued.
  test("review show distinguishes malformed, missing and queued runs", async () => {
    const { root, revision } = await fixtureRepository();
    await createRecords(root);
    const repo = ["--repo", root];
    const runId = "01M84WJ65YBV4WBF5Q2FM4S5JY";
    const command = ["review", "show", ...repo];
    expect(await run([...command, "--run", "nope"])).toEqual({
      exitCode: 2,
      stdout: "",
      stderr: "neuve: --run takes a run ID as neuve review printed it.\n",
    });
    expect((await run(command)).stdout).toContain(
      "when looking for the latest run.",
    );

    await markSetUp(root);
    const badRange = await run([
      "review",
      "nosuch..absent",
      "--detach",
      ...repo,
    ]);
    expect(badRange).toEqual({
      exitCode: 2,
      stdout: "",
      stderr:
        "neuve: The range's base names no commit in this repository.\nThe range's head names no commit in this repository.\n",
    });
    expect(await run(["review"])).toEqual({
      exitCode: 2,
      stdout: "",
      stderr: "neuve: neuve review needs a range: <base>..<head>\n",
    });

    expect(
      execute(["git", "commit", "--allow-empty", "-qm", "Reviewed head"], root)
        .exitCode,
    ).toBe(0);
    await executeRecords(
      withStore(root, "write", (location) =>
        requestReview({
          repository: root,
          location,
          range: `${revision}..HEAD`,
          requestId: runId,
          requester: { _tag: "Unresolved" },
          frozenConfig: defaultConfig(),
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              JobQueue.layer,
              Computations.layer.pipe(
                Layer.provideMerge(Blobs.layer(location)),
              ),
            ),
          ),
        ),
      ),
    );
    const queued = await run([...command, "--run", runId]);
    expect(queued.exitCode, queued.stderr).toBe(0);
    expect(queued.stdout).toContain(
      `Run ${runId} has no receipt in Records yet. Its run log so far:`,
    );
  });

  // A missing run can be requested by ID or range. Neither selector belongs in the refusal.
  test("review show names the lookup without printing its value", async () => {
    const { root } = await fixtureRepository();
    await createRecords(root);
    for (const [selector, lookup] of [
      [["--run", "01M83DRQ4J0004059GPYKHNS1P"], "with that --run ID"],
      [["HEAD..HEAD"], "for that range"],
    ] as const) {
      expect(
        await run(["review", "show", "--repo", root, ...selector]),
      ).toEqual({
        stdout: `No review run found in this repository ${lookup}. When the person asks for a review, request it with neuve review <base>..<head> --detach.\n`,
        stderr: "",
        exitCode: 1,
      });
    }
  });

  // A caller should be able to correct every invalid or missing option in one retry.
  test("rejects incomplete and malformed query options before provider discovery", async () => {
    expect(
      await run([
        "query",
        "--repo",
        "/tmp/example",
        "--max-results",
        "0",
        "--relationship-plan",
        "{}",
      ]),
    ).toEqual({
      stdout: "",
      stderr: [
        "neuve: --revision takes a hexadecimal Git object name. No value was supplied.",
        "--question takes non-empty text. No value was supplied.",
        "--max-results takes a positive integer.",
        "--relationship-plan takes a JSON array.",
        "",
      ].join("\n"),
      exitCode: 2,
    });
  });

  // An option that expects a number can still receive an arbitrary secret.
  test("query refuses a malformed limit without printing its value", async () => {
    expect(
      await run([
        "query",
        "--repo",
        "/tmp/example",
        "--revision",
        "abcdef0",
        "--question",
        "q",
        "--max-results",
        "my-private-password",
      ]),
    ).toEqual({
      stdout: "",
      stderr: "neuve: --max-results takes a positive integer.\n",
      exitCode: 2,
    });
  });

  // Both argument validation and execution must name the repository inferred from a subfolder.
  test("query names the inferred repository on either refusal path", async () => {
    const { root, revision } = await fixtureRepository();
    const subfolder = join(root, "sub");
    await mkdir(subfolder);
    const assumed = await realpath(root);
    for (const [args, message] of [
      [
        ["--revision", "private-revision"],
        "--revision takes a hexadecimal Git object name.",
      ],
      [
        ["--revision", revision, "--branch", "private-branch"],
        "--branch must name an existing local branch in --repo.",
      ],
    ] as const) {
      expect(
        await run(["query", "--question", "q", ...args], {}, subfolder),
      ).toEqual({
        stdout: "",
        stderr: `neuve: ${message}\n--repo was assumed to be ${JSON.stringify(assumed)}. Pass --repo to choose another repository.\n`,
        exitCode: 2,
      });
    }
  });

  // Validation must keep checking later fields and entries after a field fails.
  test("query reports all relationship plan problems without printing their values", async () => {
    const good = {
      request_id: "private-id",
      focus: { symbol: "target" },
      relation: "CALLS",
      selection: "family",
      direction: "out",
      depth: 1,
      limit: 5,
    };
    const result = await run(
      queryArgs("/tmp/example", "abcdef0", "q", [
        {
          ...good,
          selection: "private-selection",
          direction: "private-direction",
          limit: 0,
        },
        {
          ...good,
          focus: { symbol: "", line: -1 },
          selection: "other-private-selection",
          "private-key": "private-value",
        },
      ]),
    );
    expect(result).toEqual({
      stdout: "",
      stderr: [
        "neuve: --relationship-plan[0].selection must be exact or family.",
        "--relationship-plan[0].direction must be in or out.",
        "--relationship-plan[0].limit must be a positive integer.",
        "--relationship-plan[1] takes only these keys: request_id, focus, relation, selection, direction, depth, limit, summary.",
        "--relationship-plan[1].request_id must be unique.",
        "--relationship-plan[1].focus.symbol must be a non-empty string.",
        "--relationship-plan[1].focus.line must be a positive integer.",
        "--relationship-plan[1].focus.line requires focus.path.",
        "--relationship-plan[1].selection must be exact or family.",
        "",
      ].join("\n"),
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
      stderr: [
        "neuve: Unknown option '--target-file'. Run neuve query --help for accepted options.",
        "Unknown option '--target-symbol'. Run neuve query --help for accepted options.",
        "",
      ].join("\n"),
      exitCode: 2,
    });
  });

  // Unknown query options can contain credentials or unsafe characters in their names or values.
  test("does not echo values or unsafe names for unknown query options", async () => {
    expect(
      await run([
        ...queryArgs("/tmp/example", "abcdef0", "q", []),
        "--token",
        "sample-secret",
        "--header=inline-secret",
        "--bad\x1b[31m",
        "another-secret",
      ]),
    ).toEqual({
      stdout: "",
      stderr:
        "neuve: Unknown option '--token'. Run neuve query --help for accepted options.\nUnknown option '--header'. Run neuve query --help for accepted options.\nUnknown option. Run neuve query --help for accepted options.\n",
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
    expect(JSON.parse(result.stdout)).not.toHaveProperty("assumed_options");
    const commands = (await Bun.file(graph.log).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).command);
    expect(commands).toEqual(["version", "capabilities", "query"]);
  });

  // Defaults must be visible in both output formats without changing the stream's event order.
  test("queries the repository root from a subfolder with only revision and question", async () => {
    const { root, revision } = await fixtureRepository();
    const subfolder = join(root, "sub");
    await mkdir(subfolder);
    const graph = await fakeGraph();
    const env = {
      NEUVE_GRAPH_BINARY: graph.executable,
      FAKE_GRAPH_LOG: graph.log,
    };
    const args = [
      "query",
      "--revision",
      revision,
      "--question",
      "Where is target?",
    ];
    const assumed = {
      "--repo": root,
      "--relationship-plan": [],
      "--max-results": 8,
      "--max-context-bytes": 16000,
    };
    const json = await run(args, env, subfolder);
    expect(json.exitCode, json.stderr).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({
      source: { repository: root, revision },
      retrieval: { status: "ok" },
      structural_observations: [],
      assumed_options: assumed,
    });
    const stream = await run(
      [...args, "--stream", "--max-results", "5"],
      env,
      subfolder,
    );
    expect(stream.exitCode, stream.stderr).toBe(0);
    const events = stream.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.map((event) => event.kind)).toEqual([
      "retrieval",
      "complete",
    ]);
    expect(events[0].assumed_options).toEqual({
      "--repo": root,
      "--relationship-plan": [],
      "--max-context-bytes": 16000,
    });
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

  // An interrupt must keep the signal exit and record the retrieval already emitted.
  test("SIGTERM during a blocked relationship emits no completion and cleans up", async () => {
    const repository = await fixtureRepository();
    await createRecords(repository.root);
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
    expect(await queryHistory(repository.root)).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({
          payload: expect.objectContaining({
            revision: repository.revision,
            outcome: "interrupted",
            candidatesReturned: 2,
            relationships: 0,
          }),
        }),
      }),
    ]);
    expect(await queryHistory(repository.root, "cycle.opened@2")).toEqual([]);
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

  // A failure before the first Graph event must keep the original diagnostic and exit.
  test("does not fall back when the explicit graph binary is unavailable", async () => {
    const repository = await fixtureRepository();
    await createRecords(repository.root);
    const missing = join(repository.root, "missing-graph");
    const result = await run(
      queryArgs(repository.root, repository.revision.slice(0, 12)),
      { NEUVE_GRAPH_BINARY: missing },
    );
    expect(result).toEqual({
      stdout: "",
      stderr:
        "neuve: NEUVE_GRAPH_BINARY must name an executable Neuve Graph file.\n",
      exitCode: 2,
    });
    expect(await queryHistory(repository.root)).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({
          payload: expect.objectContaining({
            revision: repository.revision,
            outcome: "failed",
            candidatesReturned: 0,
            relationships: 0,
          }),
        }),
      }),
    ]);
    expect(await queryHistory(repository.root, "cycle.opened@2")).toEqual([]);
  });
});
