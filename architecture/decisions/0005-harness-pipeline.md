# 0005: Harness pipeline

Status: accepted, 16 October 2026; revised 26 November 2026 for the owner's approved **Assign comprehensive reviewers to distinct owned ranges** plan. The [owner's decisions](../../process/decisions.md#range-owned-comprehensive-review) record the replacement of the fixed four-finder execution shape. This record describes the target; implementation and independent approval remain separate gates.

## Decision

Partition the changed work, then give each reviewer all four concerns within its assignment. Shared context does not imply shared review ownership. The existing **Lane review** is the comprehensive reviewer; there is no additional general-review stage beside it. **Assess** remains a separate judgment about complexity and ease of validation, not another defect search. The [native execution record](0014-ace-style-pi-harness.md) defines task and runtime ownership.

| Work | Responsibility |
| --- | --- |
| Precompute | Read the immutable range, applicable scope, prepared retrieval leads, source attribution and proof records. Retain available coverage if enrichment stops. |
| Frame | State the overall goal and done-when conditions with checked citations and a disclosed fallback. |
| Map and assignment | Settle batch membership before comprehensive review starts. Reuse section planning and bounded packing, constrained to one batch per assignment. Validate exact primary ownership and explicit exclusions. |
| Assess | Judge each section's complexity and ease of validation with cited evidence, independently of Lane review and without seeing the lane or its verdict. |
| Lane review | Investigate scope fit, correctness, risky edges, and tests/proof together in one bounded, multi-turn context per assignment. Record meaningful checks, citations, per-section judgments, findings and unexamined areas. An empty findings list is valid; four mini-reports or four comments are not required. |
| Verify | Check a specific supported defect claim in fresh context, preserving its original producer, exact claim, source basis, evidence, verification outcome and destination owner. This is not another review of the entire assignment. Claims may be registered while Lane review continues. |
| Decide | Apply the existing code-owned matrix, public-surface raises, risk floors, proof-state rules and lane authority. Form units from a file's sections sharing a lane within a batch. A failed or incomplete investigation never manufactures approval. |
| Fill, Link and briefing | Preserve range coverage and attributed supporting context, verified claim-to-comment mapping and valid decision-support links. Generate the existing delivery stops from retained judgments and evidence. |
| Publish | Publish settled batches progressively through the existing durable publication mechanism. A batch waits for its own required assessments, comprehensive reviews, verification and already registered incoming claims, not all reviewers in the range. Freeze each published batch. |

### Assignment is not unit identity

A batch groups changed work by behavior or obligation. A review unit is owned work receiving its lane-specific judgment and disposition. A reading group is only a bounded execution assignment. One reviewer can cover several units, and several assignments can contribute to one batch; neither changes unit identity or decision authority. The [batch and unit record](0007-batches-units-lanes-and-cycles.md) defines those product boundaries.

Every reviewable changed row has exactly one primary comprehensive-review assignment. Excluded, unreadable, oversized and unreached work has an explicit cause; assignment alone never means reviewed. Existing rules for old-side deletions, renames, mode changes and submodule pointers remain in force. Packing affinity is a heuristic, not proof of batch isolation or complete dependencies.

Each assignment retains the reviewed source, batch membership, owned section keys and ranges, applicable requirements and execution bounds. Surrounding source references say why they matter and remain separate from ownership and prior approval. The reviewer receives the goal, a compact batch/change index and applicable evidence, and may make focused reads of callers, definitions, tests and sibling changes outside its owned ranges. The [owned-work foundation](../../foundations/04-review-units-and-context.md) explains why those reads acquire no neighboring decision authority.

### Cross-boundary claims and publication closure

A failure involving owned changed lines is reported once with an owned primary anchor and contextual references to other affected ranges. Do not copy that report to every related unit or merge distinct defects merely because their anchors overlap.

A concern wholly outside the assignment is retained as an attributed observation and routed by its primary changed anchor through existing claim verification and ownership machinery. Routing neither launches another general reviewer nor creates an independent vote or an approval of the destination. Unknown ownership and missing evidence stay explicit.

Claim registration and publication closure are serialized through the existing durable task/publication mechanisms. Closure cannot drop a known in-flight incoming claim. It also cannot wait for every possible future observation from every assignment in the range.

An observation discovered after its destination batch froze is retained and exposed as **later review information**, with its original source and cycle attribution. It does not mutate the frozen package, transfer a disposition, become reviewed or resolved by virtue of publication, or trigger an unbounded re-review loop. A changed review basis follows the existing next-cycle rules in the [persistence record](0004-persistence-and-range-immutability.md).

### Retrieval, independence and reuse

The reviewer's bounded tools expose applicable prepared Records-backed scope excerpts, proof records, source attribution and current assignment/claim state. Giving only the harness database access does not meet that requirement. Preserve source/history attribution already gathered for the cycle; unrestricted evaluative-history injection is outside this change. Sibling verdicts and the implementer's account are not premises for independent judgment.

Reuse identical source preparation and lookups only when their complete inputs match, through the [shared-work helper](0016-shared-work.md), which gives one run per key and every other caller its response. Computation identity includes the actual assignment, reviewed source, context/evidence inputs, prompt/schema versions, offered tools and relevant configuration; a group label alone is insufficient. Interrupted tasks reuse retained state and completed claims.

## Bounds and failure handling

Size context, turns and lookup allowances for the assignment and route. Do not copy four full-range finder budgets into every assignment or assume one batch fits one context. Lane review is not restricted to first-turn-only lookups. Existing bounded retry, deadline, cancellation, provider refusal, native scheduling and follow-on policies remain applicable. Work no agent could judge is explicitly not judged under the existing human-required rules; missing proof is not automatically a verified code defect.

Preserve lane rules, human-required authority, proof requirements, exclusions, carry-forward and every delivery stop. A test's existence or a static caller relation is context, not proof of behavior. The [proof decisions](../../process/decisions.md#area-11-verification-and-review-delivery-19-october-2026) require applicable kinds of evidence to agree. Missing evidence reaches readers as a gap.

## Compatibility and measurement

Freeze a new pipeline/configuration identity. Do not reuse old review outputs as new-contract judgments or splice new task semantics into a frozen old run. Historical packages remain readable and unchanged; supported queued/in-progress work needs an explicit safe compatibility path. A new-version review cannot bypass its sole comprehensive reviewer through the old readings-off switch. Remove obsolete live finder spawning, collectors, overlap-agreement ranking, budgets and settings once compatibility needs are met; retain only what reads history or safely handles legacy execution.

The treatment replaces both the four range-wide finders and their overlapping Lane-review work. Compare it with the current pipeline on a fixed independently adjudicated set, including ordinary and cross-boundary defects, under both comparable total cost and actual production configurations. Report distinct supported defects and requirement failures, false positives, duplicates, wrong/missing attribution, unreviewed work, invalid decision-support links, input/output tokens, repeated reading, verification cost and publication latency. Preserve individual missed-defect cases. No equivalent-recall or fourfold-saving claim follows from architecture alone.

This supersedes the reconciliation-first proposal: no semantic grouping stage, representative-comment model or reconciliation panel is required. A durable finding lifecycle and broader prior-discussion retrieval remain separate work.
