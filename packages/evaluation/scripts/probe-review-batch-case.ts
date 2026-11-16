import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type CommandResult = Readonly<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

type WorktreeState = "staged" | "unstaged" | "untracked";

type PatchSource =
  "index_vs_head" | "worktree_vs_index" | "added_file_vs_empty";

type CapturedHunk = Readonly<{
  hunk_identity: string;
  old_range: Readonly<{ start: number; lines: number }>;
  new_range: Readonly<{ start: number; lines: number }>;
}>;

type CapturedPatch = Readonly<{
  source: PatchSource;
  patch_identity: string;
  hunks: readonly CapturedHunk[];
}>;

type CandidateTransientMarker = Readonly<{
  marker_identity: string;
  batch_identity: string;
  approval_state: "unapproved";
  from_unit: string;
  to_unit: string;
}>;

type CandidateBatchContext = Readonly<{
  batch_identity: string;
}>;

const evaluateCandidateMarkerUse = (
  marker: CandidateTransientMarker,
  context: CandidateBatchContext,
): Readonly<{
  accepted: boolean;
  reason: "same_batch" | "batch_identity_mismatch";
}> =>
  marker.batch_identity === context.batch_identity
    ? { accepted: true, reason: "same_batch" }
    : { accepted: false, reason: "batch_identity_mismatch" };

