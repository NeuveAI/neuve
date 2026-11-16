# 0013: Graph search as one shared service, with the harness as its client

Status: accepted, 23 October 2026. Source: decisions [10.91 to 10.94, 10.96, 10.97 and 10.108](../../process/decisions.md#area-10-harness-m3-18-october-2026), and the owner's answers of 23 October recorded in [section 7 of the shared Graph service research](../../research/07-shared-graph-service.md#7-the-owners-answers-23-october-2026). The research behind it is that memo and the [local search research](../../research/06-local-search-under-a-machine-budget.md). It works within the [event-driven process model](0002-event-driven-processes.md) and the accepted [machine-wide budget](../../process/proposals/machine-budget.md), and refines how [hybrid retrieval](0006-hybrid-retrieval-and-context-references.md) reaches Graph.

This record is the direction for Graph's search speed and concurrency. A later agent starts here rather than reopening the questions it settles; a change to it needs the owner.

## Context

A Graph search is a new engine process per call, against a prepared snapshot of the base commit. Each Neuve process lets one run at a time, so the worker's review and its commit-preparation child can each run one, and they keep separate clones and snapshot caches because preparing moves a clone's HEAD. Snapshots accumulate, one per prepared commit, with nothing evicted. In the end-to-end check Graph answered at a median of 11.3 s against 12 ms for the harness's keyword search, and made no measured difference to lead coverage. A review waiting on a background Graph search cannot speed it up: one process cannot lift another's priority, so the budget's priority inheritance stops at the process boundary.

Every local analysis service the research studied that stays responsive under mixed load does the same few things: one instance found by identity; small keyed tasks of work in one in-process queue, with priority on queued tasks rather than processes; one run per key shared by its waiters; expensive whole-tree work only for the few bases queries use; and a bounded cache that never evicts what a live caller holds. Keeping a process warm saves milliseconds; the gain is in deciding what Graph does next.

## Decision

### 1. One Graph instance per machine, and it schedules

| | The rule |
| --- | --- |
| **Identity** | One instance per user and Graph build. It is found at an address derived from both, in the private directory the budget socket uses (not `$TMPDIR`, which sandboxes vary), and allowed in agent sandboxes as the budget socket is (10.93) |
| **Start and exit** | Started on demand by the first caller, elected race-free as the budget host is (a claim taken before it binds). It exits only when no connection, task, waiter or pin is open, after an idle period set from measurement. There is still no always-on service ([0002](0002-event-driven-processes.md)) |
| **Versions** | A caller checks the instance's build and protocol on connecting and uses only an exact match. Otherwise, or when the instance cannot be reached, it runs today's per-search process and discloses it, as the budget's floor does |
| **Upgrades** | Never interrupt. An instance from an older build finishes the work its connected callers already gave it, then exits; new callers start or join the new build's instance |
| **Work** | Small keyed tasks: one search, one lead, one snapshot preparation. Each task has a class (interactive or background) and its caller's deadline |
| **Computed once** | One run per key, shared by every caller that asks for it, at the highest class among its waiters, cancelled only when no caller still wants it. This is 10.94 applied inside the one process that runs Graph, as [record 0016's shared work](0016-shared-work.md) describes; Records' claims stay for the harness's own computations, such as a hunk's stored leads |
| **Kept answers** | Live in the instance's memory. An exact-commit read whose callers all left runs to the end and keeps its answer for the next identical request (bounded at 64 MiB, for 30 minutes); a read that depends on where HEAD is is cancelled instead and never kept. Kept answers are lost when the instance exits after its idle period, so commit preparation waits for its background-class searches and records their answers in its own store; submitting without waiting comes only once kept answers outlive the instance |
| **Priority** | Lives in the instance's queue, never in the operating system's process priority. A caller that needs a queued task moves it up; nothing already running is interrupted or reniced (the owner's answer). Smaller tasks make that leftover wait shorter |
| **Concurrency** | Reads of a prepared snapshot run in parallel. Preparing a snapshot is its own lane and never blocks reads of another. Searches at one base tree that arrive together are answered in one pass over that tree, and each blob's answer to a pattern is remembered (10.108) |
| **CPU** | The instance is one client of the machine-wide budget (10.93): it takes grants for the work it runs, so its parallelism stays within the machine's share |

### 2. What is prepared ahead of time, and for which commits

- **Per blob, for every commit:** facts that depend only on a file's content (its symbols and, with the planned text index, its index piece), keyed by blob, engine version and recipe. A rebase creates few new blobs, so this is cheap.
- **Per base, for few commits:** whole snapshots only for the bases reviews start from, which are the upstream branch's head and each active branch's merge base with it, plus the parent of a prepared commit for as long as commit-time leads are searched there. Other commits read the nearest prepared base with a layer for their changed files.
- **Bursts collapse to the newest:** per branch, one preparation running and one waiting, the newest replacing the waiting one. Preparation is declared (which bases and lead queries each branch wants) and reconciled against what is stored, not driven event by event.
- **Commit preparation submits its lead searches as background tasks** to the instance, so a review that asks for the same lead joins the task and moves it up, instead of waiting on an opaque child process.

### 3. The disk stays bounded

The instance owns one cache of snapshots and indexes. A running review pins the snapshot it reads over its connection, so the pin ends when the review does. Lasting roots (queued reviews, active branches' merge bases) are declared from Records. Eviction keeps a size cap and a free-space floor, removes unpinned and undeclared entries first and then the least recently used, records last use in a database rather than file access times, runs while idle, and never runs when the budget host cannot be reached. The engine's version is in the directory names, so an old build's entries go once nothing pins them. The cap is set against the number of indexed trees, since a text index is several times the text it indexes.

### 4. The harness is a client and never waits on Graph without a bound

Every caller (a review's lead searches, agents' `graph_search`, commit preparation) reaches Graph only through `@neuve/graph-client`, the one validated boundary. A request names the store, the base tree, the query, the class, the deadline and the caller.

- **Stored answers first.** A review reads a hunk's stored lead before it asks Graph.
- **A bounded wait, then a disclosed fallback.** Past its bound, a review's missing Graph lead becomes the keyword search's leads for that hunk, marked as a fallback with its reason, and an agent's `graph_search` answers that Graph is still working on it and points to the keyword and identifier tools. Neither cuts the search off: it finishes and stores its answer, so the next ask finds it ready.
- **Graph enriches; it does not set a review's pace.** The bound is set low enough that it never does, and tuned from the fallback rate and Graph's timings, not guessed.
- **A review's leads are one round.** Every missing hunk's Graph search starts at once and the review waits for them once, within the same bound, so a range with many hunks waits no longer than one with few.
- **A range keeps the leads it had.** The range's overview is computed once and reused, so a resumed review sees the same leads (0004); Graph leads that arrive after it serve the next range whose hunks they match.

### 5. What is measured (10.97)

Each through Effect spans, span events or metrics into the run log:

- the fallback rate, by caller (lead or agent search) and reason (bound passed, Graph unavailable, Graph failed);
- each lead and agent search's outcome: found ready, joined while running, computed within the bound, or fell back;
- Graph's own phases and reads on each search span, the CPU of the engine and its `git` children, the waits for the base and the slot, and the time any search was waiting or running (busy time);
- once the instance exists, its queue wait, the moves up, the batch sizes and its cache's hits and evictions.

A measure is stored whenever its work ends, exactly once: a Graph search, or a lead search, that ends within its review's attempt is in the attempt's records (and their OTLP copy); one that ends after writes records of its own to that review's run log as it ends. The slowest searches, which the wait is tuned from, are never the ones missing.

## Built, and still to build

| Part | Today (23 October 2026) | Target |
| --- | --- | --- |
| Graph's timings, CPU, waits and busy time on each search; lookups timed with their route | Built ([graph-search.ts](../../packages/harness/src/graph-search.ts), [graph-client](../../packages/graph-client/src/domain.ts)) | Plus the instance's queue measures |
| Agents' identifier lookups from the harness's per-blob index, `git grep` as fallback | Built ([lookups.ts](../../packages/harness/src/lookups.ts)) | As built |
| Lead searches at commit time, reviews reading stored answers, ready against computed counted | Built for BM25 and Graph ([commit-prepare.ts](../../packages/harness/src/commit-prepare.ts)) | Submitted as background tasks to the instance |
| The bounded wait and disclosed fallback, with the fallback rate | Built in the harness: one wait setting, the review's Graph wait; searches shared within a process and kept after their callers stop waiting ([graph-search.ts](../../packages/harness/src/graph-search.ts), [manifest.ts](../../packages/harness/src/manifest.ts)). The worker does not idle out while a search runs, so one a review stopped waiting for finishes and keeps its answer; a crash or a stop still ends it, and the next ask searches again. With the shared service on, a search's engine call ends at its waiting callers' deadline instead, and the service carries the search on and keeps the answer for the next identical ask | Searches kept by the instance, whatever process asked |
| Priority in the queue | Built in the instance's queue on the Graph side, and used: graph-client passes each engine call's class and deadline while the service setting is on, a search a review waits on asking as interactive with the waiting callers' remaining wait, background work (commit preparation, a search its callers left) as background with none; a call past its deadline (exit 75) is a disclosed fallback while the service carries on and keeps the answer (`harness.graph.service.deadline`, `harness.graph.queue.*` on the search span). Within one process as well: Graph's one slot serves first the searches a caller is still waiting on, then the rest, each in arrival order; a search's deadline counts only its own run, so a queued one is never cut off | The instance's queue, across every caller |
| One instance per machine, keyed tasks, one run per key, priority in the queue, batching per base | Started on the Graph side: a shared Graph service that each engine command reaches when it runs (`ENTIRE_GRAPH_SERVICE`, `auto` from graph-client) and that reports a `service` block per search (answered or why not, memory, snapshots, its CPU, queue wait), recorded on each search span, its CPU taken as the search's when it answered. graph-client runs each engine build from one hashed, read-only copy (by its resolved path) under the store's one Graph cache, `<git common directory>/neuve/graph/cache`, which is also graph-client's default, and gives the engine one fixed environment in every Neuve process, so the worker, commit preparation and `neuve query` reach the same service. Commit preparation keeps its own clone (`graph-commit`, since preparing moves a clone's HEAD) but shares the cache. Built since on the Graph side: the bounded store with declared bases, pins and eviction; a private per-user socket folder with a build check on connect; a sweep of gone services' files; and the queue (class and deadline per call, moving up, exit 75 when a caller's deadline passes while the search runs on, at most 32 searches outliving their callers, kept answers served only while every input they came from is unchanged). Next: parallel reads, the preparation lane and batching per base, then grants. Each Neuve process still runs one engine command at a time; a call that ends at its deadline frees that slot at once | Section 1 |
| Snapshots for the declared bases only, bursts collapsed | Not built: one snapshot per prepared commit | Section 2 |
| A bounded cache with pins | Built on the Graph side: one bounded store per cache folder (a 4 GiB cap, a 10 GiB free-space floor), evicting least recently used first and never a declared base, a read in progress or the running engine copy. The worker declares the bases from Records on its loop ([graph-declare.ts](../../packages/harness/src/graph-declare.ts)): each waiting or running review's merge base, each active branch's merge base (a local branch with a commit in the last 14 days, against the default branch; the default branch against its upstream) and the first parent of each commit preparation pending or ended in the last day, one the repository still has. The store's size, cap and evictions are on each search span as its base's preparation measured them (`harness.graph.store.*`), and in the worker's log line for each declaration (the worker keeps no spans) | Section 3 |

### Where a search's time goes (24 October 2026)

After the day's Graph changes, the long run over the 71 dev hunks gives identical answers on every hunk, and its query time fell from 814 s to 693 s, the median from 4.1 s to 3.4 s. A round of eight large searches fell from 125 s to 78 s. The changes:
- the file route answered in one pass with remembered answers;
- ranking's allocation cut;
- shared caches for file contents and signature digests;
- symbol names scored once for all terms;
- the git metadata safety walk done once per read and re-verified before each git command.

A median search, at 3.7 s profiled, now spends its time in roughly even shares, so Graph's speed work is paused:
- about 0.75 s outside the service: client start, forwarding, JSON;
- about 1.0 s waiting on git;
- about 1.0 s of ranking CPU;
- about 0.6 s reading the prepared generation.

The next Graph load to measure is commit-time hybrid lead rounds (10.117–10.119).

## Consequences

- The per-process one-engine slot (10.77) and commit preparation's separate clone go when the instance lands; the instance's queue and the budget's grants replace them.
- The budget's limit on priority inheritance, that a running background child keeps its class, no longer applies to Graph: a review moves Graph's queued tasks up inside the one process that runs them.
- Graph's answers stay byte-identical whichever caller asked, in whichever order; a change to which matches are returned still needs the owner (10.90).
- Graph keeps its place as enrichment (10.108): a review is never worse for Graph being slow, only for Graph being absent, and that is disclosed.

## Open points

- Full-profile preparation has no incremental path: each new commit is prepared from scratch: about 34 s on the Neuve repository on 24 October, about 22.5 s after the relation-phase work of 25 October, with identical snapshots ([research 08](../../research/08-graph-full-preparation.md)). Parsing is about 5%; per-file and global relation passes are most of the rest. Reusing a file's relations exactly needs per-pass dependency tracking, the open item in ADR 0006 and 0007; research 08 records what each pass reads, as groundwork. For now, the harness prepares each commit right after its commit-time job, so the next commit finds its parent ready.
- How long the instance stays alive when idle: measured, not chosen yet.
- Whether the instance's cache stays beside each repository's store or becomes user-level, as the [stack store](0012-stack-store.md) is.
- How often leads are found ready: unknown until the ready-against-computed count has run on real reviews (the owner's answer).
- Whether bases other than a commit's parent are prepared at commit time depends on how commit-time leads are keyed for multi-commit ranges.
