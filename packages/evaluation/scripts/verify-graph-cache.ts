import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  rename,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  runGraphInspection,
  type GraphCommandReceipt,
  type GraphInspectionEvent,
  type GraphInspectionRequest,
} from "@neuve/graph-client";

const workspace = resolve(import.meta.dir, "../../..");
const script = import.meta.path;
const question = "GoCaller GoLeaf GoAdded py_caller py_leaf py_added";
const files = {
  original: {
    "cache.go":
      "package fixture\n\nfunc GoLeaf() int {\n\treturn 7\n}\n\nfunc GoCaller() int {\n\treturn GoLeaf()\n}\n",
    "cache.py":
      "def py_leaf():\n    return 7\n\ndef py_caller():\n    return py_leaf()\n",
  },
  changed: {
    "cache.go":
      "package fixture\n\nfunc GoLeaf() int {\n\treturn 7\n}\n\nfunc GoCaller() int {\n\t// The new committed call must survive snapshot reuse.\n\treturn GoLeaf() + GoAdded()\n}\n\nfunc GoAdded() int {\n\treturn 11\n}\n",
    "cache.py":
      "def py_leaf():\n    return 7\n\ndef py_caller():\n    # The new committed call must survive snapshot reuse.\n    return py_leaf() + py_added()\n\ndef py_added():\n    return 11\n",
  },
};
const relationships = [
  {
    id: "go-calls",
    focus: { name: "GoCaller", path: "cache.go" },
    relation: "CALLS",
    selection: "exact",
    direction: "out",
    depth: 1,
    limit: 16,
  },
  {
    id: "python-calls",
    focus: { name: "py_caller", path: "cache.py" },
    relation: "CALLS",
    selection: "exact",
    direction: "out",
    depth: 1,
    limit: 16,
  },
] satisfies GraphInspectionRequest["relationships"];

const options = (args: readonly string[]): Map<string, string> => {
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (key === undefined || value === undefined || !key.startsWith("--")) {
      throw new Error(
        "Options must be --name value pairs. Use --help for usage.",
      );
    }
    if (result.has(key)) throw new Error(`Duplicate option ${key}.`);
    result.set(key, value);
  }
  return result;
};
const required = (values: Map<string, string>, key: string): string => {
  const value = values.get(key);
  if (value === undefined) throw new Error(`Missing ${key}.`);
  return value;
};
const digest = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const object = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return Object.fromEntries(Object.entries(value));
};
const array = (value: unknown, label: string): unknown[] => {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
};
const string = (value: unknown, label: string): string => {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  return value;
};
const json = (value: string): unknown => JSON.parse(value);
const subset = (actual: unknown, expected: unknown, label: string): void => {
  if (Array.isArray(expected)) {
    const items = array(actual, label);
    assert.equal(items.length, expected.length, `${label} length`);
    expected.forEach((item, index) =>
      subset(items[index], item, `${label}[${index}]`),
    );
  } else if (typeof expected === "object" && expected !== null) {
    const record = object(actual, label);
    for (const [key, value] of Object.entries(expected))
      subset(record[key], value, `${label}.${key}`);
  } else assert.deepEqual(actual, expected, label);
};

