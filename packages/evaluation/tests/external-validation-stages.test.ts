import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  parseExternalValidationCase,
  type ExternalValidationCase,
} from "../src/external-validation-case.ts";
import {
  normalizeExternalValidationReport,
  type CommandEvidence,
} from "../src/external-validation-report.ts";
import { createExternalValidationStageRunner } from "../src/external-validation-stages.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const runSync = (argv: readonly string[], cwd: string): string => {
  const process = Bun.spawnSync([...argv], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (process.exitCode !== 0) throw new Error(process.stderr.toString());
  return process.stdout.toString().trim();
};

const run = async (
  argv: readonly string[],
  cwd: string,
  environment?: Readonly<Record<string, string>>,
): Promise<CommandEvidence> => {
  const child = Bun.spawn([...argv], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    ...(environment === undefined
      ? {}
      : { env: { ...process.env, ...environment } }),
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return {
    argv,
    cwd,
    ...(environment === undefined ? {} : { environment }),
    stdout,
    stderr,
    exit_code: exitCode,
  };
};

const fixture = async (mode: string) => {
  const root = await mkdtemp(join(tmpdir(), "neuve-evaluation-stage-"));
  roots.push(root);
  runSync(["git", "init", "--quiet"], root);
  runSync(["git", "config", "user.name", "Evaluation Test"], root);
  runSync(["git", "config", "user.email", "evaluation@example.test"], root);
  await Bun.write(join(root, "source.custom"), "one\ntwo\nthree\nfour\n");
  await Bun.write(join(root, "other.custom"), "one\ntwo\nthree\n");
  runSync(["git", "add", "."], root);
  runSync(["git", "commit", "--quiet", "-m", "fixture"], root);
  const revision = runSync(["git", "rev-parse", "HEAD"], root);
  const executable = join(root, `graph-${mode}`);
  await Bun.write(
    executable,
    // Bun by its own path: the engine runs with graph-client's fixed PATH, which need not hold it.
    `#!${process.execPath}
import { basename } from "node:path";
const mode = basename(import.meta.path).replace("graph-", "");
const command = process.argv[2];
const args = process.argv.slice(3);
const value = (flag) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
const repo = value("--repo") ?? "";
const git = (spec) => Bun.spawnSync(["git", "-C", repo, "rev-parse", spec]).stdout.toString().trim();
const revision = repo === "" ? "" : git("HEAD");
const tree = repo === "" ? "" : git("HEAD^{tree}");
if (command === "version") console.log(JSON.stringify({ provider: "entire-graph", version: "fixture", identity_revision: "1" }));
else if (command === "capabilities") console.log(JSON.stringify({ schema_version: "1.3", provider: "entire-graph", supported_file_extensions: [".custom"], supported_languages: ["FixtureLanguage"], semantic_languages: mode.startsWith("unsupported-") ? [] : ["FixtureLanguage"], inventory_only_languages: mode.startsWith("unsupported-") ? ["FixtureLanguage"] : [], parser_versions: { fixture: "1" }, supported_relation_types: ["CALLS"], relation_selection_modes: ["exact", "family"], relation_families: { CALLS: ["CALLS"] }, relation_support_by_language: { FixtureLanguage: mode.startsWith("unsupported-") ? [] : ["CALLS"] }, relation_support_by_profile: { full: ["CALLS"] }, heuristic_relation_types: [], unsupported_but_detected_language_hints: [], optional_local_only_features: {}, features_requiring_network_access: {} }));
else if (command === "query") {
  if (mode === "query-exit") { console.error("fixture query failed"); process.exit(71); }
  else if (mode === "malformed-query") console.log("not-json");
  else {
    const contained = mode === "contained-retrieval" || mode.startsWith("contained-truncated");
    const truncated = mode.startsWith("contained-truncated");
    const containedName = mode === "contained-truncated-absent" ? "other" : "caller";
    const results = mode === "budget-loss" ? [] : [{ rank: 1, ...(mode === "omitted-language" ? {} : { language: "FixtureLanguage" }), file_path: "source.custom", ...(contained ? { symbol_name: "outer", kind: "function", qualified_name: "outer", snippet_start_line: 1, snippet_end_line: 4, contained_callables: [{ symbol_id: "opaque:" + containedName, symbol_name: containedName, kind: "function", qualified_name: containedName, language: "FixtureLanguage", start_line: 2, end_line: 3 }] } : mode === "partial-symbol" ? { kind: "function", qualified_name: "caller" } : { symbol_name: "caller", kind: "function", qualified_name: "caller" }), start_line: 1, end_line: 4 }];
    console.log(JSON.stringify({ format_version: 1, query: value("--query"), repo_root: repo, commit: revision, tree, profile: "full", results, warnings: [], partial_failures: [], completeness: { health: { status: "ok" } }, stats: { context_budget_bytes: 16384, result_bytes: 10, query_constraints_truncated: mode === "budget-loss", results_dropped_by_budget: mode === "budget-loss" ? 3 : 0, snippets_truncated_by_budget: 0, ...(contained ? { contained_callables_status: truncated ? "truncated" : "complete", contained_callables_emitted: 1, contained_callables_dropped_by_budget: truncated ? 1 : 0, ...(truncated ? { contained_callables_dropped_by_result: [{ rank: 1, dropped: 1 }] } : {}) } : {}) } }));
  }
} else if (command === "neighbors") {
  if (mode === "malformed-neighbor" || (mode === "malformed-neighbor-observation" && value("--file") === undefined)) console.log("not-json");
  else {
    const symbol = value("--symbol");
    const relation = mode === "constructs-only" ? "CONSTRUCTS" : "CALLS";
    const evidence = mode.startsWith("missing-evidence") ? [] : [{ kind: "call_site", file_path: "source.custom", start_line: 2, end_line: 2 }];
    const edge = { relation, direction: "out", endpoint: { id: "callee-id", name: "callee", qualified_name: "callee", kind: "function", file_path: mode === "shared-source" ? "source.custom" : "other.custom", language: "FixtureLanguage", start_line: 3, end_line: mode === "shared-source" ? 4 : 3 }, confidence: 0.9, resolution: mode.startsWith("weak-resolution") ? "name_only" : "exact", evidence, warning_codes: [], evidence_dropped: mode.startsWith("dropped-evidence") ? 1 : 0 };
    const outgoing = symbol !== "caller-id" || mode === "absent-edge" || (mode.endsWith("-absent") && !mode.startsWith("missing-evidence") && !mode.startsWith("weak-resolution")) ? [] : mode === "mixed-relations" ? [edge, { ...edge, relation: "CONSTRUCTS" }] : [edge];
    const diagnostic = { code: "W_FIXTURE_LOSS", severity: "warning", effect_on_semantic_completeness: "A repository file could not be analyzed." };
    const matches = mode.endsWith("missing-focus") ? [] : [{ symbol: { id: "caller-id", name: "caller", qualified_name: "caller", kind: "function", file_path: "source.custom", language: "FixtureLanguage", start_line: 1, end_line: 4 }, incoming: [], outgoing }];
    console.log(JSON.stringify({ format_version: 1, repo_root: repo, commit: revision, tree, profile: "full", selection: value("--selection"), selected_relations: ["CALLS"], relation: "CALLS", direction: "out", query: symbol, ...(value("--file") === undefined ? {} : { file: value("--file") }), ...(value("--line") === undefined ? {} : { line: Number(value("--line")) }), truncated: mode.startsWith("truncated-"), focus_matches_truncated: false, disambiguation_required: false, matches, warnings: mode.startsWith("warning-") ? [diagnostic] : [], partial_failures: mode.startsWith("partial-") ? [diagnostic] : [] }));
  }
} else process.exit(64);
`,
  );
  await chmod(executable, 0o755);
  const publicExecutable = join(root, "neuve-cli");
  await Bun.write(
    publicExecutable,
    `#!/usr/bin/env bun
const child = Bun.spawn(["bun", ${JSON.stringify(resolve(import.meta.dir, "../../../apps/neuve-cli/src/cli.ts"))}, ...process.argv.slice(2)], { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: process.env });
process.exit(await child.exited);
`,
  );
  await chmod(publicExecutable, 0o755);
  const validationCase: ExternalValidationCase = {
    id: "fixture",
    language: "FixtureLanguage",
    positiveRevision: revision,
    parentRevision: revision,
    target: {
      path: "source.custom",
      symbol: "caller",
      selector: {
        kind: "qualified",
        symbolKind: "function",
        qualifiedName: "caller",
      },
    },
    authoritativeQuestion: "How does caller invoke callee?",
    sensitivityParaphrase: "Where does caller use callee?",
    requiredRetrieval: [
      {
        kind: "symbol",
        role: "caller",
        endpoint: {
          path: "source.custom",
          symbol: "caller",
          selector: {
            kind: "qualified",
            symbolKind: "function",
            qualifiedName: "caller",
          },
        },
      },
    ],
    requiredRelationships: [
      {
        id: "caller-calls-callee",
        relation: "CALLS",
        resolution: { kind: "one", value: "exact" },
        from: {
          path: "source.custom",
          symbol: "caller",
          selector: {
            kind: "qualified",
            symbolKind: "function",
            qualifiedName: "caller",
          },
        },
        to: {
          path: "other.custom",
          symbol: "callee",
          selector: {
            kind: "qualified",
            symbolKind: "function",
            qualifiedName: "callee",
          },
        },
      },
    ],
    behavioralObligations: [],
    revisionControls: [],
  };
  return { root, revision, executable, publicExecutable, validationCase };
};

const status = (value: Readonly<Record<string, unknown>>): unknown =>
  value.status;

const evidenceStages = (
  ...values: readonly Readonly<Record<string, unknown>>[]
): readonly unknown[] =>
  values.flatMap(({ evidence }) => {
    if (!Array.isArray(evidence))
      throw new Error("stage evidence must be an array");
    return evidence.map((item) => {
      if (typeof item !== "object" || item === null || !("stage" in item)) {
        return undefined;
      }
      return item.stage;
    });
  });

const evidence = (
  value: Readonly<Record<string, unknown>>,
): readonly Readonly<Record<string, unknown>>[] => {
  if (!Array.isArray(value.evidence))
    throw new Error("stage evidence must be an array");
  return value.evidence.map((item) => {
    if (typeof item !== "object" || item === null)
      throw new Error("stage evidence item must be an object");
    return item;
  });
};

const expectedPublic = async (input: Awaited<ReturnType<typeof fixture>>) => {
  const result = await createExternalValidationStageRunner(
    run,
    input.root,
  ).runGraph({
    binary: input.executable,
    repository: input.root,
    revision: input.revision,
    validationCase: input.validationCase,
    question: input.validationCase.authoritativeQuestion,
    queryExpectations: { present: ["caller"], absent: [] },
    relationshipExpectations: {
      present: ["caller-calls-callee"],
      absent: [],
    },
    includePublicInspection: true,
  });
  if (
    result.publicInspection === undefined ||
    result.publicCommandTrace === undefined
  ) {
    throw new Error("independent inspection failed");
  }
  return {
    expectedInspection: result.publicInspection,
    expectedCommandTrace: result.publicCommandTrace,
  };
};

describe("combined external graph stage", () => {
  test("the native observer records a nonzero provider exit without changing section outcomes", async () => {
    const input = await fixture("query-exit");
    const result = await createExternalValidationStageRunner(
      run,
      input.root,
    ).runPublicQuery({
      binary: input.publicExecutable,
      engineBinary: input.executable,
      repository: input.root,
      revision: input.revision,
      validationCase: input.validationCase,
      ...(await expectedPublic(input)),
    });
    expect(result).toMatchObject({
      status: "passed",
      envelope: { valid: true, observation: { retrieval_status: "error" } },
      invocation: {
        usable: true,
        checks: { exact_exit_codes: true, exact_command_trace: true },
        invocations: expect.arrayContaining([
          expect.objectContaining({
            argv: expect.arrayContaining(["query"]),
            exit_code: 71,
          }),
        ]),
      },
    });
  });

  test("missing observer receipts cannot borrow validity from an unchanged public response", async () => {
    const input = await fixture("valid");
    await Bun.write(
      input.publicExecutable,
      `#!/usr/bin/env bun
const child = Bun.spawn(["bun", ${JSON.stringify(resolve(import.meta.dir, "../../../apps/neuve-cli/src/cli.ts"))}, ...process.argv.slice(2)], { env: { ...process.env, BUN_OPTIONS: "" }, stdout: "inherit", stderr: "inherit" });
process.exit(await child.exited);
`,
    );
    const result = await createExternalValidationStageRunner(
      run,
      input.root,
    ).runPublicQuery({
      binary: input.publicExecutable,
      engineBinary: input.executable,
      repository: input.root,
      revision: input.revision,
      validationCase: input.validationCase,
      ...(await expectedPublic(input)),
    });
    expect(result).toMatchObject({
      status: "failed",
      envelope: {
        valid: true,
        observation: { checks: { response_provenance: true } },
      },
      invocation: {
        usable: false,
        checks: {
          invoked: false,
          exact_query: false,
          exact_command_trace: false,
          no_extra_commands: false,
        },
        invocations: [],
      },
    });
  });

  test("records the v2 public boundary without reinterpreting section outcomes", async () => {
    const input = await fixture("valid");
    let temporaryPath = "";
    const result = await createExternalValidationStageRunner(
      run,
      input.root,
    ).runPublicQuery({
      binary: input.publicExecutable,
      engineBinary: input.executable,
      repository: input.root,
      revision: input.revision,
      validationCase: input.validationCase,
      ...(await expectedPublic(input)),
      registerTemporaryPath: (path) => {
        temporaryPath = path;
      },
    });
    expect(result).toMatchObject({
      status: "passed",
      envelope: {
        valid: true,
        observation: {
          checks: {
            schema_version: true,
            provider: true,
            provider_capabilities: true,
            question_unchanged: true,
            repository: true,
            revision: true,
            structural_request: true,
            response_provenance: true,
          },
          retrieval_status: "ok",
          structural_outcomes: [
            { request_id: "caller-calls-callee", status: "ok" },
          ],
        },
      },
      invocation: {
        usable: true,
        checks: {
          invoked: true,
          exact_executable: true,
          exact_exit_codes: true,
          exact_version: true,
          exact_capabilities: true,
          exact_query: true,
          exact_focus_resolution: true,
          exact_focus_observation: true,
          exact_command_trace: true,
          no_extra_commands: true,
          revision_bound_view: true,
        },
      },
      evidence: [
        {
          environment: { NEUVE_GRAPH_BINARY: expect.any(String) },
        },
      ],
    });
    expect(temporaryPath).not.toBe("");
    expect(await Bun.file(temporaryPath).exists()).toBe(false);
  });

  test("an explicit empty public relationship plan records no neighbor calls", async () => {
    const fixtureInput = await fixture("valid");
    const emptyRelationshipCase = parseExternalValidationCase({
      schema_version: 1,
      case_id: "fixture-retrieval-only",
      status: "candidate",
      language: "FixtureLanguage",
      target: {
        positive_revision: fixtureInput.revision,
        parent_revision: "a".repeat(40),
        file: "source.custom",
        symbol: "caller",
      },
      questions: {
        authoritative: fixtureInput.validationCase.authoritativeQuestion,
        sensitivity_paraphrase:
          fixtureInput.validationCase.sensitivityParaphrase,
      },
      required_retrieval: [
        {
          role: "caller",
          path: "source.custom",
          lines: { start: 1, end: 4 },
        },
      ],
      required_relationships: [],
      behavioral_obligations: ["Retrieval remains useful without traversal."],
      revision_controls: [
        {
          id: "parent",
          revision: "a".repeat(40),
          source_assertions: [
            {
              id: "source",
              kind: "file",
              path: "source.custom",
              expected: "present",
            },
          ],
          retrieval: { present: ["caller"], absent: [] },
          relationships: { present: [], absent: [] },
        },
      ],
    });
    const input = {
      ...fixtureInput,
      validationCase: emptyRelationshipCase,
    };
    const result = await createExternalValidationStageRunner(
      run,
      input.root,
    ).runPublicQuery({
      binary: input.publicExecutable,
      engineBinary: input.executable,
      repository: input.root,
      revision: input.revision,
      validationCase: input.validationCase,
      ...(await expectedPublic(input)),
    });
    expect(result).toMatchObject({
      status: "passed",
      envelope: {
        valid: true,
        observation: {
          checks: {
            structural_request: true,
            response_provenance: true,
          },
          structural_outcomes: [],
        },
      },
      invocation: {
        usable: true,
        checks: {
          exact_command_trace: true,
          no_extra_commands: true,
        },
      },
    });
    expect(
      (result.invocation as { invocations: readonly unknown[] }).invocations,
    ).toHaveLength(3);
  });

  test.each([
    ["malformed-neighbor", 4],
    ["malformed-neighbor-observation", 5],
  ] as const)(
    "matches the independent relationship-error trace for %s with %i commands",
    async (mode, expectedCalls) => {
      const input = await fixture(mode);
      const result = await createExternalValidationStageRunner(
        run,
        input.root,
      ).runPublicQuery({
        binary: input.publicExecutable,
        engineBinary: input.executable,
        repository: input.root,
        revision: input.revision,
        validationCase: input.validationCase,
        ...(await expectedPublic(input)),
      });
      expect(result).toMatchObject({
        status: "passed",
        envelope: {
          valid: true,
          observation: {
            checks: { response_provenance: true },
            structural_outcomes: [
              { request_id: "caller-calls-callee", status: "error" },
            ],
          },
        },
        invocation: {
          usable: true,
          checks: {
            exact_exit_codes: true,
            exact_focus_resolution: true,
            exact_focus_observation: true,
            exact_command_trace: true,
            no_extra_commands: true,
          },
        },
      });
      expect(
        (result.invocation as { invocations: readonly unknown[] }).invocations,
      ).toHaveLength(expectedCalls);
    },
  );

  test("an arbitrary fifth neighbor cannot pass a four-command relationship error", async () => {
    const input = await fixture("malformed-neighbor");
    await Bun.write(
      input.publicExecutable,
      `#!/usr/bin/env bun
const args = process.argv.slice(2);
const value = (flag) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
const result = Bun.spawnSync(["bun", ${JSON.stringify(resolve(import.meta.dir, "../../../apps/neuve-cli/src/cli.ts"))}, ...args], { env: process.env, stdout: "pipe", stderr: "pipe" });
if (result.exitCode !== 0) process.exit(result.exitCode);
Bun.spawnSync([process.env.NEUVE_GRAPH_BINARY, "neighbors", "--repo", value("--repo"), "--head", "--profile", "full", "--format", "json", "--no-cache", "--symbol", "arbitrary-focus", "--relation", "CALLS", "--direction", "out", "--depth", "1", "--limit", "8"], { env: process.env, stdout: "pipe", stderr: "pipe" });
process.stdout.write(result.stdout);
`,
    );
    await chmod(input.publicExecutable, 0o755);
    const result = await createExternalValidationStageRunner(
      run,
      input.root,
    ).runPublicQuery({
      binary: input.publicExecutable,
      engineBinary: input.executable,
      repository: input.root,
      revision: input.revision,
      validationCase: input.validationCase,
      ...(await expectedPublic(input)),
    });
    expect(result).toMatchObject({
      status: "failed",
      envelope: {
        valid: true,
        observation: { checks: { response_provenance: true } },
      },
      invocation: {
        usable: false,
        checks: {
          exact_focus_resolution: true,
          exact_focus_observation: false,
          exact_command_trace: false,
          no_extra_commands: false,
        },
      },
    });
  });

  // A wrapper engine: graph-client gives the engine one fixed environment, without the inherited
  // BUN_OPTIONS that loaded the evaluator's observer into the wrapper, so the observer no longer
  // follows the wrapper into its own spawn of the engine. Every exact check of the wrapped calls
  // fails and the wrapper still cannot pass. Real evaluations spawn the Go engine directly.
  test("an arbitrary fifth neighbor cannot pass a five-command relationship error", async () => {
    const input = await fixture("malformed-neighbor-observation");
    await Bun.write(
      input.publicExecutable,
      `#!/usr/bin/env bun
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const root = mkdtempSync(join(tmpdir(), "neuve-arbitrary-focus-"));
const shim = join(root, "graph-shim");
const target = process.env.NEUVE_GRAPH_BINARY;
writeFileSync(shim, \`#!\${process.execPath}
const argv = process.argv.slice(2);
if (argv[0] === "neighbors" && !argv.includes("--file")) argv[argv.indexOf("--symbol") + 1] = "arbitrary-focus";
const child = Bun.spawn([\${JSON.stringify(target)}, ...argv], { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: process.env });
process.exit(await child.exited);
\`);
chmodSync(shim, 0o755);
const child = Bun.spawn(["bun", ${JSON.stringify(resolve(import.meta.dir, "../../../apps/neuve-cli/src/cli.ts"))}, ...process.argv.slice(2)], { env: { ...process.env, NEUVE_GRAPH_BINARY: shim }, stdout: "inherit", stderr: "inherit" });
const exitCode = await child.exited;
rmSync(root, { recursive: true, force: true });
process.exit(exitCode);
`,
    );
    await chmod(input.publicExecutable, 0o755);
    const result = await createExternalValidationStageRunner(
      run,
      input.root,
    ).runPublicQuery({
      binary: input.publicExecutable,
      engineBinary: input.executable,
      repository: input.root,
      revision: input.revision,
      validationCase: input.validationCase,
      ...(await expectedPublic(input)),
    });
    expect(result).toMatchObject({
      status: "failed",
      envelope: {
        valid: true,
        observation: { checks: { response_provenance: true } },
      },
      invocation: {
        usable: false,
        checks: {
          exact_focus_resolution: false,
          exact_focus_observation: false,
          exact_command_trace: false,
          no_extra_commands: false,
        },
      },
    });
  });

  test("a public CLI that never invokes the supplied Graph executable cannot pass", async () => {
    const input = await fixture("valid");
    await Bun.write(
      input.publicExecutable,
      `#!/usr/bin/env bun
const args = process.argv.slice(2);
const value = (flag) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
console.log(JSON.stringify({ schema_version: 2, provider: { name: "entire-graph", version: "fixture", identity_revision: "2", capabilities: { schema_version: "1.3", file_extensions: [], languages: { supported: [], semantic: [], inventory_only: [], unsupported_detected_hints: [] }, relations: { supported: [], by_language: {}, by_profile: {}, heuristic: [], selection_modes: [], families: {} }, parser_versions: {}, optional_local_features: {}, features_requiring_network: {} } }, query: value("--question"), source: { repository: value("--repo"), revision: value("--revision") }, retrieval: { status: "error", error: "fabricated" }, structural_observations: [{ request_id: "caller-calls-callee", status: "error", error: "fabricated" }] }));
`,
    );
    await chmod(input.publicExecutable, 0o755);
    const result = await createExternalValidationStageRunner(
      run,
      input.root,
    ).runPublicQuery({
      binary: input.publicExecutable,
      engineBinary: input.executable,
      repository: input.root,
      revision: input.revision,
      validationCase: input.validationCase,
      ...(await expectedPublic(input)),
    });
    expect(result).toMatchObject({
      status: "failed",
      envelope: {
        valid: false,
        observation: { checks: { response_provenance: false } },
      },
      invocation: {
        usable: false,
        checks: { invoked: false, exact_query: false },
      },
    });
  });

  test("exact Graph calls with discarded responses and a fabricated envelope cannot pass", async () => {
    const input = await fixture("valid");
    await Bun.write(
      input.publicExecutable,
      `#!/usr/bin/env bun
const result = Bun.spawnSync(["bun", ${JSON.stringify(resolve(import.meta.dir, "../../../apps/neuve-cli/src/cli.ts"))}, ...process.argv.slice(2)], { env: process.env, stdout: "pipe", stderr: "pipe" });
if (result.exitCode !== 0) process.exit(result.exitCode);
const fabricated = JSON.parse(result.stdout.toString());
fabricated.provider.version = "fabricated-after-discard";
console.log(JSON.stringify(fabricated));
`,
    );
    await chmod(input.publicExecutable, 0o755);
    const result = await createExternalValidationStageRunner(
      run,
      input.root,
    ).runPublicQuery({
      binary: input.publicExecutable,
      engineBinary: input.executable,
      repository: input.root,
      revision: input.revision,
      validationCase: input.validationCase,
      ...(await expectedPublic(input)),
    });
    expect(result).toMatchObject({
      status: "failed",
      envelope: {
        valid: false,
        observation: { checks: { response_provenance: false } },
      },
      invocation: {
        usable: true,
        checks: {
          invoked: true,
          exact_executable: true,
          exact_query: true,
          exact_focus_resolution: true,
          exact_focus_observation: true,
          revision_bound_view: true,
        },
      },
    });
  });

  // A wrapper engine: graph-client gives the engine one fixed environment, without the inherited
  // BUN_OPTIONS that loaded the evaluator's observer into the wrapper, so the observer no longer
  // follows the wrapper into its own spawn of the engine. Every exact check of the wrapped calls
  // fails and the wrapper still cannot pass. Real evaluations spawn the Go engine directly.
  test("an arbitrary second focus cannot borrow validity from its own argv", async () => {
    const input = await fixture("valid");
    await Bun.write(
      input.publicExecutable,
      `#!/usr/bin/env bun
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const root = mkdtempSync(join(tmpdir(), "neuve-arbitrary-focus-"));
const shim = join(root, "graph-shim");
const target = process.env.NEUVE_GRAPH_BINARY;
writeFileSync(shim, \`#!\${process.execPath}
const argv = process.argv.slice(2);
if (argv[0] === "neighbors" && !argv.includes("--file")) argv[argv.indexOf("--symbol") + 1] = "arbitrary-focus";
const child = Bun.spawn([\${JSON.stringify(target)}, ...argv], { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: process.env });
process.exit(await child.exited);
\`);
chmodSync(shim, 0o755);
const child = Bun.spawn(["bun", ${JSON.stringify(resolve(import.meta.dir, "../../../apps/neuve-cli/src/cli.ts"))}, ...process.argv.slice(2)], { env: { ...process.env, NEUVE_GRAPH_BINARY: shim }, stdout: "inherit", stderr: "inherit" });
const exitCode = await child.exited;
rmSync(root, { recursive: true, force: true });
process.exit(exitCode);
`,
    );
    await chmod(input.publicExecutable, 0o755);
    const result = await createExternalValidationStageRunner(
      run,
      input.root,
    ).runPublicQuery({
      binary: input.publicExecutable,
      engineBinary: input.executable,
      repository: input.root,
      revision: input.revision,
      validationCase: input.validationCase,
      ...(await expectedPublic(input)),
    });
    expect(result).toMatchObject({
      status: "failed",
      envelope: {
        valid: false,
        observation: { checks: { response_provenance: false } },
      },
      invocation: {
        usable: false,
        checks: {
          exact_focus_resolution: false,
          exact_focus_observation: false,
        },
      },
    });
  });

  test("rejects an extra key in a successful public union", async () => {
    const input = await fixture("valid");
    await Bun.write(
      input.publicExecutable,
      `#!/usr/bin/env bun
const args = process.argv.slice(2);
const value = (flag) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
console.log(JSON.stringify({ schema_version: 2, provider: { name: "entire-graph", version: "fixture", identity_revision: "1", capabilities: { schema_version: "1.3", file_extensions: [".custom"], languages: { supported: ["FixtureLanguage"], semantic: ["FixtureLanguage"], inventory_only: [], unsupported_detected_hints: [] }, relations: { supported: ["CALLS"], by_language: { FixtureLanguage: ["CALLS"] }, by_profile: { full: ["CALLS"] }, heuristic: [] }, parser_versions: { fixture: "1" }, optional_local_features: {}, features_requiring_network: {} } }, query: value("--question"), source: { repository: value("--repo"), revision: value("--revision") }, retrieval: { status: "ok", coverage: "complete", candidates: [{ kind: "partial_symbol", language: "FixtureLanguage", source: { kind: "range", path: "source.custom", start_line: 1, end_line: 4 }, symbol: "caller", unexpected: true }], warnings: [], partial_failures: [], limitations: [], budget: { requested_top_k: 8, requested_max_context_bytes: 16384, returned_results: 1, provider_context_budget_bytes: 16384, provider_result_bytes: 1, query_constraints_truncated: false, results_dropped_by_budget: 0, snippets_truncated_by_budget: 0 } }, structural_observations: [{ request_id: "caller-calls-callee", status: "error", error: "fixture" }] }));
`,
    );
    await chmod(input.publicExecutable, 0o755);
    const result = await createExternalValidationStageRunner(
      run,
      input.root,
    ).runPublicQuery({
      binary: input.publicExecutable,
      engineBinary: input.executable,
      repository: input.root,
      revision: input.revision,
      validationCase: input.validationCase,
      ...(await expectedPublic(input)),
    });
    expect(result).toMatchObject({
      status: "failed",
      envelope: {
        valid: false,
        error: expect.stringContaining("must contain exactly"),
      },
    });
  });

  test.each(["not_found", "ambiguous_edges", "ambiguous_echo"] as const)(
    "rejects contradictory public focus state %s",
    async (variant) => {
      const input = await fixture("valid");
      await Bun.write(
        input.publicExecutable,
        `#!/usr/bin/env bun
const child = Bun.spawn(["bun", ${JSON.stringify(resolve(import.meta.dir, "../../../apps/neuve-cli/src/cli.ts"))}, ...process.argv.slice(2)], { stdin: "inherit", stdout: "pipe", stderr: "inherit", env: process.env });
const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
if (code !== 0) process.exit(code);
const response = JSON.parse(text);
const outcome = response.structural_observations[0];
const variant = ${JSON.stringify(variant)};
if (variant === "not_found") outcome.focus = { kind: "not_found" };
else outcome.focus = { kind: "ambiguous", matches: [outcome.focus.symbol], matches_truncated: variant === "ambiguous_echo" };
if (variant === "ambiguous_echo") outcome.observations = [];
console.log(JSON.stringify(response));
`,
      );
      const result = await createExternalValidationStageRunner(
        run,
        input.root,
      ).runPublicQuery({
        binary: input.publicExecutable,
        engineBinary: input.executable,
        repository: input.root,
        revision: input.revision,
        validationCase: input.validationCase,
        ...(await expectedPublic(input)),
      });
      expect(result).toMatchObject({
        status: "failed",
        envelope: {
          valid: false,
          error: expect.stringContaining(
            variant === "ambiguous_echo"
              ? "ambiguous focus truncation must match"
              : "unresolved focus must have no observations",
          ),
        },
      });
    },
  );

  test("maps one inspection into passing query and relationship stages", async () => {
    const input = await fixture("valid");
    const result = await createExternalValidationStageRunner(
      run,
      input.root,
    ).runGraph({
      binary: input.executable,
      repository: input.root,
      revision: input.revision,
      validationCase: input.validationCase,
      question: input.validationCase.authoritativeQuestion,
      queryExpectations: { present: ["caller"], absent: [] },
      relationshipExpectations: {
        present: ["caller-calls-callee"],
        absent: [],
      },
    });
    expect({
      query: status(result.engineQuery),
      relationships: status(result.structuredObservations),
    }).toEqual({ query: "passed", relationships: "passed" });
    const queryEvidence = evidence(result.engineQuery);
    const relationshipEvidence = evidence(result.structuredObservations);
    const queryStages = evidenceStages(result.engineQuery);
    const relationshipStages = evidenceStages(result.structuredObservations);
    expect(queryStages).toContain("version");
    expect(queryStages).toContain("capabilities");
    expect(queryStages).toContain("query");
    expect(
      queryStages.some((stage) => String(stage).startsWith("query:source:")),
    ).toBe(true);
    expect(
      queryStages.some(
        (stage) =>
          String(stage).startsWith("relationship:") &&
          !String(stage).includes(":source:"),
      ),
    ).toBe(false);
    expect(relationshipStages).toContain("version");
    expect(relationshipStages).toContain("capabilities");
    expect(relationshipStages).not.toContain("query");
    expect(
      relationshipStages.some((stage) =>
        String(stage).startsWith("relationship:caller-calls-callee:source:"),
      ),
    ).toBe(true);
    const queryVersion = queryEvidence.find(({ stage }) => stage === "version");
    const relationshipVersion = relationshipEvidence.find(
      ({ stage }) => stage === "version",
    );
    expect(queryVersion).toBe(relationshipVersion);
  });

  test("shares one cached source qualification across both stage reports", async () => {
    const input = await fixture("shared-source");
    const required = input.validationCase.requiredRelationships[0];
    if (required === undefined) throw new Error("fixture relationship missing");
    const validationCase: ExternalValidationCase = {
      ...input.validationCase,
      requiredRelationships: [
        { ...required, to: { ...required.to, path: "source.custom" } },
      ],
    };
    const result = await createExternalValidationStageRunner(
      run,
      input.root,
    ).runGraph({
      binary: input.executable,
      repository: input.root,
      revision: input.revision,
      validationCase,
      question: validationCase.authoritativeQuestion,
      queryExpectations: { present: ["caller"], absent: [] },
      relationshipExpectations: {
        present: ["caller-calls-callee"],
        absent: [],
      },
    });
    expect({
      query: status(result.engineQuery),
      relationships: status(result.structuredObservations),
    }).toEqual({ query: "passed", relationships: "passed" });
    const queryEvidence = evidence(result.engineQuery);
    const relationshipEvidence = evidence(result.structuredObservations);
    const metadataStage = "query:source:source.custom:metadata";
    const contentStage = "query:source:source.custom:content";
    expect(queryEvidence.map(({ stage }) => stage)).toContain(metadataStage);
    expect(queryEvidence.map(({ stage }) => stage)).toContain(contentStage);
    expect(relationshipEvidence.map(({ stage }) => stage)).toContain(
      metadataStage,
    );
    expect(relationshipEvidence.map(({ stage }) => stage)).toContain(
      contentStage,
    );
    const uniqueReceipts = [
      ...new Set([...queryEvidence, ...relationshipEvidence]),
    ];
    const uniqueStages = uniqueReceipts.map(({ stage }) => stage);
    for (const stage of [
      "version",
      "capabilities",
      "query",
      "relationship:caller-calls-callee:resolution",
      "relationship:caller-calls-callee:observation",
      metadataStage,
      contentStage,
    ]) {
      expect(uniqueStages.filter((value) => value === stage)).toHaveLength(1);
    }
    expect(
      uniqueStages.filter((stage) => String(stage).includes(":source:")),
    ).toEqual([metadataStage, contentStage]);
  });

  test.each([
    ["malformed-query", "error", "passed"],
    ["malformed-neighbor", "passed", "error"],
    ["missing-evidence", "passed", "failed"],
    ["constructs-only", "passed", "error"],
    ["omitted-language", "failed", "passed"],
    ["partial-symbol", "failed", "passed"],
    ["contained-retrieval", "passed", "passed"],
    ["unsupported-language", "passed", "failed"],
    ["mixed-relations", "passed", "error"],
  ])(
    "maps independent %s outcomes",
    async (mode, queryStatus, relationshipStatus) => {
      const input = await fixture(mode);
      const result = await createExternalValidationStageRunner(
        run,
        input.root,
      ).runGraph({
        binary: input.executable,
        repository: input.root,
        revision: input.revision,
        validationCase: input.validationCase,
        question: input.validationCase.authoritativeQuestion,
        queryExpectations: { present: ["caller"], absent: [] },
        relationshipExpectations: {
          present: ["caller-calls-callee"],
          absent: [],
        },
      });
      expect([
        status(result.engineQuery),
        status(result.structuredObservations),
      ]).toEqual([queryStatus, relationshipStatus]);
    },
  );

  test.each([
    ["partial-edge", "present", "passed", "present"],
    ["truncated-edge", "present", "passed", "present"],
    ["warning-edge", "present", "passed", "present"],
    ["partial-absent", "absent", "failed", "unknown"],
    ["truncated-absent", "absent", "failed", "unknown"],
    ["warning-absent", "absent", "failed", "unknown"],
    ["missing-evidence-absent", "absent", "failed", "unknown"],
    ["weak-resolution-absent", "absent", "failed", "unknown"],
    ["dropped-evidence-edge", "present", "passed", "present"],
  ] as const)(
    "%s preserves %s evidence separately from coverage",
    async (mode, expected, expectedStatus, observed) => {
      const input = await fixture(mode);
      const result = await createExternalValidationStageRunner(
        run,
        input.root,
      ).runGraph({
        binary: input.executable,
        repository: input.root,
        revision: input.revision,
        validationCase: input.validationCase,
        question: input.validationCase.authoritativeQuestion,
        queryExpectations: { present: ["caller"], absent: [] },
        relationshipExpectations: {
          present: expected === "present" ? ["caller-calls-callee"] : [],
          absent: expected === "absent" ? ["caller-calls-callee"] : [],
        },
      });
      expect(result.structuredObservations).toMatchObject({
        status: expectedStatus,
        relationships: [{ observation_valid: true, coverage_complete: false }],
        evaluation: {
          complete: false,
          requirements: [
            {
              id: "caller-calls-callee",
              expected,
              observed,
              passed: expectedStatus === "passed",
            },
          ],
        },
      });
    },
  );

  test("complete relationship coverage can establish a missing edge as absent", async () => {
    const input = await fixture("absent-edge");
    const result = await createExternalValidationStageRunner(
      run,
      input.root,
    ).runGraph({
      binary: input.executable,
      repository: input.root,
      revision: input.revision,
      validationCase: input.validationCase,
      question: input.validationCase.authoritativeQuestion,
      queryExpectations: { present: ["caller"], absent: [] },
      relationshipExpectations: {
        present: [],
        absent: ["caller-calls-callee"],
      },
    });
    expect(result.structuredObservations).toMatchObject({
      status: "passed",
      evaluation: {
        complete: true,
        requirements: [
          { expected: "absent", observed: "absent", passed: true },
        ],
      },
    });
  });

  test.each([
    "missing-focus",
    "partial-missing-focus",
    "truncated-missing-focus",
  ])(
    "%s retains the coverage needed to prove missing-focus absence",
    async (mode) => {
      const input = await fixture(mode);
      const complete = mode === "missing-focus";
      const result = await createExternalValidationStageRunner(
        run,
        input.root,
      ).runGraph({
        binary: input.executable,
        repository: input.root,
        revision: input.revision,
        validationCase: input.validationCase,
        question: input.validationCase.authoritativeQuestion,
        queryExpectations: { present: ["caller"], absent: [] },
        relationshipExpectations: {
          present: [],
          absent: ["caller-calls-callee"],
        },
      });
      expect(result.structuredObservations).toMatchObject({
        status: complete ? "passed" : "failed",
        relationships: [
          {
            focus: { kind: "not_found" },
            observation_valid: true,
            coverage_complete: complete,
          },
        ],
        evaluation: {
          requirements: [
            {
              expected: "absent",
              observed: complete ? "absent" : "unknown",
              passed: complete,
            },
          ],
        },
      });
    },
  );

  test("budget loss cannot prove retrieval absence", async () => {
    const input = await fixture("budget-loss");
    const result = await createExternalValidationStageRunner(
      run,
      input.root,
    ).runGraph({
      binary: input.executable,
      repository: input.root,
      revision: input.revision,
      validationCase: input.validationCase,
      question: input.validationCase.authoritativeQuestion,
      queryExpectations: { present: [], absent: ["caller"] },
      relationshipExpectations: { present: [], absent: [] },
    });
    expect(result.engineQuery).toMatchObject({
      status: "failed",
      evaluation: { complete: false },
    });
  });

  test("observed contained-callable presence remains usable when its manifest is truncated", async () => {
    const input = await fixture("contained-truncated");
    const result = await createExternalValidationStageRunner(
      run,
      input.root,
    ).runGraph({
      binary: input.executable,
      repository: input.root,
      revision: input.revision,
      validationCase: input.validationCase,
      question: input.validationCase.authoritativeQuestion,
      queryExpectations: { present: ["caller"], absent: [] },
      relationshipExpectations: { present: [], absent: [] },
    });
    expect(result.engineQuery).toMatchObject({
      status: "passed",
      present_roles: ["caller"],
      observation: { containedCallableCoverage: "truncated" },
    });
  });

  test.each(["partial-symbol", "contained-truncated-absent"])(
    "%s contained-callable coverage cannot prove retrieval absence",
    async (mode) => {
      const input = await fixture(mode);
      const result = await createExternalValidationStageRunner(
        run,
        input.root,
      ).runGraph({
        binary: input.executable,
        repository: input.root,
        revision: input.revision,
        validationCase: input.validationCase,
        question: input.validationCase.authoritativeQuestion,
        queryExpectations: { present: [], absent: ["caller"] },
        relationshipExpectations: { present: [], absent: [] },
      });
      expect(result.engineQuery).toMatchObject({
        status: "failed",
        evaluation: {
          expectation: { passed: true },
          complete: false,
        },
      });
    },
  );

  test("unsupported language capability cannot prove relationship absence", async () => {
    const input = await fixture("unsupported-absent");
    const result = await createExternalValidationStageRunner(
      run,
      input.root,
    ).runGraph({
      binary: input.executable,
      repository: input.root,
      revision: input.revision,
      validationCase: input.validationCase,
      question: input.validationCase.authoritativeQuestion,
      queryExpectations: { present: ["caller"], absent: [] },
      relationshipExpectations: {
        present: [],
        absent: ["caller-calls-callee"],
      },
    });
    expect(result.structuredObservations).toMatchObject({
      status: "failed",
      evaluation: { complete: false },
    });
  });

  test("a CONSTRUCTS edge in an exact CALLS response fails boundary validation", async () => {
    const input = await fixture("mixed-relations");
    const result = await createExternalValidationStageRunner(
      run,
      input.root,
    ).runGraph({
      binary: input.executable,
      repository: input.root,
      revision: input.revision,
      validationCase: input.validationCase,
      question: input.validationCase.authoritativeQuestion,
      queryExpectations: { present: ["caller"], absent: [] },
      relationshipExpectations: {
        present: ["caller-calls-callee"],
        absent: [],
      },
    });
    expect(result.structuredObservations).toMatchObject({
      status: "error",
      relationships: [{ errored: true, observed_present: false }],
    });
  });

  test("normalizes two unique temporary views to byte-identical evidence", async () => {
    const input = await fixture("valid");
    const runner = createExternalValidationStageRunner(run, input.root);
    const execute = async () => {
      const substitutions = new Map<string, string>();
      const result = await runner.runGraph({
        binary: input.executable,
        repository: input.root,
        revision: input.revision,
        validationCase: input.validationCase,
        question: input.validationCase.authoritativeQuestion,
        queryExpectations: { present: ["caller"], absent: [] },
        relationshipExpectations: {
          present: ["caller-calls-callee"],
          absent: [],
        },
        registerTemporaryView: (path) =>
          substitutions.set(path, "<graph-view-fixture>"),
      });
      return JSON.stringify(
        normalizeExternalValidationReport(result, substitutions),
      );
    };
    expect(await execute()).toBe(await execute());
  });

  test("normalizes distinct public CLI graph views to byte-identical evidence", async () => {
    const input = await fixture("valid");
    const runner = createExternalValidationStageRunner(run, input.root);
    const expected = await expectedPublic(input);
    const execute = async () => {
      const substitutions = new Map<string, string>();
      let temporaryRoot = "";
      let inspectionRoot = "";
      const result = await runner.runPublicQuery({
        binary: input.publicExecutable,
        engineBinary: input.executable,
        repository: input.root,
        revision: input.revision,
        validationCase: input.validationCase,
        ...expected,
        registerTemporaryPath: (path) => {
          temporaryRoot = path;
          substitutions.set(path, "<public-query-run-root>");
        },
        registerTemporaryView: (path) => {
          if (inspectionRoot === "") inspectionRoot = path;
          substitutions.set(path, "<public-graph-view-fixture>");
        },
      });
      const invocation = result.invocation as {
        checks: { revision_bound_view: boolean };
        invocations: readonly { repository?: string }[];
      };
      const view = invocation.invocations.find(
        ({ repository }) => repository !== undefined,
      )?.repository;
      if (view === undefined) throw new Error("public graph view missing");
      const unregisteredLookalikes = [
        `${temporaryRoot}-lookalike/candidate-tmp/neuve-graph-client-random/view`,
        `${inspectionRoot}-lookalike/executable/graph-valid`,
        `${view}-lookalike`,
      ];
      const normalized = normalizeExternalValidationReport(
        { result, unregistered_lookalikes: unregisteredLookalikes },
        substitutions,
      ) as {
        result: unknown;
        unregistered_lookalikes: string[];
      };
      return {
        view,
        temporaryRoot,
        inspectionRoot,
        revisionBoundView: invocation.checks.revision_bound_view,
        lookalikes: normalized.unregistered_lookalikes,
        canonical: JSON.stringify(normalized.result),
      };
    };
    const first = await execute();
    const second = await execute();
    expect(first.view.startsWith(`${first.temporaryRoot}/candidate-tmp/`)).toBe(
      true,
    );
    expect(second.view).not.toBe(first.view);
    expect([first.revisionBoundView, second.revisionBoundView]).toEqual([
      true,
      true,
    ]);
    expect(first.lookalikes).toEqual([
      `${first.temporaryRoot}-lookalike/candidate-tmp/neuve-graph-client-random/view`,
      `${first.inspectionRoot}-lookalike/executable/graph-valid`,
      `${first.view}-lookalike`,
    ]);
    expect(second.lookalikes).toEqual([
      `${second.temporaryRoot}-lookalike/candidate-tmp/neuve-graph-client-random/view`,
      `${second.inspectionRoot}-lookalike/executable/graph-valid`,
      `${second.view}-lookalike`,
    ]);
    expect(first.canonical).not.toContain(first.view);
    expect(first.canonical).not.toContain(first.inspectionRoot);
    expect(first.canonical).toContain("<public-graph-view-fixture>");
    expect(first.canonical).toBe(second.canonical);
    // Alone 1.95-3.09 s at load 11-17; 10x slowest, at least 30 s; child processes and disk I/O under load.
  }, 40_000);
});
