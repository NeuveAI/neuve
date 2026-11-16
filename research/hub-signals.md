# Hub signals in retrieval

A literature survey from 17 October 2026, supporting decisions [9.31](../process/decisions.md) (hubs are handled in the pipelines, never by mapping files) and [9.32](../process/decisions.md) (which hub variants the M4 benchmark tests). A hub here is an item that ranks high for many unrelated queries, measured from retrieval behaviour rather than from its file name.

## Summary

Evidence that hub handling helps code retrieval is thin. Most methods were shown in cross-lingual, cross-modal, question-answering or recommender settings. The best-evidenced pieces for code are cross-encoder and LLM rerankers, and convex score fusion beating reciprocal rank fusion in general retrieval. Every method should therefore be measured on Neuve's own benchmark before it is adopted.

## What Neuve already has

- Graph damps the caller-degree boost (2.6 × log2(1 + callers), capped at 8) so hub symbols cannot bury strong lexical evidence, and weights rare query terms by IDF (`apps/neuve-graph/internal/sem/search.go`).
- Graph also drops lockfiles by name during its file walk (`internal/sem/ignore.go`). That is a per-type rule; it stays, but new work does not copy it.

## A generic hub measure

For each chunk, count how many development-hunk queries put it in their top k (its k-occurrence, Radovanović et al., 2010). Report the skew of that count and the share of each arm's budget spent on the most-retrieved 1% of chunks. Split necessary recall between gold items in often-retrieved and rarely-retrieved chunks: a good correction raises the second without losing the first. Build any query bank from development hunks or the base snapshot, never from held-out gold.

## Techniques, by stage

| Stage | Technique | Evidence | Fit and risk |
| --- | --- | --- | --- |
| Reranking | Cross-encoder or listwise LLM reranker (monoBERT; RankGPT; SweRank, 2025; CoRNStack, ICLR 2025; Qwen3-Reranker, 2025) | Strongest code evidence found | Already arm R. No paper measures its effect on hubs specifically. |
| Reranking | Rescoring by retrieval frequency: CSLS (ICLR 2018), QB-Norm (CVPR 2022), NNN (EMNLP 2024) | Strong for cross-modal search; weak for text; none for code | Generic, needs a query bank. May bury central items that are truly necessary. |
| Reranking | Duplicate collapse (line overlap, MinHash or SimHash), then diversity over the changed lines (xQuAD, WWW 2010; MMR, SIGIR 1998; PM2; greedy DPP) | Established in general IR; code-review studies report that redundant context hurts | Cheapest. Loses recall when several necessary items sit together, so keep the diversity weight small. |
| Fusion | Weighted fusion of normalised scores tuned on dev, against RRF (Bruch, Gai and Ingber, TOIS 2023) | Convex fusion beat RRF in and out of domain; not tested on code | RRF ignores score size, so a source that always ranks the same hubs first keeps them on top. Risk of overfitting the weight on few families. |
| Graph | Node specificity (HippoRAG, NeurIPS 2024), log-degree penalties, degree-normalised walks | Question answering only | Neuve's capped log boost is already in this family. |
| History (pass 2) | Co-change rules from commits of about 8 files or fewer, scored with lift (Moonen et al., ASE 2016; Zimmermann et al., 2005) | Established in mining software repositories | Generic size limit. Drops real coupling carried by large commits. |
| Refinement | Query rewriting toward the changed identifiers and behaviour; iterative or agentic narrowing (RepoCoder, Agentless, LocAgent) | Narrowing helps code tasks; no evidence on hubs | Pseudo-relevance feedback before any hub correction likely amplifies hubs (an inference, not a published result). |

## Not preferred

- Rules by file name or type, which are brittle and ruled out by 9.31.
- Hard degree caps that drop nodes, which lose the specific line a change relies on.
- Pseudo-relevance feedback before a hub correction.
- Community detection or community summaries (Leiden, GraphRAG), which are built for broad questions rather than lookups anchored to a hunk.

## Sources

- Radovanović et al., "Hubs in Space", JMLR 2010. https://jmlr.org/papers/v11/radovanovic10a.html
- Schnitzer et al., mutual proximity, JMLR 2012. https://jmlr.org/papers/v13/schnitzer12a.html
- Feldbauer and Flexer, KAIS 2019. https://link.springer.com/10.1007/s10115-018-1205-y
- Conneau et al., CSLS, ICLR 2018. https://arxiv.org/abs/1710.04087
- Nielsen and Hansen, NLDL 2024. https://proceedings.mlr.press/v233/nielsen24a.html
- Bogolin et al., QB-Norm, CVPR 2022. https://arxiv.org/abs/2112.12777
- Chowdhury et al., NNN, EMNLP 2024. https://arxiv.org/abs/2410.24114
- HippoRAG, NeurIPS 2024. https://arxiv.org/abs/2405.14831
- GraphRAG, Edge et al., 2024. https://arxiv.org/abs/2404.16130
- Moonen et al., ASE 2016. https://cms.simula.no/sites/default/files/publications/files/practical_guidelines_for_change_recommendation_using_association_rule_mining_1.pdf
- Zimmermann et al., ICSE 2004 and TSE 2005. https://www.st.cs.uni-saarland.de/papers/icse2004/
- Chen et al., greedy DPP, NeurIPS 2018. https://arxiv.org/abs/1709.05135
- Abdollahpouri et al., FLAIRS 2019. https://arxiv.org/abs/1901.07555
- Bruch, Gai and Ingber, TOIS 2023. https://arxiv.org/abs/2210.11934
- Khattab and Zaharia, ColBERT, SIGIR 2020. https://arxiv.org/abs/2004.12832
- Nogueira and Cho, 2019. https://arxiv.org/abs/1901.04085
- RankGPT, EMNLP 2023. https://arxiv.org/abs/2304.09542
- SweRank, 2025. https://arxiv.org/abs/2505.07849
- CoRNStack, ICLR 2025. https://arxiv.org/abs/2412.01007
- Qwen3 Embedding and Reranker, 2025. https://arxiv.org/abs/2506.05176
- AACR-Bench, 2026. https://arxiv.org/abs/2601.19494
- "When More Retrieval Hurts", 2025. https://arxiv.org/abs/2511.05302
- Lu et al., ICML 2025. https://arxiv.org/abs/2505.17928
- HyDE, ACL 2023. https://arxiv.org/abs/2212.10496
- Query2doc, EMNLP 2023. https://arxiv.org/abs/2303.07678
- RepoCoder, EMNLP 2023. https://arxiv.org/abs/2303.12570
- Agentless, 2024. https://arxiv.org/abs/2407.01489

Seen only as abstracts: LiteRAG (arXiv 2609.10239), CatRAG and arXiv 2605.26575. Effect sizes for CoRNStack and AACR-Bench were not seen.
