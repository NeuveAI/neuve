# Context-query validation cases

This directory defines validation cases for Neuve context retrieval. Public-CLI cases fix the repository state, query, result budget, expected contextual markers, and failure conditions before implementation. Candidate structural probes can also freeze a problem and its oracle before the public response or verifier supports it.

The case fixture is authoritative for automated validation. The adjacent `expected.md` explains why the expected fragments matter and distinguishes accepted product requirements from evaluation-only labels.

## What is kept private

Benchmark inputs and results, selected run evidence, the review-quality datasets and the external `neuve_effect` suite are kept in Neuve's private archive, the private repository this public one was cut from. They include recorded model runs and the code they reviewed. Where a document cites one of these files, it says "kept in the private archive". The [exclusion list](../scripts/release/public-cut.exclude) names every path that stays there, including capture indexes. This repository keeps the [validation fixtures](fixtures/) and [case definitions](cases/) that its tests use.

## Case layout

Each case directory contains:

- `case.yaml`, the machine-readable input and oracle.
- `expected.md`, the human review of the oracle.

A later run stores evidence outside the case directory. Evidence must include the binary and provider versions, the command, standard output, standard error, the exit code, the canonical result, and Git status before and after the query.

## Evaluation labels

The fixture uses `direct_support`, `surrounding_context`, `contradiction`, and `unrelated` to assess retrieval output. These values are evaluation annotations. They do not add terms to the [product vocabulary](../vocabulary.md).

The validator checks missing direct support and wrong direct support separately. A single score must not hide either failure.

## First case

The mixed visible-member case (kept in the private archive, since it reads a checkout on the owner's machine) asks Neuve to explain the `mergeBlocking` contract around `validateDiffSlice`. It records the first lexical-provider milestone at a fixed Git revision in the legacy Neuve repository. It is historical regression evidence, not a structural-language support requirement.

The case and its selected result are frozen historical evidence. The evaluator that produced the result is no longer present in the working tree and is recoverable only from Git history. The case is no longer a live public-CLI gate after the graph-backed schema replaced contextual-marker classification; future validation must use a successor case rather than reinterpret or overwrite these bytes.

## Current-batch baseline

The [committed-base/current-batch case](cases/committed-base-current-batch/expected.md) records the accepted distinction between durable committed graph input and unapproved work in the current review batch. Its executable baseline derives staged, unstaged, and newly added review units from real Git patches and exact hunks in a TypeScript fixture; that factual fixture label does not define product scope. Explicit fixture batch identities make the cross-batch rejection executable without choosing production identity mechanics. The frozen Phase 2 oracle requires visibly labeled same-batch context without historical attribution, inherited approval, or disposition transfer.

## External structural-engine validation

The external `neuve_effect` suite (kept in the private archive) freezes three realistic TypeScript fixtures against committed history. Their declared language is factual case metadata, not a product-language selection. Future runs check the v2 public boundary, unchanged natural-language retrieval through the Neuve-owned engine fork, and an explicit, possibly empty relationship plan separately from semantic verdicts. The selected Phase 3 report still contains the then-live lexical comparison and remains immutable historical evidence; its missing retrieval roles and structural contract failures define fixture-specific engine work without constraining the engine's language scope. The final public-cutover rerun built committed Neuve source `30b3426a163b37f85fa7eef0ebba0cee10025cfc`, produced byte-identical canonical reports across two attempts, and cleaned every run-owned path while preserving the red engine obligations for the next phase.

## Tools that need the private archive

These files are kept in the private archive. Run them directly from the root of an archive checkout, with their existing arguments:

```sh
bun packages/evaluation/scripts/verify-external-neuve-effect.ts
bun packages/evaluation/scripts/verify-review-quality.ts
bun packages/evaluation/scripts/measure-dependency-investigation.ts
bun packages/evaluation/scripts/measure-parallel-investigation.ts
bun packages/evaluation/scripts/measure-post-cache-gates.ts
bun packages/harness/scripts/e0-parity.ts
bun packages/harness/scripts/e0-chunk-parity.ts
```

The inputs these runners read are kept in the private archive too, and their package-script shortcuts have been removed. Tests in this repository use fixtures kept in each package, so they run without the archive.

The restored archive-only test files are kept there too. Run them from the root of an archive checkout:

```sh
NEUVE_MODE=check bun --no-env-file scripts/test-budget.ts apps/neuve-cli/tests/capture-close-diagnostic-archive.test.ts
NEUVE_MODE=check bun --no-env-file scripts/test-budget.ts apps/neuve-cli/tests/sidecarless-wal-readers-archive.test.ts
NEUVE_MODE=check bun --no-env-file scripts/test-budget.ts packages/evaluation/tests/retrieval-bench-heldout-archive.test.ts
NEUVE_MODE=check bun --no-env-file scripts/test-budget.ts packages/evaluation/tests/review-quality-archive.test.ts
NEUVE_MODE=check bun --no-env-file scripts/test-budget.ts packages/evaluation/tests/external-validation-case-archive.test.ts
NEUVE_MODE=check bun --no-env-file scripts/test-budget.ts packages/evaluation/tests/harness-compare-full-test-archive.test.ts
NEUVE_MODE=check bun --no-env-file scripts/test-budget.ts packages/harness/tests/pi/capture/archive-store-policy.test.ts
```

The store-backed `encode_main` and `rerank_main` entrypoints in `packages/evaluation/modal/bench_gpu.py` use `bench_store.py`, the store reader. Both Python files are public code, but these entrypoints need the archived store and base views. Their default locations are settings in `packages/evaluation/modal/bench_store.json`. From `packages/evaluation/modal` in an archive checkout, run:

```sh
uv run modal run bench_gpu.py::encode_main --model E2 --gpu L4 --limit 500
uv run modal run bench_gpu.py::rerank_main --gpu L4
```
