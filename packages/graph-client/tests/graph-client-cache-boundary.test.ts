import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import {
  chmod,
  mkdir,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  inspectGraph,
  runGraphInspection,
  type GraphCommandReceipt,
  type GraphCommandUsage,
} from "../src/index.ts";
import {
  removeRoots,
  run,
  waitForFile,
  pathExists,
  fixtureRepository,
  fakeExecutable,
  request,
  success,
  relationship,
} from "./graph-client-support.ts";

afterEach(removeRoots);

describe("committed cache boundary", () => {
  test.each([
    "prepared-receipt-missing",
    "prepared-foreign-producer",
    "prepared-foreign-owner",
    "prepared-foreign-scope",
    "prepared-invalid-policy",
    "prepared-invented-generation",
    "prepared-false-origin",
  ])(
    "exact prepared %s rejects qualified receipt without source views",
    async (mode) => {
      const repository = await fixtureRepository();
      const commands: GraphCommandReceipt[] = [];
      const views: string[] = [];
      const before = run(
        ["git", "worktree", "list", "--porcelain"],
        repository.root,
      );
      const observed = await inspectGraph(
        {
          ...request(
            await fakeExecutable(mode),
            repository.root,
            repository.first,
          ),
          cache: "prepared",
        },
        {
          onCommand: (c) => commands.push(c),
          onTemporaryView: (v) => views.push(v.path),
        },
      );
      expect(observed.query).toMatchObject({
        kind: "error",
        error: { preparedFailure: "incompatible-artifact" },
      });
      expect(views).toEqual([]);
      expect(
        commands.some(
          (c) => c.stage.startsWith("worktree_") || c.stage === "index",
        ),
      ).toBe(false);
      expect(
        run(["git", "worktree", "list", "--porcelain"], repository.root),
      ).toBe(before);
      expect(run(["git", "rev-parse", "HEAD"], repository.root)).toBe(
        repository.second,
      );
    },
  );

  test("a provider lacking exact prepared capability refuses without source views or query commands", async () => {
    const repository = await fixtureRepository();
    const commands: GraphCommandReceipt[] = [];
    const observed = await inspectGraph(
      {
        ...request(
          await fakeExecutable("prepared-no-exact-capability"),
          repository.root,
          repository.first,
        ),
        cache: "prepared",
      },
      { onCommand: (c) => commands.push(c) },
    );
    expect(observed.query).toMatchObject({
      kind: "error",
      error: { preparedFailure: "unsupported-provider" },
    });
    expect(
      commands.some(
        (c) =>
          c.stage.startsWith("worktree_") ||
          c.stage === "index" ||
          c.stage === "query" ||
          c.stage.startsWith("relationship:"),
      ),
    ).toBe(false);
  });

  test("syntax-generation identity is explicit; unsupported CALLS is not downgraded", async () => {
    const repository = await fixtureRepository();
    const commands: GraphCommandReceipt[] = [];
    const observed = await inspectGraph(
      {
        ...request(
          await fakeExecutable("prepared-syntax-generation"),
          repository.root,
          repository.first,
        ),
        cache: "prepared",
        profile: "syntax-only",
      },
      { onCommand: (c) => commands.push(c) },
    );
    expect(success(observed.query)).toMatchObject({
      profile: "syntax-only",
      preparedRead: {
        artifactFamily: "syntax-generation",
        generationId: "b".repeat(64),
        policyId: "a".repeat(64),
        externalPolicyOrigin: "serving-directory-captured",
        gitignoreOrigin: "target-commit",
      },
    });
    expect(observed.relationships[0]?.outcome.kind).toBe("error");
    expect(
      commands.filter(
        (c) =>
          c.stage.startsWith("relationship:") &&
          c.stage.endsWith(":observation"),
      ),
    ).toHaveLength(0);
    expect(commands.find((c) => c.stage === "query")?.argv).toContain(
      "syntax-only",
    );
  });

  test("syntax legacy snapshot has no fabricated generation ID", async () => {
    const repository = await fixtureRepository();
    const observed = await inspectGraph({
      ...request(
        await fakeExecutable("prepared-valid"),
        repository.root,
        repository.first,
      ),
      cache: "prepared",
      profile: "syntax-only",
      relationships: [],
    });
    expect(success(observed.query)).toMatchObject({
      profile: "syntax-only",
      preparedRead: { artifactFamily: "search-snapshot" },
    });
    expect(success(observed.query).preparedRead).not.toHaveProperty(
      "generationId",
    );
  });

  test("syntax-generation receipt cannot qualify full profile", async () => {
    const repository = await fixtureRepository();
    const observed = await inspectGraph({
      ...request(
        await fakeExecutable("prepared-syntax-generation"),
        repository.root,
        repository.first,
      ),
      cache: "prepared",
    });
    expect(observed.query).toMatchObject({
      kind: "error",
      error: { preparedFailure: "incompatible-artifact" },
    });
  });

  test("prepared profile mismatch is a qualified artifact refusal", async () => {
    const repository = await fixtureRepository();
    const observed = await inspectGraph({
      ...request(
        await fakeExecutable("prepared-profile-forged"),
        repository.root,
        repository.first,
      ),
      cache: "prepared",
      profile: "syntax-only",
      relationships: [],
    });
    expect(observed.query).toMatchObject({
      kind: "error",
      error: { preparedFailure: "incompatible-artifact" },
    });
  });

  test("explicit syntax containment preserves its actual relation", async () => {
    const repository = await fixtureRepository();
    const base = request(
      await fakeExecutable("prepared-syntax-generation"),
      repository.root,
      repository.first,
    );
    const plan = base.relationships[0];
    if (plan === undefined) throw Error("Fixture plan missing");
    const observed = await inspectGraph({
      ...base,
      cache: "prepared",
      profile: "syntax-only",
      relationships: [{ ...plan, relation: "CONTAINS" }],
    });
    const contained = relationship(observed);
    expect(contained.profile).toBe("syntax-only");
    expect(contained.selectedRelations).toEqual(["CONTAINS"]);
    expect(contained.observations[0]?.relation).toBe("CONTAINS");
    expect(contained.preparedRead?.artifactFamily).toBe("syntax-generation");
  });

  test("policy drift across prepared query and relationship is rejected", async () => {
    const repository = await fixtureRepository();
    const observed = await inspectGraph({
      ...request(
        await fakeExecutable("prepared-policy-drift"),
        repository.root,
        repository.first,
      ),
      cache: "prepared",
    });
    expect(observed.query.kind).toBe("success");
    expect(observed.relationships[0]?.outcome).toMatchObject({
      kind: "error",
      error: { preparedFailure: "incompatible-artifact" },
    });
  });

  test("syntax or moving prepared selectors are rejected before native dispatch", async () => {
    const repository = await fixtureRepository();
    const base = request(
      await fakeExecutable("prepared-valid"),
      repository.root,
      repository.first,
    );
    await expect(
      inspectGraph({ ...base, profile: "syntax-only" }),
    ).rejects.toThrow("syntax-only requires exact prepared reads");
    await expect(
      inspectGraph({ ...base, cache: "prepared", revision: "HEAD" }),
    ).rejects.toThrow("exact full commit OID");
  });
  test("prepared reads require declared support and confirmed complete scope without index", async () => {
    const repository = await fixtureRepository();
    const receipts: GraphCommandReceipt[] = [];
    const input = request(
      await fakeExecutable("prepared-valid"),
      repository.root,
      repository.first,
    );
    const result = await inspectGraph(
      { ...input, cache: "prepared" },
      { onCommand: (receipt) => receipts.push(receipt) },
    );
    expect(success(result.query).cache).toMatchObject({
      status: "hit",
      analysisScope: "complete-prepared",
    });
    expect(relationship(result).cache).toMatchObject({
      status: "hit",
      analysisScope: "complete-prepared",
    });
    expect(receipts.some(({ stage }) => stage === "index")).toBe(false);
    const reads = receipts.filter(
      ({ stage }) =>
        stage === "query" ||
        (stage.startsWith("relationship:") &&
          (stage.endsWith(":resolution") || stage.endsWith(":observation"))),
    );
    expect(reads).toHaveLength(3);
    expect(reads.every(({ argv }) => argv.includes("--prepared-only"))).toBe(
      true,
    );
    const query = reads.find(({ stage }) => stage === "query");
    expect(query?.argv[(query?.argv.indexOf("--query") ?? -1) + 1]).toBe(
      input.question,
    );
    expect(receipts.some(({ stage }) => stage.startsWith("worktree_"))).toBe(
      false,
    );
    expect(
      reads.every(
        ({ argv }) =>
          argv.includes(repository.root) &&
          !argv.includes("--head") &&
          argv[argv.indexOf("--commit") + 1] === repository.first,
      ),
    ).toBe(true);
    expect(run(["git", "rev-parse", "HEAD"], repository.root)).toBe(
      repository.second,
    );
    expect(success(result.query).profile).toBe("full");
    expect(success(result.query).preparedRead?.artifactFamily).toBe(
      "search-snapshot",
    );
  });

  test.each([
    ["prepared-unsupported", "unsupported-provider"],
    ["prepared-query-unconfirmed", "unconfirmed-prepared-read"],
    ["prepared-missing", "missing"],
  ])(
    "prepared %s preserves explicit failure and never indexes",
    async (mode, reason) => {
      const repository = await fixtureRepository();
      const receipts: GraphCommandReceipt[] = [];
      const result = await inspectGraph(
        {
          ...request(
            await fakeExecutable(mode),
            repository.root,
            repository.first,
          ),
          cache: "prepared",
        },
        { onCommand: (receipt) => receipts.push(receipt) },
      );
      expect(result.query).toMatchObject({
        kind: "error",
        error: { preparedFailure: reason },
      });
      expect(receipts.some(({ stage }) => stage === "index")).toBe(false);
      if (mode === "prepared-unsupported")
        expect(
          receipts.some(
            ({ stage }) =>
              stage === "query" || stage.startsWith("relationship:"),
          ),
        ).toBe(false);
    },
  );

  test("prepared neighbor must confirm its own read scope", async () => {
    const repository = await fixtureRepository();
    const result = await inspectGraph({
      ...request(
        await fakeExecutable("prepared-neighbor-unconfirmed"),
        repository.root,
        repository.first,
      ),
      cache: "prepared",
    });
    expect(result.query.kind).toBe("success");
    expect(result.relationships[0]?.outcome).toMatchObject({
      kind: "error",
      error: { preparedFailure: "unconfirmed-prepared-read" },
    });
  });

  test("prepared failure classification cannot echo hostile provider diagnostics", async () => {
    const repository = await fixtureRepository();
    const result = await inspectGraph({
      ...request(
        await fakeExecutable("prepared-hostile-error"),
        repository.root,
        repository.first,
      ),
      cache: "prepared",
    });
    expect(result.query).toEqual({
      kind: "error",
      error: { message: "Neuve Graph query observation unavailable." },
    });
    expect(JSON.stringify(result)).not.toContain("HOSTILE_PRIVATE_VALUE");
  });
  test("verifies the reported executable digest against the owned copy", async () => {
    const repository = await fixtureRepository();
    const executable = await fakeExecutable("reported-build-identity");
    const expected = createHash("sha256")
      .update(await Bun.file(executable).bytes())
      .digest("hex");
    const result = await inspectGraph(
      request(executable, repository.root, repository.first, false),
    );
    expect(result.provider.executable).toEqual({
      sha256: expected,
      buildIdentity: "verified",
    });
    expect(result.query).toMatchObject({
      kind: "success",
      value: { results: [{ symbol: "caller" }] },
    });
  });

  test("cancelling a blocked refresh removes its owned view before any retrieval", async () => {
    const repository = await fixtureRepository();
    const executable = await fakeExecutable("refresh-blocked");
    const controller = new AbortController();
    const events: string[] = [];
    let view = "";
    const pending = runGraphInspection(
      {
        ...request(executable, repository.root, repository.first),
        cache: "refresh",
      },
      {
        signal: controller.signal,
        onTemporaryView: (registration) => {
          view = registration.path;
        },
        emit: async (event) => {
          events.push(event.kind);
        },
      },
    );
    await waitForFile(join(dirname(executable), "index-started"));
    controller.abort();
    await expect(pending).rejects.toThrow("Graph inspection aborted.");
    expect(events).toEqual([]);
    expect(await pathExists(dirname(dirname(view)))).toBe(false);
    expect(
      run(["git", "worktree", "list", "--porcelain"], repository.root)
        .split("\n")
        .filter((line) => line.startsWith("worktree ")),
    ).toEqual([`worktree ${await realpath(repository.root)}`]);
  });

  test("an executable-copy failure removes its owned temporary directory", async () => {
    const repository = await fixtureRepository();
    let view = "";
    const events: string[] = [];
    await expect(
      runGraphInspection(
        request(
          join(repository.root, "missing-engine"),
          repository.root,
          repository.first,
        ),
        {
          onTemporaryView: (registration) => {
            view = registration.path;
          },
          emit: async (event) => {
            events.push(event.kind);
          },
        },
      ),
    ).rejects.toThrow("ENOENT");
    expect(events).toEqual([]);
    expect(await pathExists(dirname(dirname(view)))).toBe(false);
    expect(
      run(["git", "worktree", "list", "--porcelain"], repository.root)
        .split("\n")
        .filter((line) => line.startsWith("worktree ")),
    ).toEqual([`worktree ${await realpath(repository.root)}`]);
  });
  test.each([
    ["valid", "unreported", null],
    ["cache-hit", "hit", 7],
    ["cache-miss", "miss", 7],
  ] as const)(
    "normalizes %s query and final neighbor observations",
    async (mode, status, latency) => {
      const repository = await fixtureRepository();
      const receipts: GraphCommandReceipt[] = [];
      const result = await inspectGraph(
        request(await fakeExecutable(mode), repository.root, repository.first),
        {
          onCommand: (receipt) => receipts.push(receipt),
        },
      );
      expect(result.query).toMatchObject({
        kind: "success",
        value: {
          cache: { status, indexLatencyMs: latency },
          results: [{ symbol: "caller" }],
        },
      });
      expect(result.relationships[0]?.outcome).toMatchObject({
        kind: "success",
        value: {
          cache: {
            status: mode === "valid" ? "unreported" : "hit",
            indexLatencyMs: mode === "valid" ? null : 3,
          },
          focus: { kind: "resolved" },
          observations: [{ relation: "CALLS" }],
        },
      });
      const providerCommands = receipts.filter(
        ({ stage }) =>
          stage === "version" ||
          stage === "capabilities" ||
          stage === "query" ||
          stage.endsWith(":resolution") ||
          stage.endsWith(":observation"),
      );
      expect(
        providerCommands.every(({ argv }) => !argv.includes("--no-cache")),
      ).toBe(true);
    },
  );

  test.each([
    ["valid", null],
    ["indexed-files-zero", 0],
    ["indexed-files-selective", 384],
    ["indexed-files-max", 9_007_199_254_740_991],
  ] as const)("normalizes query population for %s", async (mode, count) => {
    const repository = await fixtureRepository();
    const result = await inspectGraph(
      request(await fakeExecutable(mode), repository.root, repository.first),
    );
    expect(result.query).toMatchObject({
      kind: "success",
      value: {
        indexedFileCount: count,
        coverage: "ok",
        results: [{ symbol: "caller" }],
      },
    });
    expect(result.relationships[0]?.outcome).toMatchObject({
      kind: "success",
      value: { observations: [{ relation: "CALLS" }] },
    });
  });

  test.each([
    "indexed-files-null",
    "indexed-files-string",
    "indexed-files-negative",
    "indexed-files-fraction",
    "indexed-files-unsafe",
  ])("rejects malformed query population for %s", async (mode) => {
    const repository = await fixtureRepository();
    const result = await inspectGraph(
      request(await fakeExecutable(mode), repository.root, repository.first),
    );
    expect(result.query).toEqual({
      kind: "error",
      error: { message: "Neuve Graph query observation unavailable." },
    });
    expect(result.relationships[0]?.outcome).toMatchObject({
      kind: "success",
      value: { observations: [{ relation: "CALLS" }] },
    });
  });

  test("normalizes Graph's search stats and the commands' usage", async () => {
    const repository = await fixtureRepository();
    const usages: GraphCommandUsage[] = [];
    const result = await inspectGraph(
      request(
        await fakeExecutable("search-stats"),
        repository.root,
        repository.first,
      ),
      { onCommandUsage: (usage) => usages.push(usage) },
    );
    expect(result.query).toMatchObject({
      kind: "success",
      value: {
        stats: {
          preselectLatencyMs: 41,
          queryLatencyMs: 9,
          totalLatencyMs: 52,
          preselectionBackend: "text-index",
          preselectionFallbackReason: "no-trigram",
          preselectionPasses: 2,
          preselectionFilesExamined: 300,
          preselectionFilesRead: 12,
          preselectionPatterns: 4,
          preselectionBlobsRead: 300,
          preselectionBytesRead: 65536,
          answerCacheHits: 3,
          answerCacheMisses: 1,
          answerCacheWaits: 0,
          textIndexLookups: 6,
          textIndexCandidates: 18,
        },
      },
    });
    const query = usages.find((usage) => usage.stage === "query");
    expect(query?.aborted).toBe(false);
    expect(query?.wallMs).toBeGreaterThan(0);
    expect(query?.cpu?.userMs).toBeGreaterThan(0);
  });

  // Why: the shared Graph service (architecture record 0013) is reached only through the mode this
  // boundary passes every engine command, and its account of a search is telemetry the harness
  // tunes Graph's wait from; a mode that never reached the engine, or a block read wrongly or
  // dropped, would show nothing else. The fixture engine answers from the shared service only when
  // it is given `auto`, and reports a block on both the query and the neighbor read.
  test.each([
    [undefined, true],
    ["off", false],
  ] as const)(
    "passes the service mode %s to the engine and normalizes the service's stats",
    async (mode, answered) => {
      const repository = await fixtureRepository();
      const result = await inspectGraph(
        request(
          await fakeExecutable("service-stats"),
          repository.root,
          repository.first,
        ),
        mode === undefined ? {} : { service: mode },
      );
      if (result.query.kind !== "success")
        throw new Error("no query observation");
      expect(result.query.value.service).toStrictEqual({
        answered,
        ...(answered ? {} : { reason: "off" }),
        rssBytes: 104857600,
        maxRssBytes: 209715200,
        snapshotsHeld: 2,
        snapshotsLimit: 4,
        cacheBytes: 3221225472,
        cacheCapBytes: 4294967296,
        keptAnswer: true,
        movedUp: true,
        cpuShared: true,
        snapshotHit: true,
        cpuUserMs: 812.5,
        cpuSystemMs: 90,
        queueWaitMs: 12,
      });
      // The neighbor read's own block, from its `stats`.
      const neighbors = result.relationships[0]?.outcome;
      if (neighbors?.kind !== "success")
        throw new Error("no relationship observation");
      expect(neighbors.value.service).toStrictEqual({
        answered,
        ...(answered ? {} : { reason: "off" }),
        snapshotsHeld: 1,
        snapshotHit: true,
        cpuUserMs: 40,
        cpuSystemMs: 5,
        queueWaitMs: 0,
      });
    },
  );

  test("an engine without the shared service reports no service block", async () => {
    const repository = await fixtureRepository();
    const result = await inspectGraph(
      request(await fakeExecutable("valid"), repository.root, repository.first),
    );
    if (result.query.kind !== "success")
      throw new Error("no query observation");
    expect("service" in result.query.value).toBe(false);
    const neighbors = result.relationships[0]?.outcome;
    if (neighbors?.kind !== "success")
      throw new Error("no relationship observation");
    expect("service" in neighbors.value).toBe(false);
  });

  // Why: the shared Graph service is one per executable path, so inspections that each ran their
  // own copy of the engine would start a service per search (seen with the real engine: one
  // service per search, each idling with its memory), and nothing else would show it.
  test("every inspection of one engine build runs the same copy of it", async () => {
    const repository = await fixtureRepository();
    const executable = await fakeExecutable("valid");
    const ran: string[] = [];
    for (let at = 0; at < 2; at++)
      await inspectGraph(
        request(executable, repository.root, repository.first),
        {
          onCommand: (receipt) => {
            if (receipt.stage === "version") ran.push(receipt.argv[0]!);
          },
        },
      );
    expect(ran).toHaveLength(2);
    expect(ran[0]).toBe(ran[1]);
  });

  // Why: the shared Graph service is keyed by the engine's environment as well as its file (all but
  // PWD, OLDPWD, SHLVL and _), so a variable that differed between calls would start a service per
  // call, and nothing else would show it.
  test("every engine call of one build gets the same environment", async () => {
    const repository = await fixtureRepository();
    const executable = await fakeExecutable("prepared-valid-environment");
    for (const reuseIdentity of [false, true, true])
      await inspectGraph(
        {
          ...request(executable, repository.root, repository.first),
          cache: "prepared",
        },
        { reuseIdentity },
      );
    const calls = (
      await Bun.file(join(dirname(executable), "environments")).text()
    )
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            command: string;
            environment: Record<string, string>;
          },
      );
    expect(new Set(calls.map((call) => call.command))).toEqual(
      new Set(["query", "neighbors"]),
    );
    expect(calls.length).toBeGreaterThanOrEqual(6);
    for (const call of calls)
      expect(call.environment).toEqual(calls[0]!.environment);
  });

  // Why: the shared Graph service is keyed by the engine's environment, and every Neuve process
  // (the worker, the commit hook's process, `neuve query`) starts from a different one: a hook's
  // PATH and git variables, a caller's TMPDIR, locale or GOMAXPROCS. If any reached the engine, each
  // process would start its own service, with the first starter's Go settings.
  test("processes with different environments give the engine the same one", async () => {
    const repository = await fixtureRepository();
    const executable = await fakeExecutable("prepared-valid-environment");
    const driver = join(dirname(executable), "driver.ts");
    await Bun.write(
      driver,
      `import { inspectGraph } from ${JSON.stringify(join(import.meta.dir, "../src/index.ts"))};\n` +
        `await inspectGraph(JSON.parse(process.argv[2]!), { reuseIdentity: true });\n`,
    );
    const inspection = JSON.stringify({
      ...request(executable, repository.root, repository.first),
      cache: "prepared",
    });
    await mkdir(join(dirname(executable), "own-tmp"));
    const git = Bun.which("git");
    if (git === null) throw new Error("Git is required for this fixture");
    // Vary the caller's PATH while keeping its Git dependency fixed. The runner's
    // /usr/lib/git-core/git need not be the same executable as its default git.
    const hookBin = join(dirname(executable), "hook-bin");
    await mkdir(hookBin);
    await symlink(await realpath(git), join(hookBin, "git"));
    const variants: Record<string, string>[] = [
      { GOMAXPROCS: "2", NEUVE_WORKER: "1" },
      {
        PATH: `${hookBin}:${process.env.PATH}`,
        GIT_EXEC_PATH: "/usr/lib/git-core",
        GIT_INDEX_FILE: join(repository.root, ".git/index"),
        LANG: "fr_FR.UTF-8",
        GOGC: "50",
      },
      {
        TMPDIR: join(dirname(executable), "own-tmp"),
        LC_ALL: "C",
        LC_CTYPE: "C",
        GOMAXPROCS: "16",
        GODEBUG: "gctrace=0",
        SOMETHING_ELSE: String(Math.random()),
      },
    ];
    for (const variant of variants) {
      const child = Bun.spawnSync(["bun", driver, inspection], {
        env: { ...process.env, ...variant },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(child.stderr.toString()).toBe("");
      expect(child.exitCode).toBe(0);
    }
    const calls = (
      await Bun.file(join(dirname(executable), "environments")).text()
    )
      .trim()
      .split("\n")
      .map(
        (line) => JSON.parse(line) as { environment: Record<string, string> },
      );
    expect(calls.length).toBeGreaterThanOrEqual(variants.length * 2);
    for (const call of calls)
      expect(call.environment).toEqual(calls[0]!.environment);
    expect(calls[0]!.environment).toMatchObject({
      GOMAXPROCS: "2",
      ENTIRE_GRAPH_SERVICE: "auto",
    });
  });

  test("an explicit CPU grant caps engine and grep threads", async () => {
    const repository = await fixtureRepository();
    const executable = await fakeExecutable("prepared-valid-environment");
    await inspectGraph(
      {
        ...request(executable, repository.root, repository.first),
        cache: "prepared",
      },
      { cpuThreads: 1, reuseIdentity: true },
    );
    const calls = (
      await Bun.file(join(dirname(executable), "environments")).text()
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls)
      expect(call.environment).toMatchObject({
        GOMAXPROCS: "1",
        ENTIRE_GRAPH_GREP_CPU: "1",
        ENTIRE_GRAPH_GREP_THREADS: "1",
      });
  });

  // Why: the default cache is the store's Graph folder, the one the harness keeps, so every
  // worktree of a repository shares one cache (and one Graph service) and none of it sits in a
  // working tree; the store is owner-only.
  test("the default cache is the store's Graph folder, shared by linked worktrees", async () => {
    const repository = await fixtureRepository();
    const executable = await fakeExecutable("valid");
    const linked = join(dirname(executable), "linked");
    run(
      [
        "git",
        "worktree",
        "add",
        "--quiet",
        "--detach",
        linked,
        repository.first,
      ],
      repository.root,
    );
    const cacheDirectories: string[] = [];
    for (const root of [repository.root, linked])
      await inspectGraph(request(executable, root, repository.first), {
        onCommand: (receipt) => {
          const at = receipt.argv.indexOf("--cache-dir");
          if (at >= 0) cacheDirectories.push(receipt.argv[at + 1]!);
        },
      });
    const store = join(await realpath(repository.root), ".git/neuve");
    expect(cacheDirectories.length).toBeGreaterThan(1);
    for (const directory of cacheDirectories)
      expect(await realpath(directory)).toBe(join(store, "graph/cache"));
    expect((await stat(store)).mode & 0o777).toBe(0o700);
    expect(await pathExists(join(linked, "neuve"))).toBe(false);
    expect(await pathExists(join(repository.root, "neuve"))).toBe(false);
  });

  // Why: the engine runs from its cached copy, so a copy whose bytes changed (or that the store
  // evicted) must be made again from the configured engine, never run or reported as that engine.
  test("a changed or missing engine copy is made again", async () => {
    const repository = await fixtureRepository();
    const executable = await fakeExecutable("valid");
    const sha256 = createHash("sha256")
      .update(await Bun.file(executable).bytes())
      .digest("hex");
    const inspect = async () => {
      let ran = "";
      const result = await inspectGraph(
        request(executable, repository.root, repository.first),
        {
          reuseIdentity: true,
          onCommand: (receipt) => {
            if (receipt.stage === "query") ran = receipt.argv[0]!;
          },
        },
      );
      return { ran, sha256: result.provider.executable.sha256 };
    };
    const first = await inspect();
    expect(first.sha256).toBe(sha256);
    await chmod(first.ran, 0o700);
    await Bun.write(first.ran, "#!/bin/sh\nexit 1\n");
    const changed = await inspect();
    expect(changed).toEqual(first);
    expect(
      createHash("sha256")
        .update(await Bun.file(first.ran).bytes())
        .digest("hex"),
    ).toBe(sha256);
    await rm(first.ran);
    expect(await inspect()).toEqual(first);
  });

  // Why: the bounded store keeps an engine copy used or modified in the last day and may evict an
  // older one between two searches, so each validation must mark the copy as used.
  test("a validated engine copy is touched", async () => {
    const repository = await fixtureRepository();
    const executable = await fakeExecutable("valid");
    const inspect = async () => {
      let ran = "";
      await inspectGraph(
        request(executable, repository.root, repository.first),
        {
          reuseIdentity: true,
          onCommand: (receipt) => {
            if (receipt.stage === "query") ran = receipt.argv[0]!;
          },
        },
      );
      return ran;
    };
    const copy = await inspect();
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await utimes(copy, old, old);
    const before = Date.now() - 1000;
    expect(await inspect()).toBe(copy);
    expect((await stat(copy)).mtimeMs).toBeGreaterThan(before);
  });

  // Why: Graph names its shared service by the engine's resolved path, so a cache folder reached
  // through a symlink must still run the engine by its real path, or one folder would start two
  // services depending on how a caller named it.
  test("the engine copy runs by its resolved path", async () => {
    const repository = await fixtureRepository();
    const executable = await fakeExecutable("valid");
    const real = join(dirname(executable), "real-cache");
    await mkdir(real, { mode: 0o700 });
    const linked = join(dirname(executable), "linked-cache");
    await symlink(real, linked);
    let ran = "";
    await runGraphInspection(
      request(executable, repository.root, repository.first),
      {
        cacheDirectory: linked,
        emit: async () => {},
        onCommand: (receipt) => {
          if (receipt.stage === "query") ran = receipt.argv[0]!;
        },
      },
    );
    expect(ran.startsWith(`${await realpath(real)}/executables/`)).toBe(true);
  });

  // Why: an inspection's wait for the shared service runs from its start, so a slow setup before
  // its first engine call (finding the default cache folder through git) is counted against the
  // caller's deadline, never added to it.
  test("the service deadline counts the inspection's own setup", async () => {
    const repository = await fixtureRepository();
    const executable = await fakeExecutable("prepared-service-deadline");
    const root = dirname(executable);
    const wrapper = join(root, "slow-git");
    await mkdir(wrapper);
    const realGit = Bun.which("git")!;
    await Bun.write(
      join(wrapper, "git"),
      `#!/bin/sh\ncase " $* " in *" --git-common-dir "*) /bin/sleep 0.6;; esac\nexec ${realGit} "$@"\n`,
    );
    await chmod(join(wrapper, "git"), 0o755);
    const driver = join(root, "deadline-driver.ts");
    await Bun.write(
      driver,
      `import { inspectGraph } from ${JSON.stringify(join(import.meta.dir, "../src/index.ts"))};\n` +
        `await inspectGraph(JSON.parse(process.argv[2]!), { serviceClass: "interactive", serviceDeadlineMs: 1000 });\n`,
    );
    const child = Bun.spawnSync(
      [
        "bun",
        driver,
        JSON.stringify(request(executable, repository.root, repository.first)),
      ],
      {
        env: { ...process.env, PATH: `${wrapper}:${process.env.PATH}` },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(child.exitCode).toBe(0);
    const seen = JSON.parse(
      await Bun.file(join(root, "deadline-env")).text(),
    ) as { deadline: string };
    expect(Number(seen.deadline)).toBeGreaterThan(0);
    expect(Number(seen.deadline)).toBeLessThanOrEqual(450);
  });

  // Why: the shared Graph service queues a call by its class and stops waiting at its deadline
  // (exit 75) while the search runs on, so a review that waits a bounded time must pass both, they
  // must not reach the engine when the service is off, and exit 75 must read as "still running,
  // ask again", never as a failed engine, or the review would disclose a broken Graph.
  test("class and deadline reach the engine only with the service on, and exit 75 is a deadline", async () => {
    const repository = await fixtureRepository();
    const executable = await fakeExecutable("prepared-service-deadline");
    const seen = async (service?: "off") => {
      const result = await inspectGraph(
        request(executable, repository.root, repository.first),
        {
          serviceClass: "interactive",
          serviceDeadlineMs: 500,
          ...(service === undefined ? {} : { service }),
        },
      );
      return {
        query: result.query,
        env: JSON.parse(
          await Bun.file(join(dirname(executable), "deadline-env")).text(),
        ) as { class: string | null; deadline: string | null },
      };
    };
    const on = await seen();
    expect(on.env.class).toBe("interactive");
    expect(Number(on.env.deadline)).toBeGreaterThan(0);
    expect(Number(on.env.deadline)).toBeLessThanOrEqual(500);
    expect(on.query).toMatchObject({
      kind: "error",
      error: { serviceDeadline: true },
    });
    const off = await seen("off");
    expect(off.env).toEqual({ class: null, deadline: null });
    // Any other failing exit stays an ordinary error.
    expect(off.query.kind).toBe("error");
    if (off.query.kind === "error")
      expect(off.query.error).not.toHaveProperty("serviceDeadline");
    await expect(
      inspectGraph(request(executable, repository.root, repository.first), {
        serviceDeadlineMs: 0,
      }),
    ).rejects.toThrow("serviceDeadlineMs");
    // An operator's own per-call settings never reach the engine: graph-client sets them per call.
    // In a process of its own, as the fixed environment is taken once per process.
    const driver = join(dirname(executable), "driver.ts");
    await Bun.write(
      driver,
      `import { inspectGraph } from ${JSON.stringify(join(import.meta.dir, "../src/index.ts"))};\n` +
        `await inspectGraph(JSON.parse(process.argv[2]!));\n`,
    );
    await rm(join(dirname(executable), "deadline-env"));
    const child = Bun.spawnSync(
      [
        "bun",
        driver,
        JSON.stringify(request(executable, repository.root, repository.first)),
      ],
      {
        env: {
          ...process.env,
          ENTIRE_GRAPH_CLASS: "urgent",
          ENTIRE_GRAPH_DEADLINE_MS: "777",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(child.exitCode).toBe(0);
    expect(
      JSON.parse(
        await Bun.file(join(dirname(executable), "deadline-env")).text(),
      ),
    ).toEqual({ class: null, deadline: null });
  });

  // Why: anyone who could write the copy's folders could swap the engine between its hash and its
  // run, so a folder another user could have prepared is refused rather than trusted.
  test("an engine folder others can write is refused", async () => {
    const repository = await fixtureRepository();
    const executable = await fakeExecutable("valid");
    const sha256 = createHash("sha256")
      .update(await Bun.file(executable).bytes())
      .digest("hex");
    const folder = join(
      repository.root,
      ".git/neuve/graph/cache/executables",
      sha256,
    );
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await chmod(folder, 0o777);
    await expect(
      inspectGraph(request(executable, repository.root, repository.first)),
    ).rejects.toThrow("is not private to this user");
  });

  // Why: a caller that runs many inspections skips the engine's version, capabilities and repeated
  // hashing (most of an inspection's own time). Skipping them must never hide a changed engine, and
  // a caller that does not ask must keep every inspection's own commands as evidence.
  test("reuseIdentity takes the engine's identity once per build, and again once the file changes", async () => {
    const repository = await fixtureRepository();
    const executable = await fakeExecutable("valid");
    const inspect = async (reuseIdentity: boolean) => {
      const stages: string[] = [];
      const result = await inspectGraph(
        request(executable, repository.root, repository.first),
        {
          ...(reuseIdentity ? { reuseIdentity } : {}),
          onCommand: (receipt) => stages.push(receipt.stage),
        },
      );
      return {
        sha256: result.provider.executable.sha256,
        identity: stages.filter(
          (stage) => stage === "version" || stage === "capabilities",
        ),
        answered: result.query.kind,
      };
    };
    const first = await inspect(true);
    const second = await inspect(true);
    expect(first.identity).toEqual(["version", "capabilities"]);
    expect(second.identity).toEqual([]);
    expect(second.sha256).toBe(first.sha256);
    expect(second.answered).toBe("success");
    // The engine file changes: its new bytes are hashed and its identity taken again.
    await Bun.write(
      executable,
      `${await Bun.file(executable).text()}\n// changed\n`,
    );
    const changed = await inspect(true);
    expect(changed.sha256).not.toBe(first.sha256);
    expect(changed.identity).toEqual(["version", "capabilities"]);
    // Without the option, every inspection records its own.
    expect((await inspect(false)).identity).toEqual([
      "version",
      "capabilities",
    ]);
    expect((await inspect(false)).identity).toEqual([
      "version",
      "capabilities",
    ]);
  });

  test("an operator's own ENTIRE_GRAPH_SERVICE wins over the default", async () => {
    const repository = await fixtureRepository();
    const before = process.env.ENTIRE_GRAPH_SERVICE;
    process.env.ENTIRE_GRAPH_SERVICE = "off";
    try {
      const result = await inspectGraph(
        request(
          await fakeExecutable("service-stats"),
          repository.root,
          repository.first,
        ),
      );
      if (result.query.kind !== "success")
        throw new Error("no query observation");
      expect(result.query.value.service?.answered).toBe(false);
    } finally {
      if (before === undefined) delete process.env.ENTIRE_GRAPH_SERVICE;
      else process.env.ENTIRE_GRAPH_SERVICE = before;
    }
  });

  test.each([
    "service-stats-queue-malformed",
    "service-stats-answered-malformed",
    "service-stats-cache-malformed",
    "service-stats-kept-malformed",
    "service-stats-moved-malformed",
    "service-stats-shared-malformed",
  ])("rejects a present malformed service block for %s", async (mode) => {
    const repository = await fixtureRepository();
    const result = await inspectGraph(
      request(await fakeExecutable(mode), repository.root, repository.first),
    );
    expect(result.query.kind).toBe("error");
  });

  test("an engine that reports no search stats reads as empty", async () => {
    const repository = await fixtureRepository();
    const result = await inspectGraph(
      request(await fakeExecutable("valid"), repository.root, repository.first),
    );
    if (result.query.kind !== "success")
      throw new Error("no query observation");
    // Exactly empty: an absent field is never filled in, with zero or anything else.
    expect(result.query.value.stats).toStrictEqual({});
  });

  test.each([
    "search-stats-bytes-malformed",
    "search-stats-candidates-malformed",
    "search-stats-backend-malformed",
  ])("rejects present malformed search stats for %s", async (mode) => {
    const repository = await fixtureRepository();
    const result = await inspectGraph(
      request(await fakeExecutable(mode), repository.root, repository.first),
    );
    expect(result.query.kind).toBe("error");
  });

  test.each([
    "cache-query-malformed",
    "cache-latency-malformed",
    "cache-neighbor-malformed",
  ])("rejects present malformed operational fields for %s", async (mode) => {
    const repository = await fixtureRepository();
    const result = await inspectGraph(
      request(await fakeExecutable(mode), repository.root, repository.first),
    );
    expect(result.query.kind).toBe(
      mode === "cache-neighbor-malformed" ? "success" : "error",
    );
    expect(result.relationships[0]?.outcome.kind).toBe(
      mode === "cache-neighbor-malformed" ? "error" : "success",
    );
  });

  test("refreshes before retrieval with the owned executable and cleans its view", async () => {
    const repository = await fixtureRepository();
    const executable = await fakeExecutable("valid");
    const receipts: GraphCommandReceipt[] = [];
    let view = "";
    const result = await inspectGraph(
      {
        ...request(executable, repository.root, repository.first),
        cache: "refresh",
      },
      {
        onCommand: (receipt) => receipts.push(receipt),
        onTemporaryView: (registration) => {
          view = registration.path;
        },
      },
    );
    expect(result.query).toMatchObject({
      kind: "success",
      value: { results: [{ symbol: "caller" }] },
    });
    expect(result.relationships[0]?.outcome).toMatchObject({
      kind: "success",
      value: { observations: [{ to: { name: "callee" } }] },
    });
    expect(
      receipts
        .filter(({ stage }) =>
          ["version", "capabilities", "index", "query"].includes(stage),
        )
        .map(({ stage }) => stage),
    ).toEqual(["version", "capabilities", "index", "query"]);
    expect(
      receipts.find(({ stage }) => stage === "index")?.argv.slice(1),
    ).toEqual([
      "index",
      "--repo",
      view,
      "--head",
      "--profile",
      "full",
      "--format",
      "json",
      "--force",
      "--cache-dir",
      join(repository.root, ".git/neuve/graph/cache"),
    ]);
    // The engine runs from its one read-only copy for this build, under the cache directory, so
    // every inspection runs the same path (the shared Graph service is one per path).
    const frozen = receipts.find(({ stage }) => stage === "version")?.argv[0];
    // The copy goes by its resolved path, so compare against the resolved root (macOS's /var
    // is /private/var).
    expect(dirname(dirname(frozen!))).toBe(
      join(
        await realpath(repository.root),
        ".git/neuve/graph/cache/executables",
      ),
    );
    expect(basename(frozen!)).toBe("fake-graph-valid");
    expect(
      receipts
        .filter(
          ({ stage }) =>
            ["version", "capabilities", "index", "query"].includes(stage) ||
            stage.endsWith(":resolution") ||
            stage.endsWith(":observation"),
        )
        .every(({ argv }) => argv[0] === frozen),
    ).toBe(true);
    expect(await pathExists(dirname(dirname(view)))).toBe(false);
    expect(
      run(["git", "worktree", "list", "--porcelain"], repository.root)
        .split("\n")
        .filter((line) => line.startsWith("worktree ")),
    ).toEqual([`worktree ${await realpath(repository.root)}`]);
    // Alone 0.63-0.68 s; 10x slowest, at least 30 s; child processes and disk I/O under load.
  }, 30_000);

  test.each([
    "refresh-command-failure",
    "refresh-malformed",
    "refresh-wrong-root",
    "refresh-wrong-revision",
    "refresh-wrong-tree",
    "refresh-wrong-provider",
    "refresh-wrong-version",
    "refresh-wrong-profile",
    "refresh-unreported",
    "refresh-hit",
  ])("%s rejects before retrieval and removes the owned view", async (mode) => {
    const repository = await fixtureRepository();
    const events: string[] = [];
    const receipts: GraphCommandReceipt[] = [];
    let view = "";
    await expect(
      runGraphInspection(
        {
          ...request(
            await fakeExecutable(mode),
            repository.root,
            repository.first,
          ),
          cache: "refresh",
        },
        {
          onCommand: (receipt) => receipts.push(receipt),
          onTemporaryView: (registration) => {
            view = registration.path;
          },
          emit: async (event) => {
            events.push(event.kind);
          },
        },
      ),
    ).rejects.toThrow("Neuve Graph cache refresh");
    expect(events).toEqual([]);
    expect(
      receipts
        .filter(({ stage }) => stage === "index")
        .map(({ stage, exitCode }) => ({ stage, exitCode })),
    ).toEqual([
      { stage: "index", exitCode: mode === "refresh-command-failure" ? 23 : 0 },
    ]);
    expect(
      receipts.some(
        ({ stage }) => stage === "query" || stage.startsWith("relationship:"),
      ),
    ).toBe(false);
    expect(await pathExists(dirname(dirname(view)))).toBe(false);
    expect(
      run(["git", "worktree", "list", "--porcelain"], repository.root)
        .split("\n")
        .filter((line) => line.startsWith("worktree ")),
    ).toEqual([`worktree ${await realpath(repository.root)}`]);
  });

  test.each(["bad-build-identity", "malformed-build-identity"])(
    "%s refuses provider identity before retrieval",
    async (mode) => {
      const repository = await fixtureRepository();
      const receipts: GraphCommandReceipt[] = [];
      await expect(
        inspectGraph(
          request(
            await fakeExecutable(mode),
            repository.root,
            repository.first,
          ),
          { onCommand: (receipt) => receipts.push(receipt) },
        ),
      ).rejects.toThrow();
      expect(
        receipts
          .filter(({ stage }) => stage === "version")
          .map(({ exitCode }) => exitCode),
      ).toEqual([0]);
      expect(receipts.some(({ stage }) => stage === "query")).toBe(false);
    },
  );

  test("replacement of the configured executable cannot mix one inspection's provider", async () => {
    const repository = await fixtureRepository();
    const executable = await fakeExecutable("valid");
    const original = await Bun.file(executable).text();
    const expectedSha256 = createHash("sha256").update(original).digest("hex");
    const receipts: GraphCommandReceipt[] = [];
    const first = await inspectGraph(
      request(executable, repository.root, repository.first),
      {
        onCommand: (receipt) => {
          receipts.push(receipt);
          if (receipt.stage === "capabilities")
            writeFileSync(
              executable,
              original.replace('version: "fixture"', 'version: "replacement"'),
            );
        },
      },
    );
    expect(first.provider).toMatchObject({
      version: "fixture",
      executable: { sha256: expectedSha256, buildIdentity: "unreported" },
    });
    expect(first.query).toMatchObject({
      kind: "success",
      value: { results: [{ symbol: "caller" }] },
    });
    expect(first.relationships[0]?.outcome).toMatchObject({
      kind: "success",
      value: { observations: [{ to: { name: "callee" } }] },
    });
    expect(
      receipts
        .filter(
          ({ stage }) =>
            ["version", "capabilities", "query"].includes(stage) ||
            stage.endsWith(":resolution") ||
            stage.endsWith(":observation"),
        )
        .every(
          ({ argv }) =>
            argv[0] !== executable &&
            argv[0] ===
              receipts.find(({ stage }) => stage === "version")?.argv[0],
        ),
    ).toBe(true);
    const second = await inspectGraph(
      request(executable, repository.root, repository.first),
    );
    expect(second.provider.version).toBe("replacement");
    expect(second.provider.executable.sha256).not.toBe(expectedSha256);
    expect(second.query.kind).toBe("success");
  });

  test("a changed private executable suppresses completion and cleans the view", async () => {
    const repository = await fixtureRepository();
    const executable = await fakeExecutable("valid");
    const events: string[] = [];
    let frozen = "";
    let view = "";
    await expect(
      runGraphInspection(
        request(executable, repository.root, repository.first, false),
        {
          onTemporaryView: (registration) => {
            view = registration.path;
          },
          onCommand: (receipt) => {
            if (receipt.stage === "version") frozen = receipt.argv[0] ?? "";
          },
          emit: async (event) => {
            events.push(event.kind);
            if (event.kind === "retrieval") {
              chmodSync(frozen, 0o700);
              writeFileSync(frozen, "changed");
            }
          },
        },
      ),
    ).rejects.toThrow("frozen executable changed");
    expect(events).toEqual(["retrieval"]);
    expect(await pathExists(dirname(dirname(view)))).toBe(false);
  });
});
