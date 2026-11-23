# Judge what the proof establishes

Part of the frame every Neuve reviewer works from, in the inner loop and in final review. It answers one question: what does the offered proof actually establish about the changed behaviour? What proof is, and how to record it, is in [proof.md](proof.md).

## Proof is agreement

A change is proven when every applicable part of the flow points to the same result: what the code does, what its tests assert, and what telemetry, logs, screenshots and video observed. No single kind is enough alone. A validation requirement (what must be observed to confirm a changed behaviour, from its scope or implied by the change) has solid coverage only when its applicable kinds agree; one kind alone is at most shallow; none is missing. The review shows this as the requirement's proof state, described in [proof.md](proof.md). Each kind of proof is a designed part of the work, never an ad-hoc addition.

The code is one of the parts that must agree, but re-reading the diff is not a recorded kind of proof. The recorded kinds are a test run, telemetry, a log, a screenshot, a video, and the output of a static analyser the repository declares, such as a type checker or linter. Which kinds apply depends on the work: browser-facing work is proven with server, browser and network logs, screenshots and video; server-facing work with telemetry and logs; both rest on tests kept to what good practice needs. Documentation needs only its content and links.

## What each kind can and cannot establish

A passing check supports the behaviour and conditions it actually checks, and nothing beyond them.

| Kind | Can establish | Cannot establish |
| --- | --- | --- |
| The code, as you read it | What it would do on the paths you traced | That it runs, or behaves so under real conditions |
| Test run | The behaviour it exercises and asserts, for its inputs | Behaviour it mocks away or never observes; that its expected value is right |
| Static-analysis output | What the declared analyser checks, such as types or lint rules | Runtime behaviour |
| Telemetry, logs | What happened in that run, on that revision | Paths the run never took |
| Screenshot, video | The interaction and outcome shown | Persistence, side effects, other access paths, absence of defects |
| A script written to check the change | Nothing; it is not proof | |

## Who recorded it, and when

`neuve proof list <base>..<head> --path <owned path>` shows each record's recorder and revision, and whether it is still current for the unit that owns those files. Weigh the implementer's proof of its own work with extra skepticism. It is not wrong for being self-recorded, but nobody else has looked at it.

A record counts for a unit only if it observed a commit after which none of the unit's owned files changed, up to the head. A record that fails this is out of date, and the list says stale. It is honest proof of earlier work, never forged by that alone. Disclose it; it is never a defect, it counts at most as shallow, and on its own it leaves a criteria row at no evidence. A record is forged only when it claims to describe the reviewed code while its artefact shows another revision.

## Good tests

Good tests are not more tests. They verify the right things at the right boundaries, including error handling and input handling. Each test needs a stated reason and a setup that reaches the real behaviour. Prefer tests that assert observable behaviour and literal expected outcomes over implementation details. Judge whether the changed behaviour's boundaries, errors and inputs are exercised, never how many tests there are. A test's existence, count or passing status is never approval, and many tests in generated code is a warning sign. To find out whether a test really catches what it claims, plant a problem, as [inner-loop-reviewer.md](inner-loop-reviewer.md#how-you-work) says.

## Bogus or forged tests and proof

Agents can be convincingly wrong without meaning to be, so read every test and every claimed proof for what it really observes. Signs worth weighing:

- an assertion that is tautological or checks only a constant;
- a test that claims to verify the changed behaviour but mocks it away or can't observe it;
- assertions deleted or loosened, tests skipped, disabled or narrowed to one case, in the same range as the change;
- snapshots rewritten wholesale along with the change;
- a custom script offered as proof;
- a record that claims to describe the reviewed code while its artefact shows another revision (out-of-date proof, above, is not this).

These are signs, not a checklist. A loosened assertion can be a legitimate change of expected behaviour; check the scope before calling it forged. When the sign holds up, it is a defect.

A test that mocks away the behaviour being changed can never fail for the reason the change exists, so its passing result establishes nothing about that behaviour. That is bogus proof, a defect about the tests, and a note about it is not a correction. A test that doesn't reach a behaviour is different. That is a gap, and a risk.

| What you find | What it is |
| --- | --- |
| Bogus or forged test or proof | Defect; it supports a request for changes on any lane |
| Out-of-date proof | Disclosed; at most shallow; the row stays at no evidence; not a defect |
| A behaviour, boundary, error or input case no test reaches | Risk |
| More tests than the change needs | Risk |

Whether missing proof holds work back depends on the role: the [inner-loop reviewer](inner-loop-reviewer.md#what-this-role-owns) weighs it, and [final review](final-reviewer.md#final-review-never-blocks) never blocks.

## Disagreement is a finding

Compare the sources for the same behaviour and the same revision: what the code does, what the tests assert, what any runtime proof shows. When one contradicts the change's claimed behaviour, that is a defect. When the record can't reconcile them, that is a risk. Never pick the source you like and drop the others. Missing, made-up, out-of-date or inapplicable evidence never counts as solid or met.

## Worked example

A change should make a revoked share link stop working. Its test confirms that the revoke endpoint returns success but never tries the old link. That supports the response, not the access-control outcome. A recorded browser session that opens the old link and sees access denied would close the gap, and even that video doesn't show that every other access path is protected.

Later, a screenshot recorded at commit `b1` shows the revoked link refused, and commit `b2` then changes the unit's access check. `neuve proof list main..HEAD --path src/share.ts` lists the screenshot as stale. You disclose it, count it at most as shallow, leave the row at no evidence, and ask for a fresh capture. Had its claim said "at the head" while its artefact shows `b1`, it would be forged, and a defect.