const probe = async (values: Map<string, string>): Promise<void> => {
  const commands: Omit<GraphCommandReceipt, "stdout" | "stderr">[] = [];
  const invocations: { stage: string; executable: string; sha256: string }[] =
    [];
  const events: GraphInspectionEvent[] = [];
  const views: string[] = [];
  const executable = required(values, "--graph");
  const replaceWith = values.get("--replace-with");
  if (replaceWith !== undefined) {
    assert.equal(
      resolve(executable).startsWith(
        `${dirname(required(values, "--views"))}/`,
      ),
      true,
      "replacement probe may change only its owned fixture binary",
    );
  }
  let replaced = false;
  let error: string | null = null;
  const started = performance.now();
  try {
    await runGraphInspection(
      {
        executable,
        repository: required(values, "--repo"),
        revision: required(values, "--revision"),
        question,
        limits: { topK: 16, maxContextBytes: 32768 },
        relationships,
        ...(values.get("--cache") === "refresh" ? { cache: "refresh" } : {}),
      },
      {
        temporaryParent: required(values, "--views"),
        cacheDirectory: required(values, "--cache-root"),
        onTemporaryView: ({ path }) => views.push(path),
        onCommand: (receipt) => {
          commands.push({
            stage: receipt.stage,
            argv: receipt.argv,
            cwd: receipt.cwd,
            exitCode: receipt.exitCode,
          });
          const invoked = receipt.argv[0];
          if (
            invoked !== undefined &&
            receipt.stage !== "git_revision" &&
            receipt.stage !== "git_tree" &&
            !receipt.stage.startsWith("worktree_") &&
            !receipt.stage.includes(":source:")
          ) {
            invocations.push({
              stage: receipt.stage,
              executable: invoked,
              sha256: digest(invoked),
            });
          }
          if (replaceWith !== undefined && receipt.stage === "query") {
            copyFileSync(replaceWith, executable);
            replaced = true;
          }
        },
        emit: async (event) => {
          events.push(event);
          if (event.kind === "complete") {
            assert.equal(
              views.every(
                (view) => !existsSync(view) && !existsSync(dirname(view)),
              ),
              true,
              "completion follows owned view cleanup",
            );
          }
          const barrier = values.get("--barrier");
          if (event.kind === "retrieval" && barrier !== undefined) {
            await Bun.write(
              join(barrier, `ready-${process.pid}`),
              views.join("\n"),
            );
            const deadline = performance.now() + 15000;
            while (!existsSync(join(barrier, "release"))) {
              if (performance.now() > deadline)
                throw new Error("Concurrent inspection barrier timed out.");
              await Bun.sleep(20);
            }
          }
        },
      },
    );
  } catch (failure) {
    error = failure instanceof Error ? failure.message : String(failure);
  }
  const recordedEvents = events.map((event) => ({
    ...event,
    identity: {
      source: event.identity.source,
      provider: {
        name: event.identity.provider.name,
        version: event.identity.provider.version,
        identityRevision: event.identity.provider.identityRevision,
        executable: event.identity.provider.executable,
        semanticLanguages:
          event.identity.provider.capabilities.semanticLanguages,
      },
    },
  }));
  await Bun.write(
    Bun.stdout,
    `${JSON.stringify({
      error,
      elapsedMs: performance.now() - started,
      events: recordedEvents,
      commands,
      invocations,
      replaced,
      views,
      cleaned: views.every(
        (view) => !existsSync(view) && !existsSync(dirname(view)),
      ),
    })}\n`,
  );
};

