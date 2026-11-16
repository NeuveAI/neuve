import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { inspectGraph, type GraphCommandReceipt } from "../src/index.ts";

const binary = process.argv[2];
if (binary === undefined || !isAbsolute(binary) || process.argv.length !== 3) {
  throw new Error(
    "Usage: bun run verify:prepared /absolute/path/to/neuve-graph",
  );
}
const directory = await mkdtemp(
  join(tmpdir(), "neuve-prepared-native-client-"),
);
const repository = join(directory, "executable"),
  cache = join(repository, ".git/neuve/graph/cache");
async function run(argv: string[], cwd = directory) {
  const child = Bun.spawn(argv, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assert.equal(exit, 0, stderr);
  return stdout.trim();
}
try {
  await run(["git", "init", "--quiet", repository]);
  await mkdir(join(repository, "src"));
  await Bun.write(
    join(repository, "src/decision.ts"),
    "export function persistDecision() { return 'recorded'; }\nexport function reviewDecision() { return persistDecision(); }\n",
  );
  await run(["git", "add", "."], repository);
  await run(
    [
      "git",
      "-c",
      "user.name=Verification",
      "-c",
      "user.email=verification@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "prepared native client",
    ],
    repository,
  );
  const revision = await run(["git", "rev-parse", "HEAD"], repository);
  const receipts: GraphCommandReceipt[] = [];
  const request = {
    executable: binary,
    repository,
    revision,
    question: "  persist decision and its caller?  ",
    limits: { topK: 5, maxContextBytes: 16000 },
    cache: "prepared" as const,
    relationships: [
      {
        id: "callers",
        focus: { name: "persistDecision", path: "src/decision.ts" },
        relation: "CALLS",
        selection: "exact" as const,
        direction: "in" as const,
        depth: 1 as const,
        limit: 5,
      },
    ],
  };
  const missing = await inspectGraph(request, {
    onCommand: (receipt) => receipts.push(receipt),
  });
  assert.equal(missing.query.kind, "error");
  if (missing.query.kind === "error")
    assert.equal(missing.query.error.preparedFailure, "missing");
  assert.equal(
    receipts.some((receipt) => receipt.stage === "index"),
    false,
  );
  await run([
    binary,
    "index",
    "--repo",
    repository,
    "--head",
    "--profile",
    "full",
    "--cache-dir",
    cache,
    "--format",
    "json",
  ]);
  receipts.length = 0;
  const result = await inspectGraph(request, {
    onCommand: (receipt) => receipts.push(receipt),
  });
  assert.equal(result.query.kind, "success", JSON.stringify(result.query));
  if (result.query.kind === "success") {
    assert.equal(result.query.value.cache.analysisScope, "complete-prepared");
    assert(
      result.query.value.results.some(
        (item) => item.kind === "symbol" && item.symbol === "persistDecision",
      ),
    );
  }
  const callers = result.relationships[0]?.outcome;
  assert.equal(callers?.kind, "success", JSON.stringify(callers));
  if (callers?.kind === "success") {
    assert.equal(callers.value.cache.analysisScope, "complete-prepared");
    assert(
      callers.value.observations.some(
        (edge) =>
          edge.from.name === "reviewDecision" &&
          edge.to.name === "persistDecision" &&
          edge.resolution === "exact",
      ),
    );
  }
  assert.equal(
    receipts.some((receipt) => receipt.stage === "index"),
    false,
  );
  const reads = receipts.filter(
    (receipt) =>
      receipt.stage === "query" ||
      (receipt.stage.startsWith("relationship:") &&
        (receipt.stage.endsWith(":resolution") ||
          receipt.stage.endsWith(":observation"))),
  );
  assert.equal(reads.length, 3);
  assert(reads.every((receipt) => receipt.argv.includes("--prepared-only")));
  assert.equal(
    (await run(["git", "worktree", "list", "--porcelain"], repository))
      .split("\n")
      .filter((line) => line.startsWith("worktree ")).length,
    1,
  );
  console.log(
    JSON.stringify(
      {
        passed: true,
        checks: [
          "missing artifact explicit; no client indexing",
          "real native preparation reused across qualified detached read",
          "source basename executable cannot collide with pinned executable directory",
          "exact same-file caller and source-range qualification",
          "all query/neighbor calls prepared-only",
          "owned detached view cleaned",
        ],
        provider: result.provider.executable,
        queryQuestion: request.question,
        readCommands: reads.length,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
