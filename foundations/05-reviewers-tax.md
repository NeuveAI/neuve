# Reviewer's tax

Status: guiding principle and primary measures established by the user. Exact measurement methods remain open.

## Established principle

Neuve serves human and agentic reviewers. Both incur a reviewer's tax when gathering, reconstructing, and repeatedly processing the information needed to decide. Reducing that burden guides product and engineering decisions.

Reuse completed work and assembled evidence and context unless invalidated. A new commit or review unit does not require recomputing still-valid material or re-establishing its validity from scratch. The user reiterated this on 2026-09-24 as the existing no-repetition principle, not a new default requiring another decision.

Every review cycle builds on evidence from previous cycles. Repetition is a negative term here: it refers to unnecessarily revisiting resolved units and their context. Reusing supporting context for a new unit is acceptable, including overlap between cycles, much as overlapping retrieval chunks can preserve understanding. Review units should surface what is needed, supported by material proof and surrounding context that facilitate disposition of the decision signal. A generated briefing must retain connected sources for attribution and drilldown.

This principle does not equate less visible information with better review. The [product purpose](01-product-purpose.md) requires demonstrated correctness and quality alongside cost and throughput benefits. The [reclustering rules](04-review-units-and-context.md#recluster-for-each-new-cycle) avoid demanding repeated decisions on unaffected approved work.

## Dimensions

Unnecessary repetition and wrong or missing attribution are established dimensions of reviewer's tax. Attribution quality is also a primary quality metric for the system as a whole, not only the review interface or an individual reviewer. Track wrong attribution and missing attribution distinctly so improvements do not hide one failure by increasing the other.

The table includes these established dimensions and further explanatory examples of review burden. The additional examples do not establish new KPIs.

| Burden | Human example | Agentic example |
| --- | --- | --- |
| Wrong attribution | Assessing a unit using a fragment incorrectly connected to its hunks. | Reasoning or classifying from an unsupported hunk-marker connection. |
| Missing attribution | Reconstructing relevant context that Neuve failed to connect to the unit. | Reviewing or classifying without a material hunk-marker relationship. |
| Repetition | Reassessing a resolved unit without a new reason for a decision. | Repeating a resolved investigation without a new reason. Reusing its evidence for new units is acceptable. |
| Finding and reconstructing context | Searching tickets and Git history to recover intent. | Repeated retrieval and tool calls to reconstruct the same relationships. |
| Establishing evidence quality | Checking whether a passing result covers the changed behavior. | Discovering that supplied evidence belongs to another revision or tests the wrong outcome. |
| Separating decisions from context | Working out which displayed hunks actually require a disposition. | Mistaking a neighboring hunk or historical note for a new review obligation. |
| Coordination and rework | Following repeated comments across review cycles. | Repeating work after incomplete handoffs or contradictory review instructions. |

A changed dependency can undermine an earlier approval even if the approved code is unchanged. That creates a new reason for attention. Prior evidence and relevant code or document segments still contribute through contextual signals and the surrounding scope. Overlap alone does not indicate wasted review effort.

## Signal without noise

Established by the user on 28 October 2026 as a core product value that always holds: raise what good review raises, without adding noise. Noise is part of the reviewer's tax.

What good review raises is not left to an imagined strong reviewer. It is set by a review standard drawn from peer-reviewed studies of code review and from large organisations' published review practice, with the dataset's human reviews as a baseline. In priority order, the standard asks for wrong behaviour the change introduces, then a design that doesn't fit, then missing or misleading tests, then code that is harder to understand or change than it needs to be, then conventions and documentation that no tool enforces. A nit-pick may be correct but changes none of these.

Noise depends on the reader as well as the find. A correct, worthwhile point still costs a reader who did not need it, so where and how a find is delivered decides whether it reads as signal or noise. Valid finds that no human needs to see belong with the agent reader, or earlier in the inner loop while the code is written, not on the human desk.

Three working rules follow:

- Quality over quantity. A raised point is correct, cites its source and is attributed to the right lines, judged by a well-tuned rubric.
- Avoid nit-picks.
- Review for two readers. Agents read through the command line and the harness's tools; humans need a review interface shaped for a person. Each is served and measured in its own form.

Human reviews on the benchmark dataset are a baseline, not the gold standard: a find no person raised can still be valid, and such finds are judged on their merits.

## Established measurement priorities

Unnecessary repetition and wrong or missing attribution are the primary measures of reviewer's tax for humans and agents. Track them to improve evaluations and the graph. Acceptable context overlap across units and cycles must not be counted as waste merely because the material appeared before.

Quality and total input/output token cost are the KPIs. Include the cost of retrieving, generating, updating, and checking briefings. Timestamps support understanding average timing for a repository and checkout; estimated time saved is not a KPI. The [history and metrics foundation](03-unit-history-and-metrics.md) records the measurement commitments.

## Supported uncertainty

The user accepts supported uncertainty as information Neuve can represent. A demonstrated outcome change is not the only useful signal. Evidence must support the concern; the concern must not be presented as a proven defect.

The separate generated briefing is advisory for now. It raises awareness of possible side effects or architectural changes without being directly connected to a review unit. It does not require approval or block completion. The user calls this an isolated briefing and also accepts it for shared context and verification across separate review units. How a concern later becomes a review-unit decision signal remains open.

For example, several individually reviewed changes may together suggest an architectural consequence that no single unit captures. A briefing could expose the supporting code and document segments, the suspected consequence, and the remaining uncertainty. This is an illustrative proposal, not an agreed evidence format.

## Next discussion

Next specify escalation rules for review-unit decision signals, including supported uncertainty. Keep these distinct from the separate advisory briefing. How an advisory concern becomes a review-unit decision signal remains open.

The broader burden examples above remain explanatory proposals; they do not add KPIs beyond the established priorities. In particular, overlapping context should not count as waste merely because it has appeared before. The cost of retrieving and generating it still belongs in total usage.