type Command = Readonly<{
  argv: readonly string[];
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}>;
const commands: Command[] = [];
const run = async (
  argv: readonly string[],
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): Promise<Command> => {
  const started = performance.now();
  const child = Bun.spawn([...argv], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const result = {
    argv,
    cwd,
    exitCode,
    stdout,
    stderr,
    elapsedMs: performance.now() - started,
  };
  commands.push(result);
  return result;
};
const success = (result: Command): string => {
  assert.equal(
    result.exitCode,
    0,
    `${result.argv.join(" ")}\n${result.stderr}`,
  );
  return result.stdout.trim();
};

const endpoint = (name: string, changed: boolean): object => {
  switch (name) {
    case "GoCaller":
      return {
        id: "local/view:Go:cache.go:function:GoCaller",
        name,
        qualified_name: "GoCaller",
        symbol_kind: "function",
        language: "Go",
        external: false,
        location: {
          kind: "range",
          path: "cache.go",
          start_line: 7,
          end_line: changed ? 10 : 9,
        },
      };
    case "GoLeaf":
      return {
        id: "local/view:Go:cache.go:function:GoLeaf",
        name,
        qualified_name: "GoLeaf",
        symbol_kind: "function",
        language: "Go",
        external: false,
        location: {
          kind: "range",
          path: "cache.go",
          start_line: 3,
          end_line: 5,
        },
      };
    case "GoAdded":
      return {
        id: "local/view:Go:cache.go:function:GoAdded",
        name,
        qualified_name: "GoAdded",
        symbol_kind: "function",
        language: "Go",
        external: false,
        location: {
          kind: "range",
          path: "cache.go",
          start_line: 12,
          end_line: 14,
        },
      };
    case "py_caller":
      return {
        id: "local/view:Python:cache.py:function:py_caller",
        name,
        qualified_name: "py_caller",
        symbol_kind: "function",
        language: "Python",
        external: false,
        location: {
          kind: "range",
          path: "cache.py",
          start_line: 4,
          end_line: changed ? 6 : 5,
        },
      };
    case "py_leaf":
      return {
        id: "local/view:Python:cache.py:function:py_leaf",
        name,
        qualified_name: "py_leaf",
        symbol_kind: "function",
        language: "Python",
        external: false,
        location: {
          kind: "range",
          path: "cache.py",
          start_line: 1,
          end_line: 2,
        },
      };
    case "py_added":
      return {
        id: "local/view:Python:cache.py:function:py_added",
        name,
        qualified_name: "py_added",
        symbol_kind: "function",
        language: "Python",
        external: false,
        location: {
          kind: "range",
          path: "cache.py",
          start_line: 8,
          end_line: 9,
        },
      };
    default:
      throw new Error(`Unknown expected symbol ${name}.`);
  }
};
const expectedEdges = (
  caller: "GoCaller" | "py_caller",
  changed: boolean,
): readonly object[] => {
  const targets =
    caller === "GoCaller"
      ? changed
        ? ["GoAdded", "GoLeaf"]
        : ["GoLeaf"]
      : changed
        ? ["py_added", "py_leaf"]
        : ["py_leaf"];
  return targets.map((target) => ({
    direction: "out",
    relation: "CALLS",
    from: endpoint(caller, changed),
    to: endpoint(target, changed),
    confidence: 0.92,
    resolution: "exact",
    reason: "direct call expression resolved to same-file symbol",
    warning_codes: [],
    evidence_dropped: 0,
    evidence: [
      {
        kind: "call_site",
        location:
          caller === "GoCaller"
            ? {
                kind: "range",
                path: "cache.go",
                start_line: 7,
                end_line: changed ? 10 : 9,
              }
            : {
                kind: "range",
                path: "cache.py",
                start_line: 4,
                end_line: changed ? 6 : 5,
              },
        detail: target,
      },
    ],
  }));
};
// These are the CLI's own schema names, not the Graph wire representation.
const publicNames = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(publicNames);
  if (typeof value !== "object" || value === null) return value;
  const names: Record<string, string> = {
    qualifiedName: "qualified_name",
    symbolKind: "symbol_kind",
    startLine: "start_line",
    endLine: "end_line",
    warningCodes: "warning_codes",
    evidenceDropped: "evidence_dropped",
    partialFailures: "partial_failures",
    selectedRelations: "selected_relations",
    focusMatchesTruncated: "focus_matches_truncated",
  };
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      names[key] ?? key,
      publicNames(child),
    ]),
  );
};
const checkFacts = (input: {
  retrieval: unknown;
  structural: unknown;
  changed: boolean;
  label: string;
}): void => {
  const retrieval = object(input.retrieval, `${input.label}.retrieval`);
  subset(
    retrieval,
    { coverage: "ok", warnings: [], partial_failures: [], limitations: [] },
    input.label,
  );
  const candidates = array(
    retrieval["candidates"] ?? retrieval["results"],
    `${input.label}.candidates`,
  );
  for (const name of [
    "GoCaller",
    "GoLeaf",
    "py_caller",
    "py_leaf",
    ...(input.changed ? ["GoAdded", "py_added"] : []),
  ]) {
    const candidate = candidates
      .map((item) => object(item, "candidate"))
      .find((item) => item["symbol"] === name);
    assert.ok(candidate, `${input.label} retrieves ${name}`);
    const symbol = object(endpoint(name, input.changed), "expected endpoint");
    subset(
      candidate,
      {
        kind: "symbol",
        language: symbol["language"],
        symbol: name,
        symbol_kind: "function",
        qualified_name: name,
      },
      `${input.label}.${name}`,
    );
    // Query snippets may expand. Declaration ranges remain exact on the focus and edge endpoints below.
    const source = object(candidate["source"], "query source");
    const location = object(symbol["location"], "expected source");
    assert.equal(
      source["path"],
      location["path"],
      `${input.label}.${name}.path`,
    );
    assert.equal(typeof source["start_line"], "number");
    assert.equal(typeof source["end_line"], "number");
  }
  const outcomes = array(input.structural, `${input.label}.structural`);
  assert.equal(outcomes.length, 2, `${input.label} relationship count`);
  for (const [index, caller] of ["GoCaller", "py_caller"].entries()) {
    assert.ok(caller === "GoCaller" || caller === "py_caller");
    const outcome = object(outcomes[index], `${input.label}.relationship`);
    subset(
      outcome,
      {
        selection: "exact",
        selected_relations: ["CALLS"],
        focus: { kind: "resolved", symbol: endpoint(caller, input.changed) },
        truncated: false,
        focus_matches_truncated: false,
        warnings: [],
        partial_failures: [],
        limitations: [],
      },
      `${input.label}.${caller}`,
    );
    const edges = array(outcome["observations"], "edges").sort((left, right) =>
      string(
        object(object(left, "edge")["to"], "endpoint")["name"],
        "name",
      ).localeCompare(
        string(object(object(right, "edge")["to"], "endpoint")["name"], "name"),
      ),
    );
    subset(
      edges,
      expectedEdges(caller, input.changed),
      `${input.label}.${caller}.edges`,
    );
  }
};

