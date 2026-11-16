---
name: review-verification
description: Judge whether a change is proven to work, by checking that code, tests, telemetry, logs, and screenshots and video where they apply all converge on the same result. Load it for any adversarial review that weighs tests or proof, in the inner development loop or in final review; the reviewer role skills load it for you.
---

# Review verification

Part of the frame of reference every Neuve reviewer works from ([11.7, the owner's ruling that these skills are the single authority for it](../../../process/decisions.md#area-11-verification-and-review-delivery-19-october-2026)). It covers one question: what does the offered proof actually establish about the changed behaviour?

## Verification is convergence

A change is proven when every applicable part of the flow points to the same result: what the code does, what its tests assert, and what telemetry, logs, and screenshots and video observed (11.1). No single kind is enough alone. This holds wherever proof or validation is described ([11.9](../../../process/decisions.md#area-11-verification-and-review-delivery-19-october-2026)). A [validation requirement](../../../vocabulary.md#responsibility-and-review-flow) (what must be observed to confirm a changed behaviour, drawn from its scope or implied by the change) is solid only when its applicable kinds agree; one kind alone is at most shallow; none is missing. Each kind is a designed part of the work, never an ad-hoc addition.

The code is one of the parts that must converge. Re-reading the diff, though, is not a separate recorded kind of proof. The recorded kinds are a test run, telemetry, a log, a screenshot, a video, and the output of a static analyser the repository declares, such as a type checker or linter (the [M3 proposal's proof-record slice H4b](../../../process/proposals/m3-harness.md#12-milestone-slices) sets this list). Which kinds apply depends on the work. Browser-facing work is proven with server, browser and network logs, screenshots and video; server-facing work with telemetry and logs; both rest on tests kept to what good practice needs ([10.58, what validation means](../../../process/decisions.md#area-10-harness-m3-18-october-2026)). Documentation needs only its content and links.

## What each kind can and cannot establish

A passing check supports the behaviour and conditions it actually checks, and nothing beyond them ([foundation 07, the established principle](../../../foundations/07-verification-and-evidence.md#established-principle)).

| Kind | Can establish | Cannot establish |
| --- | --- | --- |
| The code, as you read it | What it would do on the paths you traced | That it runs, or behaves so under real conditions |
| Test run | The behaviour it exercises and asserts, for its inputs | Behaviour it mocks away or never observes; that its expected value is right |
| Static-analysis output | What the declared analyser checks, such as types or lint rules | Runtime behaviour |
| Telemetry, logs | What happened in that run, on that revision | Paths the run never took |
| Screenshot, video | The interaction and outcome shown | Persistence, side effects, other access paths, absence of defects |
| Ad-hoc verify script | Nothing; it is not proof ([7.2](../../../process/decisions.md#area-7-how-agents-build-neuve-16-october-2026)) | |

Foundation 07's [revoke-link example](../../../foundations/07-verification-and-evidence.md#example-and-open-questions) shows the gap. A change should make a revoked sharing link stop working. Its test confirms that the revoke endpoint returns success but never tries the old link. That supports the response, not the access-control outcome. A recorded browser session that opens the old link and sees access denied would close the gap, and even that video does not show that every other access path is protected.

## Who recorded it, and when

Each proof record shows who recorded it. Weigh the implementer's own proof of its own work with extra skepticism, as guidance (the proposal's rule in [slice H4b](../../../process/proposals/m3-harness.md#12-milestone-slices)): it is not wrong for being self-recorded, but nobody else has looked at it.

Check which revision each record observed. A record counts for a unit only if it observed a commit after which none of the unit's owned files changed up to the head ([11.10, stale proof is not forged proof](../../../process/decisions.md#area-11-verification-and-review-delivery-19-october-2026)). A record that fails this is **stale**: honest proof of earlier work, perhaps outdated, never forged by that alone. It is disclosed as stale and is never a defect. It counts at most as shallow coverage, and on its own it leaves a criteria row at no evidence. A record is forged only when it claims to describe the reviewed code while its artefact shows another revision.

Example: a screenshot recorded at commit `b1` shows the revoked link refused. Commit `b2` then changes the unit's access check. The screenshot is stale: disclose it, count it at most as shallow, leave the row at no evidence, and ask for a fresh capture. Had its claim said "at the head" while its artefact shows `b1`, it would be forged.

## Good tests

Good tests are not more tests (11.2). They verify the right things at the right boundaries, including error handling and input handling. Less is more. Each test needs a stated reason and a setup that reaches the real behaviour ([7.3](../../../process/decisions.md#area-7-how-agents-build-neuve-16-october-2026)). Prefer tests that assert observable behaviour and literal expected outcomes over implementation details. Judge whether the changed behaviour's boundaries, errors and inputs are exercised, never how many tests there are. A test's existence, count or passing status is never approval. Many tests in generated code is a warning sign.

## Bogus or forged tests and proof

Agents can be convincingly wrong without meaning to be, so read every test and every claimed proof for what it really observes ([10.63, judging tests and proof](../../../process/decisions.md#area-10-harness-m3-18-october-2026)). Signs worth weighing:

- an assertion that is tautological or checks only a constant;
- a test that claims to verify the changed behaviour but mocks it away or cannot observe it;
- assertions deleted or loosened, tests skipped, disabled or narrowed to one case, in the same range as the change;
- snapshots rewritten wholesale along with the change;
- a custom script offered as proof;
- a record that claims to describe the reviewed code while its artefact shows another revision (stale proof, above, is not this).

These are signs, not a checklist. A loosened assertion can be a legitimate change of expected behaviour; check the scope before calling it forged. When the sign holds up, it is a defect.

[Foundation 07's mocked-test example](../../../foundations/07-verification-and-evidence.md#responsibility-for-verification-quality): a test mocks away the behaviour being changed, so its passing result cannot establish that behaviour. It can never fail for the reason the change exists. That is bogus proof, a defect about the tests, and a note about it is not a correction. A test that simply does not reach a behaviour is different: it is a gap, a risk.

| What you find | What it is |
| --- | --- |
| Bogus or forged test or proof | Defect; it supports a request for changes on any lane |
| Stale proof | Disclosed; at most shallow coverage; the row stays no evidence; not a defect |
| A behaviour, boundary, error or input case no test reaches | Risk |
| More tests than the change needs | Risk |

Whether missing proof holds work back depends on the role: the [inner-loop reviewer](../inner-loop-reviewer/SKILL.md#what-this-role-owns) weighs it, and [final review](../final-reviewer/SKILL.md#final-review-never-blocks) never blocks ([11.11](../../../process/decisions.md#area-11-verification-and-review-delivery-19-october-2026)).

## Disagreement is a finding

This is the proposal's rule, from its [Dispose "Judging tests and proof" table](../../../process/proposals/m3-harness.md#92-what-it-is-built-on). Compare the sources: what the code does, what the tests assert, what any runtime proof shows, all for the same behaviour and the same revision. When one source contradicts the change's claimed behaviour, that is a defect. When the record cannot reconcile them, that is a risk. Never pick the source you like and drop the others.

Missing, fabricated, stale or inapplicable evidence never counts as solid or met ([foundation 01, verification must deserve trust](../../../foundations/01-product-purpose.md#verification-must-deserve-trust)).
