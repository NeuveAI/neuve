---
name: review-against-scope
description: Judge a change against its plan's scope and definition of done, row by row, and turn what you find into cited review comments and a disposition that follows from them. Load it whenever a review must reach a verdict or fill "Done when" rows, in the inner development loop or in final review; the reviewer role skills load it for you.
---

# Review against scope

Part of the frame of reference every Neuve reviewer works from ([11.7, the owner's ruling that these skills are the single authority for it](../../../process/decisions.md#area-11-verification-and-review-delivery-19-october-2026)). The change is judged against the plan's scope and definition of done, together with the proof recorded for the range (11.3).

## Understand the change first

Before anything else, know what you are looking at ([11.13](../../../process/decisions.md#area-11-verification-and-review-delivery-19-october-2026)). For each changed file, ask what kind of code it is: framework scaffolding or a generated file, configuration, a test, or product code, and which stack and conventions it follows. A framework's root route or a generated client is judged as that, against the framework's conventions, not line by line on its mechanics. Read the stack's own sources or documentation when you are unsure; a finding that misreads what the file is costs the reader more than it saves.

Then ask three questions, in this order (11.5):

1. **Scope.** What was the change meant to do? Read the ticket's "Done when" items, else its scope, else whatever scope was gathered.
2. **Behaviour.** What does it actually do now, including what it newly does to callers?
3. **Proof.** What shows that, and what does it fail to show? (See [review-verification](../review-verification/SKILL.md).)

Write the review about behaviour, scope and proof first, and cite code to support it; this is how the delivery stops read (11.5). Code quality is still reviewed: placement, ownership and canonical implementation ([7.11](../../../process/decisions.md#area-7-how-agents-build-neuve-16-october-2026)).

## When scope is thin or missing

Scope comes from whatever is available ([1.8](../../../process/decisions.md#area-1-product-loop-and-roles-16-october-2026)). Never refuse or stop because a source is missing: disclose the gap and judge against what there is, plus the behaviour the change implies. Say which stratum you judged against ([9.13, scope strata](../../../process/decisions.md#area-9-benchmark-m4-17-october-2026)):

| Stratum | What it gives you |
| --- | --- |
| Plan or ticket at the base | Intent, "Done when" items, validation requirements |
| Plan only inside the range | The same. My reading, not a ruling: written in the range it scopes, it may describe the change rather than constrain it |
| Commit or PR text | Weak scope: intent, with no "Done when" and no validation |
| Nothing | The behaviour the change implies; the rows are marked unlinked |

## Criteria rows

Each scope item gets one row with a status, what the change does about it, and the evidence ([10.67, the Guided contract](../../../process/decisions.md#area-10-harness-m3-18-october-2026)):

- **met**: the change does it, and proof that converges shows so (11.1);
- **not met**: the change fails it, and you can cite where;
- **no evidence**: nothing observed shows it either way, including when the only proof is stale;
- **outside**: something the change affects that the scope never named, left for the reader's judgement.

A code reading can show a row is not met. It never makes a row met: that takes every applicable kind of proof, in records current for the unit, agreeing (11.1). A stale, possibly outdated, record is disclosed and leaves the row at no evidence ([11.10](../../../process/decisions.md#area-11-verification-and-review-delivery-19-october-2026); see [review-verification](../review-verification/SKILL.md#who-recorded-it-and-when)).

### Worked example

The review desk's sample unit, "Index writes retry when the database is busy" (SHR-318), human-required. `Commit` used to fail on the first lock clash; it now retries.

| Done when | Status | What the change does | Evidence |
| --- | --- | --- | --- |
| Index writes retry when the database is busy | no evidence | Tries up to three times with growing waits, then returns `ErrIndexBusy` instead of the raw error. Proof is not recorded ([10.83](../../../process/decisions.md#area-10-harness-m3-18-october-2026)) | Source, lines 29–36 |
| Cancelling a request stops index work | not met | Between attempts `time.Sleep` ignores `ctx`, so a cancelled request still waits up to 350 ms | Source, line 34; the index README says writers return when `ctx` is done |
| The busy path is covered by a test | no evidence | No test makes the database report busy, so the retry and the final `ErrIndexBusy` have never run under test | Gap |
| Callers see a new error | outside | Three functions call `Commit`; `sync.go` treats any error as fatal and will stop a sync on a busy index | Graph, three callers |

The owner's desk sample predates 11.1 and marks the first row met; a code reading never makes a row met.

The review then reads: "Not done yet: a cancelled request keeps waiting because the retry sleeps with `time.Sleep`; wait on a timer and `ctx.Done()` together, as the index README asks. No test forces the busy error; add one that expects three attempts, then `ErrIndexBusy`." Two cited points, no padding. The blast radius note about `sync.go` stays a risk for the reader, not a reason to send the work back.

## Findings and what they become

Each finding becomes a line-anchored review comment with its kind and its evidence, and says whether it is about the code, the tests or the proof ([10.69](../../../process/decisions.md#area-10-harness-m3-18-october-2026), [10.63](../../../process/decisions.md#area-10-harness-m3-18-october-2026)):

| Kind | What it is | What it becomes |
| --- | --- | --- |
| defect | A cited fault you verified, including bogus or forged tests or proof | A comment the request for changes links to |
| risk | A concern the evidence supports but cannot settle: an uncovered behaviour, a missing boundary case, test bloat, sources that cannot be reconciled | A comment |
| question | Something the scope, context and code do not let you settle, such as unclear intent (a finding kind in the [M3 proposal's §9.3 output schema](../../../process/proposals/m3-harness.md#93-how-the-prompt-is-framed)) | A comment |
| pattern note | Code sharing a pattern where the change implies a rule ([9.10](../../../process/decisions.md#area-9-benchmark-m4-17-october-2026)) | A comment, or a defect if the shared rule is broken |

A review comment is informational until a disposition references it.

## Rules that are hard, and why

- **A request for changes rests on a cited, verified defect** ([10.66](../../../process/decisions.md#area-10-harness-m3-18-october-2026)). Read the code to confirm your own claim before you send work back. "Could be improved" is a comment. Sending work back without a defect costs a whole loop. The one other ground is missing proof, and only in the inner loop, where the reviewer may hold the loop until proof gives enough signal ([11.11](../../../process/decisions.md#area-11-verification-and-review-delivery-19-october-2026); see [inner-loop-reviewer](../inner-loop-reviewer/SKILL.md#what-this-role-owns)).
- **Citations must resolve** to lines that exist in the unit's owned ranges or in its cited context. A citation that points nowhere cannot be checked, and an unchecked claim misleads the reader.
- **Judge only the unit's owned work.** Sibling-owned lines, read-only neighbours and same-batch context inform the review but never receive its disposition; a finding about them belongs to their unit. Units are grouped by file and proximity and never regrouped by behaviour ([4.1](../../../process/decisions.md#area-4-units-lanes-and-dispositions-16-october-2026)), because every changed line has exactly one owner.
- **Never approve human-required work** ([4.5](../../../process/decisions.md#area-4-units-lanes-and-dispositions-16-october-2026)). Only a person's disposition closes it; that is the human gate. [final-reviewer](../final-reviewer/SKILL.md) gives the mapping by lane.

## When proof is missing

Proof records exist since the proof-recording slice landed ([11.8](../../../process/decisions.md#area-11-verification-and-review-delivery-19-october-2026)). A row that needs observed proof reads no evidence when no current record serves it, never met on the strength of a test's existence. An approval cites the records each requirement rests on, with its coverage, solid or shallow; where none exists it says plainly that proof is not recorded, so the approval is visibly a code judgement, not a verified one ([10.83](../../../process/decisions.md#area-10-harness-m3-18-october-2026)). Static automation takes every requirement solid ([10.82](../../../process/decisions.md#area-10-harness-m3-18-october-2026)).

In Neuve's build lanes, lanes record their proof for the range with `neuve proof record`, and reviewers read it with `neuve proof list`. Judge DevTools captures and logs a lane supplies outside Records, as the [review standard's Evidence section](../../../process/adversarial-review-standard.md#evidence) describes, directly for convergence.
