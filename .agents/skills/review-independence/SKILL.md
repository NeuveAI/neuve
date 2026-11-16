---
name: review-independence
description: Keep an adversarial review independent and unbiased, by judging in a fresh context, deciding before seeing others' verdicts, reasoning about why and how the change works, and separating defects from preferences. Load it for any review of someone else's change, by an agent or a person, in the inner development loop or in final review; the reviewer role skills load it for you.
---

# Review independence

Part of the frame of reference every Neuve reviewer works from ([11.7, the owner's ruling that these skills are the single authority for it](../../../process/decisions.md#area-11-verification-and-review-delivery-19-october-2026)). Reviewers in the inner loop and in final review work independently and without bias (11.4). This skill says what that takes.

## Judge in a fresh context

Your goal is your own: find what is wrong. Review each review unit in its own fresh context ([10.64, a bounded fresh-context review per unit, in the inner loop too](../../../process/decisions.md#area-10-harness-m3-18-october-2026)). What you share with the implementer is the task's scope and definition of done, nothing more ([7.1, the reviewer's own goal](../../../process/decisions.md#area-7-how-agents-build-neuve-16-october-2026)). Three things are never premises:

- **Sibling verdicts.** How other units of the batch were judged says nothing about this one.
- **The lane.** "It's only agentic, approve" is anchoring. In the harness, the review is formed without the lane and code applies it afterwards ([10.33, lane-blind review](../../../process/decisions.md#area-10-harness-m3-18-october-2026)).
- **The implementer's own account.** A summary, a handover or a claim about what was tested is one more claim to check, never a starting point.

## Decide before you reveal

Form your own verdict first, then look at what others concluded ([9.38, decide-then-reveal](../../../process/decisions.md#area-9-benchmark-m4-17-october-2026)). The owner's own adjudication showed why: after about six items, the owner sided with whichever labeller was shown first on 28 of 29. Neutral context with highlighted lines and questions helps; a proposed grade does not. You may revise after the reveal; keep your first verdict on record and say what changed it.

## Reason about why and how

Guidelines and directives prevail over hard rules (11.4, [10.23, guide don't impose](../../../process/decisions.md#area-10-harness-m3-18-october-2026)). Work out what the change is for and how it achieves it, then trace concrete paths through the code: the normal path, the error path, the boundary, the caller that breaks. A checklist ticked without that reasoning is not a review. Hard rules exist only where a ruling protects safety or integrity; [review-against-scope](../review-against-scope/SKILL.md#rules-that-are-hard-and-why) names them.

## Stay skeptical

Agents can be convincingly wrong, not on purpose ([7.3](../../../process/decisions.md#area-7-how-agents-build-neuve-16-october-2026)). Fluent explanations, confident commit messages and green checks all describe the work; none of them is the work. Verify what was claimed by reading the code and the proof yourself.

## Defects, not preferences

A defect is a fault you can cite and have verified: the code does something wrong against its scope, or its proof is bogus. A preference is a way you would have written it. A concern the evidence supports but does not prove is a risk, and must not be presented as a proven defect ([foundation 05, supported uncertainty](../../../foundations/05-reviewers-tax.md#supported-uncertainty)).

An empty result is valid. Producing objections is not evidence of review quality ([foundation 02, adversarial review](../../../foundations/02-review-modes-and-cycles.md#adversarial-review)), and noise adds to the [reviewer's tax](../../../vocabulary.md#history-and-economics): the effort reviewers spend gathering, reconstructing and repeatedly processing the information needed to assess work. Say what is wrong, or why it is fine, once, and cite it.
