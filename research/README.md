# Research

This tree holds research memos, benchmark methods and case metadata, each linked to its sources.

## What is kept private

Some research material is kept in Neuve's private archive, the private repository this public one was cut from:

- pull requests and code reviews captured from public projects, which carry their contributors' names and comments;
- copies of articles and talks, mostly by other people, that Neuve doesn't have permission to reproduce;
- recorded model runs, benchmark inputs and the evidence selected from them;
- the capture indexes, scripts and tests that only work on that material.

The captures and copies hold other people's personal data and writing, so they can't be republished here. The archive also keeps recorded model runs and the code they reviewed.

Where a document in this repository cites one of these files, it says "kept in the private archive". The [exclusion list](../scripts/release/public-cut.exclude) names every path that stays there.

The [benchmark overview](pr-bench/README.md) describes the collection and its limits. Evaluation tests in this repository use fixtures kept in each package, so they run without the archive. By default, shared benchmark helpers look for their inputs inside the repository they run from.

## Tools that need the private archive

These files are kept in the private archive. Run them directly from the root of an archive checkout, with their existing arguments:

```sh
bun research/pr-bench/build-index.ts
bun research/pr-bench/verify.ts
bun packages/evaluation/src/retrieval-bench/cli.ts
bun packages/evaluation/src/retrieval-bench/arms.ts
bun packages/evaluation/src/retrieval-bench/labelling/cli.ts
bun packages/evaluation/src/retrieval-bench/labelling/later-fixes/cli.ts
bun packages/evaluation/src/retrieval-bench/score/cli.ts
bun packages/evaluation/src/harness-compare/cli.ts
bun packages/evaluation/src/harness-compare/full-test/cli.ts
```

The index builder rewrites the inventory, so save any frozen exports before you run it. The capture, replay and historical embedding runners, with their setup instructions, are kept in the private archive too. The package-script shortcuts for all of these have been removed, so run the files directly.

The store-backed `encode_main` and `rerank_main` entrypoints in `packages/evaluation/modal/bench_gpu.py` use `bench_store.py`, the store reader. Both Python files are public code, but these entrypoints need the archived store and base views. Their default locations are settings in `packages/evaluation/modal/bench_store.json`. From `packages/evaluation/modal` in an archive checkout, run:

```sh
uv run modal run bench_gpu.py::encode_main --model E2 --gpu L4 --limit 500
uv run modal run bench_gpu.py::rerank_main --gpu L4
```

The restored archive-only tests also need an archive checkout. Run them from its root:

```sh
NEUVE_MODE=check bun --no-env-file scripts/test-budget.ts apps/neuve-cli/tests/capture-close-diagnostic-archive.test.ts
NEUVE_MODE=check bun --no-env-file scripts/test-budget.ts apps/neuve-cli/tests/sidecarless-wal-readers-archive.test.ts
NEUVE_MODE=check bun --no-env-file scripts/test-budget.ts packages/evaluation/tests/retrieval-bench-heldout-archive.test.ts
NEUVE_MODE=check bun --no-env-file scripts/test-budget.ts packages/evaluation/tests/review-quality-archive.test.ts
NEUVE_MODE=check bun --no-env-file scripts/test-budget.ts packages/evaluation/tests/external-validation-case-archive.test.ts
NEUVE_MODE=check bun --no-env-file scripts/test-budget.ts packages/evaluation/tests/harness-compare-full-test-archive.test.ts
```
