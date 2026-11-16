# M4 semantic-layer benchmark: design proposal

Historical proposal. Its review-stage graph and budgets are superseded by the [fixed-shape pipeline record](../../architecture/decisions/0005-harness-pipeline.md), which describes the NEU-111 trial. The [owner's decisions](../decisions.md) remain authoritative for accepted product meaning and the other topics below.

Status: accepted on 17 October 2026 with [rulings 9.1–9.32](../decisions.md#area-9-benchmark-m4-17-october-2026), which change some recommendations below; where they differ, the rulings win. This file is the design record behind them, revised the same day after an independent fact-check. The [decision list](#8-decision-list-for-the-owner) at the end collects the choices the owner ruled on. It serves [decision 3.3](../decisions.md), "benchmark before committing to a strategy", and the pass 1 measurement in [decision 3.7](../decisions.md). The [living plan](../plan.md) names this benchmark as M4's first deliverable.

Terms follow the [product vocabulary](../../vocabulary.md). **Surrounding context** is the supporting information used to assess a review unit ([vocabulary](../../vocabulary.md), line 16). A **contextual marker** is a retrieved piece of it, smaller than its source and traceable to it, linked per hunk (line 19). Markers appear in the **context margin** beside the diff (line 93). **Same-batch context** is work inside the selected range; work outside it carries its own review status ([decision 4.12](../decisions.md), line 78).

## Starting evidence

What the repository already holds, checked rather than taken from earlier "qualified" or "verified" labels. Most of it lives in the gitignored `.scratchpad`, which [decision 5.10](../decisions.md) keeps. It is the only copy of this evidence.

| Claim | What I found | Source |
| --- | --- | --- |
| Semantic retrieval never ran on real work | Confirmed in substance. Every earlier embedding run scored either a pool of 8–25 hand-picked candidates or one smoke corpus of 1,729 fragments with 26 author-written queries. None retrieved surrounding context for real hunks over a whole repository snapshot. I did not find the 793-byte repository the audit mentions. | [ADR 0006](../../architecture/decisions/0006-hybrid-retrieval-and-context-references.md), line 9; MAX diagnostic (kept in the private archive), line 12 (eight-document pools); smoke dataset (kept privately), line 25 |
| Retrieval quality was never measured | Partly wrong. It was measured, but only on small exposed sets: 26 queries in 18 families, with wide intervals. See the table below. | Smoke dataset (kept privately), lines 25–35; `supervisor/dense-results.json`, `competitor-results.json` and `minilm-results.json` in the same scratch folder |
| The tuned model exists | Six adapters exist, not one. Details below. | Below |
| Each search starts a new Python process | Confirmed. Records constructs a `SemanticClient`, which spawns the worker and loads the model, for every query and closes it afterwards. The worker itself can serve many requests from one process. | `apps/neuve-records/src/semantic-invocation-query.ts` at `91273d11`, lines 441 and 610; [worker loop](../../packages/semantic-client/src/worker.py), line 129 |
| 26k lines of custody code | About 22k lines measured: semantic code in Records and the CLI (7,637), `packages/semantic-client` (3,724), tracked `research/embedding-pipeline` (kept in the private archive) files (8,760, including JSON) and `research/pr-bench/embedding-rd` (2,251). I did not reproduce 26k exactly. | `wc -l` over those paths |

**Smoke-set results, required-fragment coverage at 5 results.** This is the only whole-corpus comparison that exists.

| Method | Coverage |
| --- | --- |
| BM25, filename plus body, provenance-filtered | 0.615 |
| MiniLM | 0.673 |
| EmbeddingGemma 2, 768 dimensions, filtered | 0.782 |
| **EmbeddingGemma 2 768 + BM25, fused by reciprocal rank (RRF, k=60)** | **0.686: fusion was worse than dense alone** |
| EmbeddingGemma 2 at 128 dimensions, alone and fused | 0.673 alone, 0.731 fused (fusion helped only here) |
| Qwen3-Embedding-0.6B | 0.853 |

The fusion is untuned, equal-weight RRF (evaluator (kept privately), lines 48–55). This proposal's hybrid arms and per-kind merge use the same fusion, so "fusion against dense alone" is an explicit comparison below rather than an assumption.

**The six adapters.** The base model is EmbeddingGemma 2 revision `914f7f89`. Each adapter is a rank-2 or rank-4 LoRA trained on 3–20 examples for 8–64 updates.

| Adapter (SHA-256 prefix) | Training data | Held-out result |
| --- | --- | --- |
| Phase 3 "broader" (`f7039598`), code, docs, feature and history relations, 64 updates on an L4 | 13 Entire Graph cases | Entire CLI test: 10 cases but only **2 families**. Results are in the next table. |
| Phase 3 "code only" (`b8ffdc00`) | Same | Same test; next table |
| Phase 2 A (`f50a120f`) and B (`a9df9444`), 32 updates | 20 questions: 32 Entire Graph fragments and 6 Neuve fragments from `scripts/setup-graph-workspace.ts` and `scripts/install-cli-local.ts` at `64c440e6` | Entire CLI, 9 cases: the base was 9/9 at rank 1 (saturated); both adapters were 9/9, and 8/9 at 128 dimensions (final comparison (kept privately), lines 1–9) |
| Aligned-hybrid fit-v1 (`fee88549`), rank 2, 7,168 parameters, 60 updates | 14 fit pairs from a CodeSearchNet cohort | 16 queries in 12 families. All five arms (BM25, base dense, base hybrid, tuned dense, tuned hybrid) scored 0.528; Δ 0, CI [0, 0]. Its no-harm gate failed (2 queries gained UNKNOWN results), and its verdict is `NO_WEIGHT_VALUE_DEMONSTRATED` (handoff (kept privately)) |
| Pipeline-repair (`396d1a5a`), rank 2, 60 updates | Public libraries: boltons, toolz, pydantic, zod, chi | 4 dev queries only |
| Synthetic probe (`d9cd9b4b`), 8 updates | 3 literal triplets | None (mechanical only) |

**Phase 3 adapters against the matched base.** Each cell gives Δ necessary-support coverage at k=1 / k=3 / k=5, family-macro, then Δ useful recall at k=5. Source: `supervisor/phase3/paired-test-summary-v1.json`.

| Dimensions | Code only | Broader | BM25 control |
| --- | --- | --- | --- |
| 768 | 0 / 0 / 0; +0.054 | 0 / 0 / 0; +0.094 | 0 / 0 / −0.05; +0.054 |
| 512 | +0.05 / 0 / 0; +0.054 | 0 / +0.05 / 0; +0.074 | 0 / 0 / −0.05; +0.034 |
| 256 | 0 / +0.20 / 0; +0.04 | 0 / +0.15 / 0; +0.04 | 0 / +0.15 / 0; +0.034 |
| 128 | 0 / 0 / +0.15; +0.10 | 0 / 0 / +0.15; +0.134 | 0 / +0.05 / +0.15; +0.114 |

How to read this:

- The "0 at 768, k=5" is the average of two families moving in opposite directions: installer +0.1 and copilot −0.1.
- The BM25 control matched code-only's +0.054 useful recall at 768 dimensions.
- At 128 dimensions BM25 matched both adapters on necessary coverage at k=5 (+0.15). Its useful recall (+0.114) fell between code-only (+0.10) and broader (+0.134).
- The file's own triage records `candidate_for_next_larger_experiment: false` for both adapters.
- With 2 families, none of these deltas carries statistical weight.

**Training overlap with candidate benchmark ranges.**

- No adapter saw `neuve_effect`.
- The phase 2 adapters saw two Neuve scripts. `install-cli-local.ts` later became `apps/neuve-cli/scripts/install-local.ts` in `6a5f72b3`.
- Entire Graph, Entire CLI and CodeSearchNet were used for training and testing. They are not candidate corpora.
- Graph tuning is a separate exposure inside `neuve_effect`; [section 2](#leakage-rules) covers it.

## 1. Question and scope

**Decision needed:** what the benchmark must answer, and what it leaves out.

The benchmark answers two questions.

1. **For 3.3: which semantic-layer strategy.** Choose the encoder (or none), the index topology and the fusion, given the [layer contract](../../foundations/11-retrieval-context-and-investigation.md): semantic retrieval returns many leads with provenance for later refinement (line 17), from separate indexes per source kind (line 19).
2. **For 3.7: the pass 1 measurement ladder.** Fix the cases, gold and metrics so each pass 1 stage can be scored on the same hunks: semantic, then scope sources, then agentic. Pass 2 later reuses all of them unchanged, so "how much extra context helps" is a paired difference rather than a new experiment.

| Option | What M4 runs | Trade-off |
| --- | --- | --- |
| A. Semantic arms only | Stage 1 | Fastest; leaves 3.7 without a baseline |
| **B. Stage 1 plus the procedural scope stage; agentic stage scored on the same cases once the M3 harness exists** | Stage 1 and stage 2 | Answers 3.3 now; 3.7's ladder is ready; no throwaway agent harness |
| C. Full pass 1 including a purpose-built agent loop | Stages 1–3 | Duplicates M3 and couples the strategy decision to prompt design |

**Explicitly out of scope:**

- review findings, dispositions, lanes and digests;
- the context-reference contract;
- the correctness of structural operations;
- Pass 2 sources: prior Records, git history and static analysis. They are designed here and run in M6, per the [plan](../plan.md), line 21.

A structural reference line, Graph `neighbors` at depth 1 from the changed symbols, is reported but is not a candidate.

**Recommendation: B.**

## 2. Corpus and case selection

**Decision needed:** which repositories and ranges, how many, how they are selected and split, and how leakage is prevented.

### Repositories

| Option | Pros | Cons |
| --- | --- | --- |
| **A. `neuve_effect` primary plus this repo** | Real, docs-rich history with plans, handovers, diaries and strict reviews that cite `file:line`. Not in adapter training, apart from two Neuve scripts. | TypeScript-heavy. 15 of `neuve_effect`'s 17 test files arrived with the harness-consolidation work (PR #87, 18 April 2026). Fewer eligible ranges than the raw commit count suggests (see below). |
| B. Add `chrome-devtools-mcp` (761 commits, public PRs with review threads, 4 already in [PR Bench](../../research/pr-bench/README.md)) | Real reviewer comments; tests | Public, so pretraining contamination risk; more labelling |
| C. Add `perfagent-cli` (1,342 commits) or `neuve-git` (1,683 commits) | More volume | Unknown review practice; more labelling for the same decision |

This repo's history is young (17 September 2026 onwards) and self-referential, so it is the secondary corpus. It has 188 test files, counting tracked files named `*.test.*` or `*.spec.*`, so it carries most of the test-kind measurement.

**Recommendation: A for M4.** Add B if the eligible-range count below falls short, or as the M6 generalisation check.

### Eligible-range risk

Most of `neuve_effect`'s 2,354 commits arrived through 86 pull-request merges. Only 283 are first-parent direct commits.

- By my count, 43 of the 86 merges change 1–1,500 lines of code, excluding Markdown, JSON, YAML, lockfiles and migrations. The fact-check counted about 36 with a different filter.
- Those 43 come from about 25 branch families, and about 10 of those families are build or CI only.
- `fix-ws-streaming` alone supplies 11 of the 43.

Reaching about 45 `neuve_effect` ranges therefore needs intra-PR task slices. Those concentrate in a few large families, such as the HCP harness-consolidation tasks in PR #87.

| Option | Effect |
| --- | --- |
| A. Keep 45 and slice large PRs | Families become very unequal; the effective sample is the family count, not the range count |
| **B. Cap each family at 4 ranges and accept fewer ranges (about 30–35 from `neuve_effect`)** | Honest family balance; fewer ranges |
| C. Add `chrome-devtools-mcp` to reach the target | More families; public-data caveat |

What option B's count rests on:

- Dropping the build-only families leaves about 30 eligible merges in about 15 families.
- With the 4-per-family cap, those yield only about **20 ranges**.
- The other 10–15 must come from intra-PR task slices, each also capped at 4 per family, or from the `chrome-devtools-mcp` fallback.

**Recommendation: B**, with C as the fallback if held-out has fewer than 15 families.

### Ranges, change types and sizes

A range is a base and head pair ([1.4](../decisions.md)): a PR merge (`merge^1..merge`), a task slice inside a PR, or a short direct-commit run on one feature.

Stratify on four dimensions:

- **Change type:** feature, fix, refactor, test-adding, and docs plus code.
- **Size**, in changed non-generated lines including tests: S under 50, M 50–300, L 300–1,500.
- **Scope source:** a plan at the base, a plan only inside the range, or none ([1.8](../decisions.md)).
- **Area:** the app or package touched.

Exclusions:

- docs-only, lockfile-only and build-only ranges;
- generated files, such as the 10,549-line migration snapshot in `0acbd49d`;
- ranges over 1,500 lines.

Neuve's `8b430f65` (95,511 lines deleted) is a single dev stress case. Label up to 4 hunks per range, spread across files.

### Dev and held-out split

| Option | Leakage control | Cost |
| --- | --- | --- |
| A. Random by range | Weak: families straddle the split | Cheapest |
| **B. Grouped by family, stratified, one third dev and two thirds held-out** | Strong | Needs a family label per range (from branch names and `docs/handover/<family>`) |
| C. Temporal (dev before March 2026) | Mirrors deployment | Tests almost all in the latest period; strata unbalanced |

**Recommendation: B.**

- Dev is used to tune knobs and to **select the best dense and best hybrid arms**.
- Held-out runs once per frozen configuration and is opened only for the pre-registered comparisons.

### Leakage rules

- **Graph tuning, by range.** The external suite (kept in the private archive) tuned the Graph fork's query ranking over many rounds on three HCP ranges (`a75644f8`, `51961d1a`, `6e98e699`). Under the family rule the whole HCP family, including E1–E3 below, is **dev only**.
- **Graph tuning, by file.** The suite's questions targeted these files:
  - `browsing-session.service.ts`;
  - `browsing-agent-loop.ts`;
  - `runner-loop-kernel.ts`;
  - `agent-browser-executor.service.ts` and `agent-browser-runner-adapter.service.ts`.

  Fork changes may favour regions in these files in any range. By my count 16 of 104 merge commits touch them; the fact-check counts 14 of 89. Excluding those ranges would remove the central embeds service from the benchmark. Instead:
  - tag each hunk whose anchor or gold lies in a tuned file;
  - report G-fork against G-base both overall and on untagged hunks only;
  - make the fork-reset decision on the **untagged** subset.

- **Phase 2 training files.** Neuve ranges touching `scripts/setup-graph-workspace.ts`, `scripts/install-cli-local.ts` or `apps/neuve-cli/scripts/install-local.ts` are dev only.
- **Future knowledge.** Each case indexes only its exact base. A plan that exists at the base is indexed in its base version.
- **Documents added or edited inside the range.** Each is classified at curation and recorded in the manifest.
  - **Scope sources** (plans, tickets, task briefs): under [decision 1.8](../decisions.md), scope comes from whatever is available, and an in-range plan is available to a reviewer of that range. **The scope stage may read it.** E5's `relay-lifecycle/plan/task-2-…` and E6's `embed-misclassification-fix.md` are examples.
  - **Hindsight documents** (diaries, reviews, research written during or after the change): read by nobody but the labellers.
  - Neither kind enters the semantic index, nor is it scored as a retrieval target.
  - Results for the scope stage are reported per scope-source stratum, because an in-range plan may describe the implementation itself.
- **Benchmark self-leakage.** Neuve case bases must be at or before `3ea3659b`, and the indexers ignore benchmark data paths.
- **Pretraining.** Treat any public corpus as possibly seen by off-the-shelf models. `neuve_effect` is assumed private (not verified).

**Consequence for test-kind gold.** With the HCP family dev only, held-out `neuve_effect` ranges have almost no test files at their bases. Test-kind recall will be measured mainly on Neuve cases, with low power. The report states this rather than averaging over it.

### Example ranges

| # | Range (base..head) | Split | Size and stratum | Why it is a good case |
| --- | --- | --- | --- | --- |
| E1 | `neuve_effect` `123699a2..250ab2fd`, HCP-4A HTTP client consolidation | Dev only (HCP family) | L (805+/178−) | The plan `docs/research/diary/harness-consolidation-proposal-2026-04-16.md` exists at the base. The in-range review cites `browsing-api.ts:163`, `:277` and `browsing-api.test.ts:126`. A later fix, `c16ce104`, touches `browsing-api.ts`. |
| E2 | `neuve_effect` `f35ab598..b04843f1`, HCP-5A terminal event publisher | Dev only; touches a tuned file | L (568+/66−); plan at the base | Necessary context lives inside a 145 KB service, which tests chunking. |
| E3 | `neuve_effect` `b04843f1..336d36f5`, HCP-5B | Dev only | M (102 lines) | Follow-up whose necessary context includes code that E2 committed. |
| E4 | `neuve_effect` `f03d28ab..b42c1db7`, PR #75 ws-streaming fix | Held-out candidate; touches a tuned file | Fix; plan at the base, also edited in the range | Plan, diaries and research exist at the base, which tests the docs index. Its family (#64–#75) gives "later fix" signals; capped at 4 ranges. |
| E5 | `neuve_effect` `20c58be3..f255f785`, PR #84 relay lifecycle | Held-out candidate; touches a tuned file | L feature over 15 code files; **plan only inside the range** (`relay-lifecycle/plan/task-2-…` is added in the range) | The three agent loops are all edited in this range, so their changed hunks are **same-batch context**, not retrieval targets. Only their unchanged regions at the base are scored. |
| E6 | `neuve_effect` `ec073cd2..b2222ace`, embed misclassification fix | Held-out candidate | M (code commit `c0072c36`, 62+/81−); plan only inside the range, committed first | Prompt and intent-classification change; `agent-context/*.md` docs at the base are plausible necessary context. |
| N1 | Neuve `647b9731^..647b9731`, qualified Git tree path resolution | Held-out candidate | L (443 lines including test) | `git-read-qualification.ts` is present at the base and is necessary context. |
| N2 | Neuve `7037b9bf^..7037b9bf`, decision-dock focus and Escape | Held-out candidate | L (716 lines); design decisions at the base | Docs-to-code: [round 6 design decisions](../../design/neuve-web/changes/round-6.md). |
| N3 | Neuve `6622ae1a^..6622ae1a`, latest review checkpoint | Held-out candidate | L (523 lines); contract doc at the base | `apps/neuve-cli/HISTORY.md` is necessary doc-kind context. |

## 3. Ground truth

**Decision needed:** what "correct context" means per hunk, how it is labelled, how finely, and how it is broken down by source kind.

**Definition.** Every marker anchors on a changed line ([3.5](../decisions.md)). A gold item is a source region (a path plus a line span, or a heading section for docs) that a reviewer needs to judge that hunk.

- **Necessary**: the hunk cannot be judged soundly without it. Its absence is a **missing attribution** ([reviewer's tax](../../foundations/05-reviewers-tax.md), lines 23–24).
- **Useful**: it materially helps.
- A region that is retrieved, judged irrelevant and attached anyway is a **wrong attribution**.

**Committed and same-batch context, per [4.12](../decisions.md).** The case's range is the selected range.

- A gold item that is a **changed hunk inside the selected range** is same-batch context. It is recorded in the gold with that status, but excluded from semantic scoring, because it comes from the diff, not from retrieval.
- A gold item **outside the selected range**, which is unchanged code at the base, scores as committed context. This includes unchanged parts of a file the range edits. Its review status is recorded as "no Neuve review record" for these corpora, since Records holds nothing for them.
- If a later reviewer narrows or widens the range, items move between the two categories. The benchmark fixes the range per case.

**Source kinds:**

| Kind | Examples | Stage |
| --- | --- | --- |
| Code | Callers, contracts, types, sibling implementations | Pass 1, semantic |
| Tests | Existing tests covering the behaviour | Pass 1, semantic |
| Docs | Architecture docs, READMEs, `agent-context/*.md`, design notes | Pass 1, semantic |
| Plans and scope | The plan or ticket at the base, earlier handovers and reviews | Pass 1, semantic plus scope stage |
| History | Prior commits on the same symbols; later fixes (as labels only, never inputs) | Pass 2 (M6); labelled now |

**Labelling options** (for about 200–240 hunks):

| Option | How | Owner time | Validity |
| --- | --- | --- | --- |
| A. Owner labels from scratch | Owner reads each hunk and the repo | ~10–15 min per hunk, about 40–60 h | Highest; infeasible |
| B. Two Opus 5.5 labellers, owner-adjudicated | Pool candidates per hunk: the top 20 of each arm, history-derived candidates and `file:line` citations from in-range reviews. Two Opus labellers with hindsight grade each candidate. The owner adjudicates held-out necessary labels, 20% of useful labels and disagreements. | About 5–6 h | Errors correlate: two runs of one model share blind spots, and a necessary item both mark irrelevant never reaches the owner. M3's agentic stage also runs Opus, so it would be graded by its own model family, which inflates its scores. |
| **B′. As B, but the second labeller from another model family, plus owner sampling of items both marked irrelevant** (route and fallback under [privacy](#privacy-and-hosted-services)) | Same pooling. The owner also reviews a random 10% of "both irrelevant" items on held-out, to estimate the rate of missed necessary items. | About 6–8 h | Lower error correlation; the miss rate is estimated rather than assumed zero. The agentic stage can then be scored against non-Opus or owner-confirmed labels only. |
| C. History-derived only | Co-changed files, later fixes, tests importing the changed symbol, files cited in reviews | 0 h | Unknown and biased toward code; co-change is not necessity ([blast radius](../../vocabulary.md)) |

Items outside the pool are never judged under any option. The report gives judged@k for each arm.

**Token re-estimate (supersedes the earlier 25k figure).** A labeller reads:

- the hunk and its scope plan, about 2–5k tokens;
- about 30–60 pooled candidate regions at roughly 1–4k tokens each, since Graph regions run up to 16 KB;
- the range's hindsight reviews and diaries, about 5–20k tokens.

That is about 60–150k input tokens per hunk per labeller, so about 25–70M input tokens for two labellers over 240 hunks. Prompt caching per range reduces cost but not volume.

**Recommendation: B′, with C as the candidate generator.** Measure C's agreement with adjudicated labels on dev.

**Relevance scale.** Three levels: necessary 2, useful 1, irrelevant 0. Unjudged items are never scored as 0. This matches the necessary ⊆ relevant gold shape in [context metrics](../../packages/evaluation/src/review-quality/context-metrics.ts), lines 18–29. **Recommendation:** three levels.

## 4. Arms

**Decision needed:** what is compared, and what is held fixed.

| Group | Arm | Notes |
| --- | --- | --- |
| Lexical and structural | **G-fork**: Graph `query` at fork HEAD `f89d58a` | Hybrid lexical, identifier, path and neighbour ranking; BM25 chunks with RRF at k=60 in deep mode ([search.go](../../apps/neuve-graph/internal/sem/search.go), lines 54 and 225). Exact-commit reads ([Graph guide](../../apps/neuve-graph/AGENTS.md), line 51). |
| | **G-base**: Graph `query` at the Entire baseline (`5637039f`) | Decides the fork reset ([foundation 09](../../foundations/09-structural-engine.md), line 31). The fork has changed `search.go` by 817 insertions and 253 deletions since the baseline. |
| | **L**: BM25 over the shared chunks, path plus body | k1=1.2, b=0.75 (MAX diagnostic, line 12, kept in the private archive) |
| Dense | **E0**: EmbeddingGemma 2 base | Cached locally |
| | **E1**: E0 plus the phase 3 "broader" adapter | The candidate "tuned model" |
| | **E2**: Qwen3-Embedding-0.6B | Best on the smoke set. Its local weights appear removed (15 MB left), so it needs a download at run time. |
| | **E3**: one larger open model, for example Qwen3-Embedding-4B, jina code embeddings or nomic-embed-code | Choice, version and licence to confirm at run time (unverified) |
| | ~~**E4**: a hosted code-embedding API~~ | Dropped: every arm runs locally ([ruling 9.22](../decisions.md#area-9-benchmark-m4-17-october-2026)) |
| Fusion | **D-alone**: the best dense arm, unfused | The control for every fusion |
| | **H1**: L + best dense, RRF k=60 | Untuned equal-weight fusion lost to dense alone on the smoke set. Also run a dev-tuned weighted variant. |
| | **H2**: G + best dense, RRF | |
| | **H3**: G + L + best dense, RRF | |
| Rerank | **R**: Qwen3-Reranker-0.6B over the top 50 of the best dev arm | Needs a download. LLM reranking belongs to the agentic stage. |
| Reference | **S-ref**: Graph `neighbors`, depth 1, from the changed symbols | Not a candidate |

**Index topology** ([3.8](../decisions.md)):

| Option | Trade-off |
| --- | --- |
| One index, global top-k | Simplest. In `neuve_effect`, 919 of 1,269 Markdown files at `20c58be3` are `docs/handover`, so docs could swamp code. |
| Separate per kind, merged by RRF | No calibration, but rests on the same fusion that underperformed |
| Separate per kind with a fixed token quota per kind (tuned on dev) | Guarantees every kind appears and avoids rank fusion |

Every dense arm runs all three topologies. Because RRF underperformed once, I do not presume a default. **Recommendation:** choose per-kind RRF or per-kind quotas on dev, with one index as the control.

**Held fixed across arms:**

- the base snapshot;
- one chunker for every non-Graph arm: symbol chunks for code, heading sections for docs, and the `utf8-line-window-4k-v1` line-window recipe ([source-index.ts](../../packages/semantic-client/src/source-index.ts), line 20) as the fallback;
- the query text;
- the candidate pool given to rerankers;
- the token budget;
- the gold and the hardware class.

Each model keeps its documented prefixes ([worker](../../packages/semantic-client/src/worker.py), line 53).

## 5. Metrics

**Decision needed:** the primary metric, the guard metric, the overlap rule and the decision rule.

**Overlap rule**, which decides when a returned region counts as finding a gold region:

| Option | Rule | Trade-off |
| --- | --- | --- |
| Any line | Credit if the regions share at least one line | Lenient: a 1-line touch of a 300-line contract counts as found |
| Minimum share | Credit if at least 50% of the gold region's lines are covered | A threshold to argue over; all-or-nothing |
| **Fractional coverage** | Credit equals the share of the gold region's lines covered within the budget, summed per item and capped at 1 | No threshold; partial retrieval earns partial credit |

**Recommendation:** fractional coverage, with any-line and 50% as sensitivity reports.

**Metrics:**

| Metric | Definition |
| --- | --- |
| NR@B | Necessary recall (fractional coverage) within B tokens of returned context per hunk. B follows the allowance curve and each hunk's real share, never below 4,000 tokens ([rulings 9.14, 9.17 and 9.23](../decisions.md#area-9-benchmark-m4-17-october-2026)) |
| Recall@k | k = 5, 10, 20, 50; necessary and useful separately |
| nDCG@10 | Graded 2/1/0, condensed over judged items |
| MRR | Rank of the first necessary item |
| Per-kind coverage | NR@B per source kind |
| Wrong-attribution share at B | Judged-irrelevant share within B, tracked distinctly ([reviewer's tax](../../foundations/05-reviewers-tax.md), line 17) |
| Judged@k | Pooling-bias check |
| Cost | Build time and size, incremental update time, query latency p50 and p95 (cold and warm), returned tokens, memory |
| Final-stage attribution (after M3) | Missing and wrong attribution of the markers actually attached |

**Primary metric options:**

| Option | For | Against |
| --- | --- | --- |
| **A. NR@B, averaged per family** | Matches what the agentic stage reads; fair across chunk sizes; about missing attribution | Non-standard; budget level is a choice |
| B. nDCG@10 | Standard | Blends necessary and useful; unfair across chunk sizes |
| C. Recall@10, necessary only | Standard and simple | Same chunk-size unfairness |

The fixed 4k budget and the 2k, 4k and 8k levels were replaced: necessary recall is read across a curve of allowances and at each hunk's real share, with a 4,000-token floor ([rulings 9.14, 9.17 and 9.23](../decisions.md#area-9-benchmark-m4-17-october-2026)).

**Recommendation:** A as primary.

Guard: in every comparison, the non-default arm's wrong-attribution share, read at the real share, must not exceed the default arm's by more than 5 points. The default arm is defined under the decision rule below. This applies equally to comparisons with no dense arm, such as G-fork against G-base. Always report B and C.

**Statistics:**

- **Resampling unit.** Paired bootstrap over **families**, with ranges nested inside them: 10,000 resamples, plus a paired permutation test as a cross-check.
- **Multiple comparisons.** I switch from Holm to a simple **Bonferroni adjustment**. Five pre-registered comparisons at a family-wise 5% means each decision uses the lower bound of a **99% interval** (two-sided α = 0.01). Holm would need a different interval level at each step, which is harder to state and audit. Bonferroni is slightly more conservative.
- **Effective sample size.** It is the number of held-out families, which I expect to be about 12–20, not 40 ranges. Assuming a per-family SD of 0.2 on the paired necessary-recall delta (unverified; re-estimated on dev), here is the true effect an arm needs for an 80% chance of adoption under the rule below (lower bound above +3 points):

  | Held-out families | Unadjusted (95% lower bound > +0.03) | Bonferroni (99% lower bound > +0.03) |
  | --- | --- | --- |
  | 12 | ≈0.19 | ≈0.23 |
  | 20 | ≈0.16 | ≈0.18 |

  These use a normal approximation; with so few families a t-distribution raises them further. **Differences smaller than about 15–23 points will usually be inconclusive.**

- **Selection.** The best dense, best hybrid and best topology are chosen on dev only. Held-out tests only these five pre-registered comparisons:
  1. E1 against E0;
  2. best dense against L;
  3. best fusion against D-alone;
  4. chosen topology against one index;
  5. G-fork against G-base, on the untagged subset.
- **One decision rule for every comparison, including the fork reset.** Each comparison names a **default arm**: the cheaper or simpler one, which means less code to own, less compute and no adapter. The default wins unless the other arm's Bonferroni-adjusted (99%) lower bound on the necessary-recall delta at the real share ([9.21](../decisions.md#area-9-benchmark-m4-17-october-2026)) exceeds +3 points and the guard holds. Inconclusive data therefore always gives the same answer, the default.

  | Comparison | Default arm |
  | --- | --- |
  | E1 vs E0 | E0 |
  | Dense vs L | L |
  | Fusion vs D-alone | D-alone |
  | Per-kind vs one index | One index |
  | G-fork vs G-base | G-base (the Entire baseline, less code to maintain), so inconclusive means reset |

**Recommendation:** adopt this single rule before held-out is opened. With the minimum detectable effects above, expect most comparisons to return the default.

## 6. Protocol

### Query formulation

| Option | Query | Trade-off |
| --- | --- | --- |
| **Q1, hunk-derived** | Path, enclosing symbol and post-image hunk with 3 context lines; deletions use the pre-image | Deterministic; what stage 1 receives |
| Q2, scope-derived | The plan or ticket at the base, or an in-range scope source per the [leakage rules](#leakage-rules) | Scope stage only; absent for ad hoc ranges |
| Q3, agent-written | Up to 3 queries per hunk, generated once, frozen and hashed | Closer to agentic use. Generated by the same model family as one labeller, which is another reason for B′. |

**Recommendation:** Q1 primary, Q3 frozen secondary, Q2 in the scope stage only.

### Index basis

| Option | Correctness | Cost |
| --- | --- | --- |
| A. Full index rebuilt at every base | Exact | About 45–60 snapshots × ~10k chunks per model. Estimated ~35 min per snapshot per 0.6B model on MPS (unverified). |
| **B. Exact base view from a blob-addressed chunk cache** | Exact | Each unique chunk encoded once per model, roughly 2–3 snapshots in total (assumption). This applies [5.4](../decisions.md) and [3.9](../decisions.md). |
| C. One index at the latest snapshot | Leaks future code | Cheapest |

**Recommendation: B.** Measure incremental update cost per range, and check equality against full rebuilds on 5 cases by content hash. Graph arms read prepared generations by exact commit; preparation time is recorded.

### Determinism and reproducibility

- Use exact cosine search with ties broken by chunk ID, and pinned model revisions and weight hashes ([worker](../../packages/semantic-client/src/worker.py), lines 19–20).
- Use fp32 on CPU where speed allows; otherwise record bf16 tolerances.
- Graph output has been byte-identical across reruns (external suite, kept in the private archive).
- The manifest records, for each case: repository, base, head, hunk IDs, family, split, strata and the tuned-file tag. Gold records each labeller.
- Held-out runs once per frozen configuration, and the configuration hash goes into the results.

### Run budget (estimates, unverified)

| Item | Budget |
| --- | --- |
| Embedding, 0.6B-class arms (E0, E1, E2) | ~1.5–2 h each |
| Embedding, E3 at about 4B | ~10 h locally ([9.22](../decisions.md): compute stays on this machine) |
| Labelling | 25–70M input tokens, plus 6–8 owner hours |
| Graph preparation | Unknown; recorded |

### Privacy and hosted services

"Local only" is my earlier preference, not a recorded decision. In practice:

- The Opus labeller and M3 ([2.12](../decisions.md)) already send repository code to the Anthropic API.
- Modal was used for phase 3 training. As far as the cloud record (kept privately) shows, it received only the public Entire Graph data and synthetic inputs, never private code.
- **The other-family labeller in B′ is a new data recipient.**
  - Sol 6.1 through Codex and ACP is not yet available: 2.12 waits for a released Codex that accepts it and a true read-only mode.
  - Concrete route: an OpenAI model through the Codex CLI that is available today, on a disposable read-only copy of each base checkout, because Codex lacks a true read-only mode. That route sends code to OpenAI.
  - Fallback with no new recipient: a local open-weights model as the second labeller. It costs labelling quality, and the owner-sampling estimate of missed necessary items becomes more important.

| Option | Effect |
| --- | --- |
| A. Local models only | No new recipient; E4 not run; second labeller is local |
| B. Allow hosted services for the benchmark only: a hosted embedding API (E4) and an OpenAI labeller via Codex | Measures whether paid hosted quality beats local; adds two recipients |
| C. Allow hosted services for benchmark and product | Widest choice; a standing privacy policy |

**Ruled.** [Ruling 9.2](../decisions.md#area-9-benchmark-m4-17-october-2026) allowed hosted services for the benchmark only; [9.22](../decisions.md#area-9-benchmark-m4-17-october-2026) then dropped the hosted embedding arm (E4), so only the second labeller is hosted ([9.15](../decisions.md#area-9-benchmark-m4-17-october-2026)).

### Where results live

The computation store and Records rebuild are M2 and have not started ([plan](../plan.md), line 17).

| Option | Notes |
| --- | --- |
| **A. A gitignored content-addressed cache now, keyed by `sha256(model, revision, recipe, chunk bytes)`, plus a committed manifest, gold, frozen queries and results** | Shaped for import into the M2 computation store ([5.3](../decisions.md)). A Records event follows once Records exists. |
| B. Wait for M2 | Blocks M4 |
| C. Use the current Records semantic path | Spawns a process per query and adds a custody layer the benchmark does not need |

**Recommendation: A.**

## 7. Implementation shape

- **Location.** `packages/evaluation/src/retrieval-bench/`, in TypeScript on Bun: cases, chunk, index (per kind, blob-addressed), arms (Graph, BM25, dense, fusion, rerank), score (fractional coverage, NR@B, nDCG, MRR and the family bootstrap), and a run command. About 1,000 lines (estimate). Case data lives in `validation/benchmarks/m4/` (kept in the private archive), ignored by the indexers.
- **Encoder.** One long-lived Python process per run, generalised from [`worker.py`](../../packages/semantic-client/src/worker.py). It needs a model registry (ID, revision, weights hash, prefixes, pooling), optional PEFT adapter loading, and batch encoding.
- **Reuse:**
  - [`packages/graph-client`](../../packages/graph-client/src/index.ts) exact-commit reads (lines 842–877);
  - the gold shape in [context metrics](../../packages/evaluation/src/review-quality/context-metrics.ts);
  - the BM25 and RRF formulas, rewritten in about 40 lines rather than imported from [`embedding-rd/retrieval.ts`](../../research/pr-bench/embedding-rd/retrieval.ts), which mixes them with custody schemas.
- **Preserve evidence.** The `.scratchpad` stays ([5.10](../decisions.md)). Copy the selected adapters (`f7039598`, plus any others the owner wants) and the result files cited here into a tracked or archived location, verified by SHA-256, before M4 depends on them.
- **Prune later, by owner call** ([7.11](../decisions.md)):
  - `research/pr-bench/embedding-rd/` and `research/embedding-pipeline/` (kept in the private archive) once the report supersedes them;
  - the optional `known_lexical_baseline` field ([foundation 09](../../foundations/09-structural-engine.md), line 43);
  - the Records and CLI `semantic-*` path, which is replaced rather than patched when the chosen strategy is built.

## 8. Decision list for the owner

| # | Decision | Recommendation |
| --- | --- | --- |
| 1 | What the benchmark answers | Choose the semantic-layer strategy (3.3). Build and score the pass 1 ladder: stage 1 and the scope stage now, the agentic stage on the same cases after M3. Pass 2 in M6 reuses the cases. |
| 2 | Corpora | `neuve_effect` primary and this repo secondary (bases at or before `3ea3659b`). Add `chrome-devtools-mcp` only if held-out has fewer than 15 families. |
| 3 | Size and split | At most 4 ranges per family, about 30–35 `neuve_effect` ranges (only about 20 from whole PR merges, the rest from intra-PR slices or the `chrome-devtools-mcp` fallback) plus about 15 Neuve ranges, at most 4 labelled hunks each. Family-grouped split: one third dev, two thirds held-out. Best arms selected on dev only; held-out run once per frozen configuration. |
| 4 | Leakage | The HCP family (E1–E3 and the external-suite ranges) is dev only. Hunks touching Graph-tuned files are tagged, and the fork comparison uses untagged hunks. Neuve ranges touching phase 2 training scripts are dev only. Each case indexes its exact base without hindsight docs; benchmark files are excluded from every index. Test-kind results are reported as low-power. In-range plans and tickets may be read by the scope stage (1.8); in-range hindsight documents are read only by the labellers; neither is indexed or scored. |
| 5 | Which "tuned model" | The phase 3 "broader" adapter (`f7039598`) as E1, knowing the prior evidence shows no reliable gain. No new fine-tuning in M4. |
| 6 | Ground truth | B′: one Opus 5.5 labeller and one from another family over pooled candidates, history and review citations as generators. The owner adjudicates held-out necessary labels, 20% of useful labels, disagreements and a 10% sample of items both marked irrelevant: about 6–8 h. Score the agentic stage only against non-Opus or owner-confirmed labels. |
| 7 | Relevance scale | Three levels; unjudged never counted as irrelevant |
| 8 | Arms | G-fork, G-base, BM25, E0, E1, Qwen3-Embedding-0.6B, Qwen3-Embedding-4B as the larger open model (9.2), no hosted model ([9.22](../decisions.md#area-9-benchmark-m4-17-october-2026)), best dense alone, three hybrids (equal and dev-tuned RRF) and the reranker. Graph `neighbors` as a reference. |
| 9 | Hosted services and privacy | Allow hosted services for the benchmark only: an OpenAI labeller (the hosted embedding arm was dropped by [9.22](../decisions.md#area-9-benchmark-m4-17-october-2026)) via the Codex CLI on read-only copies (Sol over ACP is not yet available, per 2.12). Fallback: a local open-weights second labeller. Decide product use separately. |
| 10 | Index topology | Pick per-kind RRF or per-kind quotas on dev; one index as the control and default arm |
| 11 | Overlap rule | Fractional line coverage; any-line and 50% as sensitivity |
| 12 | Primary metric and guard | NR@B averaged per family, with B set by [9.14, 9.17 and 9.23](../decisions.md#area-9-benchmark-m4-17-october-2026); guard on wrong-attribution share; always report recall@k, nDCG@10, MRR, per-kind coverage, judged@k and cost |
| 13 | Decision rule, including the fork reset | Paired family bootstrap over five pre-registered comparisons with a Bonferroni-adjusted (99%) lower bound. The default (cheaper or simpler) arm wins unless the other's lower bound exceeds +3 points and the wrong-attribution guard holds. For the fork, G-base is the default, so inconclusive means reset. Expect to need true effects of about 18–23 points to adopt the non-default arm. |
| 14 | Query formulation | Hunk-derived primary; frozen agent-written secondary; scope-derived in the scope stage only |
| 15 | Index basis | Exact base view from a blob-addressed cache; incremental cost measured and checked against full rebuilds |
| 16 | Result storage | Gitignored content-addressed cache shaped for M2, plus committed manifest, gold, queries and results; a Records event once Records exists |
| 17 | Implementation, evidence and pruning | `packages/evaluation/src/retrieval-bench/` with one long-lived encoder process. Copy the adapters and cited results out of `.scratchpad` (kept per 5.10). Prune the research folders and the `semantic-*` path only by owner call after the report. |
| 18 | Compute for the larger model | Ruled by [9.22](../decisions.md): every arm runs locally, downloaded, run and deleted in turn |

Unverified assumptions:

- `neuve_effect` is private.
- Chunk counts and encode times.
- The availability and licences of the E3 candidates.
- Graph preparation time and Markdown coverage. If Graph `query` returns no doc regions, Graph arms score zero on doc kinds by construction, and the report says so.
- The per-family SD behind the minimum detectable effects.
- Labelling minutes and tokens per hunk.
- The eligible-range count, which depends on the code-file filter.
