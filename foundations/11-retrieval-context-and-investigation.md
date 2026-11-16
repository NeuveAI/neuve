# Retrieval context and investigation

Status: updated 2026-10-16 to match the owner's [design decisions](../process/decisions.md) 3.3 and 3.6–3.11, and the [hybrid retrieval record](../architecture/decisions/0006-hybrid-retrieval-and-context-references.md). Numbers such as 3.6 refer to entries in the decisions. Ranking and stopping algorithms, and the investigation summaries below, remain proposals.

The [product vocabulary](../vocabulary.md#retrieval-and-investigation) owns the meanings. The [graph foundation](09-structural-engine.md) owns what the graph is responsible for. The [product purpose](01-product-purpose.md#measurement-commitments) requires quality and total input and output token cost to be measured together.

## Layers of retrieval

Retrieval is internal harness preparation for matched review units, their surrounding context and the digests (2.1). It runs in three layers (3.6):

| Layer | What it does | Sources |
| --- | --- | --- |
| 1. Semantic | Indexes code and local docs and returns meaningful leads, each with provenance metadata | The graph and embeddings |
| 2. Procedural collection | Enriches and reranks the leads | Scope sources when available, prior Records reviews and comments, Git history |
| 3. Agentic | Refines, reranks and prunes context down to what matters for this review and for future generations | Agent reasoning with retrieval, structural, history and source tools |

Semantic retrieval can return many leads for selective refinement; the harness need not expand every lead. Structural questions use separate, explicit operations; semantic metadata alone does not establish structural completeness (3.1, 3.2). Neuve does not infer investigation intent from English-language heuristics on the question; the caller states what to investigate, which keeps retrieval language-neutral.

Code, docs and other sources start as separate indexes, queried individually, then merged and reranked (3.8). Signal-to-noise decides whether a combined index is ever worth it.

## Build order and measurement

| Pass | Order | Purpose |
| --- | --- | --- |
| Pass 1 | Semantic, then scope sources, then agentic | Build and measure first |
| Pass 2 | Semantic, then scope sources, prior Records, Git history and static analysis, then agentic | Measure how much the extra context actually helps, against pass 1 |

Benchmark before building more of the semantic layer (3.3): compare the fine-tuned EmbeddingGemma 2 against its baseline and other options, then consolidate one strategy.

## Investigation inside the harness

The [harness pipeline record](../architecture/decisions/0005-harness-pipeline.md) sets these rules:

- **Multi-turn, not one-shot** (2.4). Understand and Investigate are multi-turn agent steps with tools. Results enter context as handles plus excerpts and are kept in a structured evidence ledger. The server, not the model, resolves quotes and offsets.
- **Resilience over gates** (2.5). The pipeline always produces the batch from whatever context it retrieved. Missing scope, exhausted turns or a failed step become disclosed gaps, never a dead end.
- **Budgets in tokens.** Each stage budget is derived from the model route's context window ([model routes](../architecture/decisions/0008-model-routes-and-budgets.md)). Turn limits apply to Understand and Investigate. Whether they cover both steps together, and whether they scale with batch size, is open.
- **Never recompute** (5.4). Each computation is looked up by its input hash. On a partial hit, the harness reuses what exists and runs only what is missing; context assembly may still rerank over cached and new results together.

Preserve available context, contradictions, omissions, failed attempts and unresolved needs. Neither a fixed lead count nor exhaustion proves the context is complete. Retrieval and refinement iterations do not count as review cycles.

The graph's query byte budget, the vocabulary's "query context budget", is a limit on a provider response. It is not a model budget and does not measure how much the graph knows.

## Context-reference contract

One contract, specified for every layer (semantic store, Records, package, CLI and web backend), supplies everything the context margin shows (3.10). The margin's four layers, checked against Storybook on 16 October (3.11):

| Layer | What the reader sees |
| --- | --- |
| L0 pin | Kind icon and label, count, and dots for other units that cite it |
| L1 peek | One row per marker on the line: kind, one-line reason, source and revision |
| L2 card | Kind header, title, a body specific to the kind (for example a graph path with hop depth), "Before you decide" with one sentence and one action, and Open source |
| L3 source sheet | Kind, committed or same-batch, revision, title, the full source with coverage, and the units citing it |

Every reference also carries attribution: its batch and cycle, retriever, query, rank and score, provenance, and stance. The [hybrid retrieval record](../architecture/decisions/0006-hybrid-retrieval-and-context-references.md#context-reference-contract) lists the fields for each layer. Every reference anchors on a changed line in its unit (3.5).

## Separate the questions

| Question | Relevant information | What it cannot establish alone |
| --- | --- | --- |
| Which sources look relevant? | Ranked source evidence | Correctness or adequate evidence for the obligation |
| How much can this response carry? | Query context budget and explicit omissions | How much the graph knows |
| What does the returned source identify? | Primary and contained callable identities with source ranges | Complete relationship coverage |
| What is connected, and how far away? | Selected relationships, direction, hop distance, paths | A safe stopping depth for every question |
| Where might a change matter? | Scoped blast radius, source, history, and other contextual signals | Proven runtime impact or a review disposition |
| Have we answered the actual obligation? | Applicable evidence, its provenance, and remaining uncertainty | An answer from rank, byte count, or depth alone |

Ranking and allocation are different decisions. Required source evidence describes an obligation, not an implemented search category. Do not hardcode an external case's expected helpers or roles into production allocation. Identity metadata must describe the source actually returned.

## What can exist before a query

An index can be built before any question is asked. With a known changed entity, such as one located by a diff, investigation can start there before search. With only a question, follow-up planning needs retrieved candidates or summaries prepared for indexed entities. An empty or partial index cannot supply an exhaustive dependency overview, and incomplete processing must be disclosed.

## Proposed investigation summaries

The owner's direction is to use precomputation to expose likely investigation breadth, depth and blind spots. Precomputation runs on commits in the background ([ingestion](08-ingestion-and-setup.md)). These summaries are candidates to evaluate, not current capabilities.

| Candidate summary | What it would help decide | Qualification it must keep |
| --- | --- | --- |
| Incoming and outgoing counts by relation | Which relationship requests may need another page or a narrower focus | Indexed view, filters and extraction limits; counts are not global truth |
| Hop layers and unexpanded boundaries | Which entities could be inspected next | Direction and selection, cap or deadline exhaustion, missing or unresolved edges |
| Cycle membership | How to traverse recursive dependency groups without infinite depth | A dependency graph is not a tree; membership does not prove behaviour |
| Test, prose and historical-context links | Which non-code sources may explain or verify the result | Connection type, provenance, and relevance distinct from causal impact |

Structural summaries belong to the structural operations, not the graph query (3.1). Every summary is tied to the exact repository view and indexing configuration. Same-batch summaries stay visibly unreviewed and never become committed attribution through caching.

## Evaluation controls

| Control | What it must expose |
| --- | --- |
| Same obligation with small, normal and unbounded context | Missing retrieval versus response-allocation loss |
| A chain deeper than the requested scope | An unexpanded boundary rather than false completeness |
| A wide fan-out and a cycle | Entry caps, breadth and termination without misleading tree depth |
| Unresolved edges and parse failures | Unknown coverage rather than zero impact |
| Docs, tests and historical co-change | Useful non-code context without invented calls or causal claims |
| Changed revision or configuration | Stale-summary rejection and preserved provenance |
| Retrieval without an enrichment request | No automatic impact traversal or delayed first result |

These controls belong in the benchmark and in the pass 1 and pass 2 measurements. Reuse existing capabilities before adding new machinery.
