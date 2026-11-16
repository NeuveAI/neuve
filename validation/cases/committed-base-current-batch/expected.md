# Expected committed-base and current-batch behavior

This candidate case freezes language-agnostic batch-overlay obligations using a TypeScript fixture. The fixture language records what the case executes; it does not define Neuve's repository-language scope. The case does not claim that Neuve already verifies transient relationships or that the public `neuve query` response has changed.

## Committed base

The fixture starts with a committed TypeScript repository. The commit and its blob identities represent durable graph input, not proof that ingestion occurred. Repository setup can ingest prior commit history and current committed state, while later commits extend that history.

## Current review batch

The fixture assigns the current work the explicit identity `fixture-batch-a`, then creates three separate unapproved review units:

- A staged caller hunk in `src/review.ts`.
- An unstaged sibling helper hunk in `src/summary.ts`.
- A newly added, untracked helper in `src/context.ts`.

The staged caller calls the unstaged helper. The unstaged helper calls the new file. These relationships are candidates for transient same-batch context. Staging status does not approve the caller, and neither call transfers a disposition between units.

Each unit is derived from a real Git patch: the staged index diff, the unstaged worktree diff, or an added-file diff synthesized against an empty file. The report records each patch identity and every exact hunk range and identity. Each transient unit also has a content digest for the exact bytes in the batch. None of these identities provide commit history or prior-review attribution.

The fixture also names `fixture-batch-b` and attempts to reuse a marker captured for batch A. The baseline must reject that attempt because the batch identities differ. These fixture identities make the rule testable without deciding how production batch identities will be constructed.

## Phase 1 baseline

Run `bun run probe:review-batch`. The command creates the repository, confirms the three Git states, captures and parses their patches and hunks, exercises the cross-batch rejection, emits canonical JSON, and removes the temporary directory. It does not run a language-specific semantic verifier; the fixture establishes batch identity, provenance, approval-state, and isolation obligations rather than reimplementing the structural engine.

## Phase 2 oracle

The batch-overlay implementation must preserve same-batch sibling context while retaining the `unapproved` and `same_batch` distinctions. It must reject cross-batch reuse, inherited approval, disposition transfer, stale content identities, mixed-state capture, abandoned batches presented as active context, approval inferred from staging transitions, and approval inferred from a commit without a review outcome. A later commit must create durable graph nodes with explicit lineage rather than rewriting transient nodes as if they were always committed; the commit does not establish a disposition.

The machine-readable [case and oracle](case.yaml) owns these obligations and negative controls.
