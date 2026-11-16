# Adversarial review standard

Status: how Neuve's own build lanes are reviewed, from the owner's [design decisions](decisions.md) 7.1–7.3. It is also an example of what Neuve skills can prescribe (7.4). The product meaning of the inner-loop adversarial reviewer is in the [review modes foundation](../foundations/02-review-modes-and-cycles.md#adversarial-review).

## Reviewer skills

Reviewers load the [`inner-loop-reviewer` skill](../.agents/skills/inner-loop-reviewer/SKILL.md), which combines three skills that carry the frame of reference for adversarial review ([11.7](decisions.md#area-11-verification-and-review-delivery-19-october-2026)):

| Skill | What it carries |
| --- | --- |
| [`review-verification`](../.agents/skills/review-verification/SKILL.md) | Proof converges (11.1, 11.9); the kinds of proof and what each can establish; who recorded it and stale (outdated, not forged) proof (11.10); good tests (11.2); bogus or forged tests and proof (10.63) |
| [`review-independence`](../.agents/skills/review-independence/SKILL.md) | Fresh context, decide before you reveal, skepticism, defects versus preferences (11.4) |
| [`review-against-scope`](../.agents/skills/review-against-scope/SKILL.md) | Judging against the scope and definition of done, criteria rows, finding kinds, the hard rules (11.3, 11.5) |

Those skills are the single authority for how to judge. This standard keeps only the process for Neuve's build lanes: setup, code quality, time box, what blocks, evidence to supply and the report.

## Setup

Lanes and who reviews them follow the [lane rules in `AGENTS.md`](../AGENTS.md#how-agents-build-neuve), from [decisions 7.1 and 7.7](decisions.md#area-7-how-agents-build-neuve-16-october-2026).

The reviewer's brief shares only the task's definition of done and its scope, never the implementer's own account as a premise (7.1).

A Neuve review cycle runs on the same range ([12.54](decisions.md#area-12-ace-style-pi-transition-28-october-2026)). Write your own findings first. Then give each of Neuve's findings and validation requirements a verdict: confirmed, refuted or unverified. The [lane loop](neuve-in-the-loop.md#the-loop) says where its receipt is and how to record the verdicts.

## Placement and code quality

Code must be in good order (7.11). Check that:

- each new piece of code sits in the layer and module that owns the responsibility ([architecture](../architecture/README.md)), with no new god objects;
- abstractions are small, named for what they do, and organised by domain;
- the implementation follows canonical sources: the official documentation of Effect, Bun, zod, ACP, MCP and the provider SDKs, and the established patterns of the codebase;
- code made irrelevant or deprecated by the change is removed, not left beside the new code;
- work that more than one caller can ask for follows [record 0016's shared work](../architecture/decisions/0016-shared-work.md). Never suggest duplicate runs, polling or a new lock as a simplification.

## Time box

About 30 minutes per review (7.1). Spend it on what could be wrong in ways that matter, not on completeness of ceremony.

## What blocks

| Finding | Outcome |
| --- | --- |
| Correctness defect | Blocks |
| Security defect | Blocks |
| Bogus or forged tests or proof, including a record that claims to describe the reviewed code while its artefact shows another revision ([10.63](decisions.md#area-10-harness-m3-18-october-2026); [11.10](decisions.md#area-11-verification-and-review-delivery-19-october-2026)) | Blocks |
| [Stale proof](../.agents/skills/review-verification/SKILL.md#who-recorded-it-and-when) ([11.10](decisions.md#area-11-verification-and-review-delivery-19-october-2026)): honest but possibly outdated | Disclosed; not a defect. Like missing proof, the reviewer weighs it |
| Architecture violation: a responsibility in the wrong layer, a second authority, or a dependency cycle between layers (7.11). This includes shared work that departs from [record 0016](../architecture/decisions/0016-shared-work.md): a duplicate run accepted, readiness polled, or a new claim or keys-in-flight map | Blocks |
| Non-canonical implementation: a patch, copied library logic, or hand-rolled code where the chosen stack (Effect, the official SDKs, zod) already provides it (6.1, 7.11) | Blocks |
| Missing proof, including a behaviour no test covers ([11.11](decisions.md#area-11-verification-and-review-delivery-19-october-2026)) | The reviewer's judgement, not an automatic block or follow-up: proceed if the proof present gives enough signal that the change is correct ([`inner-loop-reviewer`](../.agents/skills/inner-loop-reviewer/SKILL.md#what-this-role-owns)) |
| Test bloat | A follow-up, recorded with the lane; does not block |
| Preference, style, or a possible improvement | Noted; does not block |

## Evidence

What each lane supplies (7.2), judged as [`review-verification`](../.agents/skills/review-verification/SKILL.md) describes:

| Work | Evidence |
| --- | --- |
| Browser-facing | Screenshots, video and logs from the Chrome DevTools MCP |
| Backend, CLI or library | Logs and adequate telemetry, alongside tests where they are needed |
| Documentation | The content and its links; no capture needed |

Evidence goes into Records through the CLI once Records can take it (7.6). Ad-hoc verify scripts are not evidence.

## Report

Use the report shape in [`inner-loop-reviewer`](../.agents/skills/inner-loop-reviewer/SKILL.md#report). Blocking findings say which row of [what blocks](#what-blocks) they fall under; missing proof you let pass says why the proof present was enough.

## Sources

This standard and the reviewer skills draw on pstack's reviewer prompt and lead-judgment guidance (`references/reviewer-prompt.md` and `references/lead-judgment.md` in its `interrogate` skill), but replace the prompt's instruction to assume the stated intent is correct: the reviewer challenges intent and ownership first.
