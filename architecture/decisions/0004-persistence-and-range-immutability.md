# 0004: Persistence and range immutability

Status: accepted, 16 October 2026; revised 28 October 2026 for the [pi execution boundary](0014-ace-style-pi-harness.md). Source: decisions [1.4, 2.7, 5.3–5.6, 5.8, Area 8, 11.10, 11.18, 11.22 and Area 12](../../process/decisions.md). The detailed Records design is in [the M2 proposal](../../process/proposals/m2-records.md).

## Context

The ledger grew to 13.7 GB. 2,571 full copies of the state made up 13.62 GB, against 25 MB of actual records. The stored state was the real truth and the records were derived from it. Each event was written about 16 times, run transcripts were copied into every snapshot, and a lease-renewal bug locked Records out after any 30-second stall. The ledger was archived and deleted on 16 October 2026.

## Decision

Persistence has two kinds, with filesystem and database abstractions under both. A third kind, the user-level cache of third-party stack sources, is outside Records and described in [0012](0012-stack-store.md).

| Store | Holds | Identity |
| --- | --- | --- |
| **Record log** | Append-only events: batches, units, context references, assessments, dispositions, comments, cycles, and agent identity and activity. Current state is a projection that can always be rebuilt from the log. | Event ID, with references to ranges, units and cycles |
| **Computation store** | Reusable stage outputs, embeddings, retrieval results, and large blobs including masked raw session captures. It does not schedule pi tasks or mirror their live execution state | A hash of the computation's inputs: range or blob, pipeline version and configuration |

- **Never recompute.** A commit range is immutable, so the same changes are always attributed the same way. Before any computation runs, it is looked up by its input hash. On a partial hit, the harness reuses everything cached and runs only what is missing; context assembly may still rerank over cached and new results together. Retries and reruns use the cache too.
- **Freshness is checked on every run.** What the range fixes is never recomputed, but some inputs can move while the range stays the same: git history (a rebase, amend or force-push takes a commit out of it, and owned files can change after a proof record's commit) and external sources such as a ticket, a document or a service's telemetry. Every rerun and later run checks proof currency against the head's history and each pinned external source against its provider. A record that is no longer current, or a source that changed or could not be checked, marks the checkpoints resting on it Out of date (11.18). Whether a source's change matters is judged in context, once per change: one that matters, or cannot be judged, is taken in and the computations that read it rerun as a partial miss; one that does not keeps the text the review stands on and is disclosed (11.22). Currency is decided when a record is read and never stored (11.10).
- **Records reference computations by hash** and never copy them. Each event is recorded once, not once per unit.
- **The prepared package is transient,** assembled from references for its review cycle. Each published package gets a small, durable, content-addressed manifest of hashes (8.7). Dispositions are recorded so they are never regenerated.
- **Retention.** Raw captures (transcripts, raw tool outputs, model bodies) are kept for at most 30 days. Outputs the pipeline reuses are kept permanently. Fetching a raw capture again counts as a new attempt and never replaces a stored output (8.10). Hunk text isn't kept: Git rebuilds it ([0015](0015-range-snapshot-and-git-reader.md), 12.45).
- **Where it lives.** SQLite in `.git/neuve/` (shared by every checkout of the repository), plus a user-level list of repositories (8.6), using `@effect/sql-sqlite-bun` (8.9). Records are lost with the clone until a condensed git-ref mirror of durable records is added, for sharing or as a backstop.

## Pi review execution and capture lifetime

Under [0014](0014-ace-style-pi-harness.md), pi keeps a review's resumable task, conversation, and tool state in its native SQLite database beneath that review's existing run folder. This is working execution state, not a competing record log or a second live transcript in Records. Records continues to retain reusable computation outputs and review facts.

Before an ended run folder is removed, the capture boundary exports the native pi state together with the request journal and captured artifacts into masked raw-capture blobs in Records. The harness owns pi's SQLite connection. After pi seals Session admission and joins its scheduler, capture copies and hashes the database on that connection, then pi closes storage. Removal verifies the stored capture and unchanged journal under source ownership and removes the database, sidecars, journal, and working files together without reopening the closed database. No pi writer can run between capture and close; a later claim appends to the journal before doing pi work, invalidating the receipt. This also applies to legacy receipts taken at the same close barrier. The ended-run sweep opens a dead process's surviving database as a writer and copies it on that connection before close. Direct exports of restored credential backups still require a certificate for the exact whole source when its WAL is absent. A clean close and a lost WAL look the same on disk, and a Records store has no capture to check against, so a reader of one with no WAL reads it as it stands without writing beside it and says so, or refuses if it must see every commit; only a writer's open accepts the file. The read-only module and the macOS behaviour test cover these read paths, and review covers new code. Existing run-folder cleanup and the 30-day raw-capture limit apply; retaining pi state outside that lifecycle would bypass pruning. Capture failure is explicit and cannot produce a complete dataset claim.

Evaluation exports are separate immutable artifacts under the dataset's stated retention policy. Exporting does not change the age or identity of a stored raw capture. The coding environment's operational conversation history follows its own session lifecycle; this record does not authorize deleting coding sessions or retaining review raw captures permanently.

## Consequences

- No time lease (8.2): exclusivity comes from the worker socket singleton ([0002](0002-event-driven-processes.md)). Errors are logged with their cause, not swallowed.
- Masked review session captures become raw blobs in the computation store. Live pi task state has one owner and remains in the run folder until capture and removal.
- Pruning is a supported operation that never breaks provenance; tombstones record what expired.
