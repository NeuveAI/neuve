# Contextual markers: definition for discussion

Status: the original definition below is superseded by the user clarification. Research observations remain supporting material. Two focused research agents examined Entire Graph and primary sources on evidence, severity, and history attribution. This is a conceptual investigation, not a routing evaluation.

## User-established definition

A contextual marker is a retrieved piece of semantic context that corroborates an attribution to a particular hunk. It is smaller than a ticket, Git history entry, dependency graph, or documentation entry and remains traceable to that source through retrieval.

This corrects the original proposal: the marker is the supporting semantic fragment, not the resulting observation or assessment about the work. The [product vocabulary](../vocabulary.md) records the accepted meaning. Exact fragment boundaries, graph representation, and scoring remain open.

## Superseded proposed definition

A contextual marker is an attributable observation or supported assessment about a hunk or its surrounding context that informs review responsibility, investigation, or task decomposition. It can describe a concern, a mitigating condition, or uncertainty. Its significance and certainty can change as discovery adds evidence.

A marker is not itself a defect, lane assignment, or demand for a new decision. The definition includes both direct observations and derived assessments; this inclusion needs user agreement.

## Earlier proposed relationship, requiring revision

The [accepted vocabulary](../vocabulary.md) defines contextual signals as information that aids understanding and decision signals as indications that work needs a disposition. Proposed distinction: a marker characterizes the work for assessment. It can inform either kind of signal without automatically becoming a decision obligation. These are related roles, not necessarily separate stored objects.

Example: a bug ticket mentioning the changed component is source material. “This component is implicated in a reported bug” is a supported marker. “This hunk caused the bug” is a stronger assessment that needs additional evidence. Relevant history can help a reviewer understand a new unit without reopening a resolved one.

## Research grounding

- Entire Graph's relation record and evidence pointers (`internal/sem/provider.go:384` in `entireio/entire-graph`) separate relation type, extraction reason, confidence, warnings, and source locations. Its impact command (`docs/commands.md:32` in `entireio/entire-graph`) finds connected code, including callers and co-change information. Inference: graph connections can support markers; caller count alone does not establish an adverse outcome.
- [CodeQL query metadata](https://codeql.github.com/docs/writing-codeql-queries/metadata-for-codeql-queries/) separates precision from severity. Precision concerns true-positive frequency for a query, not a calibrated probability for an individual Neuve marker. Inference: how consequential a condition is should remain distinguishable from how well it is supported.
- The 2026 preprint [How and Why Agents Can Identify Bug-Introducing Commits](https://arxiv.org/html/2603.29378v1) studies agentic history investigation and discusses attribution failures, including cross-file causes and reference-label problems. It supports studying revisable historical assessments, not assuming that a fix touching a hunk proves that hunk introduced the bug. Its results do not validate review-lane routing.
- [W3C provenance](https://www.w3.org/TR/prov-overview/) describes entities, activities, agents, and derivations. Inference: retaining sources and how an assessment was derived makes it inspectable; attribution alone does not establish truth.

## Earlier proposed boundaries, requiring revision

Markers may reduce concern as well as raise it. “Direct verification covers the historical failure under these conditions” supplies scoped support. “No bugs found” does not establish equivalent coverage.

A marker needs an identifiable subject, an observation or assessment, supporting sources, and limits on what those sources establish. This is a proposed explanation requirement, not a selected schema. Weight, score, and certainty remain distinct design questions; no numeric formula is proposed.

Shared evidence should not be mistaken for independent corroboration. Incomplete discovery should not be mistaken for proof that a relationship is absent. These are proposed safeguards for later algorithms.

## Feasibility critique of hunk markers and unit assessment

The user clarified that Git history, documentation, and tickets are source pillars; markers are linked per hunk, while risk, complexity, and classification apply to the whole review unit. Two further focused research agents assessed feasibility. The conclusions below are recommendations for discussion, not accepted architecture.

The direction is feasible as evidence-assisted assessment. It cannot promise exhaustive context or automatically calibrated routing certainty.

| Concern | Critique and practical implication |
| --- | --- |
| Attribution noise | Retrieval relevance does not prove applicability to a hunk. Retain the exact fragment, source version, necessary qualifications, and the reason for the connection. Evaluate retrieval and attribution separately. |
| Source versus assessed property | Git, docs, and tickets identify origins. Security, historical risk, and complexity describe interpretations. Keep these distinctions even if an eventual algorithm combines them. |
| Graph impact | Reachable callers are potential exposure, not demonstrated behavioral impact. Missing edges and runtime wiring limit coverage. Make the known scope and gaps inspectable. |
| Complexity | Size, connectivity, architectural role, and behavioral difficulty can contribute, but are not interchangeable. A widely used formatting helper can be simple; a tiny authorization check can be consequential. Keep contributions distinguishable. |
| Security enrichment | Post-retrieval interpretation is plausible, but graphs can already carry security-relevant facts. Enrichment may need to request additional code analysis rather than interpret only the first retrieved fragments. |
| Whole-unit assessment | Preserve which hunk-marker relationships support a conclusion. Deduplicate shared evidence. Neither averaging away a consequential hunk nor counting copies as independent corroboration is sound. This does not prescribe a maximum-risk gate. |
| Clustering order | Responsibility-aware grouping and unit-level classification depend on one another. Subsequent user decision permits contextual assessment to split or recompute candidate clusters before assigning responsibility. The processing mechanism remains open. |

[Anthropic's contextual-retrieval experiments](https://www.anthropic.com/engineering/contextual-retrieval) support preserving fragment context and filtering retrieval with reranking. Their retrieval results do not demonstrate correct hunk attribution or lane assignment.

The [AgentSZZ preprint](https://arxiv.org/html/2604.02665v1) studies agentic bug-origin attribution and reports confidently wrong historical selections. This supports distinguishing confidence reports from established calibration; historical association does not by itself prove causality. Its task and datasets do not validate Neuve's review policy.

Entire Graph's documented analysis limits (`README.md:253` in `entireio/entire-graph`) qualify dependency counts and describe missed dynamic relationships. [CodeQL's data-flow analysis](https://codeql.github.com/docs/writing-codeql-queries/about-data-flow-analysis/) shows that graph facts can support security analysis while also explaining unavailable-source, runtime, and computational limits.

A useful first evaluation would use adjudicated changes with correct and incorrect marker attachments, stale context, duplicated evidence, cross-hunk effects, and missing dependencies. Measure incorrect attribution, missed material context, resulting classification errors, reviewer effort, and total token cost. Compare against simpler retrieval before attributing benefit to graph enrichment. No such evaluation has been run here.
