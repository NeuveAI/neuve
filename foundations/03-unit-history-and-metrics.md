# Unit history and metrics

Status: user-established direction, updated 2026-09-24. Correction counting preserves separate attributions. Matching mechanisms, remaining metric formulas, and escalation thresholds remain open.

The [unit primitive](04-review-units-and-context.md) starts with Git hunks and surrounding hunk clusters. Behavioral context helps relate changes; it does not replace those units.

## Attribute revisions before aggregating them

A revision belongs to a review unit and its surrounding context. It also participates in a review cycle. A cycle's cumulative revision metric is an aggregation of those attributed records, not a separate global revision history that loses the units involved.

Track this history across branches and patches. Git history and external sources such as Linear contribute context about earlier changes, fixes, and regressions. Their role extends beyond supplying the initial requirements.

Count review cycles when units land outside the inner implementer/adversarial-reviewer loop. Internal corrections are tracked separately. The broader workflow still spans scope and planning through final review. A review unit may have multiple correction requests or comments, all connected to that unit.

### Count the correction while preserving its attributions

Multiple reports of the same defect count as one correction. Both reviewers' attributions persist on the same review unit, as the user clarified on 2026-09-24. Deduplicating the count does not discard either report, its author, or its connection to the correction and reviewed work.

One patch fixing two distinct defects represents two corrections. The number of comments or patches alone therefore does not determine the correction count. How to establish that reports concern the same defect, and how to retain those connections through regrouping, remain design questions.

## Quality and token cost are the KPIs

Quality is the north star. Regressions receive the highest importance when assessing automation and delegation. Track corrections and dispositions alongside later outcomes so apparent success can be reconsidered when a regression is discovered.

For reviewer's tax, the primary measures are unnecessary repetition and wrong or missing attribution. Wrong and missing attribution are also primary quality metrics for the system as a whole, beyond individual review sessions. Track both distinctly and use these observations to improve evaluations and the graph. Relevant context reused by multiple units is not automatically waste.

Track total input and output tokens, including their separate totals. Token cost and quality are the KPIs. Estimated time saved is not a KPI: it cannot be measured accurately enough for that role. Retain timestamps to understand average timing for a repository in a particular checkout, as diagnostic context rather than a direct performance metric.

Evidence may be reused across units and cycles. A marker can support attribution to multiple units where dependencies or blast radius connect the code. Shared evidence does not by itself determine how revisions are counted.

## Movement can go in either direction

The product should move suitable review work toward automated checking and agentic review without causing later errors or revisions. Regression history can also move units upward toward human-suggested or human-required review.

Delegation is therefore not permanent evidence of safety. Track the route, its context, and subsequent outcomes. A later problem may reveal that an earlier approval or delegation was inappropriate.

Proposed safeguard: a historical association should remain distinguishable from a confirmed regression. A Linear issue mentioning the same file is a reason to investigate, not sufficient evidence that this review unit failed. The matching and attribution rules remain open.

## Example for discussion

A permission check passes final review on branch A. A later patch on branch B fixes another route that exposed the same private document. The new finding should be connected to the relevant behavior, earlier review, and evidence where that relationship is supported.

The affected unit's history then informs later routing. The cycle that contains the correction gets its revision total from the unit records. Other unrelated units should not automatically inherit that regression history.

This example does not decide whether the later patch contains the same unit, a successor unit, or a related unit. We need that distinction before a precise regression metric is possible.

## Open definitions

- What keeps a review unit identifiable across patches, renames, branches, splits, and merges?
- How do we establish that several reports describe the same defect so the agreed correction-counting rule can be applied?
- How do we attribute one correction affecting multiple units without inflating cycle totals?
- Which historical signals justify investigating a unit, and which justify moving it upward?
- How long do we observe a delegated or approved unit before reporting its outcome, and how do later discoveries update that result?

Keep the context and token cost commitments in [product purpose](01-product-purpose.md) alongside these quality measures. No single count establishes return on investment.
