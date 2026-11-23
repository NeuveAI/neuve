# Adversarial review standard

Status: how Neuve's own build lanes are reviewed, from the owner's [design decisions](decisions.md) 7.1–7.3. It is also an example of what Neuve skills can prescribe (7.4). The product meaning of the inner-loop adversarial reviewer is in the [review modes foundation](../foundations/02-review-modes-and-cycles.md#adversarial-review).

## Reviewer guidance

Reviewers load the installed `neuve` skill and read its [inner-loop reviewer reference](../apps/neuve-cli/skills/neuve/references/inner-loop-reviewer.md), which says how to work (skepticism, reading first, results against the scope, a planted problem, a short review), what the role owns and the report. It sends the reviewer to the references below, which carry the frame of reference for adversarial review ([11.7](decisions.md#area-11-verification-and-review-delivery-19-october-2026) as amended by [14.36](decisions.md#area-14-lane-assignment-and-agent-dispositions-redesigned-12-november-2026); 14.38):

| Reference | What it carries |
| --- | --- |
| [`review-verification`](../apps/neuve-cli/skills/neuve/references/review-verification.md) | Proof converges (11.1, 11.9); the kinds of proof and what each can establish; who recorded it and out-of-date (not forged) proof (11.10); good tests (11.2); bogus or forged tests and proof (10.63) |
| [`review-independence`](../apps/neuve-cli/skills/neuve/references/review-independence.md) | Fresh context, decide before you reveal, skepticism, defects versus preferences (11.4) |
| [`review-against-scope`](../apps/neuve-cli/skills/neuve/references/review-against-scope.md) | Judging against the scope and definition of done, criteria rows, finding kinds, the hard rules (11.3, 11.5) |
| [`final-reviewer`](../apps/neuve-cli/skills/neuve/references/final-reviewer.md) | Final review never blocks (11.11); lane-blind review (10.33); what the verdict becomes by lane (4.5, 4.13, 4.14); suggested reviews; later reviews (10.68) |

Those references are the single authority for how to judge; they are written for anyone who installs the CLI, so they carry no decision numbers. This standard keeps only the process for Neuve's build lanes: setup, code quality, time box, what blocks, evidence to supply and the report. A change to the references reaches lanes with the next release, as the [lane loop](neuve-in-the-loop.md#which-neuve-runs) says.

## Setup

Lanes and who reviews them follow the [lane rules in `AGENTS.md`](../AGENTS.md#how-agents-build-neuve), from [decisions 7.1 and 7.7](decisions.md#area-7-how-agents-build-neuve-16-october-2026).

The reviewer's brief shares only the task's definition of done and its scope, never the implementer's own account as a premise (7.1).

No Neuve review runs inside the inner loop. Once you approve, you request one Neuve review of the lane's whole range, as the [lane loop](neuve-in-the-loop.md#the-loop) describes ([14.35](decisions.md#area-14-lane-assignment-and-agent-dispositions-redesigned-12-november-2026)). Its findings are information: the requests for changes that hold up start a new cycle, in which the fix comes back to you through the inner loop before the next final review. Say in your report which ones you sent back and why. Don't write a verdict on each finding.

## Placement and code quality

Code must be in good order (7.11). Check that:

- each new piece of code sits in the layer and module that owns the responsibility ([architecture](../architecture/README.md)), with no new god objects;
- abstractions are small, named for what they do, and organised by domain;
- the implementation follows canonical sources: the official documentation of Effect, Bun, zod, ACP, MCP and the provider SDKs, and the established patterns of the codebase;
- code made irrelevant or deprecated by the change is removed, not left beside the new code;
- work that more than one caller can ask for follows [record 0016's shared work](../architecture/decisions/0016-shared-work.md). Never suggest duplicate runs, polling or a new lock as a simplification.

## Time box

About 30 minutes per review (7.1). Spend it on what could be wrong in ways that matter, not on completeness of ceremony. Read the code and the scope before any account of the work, and plant a problem where that shows whether a test or a validation really catches it ([14.38](decisions.md#area-14-lane-assignment-and-agent-dispositions-redesigned-12-november-2026)). A dragged-out review costs time and metered usage.

## What blocks

| Finding | Outcome |
| --- | --- |
| Correctness defect | Blocks |
| Security defect | Blocks |
| Bogus or forged tests or proof, including a record that claims to describe the reviewed code while its artefact shows another revision ([10.63](decisions.md#area-10-harness-m3-18-october-2026); [11.10](decisions.md#area-11-verification-and-review-delivery-19-october-2026)) | Blocks |
| [Stale proof](../apps/neuve-cli/skills/neuve/references/review-verification.md#who-recorded-it-and-when) ([11.10](decisions.md#area-11-verification-and-review-delivery-19-october-2026)): honest but possibly outdated | Disclosed; not a defect. Like missing proof, the reviewer weighs it |
| Architecture violation: a responsibility in the wrong layer, a second authority, or a dependency cycle between layers (7.11). This includes shared work that departs from [record 0016](../architecture/decisions/0016-shared-work.md): a duplicate run accepted, readiness polled, or a new claim or keys-in-flight map | Blocks |
| Non-canonical implementation: a patch, copied library logic, or hand-rolled code where the chosen stack (Effect, the official SDKs, zod) already provides it (6.1, 7.11) | Blocks |
| Missing proof, including a behaviour no test covers ([11.11](decisions.md#area-11-verification-and-review-delivery-19-october-2026)) | The reviewer's judgement, not an automatic block or follow-up: proceed if the proof present gives enough signal that the change is correct ([`inner-loop-reviewer`](../apps/neuve-cli/skills/neuve/references/inner-loop-reviewer.md#what-this-role-owns)) |
| Test bloat | A follow-up, recorded with the lane; does not block |
| Preference, style, or a possible improvement | Noted; does not block |

## Evidence

What each lane supplies (7.2), judged as [`review-verification`](../apps/neuve-cli/skills/neuve/references/review-verification.md) describes:

| Work | Evidence |
| --- | --- |
| Browser-facing | Screenshots, video and logs from the Chrome DevTools MCP |
| Backend, CLI or library | Logs and adequate telemetry, alongside tests where they are needed |
| Documentation | The content and its links; no capture needed |

Evidence goes into Records through the CLI: lanes record proof for the range with `neuve proof record`, and reviewers read it with `neuve proof list` (7.6). Judge DevTools captures and logs a lane supplies outside Records directly for convergence. Ad-hoc verify scripts are not evidence.

## Report

Use the report shape in [`inner-loop-reviewer`](../apps/neuve-cli/skills/neuve/references/inner-loop-reviewer.md#report). Blocking findings say which row of [what blocks](#what-blocks) they fall under; missing proof you let pass says why the proof present was enough.

## Sources

This standard and the reviewer references draw on pstack's reviewer prompt and lead-judgment guidance (`references/reviewer-prompt.md` and `references/lead-judgment.md` in its `interrogate` skill), but replace the prompt's instruction to assume the stated intent is correct: the reviewer challenges intent and ownership first.
