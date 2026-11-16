# 0006: Hybrid retrieval and context references

Status: accepted, 16 October 2026; revised 18 October 2026. Source: decisions [3.1–3.12, 10.10 and 10.43–10.54](../../process/decisions.md). This revises [the structural-engine foundation](../../foundations/09-structural-engine.md), which needs updating with the owner.

## Context

The current retrieval falls short in five ways:

- Semantic retrieval has never run on real work.
- Graph search results cannot be cited.
- Structural follow-up is hard-coded to "unavailable".
- Only changed lines get margin pins.
- Context items lack the fields the context margin shows.

## Decision

- **Layers of retrieval.** The semantic layer (graph and embeddings) indexes code and local docs, with provenance metadata on every entry. Procedural collection then enriches and reranks with scope sources, prior Records reviews and comments, and git history. Finally the agentic layer refines, reranks and prunes down to what matters for this review and for future generations.
- **Integrations (10.51–10.54).** External sources are reached through MCP servers or SDKs the user defines in their own user-level file, proxied as read-only agent tools; Neuve holds no credentials and never reads a repository's `.mcp.json`.
- **External scope sources ([3.12](../../process/decisions.md)).** Process systems such as Linear, Notion and Jira are read at the start of each cycle, never mirrored. Only the excerpts that enter a unit's surrounding context are kept, each dated, as part of the batch's and cycle's immutable data with the same retention; the rest of the item is linked, not stored. A citation links to the source item and states the snapshot date, so generations rest on the truth available at the time.
- **Structural and static analysis are separate, explicit operations.** The graph is for semantic embedding, analysis and retrieval. The semantic layer does not answer structural lookups; each result carries metadata that points to where more context can be found, and the harness answers structure with deterministic lookups at the reviewed revision (`read`, `uses`, `defs`, `outline`, `symbol_at`, `tree`, `same_batch`), symbol-aware only behind declared capabilities (10.10, 10.44, 10.45).
- **Separate indexes first.** Code, docs and other sources are queried separately and merged, which is easier to get right than one central "omni" query. Signal-to-noise decides.
- **Incremental, git-led indexing.** The index follows commits. Hash metadata resolves ranges.
- **Benchmark before building more.** Compare the tuned EmbeddingGemma 2 against its baseline and other options, then consolidate one semantic-layer strategy. The Graph fork may be reset to the entire-graph baseline as part of this.
- **Build order.**
  - Pass 1: semantic, then scope sources, then agentic.
  - Pass 2: adds prior Records, git history and static analysis.

  The difference between the two passes measures the value of the extra context.

## Context-reference contract

One contract, specified for every layer (semantic store, Records, package, CLI, BFF), supplies everything the context margin shows. Layers as checked in Storybook on 16 October 2026:

| Layer           | Fields it needs                                                                                                                                                                                                |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L0 pin          | Anchor on a changed line in the unit (hunk, side, lines), marker kind, count, the other units that cite it                                                                                                     |
| L1 peek         | One-line reason, source label and revision                                                                                                                                                                     |
| L2 card         | Kind and title, a body specific to the kind (for example a graph path with hop depth), "Before you decide" (one sentence and one action), a link to the source                                                 |
| L3 source sheet | Source kind, committed or same-batch, revision, the full source with the cited range, coverage and limits, the units citing it                                                                                 |
| Attribution     | Reference identity, batch and cycle, retriever, query, rank and score, provenance (repo, revision, blob, path and lines, or record or URL and version), stance (supports, contradicts, background, unresolved) |

Surrounding context always anchors on a changed line, even when it describes code elsewhere. The server derives quotes and offsets.

## Source chunks and responsibility sections

[Decision 12.57](../../process/decisions.md#area-12-ace-style-pi-transition-28-october-2026) makes Graph's outline the source of chunks and code-position identifiers for every language Graph parses. Both repository and stack indexes read bounded symbol batches through `graph-client`. Provider identity and the chunk recipe invalidate older computations. Markdown keeps heading sections. When Graph is unavailable, does not parse a language, or reports a parse or partial failure, the file gets line windows with a named fallback. Non-empty input always has a chunk; a single line over 4 KiB remains an indivisible window.

Responsibility sections use outline ranges for imports, declarations, functions, classes and exposed test blocks. A class remains one section. Missing outlines produce one section per hunk with the reason stated. The [section ownership rule](../../process/decisions.md#area-10-harness-m3-18-october-2026), 10.109, continues to separate these sections from retrieval chunks.

The benchmark now runs Graph units only, with Graph's R(H3-E0) as its comparison baseline. The M4 archive note (kept in the private archive) identifies the retained historical results that the removed unit set produced.
