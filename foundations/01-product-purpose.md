# Product purpose

Status: purpose accepted by the user on 2026-09-17. The measurement priorities and workflow directions below are user-established. Operational definitions remain open. No architecture or stack is selected.

## Purpose

Neuve helps humans and agents turn intended changes into verifiable work, preserve why decisions were made, and concentrate human judgment on what remains unresolved.

A human should understand and decide the unresolved parts of a change without reconstructing all the work that preceded it.

The product ambition is to help teams review at the speed of agents without over-relying on them. Faster review must preserve necessary human judgment and earn its context, token, and operating costs.

## Established direction

- Review units and four review categories remain central: automated checks, agentic review, human-suggested review, and human-required review. Their precise definitions remain open.
- Support development context, the implementer and adversarial reviewer loop, and post-validation review. Keep the inner development loop distinct from final review.
- Link intent, decisions, evidence, and attribution to Git. Entire remains a preferred base.
- Reduce repetitive human work by moving suitable review obligations toward automation, while tracking whether errors or revisions follow.
- Human-suggested work receives agent review before the human stage. If humans provide no input and do not manually approve it, the existing agent disposition applies. Hiding suggested units does not remove their review obligation.
- Preserve required human review, including obligations arising from applicable regulation or organizational policy. Which rules apply must be established for the actual use case; this document makes no blanket claim about EU law.
- Keep records and linkage compact. The previous workflow's documentation and output overhead must not recur. Context and tokens are product costs, not incidental implementation details.
- Use cost relative to demonstrated benefit to guide architecture, evaluations, and product metrics. Extra context, checks, and agents must justify their cost.

## Measurement commitments

Quality is the north star, and quality plus total input/output token cost are the KPIs. Wrong and missing attribution are primary system-wide quality measures and explicit dimensions of reviewer's tax. Regressions receive the highest importance. Estimated time saved is not a KPI; timestamps provide diagnostic timing context for a repository and checkout.

| Measure | What we must retain | Definition still needed |
| --- | --- | --- |
| Reviewer's tax | Unnecessary repetition and wrong or missing attribution for human and agentic reviewers. Feed findings into evaluations and graph improvement. | Detection, attribution, and comparison baseline. |
| Total model usage | Input and output tokens, with output tracked separately. | Scope across agents, retries, cached input, and providers; monetary costing. |
| Delegation and movement | Movement toward automation and escalation toward human review using regression history, including Git and external sources such as Linear. | Eligibility, observation period, and attribution of later problems. |
| Human review outcomes | Approval and revisions for human-suggested and human-required work; suggested work that falls back to agents. | What constitutes pickup, approval, and completion for each route. |
| Revisions | Revisions attributed to review units and their context across branches and patches; cycle totals aggregate those records. | Deduplication, shared corrections, and revision reasons. |
| Review cycles | Count one cycle per pass from scope gathering through the inner loop and harness pipeline to a complete set of outer dispositions (4.11 in the [design decisions](../process/decisions.md)). Inner-loop corrections happen within a cycle; track them and their quality separately. | Partial resubmissions, exact boundary events, and approval versus merge. |
| Cost and benefit | Whether added expense yields better correctness, quality, or team throughput. | Baseline, observation window, and acceptable tradeoffs. |

These are measurement requirements, not a settled scoring formula.

## Verification must deserve trust

The user reports useless tests, badly configured tests, and apparently forged evidence in the earlier workflow. These reports motivate scrutiny of verification quality; this document does not claim that particular incidents have been independently reproduced.

The pstack verification creation and maintenance skills (not in this repository) are reference material. Their useful practices include checking the running version, exercising real user paths, inspecting resulting side effects, preserving evidence, and detecting drift between documented and actual behavior.

Proposed evaluation safeguards, still to be specified:

- A passing check only supports the behavior it actually observes. Check counts and artifact volume do not establish correctness.
- Missing, fabricated, stale, or inapplicable evidence must not receive verification credit.
- Verification is convergence: code, tests, telemetry, logs, and screenshots and video where they apply must point to the same result; one kind alone is not enough ([11.1](../process/decisions.md#area-11-verification-and-review-delivery-19-october-2026)).
- Pair approval without revision with later defects and reopened work. Silence alone does not demonstrate quality.
- Keep revision reasons visible. A reviewer catching a real defect is useful even when the cycle count rises.
- Separate genuine removal of an obligation from concealment, relabeling, or avoidance of review.
- Efficiency cannot substitute for an applicable mandatory human decision.

## A concrete example

An agent changes document sharing. A requirement says private documents must remain inaccessible to unauthorized people. Checks exercise the relevant endpoints. An agent reviewer finds a bypass, the implementer fixes it, and the affected checks run again on the resulting version.

Neuve should preserve enough context and evidence to explain that work without repeatedly generating its history. The revision and review cycle remain visible, along with their token cost. Later discovery of another bypass must remain connected to the earlier result.

The change also leaves a product choice unresolved: should existing shared links survive a permission change? Tests can demonstrate either behavior, but cannot supply missing product authority. Neuve should isolate that decision for the appropriate human.

## Drilldowns

- [Ingestion and repository setup](08-ingestion-and-setup.md) records Git-led event ingestion, active ingestion, and initial pre-population.

- [Verification and evidence](07-verification-and-evidence.md) records scoped passing results and proposed evidence-quality questions grounded in Poteto Part 1.

- [Escalation and decomposition](06-escalation-and-decomposition.md) connects contextual markers to review responsibility and the design of work before implementation.

- [Reviewer's tax](05-reviewers-tax.md) establishes the burden on both human and agentic reviewers, with proposed dimensions for discussion.

- [Review modes and cycles](02-review-modes-and-cycles.md) defines the two modes and required dispositions.
- [Unit history and metrics](03-unit-history-and-metrics.md) records revision attribution and movement informed by regression history.
- [Review units and surrounding context](04-review-units-and-context.md) establishes the hunk-based starting point, chunking, and attributed UI briefings.

The review unit starts with Git hunks, which can be grouped into review units. Further legacy grounding precedes decisions about grouping and continuity. Execution ownership, interfaces, storage, and technology choices remain open.

## Sources

The user's original brief and follow-up accepting the purpose are authoritative for the established direction. Supporting research covers [earlier product intent](../research/01-existing-product.md), [review and verification](../research/02-review-and-verification.md), and [poteto's verification and supervision writing](../research/04-pstack-verification-and-supervision.md). Historical implementation choices are evidence, not inherited requirements.
