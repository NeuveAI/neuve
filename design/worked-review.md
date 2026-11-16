# A mixed-responsibility review, across two cycles

Status: design exploration, 2026-09-20. The historical repair is real. The proposed units, lane assignments, and two-cycle sequence below are an example for discussion, not accepted policy or a reconstruction of historical cycle counts.

Start here, then use the [retrieval comparison](retrieval-comparison.md) to examine how context reaches these hunks and the [four diagrams](review-diagrams.md) to follow the proposed relationships and flows. The [inspection record](evidence/inspection.md) separates observations made this session from historical reports.

## The concrete failure

The legacy review shell could reject a legitimate diff containing both human-required and nonblocking members. Its validator required each member's `mergeBlocking` value to equal the slice aggregate. With member values `true` and `false`, that condition cannot hold.

The [client repair](../../neuve-git/apps/web/src/features/mcp-review-shell/validation-diff.ts:44) accepts the slice when its flag equals whether any visible member blocks. The [producer repair](../../neuve-git/crates/mcp-server/src/review_projection/diff_slices.rs:40) uses the same visible membership. A hidden human-required fallback retains its own obligation and contributes to the independently derived [branch verdict](../../neuve-git/crates/mcp-server/src/review_projection/verdict.rs:5).

These are legacy transport semantics. A diff slice is a display grouping in that implementation, not a new definition of Neuve's review unit. Neither its aggregate flag nor displaying units together transfers decision authority.

| Historical contract case | Visible member flags | Hidden member | Slice flag | What the check establishes |
| --- | --- | --- | --- | --- |
| Mixed responsibility | `true`, `false` | None | `true` | The aggregate need not equal every member. |
| Hidden required work | `false` | Human-required | `false` | Visible slice aggregation must not erase the hidden obligation from branch review. |
| Contradictory payload | `true`, `false` | None | `false` | The validator must reject inconsistent data. |