const main = async (values: Map<string, string>): Promise<void> => {
  const allowed = new Set(["--graph-a", "--graph-b", "--neuve", "--report"]);
  for (const key of values.keys())
    if (!allowed.has(key)) throw new Error(`Unknown option ${key}.`);
  const root = await mkdtemp(join(tmpdir(), "neuve-cache-verification-"));
  const reportPath = resolve(
    values.get("--report") ??
      join(workspace, ".audit/graph-cache/lever/report.json"),
  );
  const checks: { label: string; facts: unknown; elapsedMs: number }[] = [];
  const views = join(root, "views");
  const repo = join(root, "repository");
  const cache = join(repo, "neuve/cache/graph");
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    ENTIRE_PLUGIN_DATA_DIR: cache,
    TMPDIR: views,
  };
  let failure: string | null = null;
  const inventory = async (repository: string): Promise<string> =>
    success(
      await run(
        ["git", "-C", repository, "worktree", "list", "--porcelain"],
        workspace,
        env,
      ),
    );
  try {
    await Promise.all([mkdir(views), mkdir(cache, { recursive: true })]);
    const graphA = resolve(values.get("--graph-a") ?? join(root, "graph-a"));
    const graphB = resolve(values.get("--graph-b") ?? join(root, "graph-b"));
    const neuve = resolve(values.get("--neuve") ?? join(root, "neuve"));
    const goCommand =
      Bun.which("mise") === null ? ["go"] : ["mise", "exec", "--", "go"];
    for (const [key, binary, buildId] of [
      ["--graph-a", graphA, "neuve-cache-proof-a"],
      ["--graph-b", graphB, "neuve-cache-proof-b"],
    ]) {
      if (key === undefined || binary === undefined || buildId === undefined)
        throw new Error("Incomplete build specification.");
      if (!values.has(key))
        success(
          await run(
            [
              ...goCommand,
              "build",
              `-ldflags=-buildid=${buildId}`,
              "-o",
              binary,
              "./cmd/entire-graph",
            ],
            join(workspace, "apps/neuve-graph"),
            env,
          ),
        );
    }
    if (!values.has("--neuve")) {
      success(
        await run(
          [
            "bun",
            "build",
            "./apps/neuve-cli/src/cli.ts",
            "--compile",
            "--outfile",
            neuve,
          ],
          workspace,
          env,
        ),
      );
      if (process.platform === "darwin")
        success(
          await run(
            ["codesign", "--force", "--sign", "-", neuve],
            workspace,
            env,
          ),
        );
    }
    const shaA = digest(graphA);
    const shaB = digest(graphB);
    assert.notEqual(
      shaA,
      shaB,
      "two real builds must contain different executable bytes",
    );
    const git = async (
      args: readonly string[],
      directory = repo,
    ): Promise<string> =>
      success(await run(["git", "-C", directory, ...args], workspace, env));
    await git(["init", "--quiet"]);
    await git(["config", "user.name", "Cache verification"]);
    await git(["config", "user.email", "cache-verification@example.invalid"]);
    const commit = async (
      source: typeof files.original | typeof files.changed,
      message: string,
    ): Promise<string> => {
      for (const [path, content] of Object.entries(source))
        await Bun.write(join(repo, path), content);
      await git(["add", ...Object.keys(source)]);
      await git([
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "--quiet",
        "-m",
        message,
      ]);
      return git(["rev-parse", "HEAD"]);
    };
    const original = await commit(
      files.original,
      "Original Go and Python calls",
    );
    const originalTree = await git(["rev-parse", "HEAD^{tree}"]);
    const preexisting = join(root, "preexisting-view");
    await git([
      "worktree",
      "add",
      "--quiet",
      "--detach",
      preexisting,
      original,
    ]);
    await Bun.write(
      join(preexisting, "owned-by-another-inspection.txt"),
      "preserve this view\n",
    );
    let before = await inventory(repo);
    const allViews = new Set<string>();
    const inspect = async (
      label: string,
      input: {
        graph?: string;
        repository?: string;
        revision?: string;
        changed?: boolean;
        cache?: "refresh";
        replaceWith?: string;
        barrier?: string;
        cacheRoot?: string;
        expectedError?: boolean;
      } = {},
    ): Promise<Record<string, unknown>> => {
      const selectedGraph = input.graph ?? graphA;
      const selectedRepo = input.repository ?? repo;
      const revision = input.revision ?? original;
      const selectedEnv = {
        ...env,
        ENTIRE_PLUGIN_DATA_DIR: input.cacheRoot ?? cache,
      };
      const inventoryBefore =
        input.barrier === undefined ? await inventory(selectedRepo) : null;
      const result = await run(
        [
          process.execPath,
          script,
          "--probe",
          "true",
          "--graph",
          selectedGraph,
          "--repo",
          selectedRepo,
          "--revision",
          revision,
          "--views",
          views,
          "--cache-root",
          input.cacheRoot ?? cache,
          ...(input.cache === undefined ? [] : ["--cache", input.cache]),
          ...(input.replaceWith === undefined
            ? []
            : ["--replace-with", input.replaceWith]),
          ...(input.barrier === undefined ? [] : ["--barrier", input.barrier]),
        ],
        workspace,
        selectedEnv,
      );
      const observation = object(json(success(result)), label);
      assert.equal(observation["cleaned"], true, `${label} cleans owned views`);
      for (const value of array(observation["views"], "views")) {
        const view = string(value, "view");
        assert.equal(
          allViews.has(view),
          false,
          "every inspection owns a distinct view",
        );
        allViews.add(view);
      }
      if (input.expectedError) {
        assert.equal(
          typeof observation["error"],
          "string",
          `${label} reports refresh failure`,
        );
        assert.deepEqual(
          observation["events"],
          [],
          `${label} fails before retrieval`,
        );
      } else {
        assert.equal(
          observation["error"],
          null,
          `${label} inspection succeeds`,
        );
        const events = array(observation["events"], "events").map((event) =>
          object(event, "event"),
        );
        assert.deepEqual(
          events.map((event) => event["kind"]),
          ["retrieval", "relationship", "relationship", "complete"],
          `${label} event order`,
        );
        assert.deepEqual(
          events.map((event) => event["sequence"]),
          [1, 2, 3, 4],
          `${label} sequence`,
        );
        for (const event of events) {
          const identity = object(event["identity"], "identity");
          subset(
            identity["source"],
            { repository: selectedRepo, revision },
            `${label}.source`,
          );
          subset(
            object(identity["provider"], "provider"),
            {
              name: "entire-graph",
              version: "dev",
              executable: {
                sha256:
                  input.replaceWith === undefined
                    ? digest(selectedGraph)
                    : shaA,
                buildIdentity: "verified",
              },
            },
            `${label}.provider`,
          );
        }
        const outcomes = events.slice(0, 3).map((event) => {
          const outcome = object(event["outcome"], "outcome");
          assert.equal(
            outcome["kind"],
            "success",
            `${label} operation succeeds`,
          );
          return object(outcome["value"], "outcome.value");
        });
        checkFacts({
          retrieval: publicNames(outcomes[0]),
          structural: publicNames(outcomes.slice(1)),
          changed: input.changed ?? false,
          label,
        });
        const invocations = array(
          observation["invocations"],
          "invocations",
        ).map((item) => object(item, "invocation"));
        const paths = new Set(invocations.map((item) => item["executable"]));
        assert.equal(
          paths.size,
          1,
          `${label} invokes one immutable executable`,
        );
        assert.equal(
          paths.has(selectedGraph),
          false,
          `${label} never invokes the configured mutable path`,
        );
        for (const invocation of invocations)
          assert.equal(
            invocation["sha256"],
            input.replaceWith === undefined ? digest(selectedGraph) : shaA,
            `${label} all invocations use frozen bytes`,
          );
      }
      if (input.cache === "refresh") {
        const refreshCommands = array(observation["commands"], "commands").map(
          (command) => object(command, "command"),
        );
        const refresh = refreshCommands.find(
          (command) => command["stage"] === "index",
        );
        assert.ok(refresh, `${label} reaches the engine refresh operation`);
        assert.equal(
          array(refresh["argv"], "index argv").includes("--force"),
          true,
          `${label} forces the applicable snapshot rebuild`,
        );
      }
      if (inventoryBefore !== null)
        assert.equal(
          await inventory(selectedRepo),
          inventoryBefore,
          `${label} preserves worktree registrations`,
        );
      assert.equal(
        await Bun.file(
          join(preexisting, "owned-by-another-inspection.txt"),
        ).text(),
        "preserve this view\n",
        `${label} preserves pre-existing view contents`,
      );
      checks.push({ label, facts: observation, elapsedMs: result.elapsedMs });
      return observation;
    };
    const cacheStatus = (
      observation: Record<string, unknown>,
      expected: "hit" | "miss" | readonly ["hit", "miss"],
      label: string,
      neighborStatus: "hit" | "miss" = "hit",
    ): void => {
      const event = object(
        array(observation["events"], "events")[0],
        "retrieval",
      );
      const value = object(
        object(event["outcome"], "outcome")["value"],
        "query",
      );
      const telemetry = object(value["cache"], "query cache");
      if (typeof expected === "string")
        assert.equal(
          telemetry["status"],
          expected,
          `${label} query cache status`,
        );
      else
        assert.ok(
          telemetry["status"] === "hit" || telemetry["status"] === "miss",
          `${label} query reports an actual hit or miss`,
        );
      const duration = telemetry["indexLatencyMs"];
      assert.ok(
        duration === null || (typeof duration === "number" && duration >= 0),
        `${label} truthful nullable duration`,
      );
      for (const event of array(observation["events"], "events").slice(1, 3)) {
        const relationship = object(
          object(object(event, "event")["outcome"], "outcome")["value"],
          "relationship",
        );
        subset(
          relationship["cache"],
          { status: neighborStatus },
          `${label}.neighbor cache`,
        );
      }
    };
    const publicQuery = async (
      label: string,
      revision: string,
      changed: boolean,
      refresh = false,
      cacheRoot = cache,
      expectedError = false,
    ): Promise<void> => {
      const plan = relationships.map(({ id, focus, ...rest }) => ({
        request_id: id,
        focus: { symbol: focus.name, path: focus.path },
        ...rest,
      }));
      const relocatedCache = `${cache}.verification-saved`;
      const substitutedCache = cacheRoot !== cache;
      if (substitutedCache) {
        await rename(cache, relocatedCache);
        await symlink(cacheRoot, cache);
      }
      let result: Awaited<ReturnType<typeof run>>;
      try {
        result = await run(
          [
            neuve,
            "query",
            "--repo",
            repo,
            "--revision",
            revision,
            "--question",
            question,
            "--max-results",
            "16",
            "--max-context-bytes",
            "32768",
            "--relationship-plan",
            JSON.stringify(plan),
            ...(refresh ? ["--refresh-cache"] : []),
          ],
          workspace,
          {
            ...env,
            ENTIRE_PLUGIN_DATA_DIR: cacheRoot,
            NEUVE_GRAPH_BINARY: graphA,
          },
        );
      } finally {
        if (substitutedCache) {
          await rm(cache);
          await rename(relocatedCache, cache);
        }
      }
      if (expectedError) {
        assert.equal(
          result.exitCode,
          2,
          `${label} public refresh fails visibly`,
        );
        assert.equal(
          result.stdout,
          "",
          `${label} does not return successful query facts`,
        );
        assert.match(
          result.stderr,
          /refresh|index|cache/i,
          `${label} failure identifies refresh or storage`,
        );
        assert.equal(
          await inventory(repo),
          before,
          `${label} preserves worktree registrations`,
        );
        assert.deepEqual(
          await readdir(views),
          [],
          `${label} cleans owned temporary roots`,
        );
        checks.push({
          label,
          facts: {
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
          },
          elapsedMs: result.elapsedMs,
        });
        return;
      }
      const output = object(json(success(result)), label);
      subset(
        output,
        {
          schema_version: 2,
          query: question,
          source: { repository: repo, revision },
          provider: { name: "entire-graph", version: "dev" },
          retrieval: { status: "ok" },
        },
        label,
      );
      const structural = array(output["structural_observations"], "structural");
      structural.forEach((outcome) =>
        subset(outcome, { status: "ok" }, `${label}.relationship`),
      );
      checkFacts({
        retrieval: output["retrieval"],
        structural,
        changed,
        label,
      });
      assert.equal(
        await inventory(repo),
        before,
        `${label} public CLI cleans owned views`,
      );
      assert.deepEqual(
        await readdir(views),
        [],
        `${label} public CLI cleans owned temporary roots`,
      );
      checks.push({ label, facts: output, elapsedMs: result.elapsedMs });
    };
    cacheStatus(await inspect("cold-a"), "miss", "cold-a");
    cacheStatus(await inspect("warm-a"), "hit", "warm-a");
    await publicQuery("public-warm", original, false);
    cacheStatus(
      await inspect("refresh-existing-generation", { cache: "refresh" }),
      "hit",
      "refresh-existing-generation",
    );
    cacheStatus(
      await inspect("warm-after-refresh"),
      "hit",
      "warm-after-refresh",
    );
    await publicQuery("public-refresh", original, false, true);
    cacheStatus(
      await inspect("warm-after-public-refresh"),
      "hit",
      "warm-after-public-refresh",
    );
    const changed = await commit(
      files.changed,
      "Add committed call edges and declaration metadata",
    );
    before = await inventory(repo);
    cacheStatus(
      await inspect("new-revision-cold", { revision: changed, changed: true }),
      "miss",
      "new-revision-cold",
    );
    cacheStatus(
      await inspect("new-revision-warm", { revision: changed, changed: true }),
      "hit",
      "new-revision-warm",
    );
    await publicQuery("public-new-revision", changed, true);
    cacheStatus(
      await inspect("old-revision-still-original"),
      "hit",
      "old-revision-still-original",
    );
    await publicQuery("public-old-revision", original, false);
    const foreign = join(root, "foreign", "repository");
    await mkdir(dirname(foreign));
    await git(["clone", "--quiet", "--no-hardlinks", repo, foreign]);
    assert.equal(
      await git(["rev-parse", `${original}^{tree}`], foreign),
      originalTree,
      "foreign repository negative control has the exact same tree",
    );
    cacheStatus(
      await inspect("foreign-same-tree-cold", { repository: foreign }),
      "miss",
      "foreign-same-tree-cold",
    );
    cacheStatus(
      await inspect("foreign-own-warm", { repository: foreign }),
      "hit",
      "foreign-own-warm",
    );
    cacheStatus(
      await inspect("different-dev-build-cold", { graph: graphB }),
      "miss",
      "different-dev-build-cold",
    );
    cacheStatus(
      await inspect("different-dev-build-warm", { graph: graphB }),
      "hit",
      "different-dev-build-warm",
    );
    const configured = join(root, "mutable-graph");
    await copyFile(graphA, configured);
    await chmod(configured, 0o755);
    const replacement = await inspect("mid-inspection-replacement", {
      graph: configured,
      replaceWith: graphB,
    });
    assert.equal(
      replacement["replaced"],
      true,
      "configured binary replaced after retrieval command",
    );
    assert.equal(
      digest(configured),
      shaB,
      "configured binary now contains build B",
    );
    cacheStatus(
      await inspect("next-inspection-uses-replacement", { graph: configured }),
      "hit",
      "next-inspection-uses-replacement",
    );
    const barrier = join(root, "barrier");
    const concurrentCache = join(root, "concurrent-cache");
    await Promise.all([mkdir(barrier), mkdir(concurrentCache)]);
    assert.deepEqual(
      await readdir(concurrentCache),
      [],
      "concurrent pair starts with an empty cache",
    );
    const concurrentPending = Promise.allSettled([
      inspect("concurrent-first", { barrier, cacheRoot: concurrentCache }),
      inspect("concurrent-second", { barrier, cacheRoot: concurrentCache }),
    ]);
    try {
      const barrierDeadline = performance.now() + 15000;
      while (
        (await readdir(barrier)).filter((name) => name.startsWith("ready-"))
          .length < 2
      ) {
        if (performance.now() > barrierDeadline)
          throw new Error("Concurrent probes did not reach retrieval.");
        await Bun.sleep(20);
      }
      const simultaneousViews = await Promise.all(
        (await readdir(barrier))
          .filter((name) => name.startsWith("ready-"))
          .map(async (name) =>
            (await Bun.file(join(barrier, name)).text()).trim(),
          ),
      );
      assert.equal(
        new Set(simultaneousViews).size,
        2,
        "concurrent views have separate ownership",
      );
      assert.equal(
        simultaneousViews.every(existsSync),
        true,
        "both views are alive before either inspection continues",
      );
      checks.push({
        label: "simultaneous-view-ownership",
        elapsedMs: 0,
        facts: { views: simultaneousViews, bothAlive: true },
      });
    } finally {
      await Bun.write(join(barrier, "release"), "continue\n");
      await concurrentPending;
    }
    const concurrent = await concurrentPending;
    concurrent.forEach((result, index) => {
      if (result.status === "rejected") throw result.reason;
      cacheStatus(result.value, ["hit", "miss"], `concurrent-${index}`);
    });
    assert.equal(
      concurrent.some((result) => {
        if (result.status === "rejected") return false;
        const retrieval = object(
          array(result.value["events"], "events")[0],
          "retrieval",
        );
        const value = object(
          object(retrieval["outcome"], "outcome")["value"],
          "query",
        );
        return object(value["cache"], "query cache")["status"] === "miss";
      }),
      true,
      "at least one concurrent inspection builds the previously absent snapshot",
    );
    cacheStatus(
      await inspect("warm-after-concurrent-publication", {
        cacheRoot: concurrentCache,
      }),
      "hit",
      "warm-after-concurrent-publication",
    );
    assert.equal(
      await inventory(repo),
      before,
      "concurrent inspections preserve unrelated registrations",
    );
    const unusable = join(root, "cache-is-a-file");
    await Bun.write(
      unusable,
      "a regular file cannot contain a cache directory\n",
    );
    cacheStatus(
      await inspect("unusable-cache-fallback", { cacheRoot: unusable }),
      "miss",
      "unusable-cache-fallback",
      "miss",
    );
    await inspect("unusable-cache-refresh-fails", {
      cacheRoot: unusable,
      cache: "refresh",
      expectedError: true,
    });
    await publicQuery(
      "public-unusable-cache-refresh-fails",
      original,
      false,
      true,
      unusable,
      true,
    );
    assert.deepEqual(
      await readdir(views),
      [],
      "all inspection temporary parents removed",
    );
    await git(["worktree", "remove", "--force", preexisting]);
    checks.push({
      label: "independent-fixture-source",
      elapsedMs: 0,
      facts: {
        original,
        changed,
        originalTree,
        changedTree: await git(["rev-parse", "HEAD^{tree}"]),
        files,
        buildA: { path: graphA, sha256: shaA },
        buildB: { path: graphB, sha256: shaB },
        note: "Scope collision, corrupt snapshot decoding, and late stale generation writes are engine-owned behavioral tests. This lever does not decode or manipulate Graph cache layout.",
      },
    });
  } catch (error) {
    failure =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    throw error;
  } finally {
    await mkdir(dirname(reportPath), { recursive: true });
    await Bun.write(
      reportPath,
      `${JSON.stringify({ schemaVersion: 1, status: failure === null ? "passed" : "failed", failure, checks, commands, runtimeRoot: root, generatedAt: new Date().toISOString() }, null, 2)}\n`,
    );
    // Only this mkdtemp-owned repository, binaries, cache, and views are removed.
    await rm(root, { recursive: true, force: true });
    await Bun.write(
      Bun.stderr,
      `Graph cache verification report: ${reportPath}\n`,
    );
  }
};

if (Bun.argv.includes("--help")) {
  await Bun.write(
    Bun.stdout,
    "Usage: bun run verify:graph-cache [--graph-a /absolute/native-binary] [--graph-b /absolute/different-native-binary] [--neuve /absolute/built-neuve] [--report /absolute/report.json]\n\nWithout binary arguments, builds two real Graph binaries with different Go build IDs and one public Neuve binary in an owned temporary directory. Both Graph builds must report dev. Uses real committed Go and Python fixtures, an isolated cache, independently owned inspection views, and literal source/edge/metadata expectations. Reports timings without machine-specific thresholds. No install, provider receipt parser, or cache-layout decoder.\n",
  );
} else {
  try {
    const values = options(Bun.argv.slice(2));
    if (values.has("--probe")) await probe(values);
    else await main(values);
  } catch (error) {
    await Bun.write(
      Bun.stderr,
      `verify-graph-cache: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
