# Research synthesis for the Neuve rethink

Later clarification: the user established Git hunks and surrounding hunk clusters as the review-unit starting point. Proposals below to make behavioral claims the primary unit are superseded. See [the current foundation](../foundations/04-review-units-and-context.md).

Research date: 2026-09-17. This is a discussion document. Observations describe inspected sources; inferences interpret them; proposals remain open. No architecture, quadrant definition, or stack is accepted here.

## Overview

Observation. The earliest located Neuve concept describes an author-side pre-review assistant. It helps people understand expected behavior, evidence gaps, and where a reviewer should concentrate. Later work expanded into decomposition, agent review, routing, and ongoing review coordination. The original outcome was better use of human attention. The existing commands and stores are evidence of previous implementation choices. [Existing product research](01-existing-product.md).

Proposal. A candidate promise for the rebuild is: **Neuve makes a change's intent and evidence traceable, so people can understand what has been established and direct their judgment to what remains unresolved.**

The user's direction already spans development sources, an implementer-antagonist loop, and post-validation review. The narrower historical review-triage product remains a useful comparison, but lifecycle scope is not the first open question. A boundary remains between helping existing agents and humans coordinate intent, evidence, and decisions, and owning work execution itself. That boundary can wait until the user-visible promise is clear.

## Key concepts

Inference. Several things currently called correctness need separate explanations. A requirement says what should happen. A check records an observation under stated conditions. An agent interprets the available information. An authorized person or policy determines whether a remaining tradeoff is acceptable. These can disagree. Passing the available tests does not settle whether those tests express the intended requirement. [Review and verification research](02-review-and-verification.md).

The four desired categories also need discussion. Automated and agentic describe ways to investigate or check something. Human-suggested and human-required describe a person's involvement or authority. A change can need all four. The existing implementation collapses some distinctions and routes ordinary source changes to strict human review through a runtime/lifecycle gate. That is an observed routing rule; its frequency and actual burden were not measured. Meanwhile, its classifier cannot lower required human posture, and decomposition remains incomplete. [Existing product research](01-existing-product.md).

Inference. The central inherited tension is whether Neuve reduces unresolved work or mainly classifies it. Another is whether a review unit follows a file fragment or a behavioral obligation that spans files. Neither question can be settled by drawing a more detailed matrix.

Independent evidence also needs a concrete meaning. A fresh agent context or different model can offer another perspective while sharing the implementer's mistaken requirement and incomplete context. A counterexample, previously established constraint, runtime observation, or independently constructed check contributes information that another agreeing opinion may not. Even executable checks have fallible expectations. The surveyed research supports evaluating what reviewers discover and help correct, while retaining benchmark and deployment limitations. [Review and verification research](02-review-and-verification.md).

## How it works in one possible example

Proposal for discussion. Suppose a change retries a payment request after a timeout. The intended behavior is to avoid duplicate charges while explaining an uncertain payment state to the customer. The following are illustrative obligations, not accepted category definitions.

| Possible category | Concrete obligation | What remains after it is done |
| --- | --- | --- |
| Automated | Run a check that repeated requests with the same payment identity create one charge in the tested environment. | Untested concurrency and provider behavior remain outside that result. |
| Agentic | Investigate concurrent retries and provider callbacks; support any concern with a source or counterexample. | A clean investigation still has stated coverage limits. |
| Optional human | Invite a reviewer to inspect pending-state wording after agreed content checks pass. | Whether this inspection is optional depends on the team's actual policy. |
| Required human | Have the authorized product owner resolve an unsettled choice about how long a payment may remain pending. | Checks can inform that choice but cannot supply the missing authority. |

During implementation, an antagonistic reviewer could find the callback race and help the author repair it. Later review would ask whether the resulting change has applicable evidence and whether the pending-state decision was made. This distinction does not imply another model call at every transition. It raises the narrower question of which subsequent changes invalidate which results.

Poteto's writing adds a practical requirement to examine: agents need maintained ways to exercise the actual application. A screenshot of a changed setting does not establish persistence after reload. A feature map can describe user behavior that a symbol graph omits. These are useful mechanisms and author-reported experience, without adopting the posts' productivity claims. [Verification and supervision research](04-pstack-verification-and-supervision.md).

## Where Entire fits

Observation. Entire captures development sessions and checkpoints. Entire Graph derives structural code relationships and retrieves selected context. Source inspection found useful provenance, alongside heuristic relations, coverage limits, and different working-tree and committed-content behavior. A checkpoint association does not establish exclusive authorship; a graph edge does not establish behavioral correctness. [Entire research](03-entire-and-code-context.md), [pinned snapshot contract](https://github.com/entireio/entire-graph/blob/5637039f7da7c8f35726eec22c230491a3f90b9f/docs/snapshot-format.md).

Inference. These capabilities could help recover why work happened and find relevant code. Neuve would still need to explain the intended outcome, evidence applicability, unresolved obligations, and decision authority. Retaining Entire leaves those product questions open.

## Gotchas and the first discussion

More checks can increase machine cost and human investigation without resolving the important uncertainty. A quiet review can conceal missed scope. Smaller units can still interact incorrectly. Historical repository documents establish prior intent; neither those documents nor vendor reports prove the rebuilt product will work.

The first discussion should test the candidate promise through the payment example: **What must Neuve let the human understand and decide, and which obligations must it genuinely discharge, for this to count as less review work rather than work hidden from view?** A concrete answer would describe what the person sees, which evidence they can challenge, and what decision remains theirs. That gives us a user-visible measure of success before we define review units, authority rules, or architecture.
