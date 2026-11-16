import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  inspectGraph,
  runGraphInspection,
  type GraphCommandReceipt,
} from "../src/index.ts";
import {
  removeRoots,
  roots,
  run,
  waitForFile,
  pathExists,
  fixtureRepository,
  fakeExecutable,
  request,
  requestWithRelationship,
  success,
  relationship,
} from "./graph-client-support.ts";

afterEach(removeRoots);

describe("inspectGraph", () => {
  test.each([
    "selection-family-duplicate",
    "selection-family-unsupported",
    "selection-mode-invalid",
  ])("rejects malformed capability selection %s", async (mode) => {
    const repository = await fixtureRepository();
    await expect(
      inspectGraph(
        request(await fakeExecutable(mode), repository.root, repository.first),
      ),
    ).rejects.toThrow("capabilities");
  });

  test("a family member missing from the full profile stops before neighbors", async () => {
    const repository = await fixtureRepository();
    const commands: GraphCommandReceipt[] = [];
    const inspection = await inspectGraph(
      request(
        await fakeExecutable("selection-profile-missing"),
        repository.root,
        repository.first,
      ),
      { onCommand: (receipt) => commands.push(receipt) },
    );
    expect(inspection.query.kind).toBe("success");
    expect(inspection.relationships[0]?.outcome.kind).toBe("error");
    expect(
      commands.filter(({ stage }) => stage.startsWith("relationship:")),
    ).toEqual([]);
  });
  test("exact relation selection preserves a weaker endpoint resolution", async () => {
    const repository = await fixtureRepository();
    const result = relationship(
      await inspectGraph(
        requestWithRelationship(
          await fakeExecutable("selection-name-only"),
          repository.root,
          repository.first,
          { selection: "exact" },
        ),
      ),
    );
    expect(result.selection).toBe("exact");
    expect(result.observations[0]).toMatchObject({
      relation: "CALLS",
      resolution: "name_only",
    });
  });

  test("requests a frontier only on the final stable-id neighbor command", async () => {
    const repository = await fixtureRepository();
    const commands: GraphCommandReceipt[] = [];
    const result = relationship(
      await inspectGraph(
        requestWithRelationship(
          await fakeExecutable("valid"),
          repository.root,
          repository.first,
          { selection: "exact", summary: "frontier" },
        ),
        { onCommand: (receipt) => commands.push(receipt) },
      ),
    );
    expect(result.summary).toEqual({
      kind: "observed",
      expandedDepth: 1,
      indexedCoverage: "ok",
      direct: {
        eligibleEdges: 1,
        emittedEdges: 1,
        omittedEdges: 0,
        missingEndpointEdges: 0,
      },
      frontier: [
        {
          kind: "indexed",
          endpointId: "callee-id",
          counts: [{ relation: "CALLS", resolution: "exact", edges: 2 }],
          externalEdges: 0,
          missingEndpointEdges: 0,
          returnsToFocus: 0,
          selfEdges: 0,
        },
      ],
    });
    const neighbors = commands.filter(
      ({ stage }) =>
        stage === "relationship:caller-calls-callee:resolution" ||
        stage === "relationship:caller-calls-callee:observation",
    );
    expect(neighbors).toHaveLength(2);
    expect(neighbors[0]?.argv).not.toContain("--summary");
    expect(neighbors[1]?.argv).toEqual(
      expect.arrayContaining(["--summary", "frontier"]),
    );
  });

  test("keeps direct observations when the provider lacks frontier support", async () => {
    const repository = await fixtureRepository();
    const commands: GraphCommandReceipt[] = [];
    const result = relationship(
      await inspectGraph(
        requestWithRelationship(
          await fakeExecutable("frontier-unsupported"),
          repository.root,
          repository.first,
          { summary: "frontier" },
        ),
        { onCommand: (receipt) => commands.push(receipt) },
      ),
    );
    expect(result.observations).toHaveLength(1);
    expect(result.summary).toEqual({
      kind: "unavailable",
      reason: "unsupported_provider",
    });
    expect(
      commands
        .filter(({ stage }) => stage.startsWith("relationship:"))
        .flatMap(({ argv }) => argv),
    ).not.toContain("--summary");
  });

  test("marks a requested frontier unresolved without enriching focus resolution", async () => {
    const repository = await fixtureRepository();
    const commands: GraphCommandReceipt[] = [];
    const result = relationship(
      await inspectGraph(
        requestWithRelationship(
          await fakeExecutable("valid"),
          repository.root,
          repository.first,
          { focus: { line: 6 }, summary: "frontier" },
        ),
        { onCommand: (receipt) => commands.push(receipt) },
      ),
    );
    expect(result.focus).toEqual({ kind: "not_found" });
    expect(result.summary).toEqual({ kind: "unresolved_focus" });
    const neighbors = commands.filter(
      ({ stage }) => stage === "relationship:caller-calls-callee:resolution",
    );
    expect(neighbors).toHaveLength(1);
    expect(neighbors[0]?.argv).not.toContain("--summary");
  });

  test("keeps duplicate direct records while summarizing one endpoint", async () => {
    const repository = await fixtureRepository();
    const result = relationship(
      await inspectGraph(
        requestWithRelationship(
          await fakeExecutable("frontier-duplicate-records"),
          repository.root,
          repository.first,
          { selection: "exact", summary: "frontier" },
        ),
      ),
    );
    expect(result.observations).toHaveLength(2);
    expect(result.summary).toMatchObject({
      kind: "observed",
      direct: { eligibleEdges: 2, emittedEdges: 2, omittedEdges: 0 },
      frontier: [{ endpointId: "callee-id" }],
    });
  });

  test.each([
    "frontier-unknown-endpoint",
    "frontier-negative-count",
    "frontier-negative-degree",
    "frontier-bad-arithmetic",
    "frontier-wrong-selection",
    "frontier-wrong-direction",
    "frontier-wrong-coverage",
    "frontier-unreported-omission",
    "frontier-stale-view",
    "frontier-command-failure",
  ])(
    "isolates a rejected frontier response from retrieval and other relationships: %s",
    async (mode) => {
      const repository = await fixtureRepository();
      const executable = await fakeExecutable(mode);
      const base = requestWithRelationship(
        executable,
        repository.root,
        repository.first,
        { selection: "exact", summary: "frontier" },
      );
      const enriched = base.relationships[0];
      if (enriched === undefined)
        throw new Error("fixture relationship missing");
      let view = "";
      const receipts: GraphCommandReceipt[] = [];
      const inspection = await inspectGraph(
        {
          ...base,
          relationships: [
            enriched,
            {
              id: "ordinary",
              focus: enriched.focus,
              relation: enriched.relation,
              selection: enriched.selection,
              direction: enriched.direction,
              depth: enriched.depth,
              limit: enriched.limit,
            },
          ],
        },
        {
          onTemporaryView: ({ path }) => {
            view = path;
          },
          onCommand: (receipt) => receipts.push(receipt),
        },
      );
      expect(inspection.query.kind).toBe("success");
      expect(
        inspection.relationships.map(({ outcome }) => outcome.kind),
      ).toEqual(["error", "success"]);
      expect(view).not.toBe("");
      expect(await pathExists(view)).toBe(false);
      if (mode === "frontier-command-failure") {
        expect(
          receipts.find(
            ({ stage }) =>
              stage === "relationship:caller-calls-callee:observation",
          ),
        ).toMatchObject({ stderr: "FRONTIER_FAILURE\n", exitCode: 23 });
      }
    },
  );
  test.each(["exact", "family"] as const)(
    "legacy provider yields typed unavailable for %s without neighbors",
    async (selection) => {
      const repository = await fixtureRepository();
      const commands: GraphCommandReceipt[] = [];
      const inspection = await inspectGraph(
        requestWithRelationship(
          await fakeExecutable("legacy-selection"),
          repository.root,
          repository.first,
          { selection },
        ),
        { onCommand: (receipt) => commands.push(receipt) },
      );
      expect(inspection.query.kind).toBe("success");
      expect(inspection.relationships[0]?.outcome).toEqual({
        kind: "unavailable",
        reason: "unsupported_selection",
        selection,
        relation: "CALLS",
      });
      expect(
        commands.filter(({ stage }) => stage.startsWith("relationship:")),
      ).toEqual([]);
    },
  );

  test.each([
    "selection-forged-mode",
    "selection-forged-set",
    "selection-duplicate-set",
    "selection-edge-outside",
  ])("rejects provider selection breach %s", async (mode) => {
    const repository = await fixtureRepository();
    const inspection = await inspectGraph(
      requestWithRelationship(
        await fakeExecutable(mode),
        repository.root,
        repository.first,
        { selection: "exact" },
      ),
    );
    expect(inspection.query.kind).toBe("success");
    expect(inspection.relationships[0]?.outcome.kind).toBe("error");
  });

  test("exact selection preserves literal CALLS and source diagnostics", async () => {
    const repository = await fixtureRepository();
    const result = relationship(
      await inspectGraph(
        requestWithRelationship(
          await fakeExecutable("relationship-diagnostics"),
          repository.root,
          repository.first,
          { selection: "exact" },
        ),
      ),
    );
    expect({
      selection: result.selection,
      selectedRelations: result.selectedRelations,
      relations: result.observations.map(({ relation }) => relation),
    }).toEqual({
      selection: "exact",
      selectedRelations: ["CALLS"],
      relations: ["CALLS"],
    });
    expect(result.partialFailures.length).toBeGreaterThan(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  test("family observations use each actual relation's language capability", async () => {
    const repository = await fixtureRepository();
    const result = relationship(
      await inspectGraph(
        request(
          await fakeExecutable("unsupported-constructs"),
          repository.root,
          repository.first,
        ),
      ),
    );
    expect(result.observations.map(({ relation }) => relation)).toEqual([
      "CALLS",
      "CONSTRUCTS",
    ]);
    expect(result.limitations).toContainEqual({
      kind: "unsupported_relation_for_language",
      subject: "relationship_endpoint",
      language: "FixtureLanguage",
      relation: "CONSTRUCTS",
    });
  });
  test("awaits retrieval delivery before starting relationship commands", async () => {
    const repository = await fixtureRepository();
    const executable = await fakeExecutable("valid");
    const receipts: GraphCommandReceipt[] = [];
    const events: string[] = [];
    let release = (): void => {};
    const held = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    let retrievalReady = (): void => {};
    const retrievalObserved = new Promise<void>((resolvePromise) => {
      retrievalReady = resolvePromise;
    });
    const running = runGraphInspection(
      request(executable, repository.root, repository.first),
      {
        onCommand: (receipt) => receipts.push(receipt),
        emit: async (event) => {
          events.push(event.kind);
          if (event.kind === "retrieval") {
            retrievalReady();
            await held;
          }
        },
      },
    );
    await retrievalObserved;
    expect(
      receipts.filter(({ stage }) => stage.startsWith("relationship:")),
    ).toEqual([]);
    release();
    await running;
    expect(events).toEqual(["retrieval", "relationship", "complete"]);
  });

  test("cleans the isolated view when retrieval delivery fails", async () => {
    const repository = await fixtureRepository();
    let view = "";
    await expect(
      runGraphInspection(
        request(
          await fakeExecutable("valid"),
          repository.root,
          repository.first,
        ),
        {
          onTemporaryView: ({ path }) => {
            view = path;
          },
          emit: async (event) => {
            if (event.kind === "retrieval") throw new Error("output closed");
          },
        },
      ),
    ).rejects.toThrow("output closed");
    expect(view).not.toBe("");
    expect(await pathExists(view)).toBe(false);
  });

  test("emits completion only after isolated-view cleanup", async () => {
    const repository = await fixtureRepository();
    let view = "";
    const events: string[] = [];
    await runGraphInspection(
      request(await fakeExecutable("valid"), repository.root, repository.first),
      {
        onTemporaryView: ({ path }) => {
          view = path;
        },
        emit: async (event) => {
          events.push(event.kind);
          if (event.kind === "complete") {
            expect(await pathExists(view)).toBe(false);
          }
        },
      },
    );
    expect(events).toEqual(["retrieval", "relationship", "complete"]);
  });

  test("an evidence failure after setup prevents completion", async () => {
    const repository = await fixtureRepository();
    let view = "";
    const events: string[] = [];
    await expect(
      runGraphInspection(
        request(
          await fakeExecutable("valid"),
          repository.root,
          repository.first,
        ),
        {
          onTemporaryView: ({ path }) => {
            view = path;
          },
          onCommand: ({ stage }) => {
            if (stage === "query") throw new Error("evidence sink failed");
          },
          emit: async (event) => {
            events.push(event.kind);
          },
        },
      ),
    ).rejects.toThrow("Graph inspection evidence recording or cleanup failed");
    expect(events).toEqual(["retrieval", "relationship"]);
    expect(await pathExists(view)).toBe(false);
  });

  test("cancellation kills a blocked neighbor, skips later work, and cleans the view", async () => {
    const repository = await fixtureRepository();
    const executable = await fakeExecutable("blocked-neighbor");
    const base = request(executable, repository.root, repository.first);
    const first = base.relationships[0];
    if (first === undefined) throw new Error("fixture relationship missing");
    const controller = new AbortController();
    const events: string[] = [];
    let view = "";
    const running = runGraphInspection(
      {
        ...base,
        relationships: [first, { ...first, id: "second-relationship" }],
      },
      {
        signal: controller.signal,
        onTemporaryView: ({ path }) => {
          view = path;
        },
        emit: async (event) => {
          events.push(event.kind);
        },
      },
    );
    const started = join(dirname(executable), "neighbor-started");
    await waitForFile(started);
    const blockedPid = Number((await Bun.file(started).text()).trim());
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(events).toEqual(["retrieval"]);
    expect(view).not.toBe("");
    expect(await pathExists(view)).toBe(false);
    expect(() => process.kill(blockedPid, 0)).toThrow();
  });

  test("inspects one arbitrary revision and qualifies every returned location", async () => {
    const repository = await fixtureRepository();
    const receipts: GraphCommandReceipt[] = [];
    const inspection = await inspectGraph(
      request(await fakeExecutable("valid"), repository.root, repository.first),
      { onCommand: (receipt) => receipts.push(receipt) },
    );
    expect(String(inspection.source.repository)).toBe(resolve(repository.root));
    expect(String(inspection.source.revision)).toBe(repository.first);
    expect(success(inspection.query).results[0]).toMatchObject({
      language: "FixtureLanguage",
      source: {
        kind: "range",
        path: "source.custom",
        startLine: 1,
        endLine: 5,
      },
    });
    expect(relationship(inspection).observations[0]).toMatchObject({
      relation: "CALLS",
      to: { location: { kind: "range", path: "other.custom" } },
      evidence: [{ location: { kind: "range", path: "source.custom" } }],
    });
    expect(receipts.some(({ stdout }) => stdout.includes("alpha\nbeta"))).toBe(
      false,
    );
    expect(
      receipts
        .filter(({ stage }) => stage.includes(":content"))
        .map(({ stdout }) => stdout),
    ).toEqual([
      "<source bytes omitted; length=31>",
      "<source bytes omitted; length=19>",
    ]);
  });

  test.each([
    ["malformed-version", "provider is required"],
    ["wrong-version-provider", "provider must be entire-graph"],
    ["malformed-capabilities", "schema_version"],
    ["wrong-capabilities-provider", "provider must be entire-graph"],
  ])("rejects global %s failure after cleanup", async (mode, message) => {
    const repository = await fixtureRepository();
    let view = "";
    await expect(
      inspectGraph(
        request(await fakeExecutable(mode), repository.root, repository.first),
        { onTemporaryView: ({ path }) => (view = path) },
      ),
    ).rejects.toThrow(message);
    expect(
      run(["git", "worktree", "list", "--porcelain"], repository.root),
    ).not.toContain(view);
  });

  test("keeps query and relationship outcomes independent", async () => {
    const repository = await fixtureRepository();
    const badQuery = await inspectGraph(
      request(
        await fakeExecutable("malformed-query"),
        repository.root,
        repository.first,
      ),
    );
    expect(badQuery.query.kind).toBe("error");
    expect(badQuery.relationships[0]?.outcome.kind).toBe("success");

    const badRelationship = await inspectGraph(
      request(
        await fakeExecutable("malformed-neighbor"),
        repository.root,
        repository.first,
      ),
    );
    expect(badRelationship.query.kind).toBe("success");
    expect(badRelationship.relationships[0]?.outcome.kind).toBe("error");
  });

  test("keeps failed-command streams in receipts instead of section errors", async () => {
    const repository = await fixtureRepository();
    const receipts: GraphCommandReceipt[] = [];
    const inspection = await inspectGraph(
      request(
        await fakeExecutable("hostile-streams"),
        repository.root,
        repository.first,
        false,
      ),
      { onCommand: (receipt) => receipts.push(receipt) },
    );
    expect(inspection.query).toEqual({
      kind: "error",
      error: { message: "Neuve Graph query observation unavailable." },
    });
    expect(JSON.stringify(inspection.query)).not.toContain("HOSTILE_");
    expect(receipts.find(({ stage }) => stage === "query")).toMatchObject({
      stdout: "HOSTILE_STDOUT_RECEIPT\n",
      stderr: "HOSTILE_STDERR_RECEIPT\n",
      exitCode: 23,
    });
  });

  test.each(["wrong-repository", "wrong-revision", "wrong-tree"])(
    "captures query provenance mismatch %s",
    async (mode) => {
      const repository = await fixtureRepository();
      const inspection = await inspectGraph(
        request(
          await fakeExecutable(mode),
          repository.root,
          repository.first,
          false,
        ),
      );
      expect(inspection.query).toEqual({
        kind: "error",
        error: { message: "Neuve Graph query observation unavailable." },
      });
    },
  );

  test.each([
    "neighbor-wrong-repository",
    "neighbor-wrong-revision",
    "neighbor-wrong-tree",
    "wrong-relation",
    "wrong-direction",
    "wrong-first-query",
    "wrong-first-file",
    "wrong-stable-query",
  ])("captures relationship contract mismatch %s", async (mode) => {
    const repository = await fixtureRepository();
    const inspection = await inspectGraph(
      request(await fakeExecutable(mode), repository.root, repository.first),
    );
    expect(inspection.relationships[0]?.outcome).toEqual({
      kind: "error",
      error: {
        message: "Neuve Graph relationship observation unavailable.",
      },
    });
    expect(inspection.query.kind).toBe("success");
  });

  test("rejects a wrong echoed line on the first relationship request", async () => {
    const repository = await fixtureRepository();
    const inspection = await inspectGraph(
      requestWithRelationship(
        await fakeExecutable("wrong-first-line"),
        repository.root,
        repository.first,
        { focus: { line: 2 } },
      ),
    );
    expect(inspection.relationships[0]?.outcome).toEqual({
      kind: "error",
      error: {
        message: "Neuve Graph relationship observation unavailable.",
      },
    });
  });

  test("a requested line outside the returned symbol range does not resolve", async () => {
    const repository = await fixtureRepository();
    const inspection = await inspectGraph(
      requestWithRelationship(
        await fakeExecutable("valid"),
        repository.root,
        repository.first,
        { focus: { line: 6 } },
      ),
    );
    expect(relationship(inspection).focus).toEqual({ kind: "not_found" });
  });

  test("orients inbound observations from the adjacent endpoint to the focus", async () => {
    const repository = await fixtureRepository();
    const inspection = await inspectGraph(
      requestWithRelationship(
        await fakeExecutable("valid"),
        repository.root,
        repository.first,
        { direction: "in" },
      ),
    );
    expect(relationship(inspection).observations[0]).toMatchObject({
      direction: "in",
      from: { name: "callee", location: { path: "other.custom" } },
      to: { name: "caller", location: { path: "source.custom" } },
    });
  });

  test.each(["ambiguous", "one-match-disambiguation"])(
    "preserves provider ambiguity for %s",
    async (mode) => {
      const repository = await fixtureRepository();
      expect(
        relationship(
          await inspectGraph(
            request(
              await fakeExecutable(mode),
              repository.root,
              repository.first,
            ),
          ),
        ).focus.kind,
      ).toBe("ambiguous");
    },
  );

  test("preserves actual CALLS-family relations and deduplicated diagnostics", async () => {
    const repository = await fixtureRepository();
    const mixed = relationship(
      await inspectGraph(
        request(
          await fakeExecutable("mixed-relations"),
          repository.root,
          repository.first,
        ),
      ),
    );
    expect(mixed.observations.map(({ relation }) => relation)).toEqual([
      "CALLS",
      "CONSTRUCTS",
    ]);

    const diagnostics = relationship(
      await inspectGraph(
        request(
          await fakeExecutable("relationship-diagnostics"),
          repository.root,
          repository.first,
        ),
      ),
    );
    expect({
      truncated: diagnostics.truncated,
      warnings: diagnostics.warnings.length,
      failures: diagnostics.partialFailures.length,
    }).toEqual({ truncated: true, warnings: 1, failures: 1 });
  });

  test.each<readonly [string, unknown]>([
    ["external-absent", { kind: "absent" }],
    ["external-path", { kind: "path", path: "vendor/api" }],
    ["external-point", { kind: "point", path: "vendor/api", line: 2 }],
    [
      "external-range",
      { kind: "range", path: "vendor/api", startLine: 2, endLine: 3 },
    ],
  ])("preserves %s external location", async (mode, expected) => {
    const repository = await fixtureRepository();
    const endpoint = relationship(
      await inspectGraph(
        request(await fakeExecutable(mode), repository.root, repository.first),
      ),
    ).observations[0]?.to;
    expect(JSON.stringify(endpoint?.location)).toBe(JSON.stringify(expected));
  });

  test("preserves budget loss, optional language, and capability limitations", async () => {
    const repository = await fixtureRepository();
    const budget = success(
      (
        await inspectGraph(
          request(
            await fakeExecutable("budget-loss"),
            repository.root,
            repository.first,
            false,
          ),
        )
      ).query,
    );
    expect(budget.budget).toMatchObject({
      queryConstraintsTruncated: true,
      resultsDroppedByBudget: 9,
      snippetsTruncatedByBudget: 4,
      requestedTopK: 8,
      returnedResults: 1,
    });

    const omitted = success(
      (
        await inspectGraph(
          request(
            await fakeExecutable("omitted-language"),
            repository.root,
            repository.first,
            false,
          ),
        )
      ).query,
    );
    expect(omitted.results[0]?.language).toBeNull();
    expect(omitted.limitations).toEqual([
      { kind: "unclassified_language", subject: "query_result" },
    ]);

    const undeclared = success(
      (
        await inspectGraph(
          request(
            await fakeExecutable("undeclared-language"),
            repository.root,
            repository.first,
            false,
          ),
        )
      ).query,
    );
    expect(undeclared.limitations).toEqual([
      {
        kind: "undeclared_language",
        subject: "query_result",
        language: "OtherLanguage",
      },
    ]);
  });

  test("preserves the actual rank-6 partial symbol shape without fabrication", async () => {
    const repository = await fixtureRepository();
    const query = success(
      (
        await inspectGraph(
          request(
            await fakeExecutable("partial-symbol-rank-6"),
            repository.root,
            repository.first,
            false,
          ),
        )
      ).query,
    );
    expect(JSON.parse(JSON.stringify(query.results[5]))).toEqual({
      kind: "partial_symbol",
      language: null,
      source: {
        kind: "range",
        path: "source.custom",
        startLine: 1,
        endLine: 5,
      },
      symbolKind: "function",
      qualifiedName: "grepTermPaths",
      containedCallables: { kind: "unavailable" },
    });
  });

  test("preserves contained callable identity without flattening the ranking", async () => {
    const repository = await fixtureRepository();
    for (const [mode, expected] of [
      ["contained-callables", { kind: "complete" }],
      ["contained-callables-truncated", { kind: "truncated", dropped: 2 }],
    ] as const) {
      const query = success(
        (
          await inspectGraph(
            request(
              await fakeExecutable(mode),
              repository.root,
              repository.first,
              false,
            ),
          )
        ).query,
      );
      expect(query.results).toHaveLength(1);
      expect(query.containedCallableCoverage).toBe(expected.kind);
      const manifest = query.results[0]?.containedCallables;
      expect(manifest?.kind).toBe(expected.kind);
      if (manifest === undefined || manifest.kind === "unavailable")
        throw new Error("contained manifest unavailable");
      expect(manifest.items).toHaveLength(1);
      const item = manifest.items[0];
      expect(String(item?.providerId)).toBe("opaque:id:one");
      expect(item?.kind).toBe("symbol");
      expect(item?.language).toBe("FixtureLanguage");
      expect(item?.source.kind).toBe("range");
      expect(String(item?.source.path)).toBe("source.custom");
      expect(item?.source.startLine).toBe(2);
      expect(item?.source.endLine).toBe(3);
      expect(item?.symbol).toBe("nested");
      expect(item?.symbolKind).toBe("function");
      expect(item?.qualifiedName).toBe("nested");
      if (manifest.kind === "truncated") expect(manifest.dropped).toBe(2);
    }
  });

  test.each([
    "contained-callables-empty-id",
    "contained-callables-ledger-duplicate",
    "contained-callables-ledger-zero",
    "contained-callables-ledger-mismatch",
    "contained-callables-ledger-out-of-range",
    "contained-callables-duplicate-id",
    "contained-callables-out-of-order",
    "contained-callables-top-level-id",
    "query-noncontiguous-rank",
  ])("rejects invalid contained callable provenance for %s", async (mode) => {
    const repository = await fixtureRepository();
    const inspection = await inspectGraph(
      request(
        await fakeExecutable(mode),
        repository.root,
        repository.first,
        false,
      ),
    );
    expect(inspection.query).toEqual({
      kind: "error",
      error: { message: "Neuve Graph query observation unavailable." },
    });
  });

  test("preserves query diagnostics directly", async () => {
    const repository = await fixtureRepository();
    const query = success(
      (
        await inspectGraph(
          request(
            await fakeExecutable("diagnostics"),
            repository.root,
            repository.first,
            false,
          ),
        )
      ).query,
    );
    expect(
      JSON.parse(
        JSON.stringify({
          coverage: query.coverage,
          warnings: query.warnings,
          partialFailures: query.partialFailures,
        }),
      ),
    ).toEqual({
      coverage: "degraded",
      warnings: [
        {
          kind: "provider",
          code: "W_FIXTURE",
          severity: "warning",
          filePath: "source.custom",
          language: "FixtureLanguage",
          effectOnCompleteness: "fixture warning",
          detail: "preserved",
        },
      ],
      partialFailures: [
        {
          kind: "provider",
          code: "E_FIXTURE",
          severity: "error",
          filePath: "source.custom",
          language: "FixtureLanguage",
          effectOnCompleteness: "fixture warning",
          detail: "preserved",
        },
      ],
    });
  });

  test.each([
    "language-neutral",
    "colon-path",
    "leading-colon-path",
    "magic-glob-path",
    "whitespace-path",
  ])("qualifies valid unusual committed paths for %s", async (mode) => {
    const repository = await fixtureRepository();
    success(
      (
        await inspectGraph(
          request(
            await fakeExecutable(mode),
            repository.root,
            repository.first,
            false,
          ),
        )
      ).query,
    );
  });

  test.each([
    "query-nonexistent",
    "query-tree",
    "query-symlink",
    "query-out-of-range",
  ])("rejects invalid query source %s", async (mode) => {
    const repository = await fixtureRepository();
    const inspection = await inspectGraph(
      request(
        await fakeExecutable(mode),
        repository.root,
        repository.first,
        false,
      ),
    );
    expect(inspection.query).toEqual({
      kind: "error",
      error: { message: "Neuve Graph query observation unavailable." },
    });
  });

  // Why: the Entire baseline (5637039f) reports a symbol that ends on a file's last line as ending
  // one line past it, and refusing the whole observation for that lost every other result. Only
  // that exact overrun is clamped, and it is reported, never silent; larger overruns still refuse.
  test("clamps a query result that ends exactly one line past end of file and reports it", async () => {
    const repository = await fixtureRepository();
    const inspection = await inspectGraph(
      request(
        await fakeExecutable("query-end-past-eof"),
        repository.root,
        repository.first,
        false,
      ),
    );
    const query = success(inspection.query);
    expect(
      query.results.map((result) => [
        String(result.source.path),
        result.source.startLine,
        result.source.endLine,
      ]),
    ).toEqual([
      ["source.custom", 1, 5],
      ["extensionless", 1, 2],
    ]);
    expect(
      query.normalizations?.map((entry) => ({
        ...entry,
        path: String(entry.path),
      })),
    ).toEqual([
      {
        kind: "end-line-past-eof",
        resultIndex: 1,
        path: "extensionless",
        reportedEndLine: 3,
        endLine: 2,
      },
    ]);
  });

  test.each([
    "endpoint-nonexistent",
    "endpoint-out-of-range",
    "evidence-nonexistent",
    "evidence-out-of-range",
  ])(
    "rejects invalid relationship provenance %s without erasing query evidence",
    async (mode) => {
      const repository = await fixtureRepository();
      const inspection = await inspectGraph(
        request(await fakeExecutable(mode), repository.root, repository.first),
      );
      expect(inspection.query.kind).toBe("success");
      expect(inspection.relationships[0]?.outcome.kind).toBe("error");
    },
  );

  test("a worktree-removal failure suppresses completion while recovery removes the view", async () => {
    const repository = await fixtureRepository();
    const temporaryParent = await mkdtemp(
      join(tmpdir(), "neuve-cleanup-failure-"),
    );
    roots.push(temporaryParent);
    const wrapperRoot = await mkdtemp(join(tmpdir(), "neuve-git-wrapper-"));
    roots.push(wrapperRoot);
    const gitPath = join(wrapperRoot, "git");
    const realGit = run(["which", "git"], repository.root);
    await Bun.write(
      gitPath,
      `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args.includes("worktree") && args.includes("remove")) {
  console.error("forced worktree removal failure");
  process.exit(91);
}
const child = Bun.spawnSync([${JSON.stringify(realGit)}, ...args], { stdin: "inherit", stdout: "pipe", stderr: "pipe" });
process.stdout.write(child.stdout);
process.stderr.write(child.stderr);
process.exit(child.exitCode ?? 1);
`,
    );
    await chmod(gitPath, 0o755);
    const executable = await fakeExecutable("valid");
    const harness = join(wrapperRoot, "cleanup-harness.ts");
    await Bun.write(
      harness,
      `import { readdir, stat } from "node:fs/promises";
import { runGraphInspection } from ${JSON.stringify(resolve(import.meta.dir, "../src/index.ts"))};
const receipts = [];
const events = [];
let view = "";
let failure;
try {
  await runGraphInspection(${JSON.stringify(request(executable, repository.root, repository.first))}, {
    temporaryParent: ${JSON.stringify(temporaryParent)},
    onTemporaryView: ({ path }) => { view = path; },
    onCommand: (receipt) => receipts.push(receipt),
    emit: async (event) => {
      events.push(event.kind);
    },
  });
} catch (error) {
  failure = error;
}
const messages = (value) => value instanceof AggregateError ? value.errors.flatMap(messages) : [value instanceof Error ? value.message : String(value)];
const viewExists = await stat(view).then(() => true, () => false);
const worktrees = Bun.spawnSync([${JSON.stringify(realGit)}, "-C", ${JSON.stringify(repository.root)}, "worktree", "list", "--porcelain"]).stdout.toString();
const failureMessages = messages(failure);
console.log(JSON.stringify({
  removalFailureRetained: failureMessages.some((message) => message.includes("Git isolated view removal exited")),
  removeExitCode: receipts.find(({ stage }) => stage === "worktree_remove")?.exitCode,
  recoveryPruned: receipts.some(({ stage }) => stage === "worktree_prune"),
  events,
  viewCaptured: view !== "",
  viewExists,
  temporaryChildren: await readdir(${JSON.stringify(temporaryParent)}),
  registrationRemains: worktrees.includes(view),
}));
`,
    );
    const child = Bun.spawn([process.execPath, harness], {
      cwd: repository.root,
      env: {
        ...process.env,
        PATH: `${wrapperRoot}:${process.env.PATH ?? ""}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(JSON.parse(stdout)).toEqual({
      removalFailureRetained: true,
      removeExitCode: 91,
      recoveryPruned: true,
      events: ["retrieval", "relationship"],
      viewCaptured: true,
      viewExists: false,
      temporaryChildren: [],
      registrationRemains: false,
    });
  });

  test("a throwing worktree-add recorder cannot leak registration", async () => {
    const repository = await fixtureRepository();
    const temporaryParent = await mkdtemp(
      join(tmpdir(), "neuve-recorder-failure-"),
    );
    roots.push(temporaryParent);
    let view = "";
    await expect(
      inspectGraph(
        request(
          await fakeExecutable("valid"),
          repository.root,
          repository.first,
          false,
        ),
        {
          temporaryParent,
          onTemporaryView: ({ path }) => {
            view = path;
          },
          onCommand: ({ stage }) => {
            if (stage === "worktree_add")
              throw new Error("receipt recorder failed");
          },
        },
      ),
    ).rejects.toThrow("evidence recording or cleanup failed");
    expect(view).not.toBe("");
    await expect(stat(view)).rejects.toThrow();
    expect(
      run(["git", "worktree", "list", "--porcelain"], repository.root),
    ).not.toContain(view);
    expect(await readdir(temporaryParent)).toEqual([]);
  });

  test("cancellation after a side-effected worktree add removes its registration", async () => {
    const repository = await fixtureRepository();
    const temporaryParent = await mkdtemp(join(tmpdir(), "neuve-add-cancel-"));
    roots.push(temporaryParent);
    const wrapperRoot = await mkdtemp(join(tmpdir(), "neuve-git-wrapper-"));
    roots.push(wrapperRoot);
    const marker = join(wrapperRoot, "worktree-added");
    const gitPath = join(wrapperRoot, "git");
    const realGit = run(["which", "git"], repository.root);
    await Bun.write(
      gitPath,
      `#!/usr/bin/env bun
process.on("SIGTERM", () => process.exit(143));
const args = process.argv.slice(2);
if (args.includes("worktree") && args.includes("add")) {
  const child = Bun.spawnSync([${JSON.stringify(realGit)}, ...args], { stdin: "inherit", stdout: "pipe", stderr: "pipe" });
  process.stdout.write(child.stdout);
  process.stderr.write(child.stderr);
  if ((child.exitCode ?? 1) !== 0) process.exit(child.exitCode ?? 1);
  await Bun.write(${JSON.stringify(marker)}, "added");
  while (true) await Bun.sleep(10);
}
const child = Bun.spawnSync([${JSON.stringify(realGit)}, ...args], { stdin: "inherit", stdout: "pipe", stderr: "pipe" });
process.stdout.write(child.stdout);
process.stderr.write(child.stderr);
process.exit(child.exitCode ?? 1);
`,
    );
    await chmod(gitPath, 0o755);
    const harness = join(wrapperRoot, "add-cancel-harness.ts");
    await Bun.write(
      harness,
      `import { readdir, stat } from "node:fs/promises";
import { runGraphInspection } from ${JSON.stringify(resolve(import.meta.dir, "../src/index.ts"))};
const controller = new AbortController();
const events = [];
let view = "";
let failure;
const running = runGraphInspection(${JSON.stringify(request(await fakeExecutable("valid"), repository.root, repository.first, false))}, {
  temporaryParent: ${JSON.stringify(temporaryParent)},
  signal: controller.signal,
  onTemporaryView: ({ path }) => { view = path; },
  emit: async (event) => { events.push(event.kind); },
});
const deadline = Date.now() + 2_000;
while (!(await Bun.file(${JSON.stringify(marker)}).exists())) {
  if (Date.now() >= deadline) throw new Error("timed out waiting for side-effected add");
  await Bun.sleep(10);
}
controller.abort();
try {
  await running;
} catch (error) {
  failure = error;
}
const viewExists = await stat(view).then(() => true, () => false);
const worktrees = Bun.spawnSync([${JSON.stringify(realGit)}, "-C", ${JSON.stringify(repository.root)}, "worktree", "list", "--porcelain"]).stdout.toString();
console.log(JSON.stringify({
  failureName: failure instanceof Error ? failure.name : "",
  events,
  viewCaptured: view !== "",
  viewExists,
  temporaryChildren: await readdir(${JSON.stringify(temporaryParent)}),
  registrationRemains: worktrees.includes(view),
}));
`,
    );
    const child = Bun.spawn([process.execPath, harness], {
      cwd: repository.root,
      env: {
        ...process.env,
        PATH: `${wrapperRoot}:${process.env.PATH ?? ""}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(JSON.parse(stdout)).toEqual({
      failureName: "AbortError",
      events: [],
      viewCaptured: true,
      viewExists: false,
      temporaryChildren: [],
      registrationRemains: false,
    });
  });

  test("a genuine worktree-add failure is not relabeled as cleanup failure", async () => {
    const repository = await fixtureRepository();
    const temporaryParent = await mkdtemp(join(tmpdir(), "neuve-add-failure-"));
    roots.push(temporaryParent);
    const wrapperRoot = await mkdtemp(join(tmpdir(), "neuve-git-wrapper-"));
    roots.push(wrapperRoot);
    const gitPath = join(wrapperRoot, "git");
    const realGit = run(["which", "git"], repository.root);
    await Bun.write(
      gitPath,
      `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args.includes("worktree") && args.includes("add")) {
  console.error("forced worktree add failure");
  process.exit(92);
}
const child = Bun.spawnSync([${JSON.stringify(realGit)}, ...args], { stdin: "inherit", stdout: "pipe", stderr: "pipe" });
process.stdout.write(child.stdout);
process.stderr.write(child.stderr);
process.exit(child.exitCode ?? 1);
`,
    );
    await chmod(gitPath, 0o755);
    const harness = join(wrapperRoot, "add-failure-harness.ts");
    await Bun.write(
      harness,
      `import { readdir, stat } from "node:fs/promises";
import { runGraphInspection } from ${JSON.stringify(resolve(import.meta.dir, "../src/index.ts"))};
let view = "";
let failure;
try {
  await runGraphInspection(${JSON.stringify(request(await fakeExecutable("valid"), repository.root, repository.first, false))}, {
    temporaryParent: ${JSON.stringify(temporaryParent)},
    onTemporaryView: ({ path }) => { view = path; },
    emit: async () => {},
  });
} catch (error) {
  failure = error;
}
const messages = (value) => value instanceof AggregateError ? value.errors.flatMap(messages) : [value instanceof Error ? value.message : String(value)];
const failureMessages = messages(failure);
const worktrees = Bun.spawnSync([${JSON.stringify(realGit)}, "-C", ${JSON.stringify(repository.root)}, "worktree", "list", "--porcelain"]).stdout.toString();
console.log(JSON.stringify({
  addFailureRetained: failureMessages.some((message) => message.includes("Git isolated view creation exited with 92")),
  misleadingCleanupFailure: failureMessages.some((message) => message.includes("Git isolated view removal")),
  viewCaptured: view !== "",
  viewExists: await stat(view).then(() => true, () => false),
  temporaryChildren: await readdir(${JSON.stringify(temporaryParent)}),
  registrationRemains: worktrees.includes(view),
}));
`,
    );
    const child = Bun.spawn([process.execPath, harness], {
      cwd: repository.root,
      env: {
        ...process.env,
        PATH: `${wrapperRoot}:${process.env.PATH ?? ""}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(JSON.parse(stdout)).toEqual({
      addFailureRetained: true,
      misleadingCleanupFailure: false,
      viewCaptured: true,
      viewExists: false,
      temporaryChildren: [],
      registrationRemains: false,
    });
  });

  test("isolates concurrent inspections", async () => {
    const repository = await fixtureRepository();
    const executable = await fakeExecutable("valid");
    const views: string[] = [];
    await Promise.all([
      inspectGraph(
        request(executable, repository.root, repository.first, false),
        { onTemporaryView: ({ path }) => views.push(path) },
      ),
      inspectGraph(
        request(executable, repository.root, repository.first, false),
        { onTemporaryView: ({ path }) => views.push(path) },
      ),
    ]);
    expect(new Set(views).size).toBe(2);
    await Promise.all(
      views.map((path) => expect(stat(path)).rejects.toThrow()),
    );
  });
});
