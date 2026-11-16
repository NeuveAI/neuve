# Verification and evidence

Status: user-established, updated 2026-10-19 to match the owner's [design decisions](../process/decisions.md), Areas 7, 10 and 11. Numbers such as 7.2 refer to entries there. This foundation covers evidence in the product, and also how agents building Neuve supply evidence (7.2, 7.3). All applicable proof for a range belongs in the system of records (11.3); when recording it enters the build is still open.

## Established principle

A passing check supports the behaviour and conditions it actually checks. It does not by itself approve the entire review unit. Neuve should identify what the evidence establishes and what remains unresolved, so reviewers do not have to reconstruct that distinction themselves.

Under the [no-repetition principle](05-reviewers-tax.md#established-principle), reuse already assembled, valid evidence and context unless invalidated. Reuse does not require a fresh applicability proof for every commit. Invalidation must have a reason, such as a relevant change or a discovered evidence defect; recompute the affected material rather than repeat unaffected work. Reuse does not extend an earlier result beyond what it established. Detecting and propagating invalidation remain design work.

Use [Poteto's verification guide, Part 1](https://x.com/poteto/status/2094457600259842065) as a starting reference (our captured copy is kept in the private archive). The owner endorses its role here, not every tool, workflow choice, or productivity claim in the article.

## Verification is convergence

Code, tests, telemetry, logs, and screenshots and video where they apply, are all parts of proving that a change works. Every applicable part of the flow must converge on the same result; no single kind of proof is enough on its own (11.1). Each is a designed part of the work, never an ad-hoc addition. Together with the plan's scope and definition of done, this proof is what the harness and the inner-loop reviewer judge against (11.3).

Reviewers, in the inner loop and in final review, work independently and without bias, guided by directives rather than hard rules, so agents and humans reason about why and how things change (11.4).

## What counts as evidence

Evidence is recorded in Records through the CLI (7.2). What fits depends on the work:

| Work | Evidence |
| --- | --- |
| Browser-facing | Screenshots, video and logs captured through the Chrome DevTools MCP |
| Backend, CLI or library | Logs and adequate telemetry records, alongside tests where they are needed |
| Documentation | The content and its links |

Ad-hoc verify scripts are not evidence (7.2).

**Use tests sparingly** (7.3). Create a test only when it is needed, with an appropriate setup and a stated reason. A large number of tests is a bad sign, not a good one. Good tests verify the right things at the right boundaries, including error handling and input handling (11.2). Reviewers question each test's setup and what it actually observes. A test's existence or count is never approval.

**Stay skeptical** (7.3). Agents can be convincingly wrong without meaning to be. Reviewers check what the evidence actually observed rather than trusting its description.

## Responsibility for verification quality

The adversarial reviewer must refute invalid or inadequate evidence and require correction within the inner development loop. The loop advances only after its approval, as specified in the [adversarial review rule](02-review-modes-and-cycles.md#adversarial-review).

For example, if a test mocks away the behaviour being changed, a passing result cannot establish that behaviour. The reviewer requires an appropriate correction and assesses the resulting evidence before approving. Retaining a note about the inadequate test does not satisfy this requirement.

## What the reference contributes

Part 1 describes verification as a maintained capability: agents can operate and inspect the real application through reusable controls, with reproducible setup and a feature map explaining behaviour and how to reach it. The transferable idea is to make verification accessible and repeatable while reducing repeated context discovery.

The [verification research memo](../research/04-pstack-verification-and-supervision.md) distinguishes that approach from simply storing commands or screenshots. Its persistence example remains useful: seeing a setting change on screen does not establish that the change survives a reload.

## Visual evidence

Screenshots and videos support verification for both agentic and human reviewers. They can demonstrate observed interactions and outcomes, but are not sufficient on their own to establish all intended behaviour, persistence, side effects, or absence of defects.

For example, a video can show a reviewer revoking a link and then observing access denied. It supports that observed sequence; it does not establish that every alternative access path is protected.

## Conflicting intended behaviour

Scoping work and human resolution of unclear intended behaviour belong in planning. Investigate conflicting sources and their authority there. Unresolved intent requires human judgment and must not remain only in an advisory isolated briefing.

During the inner development loop, agents [query surrounding context and use the pinned task scope](02-review-modes-and-cycles.md#context-for-agent-reasoning) to reason through conflicting expectations with their available tools. Neuve supplies context; conflict resolution is mostly the agents' workflow responsibility. Routine mid-loop human clarification is rejected. More passing tests cannot decide between contradictory expectations.

## Evidence questions

For a review unit, explain:

- What intended behaviour or constraint is being checked, and where that expectation comes from.
- What actually ran or was inspected, against which version and conditions, and what observable result supports the conclusion.
- What the check can detect, what it does not establish, and which decision signals remain unresolved.

Answer these through attributable evidence and concise briefings, not a new verbose report per check or repeated justification of still-valid evidence. Evidence and markers may support multiple connected units through dependencies or blast radius.

## Research behind this

The [test-oracle survey by Barr and colleagues](https://discovery.ucl.ac.uk/id/eprint/1471263/) distinguishes observing behaviour from knowing whether it is correct. Inference for Neuve: an assertion can faithfully reproduce an implementation mistake if its expectation lacks a sound basis.

[PIT's mutation-testing documentation](https://pitest.org/) distinguishes executed-code coverage from tests detecting introduced faults. Inference for Neuve: targeted fault insertion can sometimes expose ineffective checks. It is one possible technique, not a requirement.

## Example and open questions

A change should revoke a sharing link. A test confirms that the revoke endpoint returns success, but does not attempt to use the old link. That result supports the response assertion, not the access-control outcome. Verification through the real access path, such as a recorded browser session, could address the missing evidence.

If a ticket says the old link must stop working but another source says existing links must remain valid, resolve intent with humans during planning. Separately, assess whether the checks actually test whichever behaviour is established.

Still open: invalidation detection and propagation, contradictory results, detection of misleading or fabricated evidence, and when further investigation earns its cost.
