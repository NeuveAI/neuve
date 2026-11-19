# Ingestion and repository setup

Status: user-established, updated 2026-10-16 to match the owner's [design decisions](../process/decisions.md). Numbers such as 6.9 refer to entries there. Ingestion is Git-led and event-driven. Source selection, historical depth, and freshness of external sources remain open.

## Ongoing ingestion

Git leads ingestion, following entire-cli's approach as a reference rather than a model to copy (1.5, 3.9). Review units are directly connected to the commits they concern. The [event-driven process record](../architecture/decisions/0002-event-driven-processes.md) describes the mechanism:

| Step | What happens |
| --- | --- |
| Capture | Git hooks and agent hooks call the CLI. It records the event, the agent's fingerprint and the commit, then returns quickly (6.9) |
| Queue | Records turns events into durable background jobs, such as embedding a new blob or updating the graph (5.2) |
| Work | A worker starts when jobs are queued and exits when idle. The release install registers a macOS launchd agent, so queued work is picked up even without a hook firing (6.9). There is no always-on service |
| Precompute | Work attached to agent activity and commits, such as embeddings, runs in the background rather than cold at review time (2.10) |

The index follows commits incrementally, and hash metadata resolves ranges (3.9). Each commit extends the [durable committed graph](../vocabulary.md) rather than replacing it with the repository's latest tree. Commit and blob identities keep the historical and review attribution available to later queries. Hooks never wait for long jobs.

A Git event alone does not establish a review cycle; the [cycle boundary](02-review-modes-and-cycles.md#cycle-boundary-and-corrections) still applies. Indexing a commit records what exists, not that it was approved.

Planning decisions, scope sources and documents that occur naturally in the repository, such as the vocabulary and other records, are ingested as context (7.4). They must be available for the [inner loop's scope drilldown](02-review-modes-and-cycles.md#planning-and-scope-precede-the-development-loop). Git history, documentation, and ticket information are the main source pillars established in the [escalation foundation](06-escalation-and-decomposition.md).

Broad ingestion and selective retrieval are separate concerns: collecting a source does not make all of its contents relevant to every review unit.

Context drawn from other changed work in the range under review is shown as same-batch context, as the vocabulary's "Transient context" entry defines. The boundary is relative to the selected range: work inside it is under review, and work outside it is context carrying its own review status (4.12).

## Initial pre-population

Installing Neuve in a new repository includes an initial ingestion pass. The user chooses whether it runs in the foreground or background. It ingests the existing commit history and current committed state so the committed graph is queryable before later Git events extend it.

Users can begin working while background pre-population is still running. Neuve must clearly flag that processing is incomplete. Incomplete processing must not be presented as evidence that no relevant history or context exists.

## Open product questions

- Which existing material is included initially, and how far back should historical ingestion extend?
- How do users actively add or refresh material, especially information outside the repository?
- How are changes, deletions, and superseded planning decisions reflected in later retrieval?

The Records rebuild's scope schedules the event queue, on-demand worker and launchd backstop as part of rebuilding Records.
