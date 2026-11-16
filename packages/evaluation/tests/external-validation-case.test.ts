import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import {
  assembleExternalValidationSuite,
  parseExternalValidationCase,
  parseExternalValidationManifest,
  type SourceAssertion,
} from "../src/external-validation-case.ts";
import {
  evaluatePresence,
  evaluateProviderProvenance,
  evaluateQueryStage,
  evaluateRelationshipStage,
  evaluateSourceAssertion,
  type SourceObservation,
} from "../src/external-validation-evaluator.ts";
import {
  externalValidationEvaluatorSourcePaths,
  normalizeExternalValidationReport,
  type CommandEvidence,
} from "../src/external-validation-report.ts";
import { createExternalValidationStageRunner } from "../src/external-validation-stages.ts";
import { evaluateOperationalForkMarker } from "../src/operational-fork-marker.ts";

const suiteRoot = resolve(import.meta.dir, "./fixtures/external-validation");
const alternateLanguage = "FixtureLanguageA";

describe("external validation boundary", () => {
  test("parses every checked-in case in manifest order", async () => {
    const manifestValue: unknown = Bun.YAML.parse(
      await Bun.file(resolve(suiteRoot, "manifest.yaml")).text(),
    );
    const manifest = parseExternalValidationManifest(manifestValue);
    const caseFiles = await Promise.all(
      manifest.cases.map(async (filename) => ({
        filename,
        validationCase: parseExternalValidationCase(
          Bun.YAML.parse(await Bun.file(resolve(suiteRoot, filename)).text()),
        ),
      })),
    );
    const suite = assembleExternalValidationSuite(manifest, caseFiles);

    expect(suite.cases.map(({ id }) => id)).toEqual([
      "neuve-effect-argument-roundtrip",
      "neuve-effect-terminal-idempotency",
      "neuve-effect-deterministic-watcher",
    ]);
    expect(suite.cases[0]?.requiredRelationships).toHaveLength(2);
    expect(suite.cases[0]?.requiredRetrieval.map(({ role }) => role)).toEqual([
      "target_parser",
      "production_caller",
      "serializer",
      "quoting_helper",
      "regression_check",
    ]);
    expect(suite.manifest.stageResults).toEqual([
      "public_query",
      "engine_query",
      "structured_observations",
    ]);
    expect(suite.manifest.requiredRunIdentities).toContain(
      "neuve_binary_identity",
    );
  });

  test("accepts a new case without invented lexical history", async () => {
    const source = await Bun.file(
      resolve(suiteRoot, "argument-roundtrip.yaml"),
    ).text();
    const withoutHistory = source.replace(
      /\nknown_lexical_baseline:[\s\S]*$/,
      "\n",
    );
    expect(() =>
      parseExternalValidationCase(Bun.YAML.parse(withoutHistory)),
    ).not.toThrow();
  });

  test("accepts a literal empty relationship plan and empty control classifications", async () => {
    const value = Bun.YAML.parse(
      await Bun.file(resolve(suiteRoot, "argument-roundtrip.yaml")).text(),
    ) as {
      required_relationships: unknown[];
      revision_controls: Array<{
        relationships: { present: unknown[]; absent: unknown[] };
      }>;
    };
    value.required_relationships = [];
    for (const control of value.revision_controls) {
      control.relationships = { present: [], absent: [] };
    }

    const parsed = parseExternalValidationCase(value);
    expect(parsed.requiredRelationships).toEqual([]);
    expect(
      parsed.revisionControls.map(({ relationships }) => relationships),
    ).toEqual([{ present: [], absent: [] }]);
  });

  test("rejects unsupported fields instead of silently ignoring them", async () => {
    const source = await Bun.file(
      resolve(suiteRoot, "argument-roundtrip.yaml"),
    ).text();
    const invalidValue: unknown = Bun.YAML.parse(
      `${source}\nignored_constraint: should-not-be-ignored\n`,
    );

    expect(() => parseExternalValidationCase(invalidValue)).toThrow(
      "unsupported fields: ignored_constraint",
    );
  });

  test("rejects duplicate manifest filenames", async () => {
    const source = await Bun.file(resolve(suiteRoot, "manifest.yaml")).text();
    const invalidValue: unknown = Bun.YAML.parse(
      source.replace(
        "  - terminal-idempotency.yaml\n",
        "  - argument-roundtrip.yaml\n",
      ),
    );

    expect(() => parseExternalValidationManifest(invalidValue)).toThrow(
      "duplicate argument-roundtrip.yaml",
    );
  });

  test("rejects duplicate case ids and suite language mismatch", async () => {
    const manifest = parseExternalValidationManifest(
      Bun.YAML.parse(
        await Bun.file(resolve(suiteRoot, "manifest.yaml")).text(),
      ),
    );
    const argumentSource = await Bun.file(
      resolve(suiteRoot, "argument-roundtrip.yaml"),
    ).text();
    const terminalSource = await Bun.file(
      resolve(suiteRoot, "terminal-idempotency.yaml"),
    ).text();
    const watcherSource = await Bun.file(
      resolve(suiteRoot, "deterministic-watcher.yaml"),
    ).text();
    const argumentCase = parseExternalValidationCase(
      Bun.YAML.parse(argumentSource),
    );
    const duplicateIdCase = parseExternalValidationCase(
      Bun.YAML.parse(
        terminalSource.replace(
          "neuve-effect-terminal-idempotency",
          "neuve-effect-argument-roundtrip",
        ),
      ),
    );
    const watcherCase = parseExternalValidationCase(
      Bun.YAML.parse(watcherSource),
    );
    expect(() =>
      assembleExternalValidationSuite(manifest, [
        { filename: manifest.cases[0] ?? "", validationCase: argumentCase },
        { filename: manifest.cases[1] ?? "", validationCase: duplicateIdCase },
        { filename: manifest.cases[2] ?? "", validationCase: watcherCase },
      ]),
    ).toThrow("duplicate neuve-effect-argument-roundtrip");

    const mismatched = parseExternalValidationCase(
      Bun.YAML.parse(
        argumentSource.replace(
          `language: ${manifest.language}`,
          `language: ${alternateLanguage}`,
        ),
      ),
    );
    expect(() =>
      assembleExternalValidationSuite(manifest, [
        { filename: manifest.cases[0] ?? "", validationCase: mismatched },
        {
          filename: manifest.cases[1] ?? "",
          validationCase: parseExternalValidationCase(
            Bun.YAML.parse(terminalSource),
          ),
        },
        { filename: manifest.cases[2] ?? "", validationCase: watcherCase },
      ]),
    ).toThrow(
      `language ${alternateLanguage} does not match suite language ${manifest.language}`,
    );
  });

  test("accepts a consistently declared alternate-language suite", async () => {
    const manifestSource = await Bun.file(
      resolve(suiteRoot, "manifest.yaml"),
    ).text();
    const argumentSource = await Bun.file(
      resolve(suiteRoot, "argument-roundtrip.yaml"),
    ).text();
    const originalManifest = parseExternalValidationManifest(
      Bun.YAML.parse(manifestSource),
    );
    const manifest = parseExternalValidationManifest(
      Bun.YAML.parse(
        manifestSource
          .replace(
            `language: ${originalManifest.language}`,
            `language: ${alternateLanguage}`,
          )
          .replace(
            "  - terminal-idempotency.yaml\n  - deterministic-watcher.yaml\n",
            "",
          ),
      ),
    );
    const validationCase = parseExternalValidationCase(
      Bun.YAML.parse(
        argumentSource.replace(
          `language: ${originalManifest.language}`,
          `language: ${alternateLanguage}`,
        ),
      ),
    );

    expect(
      assembleExternalValidationSuite(manifest, [
        { filename: "argument-roundtrip.yaml", validationCase },
      ]),
    ).toMatchObject({ manifest: { language: alternateLanguage } });
  });

  test("rejects a relationship with both resolution forms", async () => {
    const source = await Bun.file(
      resolve(suiteRoot, "argument-roundtrip.yaml"),
    ).text();
    const invalidValue: unknown = Bun.YAML.parse(
      source.replace(
        "    resolution: exact\n",
        "    resolution: exact\n    accepted_resolutions: [exact]\n",
      ),
    );

    expect(() => parseExternalValidationCase(invalidValue)).toThrow(
      "must define exactly one resolution form",
    );
  });

  test("rejects an endpoint with only half of its qualified selector", async () => {
    const source = await Bun.file(
      resolve(suiteRoot, "argument-roundtrip.yaml"),
    ).text();
    const invalidValue: unknown = Bun.YAML.parse(
      source.replace(
        "      symbol: parseCommandSpec\n",
        "      symbol: parseCommandSpec\n      kind: function\n",
      ),
    );

    expect(() => parseExternalValidationCase(invalidValue)).toThrow(
      "must define both kind and qualified_name or neither",
    );
  });

  test("rejects unknown nested relationship endpoint fields", async () => {
    const source = await Bun.file(
      resolve(suiteRoot, "argument-roundtrip.yaml"),
    ).text();
    const invalidValue: unknown = Bun.YAML.parse(
      source.replace(
        "      symbol: parseCommandSpec\n",
        "      symbol: parseCommandSpec\n      ignored_endpoint_constraint: true\n",
      ),
    );

    expect(() => parseExternalValidationCase(invalidValue)).toThrow(
      "unsupported fields: ignored_endpoint_constraint",
    );
  });

  test("rejects retrievals with both or neither locator", async () => {
    const source = await Bun.file(
      resolve(suiteRoot, "argument-roundtrip.yaml"),
    ).text();
    const both: unknown = Bun.YAML.parse(
      source.replace(
        "    symbol: parseCommandTokens\n",
        "    symbol: parseCommandTokens\n    lines: { start: 1, end: 2 }\n",
      ),
    );
    const neither: unknown = Bun.YAML.parse(
      source.replace("    symbol: parseCommandTokens\n", ""),
    );

    expect(() => parseExternalValidationCase(both)).toThrow(
      "must define exactly one locator: symbol or lines",
    );
    expect(() => parseExternalValidationCase(neither)).toThrow(
      "must define exactly one locator: symbol or lines",
    );
  });

  test("rejects a missing operational fork marker", async () => {
    const source = await Bun.file(resolve(suiteRoot, "manifest.yaml")).text();
    const invalidValue: unknown = Bun.YAML.parse(
      source.replace(
        "    required_fork_marker:\n",
        "    missing_fork_marker:\n",
      ),
    );

    expect(() => parseExternalValidationManifest(invalidValue)).toThrow(
      "unsupported fields: missing_fork_marker",
    );
  });

  test("rejects a hosted origin that disagrees with the required origin remote", async () => {
    const source = await Bun.file(resolve(suiteRoot, "manifest.yaml")).text();
    const invalidValue: unknown = Bun.YAML.parse(
      source.replace(
        /^    hosted_origin:.*$/m,
        "    hosted_origin: git@example.test:wrong.git",
      ),
    );

    expect(() => parseExternalValidationManifest(invalidValue)).toThrow(
      "hosted origin and origin remote URL must match",
    );
  });

  test("rejects malformed revision controls", async () => {
    const source = await Bun.file(
      resolve(suiteRoot, "terminal-idempotency.yaml"),
    ).text();
    const invalidValue: unknown = Bun.YAML.parse(
      source.replace(
        "revision: 8e0b9a517d9a1581d997acbc9c534d2a82c55d2d",
        "revision: not-a-revision",
      ),
    );

    expect(() => parseExternalValidationCase(invalidValue)).toThrow(
      "must be a full lowercase Git object name",
    );
  });

  test("rejects a revision control that leaves a retrieval role unclassified", async () => {
    const source = await Bun.file(
      resolve(suiteRoot, "terminal-idempotency.yaml"),
    ).text();
    const invalidValue: unknown = Bun.YAML.parse(
      source.replace(
        "      absent: [integration_check]\n",
        "      absent: []\n",
      ),
    );

    expect(() => parseExternalValidationCase(invalidValue)).toThrow(
      "retrieval must classify every required retrieval role exactly once",
    );
  });

  test("rejects a revision control that leaves a relationship unclassified", async () => {
    const source = await Bun.file(
      resolve(suiteRoot, "deterministic-watcher.yaml"),
    ).text();
    const invalidValue: unknown = Bun.YAML.parse(
      source.replace(
        "      absent: [wrapper-calls-watcher, loop-calls-wrapper]\n",
        "      absent: [wrapper-calls-watcher]\n",
      ),
    );

    expect(() => parseExternalValidationCase(invalidValue)).toThrow(
      "relationships must classify every required relationship id exactly once",
    );
  });

  test("presence evaluation detects retrieval and relationship polarity mutations", () => {
    const observed = new Set(["target", "caller"]);
    expect(
      evaluatePresence(
        { present: ["target", "caller"], absent: ["regression"] },
        observed,
      ).passed,
    ).toBe(true);
    expect(
      evaluatePresence(
        { present: ["target", "regression"], absent: ["caller"] },
        observed,
      ),
    ).toEqual({
      passed: false,
      missingExpectedPresent: ["regression"],
      unexpectedlyPresent: ["caller"],
    });
  });

  test("provider provenance rejects revision and normalized repository mismatches", () => {
    const valid = evaluateProviderProvenance({
      expectedRevision: "a".repeat(40),
      observedRevision: "a".repeat(40),
      expectedRepository: "/tmp/suite/target",
      observedRepository: "/tmp/suite/./target",
    });
    expect(valid.passed).toBe(true);
    expect(
      evaluateProviderProvenance({
        expectedRevision: "a".repeat(40),
        observedRevision: "b".repeat(40),
        expectedRepository: "/tmp/suite/target",
        observedRepository: "/tmp/suite/other",
      }),
    ).toMatchObject({
      passed: false,
      revisionMatches: false,
      repositoryMatches: false,
    });
  });

  test("partial provider results cannot prove expected retrieval or relationship absence", () => {
    const provenance = evaluateProviderProvenance({
      expectedRevision: "a".repeat(40),
      observedRevision: "a".repeat(40),
      expectedRepository: "/tmp/target",
      observedRepository: "/tmp/target",
    });
    expect(
      evaluateQueryStage({
        expectations: { present: [], absent: ["missing"] },
        observedPresent: new Set(),
        provenance,
        coverage: "ok",
        partialFailureCount: 1,
        queryConstraintsTruncated: false,
        resultsDroppedByBudget: 0,
        containedCallablesComplete: true,
        capabilityComplete: true,
      }).passed,
    ).toBe(false);
    expect(
      evaluateRelationshipStage({ present: [], absent: ["missing-edge"] }, [
        {
          id: "missing-edge",
          kind: "observed",
          present: false,
          coverage: "incomplete",
        },
      ]).passed,
    ).toBe(false);
  });

  test("source lookup command failure is an error, never absent evidence", async () => {
    const failingRun = async (
      argv: readonly string[],
      cwd: string,
    ): Promise<CommandEvidence> => ({
      argv,
      cwd,
      stdout: "",
      stderr: "fatal: not a git repository",
      exit_code: 128,
    });
    const stageRunner = createExternalValidationStageRunner(failingRun, "/tmp");
    const result = await stageRunner.runSourceAssertions("/missing", {
      id: "missing-file-control",
      revision: "a".repeat(40),
      sourceAssertions: [
        {
          kind: "file",
          id: "missing-file",
          path: "src/missing.ts",
          expected: "absent",
        },
      ],
      retrieval: { present: [], absent: [] },
      relationships: { present: [], absent: [] },
    });

    expect(result).toMatchObject({
      status: "error",
      assertions: [{ passed: false, observed: "operational_error" }],
    });
  });

  test("canonical normalization covers transient paths and telemetry", () => {
    const normalized = normalizeExternalValidationReport(
      {
        command: {
          argv: ["/tmp/run/bin", "query"],
          cwd: "/tmp/run",
          environment: { NEUVE_GRAPH_BINARY: "/tmp/run/graph" },
          stdout: '{"query_latency_ms":12,"repo":"/tmp/run/target"}\n',
          stderr: "",
          exit_code: 0,
        },
        install: {
          argv: ["bun", "install", "--frozen-lockfile"],
          cwd: "/tmp/run/source",
          stdout: "",
          stderr:
            "bun install v1.4.0\nChecked 13 installs across 31 packages (no changes) [24.00ms]\n",
          exit_code: 0,
        },
      },
      new Map([["/tmp/run", "<run-root>"]]),
    );
    expect(normalized).toEqual({
      command: {
        argv: ["<run-root>/bin", "query"],
        cwd: "<run-root>",
        environment: { NEUVE_GRAPH_BINARY: "<run-root>/graph" },
        exit_code: 0,
        stderr: "",
        stdout:
          '{"query_latency_ms":"<telemetry>","repo":"<run-root>/target"}\n',
      },
      install: {
        argv: ["bun", "install", "--frozen-lockfile"],
        cwd: "<run-root>/source",
        exit_code: 0,
        stderr:
          "bun install v1.4.0\nChecked 13 installs across 31 packages (no changes) [<install-telemetry>]\n",
        stdout: "",
      },
    });
  });

  test("canonical normalization prefers an exact view over its registered parent", () => {
    const parent = "/tmp/public-query-run";
    const view = `${parent}/candidate-tmp/neuve-graph-client-random/view`;
    const parentLookalike = `${parent}-lookalike/candidate-tmp`;
    const viewLookalike = `${view}-lookalike`;
    expect(
      normalizeExternalValidationReport(
        {
          view,
          parent_file: `${parent}/graph-recorder`,
          parent_lookalike: parentLookalike,
          view_lookalike: viewLookalike,
        },
        new Map([
          [parent, "<public-query-run>"],
          [view, "<public-graph-view>"],
        ]),
      ),
    ).toEqual({
      view: "<public-graph-view>",
      parent_file: "<public-query-run>/graph-recorder",
      parent_lookalike: parentLookalike,
      view_lookalike: viewLookalike,
    });
  });

  test("evaluator identity names every running source seam", async () => {
    expect(externalValidationEvaluatorSourcePaths).toEqual([
      "packages/evaluation/scripts/verify-external-neuve-effect.ts",
      "apps/neuve-cli/src/boundary.ts",
      "apps/neuve-cli/src/domain.ts",
      "apps/neuve-cli/src/graph-query.ts",
      "packages/graph-client/src/domain.ts",
      "packages/graph-client/src/index.ts",
      "packages/graph-client/src/parse.ts",
      "packages/evaluation/src/external-validation-case.ts",
      "packages/evaluation/src/external-validation-evaluator.ts",
      "packages/evaluation/src/external-validation-report.ts",
      "packages/evaluation/src/external-validation-stages.ts",
      "packages/evaluation/src/observe-native-graph-preload.ts",
      "packages/evaluation/src/external-validation-suite.ts",
      "packages/evaluation/src/neuve-build.ts",
      "packages/evaluation/src/operational-fork-marker.ts",
    ]);
  });

  test("source assertion evaluation detects polarity mutations in an exact region", () => {
    const assertion: SourceAssertion = {
      kind: "literal",
      id: "bridge",
      path: "src/service.ts",
      region: { startLine: 2, endLine: 3 },
      literal: "target()",
      expected: "present",
    };
    const observation: SourceObservation = {
      kind: "file",
      lines: ["outside", "target()", "end"],
    };
    expect(evaluateSourceAssertion(assertion, observation).passed).toBe(true);
    expect(
      evaluateSourceAssertion({ ...assertion, expected: "absent" }, observation)
        .passed,
    ).toBe(false);
    expect(
      evaluateSourceAssertion(assertion, { kind: "missing_file" }),
    ).toMatchObject({ passed: false, observed: "missing_file" });
    expect(
      evaluateSourceAssertion(assertion, {
        kind: "file",
        lines: ["too short"],
      }),
    ).toMatchObject({ passed: false, observed: "region_out_of_bounds" });
  });

  test("accepts the exact hosted operational fork marker", () => {
    const result = evaluateOperationalForkMarker({
      expected: {
        baselineTagTarget: "a".repeat(40),
        upstreamRemoteUrl: "git@example.test:upstream.git",
        originRemoteName: "origin",
        originRemoteUrl: "git@example.test:fork.git",
      },
      observed: {
        tagType: "tag",
        tagTarget: "a".repeat(40),
        upstreamFetch: "git@example.test:upstream.git",
        upstreamPush: "DISABLED",
        originFetch: "git@example.test:fork.git",
        remotes: ["upstream", "origin"],
        descendsFromBaseline: true,
      },
    });

    expect(result.valid).toBe(true);
    expect(result.checks.origin_present).toBe(true);
    expect(result.checks.origin_fetch).toBe(true);
  });

  test("rejects an observed checkout whose hosted origin is wrong", () => {
    const result = evaluateOperationalForkMarker({
      expected: {
        baselineTagTarget: "a".repeat(40),
        upstreamRemoteUrl: "git@example.test:upstream.git",
        originRemoteName: "origin",
        originRemoteUrl: "git@example.test:fork.git",
      },
      observed: {
        tagType: "tag",
        tagTarget: "a".repeat(40),
        upstreamFetch: "git@example.test:upstream.git",
        upstreamPush: "DISABLED",
        originFetch: "git@example.test:wrong.git",
        remotes: ["upstream", "origin"],
        descendsFromBaseline: true,
      },
    });

    expect(result.valid).toBe(false);
    expect(result.checks.origin_present).toBe(true);
    expect(result.checks.origin_fetch).toBe(false);
  });
});
