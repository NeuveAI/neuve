# Retrieving context for the mixed-tier repair

Status: research and proposed experiments, 2026-09-20. No graph schema, embedding model, algorithm, library, or store is selected. This comparison uses the [same client, producer, packaging, and verification hunks](worked-review.md#start-with-actual-hunks). It reports no measured Neuve retrieval improvement.

## Separate three questions

Retrieval asks whether we found the relevant source fragment. Attribution asks why that fragment applies to a particular hunk. Evidence assessment asks what an observation actually establishes on the submitted revision.

In this example, finding the harness's green result is successful retrieval. Using it to claim that host-push or browser rendering succeeded is wrong attribution of evidence. A fragment about branch-level blocking can be relevant surrounding context while being the wrong source for the slice-level aggregation rule.

[ALCE's citation evaluation](https://arxiv.org/html/2305.14627v2#S3.SS3) distinguishes answer correctness from citation support and irrelevant citations. Applying that distinction to hunk attribution is an inference for Neuve, not an already validated metric.

## Compare the candidates on the same change

| Approach | How it would search this example | Main failure to expose | Cost to measure |
| --- | --- | --- | --- |
| Lexical retrieval | Search identifiers, exact diagnostics, paths, and commit text for `mergeBlocking`, `focused_diff_slices`, or `structuredContent`. | A same-name field or superseded contract can outrank the relevant fragment; paraphrased intent may have no matching identifier. | Index updates, query work, candidate volume, and context sent to reviewers. |
| Vector retrieval | Match “mixed review responsibilities rejected as an invalid artifact” to related repair prose. | Semantic similarity can conflate branch and slice semantics or favor a confident but overstated verification report. | Embedding input, storage, refresh, query embedding, and downstream model tokens. |
| Graph traversal | Follow the validator's callers, the adapter, source relationships, packaging, and host transport. | A call graph may not represent configuration-driven registration or a build embedding generated HTML; high-degree helpers can flood the results. | Extraction and refresh work, traversed relations, and returned context. |
| Lexical plus vector fusion | Combine exact identifier hits with explanatory prose, then deduplicate candidates. | Both searches may miss the build dependency. Combining ranks does not establish authority or applicability. | Both indexes plus candidate fusion and any reranking. |
| Search plus bounded graph expansion | Seed from identifier or semantic hits, then investigate the producer, artifact, and transport dependencies. | Missing or inferred edges can create false confidence in the surrounding context. | Search, traversal, enrichment, reranking, and total context consumption. |

These are analytical expectations to test. [Anthropic's contextual retrieval experiments](https://www.anthropic.com/engineering/contextual-retrieval) compare lexical and semantic retrieval, adding explanatory context to fragments, and reranking. Their datasets and reported gains do not establish Neuve attribution quality. [Elastic's rank-fusion documentation](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/reciprocal-rank-fusion) illustrates combining ranked lists within bounded candidate windows, not validating the resulting evidence. [CodeQL's analysis documentation](https://codeql.github.com/docs/writing-codeql-queries/about-data-flow-analysis/) identifies unavailable source and runtime resolution as challenges and distinguishes local from more costly global analysis.

My recommendation for the next experiment is a lexical baseline, then lexical plus structural expansion, then an added semantic retriever. That order tests whether embeddings recover material context the simpler candidates miss. It is an experiment order, not an architecture decision.

## What Entire Graph actually contributes

At the inspected revision, Entire Graph's [search contract](../../.better-coding-agents/resources/entire-graph/docs/search.md:14) combines lexical ranking with callers, callees, and neighboring code. Its [search implementation](../../.better-coding-agents/resources/entire-graph/internal/sem/search.go:1058) explicitly uses no embeddings. “Hybrid” in that source means lexical plus structural retrieval, not lexical plus vector search.

Results have count and byte limits. A missing result therefore does not prove a missing dependency. The [snapshot contract](../../.better-coding-agents/resources/entire-graph/docs/snapshot-format.md:33) makes the trailing summary authoritative for extraction failures and completeness. Retain that coverage information with the results.

The [working-tree cache boundary](../../.better-coding-agents/resources/entire-graph/internal/sem/search_cache.go:85) avoids persistent reuse for live content. Its [working-tree snapshot warning](../../.better-coding-agents/resources/entire-graph/internal/sem/provider.go:1857) matters because HEAD metadata does not certify that every extracted byte came from that commit. The earlier [Entire inspection](../research/03-entire-and-code-context.md) records further identity, coverage, and checkpoint limitations.

## Attribution filtering and enrichment

For the client hunk, a proposed attribution check would ask whether the fragment concerns the visible slice membership, applies to the relevant source version, and supports the stated relationship. The accepted [attribution questions](../foundations/06-escalation-and-decomposition.md#next-investigation-and-discussion) remain the guide: what the fragment establishes, why it applies to this hunk, and what remains uncertain.

| Candidate found | Proposed treatment | Reason |
| --- | --- | --- |
| Producer's visible-member aggregation | Attach the exact fragment to client and producer hunks with their relationship. | It corroborates the shared membership contract. |
| Branch verdict logic | Retain as surrounding context, with its separate role. | It explains the hidden obligation without redefining the slice flag. |
| Historical report that a model was “rendered” | Read alongside the harness execution boundary before deriving a claim. | The word refers to a model state in this harness. |
| Existing valid report carried into a new revision | Reuse unless invalidated, retaining its identity and established scope. | A different commit alone does not invalidate it. Applying it to a different host path may require evidence it never supplied. |
| Duplicate copies of the same review report | Present once where useful while preserving source lineage. | Duplicate text is not independent corroboration. |
| Conflicting source instructions | Preserve both with their authority and dates. | Similarity rank cannot decide intended behavior. |

Enrichment could label the producer/client relationship, identify a security consequence, or request the missing packaging evidence. Such generated interpretation stays distinct from the retrieved fragment. If the interpretation cannot be supported, it remains uncertain rather than becoming an asserted graph fact. The unit's full context then informs assessment, including escalation or de-escalation.

## Representation choices exposed by this example

These are alternatives to compare, not a chosen graph model:

| Choice | Concrete consequence |
| --- | --- |
| Code structure only, versus code plus source/history/artifact relationships | Code edges can expose callers but may omit the review report, build output, and host message boundary that matter here. Additional relationships need their own provenance and refresh rules. |
| Raw fragments versus fragments indexed with generated explanations | An explanation can connect “mixed responsibility” to the original identifiers. It can also inject an incorrect contract. Keep the original source accessible and evaluate explanation-induced errors. |
| One embedding treatment versus separate treatment for code and prose | The validator's identifiers and the reviewer's explanation need different matching behavior. A shared ranking scale cannot be assumed; compare the returned fragments and cost before choosing. |
| Persistent inferred relationships versus on-demand enrichment | Persistence can reduce repeat work but needs invalidation. On-demand work can adapt to the current hunk but repeatedly consumes tokens. |
| Stable source identities with versioned observations versus overwriting a current record | Historical results need the exact source version they described. The logical requirement does not select a database or review-unit identity scheme. |

## Ingestion and freshness

Initial foreground or background pre-population, Git-led event updates, and active ingestion all feed the same conceptual source processing in the [retrieval diagram](review-diagrams.md#2-retrieval-attribution-and-ingestion). A proposed implementation would retain per-source progress, content/version identity, and extraction warnings so unfinished processing cannot be mistaken for absence of context.

Git hooks offer commit, checkout, merge, and rewrite events with different coverage. The [Git hook reference](https://git-scm.com/docs/githooks) notes, for example, that `post-rewrite` does not cover every history-rewriting tool. Inference: event-triggered work needs reconciliation against the current state. Git events alone cannot detect an externally edited ticket. Compare source webhooks, periodic refresh, and explicit active refresh for that gap.

Proposed failure probes are an interrupted initial pass, a duplicate event, a deleted source, an amended commit, and an external requirement updated without a Git change. Processing should resume without silently duplicating observations or keeping superseded material current. These are experimental expectations, not a selected queue, hook, polling interval, or history depth.

## A compact evaluation before choosing technology

Create expected fragment-to-hunk attributions from this example, with separate labels for support, relevant background, contradiction, and unrelated material. Those are evaluation annotations, not additions to product vocabulary. Have an independent reviewer check the expected relationships before scoring retrieval.

Hold source versions, queries, input hunks, and delivered-context budgets fixed. Compare lexical, vector, lexical plus graph, and the combined candidate. Also record preprocessing costs so repeated queries do not hide expensive ingestion.

| Variant | Failure the evaluation should detect |
| --- | --- |
| Original per-member equality restored | The mixed-member case remains a regression, even if a briefing sounds convincing. |
| Hidden required member with nonblocking visible members | Slice and branch semantics must remain distinct. |
| Same identifier in unrelated source | Wrong attachment must not count as a useful retrieval hit. |
| Green model-only harness | Missing browser and host-push evidence must remain explicit. |
| Old bundle with the expected diagnostic string inserted | Literal matching cannot stand in for artifact equivalence or executed behavior. |
| Packaging relationship missing from the graph | Retrieval completeness must not be inferred from traversal completing. |
| Source renamed, unit split, or patch moved to another branch | History links must expose uncertain matching and avoid transferring approval by name alone. |
| Duplicate review report or repeated source event | Repeated evidence must not become extra corroboration or extra corrections. |
| Changed producer contract with unchanged client text | Dependency change must prompt renewed applicability assessment. |

Report missing material attributions and wrong attributions separately, using explicit denominators over the expected relationships and emitted attachments. Track missed regressions above apparent review convenience. Record unnecessary re-review separately from relevant context reuse. Count total input and output tokens across retrieval enrichment, briefing, review, retries, and invalidation work, with embedding and non-model processing costs visible alongside them.

No acceptance threshold or weighted score is proposed here. One worked example establishes useful test cases; it cannot establish general retrieval quality or a winning architecture. Broaden the corpus before adopting a design, including dynamic dependencies and cases with no useful source to retrieve.
