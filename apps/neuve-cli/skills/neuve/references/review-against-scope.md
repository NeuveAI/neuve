# Judge against the scope

Part of the frame every Neuve reviewer works from, in the inner loop and in final review. The change is judged against its plan's scope and definition of done, together with the proof recorded for the range, and what you find becomes cited review comments and a verdict that follows from them.

## Understand the change first

Before anything else, know what you are looking at. For each changed file, ask what kind of code it is: framework scaffolding or a generated file, configuration, a test, or product code, and which stack and conventions it follows. A framework's root route or a generated client is judged as that, against the framework's conventions, not line by line on its mechanics. When you are unsure, read the stack's own pinned sources, as [stack.md](stack.md) says; a finding that misreads what the file is costs the reader more than it saves.

Then ask three questions, in this order:

1. **Scope.** What was the change meant to do? Read the ticket's "Done when" items, else its scope, else whatever scope was gathered.
2. **Behaviour.** What does it actually do now, including what it newly does to its callers?
3. **Proof.** What shows that, and what does it fail to show? ([review-verification.md](review-verification.md))

Write the review about behaviour, scope and proof first, and cite code to support it. Code quality is still reviewed: where the code sits, which component owns the responsibility, and whether it follows the canonical way of doing it in its stack and codebase.

## When scope is thin or missing

Scope comes from whatever is available. Never refuse or stop because a source is missing. Say what is missing and judge against what there is, plus the behaviour the change implies. Say which kind of scope you judged against:

| Scope you have | What it gives you |
| --- | --- |
| A plan or ticket that existed before the change | Intent, "Done when" items, validation requirements |
| A plan written inside the range it scopes | Probably the same, but that is a judgement call, not a fixed rule. Written in the range it scopes, it may describe the change rather than constrain it |
| Commit or pull request text | Weak scope: intent, with no "Done when" and no validation |
| Nothing | The behaviour the change implies; the rows are marked unlinked |

## Criteria rows

Each scope item gets one row with a status, what the change does about it, and the evidence:

- **met**: the change does it, and proof that agrees shows so;
- **not met**: the change fails it, and you can cite where;
- **no evidence**: nothing observed shows it either way, including when the only proof is out of date;
- **outside**: something the change affects that the scope never named, left for the reader's judgement.

A code reading can show a row is not met. It never makes a row met. That takes every applicable kind of proof, in records current for the unit, agreeing. An out-of-date record is disclosed and leaves the row at no evidence ([review-verification.md](review-verification.md#who-recorded-it-and-when)).

## Findings and what they become

Each finding becomes a review comment anchored on the lines it is about, with its kind and its evidence, and says whether it is about the code, the tests or the proof:

| Kind | What it is | What it becomes |
| --- | --- | --- |
| defect | A cited fault you verified, including bogus or forged tests or proof | A comment the request for changes rests on |
| risk | A concern the evidence supports but can't settle: an uncovered behaviour, a missing boundary case, test bloat, sources that can't be reconciled | A comment |
| question | Something the scope, context and code don't let you settle, such as unclear intent | A comment |
| pattern note | Code sharing a pattern where the change implies a rule | A comment, or a defect if the shared rule is broken |

A comment is information until a disposition (an approval or a request for changes) rests on it.

## Rules that are hard, and why

- **A request for changes rests on a cited, verified defect.** Read the code to confirm your own claim before you send work back. "Could be improved" is a comment. Sending work back without a defect costs a whole loop. The one other ground is missing proof, and only in the inner loop, where the reviewer may hold the work until proof gives enough signal ([inner-loop-reviewer.md](inner-loop-reviewer.md#what-this-role-owns)).
- **Citations must resolve** to lines that exist in the unit's owned ranges or in its cited context. A citation that points nowhere can't be checked, and an unchecked claim misleads the reader.
- **Judge only the unit's owned work.** Lines another unit owns, read-only neighbours and the rest of the batch inform the review but never receive its verdict. Every changed line has exactly one owning unit, so a finding about another unit's lines belongs to that unit.
- **Never approve human-required work.** Only a person's disposition closes it. [final-reviewer.md](final-reviewer.md#what-the-verdict-becomes-by-lane) gives what your verdict becomes on each lane.

## When proof is missing

The implementer records proof with `neuve proof record`, and you read it with `neuve proof list <base>..<head>` ([proof.md](proof.md)). A row that needs observed proof reads no evidence when no current record serves it, never met on the strength of a test's existence. An approval cites the records each requirement rests on, with its coverage, solid or shallow. Where none exists it says plainly that proof is not recorded, so the approval is visibly a judgement of the code, not a verified one. A unit is placed in static automation only when every one of its requirements has solid coverage.

## Worked example

A unit titled "Index writes retry when the database is busy", human-required. `Commit` used to fail on the first lock clash; it now retries.

| Done when | Status | What the change does | Evidence |
| --- | --- | --- | --- |
| Index writes retry when the database is busy | no evidence | Tries up to three times with growing waits, then returns `ErrIndexBusy` instead of the raw error. Proof is not recorded | Source, lines 29–36 |
| Cancelling a request stops index work | not met | Between attempts `time.Sleep` ignores `ctx`, so a cancelled request still waits up to 350 ms | Source, line 34; the index README says writers return when `ctx` is done |
| The busy path is covered by a test | no evidence | No test makes the database report busy, so the retry and the final `ErrIndexBusy` have never run under test | Gap |
| Callers see a new error | outside | Three functions call `Commit`; `sync.go` treats any error as fatal and will stop a sync on a busy index | The three callers |

The first row stays at no evidence although the code reads right, because a code reading never makes a row met.

The review then reads: "Not done yet: a cancelled request keeps waiting because the retry sleeps with `time.Sleep`; wait on a timer and `ctx.Done()` together, as the index README asks. No test forces the busy error; add one that expects three attempts, then `ErrIndexBusy`." Two cited points, no padding. The note about `sync.go` stays a risk for the reader, not a reason to send the work back. On this human-required unit it is a suggested review, never an approval.
