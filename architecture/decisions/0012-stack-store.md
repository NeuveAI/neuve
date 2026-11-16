# 0012: The stack store, a third kind of persistence

Status: accepted, 21 October 2026. Source: decisions [11.14 and 11.15](../../process/decisions.md#area-11-verification-and-review-delivery-19-october-2026), which accept the [stack-context proposal](../../process/proposals/stack-context.md) (its rows SC2, SC5, SC6 and SC7, and conflict X12). It adds to [0004](0004-persistence-and-range-immutability.md), whose two kinds of persistence stay as they are.

## Context

Reviewers and implementers search the sources of the stack a repository uses: its framework's and dependencies' published packages and, for the most-used, the upstream repository at the published commit (11.14). These are third-party inputs, not the repository's work, and the same entry serves every repository that pins it. They are large (this repository's direct dependencies take about 250 MiB) and can always be fetched again, though not always successfully: packages are unpublished, repositories deleted and commits force-pushed away.

[0004](0004-persistence-and-range-immutability.md) gives persistence exactly two kinds, the record log and the computation store, both in `.git/neuve/` (8.6), and makes the computation store the one home for computations such as retrieval results. Neither fits: the record log is append-only truth about the repository's work, and the computation store is per repository and keeps reusable outputs permanently.

## Decision

Persistence gains a third kind: a **rebuildable user-level cache of third-party inputs and what is derived from them**.

| Store | Holds | Identity | Lifetime |
| --- | --- | --- | --- |
| **Stack store** | Package contents and upstream trees, each as a read-only folder and its own small bare git repository, and a search index per tree | Tree OID; entries by ecosystem, name, version and the lockfile's hash; upstream trees by host, path and commit | Evicted: least recently used past the cap (5 GiB by default), and first what no registered repository pinned or used for 30 days; never what an open review cycle holds, until the cycle has had no run for 7 days (10.79) |

- **Where it lives.** One store per user, outside every repository and outside `.git/neuve/`: `~/Library/Caches/Neuve/stack/` on macOS, `~/.cache/neuve/stack/` elsewhere, built from the home directory only. Each repository's pins (the entries each revision pins, each fetch's outcome, the head-only budget) stay beside its Records store in `.git/neuve/stack.json`.
- **Never Records data.** Records holds no stack bytes and no stack index. It references a stack source by tree OID and the index recipe, and a cited excerpt is kept with its context reference, as scope excerpts are (3.12), so a citation outlives an eviction. Captured tool results keep their bodies under the capture rules (10.8, 10.24).
- **Write once, delete to evict.** Each tree is its own repository: written once, never repacked, garbage-collected or checked with `fsck`. Package trees are built blob by blob (`git hash-object -w --no-filters`, `git mktree`), never by path. An upstream tree keeps its filtered pack with a promisor that cannot be reached and `GIT_NO_LAZY_FETCH=1`, so nothing it left out is ever fetched. Eviction deletes a tree's directory, folder and index; nothing else changes.
- **The index is a cache, not a computation.** One persisted BM25 index per tree, built in the background with the repository index's chunker and parameters and keyed by its recipe; a search sums the statistics of the distinct trees of a stack state. A new recipe rebuilds; nothing is migrated.
- **Untrusted inputs.** Nothing in the store is ever run. Everything enters through the fetch rules of SC7: URLs Neuve builds, HTTPS only, hashes that must match, extraction that refuses `.git` components, links and collisions, a scrubbed environment and no credentials.

## Consequences

- Losing the store loses nothing durable: the next fetch rebuilds what can still be fetched and discloses the rest as no longer available.
- `stack.fetch` and `stack.index` are background jobs in each repository's queue (0002); the store is shared, so their writes to it take a lock in the store.
- The harness reads the store through git objects at a stack state frozen per review cycle (11.15, a second read surface beside 10.34's); the store's read API is built for those tools.