The [mixed-tier fixture](../../neuve-git/tools/mcp-review-shell-validation/fixtures.ts:105) and [producer regression cases](../../neuve-git/crates/mcp-server/src/review_projection/tests/diff_slices.rs:168) supply these concrete distinctions. The offline harness passed this session, within the [recorded scope](evidence/inspection.md#checks-and-limits).

## What the old interface gives us

The [legacy redesign brief](../../neuve-git/docs/handover/mcp-review-redesign/nv-mcp-review-redesign-brief.md:27) organizes review around a scope header, unit list, selected diff, notes and supporting records, and review actions. I operated the checked-in packaged shell in its existing mock MCP host. It displayed that structure with fixture data and successfully consumed a host-pushed model.

The required/suggested filter worked. Changing the filter left the previously selected required unit in the detail pane until I selected a suggested row. Clicking Accept did not advance the displayed review progress. Add note did not open an editable note in the observed state. Source inspection confirms the [live presentation has empty notes and no ticket link](../../neuve-git/apps/web/src/features/mcp-review-shell/shell-presentation-live.ts:104), and the [action controls lack durable writes](../../neuve-git/crates/mcp-server/src/review_shell_ui/README.md:48).

Proposed improvements to that existing layout:

| Existing place | Proposed content for this repair | Why it matters |
| --- | --- | --- |
| Scope header | Current submitted revision, outstanding dispositions, and incomplete source processing when applicable. | A loaded UI does not establish complete context or completed review. |
| Unit list | Client aggregation, producer membership, packaged delivery, and verification changes, with their assessed lanes and dispositions. | The reader can see what needs a decision. |
| Selected diff | Hunks receiving the decision, plus clearly identified context and different-lane read-only neighbors where present. | Context must not silently become work receiving the approval. |
| Notes and context | A short contextual briefing with exact source fragments and any unresolved correction. | The reviewer can understand the contract without reconstructing the repair. |
| What's on record | What each check establishes, the version it examined, and what it leaves unverified. | “Passed” alone cannot express evidence applicability. |
| Review actions | Explicit decision target and acknowledged, durable result. If selection is outside the active filter, show that fact or update selection. | The legacy visible controls and selection behavior can mislead a reviewer. |

The specific presentation is proposed. Human-suggested units still arrive with completed agent dispositions under the [accepted sequencing rules](../foundations/02-review-modes-and-cycles.md#human-review-is-the-last-gate). The old label “not blocking” does not remove that obligation.

## Start with actual hunks

The [historical repair review](../../neuve-git/docs/handover/mcp-review-redesign/remediation-2026-07-02/reviews/ticket-a-review.md:9) names the client, producer, and packaged-asset commits. The [later verification review](../../neuve-git/docs/handover/mcp-review-redesign/remediation-2026-07-02/reviews/ticket-c-review.md:87) challenges overstated coverage and fallback behavior.

| Proposed review unit | Historical hunk anchor | Surrounding context needed |
| --- | --- | --- |
| Client aggregation | Client repair `c6259096`, `validateDiffSlice`, `@@ -45,13 +45,22 @@`. | Mixed-member contract, producer membership, negative validator cases. |
| Producer membership | Producer repair `161512ec`, `focused_diff_slices`, `@@ -43,7 +43,15 @@`. | Visible versus hidden members, per-member responsibility, independent branch verdict. |
| Packaged delivery | Bundle rebuild `4d270128`, the changed served HTML hunk. | Build input, embedded output, host transport, actual browser observation. |
| Verification and fallback | Evidence correction `bb4b3d57`, `loadBranchModel`, `@@ -127,18 +144,15 @@`, plus nearby coverage explanation changes. | Primary host-push route, fallback route, diagnostic preservation, harness limitations. |

These anchors can be reproduced with `git show <commit> -- <path>` in the legacy checkout. The [inspection record](evidence/inspection.md) pins that checkout. The last unit may split after assessment because executable fallback behavior and evidence wording need different verification. Test-file changes remain separate candidate units, linked as context here. This example does not decide cross-file cluster membership.

For discussion, assume the producer membership decision is human-required, the client unit is human-suggested with an agent approval, and packaged delivery is agentic. These lane assignments illustrate responsibility boundaries; they are not a proposed classifier rule. Static checks supply evidence without settling the [open deterministic-lane completion rule](../foundations/02-review-modes-and-cycles.md#every-review-obligation-gets-a-disposition).

## Retrieve fragments, then justify their attribution

Each row below identifies a possible contextual marker. The marker is the source fragment, not the explanation, risk label, or whole document. One fragment can support several hunks when the connection is established.

| Retrieved fragment | Attribution to the example | What remains uncertain |
| --- | --- | --- |
| [Visible membership and any-member aggregation](../../neuve-git/crates/mcp-server/src/review_projection/diff_slices.rs:40) | Supports the client and producer hunks' agreement about which members define the slice flag. | Source agreement alone does not prove packaged execution. |
| [Independent branch verdict derivation](../../neuve-git/crates/mcp-server/src/review_projection/verdict.rs:5) | Explains why excluding hidden members from a display aggregate need not remove their branch obligation. | The actual branch posture and its inputs must still be checked. |
| [Primary push and fallback transport distinction](../../neuve-git/apps/web/src/features/mcp-review-shell/standalone/mcp-postmessage-client.ts:14) | Supports the verification hunk's correction of the claimed delivery path. | A description of the path is not an observed successful delivery. |
| [Harness execution and omission contract](../../neuve-git/tools/mcp-review-shell-validation/model-evaluation.ts:10) | Limits what a green harness result can support for validator and packaging hunks. | An outcome named `rendered` does not prove a browser rendered. |
| [Historical request to correct coverage claims](../../neuve-git/docs/handover/mcp-review-redesign/remediation-2026-07-02/reviews/ticket-c-review.md:87) | Explains the verification correction and the earlier mismatch between claim and check. | Historical approval does not establish readiness under today's product rules. |

A ticket about another component's `mergeBlocking` field is a candidate search hit, not an attributable marker for these hunks. Similarly, the served bundle's [literal-presence check](../../neuve-git/tools/mcp-review-shell-validation/served-shell.ts:63) supports presence of those strings. It does not establish arbitrary source-to-bundle equivalence.

Proposed contextual briefing for the client unit:

> This hunk changes the slice check from equality with every member to whether any visible member blocks. The producer now uses the same visible membership. Hidden human-required work keeps its separate branch obligation. The validator cases support the aggregation rule; packaged browser delivery requires separate evidence.

In the interface, each sentence would link to the corresponding fragment above and the applicable check. An isolated briefing can explain the producer/client/build relationship once and be reached from each unit. It remains advisory and has no disposition of its own, as required by the [shared-context rules](../foundations/04-review-units-and-context.md#shared-context-across-separate-units).

## Walk the example through the workflow

This is a proposed simulation using real failure modes. Historical review rounds are not evidence of counted Neuve cycles.

1. During scope and planning, establish the member-aggregation contract and the required delivery paths. If actual host delivery is in scope, a model-only harness cannot satisfy it.
2. In the inner loop, the implementer changes the client and producer, rebuilds the asset, and supplies checks. The adversarial reviewer rejects any claim that the model-only harness proves browser rendering. Inadequate evidence is corrected before approval. These internal corrections do not increment the review-cycle count.
3. After adversarial approval, the first submission lands outside the inner loop. This is counted cycle 1 in this example. Final automated processing completes before the human stage. Units retain their individual dispositions and the assumed human-required producer unit still needs a human decision.
4. At the human gate, suppose the reviewer finds that a diagnostic from an unpinned request can be obscured by loading a different model through fallback. They request a correction to the verification/fallback unit. A second comment about the same cause remains linked without presuming whether it counts as another revision.
5. The implementer corrects fallback, adds applicable verification, and returns through adversarial approval and final automation. The second external submission is counted cycle 2. Recluster around the changed work. The unaffected aggregation hunks remain useful context without automatically needing another decision.
6. If investigation instead shows that changed membership alters a previously approved consumer's outcome, that unchanged consumer gets a renewed decision signal. Unchanged text is insufficient to preserve approval.

The historical verification repair disclosed the missing host-push coverage and later received approval. That narrower historical acceptance is not a valid substitute for the [current adversarial evidence requirement](../foundations/02-review-modes-and-cycles.md#adversarial-review). Merely documenting a missing in-scope check cannot make this simulated inner loop ready.

## What carries forward

| Prior material | Use in cycle 2 | Boundary |
| --- | --- | --- |
| Source fragments establishing the membership contract | Reuse when the source and its applicability remain unchanged. | Recheck after a relevant dependency or contract change. |
| Validator results on the previous revision | Reuse unless invalidated, retaining the original observation and its scope. | A new commit hash alone does not invalidate the result or require a fresh applicability proof. |
| Packaged browser result | Reuse only for the artifact, input, path, and conditions it examined. | Changed bundle or transport can require a new observation. |
| Fallback result predating diagnostic preservation | Keep for history, require new evidence for the changed behavior. | A success-path test cannot prove the new diagnostic path. |
| Prior dispositions | Keep linked to their original scope and revision. | Reuse of context is not transfer of approval to changed work. |
| Two comments describing one faulty fallback | Retain both comments and their attribution. | Whether they aggregate as one revision remains a product decision. |

## Questions ready for the interview

These questions are grounded in the example. Questions 1 through 3 were answered on 2026-09-24. Question 4 restated the existing no-repetition principle. Question 5 clarified the boundary between Neuve's context support and agents' workflow responsibilities.

1. Settled: regrouped units are new groupings with explicit links to earlier hunks, comments, evidence, and decisions. Preserve connected history and the original meaning of prior approvals. Changes remain visible in the appropriate venues, and changes to reviewed work require justification in markers or surrounding context. See the [accepted continuity and justification rules](../foundations/04-review-units-and-context.md#recluster-for-each-new-cycle). Exact hunk matching remains open.
2. Settled: reports of the same defect count as one correction, with both reviewers' attributions preserved on the same review unit, as clarified by the user. A patch fixing two distinct defects represents two corrections. See the [correction-counting agreement](../foundations/03-unit-history-and-metrics.md#count-the-correction-while-preserving-its-attributions). Matching reports and retaining attribution through regrouping remain design work.
3. Settled: Git hooks and events drive the main flow, with units directly connected to a commit or revision. A review of commit A stays tied to A when B arrives. Surface B's changes and give B new units that attest to and attribute those changes and their surrounding context, carrying forward applicable history and evidence under the no-repetition principle. See the [revision-bound review rule](../foundations/04-review-units-and-context.md#recluster-for-each-new-cycle). Exact scheduling and partial-submission counting remain design work.
4. Settled by the existing [no-repetition principle](../foundations/05-reviewers-tax.md#established-principle): reuse completed work and assembled evidence and context unless invalidated. The assistant's proposed requirement to substantiate applicability anew reversed this default. Detection and propagation of invalidation remain design work; whether to reuse still-valid material is not an open product question.
5. Clarified: implementers and reviewers query Neuve for surrounding context about a file, function, or code section. They pin the task or ticket's source scope, constraints, non-goals, and definition of done, then reason about conflicts using that information and their tools. Neuve aggregates, resolves, and gathers context; conflict resolution is mostly part of the agents' workflow. See the [context-querying responsibility boundary](../foundations/02-review-modes-and-cycles.md#context-for-agent-reasoning). Operational failure recording remains unspecified; this clarification does not introduce an approval bypass.

The five-question interview has established enough direction to continue design. These agreements do not select a storage system or matching algorithm. Do not reopen settled principles through examples that merely restate them, or turn agent workflow responsibilities into additional Neuve policy questions.