const run = async (
  command: readonly string[],
  input: Readonly<{
    cwd?: string;
    env?: Readonly<Record<string, string>>;
  }> = {},
): Promise<CommandResult> => {
  const child = Bun.spawn([...command], {
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.env === undefined
      ? {}
      : { env: { ...process.env, ...input.env } }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
};

const output = (result: CommandResult, label: string): string => {
  if (result.exitCode !== 0) {
    throw new Error(
      `${label} exited with ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout;
};

const git = async (
  repository: string,
  args: readonly string[],
  label: string,
  env?: Readonly<Record<string, string>>,
): Promise<string> =>
  output(
    await run(["git", "-C", repository, ...args], {
      ...(env === undefined ? {} : { env }),
    }),
    label,
  ).trim();

const digest = (source: string): string =>
  new Bun.CryptoHasher("sha256").update(source).digest("hex");

const parseRange = (
  start: string,
  lines: string | undefined,
): Readonly<{ start: number; lines: number }> => ({
  start: Number.parseInt(start, 10),
  lines: lines === undefined ? 1 : Number.parseInt(lines, 10),
});

const parsePatch = (patch: string, source: PatchSource): CapturedPatch => {
  const lines = patch.split("\n");
  const headers: Array<{
    index: number;
    match: RegExpMatchArray;
  }> = [];
  for (const [index, line] of lines.entries()) {
    const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (match !== null) headers.push({ index, match });
  }
  if (headers.length === 0) {
    throw new Error(`The ${source} patch did not contain a Git hunk.`);
  }
  const hunks = headers.map(({ index, match }, headerIndex) => {
    const nextIndex = headers[headerIndex + 1]?.index ?? lines.length;
    const hunkPatch = lines.slice(index, nextIndex).join("\n");
    const oldStart = match[1];
    const newStart = match[3];
    if (oldStart === undefined || newStart === undefined) {
      throw new Error(`The ${source} patch contained an invalid hunk header.`);
    }
    return {
      hunk_identity: `sha256:${digest(hunkPatch)}`,
      old_range: parseRange(oldStart, match[2]),
      new_range: parseRange(newStart, match[4]),
    };
  });
  return {
    source,
    patch_identity: `sha256:${digest(patch)}`,
    hunks,
  };
};

const capturePatches = async (
  repository: string,
): Promise<
  Readonly<{
    staged: CapturedPatch;
    unstaged: CapturedPatch;
    untracked: CapturedPatch;
  }>
> => {
  const [stagedResult, unstagedResult, untrackedResult] = await Promise.all([
    run(
      [
        "git",
        "-C",
        repository,
        "diff",
        "--cached",
        "--unified=0",
        "--no-ext-diff",
        "--",
        "src/review.ts",
      ],
      {},
    ),
    run(
      [
        "git",
        "-C",
        repository,
        "diff",
        "--unified=0",
        "--no-ext-diff",
        "--",
        "src/summary.ts",
      ],
      {},
    ),
    run(
      [
        "git",
        "-C",
        repository,
        "diff",
        "--no-index",
        "--unified=0",
        "--no-ext-diff",
        "--",
        "/dev/null",
        "src/context.ts",
      ],
      { cwd: repository },
    ),
  ]);
  const stagedPatch = output(stagedResult, "Capture staged patch");
  const unstagedPatch = output(unstagedResult, "Capture unstaged patch");
  if (untrackedResult.exitCode !== 1) {
    throw new Error(
      `Added-file diff must exit 1, got ${untrackedResult.exitCode}: ${untrackedResult.stderr.trim()}`,
    );
  }
  return {
    staged: parsePatch(stagedPatch, "index_vs_head"),
    unstaged: parsePatch(unstagedPatch, "worktree_vs_index"),
    untracked: parsePatch(untrackedResult.stdout, "added_file_vs_empty"),
  };
};

const assertGitState = (
  status: string,
  expected: Readonly<{
    path: string;
    prefix: string;
    state: WorktreeState;
  }>,
): void => {
  const line = status.split("\n").find((item) => item.endsWith(expected.path));
  if (line === undefined || !line.startsWith(expected.prefix)) {
    throw new Error(
      `${expected.path} must be ${expected.state}; status=${JSON.stringify(status)}.`,
    );
  }
};

const writeFixture = async (repository: string): Promise<void> => {
  await mkdir(join(repository, "src"), { recursive: true });
  await Promise.all([
    Bun.write(
      join(repository, "src/review.ts"),
      [
        "export const reviewUnit = (input: string): string => {",
        "  return input;",
        "};",
        "",
      ].join("\n"),
    ),
    Bun.write(
      join(repository, "src/summary.ts"),
      [
        "export const summarizeLegacy = (input: string): string => {",
        "  return `${input}:committed`;",
        "};",
        "",
      ].join("\n"),
    ),
  ]);
};

const createCommittedBase = async (repository: string): Promise<string> => {
  output(await run(["git", "init", "--quiet", repository]), "Git init");
  await writeFixture(repository);
  await git(repository, ["add", "src"], "Git add base");
  const fixedIdentity = {
    GIT_AUTHOR_DATE: "2026-09-27T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-09-27T00:00:00Z",
  };
  await git(
    repository,
    [
      "-c",
      "user.name=Neuve Probe",
      "-c",
      "user.email=probe@neuve.invalid",
      "commit",
      "--quiet",
      "-m",
      "committed graph base",
    ],
    "Git commit base",
    fixedIdentity,
  );
  return git(repository, ["rev-parse", "HEAD"], "Base revision");
};

const createCurrentBatch = async (
  repository: string,
): Promise<
  Readonly<{
    stagedSource: string;
    unstagedSource: string;
    untrackedSource: string;
  }>
> => {
  const stagedSource = [
    'import { summarizeSiblingContext } from "./summary.ts";',
    "",
    "export const reviewUnit = (input: string): string => {",
    "  return summarizeSiblingContext(input);",
    "};",
    "",
  ].join("\n");
  const unstagedSource = [
    'import { describeNewArtifact } from "./context.ts";',
    "",
    "export const summarizeLegacy = (input: string): string => {",
    "  return `${input}:committed`;",
    "};",
    "",
    "export const summarizeSiblingContext = (input: string): string => {",
    "  return `${input}:${describeNewArtifact()}`;",
    "};",
    "",
  ].join("\n");
  const untrackedSource = [
    "export const describeNewArtifact = (): string => {",
    '  return "same-batch context";',
    "};",
    "",
  ].join("\n");

  await Bun.write(join(repository, "src/review.ts"), stagedSource);
  await git(repository, ["add", "src/review.ts"], "Git stage caller");
  await Promise.all([
    Bun.write(join(repository, "src/summary.ts"), unstagedSource),
    Bun.write(join(repository, "src/context.ts"), untrackedSource),
  ]);
  return { stagedSource, unstagedSource, untrackedSource };
};

const runProbe = async (repository: string) => {
  const currentBatchIdentity: string = "fixture-batch-a";
  const secondBatchIdentity: string = "fixture-batch-b";
  const revision = await createCommittedBase(repository);
  const baseBlobs = {
    review: await git(
      repository,
      ["rev-parse", `${revision}:src/review.ts`],
      "Committed review blob",
    ),
    summary: await git(
      repository,
      ["rev-parse", `${revision}:src/summary.ts`],
      "Committed summary blob",
    ),
  };
  const sources = await createCurrentBatch(repository);
  const status = await git(
    repository,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    "Current batch status",
  );
  assertGitState(status, {
    path: "src/review.ts",
    prefix: "M ",
    state: "staged",
  });
  assertGitState(status, {
    path: "src/summary.ts",
    prefix: " M",
    state: "unstaged",
  });
  assertGitState(status, {
    path: "src/context.ts",
    prefix: "??",
    state: "untracked",
  });
  const [stagedIndexSource, unstagedWorktreeSource, untrackedWorktreeSource] =
    await Promise.all([
      run(["git", "-C", repository, "show", ":src/review.ts"]).then((result) =>
        output(result, "Read staged caller bytes"),
      ),
      Bun.file(join(repository, "src/summary.ts")).text(),
      Bun.file(join(repository, "src/context.ts")).text(),
    ]);
  if (
    stagedIndexSource !== sources.stagedSource ||
    unstagedWorktreeSource !== sources.unstagedSource ||
    untrackedWorktreeSource !== sources.untrackedSource
  ) {
    throw new Error("Captured batch bytes differ from the fixture sources.");
  }
  const patches = await capturePatches(repository);
  const candidateMarker: CandidateTransientMarker = {
    marker_identity: "fixture-marker-a-to-sibling",
    batch_identity: currentBatchIdentity,
    approval_state: "unapproved",
    from_unit: "staged-caller",
    to_unit: "unstaged-sibling",
  };
  const sameBatchDecision = evaluateCandidateMarkerUse(candidateMarker, {
    batch_identity: currentBatchIdentity,
  });
  const crossBatchDecision = evaluateCandidateMarkerUse(candidateMarker, {
    batch_identity: secondBatchIdentity,
  });
  if (
    !sameBatchDecision.accepted ||
    sameBatchDecision.reason !== "same_batch"
  ) {
    throw new Error("The candidate marker was rejected from its source batch.");
  }
  if (
    crossBatchDecision.accepted ||
    crossBatchDecision.reason !== "batch_identity_mismatch"
  ) {
    throw new Error(
      "A transient marker escaped into a different review batch.",
    );
  }
  return {
    schema_version: 1,
    case: {
      id: "committed-base-current-batch",
      status: "candidate_baseline",
      language: "TypeScript",
      accepted_as_neuve_evidence: false,
    },
    committed_graph_input: {
      revision,
      ingestion_role: "durable_base",
      ingestion_performed: false,
      commit_and_blob_identity_available: true,
      blobs: [
        { path: "src/review.ts", blob_oid: baseBlobs.review },
        { path: "src/summary.ts", blob_oid: baseBlobs.summary },
      ],
    },
    current_review_batch: {
      fixture_batch_identity: currentBatchIdentity,
      production_identity_mechanics: "deferred",
      approval_state: "unapproved",
      review_units: [
        {
          unit_id: "staged-caller",
          path: "src/review.ts",
          worktree_state: "staged",
          content_identity: `sha256:${digest(stagedIndexSource)}`,
          patch: patches.staged,
          historical_attribution_available: false,
        },
        {
          unit_id: "unstaged-sibling",
          path: "src/summary.ts",
          worktree_state: "unstaged",
          content_identity: `sha256:${digest(unstagedWorktreeSource)}`,
          patch: patches.unstaged,
          historical_attribution_available: false,
        },
        {
          unit_id: "newly-added-context",
          path: "src/context.ts",
          worktree_state: "untracked",
          content_identity: `sha256:${digest(untrackedWorktreeSource)}`,
          patch: patches.untracked,
          historical_attribution_available: false,
        },
      ],
      candidate_transient_context: [
        {
          from_unit: "staged-caller",
          to_unit: "unstaged-sibling",
          relationship: "call",
          label: "same_batch_unapproved",
          batch_identity: currentBatchIdentity,
          disposition_transfer: false,
        },
        {
          from_unit: "unstaged-sibling",
          to_unit: "newly-added-context",
          relationship: "call",
          label: "same_batch_unapproved",
          batch_identity: currentBatchIdentity,
          disposition_transfer: false,
        },
      ],
    },
    cross_batch_negative_scenario: {
      marker: candidateMarker,
      source_batch_decision: sameBatchDecision,
      second_batch: { batch_identity: secondBatchIdentity },
      second_batch_decision: crossBatchDecision,
    },
    controls: {
      git_states_confirmed: true,
      review_units_derived_from_git_hunks: true,
      added_file_patch_synthesized: true,
      same_batch_marker_use_accepted: sameBatchDecision.accepted,
      cross_batch_marker_reuse_rejected: !crossBatchDecision.accepted,
      public_query_schema_changed: false,
    },
  };
};

const temporaryRoot = await mkdtemp(
  join(tmpdir(), "neuve-review-batch-probe-"),
);
const repository = join(temporaryRoot, "repository");
let report: Awaited<ReturnType<typeof runProbe>>;
try {
  report = await runProbe(repository);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
if (existsSync(temporaryRoot)) {
  throw new Error(`Probe did not remove ${temporaryRoot}.`);
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
