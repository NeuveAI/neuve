# Entire and code context as a possible retained foundation

Research date: 2026-09-17. Status: historical research. The later [structural-engine foundation](../foundations/09-structural-engine.md) records the accepted decision to use a Neuve-owned Entire Graph fork as the engine starting point while keeping Neuve's mandatory boundary language-neutral.

The useful separation is between captured development history, a derived description of code, and evidence that a product obligation has been satisfied. Entire supplies much of the first and Entire Graph supplies part of the second. Neither, by itself, supplies the third. This is the researcher's interpretation of their contracts, not a limitation claimed by their authors.

## Sources and verification boundary

Two clean local checkouts were inspected read-only. These are the primary sources for implementation claims below.

| Artifact | Pinned revision | Location |
| --- | --- | --- |
| Entire Graph | `5637039f7da7c8f35726eec22c230491a3f90b9f` | a local clone of `entireio/entire-graph` |
| Entire CLI | `5c277cf9509a9352de132c7dd10d77220af06226` | a local clone of `entireio/cli` |

I read repository instructions, contracts, and focused implementation sections. I did not install, build, execute the analyzers, or run their tests. Source inspection supports the behavior descriptions; it does not prove these binaries work on Neuve's repository. All local line citations below refer to these revisions. Web references were accessed on the research date and may subsequently change.

## What Entire captures

