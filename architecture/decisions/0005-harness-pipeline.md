# 0005: Harness pipeline

Status: accepted, 16 October 2026. The [owner's decision to give Lane review responsibility for each batch](../../process/decisions.md#one-reviewer-per-batch) replaces the whole-range finders.

## Decision

Precompute reads the committed range and scope. Frame states the goal and up to five done-when conditions. Map groups the changed files by intent and checks that each retained file belongs to one group. Lockfiles and generated or vendored files that Map excludes form a code-only batch.

The plan task waits for Frame and Map. If the front task ends without a Map, it gives the run no readings.

| Work | Shape |
| --- | --- |
| Plan | Code packs changed sections into bounded reading groups within each Map batch. Groups run riskiest first. |
| Assess | Assess records evidence for complexity and ease of validation, the requirements it can identify, and the gaps. It sees neither the goal nor the lane. |
| Lane review | Lane review checks scope fit, correctness, risky edges and tests for its assigned sections. It may use its first turn to read surrounding code. It returns a verdict per section, what it checked and comments on lines those sections own. |
| Verify | A fresh context checks defect claims and incoming defect, risk and question claims against pinned source. Identical checks share a computation. A reviewer can report a claim on changed lines outside its reading group separately from its own verdicts. |
| Decide | Code applies the lane rule and risk floors, forms units from sections of a file that share a lane, and uses the verified claims to decide which comments a request for changes rests on. The [batch and unit record](0007-batches-units-lanes-and-cycles.md) describes ownership and dispositions. |
| Publish | A batch waits for its readings and the incoming checks registered before the publisher selects its input. One publisher writes cumulative packets in batch order. Its publication chain tells the harness which batches are frozen. For any incoming claim left off the desk, the run log records its anchor and points to the answer and any stored check. |

[Native tasks](0014-ace-style-pi-harness.md) own the model conversations and waits. The [shared review rules](../../packages/review-rules/src/index.ts) decide which lines a unit owns. A reading group only decides which changed sections reach the same model call. The [shared-work contract](0016-shared-work.md) gives each publication plan one run for its cycle, review key and place in the packet chain.

Frame and Map have one turn and one invalid-answer retry each. Their deadlines are 90 and 120 seconds from their respective starts. Assess can resend a refused answer. Lane review can look up context, answer, and resend a refused answer. Verify uses one turn. A reading may reread unanswered sections once.

A default run lasts ten minutes and stops model work at 9:10. A cut-off retains stored readings and checks. A batch with sections the run did not reach waits for a follow-on run, up to eight follow-ons. At the cap, work no agent could judge is human-required with the note "No agent decision in this run". Work too large for a reading has the same lane. A provider quota refusal leaves its batches pending with a disclosed gap. An owner stop ends publication from that attempt.

## Retained boundaries

Lookups read committed source and treat it as evidence. Records keeps published packets and retained computation outputs. A person's decision can carry to a unit with the same sections. The [proof requirements](../../process/decisions.md#area-11-verification-and-review-delivery-19-october-2026) govern what makes a requirement proven. A test's existence, or a test that calls changed code, gives a reviewer context. Proof requires evidence that meets the requirement.
