import { chmod, mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectGraph,
  type GraphInspectionRequest,
  type GraphOutcome,
} from "../src/index.ts";
export const roots: string[] = [];

export const removeRoots = async (): Promise<void> => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
};

export const run = (argv: readonly string[], cwd: string): string => {
  const process = Bun.spawnSync([...argv], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (process.exitCode !== 0) {
    throw new Error(process.stderr.toString() || process.stdout.toString());
  }
  return process.stdout.toString().trim();
};

export const waitForFile = async (path: string): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (!(await Bun.file(path).exists())) {
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for ${path}.`);
    await Bun.sleep(10);
  }
};

export const pathExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

export const gate = (): Readonly<{
  wait: Promise<void>;
  release: () => void;
}> => {
  let release = (): void => {};
  const wait = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  return { wait, release };
};

export const fixtureRepository = async (): Promise<{
  root: string;
  first: string;
  second: string;
}> => {
  const root = await mkdtemp(join(tmpdir(), "neuve-graph-client-test-repo-"));
  roots.push(root);
  run(["git", "init", "--quiet"], root);
  run(["git", "config", "user.name", "Graph Client Test"], root);
  run(["git", "config", "user.email", "graph-client@example.test"], root);
  await mkdir(join(root, "nested"), { recursive: true });
  await mkdir(join(root, "vendor"), { recursive: true });
  await Bun.write(
    join(root, "source.custom"),
    "alpha\nbeta\ngamma\ndelta\nepsilon\n",
  );
  await Bun.write(join(root, "other.custom"), "one\ntwo\nthree\nfour\n");
  await Bun.write(join(root, "extensionless"), "one\ntwo\n");
  await Bun.write(join(root, "nested/source.unusual"), "one\ntwo\nthree\n");
  await Bun.write(join(root, "colon:path.custom"), "one\ntwo\n");
  await Bun.write(join(root, ":leading.custom"), "one\ntwo\n");
  await Bun.write(join(root, "*.custom"), "one\ntwo\n");
  await Bun.write(join(root, " white\tpath "), "one\ntwo\n");
  await Bun.write(join(root, "vendor/api"), "one\ntwo\nthree\n");
  await symlink("source.custom", join(root, "linked.custom"));
  run(["git", "add", "."], root);
  run(["git", "commit", "--quiet", "-m", "first"], root);
  const first = run(["git", "rev-parse", "HEAD"], root);
  await Bun.write(
    join(root, "source.custom"),
    "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\n",
  );
  run(["git", "add", "source.custom"], root);
  run(["git", "commit", "--quiet", "-m", "second"], root);
  return { root, first, second: run(["git", "rev-parse", "HEAD"], root) };
};

export const fakeExecutable = async (mode: string): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "neuve-fake-graph-"));
  roots.push(root);
  const path = join(root, `fake-graph-${mode}`);
  await Bun.write(
    path,
    // Bun by its own path: the engine runs with graph-client's fixed PATH, which need not hold it.
    `#!${process.execPath}
import { basename } from "node:path";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const mode = basename(import.meta.path).replace("fake-graph-", "");
const prepared = mode.startsWith("prepared-") && process.argv.includes("--prepared-only");
const controlRoot = ${JSON.stringify(root)};
const containedMode = mode.startsWith("contained-callables");
const indexedFiles = { "indexed-files-zero": 0, "indexed-files-selective": 384, "indexed-files-max": 9007199254740991, "indexed-files-null": null, "indexed-files-string": "384", "indexed-files-negative": -1, "indexed-files-fraction": 1.5, "indexed-files-unsafe": 9007199254740992 }[mode];
const command = process.argv[2];
const args = process.argv.slice(3);
const value = (flag) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
const repo = value("--repo") ?? "";
const git = (...parts) => Bun.spawnSync(["git", "-C", repo, ...parts]).stdout.toString().trim();
const revision = repo === "" ? "" : git("rev-parse", value("--commit") ?? "HEAD");
const tree = repo === "" ? "" : git("rev-parse", revision + "^{tree}");
const preparedReceipt = { artifact_family: mode.includes("syntax-generation") ? "syntax-generation" : "search-snapshot", ...(mode.includes("syntax-generation") ? { generation_id:"b".repeat(64) } : {}), policy_id:"a".repeat(64), producer_build_id:createHash("sha256").update(readFileSync(import.meta.path)).digest("hex"), source:{common_dir: repo === "" ? "" : git("rev-parse","--path-format=absolute","--git-common-dir"),scope:repo === "" ? "" : git("rev-parse","--show-prefix").slice(0,-1)}, external_policy_origin:"serving-directory-captured",gitignore_origin:"target-commit" };
if(mode === "prepared-foreign-producer") preparedReceipt.producer_build_id="f".repeat(64);
if(mode === "prepared-foreign-owner") preparedReceipt.source.common_dir+="-foreign";
if(mode === "prepared-foreign-scope") preparedReceipt.source.scope="foreign";
if(mode === "prepared-invalid-policy") preparedReceipt.policy_id="invalid";
if(mode === "prepared-invented-generation") preparedReceipt.generation_id="b".repeat(64);
if(mode === "prepared-false-origin") preparedReceipt.external_policy_origin="target-commit";
if((mode === "prepared-policy-drift" || mode === "prepared-syntax-generation-policy-drift") && command === "neighbors") preparedReceipt.policy_id="c".repeat(64);
const receiptFields = prepared && mode !== "prepared-receipt-missing" ? { prepared_read:preparedReceipt } : {};
if (mode.endsWith("-environment") && ["query", "search", "neighbors"].includes(command)) appendFileSync(controlRoot + "/environments", JSON.stringify({ command, environment: Object.fromEntries(Object.entries(process.env).filter(([name]) => !["PWD", "OLDPWD", "SHLVL", "_"].includes(name))) }) + "\\n");
const storeUsage = { bytes: 3221225472, cap_bytes: 4294967296, min_free_bytes: 10737418240, free_bytes: mode.endsWith("-free-unknown") ? -1 : 53687091200, declared_bytes: 1048576, pinned_bytes: 0, families: { "search-snapshot": 2147483648, executables: 114488248 }, evicted_bytes: mode.endsWith("-malformed") ? -2 : 0, evicted_entries: 0, measured_at: "2026-10-24T00:00:00Z" };
const parallelMode = mode.startsWith("parallel-");
const wait = async (name) => { while (!(await Bun.file(controlRoot + "/" + name).exists())) await Bun.sleep(10); };
if (parallelMode && (command === "query" || command === "neighbors")) {
  appendFileSync(controlRoot + "/starts", JSON.stringify({ command, symbol: value("--symbol"), pid: process.pid }) + "\\n");
  writeFileSync(controlRoot + "/" + command + "-started", String(process.pid));
  process.on("exit", () => { writeFileSync(controlRoot + "/" + command + "-finished", "done"); if (command === "neighbors") writeFileSync(controlRoot + "/neighbors-" + value("--symbol") + "-finished", "done"); });
  if (mode === "parallel-handshake" || mode === "parallel-malformed-query" || mode === "parallel-malformed-neighbor") await wait(command === "query" ? "neighbors-started" : "query-started");
  if ((mode === "parallel-hold-query" || mode === "parallel-block-both") && command === "query") await wait("query-release");
  if ((mode === "parallel-hold-neighbor" || mode === "parallel-block-both") && command === "neighbors") await wait("neighbors-release");
}
const stableCalls = parallelMode && (command === "query" || command === "neighbors") ? readFileSync(controlRoot + "/starts", "utf8").split("\\n").filter((line) => line.includes('"symbol":"caller-id"')).length : 0;
const diagnostic = { code: "W_FIXTURE", severity: "warning", file_path: "source.custom", language: "FixtureLanguage", effect_on_semantic_completeness: "fixture warning", detail: "preserved" };
const declared = mode === "language-neutral" ? ["FixtureLanguageA", "FixtureLanguageB"] : ["FixtureLanguage"];
if (command === "version") {
  console.log(JSON.stringify(mode === "malformed-version" ? {} : { identity_revision: "2", provider: mode === "wrong-version-provider" ? "other-graph" : "entire-graph", version: "fixture", ...(mode === "bad-build-identity" ? { build_identity: "a".repeat(64) } : mode === "malformed-build-identity" ? { build_identity: 42 } : mode === "reported-build-identity" ? { build_identity: createHash("sha256").update(readFileSync(import.meta.path)).digest("hex") } : {}) }));
} else if (command === "capabilities") {
  console.log(JSON.stringify(mode === "malformed-capabilities" ? { schema_version: "2.0", provider: "entire-graph" } : {
    schema_version: "1.3", provider: mode === "wrong-capabilities-provider" ? "other-graph" : "entire-graph", supported_file_extensions: [".custom"], supported_languages: declared, semantic_languages: declared, inventory_only_languages: [], parser_versions: { fixture: "1" }, supported_relation_types: mode.startsWith("prepared-") ? ["CALLS", "CONSTRUCTS", "DEFINES", "CONTAINS"] : ["CALLS", "CONSTRUCTS"], ...(mode === "legacy-selection" ? {} : { relation_selection_modes: mode === "selection-mode-invalid" ? ["exact", "guess"] : ["exact", "family"], relation_families: { CALLS: mode === "selection-family-duplicate" ? ["CALLS", "CALLS"] : mode === "selection-family-unsupported" ? ["CALLS", "MADE_UP"] : ["CALLS", "CONSTRUCTS"], CONSTRUCTS: ["CONSTRUCTS"], ...(mode.startsWith("prepared-") ? {DEFINES:["DEFINES"],CONTAINS:["CONTAINS"]} : {}) } }), relation_support_by_language: Object.fromEntries(declared.map((language) => [language, mode === "unsupported-constructs" ? ["CALLS"] : mode.startsWith("prepared-") ? ["CALLS", "CONSTRUCTS", "DEFINES", "CONTAINS"] : ["CALLS", "CONSTRUCTS"]])), relation_support_by_profile: { ...(mode.startsWith("prepared-") ? {"syntax-only":["DEFINES","CONTAINS"]} : {}), full: mode === "selection-profile-missing" ? ["CALLS"] : ["CALLS", "CONSTRUCTS"] }, heuristic_relation_types: [], unsupported_but_detected_language_hints: [], optional_local_only_features: { focused_neighbors: true, ...(mode.startsWith("prepared-") && mode !== "prepared-unsupported" ? { prepared_snapshot_query: true, ...(mode === "prepared-no-exact-capability" ? {} : { exact_commit_prepared_read:true }) } : {}), ...(mode === "frontier-unsupported" ? {} : { neighbor_frontier_summary: true }) }, features_requiring_network_access: { telemetry_upload: false }
  }));
} else if (command === "index") {
  // The service's block, last, as Graph writes it: one the service ran in its preparation lane, one
  // run in this process with the setting on (no queue, snapshots left out at zero), or a malformed one.
  const preparationService = mode.includes("service-answered") ? { answered: true, rss_bytes: 314572800, max_rss_bytes: 314572800, cpu_user_ms: 1500, cpu_system_ms: 250, queue_wait_ms: 7, cache_bytes: 3221225472, cache_cap_bytes: 4294967296, lane: "prepare", class: "background" } : mode.includes("service-own") ? { answered: false, reason: "busy", rss_bytes: 52428800, max_rss_bytes: 104857600, cpu_user_ms: 900, cpu_system_ms: 100, queue_wait_ms: 0, cache_bytes: 3221225472, cache_cap_bytes: 4294967296, lane: "prepare" } : mode.includes("service-malformed") ? { answered: true, lane: "prepare", cpu_user_ms: -1 } : undefined;
  if (preparationService !== undefined) writeFileSync(controlRoot + "/index-call", JSON.stringify({ engine: import.meta.path, class: process.env.ENTIRE_GRAPH_CLASS ?? null, deadline: process.env.ENTIRE_GRAPH_DEADLINE_MS ?? null }));
  if (mode === "refresh-blocked") { writeFileSync(controlRoot + "/index-started", "started"); await wait("index-release"); }
  if (mode === "refresh-command-failure") process.exit(23);
  if (mode === "refresh-malformed") console.log("not-json");
  else console.log(JSON.stringify({ format_version: 1, provider: mode === "refresh-wrong-provider" ? "foreign" : "entire-graph", provider_version: mode === "refresh-wrong-version" ? "foreign" : "fixture", repo_root: mode === "refresh-wrong-root" ? repo + "-wrong" : repo, commit: mode === "refresh-wrong-revision" ? "f".repeat(40) : revision, tree: mode === "refresh-wrong-tree" ? "e".repeat(40) : tree, profile: mode === "refresh-wrong-profile" ? "fast" : "full", ...(mode === "refresh-unreported" ? {} : { index_cache_hit: mode === "refresh-hit" }), index_latency_ms: 5, ...(mode.startsWith("refresh-store") ? { cache: storeUsage } : {}), ...(preparationService === undefined ? {} : { service: preparationService }) }));
} else if (command === "cache" && args[0] === "declare") {
  writeFileSync(controlRoot + "/declare-args", JSON.stringify(args));
  writeFileSync(controlRoot + "/declare-class", process.env.ENTIRE_GRAPH_CLASS ?? "");
  const commits = args.flatMap((arg, at) => (arg === "--commit" ? [args[at + 1]] : []));
  console.log(JSON.stringify({ format_version: 1, action: "declare", declared: { commits: mode === "declare-other" ? ["d".repeat(40)] : commits, trees: commits.map(() => "e".repeat(40)) }, cache: storeUsage }));
} else if (command === "query" && mode === "prepared-service-deadline") {
  writeFileSync(controlRoot + "/deadline-env", JSON.stringify({ class: process.env.ENTIRE_GRAPH_CLASS ?? null, deadline: process.env.ENTIRE_GRAPH_DEADLINE_MS ?? null }));
  if (process.env.ENTIRE_GRAPH_DEADLINE_MS !== undefined) { await Bun.sleep(Math.min(Number(process.env.ENTIRE_GRAPH_DEADLINE_MS), 5000)); console.error("entire-graph: deadline passed while waiting for the Graph service"); process.exit(75); }
  process.exit(3);
} else if (command === "query") {
  if (mode.startsWith("orphan-child")) { if (mode === "orphan-child-stubborn") process.on("SIGTERM", () => {}); const child = Bun.spawn(mode === "orphan-child-ignoring" ? ["/bin/sh", "-c", 'trap "" TERM; exec sleep 60'] : ["sleep", "60"]); writeFileSync(controlRoot + "/child-pid", String(child.pid)); writeFileSync(controlRoot + "/engine-pid", String(process.pid)); await wait("never"); }
  if (mode === "prepared-missing") { console.error("prepared snapshot unavailable: missing"); process.exit(1); }
  if (mode === "prepared-hostile-error") { console.error("prepared snapshot unavailable: missing HOSTILE_PRIVATE_VALUE"); process.exit(1); }
  if (mode === "hostile-streams") {
    console.log("HOSTILE_STDOUT_RECEIPT");
    console.error("HOSTILE_STDERR_RECEIPT");
    process.exit(23);
  } else if (mode === "malformed-query" || mode === "prepared-syntax-generation-bad-query" || mode === "parallel-malformed-query") console.log("not-json");
  else {
    const baseContained = { symbol_id: mode === "contained-callables-empty-id" ? "" : "opaque:id:one", symbol_name: "nested", qualified_name: "nested", kind: "function", language: "FixtureLanguage", start_line: 2, end_line: 3 };
    const containedItems = mode === "contained-callables-duplicate-id" ? [baseContained, { ...baseContained, start_line: 4, end_line: 5 }] : mode === "contained-callables-out-of-order" ? [{ ...baseContained, symbol_id: "opaque:id:two", start_line: 4, end_line: 5 }, baseContained] : [baseContained];
    let results = [{ language: "FixtureLanguage", file_path: "source.custom", symbol_name: "caller", kind: "function", qualified_name: "caller", start_line: 1, end_line: 5 }];
    if (mode === "language-neutral") results = [
      { language: "FixtureLanguageA", file_path: "extensionless", start_line: 1, end_line: 2 },
      { language: "FixtureLanguageB", file_path: "nested/source.unusual", symbol_name: "caller", kind: "function", qualified_name: "caller", start_line: 2, end_line: 3 }
    ];
    if (mode === "omitted-language") results = [{ file_path: "extensionless", start_line: 1, end_line: 2 }];
    if (mode === "partial-symbol-rank-6") results = [
      { language: "FixtureLanguage", file_path: "source.custom", symbol_name: "caller", kind: "function", qualified_name: "caller", start_line: 1, end_line: 5 },
      { language: "FixtureLanguage", file_path: "other.custom", start_line: 1, end_line: 2 },
      { language: "FixtureLanguage", file_path: "extensionless", symbol_name: "extension", kind: "function", qualified_name: "extension", start_line: 1, end_line: 2 },
      { language: "FixtureLanguage", file_path: "nested/source.unusual", symbol_name: "nested", kind: "function", qualified_name: "nested", start_line: 1, end_line: 3 },
      { language: "FixtureLanguage", file_path: "vendor/api", symbol_name: "api", kind: "function", qualified_name: "api", start_line: 1, end_line: 3 },
      { file_path: "source.custom", kind: "function", qualified_name: "grepTermPaths", start_line: 1, end_line: 5 }
    ];
    if (containedMode) results = [{
      symbol_id: mode === "contained-callables-top-level-id" ? "opaque:id:one" : "opaque:owner", language: "FixtureLanguage", file_path: "source.custom", symbol_name: "caller", kind: "function", qualified_name: "caller",
      start_line: 1, end_line: 5, snippet_start_line: 1, snippet_end_line: 5,
      contained_callables: containedItems
    }];
    if (mode === "undeclared-language") results = [{ language: "OtherLanguage", file_path: "extensionless", start_line: 1, end_line: 2 }];
    if (mode === "colon-path") results = [{ language: "FixtureLanguage", file_path: "colon:path.custom", start_line: 1, end_line: 2 }];
    if (mode === "leading-colon-path") results = [{ language: "FixtureLanguage", file_path: ":leading.custom", start_line: 1, end_line: 2 }];
    if (mode === "magic-glob-path") results = [{ language: "FixtureLanguage", file_path: "*.custom", start_line: 1, end_line: 2 }];
    if (mode === "whitespace-path") results = [{ language: "FixtureLanguage", file_path: " white\\tpath ", start_line: 1, end_line: 2 }];
    if (mode === "query-nonexistent") results = [{ language: "FixtureLanguage", file_path: "missing.custom", start_line: 1, end_line: 1 }];
    if (mode === "query-tree") results = [{ language: "FixtureLanguage", file_path: "nested", start_line: 1, end_line: 1 }];
    if (mode === "query-symlink") results = [{ language: "FixtureLanguage", file_path: "linked.custom", start_line: 1, end_line: 1 }];
    if (mode === "query-out-of-range") results = [{ language: "FixtureLanguage", file_path: "extensionless", start_line: 1, end_line: 4 }];
    if (mode === "query-end-past-eof") results = [{ language: "FixtureLanguage", file_path: "source.custom", symbol_name: "caller", kind: "function", qualified_name: "caller", start_line: 1, end_line: 5 }, { language: "FixtureLanguage", file_path: "extensionless", start_line: 1, end_line: 3 }];
    if (mode === "parallel-invalid-query-source") results[0].end_line = 99;
    results = results.map((result, index) => ({ rank: index + 1, ...result }));
    if (mode === "query-noncontiguous-rank") results[0].rank = 2;
    const containedDropped = mode === "contained-callables-truncated" || mode === "contained-callables-ledger-duplicate" || mode === "contained-callables-ledger-mismatch" ? 2 : mode === "contained-callables-ledger-zero" || mode === "contained-callables-ledger-out-of-range" ? 1 : 0;
    const containedLedger = mode === "contained-callables-ledger-duplicate" ? [{ rank: 1, dropped: 1 }, { rank: 1, dropped: 1 }] : mode === "contained-callables-ledger-zero" ? [{ rank: 1, dropped: 0 }] : mode === "contained-callables-ledger-mismatch" ? [{ rank: 1, dropped: 1 }] : mode === "contained-callables-ledger-out-of-range" ? [{ rank: 2, dropped: 1 }] : mode === "contained-callables-truncated" ? [{ rank: 1, dropped: 2 }] : [];
    console.log(JSON.stringify({
      format_version: 1, query: value("--query"), repo_root: mode === "wrong-repository" ? repo + "-wrong" : repo,
      commit: mode === "wrong-revision" ? "f".repeat(40) : revision, tree: mode === "wrong-tree" ? "e".repeat(40) : tree, profile: mode === "prepared-profile-forged" ? "full" : value("--profile"), ...receiptFields, results,
      warnings: (mode === "diagnostics" || mode === "prepared-syntax-generation-diagnostics") ? [diagnostic] : [], partial_failures: (mode === "diagnostics" || mode === "prepared-syntax-generation-diagnostics") ? [{ ...diagnostic, code: "E_FIXTURE", severity: "error" }] : [],
      completeness: { health: { status: (mode === "diagnostics" || mode === "prepared-syntax-generation-diagnostics") ? "degraded" : "ok" } },
      stats: { ...(mode.startsWith("service-stats") ? { service: { answered: process.env.ENTIRE_GRAPH_SERVICE === "auto", ...(process.env.ENTIRE_GRAPH_SERVICE === "auto" ? {} : { reason: "off" }), rss_bytes: 104857600, max_rss_bytes: 209715200, snapshots_held: 2, snapshots_limit: 4, cache_bytes: mode === "service-stats-cache-malformed" ? 1.5 : 3221225472, cache_cap_bytes: 4294967296, ...(process.env.ENTIRE_GRAPH_CLASS === undefined ? {} : { class: process.env.ENTIRE_GRAPH_CLASS }), kept_answer: mode === "service-stats-kept-malformed" ? "yes" : true, moved_up: mode === "service-stats-moved-malformed" ? 1 : true, cpu_shared: mode === "service-stats-shared-malformed" ? "yes" : true, snapshot_hit: true, cpu_user_ms: 812.5, cpu_system_ms: 90, queue_wait_ms: mode === "service-stats-queue-malformed" ? -3 : 12, ...(mode === "service-stats-answered-malformed" ? { answered: "yes" } : {}) } } : {}), ...(mode.startsWith("search-stats") ? { preselect_latency_ms: 41, query_latency_ms: 9, total_latency_ms: 52, preselection_backend: "text-index", preselection_fallback_reason: "no-trigram", preselection_passes: 2, preselection_files_examined: 300, files_content_read_during_preselection: 12, preselection_patterns: 4, preselection_blobs_read: 300, preselection_bytes_read: mode === "search-stats-bytes-malformed" ? -1 : 65536, answer_cache_hits: 3, answer_cache_misses: 1, answer_cache_waits: 0, text_index_lookups: 6, text_index_candidates: mode === "search-stats-candidates-malformed" ? "many" : 18, ...(mode === "search-stats-backend-malformed" ? { preselection_backend: "" } : {}) } : {}), ...(prepared ? { index_cache_hit: true, ...(mode === "prepared-query-unconfirmed" ? {} : { analysis_scope: "complete-prepared" }) } : {}), ...(mode.startsWith("indexed-files-") ? { files_indexed: indexedFiles } : {}), ...(mode.startsWith("cache-") ? { index_cache_hit: mode === "cache-query-malformed" ? "yes" : mode === "cache-hit", index_latency_ms: mode === "cache-latency-malformed" ? -1 : 7 } : {}), context_budget_bytes: Number(value("--max-context-bytes")), result_bytes: 123, query_constraints_truncated: mode === "budget-loss", results_dropped_by_budget: mode === "budget-loss" ? 9 : 0, snippets_truncated_by_budget: mode === "budget-loss" ? 4 : 0,
        ...(containedMode ? {
          contained_callables_status: containedDropped > 0 ? "truncated" : "complete",
          contained_callables_emitted: containedItems.length,
          contained_callables_dropped_by_budget: containedDropped,
          ...(containedLedger.length > 0 ? { contained_callables_dropped_by_result: containedLedger } : {})
        } : {}) }
    }));
  }
} else if (command === "neighbors") {
  if (mode.startsWith("blocked-neighbor")) {
    await Bun.write(controlRoot + "/neighbor-started", String(process.pid));
    while (!(await Bun.file(controlRoot + "/neighbor-release").exists())) await Bun.sleep(10);
  }
  if (mode === "malformed-neighbor" || mode === "prepared-syntax-generation-bad-neighbor" || mode === "blocked-neighbor-fail" || mode === "parallel-malformed-neighbor") console.log(JSON.stringify({ format_version: 1 }));
  else if (mode === "parallel-command-failure") { console.error("NEIGHBOR_FAILURE"); process.exit(23); }
  else if (mode === "frontier-command-failure" && value("--summary") === "frontier") { console.error("FRONTIER_FAILURE"); process.exit(23); }
  else {
    const requestedSymbol = value("--symbol");
    const relation = mode === "wrong-relation" ? "CONSTRUCTS" : value("--relation");
    const direction = mode === "wrong-direction" ? "in" : value("--direction");
    const firstRequest = requestedSymbol === "caller";
    const echoedQuery = mode === "wrong-first-query" && firstRequest ? "other" : mode === "wrong-stable-query" && !firstRequest ? "other-id" : requestedSymbol;
    const echoedFile = mode === "wrong-first-file" && firstRequest ? "other.custom" : value("--file");
    const requestedLine = value("--line");
    const echoedLine = mode === "wrong-first-line" && firstRequest ? Number(requestedLine) + 1 : requestedLine === undefined ? undefined : Number(requestedLine);
    const endpoint = (() => {
      if (mode === "external-absent") return { id: "external-id", name: "externalCall", external: true };
      if (mode === "external-path") return { id: "external-id", name: "externalCall", file_path: "vendor/api", external: true };
      if (mode === "external-point") return { id: "external-id", name: "externalCall", file_path: "vendor/api", start_line: 2, external: true };
      if (mode === "external-range") return { id: "external-id", name: "externalCall", file_path: "vendor/api", start_line: 2, end_line: 3, external: true };
      if (mode === "endpoint-nonexistent") return { id: "callee-id", name: "callee", qualified_name: "callee", kind: "function", file_path: "missing.custom", language: "FixtureLanguage", start_line: 1, end_line: 1 };
      if (mode === "endpoint-out-of-range") return { id: "callee-id", name: "callee", qualified_name: "callee", kind: "function", file_path: "other.custom", language: "FixtureLanguage", start_line: 9, end_line: 9 };
      if (mode === "parallel-invalid-neighbor-source") return { id: "callee-id", name: "callee", qualified_name: "callee", kind: "function", file_path: "source.custom", language: "FixtureLanguage", start_line: 9, end_line: 9 };
      if (mode === "parallel-invalid-first-source" && stableCalls === 1) return { id: "callee-id", name: "callee", qualified_name: "callee", kind: "function", file_path: "source.custom", language: "FixtureLanguage", start_line: 9, end_line: 9 };
      return { id: "callee-id", name: "callee", qualified_name: "callee", kind: "function", file_path: "other.custom", language: "FixtureLanguage", start_line: 2, end_line: 3 };
    })();
    const makeMatch = (id, name) => {
      const evidence = mode === "missing-evidence" ? [] : [{ kind: "call_site", file_path: mode === "evidence-nonexistent" ? "missing.custom" : "source.custom", start_line: mode === "evidence-out-of-range" ? 9 : 2, end_line: mode === "evidence-out-of-range" ? 9 : 2 }];
      const stableRequest = requestedSymbol === "caller-id";
      const incoming = stableRequest && direction === "in" ? [{ relation: "CALLS", direction: "in", endpoint, confidence: 0.75, resolution: "exact", reason: "fixture", evidence, warning_codes: ["W_EDGE"], evidence_dropped: 2 }] : [];
      const outgoing = stableRequest && direction === "out" ? [{ relation: mode === "constructs-only" ? "CONSTRUCTS" : value("--profile") === "syntax-only" ? relation : "CALLS", direction: "out", endpoint, confidence: 0.75, resolution: mode === "selection-name-only" ? "name_only" : "exact", reason: "fixture", evidence, warning_codes: ["W_EDGE"], evidence_dropped: 2 }] : [];
      if (requestedSymbol === "caller-id" && (mode === "mixed-relations" || mode === "unsupported-constructs" || mode === "selection-edge-outside")) outgoing.push({ relation: "CONSTRUCTS", direction: "out", endpoint, confidence: 0.7, resolution: "exact", reason: "fixture construct", evidence, warning_codes: [], evidence_dropped: 0 });
      if (mode === "frontier-duplicate-records" && stableRequest && direction === "out" && outgoing[0] !== undefined) outgoing.push({ ...outgoing[0], reason: "second fixture record" });
      return { symbol: { id, name, qualified_name: name, kind: "function", file_path: "source.custom", language: "FixtureLanguage", start_line: 1, end_line: 5 }, incoming, outgoing };
    };
    const matches = mode === "ambiguous" && requestedSymbol === "caller" ? [makeMatch("caller-id", "caller"), makeMatch("caller-2", "caller")] : [makeMatch("caller-id", "caller")];
    const selectedRelations = value("--selection") === "exact" || value("--profile") === "syntax-only" ? [relation] : ["CALLS", "CONSTRUCTS"];
    const directEdges = matches.flatMap((match) => direction === "in" ? match.incoming : match.outgoing);
    const retainedIds = [...new Set(directEdges.map((edge) => edge.endpoint.id))].sort();
    const frontier = retainedIds.map((endpointId) => endpoint.external
      ? { kind: "unavailable", endpoint_id: endpointId, reason: "external_endpoint" }
      : { kind: "indexed", endpoint_id: endpointId, counts: [{ relation: value("--profile") === "syntax-only" ? relation : "CALLS", resolution: "exact", edges: 2 }], external_edges: mode === "frontier-negative-degree" ? -1 : 0, missing_endpoint_edges: 0, returns_to_focus: 0, self_edges: 0 });
    if (mode === "frontier-unknown-endpoint" && frontier[0] !== undefined) frontier[0].endpoint_id = "unknown-id";
    const summary = value("--summary") !== "frontier" ? undefined : {
      mode: "frontier", kind: "observed",
      selection: mode === "frontier-wrong-selection" ? (value("--selection") === "exact" ? "family" : "exact") : value("--selection"),
      selected_relations: selectedRelations,
      direction: mode === "frontier-wrong-direction" ? (direction === "in" ? "out" : "in") : direction,
      depth: 1, indexed_coverage: mode === "frontier-wrong-coverage" ? "partial" : "ok",
      direct: {
        eligible_edges: mode === "frontier-negative-count" ? -1 : mode === "frontier-bad-arithmetic" || mode === "frontier-unreported-omission" ? directEdges.length + 1 : directEdges.length,
        emitted_edges: directEdges.length, omitted_edges: mode === "frontier-unreported-omission" ? 1 : 0, missing_endpoint_edges: 0
      },
      frontier
    };
    console.log(JSON.stringify({
      ...(prepared ? { index_cache_hit: true, ...(mode === "prepared-neighbor-unconfirmed" ? {} : { analysis_scope: "complete-prepared" }) } : {}),
      ...(mode.startsWith("cache-") ? { index_cache_hit: mode === "cache-neighbor-malformed" ? null : requestedSymbol === "caller-id", index_latency_ms: 3 } : {}),
      format_version: 1, repo_root: mode === "neighbor-wrong-repository" ? repo + "-wrong" : repo,
      commit: mode === "neighbor-wrong-revision" ? "f".repeat(40) : revision, tree: mode === "neighbor-wrong-tree" || (mode === "frontier-stale-view" && value("--summary") === "frontier") ? "e".repeat(40) : tree,
      profile: value("--profile"), ...receiptFields, selection: mode === "selection-forged-mode" ? "family" : value("--selection"), selected_relations: mode === "selection-forged-set" ? ["CONSTRUCTS"] : mode === "selection-duplicate-set" ? ["CALLS", "CALLS"] : selectedRelations, relation, direction, query: echoedQuery, ...(echoedFile === undefined ? {} : { file: echoedFile }), ...(echoedLine === undefined ? {} : { line: echoedLine }),
      ...(mode.startsWith("service-stats") ? { stats: { service: { answered: process.env.ENTIRE_GRAPH_SERVICE === "auto", ...(process.env.ENTIRE_GRAPH_SERVICE === "auto" ? {} : { reason: "off" }), snapshots_held: 1, snapshot_hit: true, cpu_user_ms: 40, cpu_system_ms: 5, queue_wait_ms: 0 } } } : {}),
      truncated: mode === "relationship-diagnostics", focus_matches_truncated: false,
      disambiguation_required: mode === "ambiguous" || mode === "one-match-disambiguation", matches,
      warnings: mode === "relationship-diagnostics" ? [diagnostic] : [], partial_failures: mode === "relationship-diagnostics" ? [{ ...diagnostic, code: "E_FIXTURE", severity: "error" }] : [],
      completeness: { health: { status: "ok" } },
      ...(summary === undefined ? {} : { summary })
    }));
  }
} else process.exit(64);
`,
  );
  await chmod(path, 0o755);
  return path;
};

export const request = (
  executable: string,
  repository: string,
  revision: string,
  relationships = true,
): GraphInspectionRequest => ({
  executable,
  repository,
  revision,
  question: "  preserve this question exactly?  ",
  limits: { topK: 8, maxContextBytes: 16_384 },
  relationships: relationships
    ? [
        {
          id: "caller-calls-callee",
          focus: {
            name: "caller",
            path: "source.custom",
            symbolKind: "function",
            qualifiedName: "caller",
          },
          relation: "CALLS",
          selection: "family",
          direction: "out",
          depth: 1,
          limit: 50,
        },
      ]
    : [],
});

export const requestWithRelationship = (
  executable: string,
  repository: string,
  revision: string,
  change: Readonly<{
    selection?: "exact" | "family";
    direction?: "in" | "out";
    focus?: Readonly<{ line?: number }>;
    summary?: "frontier";
  }>,
): GraphInspectionRequest => {
  const base = request(executable, repository, revision);
  const relationship = base.relationships[0];
  if (relationship === undefined)
    throw new Error("fixture relationship missing");
  return {
    ...base,
    relationships: [
      {
        ...relationship,
        ...(change.selection === undefined
          ? {}
          : { selection: change.selection }),
        ...(change.direction === undefined
          ? {}
          : { direction: change.direction }),
        ...(change.summary === undefined ? {} : { summary: change.summary }),
        ...(change.focus === undefined
          ? {}
          : relationship.focus.path === undefined
            ? {}
            : {
                focus: {
                  ...relationship.focus,
                  ...(change.focus.line === undefined
                    ? {}
                    : { line: change.focus.line }),
                },
              }),
      },
    ],
  };
};

export const success = <Value>(
  outcome: GraphOutcome<Value> | Readonly<{ kind: "unavailable" }>,
): Value => {
  if (outcome.kind === "unavailable")
    throw new Error("unavailable relationship");
  if (outcome.kind === "error") throw new Error(outcome.error.message);
  return outcome.value;
};

export const relationship = (
  inspection: Awaited<ReturnType<typeof inspectGraph>>,
) =>
  success(
    inspection.relationships[0]?.outcome ?? {
      kind: "error",
      error: { message: "missing relationship" },
    },
  );