Entire distinguishes a session from its checkpoints. Ephemeral checkpoints retain code and metadata during work. Persistent checkpoints retain metadata and a reference to committed code. Active session state is separate from permanent checkpoint storage. The current CLI has both branch-based and ref-based persistent backends; assuming that every checkpoint is only a directory on `entire/checkpoints/v1` would miss the newer backend. [Pinned domain model](https://github.com/entireio/cli/blob/5c277cf9509a9352de132c7dd10d77220af06226/docs/architecture/sessions-and-checkpoints.md#L39)

Git hooks attach an `Entire-Checkpoint` trailer and condense session material when a user commits. Agent lifecycle hooks provide the conversation and tool activity. This connects an observed development session to Git history. The connection does not certify that the reasoning was correct, that tests passed, or that the session explains every line in the commit. The trailer can be removed. Checkpoint data can arrive or be backfilled after initial creation. A consumer that needs an immutable evidence record would therefore need to specify exactly which checkpoint content version it read. [Pinned linking description](https://github.com/entireio/cli/blob/5c277cf9509a9352de132c7dd10d77220af06226/docs/architecture/sessions-and-checkpoints.md#L656)

There is material version skew in the supplied references. Graph's `AGENTS.md` says commits in another worktree are not linked without explicit session adoption. The inspected CLI now unions sessions matched by worktree with a session matched through the committing process's ancestry. A session can be guest-linked without moving its worktree-coupled state. Ambiguous fallback cases still decline to guess, and platforms without process identity support fall back to worktree matching. We must pin and verify the actual installed CLI before turning either description into a Neuve assumption. [Graph warning](https://github.com/entireio/entire-graph/blob/5637039f7da7c8f35726eec22c230491a3f90b9f/AGENTS.md#L216), [CLI implementation](https://github.com/entireio/cli/blob/5c277cf9509a9352de132c7dd10d77220af06226/cmd/entire/cli/strategy/session_identity.go#L14)

Concurrent sessions can contribute to a shared working tree and its checkpoint history. A commit-to-session association is consequently not exclusive authorship. Neuve would still need its own meaning for implementer, reviewer, author, witness, and approving human.

## What the graph actually describes

The graph is a local tree-sitter-based provider of file, symbol, external endpoint, and relation records. Interactive retrieval combines lexical matching with graph expansion, then bounds the returned context. It is useful for finding candidate code and explaining known relationships. A ranked query result is intentionally a selected view, not an exhaustive inventory. [Search contract](https://github.com/entireio/entire-graph/blob/5637039f7da7c8f35726eec22c230491a3f90b9f/docs/search.md#L14)

Its native records retain source locations, extraction reasons, resolution categories, warning codes, and optional relation evidence. That makes an assertion inspectable. Evidence here means a source location supporting a structural relation; it does not mean an executed behavioral check. [Record definitions, lines 230–414](https://github.com/entireio/entire-graph/blob/5637039f7da7c8f35726eec22c230491a3f90b9f/internal/sem/provider.go#L230)

### Identity and revision binding

The symbol ID is a colon-joined tuple of repository namespace, language, path, kind, and qualified name. It deliberately omits commit and body hash, so ordinary body edits can retain identity. Moving or renaming code changes tuple fields and can change identity. Symbol identity cannot serve as proof that the reviewed code is unchanged. The fields are not escaped, so consumers must not recover a path by splitting the ID on colons. [Implementation, line 28455](https://github.com/entireio/entire-graph/blob/5637039f7da7c8f35726eec22c230491a3f90b9f/internal/sem/provider.go#L28455)

`repo_key` is a namespace, not a globally unique repository identity. Supported GitHub remotes yield `gh/owner/name`; otherwise the fallback is `local/basename`. Two unrelated directories called `tools` can collide. The snapshot contract explicitly requires consumers to add their own repository identity or additional binding information. [Identity contract](https://github.com/entireio/entire-graph/blob/5637039f7da7c8f35726eec22c230491a3f90b9f/docs/snapshot-format.md#L58)

The header carries repository root, namespace, provider version, commit, tree, profile, and limits. A committed snapshot reads content from the resolved revision. A working-tree snapshot still records the resolved HEAD commit and tree but reads working files and emits `W_WORKTREE_SNAPSHOT`. If HEAD is unavailable, it can fall back to working files with `E_NO_GIT_HEAD`. Therefore the presence of a commit hash alone does not prove that the records describe that commit. Consumers must retain the requested view and final warnings. Source inspection did not establish an atomic, repository-wide freeze of live working files; concurrent editing remains a verification question. [Source selection, lines 1799–1880](https://github.com/entireio/entire-graph/blob/5637039f7da7c8f35726eec22c230491a3f90b9f/internal/sem/provider.go#L1799)

### Precomputation is not continuous incremental indexing

Interactive `query`, `def`, `explain`, `neighbors`, and `impact` default to working-tree content. Bulk streams default to committed content. Working-tree snapshots bypass persistent graph caches and rebuild even if the checkout appears clean. The cache pipeline explicitly enforces this. [Implementation, lines 85–90 and 220–242](https://github.com/entireio/entire-graph/blob/5637039f7da7c8f35726eec22c230491a3f90b9f/internal/sem/search_cache.go#L85)

Committed cache entries bind graph-shaping inputs such as tree, profile, provider, repository, limits, and inclusion rules. Search can reuse a same-tree snapshot and restamp commit metadata. Opaque bulk output additionally binds the exact commit. The inspected pipeline supports cache reuse, selected views derived from complete snapshots, and rebuilding. I found no basis to claim a continuously maintained per-edit graph or incremental dependency invalidation across changed revisions. Tree-sitter's incremental parsing capability is not proof that this application uses that capability for durable incremental indexing. [Cache contract](https://github.com/entireio/entire-graph/blob/5637039f7da7c8f35726eec22c230491a3f90b9f/docs/operations.md#L79)

`index` prewarms one committed cache variant. Its default full profile does not warm a default fast query, and it never warms the default working-tree query path. This matters when estimating whether precomputation will shorten an in-the-loop review.

### Confidence, completeness, and absence

Confidence values are implementation heuristics. For example, a same-package call receives `0.80`, a globally unique name match `0.68`, and an ambiguous PHP candidate `0.55` in the inspected resolver. These are not demonstrated probabilities that the relation is correct. They cannot be used directly as a probability that a change is safe. [Resolver, lines 3945–4040](https://github.com/entireio/entire-graph/blob/5637039f7da7c8f35726eec22c230491a3f90b9f/internal/sem/provider.go#L3945)

Coverage depends on language, profile, ignored files, file limits, parse failures, and extraction support. The documented inventory recognizes 185 language/filetype names but only 36 have semantic extraction paths. Inventory-only recognition does not establish call or type analysis. Even semantic coverage is not compiler equivalence. [Language matrix](https://github.com/entireio/entire-graph/blob/5637039f7da7c8f35726eec22c230491a3f90b9f/docs/language-support.md#L1)

The streaming header is intentionally incomplete. The trailing summary is authoritative for aggregate failures and completeness. A consumer that accepts an interrupted stream after its header can mistake unfinished extraction for a successful empty or clean graph. Profile metadata remains in the header. [Stream contract](https://github.com/entireio/entire-graph/blob/5637039f7da7c8f35726eec22c230491a3f90b9f/docs/snapshot-format.md#L31)

Health is a diagnostic policy, not semantic recall. Its default degradation threshold is 5% flagged source files, with additional guards. Intentional oversized/minified skips are reported separately, ignored files lie outside scope, and a query-selected scope can be smaller than the repository. An `ok` result does not mean every affected dependency was found. [Health policy](https://github.com/entireio/entire-graph/blob/5637039f7da7c8f35726eec22c230491a3f90b9f/docs/operations.md#L210)

The graph's checkpoint command searches reachable Git history for one matching trailer, then analyzes the associated commit against its first parent. It is not a complete traversal of checkpoint session history, every commit sharing an ID, or all merge parents. [Lookup implementation](https://github.com/entireio/entire-graph/blob/5637039f7da7c8f35726eec22c230491a3f90b9f/internal/gitutil/git.go#L147), [analysis implementation](https://github.com/entireio/entire-graph/blob/5637039f7da7c8f35726eec22c230491a3f90b9f/internal/sem/analyze.go#L1182)

## Other context approaches and what they clarify

These are representative approaches, not a ranked benchmark or proposed stack.

| Approach | What it contributes | Boundary relevant to Neuve |
| --- | --- | --- |
| Tree-sitter | Syntax trees and incremental reparsing of edited text, including tolerance of incomplete syntax. | A parser does not by itself provide type checking, runtime resolution, or behavioral correctness. [Primary documentation](https://tree-sitter.github.io/tree-sitter/) |
| SCIP | A language-neutral protocol for code intelligence such as definitions, references, and implementations, populated by language indexers. | The protocol does not make every producer equally precise. Provenance and producer capabilities still matter. [Protocol repository](https://github.com/scip-code/scip), [schema](https://github.com/scip-code/scip/blob/main/scip.proto) |
| Aider repository map | A dependency graph helps select important definitions within a context budget. | Context selection deliberately omits material. Importance for editing is not an exhaustive impact boundary. [Primary documentation](https://aider.chat/docs/repomap.html) |
| Entire Graph retrieval | Lexical relevance plus structural neighbors and source citations, locally computed. | Retrieval success, relation precision, missed dependencies, and final review quality are different measurements. [Search contract](https://github.com/entireio/entire-graph/blob/5637039f7da7c8f35726eec22c230491a3f90b9f/docs/search.md) |

Graph's experimental SCIP export projects its existing extraction into a navigation format. It does not upgrade heuristic facts to compiler-derived facts. Native NDJSON remains the lossless relation representation; the SCIP export reports omissions separately, including revision provenance in its sidecar note. Losing that note loses information needed to interpret the index. [SCIP export contract](https://github.com/entireio/entire-graph/blob/5637039f7da7c8f35726eec22c230491a3f90b9f/docs/snapshot-format.md#L158)

## Failure cases to carry into first-principles discussion

| Situation | What could go wrong | Question the product must settle |
| --- | --- | --- |
| An agent edits during graph extraction | Records can describe live working content while the header still names HEAD. | What exact state does an in-the-loop review attest to? |
| Code moves without behavior changing | Symbol identity changes while the obligation may remain the same. | Does a review unit follow a symbol, behavior, requirement, change, or combination? |
| A dynamic registration is missed | An impact query omits a real runtime consumer. | What coverage gap prevents automated closure? |
| A relevant file is ignored or unsupported | A clean-looking result covers only a selected scope. | How are exclusions shown in a review unit's evidence? |
| Two agents share a worktree | Session linkage does not establish exclusive responsibility. | What independence is required of antagonistic review? |
| A checkpoint is backfilled | A stable checkpoint ID can expose more material later. | Are decisions bound to an ID, content digest, or captured evidence version? |
| A commit is amended or rebased | Prior checks may no longer apply to the exact reviewed tree or context. | Which changes invalidate each kind of evidence? |
| A low-confidence relation looks authoritative | A heuristic number is interpreted as calibrated assurance. | Which relation kinds can guide exploration versus justify closure? |
| Review finds no issue | Retrieval or extraction could have omitted the relevant path. | What does a negative finding actually certify? |

These are design questions, not accepted requirements.

## What the graph cannot decide for us

A graph can suggest which code relates to a change. It cannot decide what outcome the user needed, which behavior must remain invariant, or why a tradeoff is acceptable. It cannot decide who has authority to accept residual risk. It does not determine whether a human review is suggested or required, or whether a passing test expresses the right requirement.

For the proposed quadrants, its plausible contribution is evidence discovery and scope estimation. Static analysis, agentic review, human-suggested review, and human-required review still need separately specified obligations, completion conditions, escalation rules, and invalidation rules. A call graph is not the review-unit model. A checkpoint is not the acceptance decision. Preserving that distinction would let us retain Entire while rethinking Neuve's architecture freely.

## Measurements still missing

Before relying on this base, a later evaluation could use a small fixed set of Neuve changes with known effects. Measure missed affected paths, incorrect relations, identity continuity through moves, stale-evidence detection, exact revision attribution, language gaps, and context cost. Test both working-tree and committed paths. Include one dynamic-dispatch case, one cross-worktree session, one concurrent edit, one ignored dependency, and one non-code product obligation.

No end-to-end token-saving or review-quality claim is adopted here. The inspected Graph agent guide explicitly disclaims a current end-to-end savings claim, while the web documentation index still advertises a percentage saving. That discrepancy is another reason to preserve source versions and benchmark conditions rather than promote marketing language into ground truth. [Pinned guide](https://github.com/entireio/entire-graph/blob/5637039f7da7c8f35726eec22c230491a3f90b9f/AGENTS.md#L3), [live documentation index](https://docs.entire.io/llms.txt)
