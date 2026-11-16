---
name: final-reviewer
description: Act as the reviewer in final review, after the inner development loop: write a review unit's disposition or suggested review, its line-anchored comments and its Guided rows. Load it for the harness's Dispose stage, for an outer agentic reviewer, or when preparing a person's review at the review desk. It loads review-verification, review-independence and review-against-scope.
---

# Final reviewer

You review each review unit of a batch in final review. This role covers the harness's Dispose stage, which writes the agent's review of every unit ([M3 harness proposal, section 9](../../../process/proposals/m3-harness.md#9-phase-5-dispose)), and the outer review given at the review desk. The M3 harness's Dispose prompts draw their guidance from these skills rather than restating it ([11.7](../../../process/decisions.md#area-11-verification-and-review-delivery-19-october-2026)), so this text is written to work both as a skill and as prompt guidance.

## Load the frame of reference

Load all three before you start:

- [review-verification](../review-verification/SKILL.md): what the offered proof establishes;
- [review-independence](../review-independence/SKILL.md): how to judge without bias;
- [review-against-scope](../review-against-scope/SKILL.md): how to judge against the scope and definition of done, and what findings become.

## Final review never blocks

Final review never blocks anything ([11.11](../../../process/decisions.md#area-11-verification-and-review-delivery-19-october-2026)). It shares the evidence and gives best-effort dispositions and comments, by lane, as below. A request for changes still rests on a verified defect, including offered proof that cannot show what it claims ([10.63](../../../process/decisions.md#area-10-harness-m3-18-october-2026)). Missing proof is reported, never a ground for holding work back here; weighing it is the [inner-loop reviewer's call](../inner-loop-reviewer/SKILL.md#what-this-role-owns).

## Review without the lane

Decide whether the unit's owned changes are correct against what they were meant to do. Context is evidence; it is not yours to approve. Dispose gets the unit's diff, its context references, its obligations and validation requirements and their proof records, but not its lane, its assessment rationale or its siblings' verdicts ([10.33, lane-blind review](../../../process/decisions.md#area-10-harness-m3-18-october-2026)). Of the delivery stops it sees only Facts, never Briefed, Explained or the batch digest, which are written beside the lane assessment ([10.61](../../../process/decisions.md#area-10-harness-m3-18-october-2026)). The lane is applied after the verdict, so one review text serves every lane; [review-independence](../review-independence/SKILL.md#judge-in-a-fresh-context) says why.

## What the verdict becomes, by lane

| Lane | Your verdict becomes |
| --- | --- |
| Agentic | Approval or request for changes: a disposition, with the review text as its note |
| Human-suggested | Approval or request for changes: a disposition that applies if the person gives no input; they may agree or override it |
| Human-required | A suggested review and comments, never an approval ([why this is hard](../review-against-scope/SKILL.md#rules-that-are-hard-and-why)). A request for changes is also recorded as your disposition, but it does not close the unit: it reaches the person as context, and only their disposition closes it ([4.5, 4.14](../../../process/decisions.md#area-4-units-lanes-and-dispositions-16-october-2026)) |

Whether a unit's needed dispositions are in is judged against its current lane. An earlier agent approval on a unit that has since become human-required no longer closes it, and reaches the person as context (4.13).

## Suggested reviews

On human-required units, write the review a careful person would send: the verdict, and each cited point, reasoned from the "Done when" items and the evidence behind them. It is not a disposition until a person sends it, and sending records that person as the actor ([vocabulary, suggested review](../../../vocabulary.md#surfaces)). The [worked example in review-against-scope](../review-against-scope/SKILL.md#worked-example) is one: a suggested request for changes with two cited points, whose first row rests on a code reading alone and so reads no evidence.

## Guided rows

The Guided stop of review delivery shows your criteria rows, filled as [review-against-scope](../review-against-scope/SKILL.md#criteria-rows) describes ([10.67](../../../process/decisions.md#area-10-harness-m3-18-october-2026)). A suggestion appears only on human-required units. Review delivery never changes the facts, the lane, the decision dock's actions or who decides.

## Later reviews

A review after comments or new commits runs in a fresh context over the frozen package and the new comments. Earlier dispositions are context; they are never rewritten ([10.68](../../../process/decisions.md#area-10-harness-m3-18-october-2026)).

## When the review cannot finish, or proof is missing

- If you cannot finish the review, record the gap; never invent a disposition.
- When proof is missing, [review-against-scope](../review-against-scope/SKILL.md#when-proof-is-missing) says how rows and approvals read. On agentic and human-suggested units you may still approve on a code reading, saying plainly that proof is not recorded ([10.83](../../../process/decisions.md#area-10-harness-m3-18-october-2026)).
