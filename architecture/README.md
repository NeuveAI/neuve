# Architecture

This folder describes the system that follows from the owner's [design decisions](../process/decisions.md), recorded on 16 October 2026. The [foundations](../foundations/) define what the product means, and the [vocabulary](../vocabulary.md) defines its terms. This folder covers how the system is built: its layers, how they communicate, where data lives, and why. Each file in [`decisions/`](decisions/) records one architectural decision and links back to the owner decisions it comes from.

These records describe the target architecture. Much of the current code does not match it yet. The correction milestones close that gap.

## Layers

Neuve has six base layers. Each owns its own internal abstractions and talks to the others only through the boundaries listed here. See [0001](decisions/0001-layers-and-responsibilities.md).

| Layer | Owns | Does not own |
| --- | --- | --- |
| **Harness** | The final-review pipeline, from scope gathering to dispositions: hybrid retrieval, refinement and reranking, deterministic checks, matching units to context, digests, the lane matrix, pre-generated dispositions and review-delivery content. It runs as a client of the system of records. | Durable state, identity, and the UI |
| **System of records** | A library that every process links, over one SQLite file in `.git/neuve/` (8.3, 8.6). The append-only record of what happened: batches, units, context references, assessments, dispositions, comments, cycles, and agent identity and activity. It also holds the content-addressed computation store and the event queue that drives background work. | Model calls, retrieval logic, and agent orchestration |
| **Graph** | The semantic layer: indexing code and local docs and keeping their embeddings, with the provenance metadata needed for citation and refinement. It is updated incrementally as commits land, and served by one shared instance per machine ([0013](decisions/0013-graph-search-service.md)). | Being the only structural analyser. Structural and static analysis are separate, explicit operations ([0006](decisions/0006-hybrid-retrieval-and-context-references.md)). |
| **CLI** | The agent-facing interface for inner-loop and outer agentic reviewers: recording work, evidence and identity, and drilling into review data. It also handles install, hooks and the local-development command. | Business rules that belong to Records or the harness |
| **MCP** | Exposing Neuve's tools to coding agents over stdio, for the lifetime of the agent's session | Long-lived ports or shared daemons |
| **Web app** | An event-driven interface for humans: the batch overview and review desk, projected from Records, with commands relayed back to it | Business logic. The BFF only projects and relays. |

ACP connects Neuve to external coding harnesses such as Codex and Claude Code when they are available. It is a connection, not a layer, and final review never depends on it.

## How work flows

| Step | What happens | Where |
| --- | --- | --- |
| 1. Capture | Git hooks and agent hooks call the CLI. It writes the event, the agent's fingerprint and the commit to a spool, then returns. The worker ingests the spool. | CLI → spool → Records |
| 2. Queue | Records turns events into background jobs: embeddings for new blobs, graph updates, and pipeline runs for review requests. | Records |
| 3. Work | A worker starts when jobs are queued and exits when idle. A launchd agent from the release install makes sure queued work is picked up. | Worker (harness and graph) |
| 4. Reuse | Every computation is looked up by its input hash before it runs. Ranges are immutable, so finished work is never redone. A partial hit reuses what exists and reranks the rest. | Computation store |
| 5. Review | The harness writes the batch package. The web app shows it to humans, and the CLI shows it to agents. Dispositions are appended as records. | Records → web app and CLI |
| 6. Cycle | When every needed disposition is in, the cycle ends. Comments, including those on approvals, become context for the next cycle. | Records |

See [0002](decisions/0002-event-driven-processes.md) for the process model and [0004](decisions/0004-persistence-and-range-immutability.md) for storage.

## Decision index

| # | Decision |
| --- | --- |
| [0001](decisions/0001-layers-and-responsibilities.md) | Six layers with their own abstractions. Records stores and coordinates; the harness computes. |
| [0002](decisions/0002-event-driven-processes.md) | Event-driven. Hooks capture quickly, jobs queue, and a worker runs on demand with a launchd backstop. No always-on service. |
| [0003](decisions/0003-effect-native-harness-runtime.md) | The incumbent Effect runtime and its validation. Superseded for agent execution by 0014. |
| [0004](decisions/0004-persistence-and-range-immutability.md) | An append-only record log plus a content-addressed computation store. Ranges are immutable, nothing is recomputed, and full session data is kept for 30 days. |
| [0005](decisions/0005-harness-pipeline.md)                        | The fixed review-shape trial: Frame, Map, four finders, Verify, code fill, Link and Publish, with bounded work and full range coverage.                                                       |
| [0006](decisions/0006-hybrid-retrieval-and-context-references.md) | The semantic layer, then procedural enrichment, then agentic refinement, with one context-reference contract feeding the context margin. |
| [0007](decisions/0007-batches-units-lanes-and-cycles.md)          | The established batch and lane policy, with the fixed-shape trial's proximity units, unassessed coverage and defect-only dispositions.                                                        |
| [0008](decisions/0008-model-routes-and-budgets.md) | Anthropic API and ChatGPT subscription routes freeze accounts and budgets while preserving legacy keys. Run configurations admit the Claude subscription route. |
| [0009](decisions/0009-identity-without-auth.md) | No auth. Agents are identified by fingerprint and alias, and git credentials are enough. |
| [0010](decisions/0010-release-and-distribution.md) | A binary distribution installed on the PATH. Tests never touch the installed binary, and end-to-end runs test the release. |
| [0011](decisions/0011-zod-schemas.md) | Zod is the one schema library, and Effect consumes it. |
| [0012](decisions/0012-stack-store.md) | A third kind of persistence: a user-level stack store of third-party sources and their indexes, outside Records, rebuildable and evicted. |
| [0013](decisions/0013-graph-search-service.md) | Graph search runs in one shared instance per machine that schedules keyed units, prepares few bases and bounds its cache; the harness is its client and never waits on Graph without a bound. |
| [0014](decisions/0014-ace-style-pi-harness.md)                    | Ace-style tasks within Effect and Bun, with pi conversations and isolated Claude Code loops behind the runtime contract. Claude stages are enabled.                                         |
| [0015](decisions/0015-range-snapshot-and-git-reader.md) | A review reads a range snapshot that the Git reader makes; hunk text comes from Git rather than durable records. Accepted as the reference; not built. |
| [0016](decisions/0016-shared-work.md) | Work more than one caller can ask for runs once per idempotency key, and every other caller subscribes to its response. The only design for it; not built across processes. |
| [0017](decisions/0017-runtime-contract-and-accounts.md) | Named accounts and isolated runtime loops, with shared tools and stage policy. Claude stages are enabled; account removal and file-watch gaps stay explicit. |

## Keeping these records true

When an owner decision changes, update the matching record in the same change and delete superseded text, which git keeps. A record describes the target until the code reaches it. Code that disagrees with a record is either a defect or a sign that the record needs the owner's revision; it never silently redefines the architecture.
