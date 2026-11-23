# Review in final review

Final review comes after the inner loop has approved. Each review unit of a batch gets a verdict, cited comments and, on human-required work, a suggested review. Neuve's own review agent writes the agent's review of every unit by these rules. Read this when you are a final reviewer yourself: an outer agentic reviewer of a finished range, or preparing a person's review of the units waiting on them.

Read [review-verification.md](review-verification.md), [review-independence.md](review-independence.md) and [review-against-scope.md](review-against-scope.md) first.

## Final review never blocks

Final review shares the evidence and gives best-effort verdicts and comments; it never holds work back. A request for changes still rests on a verified defect, including offered proof that can't show what it claims. Missing proof is reported, never a ground for holding work back here; weighing it is the [inner-loop reviewer's call](inner-loop-reviewer.md#what-this-role-owns).

## Review without the lane

Decide whether the unit's owned changes are correct against what they were meant to do. Context is evidence; it is not yours to approve. Form the verdict without the unit's lane, the reasons it was placed there, or the verdicts on other units; the lane is applied after the verdict, so one review text serves every lane ([review-independence.md](review-independence.md#judge-in-a-fresh-context) says why).

## What the verdict becomes, by lane

| Lane | Your verdict becomes |
| --- | --- |
| Agentic review | Approval or request for changes: a disposition, with the review text as its note |
| Human-suggested | Approval or request for changes: a disposition that applies if the person gives no input; they may agree or override it |
| Human-required | A suggested review and comments, never an approval. A request for changes may also be recorded as the agent's disposition, but it doesn't close the unit. It reaches the person as context, and only their disposition closes it |

Whether a unit's needed dispositions are in is judged against its current lane. An earlier agent approval on a unit that has since become human-required no longer closes it, and reaches the person as context.

Neuve's review records its own agent's dispositions. In your own session there is no command for you to record one. Give your verdict to the person in your report, and never record or send a disposition in their name ([SKILL.md](../SKILL.md)).

## Suggested reviews

On human-required units, write the review a careful person would send: the verdict, and each cited point, reasoned from the "Done when" items and the evidence behind them. It is not a disposition until a person sends it, and sending records that person as the actor. The [worked example in review-against-scope.md](review-against-scope.md#worked-example) is one: a suggested request for changes with two cited points, whose first row rests on a code reading alone and so reads no evidence.

## Criteria rows

Fill the unit's criteria rows as [review-against-scope.md](review-against-scope.md#criteria-rows) describes. A suggestion appears only on human-required units. However much you explain, you never change the facts, the lane, what the person can record on the review desk or who decides.

## Later reviews

A review after new comments or new commits runs in a fresh context over the same frozen changes and the new comments. Earlier dispositions are context; they are never rewritten.

## When the review can't finish, or proof is missing

- If you can't finish the review, say what is missing; never invent a verdict.
- When proof is missing, [review-against-scope.md](review-against-scope.md#when-proof-is-missing) says how rows and approvals read. On agentic and human-suggested units you may still approve on a reading of the code, saying plainly that proof is not recorded.

## Worked example

The person asks you to go over a finished range before they decide. You form your own verdict on each unit first, then read `neuve review show main..HEAD` and `neuve proof list main..HEAD`. One unit, "Charge the card once per order", is human-required and has one test-run record.

You write the person a suggested review: "Request changes. Not met: a retried payment request charges again, because the idempotency key is built after the charge call (`payment.ts`, line 52). The test run covers a single request only, so the retry has no evidence. This is a suggestion; you decide it on the review desk." You record nothing yourself, and you don't hold back the other units. Their findings go to the person as information.
