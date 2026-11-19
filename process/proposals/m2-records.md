# M2 "Records rebuilt": design proposal

Historical proposal. Its review-stage graph and budgets are superseded by the [fixed-shape pipeline record](../../architecture/decisions/0005-harness-pipeline.md), which describes the NEU-111 trial. The [owner's decisions](../decisions.md) remain authoritative for accepted product meaning and the other topics below.

Status: accepted on 17 October 2026 with [rulings 8.1–8.17](../decisions.md#area-8-records-rebuild-m2-17-october-2026), which change some recommendations below. Its lasting content now lives in the decisions record and in architecture records [0001 (layers)](../../architecture/decisions/0001-layers-and-responsibilities.md), [0002 (processes and job queue)](../../architecture/decisions/0002-event-driven-processes.md), [0004 (persistence)](../../architecture/decisions/0004-persistence-and-range-immutability.md), [0009 (identity)](../../architecture/decisions/0009-identity-without-auth.md) and [0011 (zod schemas)](../../architecture/decisions/0011-zod-schemas.md); where they differ, they win. This file is the design record behind them, written by the M2 design lead and fact-checked the same day. Each section separates **Facts** (checked in code or docs, cited as file:line at the time), **Options** and a **Recommendation**. "Unverified" marks an assumption I could not check. Numbers such as 5.5 refer to the [design decisions](../decisions.md). Section 12 lists every decision.

Product words follow the [vocabulary](../../vocabulary.md). "Event", "projection", "computation", "blob", "job", "spool", "tombstone" and "turn key" are internal implementation words, not product concepts.

## Starting point (facts)

| Finding | Evidence |
| --- | --- |
| A full copy of the state is stored on every change (2,571 copies, 13.62 GB, against 25 MB of records, per [0004](../../architecture/decisions/0004-persistence-and-range-immutability.md)) | `saveCheckpointWithRecords` appends the whole checkpoint payload to `review_checkpoint_history` whenever its digest changes (`packages/verification-ledger/src/history.ts:19414-19440` at `91273d11`) |
| Each event is written about 16 times | The backend derives records from in-memory state, one per unit, each with the full payload: an assigned publication writes the whole `units` array once per unit (`apps/neuve-web/packages/backend/src/history.ts:449-463` at `91273d11`); agent-binding events repeat per bound unit (463-541) |
| Transcripts live inside the state | An ACP update's `detail` holds up to 512,000 characters (`apps/neuve-web/packages/backend/src/review-run.ts:168-183` at `91273d11`), kept in the checkpoint's `reviewRunUpdates` (`apps/neuve-web/packages/backend/src/checkpoint.ts:196` at `91273d11`) |
| Records does model I/O and the ACP relay | Records depends on `@workspace/ai`, `@workspace/editor` and `@workspace/backend` (`apps/neuve-records/package.json` at `91273d11`); `review-launcher.ts:42` imports `runAssignedReview`, `review-finalization.ts:5-8` imports `generateManagedReviewText`, `relay.ts:15-20` imports `openAcpSession`; the 5.6k-line store runs inside Records (`apps/neuve-records/src/runtime.ts:45` at `91273d11`) |
| Three schema and SQL layers | zod 4 in the ledger; Effect Schema in the backend domain (343 `Schema.` uses in `apps/neuve-web/packages/backend/src/domain.ts` at `91273d11`); drizzle in `apps/neuve-web/packages/storage/src/tables.ts` at `91273d11` |
| Pruning is impossible by construction | `records_content_blobs` has a no-delete trigger (`packages/verification-ledger/src/history.ts:983` at `91273d11`) |
| One always-on HTTP server | Records listens on 127.0.0.1:4319 (`apps/neuve-records/src/main.ts:21-39` at `91273d11`); the BFF proxies to it (`apps/neuve-web/apps/web/src/server/review.ts:144` at `91273d11`, `apps/neuve-web/apps/web/src/server/records-feed.ts:76` at `91273d11`) |
| EVE depends on all of it | `@workspace/ai` depends on `records-client`, `verification-ledger`, `backend`, `storage` and `editor` (`apps/neuve-web/packages/ai/package.json` at `91273d11`) and reaches the CLI's MCP server over SSE at `http://127.0.0.1:4318/sse` (`apps/neuve-web/packages/ai/agent/connections/neuve.ts:5` at `91273d11`) |
| Size | `apps/neuve-records/src`: 44 files, 20.6k lines. `packages/verification-ledger/src`: 29 files, 28.7k lines. `apps/neuve-web/packages/backend/src`: 21.0k lines |
| Data | The ledger was archived and deleted on 16 October (5.10, 6.7). Records starts empty: no data migration |

Worth keeping as ideas: append-only triggers (`packages/verification-ledger/src/history.ts:958` at `91273d11`), idempotency keys checked against a content fingerprint (`review_record_keys`, history.ts:935), and two rules enforced at append: only a human records a human-required approval, and only a disposition's author retracts it (`packages/verification-ledger/src/history.ts:6318-6330` at `91273d11`).

## Conflicts that need an owner ruling

| # | Existing decision, record or rule | What this proposal recommends | Section |
| --- | --- | --- | --- |
| C1 | `AGENTS.md`: never add agent attribution trailers to commits in this repository or the graph submodule | A `Neuve-Session` trailer in user repositories, opt-in, never in this repository | 6 |
| C2 | [0004](../../architecture/decisions/0004-persistence-and-range-immutability.md) and 5.5: fix the lease so it stays valid while owner and fence are unchanged | Remove time leases altogether | 5 |
| C3 | [0001](../../architecture/decisions/0001-layers-and-responsibilities.md), [0002](../../architecture/decisions/0002-event-driven-processes.md) and the README flow "CLI → Records": Records as a layer with its own process boundary; 1.7: an event-driven web app | Records as a library inside the CLI, MCP, worker and BFF processes, with migrations and projectors running there and the BFF polling a sequence number | 1 |
| C4 | Plan: MCP moves to stdio in M3 | Add a stdio MCP server in M2, keep SSE until M3 | 8 |
| C5 | Plan: EVE and its patch leave in M3; "Start a review" is fixed in M5 | Deleting the old packages in M2 also removes EVE, "Start a review" and the old review commands now | 10 |
| C6 | 5.6: git refs or a `.neuve` folder | A third place, `.git/neuve/`; durable records die with the clone until a mirror exists | 4 |
| C7 | 5.5: the prepared package is transient | A small durable manifest of hashes per published package | 2 |
| C8 | 2.15: at most one vent per turn | When no turn is known, one vent per 5-minute window | 8 |
| C9 | No decision on SQL libraries yet | Remove drizzle; use `@effect/sql-sqlite-bun` | 9 |
| C10 | 5.4 never recompute versus 5.8 prune session data after 30 days | Computation outputs the pipeline reuses are durable; raw captures may be recomputed after pruning | 3, 7 |

## 1. Layering

**Decision needed.** What Records owns, what process it runs in, its API, and where today's model I/O and ACP relay go.

**Facts.** 0001: Records stores and coordinates, never calls a model, runs retrieval or orchestrates agents, and imports no harness, AI, editor or backend package; "a layer can restart without killing work in another". 0002: no always-on service; hooks capture quickly; a worker runs on demand. 5.1 moves model calls, the ACP relay and finalization out of Records.

**Options for the process boundary.**

| | A. Library over one SQLite file | B. Small on-demand Records process | C. Long-lived HTTP server (today) |
| --- | --- | --- | --- |
| Shape | CLI, MCP, worker and BFF each link the Records package and open one SQLite file in WAL mode | One process per repository owns the file. It starts on demand (spawned by the first caller, singleton as in section 5), serves the others over a Unix socket and exits when idle. It can be the worker process itself | Records always runs on a port |
| Writer | SQLite's lock serializes short transactions | One writer by construction | One writer, guarded by today's lease |
| Migrations and projectors | Run in every process that writes; a version gate (below) stops old writers | Run in one place | Run in one place |
| Web events (1.7) | The BFF polls the log's sequence number (cheap) and pushes events to the browser | Records pushes change events to subscribers over the socket | Records pushes a feed (today) |
| Capture path | A spool file written by the hook (section 5), so hooks never open SQLite | Spool, or a socket call that may pay a cold start | One HTTP call |
| Readers while Records is down | Always available | Read-only file access, or start Records | Unavailable |
| Fit with 0001, 0002 | Revises the topology (C3); keeps "no always-on service" | Keeps the "CLI → Records" flow and the layer boundary; keeps "no always-on service" | Rejected by 0002 |

**Recommendation: A** (an owner ruling under C3). The layer boundary becomes the package API and the file, with no lifecycle to manage and nothing held in memory. B is a sound alternative: it keeps migrations, projectors and change notification in one process and matches 0001's wording; it costs a socket protocol, a start-up path for every caller and a second lifecycle. Under A:

- **Version gate.** The database stores its schema version and the minimum writer version. An older writer refuses to write and says so; only `neuve records migrate` or the worker at start migrates.
- **Blocking.** `bun:sqlite` waits for a busy lock synchronously, blocking that process's JavaScript thread. Transactions stay short (no I/O inside), and the BFF and MCP server write rarely (human commands, vents).
- **File shares.** SQLite's WAL mode needs shared memory and does not work across network or VM file shares, and Unix sockets do not cross them either (unverified for each container runtime). A process inside a container working on a host checkout must not open the database or start a worker; it writes to the spool only, and the host's worker or launchd sweep ingests it. **Open point:** how a process knows it is in a container. Candidates are a `NEUVE_SPOOL_ONLY` setting written by `neuve setup` into container configuration, and checks such as `/.dockerenv` or a database path on a different device than the git directory; none is reliable alone. This repository is not one of the workspace's configured devcontainer projects, but users' setups may be.

**API surface** (Effect services, zod types): `Log.append(events)` (idempotent; the only way to enqueue a job), `Log.read(filter)`, `Log.get(id)`, `Log.since(seq)`; `Spool.write(event)` for hooks; `Projections.*` (cycles, batches, units and owned ranges, dispositions, comments, actors, sessions) and `Projections.rebuild()`; `Computations.lookup`, `start`, `succeed`, `fail`; `Blobs.put`, `get`; `Jobs.claim`, `finish`, `inspect`; `Actors.resolve`; `Admin.fsck`, `prune`, `stats`.

**Where today's Records work goes.**

| Today in `apps/neuve-records/src` | Goes to |
| --- | --- |
| `relay.ts` (ACP turns for review threads) | Records appends the thread message; the worker performs the ACP send (M3 keeps the ACP path runnable, 2.12). See the live-session problem below |
| `review-launcher.ts`, `assigned-review-calls.ts`, `review-finalization*.ts`, `review-generation.ts` (2.5k lines of model calls) | The harness in M3 |
| `semantic-*` (16 files, 6.9k lines) | Graph-client calls from worker jobs (M4); Records keeps only their computation entries |
| `git-preparation.ts`, `source-preparation.ts`, `git-lineage-acquisition.ts` | Worker jobs triggered by commit events |
| `review-framing.ts`, `planning-source.ts` | Deleted ("frame" is not a product concept, 1.9); scope gathering belongs to the harness (2.1) |

**Live ACP sessions and an exiting worker.** A Codex session through `codex-acp` is a subprocess of whoever opened it. A worker that exits after 60 s idle would kill it, while a review thread expects the agent to keep its context between a person's comments. Options: A, the worker counts open ACP sessions as work and stays alive while any is open, closing a session after a long idle period (for example 30 minutes) and recording that; B, each thread turn is a job that opens a session, sends, waits and closes, losing the agent's context unless ACP session loading restores it (unverified for codex-acp); C, a separate connection process that owns ACP sessions. **Recommendation: A.**

## 2. Record log

**Decision needed.** The event envelope, append-only rules, how current state is projected and rebuilt (5.5), and how a multi-unit event is stored once.

| Field | Content | Notes |
| --- | --- | --- |
| `id` | ULID minted by the producer | Time-sortable; the leaf format Entire uses for refs, so a later git export is mechanical |
| `seq` | Integer assigned at append | The order inside one store; not part of identity |
| `kind` | Closed union with a version, for example `disposition.recorded@1` | Old versions are upcast on read, never rewritten |
| `idempotencyKey` | From natural keys, for example `git:commit:<oid>` or `claude-code:<session>:turn:<n>:stop` | Same key and content returns the existing event; same key with different content is a conflict |
| `actor` | `actorId` (fingerprint, section 6) | The alias is projected from the actor registry, never copied |
| `attribution` | `range` (base ref, base OID, head OID; 1.4, 4.12), `batchId`, `cycleId`, `unitIds[]`, `runId`, `stage`, `sessionId`, `turnKey` | Each optional; a cycle can be bound later, as [foundation 02](../../foundations/02-review-modes-and-cycles.md#cycle-attribution-and-the-prepared-package) requires |
| `causation` | `causedBy`, `correlationId` (command, run or turn), `supersedes` (corrections, retractions) | Corrections are new linked events, never edits |
| `occurredAt`, `recordedAt` | Producer's time and writer's time | Diagnostic ([foundation 03](../../foundations/03-unit-history-and-metrics.md)); `seq` orders |
| `payload` | Kind-specific, at most 64 KB (proposed) | Anything larger is a blob or computation referenced by hash |
| `refs` | `computation:<key>` or `blob:<hash>` with a role | Records reference computations and never copy them (5.3) |

**Append-only rules.** Triggers forbid `UPDATE` and `DELETE` on events. An event never embeds another event or a copy of state. Workflow rules (a human records a human-required approval; the author retracts; an agent never approves human-required work, [0009](../../architecture/decisions/0009-identity-without-auth.md)) are checked in the append transaction.

**Each event once.** One row in `events`, plus index rows in `event_units(event_id, unit_id)` and `event_cycles`. Sixteen units cost sixteen small index rows, not sixteen payloads.

**Options for projections.** A: projector tables updated in the append transaction (immediate, indexed reads, `rebuild` replays by `seq`). B: fold events on each read (nothing to rebuild; cost grows with the log). C: an asynchronous projector with a cursor (indexed reads; readers may see stale state). **Recommendation: A.** Projectors are pure functions of state and event that never read a clock, so rebuilds are deterministic. A version constant triggers a rebuild when it changes. `neuve records rebuild --verify` prints a checksum of every projection table before and after, which is how the owner sees projections rebuild from the log. **`seq` is not causal across capture paths:** spooled events get their `seq` when the worker ingests them, while interactive commands append at once, so a later `seq` can hold an earlier event. The worker ingests spool files in ULID order, and projectors must rely on `causation` links and attribution, never on `seq` order, wherever order matters (for example a retraction arriving before what it retracts is held until its target exists). Under option B of section 1, projectors run only in the Records process.

**The prepared package (C7).** 5.5 says the prepared snapshot can be transient. Options: A, a `package.published` event referencing a small content-addressed manifest (hashes of batches, units, context references, digests and dispositions), kept durably so later dispositions in a fresh context (4.7) can name their exact basis; B, no manifest: each disposition records the unit, cycle and computation keys it read, and the package is reassembled from records when needed; C, the manifest of A, pruned when its cycle ends. **Recommendation: A**, because it is written once per publish and holds only references. The owner should confirm that this reading of "transient" is acceptable.

## 3. Computation store

**Decision needed.** The input hash, blobs versus metadata, reuse and partial hits (5.4), attempts and retries, integrity.

**Key.** `key = sha256(canonical JSON {op, opVersion, inputs, config, route})`. Canonical JSON follows RFC 8785: object keys sorted by UTF-16 code units, ECMAScript number formatting, no whitespace. The ledger's `canonical` helper (`packages/verification-ledger/src/history.ts:370-378` at `91273d11`) sorts with `localeCompare`, which depends on locale, so it must not be reused for keys.

| Input | Included as | Why |
| --- | --- | --- |
| Range | Base, head and merge-base OIDs; never branch names | The range is the fingerprint (1.4); branch names move |
| File content | Git blob OID | Content identity |
| Upstream computation | Its key | Keys chain, so partial hits fall out naturally |
| Operation | `op` and `opVersion`, for example `retrieve.semantic@3` | A change to one stage invalidates only that stage |
| Configuration | Effective config: limits, top-k, prompt template ID and hash | Different settings are different work |
| Model route | Provider, model ID, reasoning setting | Opus and Sol outputs differ |
| Scope sources | Content hash of each source snapshot | An edited ticket yields new keys |

Excluded: timestamps, run IDs, actors, cycle IDs (reuse across cycles is the point) and absolute paths. **Versioning options:** A, one global pipeline version; B, a version per operation. **Recommendation: B**, plus a global epoch reserved for emergencies.

**Storage.** `computations(key, op, state, output_hash, created_at)`; `blobs(hash, size, media_type, retention_class, captured_at, pruned_at)` keyed by sha256 of content. Blobs up to 128 KB live in SQLite; larger ones in a filesystem store (`blobs/sha256/ab/cdef…`, temporary file, fsync, rename). The threshold follows SQLite's guidance that small blobs read faster from the database (unverified for our workload; S5 measures it).

**Partial hits.** Lookup is per computation, never per run. Rerunning a known range with one new scope source: per-hunk semantic retrieval hits; the new source's query is computed; the rerank over all candidates is computed over cached and new results (5.4); unit digests whose inputs changed are computed and the rest hit.

**Attempts.** `attempts(attempt_id, key, n, started_at, ended_at, outcome, error_class, cause_blob, usage, model)`. Only a successful attempt binds the output, permanently. Failed and cancelled attempts stay, because their tokens count toward cost (2.5). The retry policy belongs to the harness (2.6). Concurrent requests for one key inside the single worker share one in-flight attempt.

**Never recompute versus pruning (C10).** If an output is pruned at 30 days, a later lookup lands on a tombstone. Options: A, treat a tombstone as a miss and recompute, recording why (breaks 5.4's letter); B, treat it as a hit with no content (keeps 5.4, but the caller gets nothing usable); C, classify by use: every output bound to a computation key (retrieval results, assessments, digests, dispositions, embeddings, manifests) is durable. Raw captures (transcripts, raw tool output, raw model bodies) are never bound outputs; they are blobs attached to an attempt (its `cause_blob` or capture references) and are session data. A raw tool result needed after pruning is therefore fetched again as a new attempt, with the reason recorded, and no bound output is ever replaced, which keeps D12. **Recommendation: C.**

**Integrity.** The store computes every hash itself. File blobs are re-hashed when read. `neuve records fsck` checks that every reference resolves to a blob or tombstone, that every successful computation has its output, that projections equal a rebuild, and runs SQLite's `integrity_check`.

## 4. Storage medium

**Decision needed.** SQLite only, git refs, or a hybrid (5.6), using only the parts of Entire that fit Neuve (5.7).

**Facts about Entire** (ref backend (`docs/architecture/ref-checkpoint-backend.md` in `entireio/cli`), sessions and checkpoints (`docs/architecture/sessions-and-checkpoints.md` in `entireio/cli`)): live session work is held locally (session state in `.git/entire-sessions/`, shadow branches) and is **condensed** into a checkpoint when a commit happens. Each checkpoint is one ref, `refs/entire/checkpoints/<shard>/<ULID>` (shard = last two characters), pointing at a commit whose tree is the checkpoint (`metadata.json`, per-session `full.jsonl`, `tasks/`); later writes add parented commits. User commits carry an `Entire-Checkpoint` trailer. Pushes are fast-forward only, from a flock-protected queue file in the git common directory at pre-push; reads fetch missing refs on demand. Only a git-backed store can be primary, because Entire's lifecycle runs through refs. Transcripts are redacted best-effort because they get pushed; compact transcripts are skipped above a 50 MB cap.

**The exercise: Neuve records as git objects, condensed like Entire.** Hot capture stays local (spool and SQLite). The worker condenses at natural boundaries (turn end, commit, disposition, package publish) into refs:

```
refs/neuve/cycles/<shard>/<cycle-ulid>      -> one commit per condensation (parent = previous)
    cycle.json                                 range, base, opened-at
    events/<ulid[0:2]>/<ulid>.json             each event once, added at condensation
refs/neuve/actors                           -> actors/<fingerprint>.json
refs/neuve/computations/<shard>/<key>       -> key.json, attempts.json, output  (durable outputs only)
session transcripts                            never in refs (5.8)
```

| Concern | Per-event commits | Condensed commits |
| --- | --- | --- |
| Write cost | Blobs, trees, a commit and a ref update per event, through `git` spawns or a git library | The same per condensation: tens per day for one developer rather than thousands (unverified volume) |
| Repository hygiene | Loose objects pile up; `git gc --auto` runs past 6,700 by default, inside the user's commands | Modest |
| Concurrency | `git update-ref <ref> <new> <old>` compare-and-swap; appenders to one cycle retry | The worker is the only condenser |
| Atomicity | Jobs, spool and projections are local operational state, so refs need not join a transaction; a crash before condensation leaves the local copy to condense later | Same |
| Querying | None; SQLite is a required index, rebuilt by walking refs | Same |
| Sharing | Records travel with the repository using git credentials alone (6.6), with an explicit `refs/neuve/*` refspec and a pre-push queue | Same |
| Retention | Session data never enters refs; durable records are never pruned, so refs need no history rewrite | Same |
| Size | GitHub rejects files over 100 MB and warns over 50 MB; very many refs slow `ls-remote` and fetch negotiation (unverified thresholds) | Fewer objects; same ref count |

**Options.**

| | A. SQLite only | B. Git refs as durable truth, condensed; SQLite as hot store and index | C. SQLite primary; git-ref mirror later |
| --- | --- | --- | --- |
| Capture and queries | Fast; SQL | Fast; SQL over a cache rebuilt from refs | Fast; SQL |
| Survives deleting the clone | No | Only once pushed | No, until the mirror exists and is pushed |
| Team or multi-machine sharing | No | Yes | When the mirror is built |
| Moving parts | One store | Two representations, condensation, reconciliation, refspec and push queue | One store now; the mirror later |

**Recommendation: C, with only the SQLite half in M2.** B is a fair design and is Entire's shape; its costs are the second representation and its reconciliation, before anyone needs sharing. The envelope serializes each event to one ULID-named JSON file, so the C mirror (durable records only) is the B condensation run one way. Build it when records must follow the repository to other machines or teammates, or when losing them with a clone becomes unacceptable. Git stays the backbone either way: commit OIDs identify ranges and content (1.4), commits link to sessions (section 6) and history is read directly.

**Location (C6).** Today's ledger lives in the gitignored `<repo>/neuve/` folder (`packages/verification-ledger/src/ledger.ts:144-146`).

| | Git common directory `.git/neuve/` | In-repository `.neuve/` | User directory `~/Library/Application Support/Neuve/<repo-id>/` |
| --- | --- | --- | --- |
| Worktrees | Shared (Entire keeps session state there) | One per worktree | Shared, through a repository-identity map |
| `git status` | Never shows it | Needs an ignore rule | Never shows it |
| Deleting the clone | Deletes durable records | Deletes durable records | Keeps them |

**Recommendation: `.git/neuve/`** (`records.sqlite`, `blobs/`, `spool/`, `workflow.sqlite`, `worker.sock`), plus a small user-level registry of enabled repositories for the launchd sweep. **Risk:** until a mirror exists, deleting or re-cloning the repository loses its durable records. `neuve records export` (a tar of the directory) is the M2 backstop.

**From Entire, Neuve takes:** hooks that call the CLI with no daemon; the agent's own session ID; state in the git common directory; process-ancestry matching; ULIDs; condensation and fast-forward-only pushes if a mirror is built. **It does not take:** shadow branches with worktree snapshots (Neuve reviews commits; it does not rewind code), transcripts in git, or agent-versus-human line percentages (not a requested metric).

## 5. Event queue and worker

**Decision needed.** The durable job queue, the worker lifecycle and launchd backstop (6.9, 0002), how `effect/workflow` fits (0003), single-writer rules, and capture that never silently loses events.

**Facts: the lease bug.** `renewAuthority` (`packages/verification-ledger/src/history.ts:2326-2340` at `91273d11`) calls `assertAuthority` (2353-2373), which throws when `lease_until <= now` though owner and fence still match. Renewal runs every 10 s (`apps/neuve-records/src/main.ts:75-79` at `91273d11`) on the event loop that also runs synchronous `bun:sqlite` work. A stall of 30 s or more fails the next renewal; the failure escapes `Effect.forever` and stops Records with exit code 1 (main.ts:82-98), and the 67 `assertAuthority` calls fail meanwhile. After a crash, `acquireAuthority` refuses for up to 30 s (history.ts:2313-2314).

**Facts: Effect 4.0.0** (installed `node_modules/effect/dist`). `SingleRunner` always provides SQL message storage; `runnerStorage: "memory"` swaps only runner storage (`cluster/SingleRunner.js:36-56`). SQL runner shard locks expire after 35 s and refresh every 10 s (`cluster/ShardingConfig.js:52-53`); the same runner address reclaims its locks at once (`cluster/SqlRunnerStorage.js:407-423`, the SQLite branch), so a stall does not lock it out. Two engines on one `workflow.sqlite` with the same address would both believe they own every shard. `persistence/PersistedQueue.js` has a SQL store: `INSERT OR IGNORE` by element ID (893), retries delayed through `visible_at` (933), a default retry schedule of exponential backoff from 1 s capped at 5 minutes (79), and a 2-minute lock refreshed every 30 s (843-844), after which an item is redelivered. The spike found activities at-least-once, `Activity.retry` without a backoff schedule, and non-durable activity timeouts ([0003](../../architecture/decisions/0003-effect-native-harness-runtime.md)).

**Options for the queue.**

| | A. Records' own `jobs` table | B. `PersistedQueue.layerStoreSql` |
| --- | --- | --- |
| Enqueue with the triggering event | In the same transaction | Unverified whether it can share the append transaction (it uses its own SQL client calls) |
| Dedupe | Unique `dedupe_key` (the computation key) | By element ID |
| Backoff | `not_before` column, written by us | Built in (`visible_at`, default schedule) |
| After a stall | Nothing expires (single worker, below) | Redelivered after 2 minutes; with one worker, the same job may run twice in one process |
| Code to own | Small table and claim logic | None; a library contract |

**Recommendation: A**, because event and job commit together and nothing is time-based. B is close; choose it if S1 shows it can join the append transaction. Pipeline runs (M3) call `Workflow.execute` with the job ID as idempotency key, and every activity looks up its computation key first, so at-least-once replays are cache hits.

**Options for worker exclusivity.** Replaced by [ruling 8.2](../decisions.md#area-8-records-rebuild-m2-17-october-2026): no time lease anywhere, one worker per repository held by an OS socket claimed under SQLite's write lock (option B). The options are kept as the record of the choice.

| | A. Fix the lease (0004's wording) | B. Socket singleton serialized by SQLite | C. OS advisory lock |
| --- | --- | --- | --- |
| How | Renewal succeeds whenever owner and fence match, even after expiry, unless another owner took over | A starter takes SQLite's write lock (`BEGIN IMMEDIATE`), tries to connect to `worker.sock`; if live it exits, otherwise it unlinks, binds, records PID and start time, and commits. Starters are serialized, so two cannot both unlink and run | `flock` or `fcntl` on `worker.lock`; the kernel releases it when the process dies. Bun exposes neither (unverified); needs `bun:ffi` to libc |
| After a stall | A takeover after expiry is still possible, so two owners can briefly coexist | Resumes; nothing expired | Resumes |
| After a crash | Blocked until expiry | Next start succeeds | Next start succeeds |

**Recommendation: B**, with C if FFI is acceptable. With one worker per repository, any job found `running` at worker start was orphaned and is requeued. Two invariants follow: **only the worker runs `Workflow.execute`** (other processes enqueue jobs), and **only the worker condenses or migrates** in the background. macOS limits socket paths to 104 bytes, so deep repositories use a hashed path under the user's temporary directory. A hung worker shows in `neuve worker status` (last progress) and is stopped by `neuve worker stop`; per-job budgets are enforced inside the worker.

**Capture without silent loss.** Hooks are fail-soft: they must exit 0 so the agent is never blocked. Writing SQLite from a hook can drop events on a busy timeout or a too-old-writer refusal. Options: A, hooks append directly and log failures; B, hooks write each event to a **spool** (`.git/neuve/spool/<ulid>.json`, written to a temporary file then renamed) and the worker ingests it, with idempotency keys making ingestion repeatable (Entire similarly keeps session state as files in the git common directory); C, B with a direct append attempted first. **Recommendation: B** for git and agent hooks; interactive commands (`vent`, dispositions, CLI) append directly and report errors. The spool also serves processes that cannot open the database (file shares, section 1). Hooked events reach Records only when the worker ingests the spool; the hook starts the worker at once, so the delay is normally a worker start.

**Lifecycle.** **Every process that writes the spool or enqueues a job runs the starter**: hooks, the CLI, the MCP server and the BFF, not only hooks and launchd. The starter spawns `neuve worker --repo <dir>` detached; a second worker exits at once. **No lost wake-up at idle exit:** a starter could connect just as the worker finishes its last scan and exits, leaving the event until the next hook or sweep (never, in dev). So an idle worker takes SQLite's write lock, unlinks its socket, commits, and then scans the spool and the job table once more; if it finds work, it re-runs the starter protocol instead of exiting. A starter that arrives after the unlink finds no live socket and starts a new worker. The launchd agent `dev.neuve.worker` (release install) runs `neuve worker --sweep` every 5 minutes and at login, starting workers for registered repositories with spooled or queued work and the daily retention job. A worker exits after 60 s with no jobs and no open ACP session (section 1). After a crash, orphaned jobs are requeued and the workflow engine resumes in-flight runs by itself.

**Workflow engine storage.** A separate `workflow.sqlite`, so engine tables and migrations never touch records. Runner storage can be `"memory"` (message storage stays SQL and durable), given the singleton invariant.

## 6. Agent identity

**Decision needed.** Fingerprint sources, aliases, commit linkage and capture hooks. No auth (6.6): identity is for attribution, and actor kind still enforces lane rules ([0009](../../architecture/decisions/0009-identity-without-auth.md)).

**Facts from Entire's hook payloads.** Claude Code hooks carry `session_id` and `transcript_path`; `SessionStart` may carry `model`; subagents appear through `PostToolUse` on the `Agent` tool (`tool_response.agentId`) and `SubagentStop` (entire-cli `agent/claudecode/types.go:39-68`). Codex hooks carry `session_id`, `turn_id`, `transcript_path` and `model`, and `agent_id` for subagents (`agent/codex/types.go:44-129`).

**Fingerprint options.** A: harness + session ID (one actor per agent session; the model recorded per turn). B: harness + model (a persona shared by sessions; implementer and reviewer become indistinguishable). C: harness + session + model (a mid-session model change splits the actor). **Recommendation: A.** `fingerprint = sha256("neuve-actor/1", harness, sessionId[, subagentId])`; subagents are child actors. Neuve's harness agents use `harness = neuve` with the run ID and role. Humans are identified by git `user.email`. A session's role (implementer or reviewer) is declared by the Neuve skill as an event scoped to the cycle.

**Alias options.** A: a word pair with a digit added on collision; the digit depends on which agent was seen first, so two machines can disagree. B: a hash code that lengthens on collision, like short git hashes (`cc-3f9a`); always a prefix of the fingerprint, so unambiguous everywhere, but not memorable. C: three words chosen from the fingerprint out of a 2,048-word list (about 33 bits), deterministic on every machine. Every session and subagent is an actor, so collisions matter: at 33 bits, 10,000 actors in one repository give about a 0.6% chance of at least one collision and 100,000 about 44%. **Recommendation: C with a collision rule:** if an alias is already held by a different fingerprint, the newcomer's alias gains a fourth word from the next fingerprint bits (and a fifth if needed). The first holder keeps its alias, and the full fingerprint always disambiguates. Shown with harness and model, for example "amber-heron-quill · Claude Code · Opus 5.5". Humans keep their git name.

**Linking a `neuve` call to its session.** A: process ancestry, as Entire does: `SessionStart` records the agent's PID and start time, and later calls walk their own ancestry to it. Bun has only `process.ppid`, so a walk costs one `ps -A -o pid,ppid,lstart,comm` snapshot (one spawn, tens of ms, unverified) or `bun:ffi` calls to libproc. Agent sandboxes (Claude Code's or Codex's) may deny process listing (unverified). An MCP stdio server is the agent's child, so its match needs only `ppid`. B: an environment variable from the harness (unverified whether either exports the session ID). C: an explicit `--session` flag the skill passes. **Recommendation: A, with C as the override and the fallback when ancestry is denied.**

**Commit linkage (C1).** `post-commit` records `commit.recorded` (OID, parents, tree, author, matched session); `post-rewrite` records the old-to-new mapping after an amend or rebase. Options for a breadcrumb in history:

| | A. Trailer, opt-in, user repositories only | B. No trailer | C. Git note |
| --- | --- | --- | --- |
| How | `prepare-commit-msg` adds `Neuve-Session: <fingerprint>` to agent commits when the user opted in at `neuve setup`; never in this repository or its submodules | Links live only in Records, kept current by `post-rewrite` | `refs/notes/neuve` per commit |
| Survives push, rebase, cherry-pick | Yes | Only locally, while `post-rewrite` runs | Push needs a notes refspec; rebases need `notes.rewriteRef` |
| `AGENTS.md` rule | Respected by never enabling it here | Respected | Respected (outside the message), but still agent attribution; the owner should say whether the rule covers notes |

**Recommendation: A**, Entire's breadcrumb (1.5), with B as the behaviour in this repository and by default. The [Entire research](../../research/03-entire-and-code-context.md) cautions that a trailer can be removed and shows association, not authorship.

**Capture hooks** (installed by `neuve setup hooks`; fail-soft; each writes to the spool):

| Hook | Event | Job |
| --- | --- | --- |
| Claude Code and Codex `SessionStart` | `session.started` (harness, session, model, transcript path, owning process); actor upsert | — |
| `UserPromptSubmit` | `turn.started` (Codex `turn_id`; minted for Claude Code) | — |
| `PostToolUse` on subagent tools, `SubagentStop` | `subagent.started` or `subagent.finished` | — |
| `Stop` | `turn.ended` with transcript path and byte offset | `transcript.capture` |
| `SessionEnd` | `session.ended` | Final `transcript.capture` |
| git `post-commit`, `post-rewrite` | `commit.recorded`, `commit.rewritten` | Graph and embedding preparation (M4) |

Prompt text never enters durable events; it lives in the transcript (session data). `transcript.capture` copies the transcript delta into the blob store and records `turn.summarized` (model, input, output and cache tokens, tool calls, duration), so cost figures survive pruning.

## 7. Retention

**Decision needed.** What the 30-day rule (5.8) prunes, and how pruning keeps provenance.

| Durable | Session data, pruned 30 days after capture |
| --- | --- |
| Events, actors, projections, commit links, computation keys and attempts, every computation output the pipeline reuses (C10), package manifests, turn summaries | Raw Claude Code, Codex and harness transcripts; raw tool outputs; ACP streams; raw model request and response bodies |

The producer sets each blob's class. A daily job deletes session blob bytes older than 30 days, keeps a tombstone (hash, size, media type, class, capture and prune dates) and appends one `retention.pruned` event per run with counts and cutoff. References to pruned blobs resolve to "pruned on <date>"; event chains, hashes and keys stay intact. The database uses incremental auto-vacuum so space returns.

**Options for the clock.** A, from capture; B, from the end of the cycle that used the data. "At most 30 days" excludes B. **Recommendation: A**, with no exemptions: anything needed longer must exist as a durable summary first.

## 8. Vent records

**Decision needed.** Shape, commands, the one-per-turn limit (2.15) and how inner-loop agents reach it.

**Shape.** `vent.recorded@1` with `{ text }` (1 to 2,000 characters, proposed) and the envelope's attribution: actor, session, turn key, and run, stage, cycle or units when known. No categories now; triage comes later (2.15). Vents never enter review context.

**Commands.** CLI: `neuve vent "<text>"`; `neuve vents [--since 7d] [--agent <alias>] [--run <id>] [--json]`. MCP: a `vent` tool with one `text` parameter. M3's harness tool calls the same library function.

**One per turn.** A unique index on `(actor_id, turn_key)`, filled in the append transaction, holds under races. Harness agents use the workflow's turn number; inner-loop agents use the turn opened by their latest `turn.started`. A second vent in a turn gets an ordinary success reply ("One vent per turn; your earlier vent is kept"), never an error, so there is nothing to retry. Because spooled events may not yet be ingested, `vent` reads the session's spool for the latest turn too.

**When no turn is known (C8).** Without hooks there are no turn boundaries. Options: A, refuse and ask for hooks (keeps 2.15 exactly); B, one vent per actor per 5-minute window, recorded as `turnKey: window:<start>`; C, one per MCP server process. **Recommendation: B**, disclosed in the record; it replaces 2.15's rule in that case.

**MCP transport (C4).** The CLI's MCP server speaks SSE over HTTP (`apps/neuve-cli/src/mcp.ts` at `91273d11`), and EVE connects to it at port 4318 until M3. Options: A, replace SSE with stdio in M2 (breaks EVE); B, add a stdio transport in M2 and keep SSE until M3 removes EVE; C, wait for M3 (inner-loop agents cannot vent through MCP in M2, only through the CLI). **Recommendation: B.**

## 9. Schema

**Decision needed.** Zod as the single library (5.9, [0011](../../architecture/decisions/0011-zod-schemas.md)), where schemas live, how Effect consumes them, and the SQL library (C9).

**Where.** A new `packages/records-schema` with zod 4 as its only dependency: envelope, event kinds, actor, computation key, job, blob and command inputs, imported by every layer.

**Facts.** Effect 4.0.0 converts its own schemas to Standard Schema (`toStandardSchemaV1`, `effect/dist/Schema.d.ts:1046`) but has no converter from it. It offers `Schema.declare(is, annotations)` (Schema.d.ts:399), whose declaration annotations include `representation` and `toCodecJson` for JSON derivation (Schema.d.ts:11473-11492); the `toJsonSchema` hook at Schema.d.ts:11561 belongs to check and filter annotations. `effect/ai` tools take Effect Schema parameters and derive JSON Schema from them (spike `q1-jsonschema-probe.ts`).

**Options.** A: parse with zod at each boundary inside an Effect, mapped to a tagged error; types from `z.infer`. B: a `fromZod` adapter on `Schema.declare` carrying the JSON Schema from `z.toJSONSchema`, for `effect/ai` tool parameters and structured output; whether `Tool.getJsonSchema` uses a declaration's annotations is unverified. C: Effect Schema allowed only for model-facing tool parameters, with a test proving each matches its zod schema. **Recommendation: A everywhere, B for `effect/ai` if S1 proves it, otherwise C.** Errors use Effect's `Data.TaggedError`, which is not a schema.

**SQL library (C9, a new decision).** A: `@effect/sql-sqlite-bun`, which the workflow engine needs anyway (spike). B: raw `bun:sqlite` (today's ledger). C: drizzle (today's storage package). **Recommendation: A**, and drizzle leaves with the storage package.

## 10. Migration and removal

No data migration is needed.

**What the deletion takes with it (C5).** `@workspace/ai` (EVE) depends on every package below, so deleting them in M2 removes EVE, the web "Start a review" path and live review, and these CLI commands: `ledger`, `history`, `frame`, `review-context`, `review-generation`, `semantic-invocation`, `semantic-observe` and the review-context MCP tools. 1.1 already reports "Start a review" broken. The plan's M2 dogfooding is agent activity with aliases; review dogfooding needs the M3 harness (7.6: "once Records can take a review"). The committed `AGENTS.md` no longer prescribes `neuve ledger history`; its workspace table still names `apps/neuve-records`.

| Option | Effect |
| --- | --- |
| A. Delete in M2 (S2) | Clean base for M3; EVE, "Start a review" and the old review commands are absent until M3 and M5 |
| B. Keep the old stack running until M3 lands, then delete | Nothing regresses early; two record systems and the old dev services coexist through M2, and `check` keeps covering about 70k lines due for deletion |
| C. Rewire EVE and the web app to the new Records | Keeps them working, but the work is discarded when EVE leaves in M3 |

**Recommendation: A**, an owner ruling because it brings forward part of M3 and M5's scope.

| Code | Disposition |
| --- | --- |
| `packages/verification-ledger` (29 files, 28.7k lines) | Delete; keep the ideas under Starting point |
| `apps/neuve-records` (44 files, 20.6k lines), including `verify-*.ts` (3 files, 2.4k lines) | Delete; the verify scripts test the old lease, authority and preparation, so there is nothing to convert |
| `apps/neuve-web/packages/ai` (EVE) and its connection to the SSE MCP server | Delete under option A (EVE leaves in M3 anyway) |
| Backend: `store.ts`, `checkpoint.ts`, `history.ts`, `review-run.ts`, `legacy-records.ts`, `snapshot.ts`, `service.ts`, `verify.ts` and `verify-*.ts` (16.2k lines) | Delete |
| Backend product rules: `decision-ranges.ts`, `responsibility-scope.ts`, `submitted-hunks.ts`, `comment-anchor.ts`, `lineage.ts`, `review-lane.ts` (1.0k lines) | Keep; port to zod and plain TypeScript where the rule still holds |
| Backend remainder: `domain.ts` (737), `evidence.ts` (973), `submission.ts` (514), `review-context.ts` (449), `unit-review-context.ts` (232), `static-review*.ts` (396), `agent-thread.ts` (203), `published-*.ts` (156), `errors.ts`, `index.ts`, `submission-schema.ts` (156); 3.8k lines | Assess per file in S2: delete what only serves the old store; move surviving product types into `records-schema` as zod |
| `apps/neuve-web/packages/storage` (drizzle) and `packages/records-client` | Delete |
| CLI files on the old Records: `ledger*.ts`, `history-cli.ts`, `records-connection.ts`, `evidence-upload.ts`, `review-framing*.ts`, `review-generation-cli.ts`, `review-context-cli.ts`, `semantic-invocation-cli.ts`, `semantic-observe-cli.ts` | Delete |
| CLI files that import ledger types but stay: `mcp.ts`, `boundary.ts`, `setup.ts`, `graph-query.ts`, `source-preparation.ts` | Rewire to `records-schema` or local types; `neuve query` keeps working |
| 24 web files importing the deleted packages (22 under `apps/web/src/server`, plus `components/start-review-operation.ts` and `components/records-feed.ts`) | Replace proxies and feeds with library reads; delete "Start a review" wiring until M5 |
| `scripts/dev.ts` Records and EVE services | Removed; the worker starts on demand |

Documents describing the old contract need rewriting by their owners: `apps/neuve-cli/HISTORY.md` at `91273d11`, `apps/neuve-cli/LEDGER.md` at `91273d11`, and the workspace table in `AGENTS.md`.

## 11. Milestone slices

Each slice runs as one implementer and one independent reviewer. The new packages are `@neuve/records-schema` and `@neuve/records-core`, because `apps/neuve-records` already uses the name `@neuve/records`.

| # | Slice | The owner can judge | Depends on |
| --- | --- | --- | --- |
| S1 | **Schema and core.** `records-schema`; `records-core` with events, idempotency, the unit index, projector tables, rebuild, fsck, stats, the version gate, the spool format and the jobs table (enqueue in append); `neuve records` with `history`, `get`, `rebuild`, `fsck`, `stats`. Checks: hook start latency, the zod adapter for `effect/ai`, whether `PersistedQueue` can join the append transaction | A terminal recording: a scripted cycle appended, `rebuild --verify` with identical checksums, `stats` with bytes per event and no state copies | — |
| S2 | **Removal and cut-over** (if C5 is ruled A). Delete and rewire per section 10; BFF reads the library; if EVE goes here, the SSE MCP transport can go with it (D29) | The deletion diff (about 70k lines), a green `check`, `bun run dev` starting only the web app, and the web app showing empty states with no errors, plus a list of what no longer exists | S1 |
| S3 | **Capture and identity.** `neuve setup hooks` for git, Claude Code and Codex; spool writes; a manual `neuve records ingest` that ingests the spool in ULID order (the worker reuses it in S4); actors and aliases; ancestry matching; commit records; turn events; `neuve agents` | Dogfooding: this repository's lane sessions listed with aliases, turns and commits, after `neuve records ingest` until S4 automates it | S2 (shares CLI files) |
| S4 | **Worker.** Spool ingestion, `neuve worker` with the singleton, launchd agent and sweep, `neuve worker status` and `stop`, `neuve jobs` | Logs of SIGKILL mid-job then restart; SIGSTOP for 60 s then continue with no lockout; two simultaneous starts with exactly one winner | S1; runs beside S3 |
| S5 | **Computations, blobs, transcripts.** Keys, attempts, inline and file blobs, `transcript.capture`, `turn.summarized` | `neuve records stats` after a day of dogfooding: transcripts as referenced blobs, token totals per agent, database size | S3, S4 |
| S6 | **Retention and vent.** Pruner with tombstones; `neuve vent`, `neuve vents`; the stdio MCP server with `vent` | `neuve records prune --dry-run` output; lane agents' vents in `neuve vents` with the one-per-turn limit visible | S5 |

Milestone exit (plan): after a week of dogfooding, `stats` shows the database growing with the number of events and no table holding state copies; `rebuild --verify` matches; `neuve agents` lists this repository's agents with aliases.

## 12. Decision list for the owner

Items marked **Conflict** revise an existing decision, record or rule (see the conflicts table).

| # | Decision | Recommendation | Section |
| --- | --- | --- | --- |
| D1 | **Conflict C3.** Records process model | A library over one SQLite file in each process; alternative: a small on-demand Records process | 1 |
| D2 | Version skew between installed CLI and dev checkout | Schema and minimum-writer versions in the database; older writers refuse; explicit migrate | 1 |
| D3 | Where moved work lands, and live ACP sessions | Worker jobs for ACP sends and pipeline runs; the worker stays alive while ACP sessions are open | 1 |
| D4 | Event identity | Producer-minted ULID plus an idempotency key checked against content | 2 |
| D5 | Envelope | As tabled, 64 KB payload cap, hash references beyond | 2 |
| D6 | Multi-unit events | One event row plus unit and cycle index rows | 2 |
| D7 | Projections | Same-transaction projector tables, deterministic, versioned, `rebuild --verify` | 2 |
| D8 | **Conflict C7.** The prepared package | A durable content-addressed manifest per publish; confirm this reading of "transient" | 2 |
| D9 | Computation key | RFC 8785 canonical JSON of OIDs, upstream keys, operation and version, config, model route, scope-source hashes | 3 |
| D10 | Versioning | Per operation, plus a global emergency epoch | 3 |
| D11 | Blob placement | Inline up to 128 KB, filesystem above, verified on read | 3 |
| D12 | Attempts | All recorded with usage; only success binds an output, permanently | 3 |
| D13 | **Conflict C10.** Never recompute versus pruning | Reused outputs are durable; only raw captures are session data and may be fetched again | 3, 7 |
| D14 | Storage medium | SQLite primary now; a condensed git-ref mirror of durable records when sharing or clone-loss matters | 4 |
| D15 | **Conflict C6.** Location | `.git/neuve/` plus a user-level repository registry; accept that records die with the clone until the mirror | 4 |
| D16 | Job queue | Own `jobs` table in the append transaction; `PersistedQueue` if S1 shows it joins the transaction | 5 |
| D17 | **Conflict C2.** Exclusivity | No time lease: a socket singleton serialized through SQLite's write lock (or `flock` via FFI); only the worker runs workflows | 5 |
| D18 | Capture path | Hooks write a spool the worker ingests; interactive commands append directly. Hooked events reach Records only at ingestion, and `seq` is not causal across the two paths | 5 |
| D19 | Worker lifecycle | Started by every enqueuer (hooks, CLI, MCP, BFF) per repository; unlink-then-rescan at idle exit; exits after 60 s with no jobs and no ACP session; launchd sweep every 5 minutes and at login | 5 |
| D20 | Workflow engine storage | Separate `workflow.sqlite`, memory runner storage, SQL message storage | 5 |
| D21 | Fingerprint | Harness plus session ID (plus subagent ID); model per turn; humans by git email | 6 |
| D22 | Alias | Three words from the fingerprint (2,048-word list), the same on every machine; a fourth word for a later fingerprint that collides | 6 |
| D23 | Linking calls to sessions | Process ancestry from one `ps` snapshot; `--session` override and fallback | 6 |
| D24 | **Conflict C1.** Commit breadcrumb | Opt-in `Neuve-Session` trailer in user repositories only, never here; otherwise `post-commit` and `post-rewrite` records | 6 |
| D25 | Prompts and transcripts | Never in durable events; captured as session blobs; token summaries kept | 6, 7 |
| D26 | Retention clock | 30 days from capture, no exemptions, tombstones | 7 |
| D27 | Vent shape and limit | Text up to 2,000 characters; unique per actor and turn; success-shaped reply to a second vent | 8 |
| D28 | **Conflict C8.** Vent without known turns | One per actor per 5-minute window, disclosed | 8 |
| D29 | **Conflict C4.** MCP transport | Add stdio in M2; keep SSE until EVE leaves | 8 |
| D30 | Schema home and consumption | `records-schema` in zod 4; parse at boundaries; `fromZod` for `effect/ai` if proven, else the narrow exception | 9 |
| D31 | **Conflict C9.** SQL library | `@effect/sql-sqlite-bun`; remove drizzle | 9 |
| D32 | **Conflict C5.** Removal timing | Delete the old stack, including EVE, in S2; "Start a review" and old review commands return with M3 and M5 | 10 |
| D33 | Slice order | S1 core (with the jobs table), S2 removal, then S3 capture beside S4 worker, S5 computations, S6 retention and vent | 11 |
