export const GRAPH_DEPENDENT_TESTS = [
  {
    cwd: "packages/harness",
    file: "tests/graph-fallback.test.ts",
    names: [
      "past the review's wait, Graph's leads and answers fall back, disclosed and counted, while Graph finishes and keeps them",
    ],
  },
  {
    cwd: "packages/harness",
    file: "tests/graph-leads-at-commit.test.ts",
    names: [
      "Graph's leads are searched at commit time with their timings and CPU, and the review finds them ready",
    ],
  },
  {
    cwd: "packages/harness",
    file: "tests/graph-declare.test.ts",
    names: [
      "the worker declares the bases still needed, none that ended, and looks again after a failure",
    ],
  },
  {
    cwd: "apps/neuve-cli",
    file: "tests/preparation-orphan.test.ts",
    names: [
      "SIGKILL of prepare-code stops a real indexing engine and its group within five seconds",
      "SIGKILL of prepare-commit stops a real indexing engine and its group within five seconds",
    ],
  },
  {
    cwd: "packages/harness",
    file: "tests/sections.test.ts",
    names: [
      "a file's structure: imports as one block, a declaration with its namesake, a suite opened into its tests, a class kept whole",
      "a newly added file is cut into its parts, and the parts own exactly the lines the review rules gave the hunk",
      "changes to several members of one class are one section, across hunks",
      "nested describe and it calls use exposed outline ranges and never open class members",
    ],
  },
  {
    cwd: "packages/harness",
    file: "tests/stack-index-admission.test.ts",
    names: [
      "upgrades the real available index fixture through admission",
      "upgrades the real unavailable index fixture through admission",
      "upgrades the real source-bound-graph index fixture through admission",
      "stack build cancellation during Graph work never publishes",
      "stack admission cancellation during Graph work never publishes",
      "the previous unverified Graph recipe upgrades through admission",
    ],
  },
  {
    cwd: "packages/harness",
    file: "tests/graph-source-binding.test.ts",
    names: [
      "stack discards an engine change before-graph and the next request rebuilds",
      "stack discards an engine change freeze-ABA and the next request rebuilds",
      "snapshot discards an engine change before-graph and the next request rebuilds",
      "snapshot discards an engine change freeze-ABA and the next request rebuilds",
    ],
  },
  {
    cwd: "packages/harness",
    file: "tests/graph-request-source.test.ts",
    names: [
      "shared tree materialization serves an index from its keyed engine",
    ],
  },
  {
    cwd: "packages/harness",
    file: "tests/graph-outline-parts.test.ts",
    names: [
      "the holder keeps an outline it cannot publish; a subscriber elsewhere gets the recorded failure, disclosed once",
      "a read over its bound comes in parts, each its own key, and the merged answer is one whole read's, file by file",
      "two callers in different processes asking for the same read at once start each part once",
      "two callers whose reads overlap share the parts they have in common",
      "within the CPU budget at most the fixed number of parts run at once, one inside an inherited grant, and cancellation stops the rest",
    ],
  },
  {
    cwd: "packages/harness",
    file: "tests/graph-outline-discovery.test.ts",
    names: [
      "checkout outline discovery and source identity do not depend on HOME or cwd",
      "replacing a PATH-named engine rejects its old stack index",
    ],
  },
  {
    cwd: "packages/harness",
    file: "tests/commit-hunks-source.test.ts",
    names: ["stored commit hunks use the source identity in their key"],
  },
  {
    cwd: "packages/harness",
    file: "tests/index-budget.test.ts",
    names: [
      "an existing outer grant admits once and a warm chunk cache admits nothing",
    ],
  },
  {
    cwd: "packages/harness",
    file: "tests/precompute-lock.test.ts",
    names: [
      "a completed background index publishes before yielding to a new review",
    ],
  },
  {
    cwd: "packages/harness",
    file: "tests/precompute-priority.test.ts",
    names: [
      "two processes reuse one index build through the bounded temporary cache",
    ],
  },
  {
    cwd: "packages/harness",
    file: "tests/result-cap.test.ts",
    names: [
      "every pager's whole result stays within 3,000 UN9 tokens, and uses loses no match",
    ],
  },
  {
    cwd: "packages/harness",
    file: "tests/git-read-retrieval.test.ts",
    names: [
      "describeHunks keeps the captured hunk and query data when a shared symlink blob straddles groups",
    ],
  },
  {
    cwd: "packages/harness",
    file: "tests/stack-tools.test.ts",
    names: [
      "the stack tools freeze the stack state per cycle, read third-party data wrapped and labelled, and never pass for the repository",
    ],
  },
  {
    cwd: "packages/harness",
    file: "tests/relations-real.test.ts",
    names: [
      "the real engine reads the merge base and the head by commit while HEAD is on the base branch's tip, and the slice shows the real callers, the declared test callers, and counts the name match as dropped",
      "the real engine says where each import of a commit resolves while HEAD is elsewhere",
      "on the real engine, file-level callers removed with a function are not still pointing at it, and untouched ones are",
      "with the worker's socket in the repository's Git directory, both sides are read from the store's private clone and the repository is untouched",
      "a commit made after the private clone exists is read from it",
      "moving the private clone's HEAD between two reads of one commit gives the same index",
      "on the real engine, Python relative modules sharing one relation are read on both sides of a round, and each answers its own target",
    ],
  },
  {
    cwd: "packages/harness",
    file: "tests/relations-matched-real.test.ts",
    names: [
      "on the real engine, a resolved, a receiver-type and a name-only call into changed symbols each say how they were matched, and a same-file name-only method match is counted, not kept",
    ],
  },
  {
    cwd: "packages/harness",
    file: "tests/relations-fixture.test.ts",
    names: [
      "on the real engine, every expected relation is the row the slice gives, with its match class, test flag and site, and no other row appears",
      "on the real engine, the three removals, the symbols with no caller, the counterparts, two members of one name, the counts and the changed edges are as recorded",
    ],
  },
  {
    cwd: "packages/harness",
    file: "tests/relations-task.test.ts",
    names: [
      "on the real engine the task stores both sides once each, and a round afterwards reads both stored",
    ],
  },
  {
    cwd: "packages/harness",
    file: "tests/commit-relations-real.test.ts",
    names: [
      "a review started after preparation finds both sides stored without starting a read",
      "with readings off the preparation child reads nothing, makes no clone and logs as before",
      "a range preparation reads no relations, for the range or any of its commits",
      "the worker's and the preparation child's clones give the same index, repoKey included",
      "with the commit's hunks held by another caller, the preparation reads no relations",
    ],
  },
  // The CLI copies the committed validation manifest before starting its fake provider; keep that startup/SIGINT case local.

  {
    cwd: "packages/evaluation",
    file: "tests/retrieval-bench-cancel.test.ts",
    names: [
      "interrupting a one-file benchmark view aborts its real Graph symbols command",
      "interrupting a one-file benchmark query aborts its real Graph symbols command",
      "interrupting a one-file benchmark changed-symbols aborts its real Graph symbols command",
      "benchmark CLI shutdown reaches provider setup before its command starts",
    ],
  },
];

export const escapeTestName = (name: string) =>
  name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const graphTestArguments = () => [
  ...GRAPH_DEPENDENT_TESTS.map(({ cwd, file }) => `./${cwd}/${file}`),
  "--test-name-pattern",
  `^(?:${GRAPH_DEPENDENT_TESTS.flatMap(({ names }) => names)
    .map(escapeTestName)
    .join("|")})$`,
];
