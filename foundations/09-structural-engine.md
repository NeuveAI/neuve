# Graph and structural analysis

Status: revised 2026-10-16 to match the owner's [design decisions](../process/decisions.md) 3.1–3.4, 3.8 and 3.9, and the [hybrid retrieval record](../architecture/decisions/0006-hybrid-retrieval-and-context-references.md). Which semantic-layer strategy to keep waits on the embedding benchmark.

## What the graph is for

Neuve is a hybrid system: it combines structural analysis, other static and procedural analysis, and agentic analysis (1.3, 3.1). The graph is the **semantic layer**. It serves semantic embedding, analysis and retrieval over code and local docs. It finds meaningful leads and carries the metadata needed to refine them (3.2). It is not solely responsible for structural work.

| Concern | Where it lives |
| --- | --- |
| Semantic embedding, analysis and retrieval | The graph and its embeddings |
| Structural facts, such as callers or callees of a changed entity | Separate, explicit structural operations, not inside a graph query (3.1, 3.2) |
| Other static and procedural analysis | Separate, explicit operations |
| Judging relevance, refining and pruning | The agentic layer of the harness ([retrieval foundation](11-retrieval-context-and-investigation.md)) |

Structural follow-up is hard-coded to "unavailable" today and was never built. It needs its own explicit operations.

## Rules for the semantic layer

- **Provenance on every entry** (3.4). Graph and embedding entries carry provenance metadata, such as repository, revision, blob, path and lines, so results can be attributed and cited. A retrieval result the package cannot cite is a defect. The metadata work is likely NEU-13, versioned embeddings during ingestion; confirm against Linear.
- **Separate indexes first** (3.8). Code, docs and other sources are queried separately, then merged and reranked. This is easier to get right than one central query answering everything. Signal-to-noise decides which to use.
- **Git-led, incremental indexing** (3.9). The index follows commits as code evolves, and hash metadata resolves ranges ([ingestion](08-ingestion-and-setup.md)).
- **Benchmark before building more** (3.3). Compare the fine-tuned EmbeddingGemma 2 against its baseline and other options, using standard practice and the research in the repository, then consolidate one strategy. No more semantic-layer building happens until the benchmark exists.

Retrieved results are contextual candidates, kept separate from verified evidence. A relevant query result cannot substitute for an expected relationship that the engine did not expose, and a successful relationship lookup cannot conceal a failed query. Owning the graph does not make its output trusted. The [verification principle](07-verification-and-evidence.md#established-principle) still requires each result to state what it establishes and what remains unresolved.

Neuve's contracts stay language-neutral, as the [repository constitution](../CONSTITUTION.md#repository-language-neutrality) requires. Language is observation data, not a product-wide mode. Neuve discovers each provider's declared capabilities and preserves per-language coverage and limitations.

## The Neuve Graph fork

Neuve Graph started from Entire Graph revision `5637039f7da7c8f35726eec22c230491a3f90b9f`. The upstream project uses the MIT license, which permits modification and redistribution while requiring preservation of its copyright and license notice. The fork may be reset to the Entire Graph baseline as part of the benchmark (3.1, 3.3).

| Fact | Value |
| --- | --- |
| Mount | `apps/neuve-graph`, a separate Git repository mounted as a submodule |
| `origin` | `git@github.com:NeuveAI/neuve-graph.git`, private and Neuve-owned |
| `upstream` | `git@github.com:entireio/entire-graph.git`, fetch only; pushes are disabled with the literal URL `DISABLED` |
| Baseline tag | The annotated tag `neuve-upstream-baseline-2026-09-27`, pointing at the upstream revision above |
| Setup | `bun run setup:graph` from the root configures and verifies these remotes; it is safe to repeat |

Validation identifies the configured fork through an operational marker: the exact private `origin`, the `upstream` remote with the original fetch URL, disabled upstream pushes, the annotated baseline tag, and ancestry from that baseline. Each run records the exact engine revision it used.

The external `neuve_effect` suite (kept in the private archive) holds the first three realistic retrieval and relationship cases. Fixture language is case data and neither selects nor limits the supported languages. The former lexical provider was temporary scaffolding, never a second retained provider. What remains of it, the optional `known_lexical_baseline` case field parsed in [the external case reader](../packages/evaluation/src/external-validation-case.ts), is to be deleted.

## Change discipline

Each engine change must answer a frozen case that names the failed stage, the expected relationship or retrieval result, and the pinned source that establishes it. Changes to the semantic layer are also measured against the benchmark. A change to ranking must not silently weaken another measurement. A new extractor must not silently relabel inferred relationships as exact. A fixture establishes only the behaviour it exercises.
