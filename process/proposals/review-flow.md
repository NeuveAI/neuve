# The review flow: lane assignment and agent dispositions, redesigned

Status: the guide for the sessions building NEU-148, which brings back lane assignment and agent dispositions. Commit `9dde51ad` removed both on 4 November without saying so, and 13.18 gave their return maximum priority, "redesigned from the system design up", before the open-source cut. The owner's rulings of 12 and 13 November are [Area 14 of the decisions record][A14], cited here by number; the record wins wherever this differs, and [section 5](#5-what-this-changes-in-the-decisions) lists the rows they change. Everything else is the NEU-148 coordinator's design, under the owner's mandate to decide engineering as tech lead (14.11), including the records and readers design notes (`design/records-design.md` and `design/readers-design.md` in the NEU-148 coordination folder). Area 13 is not on main yet: its rows are cited by number and land with the release's decisions branch. The scope lives once, in NEU-148 and its child issues in Linear.

## Where it stands

On 13 November 2026 three reviewed batches of NEU-148 are on main, at `1ea742ba`. A fourth is forming on the integration branch: what is merged there is reviewed but has not had its full check.

| State | What |
| --- | --- |
| On main | The step order and the finders' opening (2.3); blob structure, section keys, change facts, rule judgements, reading groups and units by section, off (2.1); both readings and code's decisions, in probe mode only (2.2, 2.4); the new record kinds, identity and lineage (2.5); the publisher and follow-on requests, which nothing calls yet, and a person's carried decisions through the publisher (2.6); Graph's callers per commit, capped at 256 MiB; on the desk, push updates, the "No agent decision in this run" note and carried decisions under "Decided" |
| Reviewed, waiting in the fourth batch | The carry rule rebuilt on a person's last act (2.6); which files the repository declares as tests, following a wrapper named in the test runner's preload |
| Being built | A marker when the reading budget cuts a lookup result; the call's own line in Graph's callers; readings shown the declaring lines of removed code, Lane review asked whether a change was asked for, Assess asked what tests it; the missing-callers gap without its test half (14.19); the desk's dock change |
| Not started | The finders' last turn as an ordinary turn, lookups per lens and the credential lookup before the call slot; rules used by the readings beyond generated files; pattern families; a second model for Lane review; one waiter per batch and the review task calling the publisher; carried agent judgements; the desk's "same pattern as" and rule disclosures |

**Off by default.** Every part is behind a setting that is off. With the settings absent, a review runs the fixed-shape trial of [record 0005](../../architecture/decisions/0005-harness-pipeline.md) with the new step order and publishes what it published before. In probe mode (`review.sectionReadings: "probe"`) a review plans, runs, decides and records both readings, and publishes exactly what it would have published without them. No setting yet makes the readings publish.

**Before the readings go on by default**, which waits for the owner's look (14.11):

1. The carry rule's redesign has landed.
2. The cost of reading callers is measured with Graph search on, on prepared stores.
3. The effort default is settled by a paired run under a rule fixed in advance.
4. Reading-content rounds for removed lines, out-of-scope changes and missing tests are measured on planted problems.
5. A publishing setting exists and the per-batch publisher is called.

[Section 9](#9-where-the-12-november-design-and-the-code-disagree) lists where the 12 November design and the code disagree.

**Words.** Working words for this design, never product terms (14.16):

- A _section_ is part of one file's changed lines, cut at Graph's symbol boundaries (a class kept whole, Markdown by heading, a named line-window fallback elsewhere), as [12.57][A12] has Graph supply them; [10.109][A10] calls them responsibility sections. A review unit is a file's sections that share a review lane.
- A _reading group_ is a set of related sections that code packs to a size bound for one model call. It never decides a review unit or a batch.
- _Assess_ is the reading that asks whether a section needs a person: both axes of the lane matrix with cited evidence, the validation requirements it names, impact and gaps. It supplies the inputs of the review lane, never the lane.
- _Lane review_ is the reading that asks whether a section is right: a verdict, comments, findings and what was checked. It never sees the review lane or Assess's answer. The stage names are `assess` and `lane-review`; receipts and progress lists may show "Assess" and "Lane review" for now (14.16).
- A _code risk floor_ is the least cautious review lane code allows for a section, from rules over recorded facts ([12.33][A12]'s floor). A model can only raise it.
- The _backstop_ is where a section no agent could judge goes: human-required, with one plain note that no agent decided it in this run (14.4).

Product terms they sit beside, used as the [vocabulary](../../vocabulary.md) defines them: review unit, batch, review lane, disposition, validation requirement, checkpoint, packet (internal). "Finding" is used as [10.69][A10] uses it.

## Starting facts

Measured locally on 25-, 100- and 420-commit ranges of this repository, one run each unless stated. The run files and the research behind the design (`research/headroom.md` on where a review's time went, the three adversarial reviews, the impact maps and `research/harness-literature.md`) are in the NEU-148 coordination folder on the owner's drive, outside the repository.

| Fact | Numbers | Source |
| --- | --- | --- |
| Before: one packet, published late | Published at 322 / 339 / 359 s; Precompute 37 / 45 / 60 s; units existed at 118 / 161 / 177 s; finders read 50 / 17 / 7% of added lines and almost no deleted line; 131/187, 438/514 and 1,147/1,238 units untouched by any finder | `reports/ladder-merged-main.md` |
| After the reordering and the new opening (on main) | Published at 173 / 177 / 146 s with the opening, 181 / 150 / 174 s with readings starting early (off); about 40 s is noise between runs | The timeline lane's paired timing run, `logs/timeline/paired-2` |
| Planted problems caught by the finders | 9 of 15 on old main; 12 of 15 with the new opening, both deleted-line plants caught on the line, output tokens down 19%; 13 of 15 with readings starting early | Gates lane, set C |
| Sections | 1,784 / 5,408 / 10,844 sections in 61 / 180 / 363 reading groups, against 230 / 618 / 1,484 hunks | The sections lane's measurement on the same ranges |
| Readings' reach in one ten-minute run, 25 commits | Sections judged by both readings: 38% at high effort, 95% at medium, before the early start; 57% at the default effort with it | `reports/readers-1.md` and the readers' seam probe |
| Graph callers | Resolved and receiver-type matches were right in hand checks; name-only matches were often wrong; every index today records a call at the calling function's first line, not the call's own line | `reports/graph-relations-measures.md`, the graph lane's hand checks |

What the outside evidence says, strongest first:

| Finding | Strength | Source |
| --- | --- | --- |
| Hand the model what the pipeline holds and let it fetch only what lies beyond. A capped retrieval agent of 4 turns of 8 parallel calls matched 10–20 serial turns | Strong in direction; before NEU-148, 85–100% of what the finders read was already held by Precompute | [Cognition, SWE-grep](https://cognition.com/blog/swe-grep); [Agentless](https://arxiv.org/abs/2407.01489) |
| Output tokens set latency; input barely does. Effort is the main control, and its quality cost is task-specific | Strong for the mechanism | [OpenAI latency guide](https://developers.openai.com/api/docs/guides/latency-optimization); [Anthropic effort](https://platform.claude.com/docs/en/build-with-claude/effort) |
| A small structured reading beats more raw context: eight models all got worse as file and repository context was added. Counterpoint: about one reference comment in six needs repository context | Medium; young preprints | [SWE-PRBench](https://arxiv.org/abs/2603.26130); [AACR-Bench](https://arxiv.org/abs/2601.19494); [Chroma, context rot](https://research.trychroma.com/context-rot) |
| Fan out per unit, then verify, dedupe and rank | Strong as a pattern; latency data thin | [Uber uReview](https://www.uber.com/en-IN/blog/ureview); [Claude Code Review](https://claude.com/blog/code-review) |
| Bounded agentic exploration beats diff-only review. Nobody compares it with rich prepared context | Medium | [OpenAI, scaling code verification](https://alignment.openai.com/scaling-code-verification/); [Cursor Bugbot](https://cursor.com/blog/building-bugbot) |
| Progressive delivery cut time to first comment by about 90% | Vendor-measured | [CodeRabbit IDE review](https://dev.to/coderabbitai/how-we-built-our-ai-code-review-agent-for-ides-4bpf) |
| Incremental re-review of changed commits is common practice; no source measures its quality effect | Practice only | [CodeRabbit auto review](https://docs.coderabbit.ai/configuration/auto-review) |

## 1. First principles

A review takes a Git range and its stated intent and returns review units, each with owned ranges, a review lane, its lane's judgement, comments and a disposition. It must be:

| Property | What it means | Rows behind it |
| --- | --- | --- |
| Complete | Every changed line is owned by exactly one unit, removed lines included | [10.21][A10] (one authority for what a unit owns), [12.31][A12] ("no lever removes a hunk from coverage"), 13.20 |
| Decided | Every unit carries its lane's judgement, comments and disposition; what no agent could judge gets a lane by rule | 13.23, 14.4 |
| Conservative | Failure of any kind ends with a person, never with an approval. Floors only raise; a gap never lowers high-and-hard work | [12.33][A12], [10.9][A10], [4.13][A4] |
| Provable | An approval that closes work without a person rests on two independent readings and on proof state set by code | [11.16][A11], [10.82][A10], [10.83][A10], [11.1][A11] |
| Bounded | Ten minutes per run; larger work continues in a follow-on run | [10.15][A10], [10.26][A10], [10.95][A10], 14.6 |
| Incremental | The same inputs do the same work once; unchanged inputs carry their judgement; lanes can be recomputed from records | [Record 0016](../../architecture/decisions/0016-shared-work.md), [12.35][A12], [10.140][A10] ("what was measured is what runs") |

The five rules for the model's time follow from the starting facts:

1. **No model turn fetches what code holds.** Code prepares the reading; the model judges.
2. **Width, not depth.** Shorten the longest chain of model calls and use the idle slots.
3. **Depth by risk.** Every section is read; tool-using work goes where risk is, and readings start riskiest first.
4. **Never redo work whose inputs did not change.** Content keys, carried judgements, preparation before the review is asked for.
5. **Output tokens are the time.** Answers by exception, prose once per unit.

The owner set the order (14.1): first remove chaining and idle time, then wasteful reads, then add readers in the idle call slots, riskiest first, without extending the run.

## 2. The design

```
Precompute: hunks, sections, change facts, rules, floors, reading groups
  ├─▶ Assess and Lane review per reading group, riskiest first       (start right after Precompute)
  └─▶ Frame ─▶ four finders (start when Frame lands) ─▶ Verify per finding, as it is recorded
      Frame ─▶ Map
        all of these ─▶ code decides per section: lane, proof state, units, dispositions
                      ─▶ publisher, one settled batch at a time ─▶ cumulative packets
```

### 2.1 Prepared by code

| Part | What it is | State |
| --- | --- | --- |
| Blob structure | Graph's symbols and outline per blob, stored beside the chunks in the same Precompute pass, so unit building adds no Graph read | On main |
| Section key | SHA-256 over a versioned recipe and the section's path, side, kind, name, span text, its own changed rows (no line numbers) and an ordinal; nothing from a model, batch or run. A rename does not carry | On main (`section-identity.ts`) |
| Change facts | Added, removed, signature or body changed, declared kind, symbols removed. No public names: `withPublicSurface` in `lane-rule.ts` stays their one authority | On main (`section-facts.ts`) |
| Units by section | `review.responsibilitySections`: a file's changed lines cut at its own structure. Off: units and keys as before | On main, off |
| Rule judgements | Code-decided sections, recorded with rule and inputs: generated (repository declarations and GitHub Linguist's generated and vendored lists, 14.18), blank rows beside an unchanged declaration, moved unchanged, Markdown prose; token rules for whitespace, comments and imports. Deletion-only, rule version 2 (name-only callers kept as such) | On main |
| Rules used by the readings | Only generated files skip every reading; every other rule replaces Assess while Lane review still reads once with the rule shown. Narrower than the owner's approval (14.17), after the hand checks | Not started |
| Pattern families | A repeated change judged once through a representative, at least 21 tokens of changed content | Not started |
| Removal floor | A section that removes a declaration or a public name is at least human-suggested | On main, off until the lanes evaluation measures it |
| Reading groups and plan | Sections packed deterministically to a size bound; the plan holds keys, facts, floors, groups and each group's rank (a sort order from code facts, never a score, [10.22][A10]) | On main |
| Graph callers per commit | One bulk read of the callers index per commit, shared across reviews, with how each row was matched | On main: the engine and reader, imports from the syntax tree, the read at commit preparation (readings on only), how each row was matched, the tightened name-only rule and one shared decode. Being built: the call's own line |
| Test declarations | Which files the repository declares as tests, following a wrapper named in the test runner's preload | Waiting to land |
| Cap on stored callers | 1 GiB by bytes, oldest first, through Records' eviction of declared recomputable kinds (14.21) | On main with a 256 MiB cap; the 1 GiB cap is in the fourth batch |

### 2.2 The two readings (on main, behind `review.sectionReadings: "probe"`)

| | Assess | Lane review |
| --- | --- | --- |
| Asks | Does this need a person? | Is this right? |
| Writes | Both axes of the lane matrix with cited evidence, requirement names, impact, gaps; picks the cautious level when unsure | Per section approve, request changes or unsure; comments; what was checked |
| Never sees | The lane, the floor, the goal | The lane, Assess's answer, the floor, the finders' findings ([10.33][A10], [10.64][A10], [2.16][A2]) |
| Turns | Two; the second exists only to resend a refused answer | Three; the first is for its lookups |
| Stage name | `assess` | `lane-review` (14.16) |

- Readings start right after Precompute and read up to the run's cut-off, never delaying a finder; the scheduler keeps a turn reserve for each review's own steps and at least a quarter of the slots for readings.
- Each reading sets its own effort; the default is high, and effort by risk is behind `review.sectionReadingsEffort` (14.15). Whether medium becomes the default is decided by a paired run under a rule fixed in advance.
- Every model step claims its computation key before it sends, so two callers never both call the model (record 0016).
- A failed, refused or orphaned reading ends as "not judged" for its sections and never fails the review; credential failures still hold it.
- Each reading is shown the stored callers and test callers of the code it reads, as context. Nothing they show lifts a gap (2.4).
- **Being built:** readings shown the declaring lines of removed code; Lane review asked whether a change was asked for; Assess asked what tests it; each behind a setting and measured on planted problems under a rule fixed in advance.
- **Not started:** a second model for Lane review where one is signed in. Today it is the same model in a fresh context.

### 2.3 The step order, the finders and Verify (on main)

- Frame starts once the hunks and scope exist; lead search and both tree indexes run as keyed background work that Link still awaits. The head tree index is built early, so finders no longer wait on it.
- The four finders of [12.41][A12] stay: scope fit, correctness, risky edges, tests. They hunt across the whole change and start when Frame lands, in the front task's commit; they do not wait for Map. Code places each finding by its primary hunk.
- Their opening (14.2): a structured diff by section, bounded in size, with deleted lines shown and every handed-over line citable, old side included, built from what Precompute holds; a read takes many ranges.
- Verify runs once per distinct finding, keyed by its claim, and starts when the finding is recorded (`harness.verify`, created inside `record_finding`'s commit). Findings from Lane review go through the same Verify.
- Verify has three outcomes. Confirmed: the finding stands. Refuted: it keeps its rank and fate ([10.146][A10]) and is not published as a comment. Neither: the section gets the backstop (14.4). Code never turns a request for changes into an approval.
- Ranking with each finding's fate, and the noise bound of under one point in ten ([10.143][A10]), stay.
- Each wait is attributed in telemetry: for inputs, for a call slot, running.
- **Being built:** a marker when the reading budget cuts a lookup result, so a cut data block is closed and says it was cut.
- **Not started:** the finders' last turn as an ordinary turn whose prompt names the submit tool (14.15), lookups offered only to lenses that can use them, and the credential lookup before the call slot. They touch files the Claude sign-in work owns, which waits for the owner's own review.

### 2.4 Code decides (on main, used only in probe mode)

- **Lane per section**, lane rule 3 (`LANE_RULE_VERSION = 3`): `laneOf` over the recorded assessment, then the public-surface raise, then the floors, so a floor only raises. The lanes evaluation recomputes it from the record alone.
- **Gaps by code.** Missing callers are a gap on every section not declared test, documentation or generated (14.5), so it goes to human-suggested; a gap never lowers high-and-hard work. A section whose file structure could not be read gets a structure gap.
- **The gap does not lift today.** The rule needs, for every symbol a section changes, a trusted caller row and a trusted test row, matched by resolution or receiver type, at the call's own line. No engine index records the call's own line yet, so no gap lifts. Under 14.19 the test half goes: being built.
- **Proof state** from proof records and their currency, never by an agent (`proof-state.ts`, [11.16][A11] to [11.22][A11]). Static automation needs every requirement Proven ([10.82][A10]), so it stays empty until proof is recorded.
- **Units:** a file's settled sections that share a lane, within a batch ([10.109][A10], [10.120][A10]). A unit requests changes if any section does, and approves only when Lane review approved and no claim on it is unconfirmed or unchecked.
- **Dispositions** through `applyLane` in [`disposition.ts`](../../packages/harness/src/disposition.ts); on agentic work a confirmed defect cannot be approved over (13.25).

Work closes without a person only when Assess places it low risk, Lane review approves independently, and code sets the proof state from what is recorded. A wrong closure needs both readings wrong in the same direction.

| A section's outcome | Review lane | Disposition |
| --- | --- | --- |
| Assess low and easy, every requirement Proven, Lane review approves | Static automation | Green status |
| Assess places it agentic, Lane review approves | Agentic | Agent approval, citing proof or saying none is recorded ([10.83][A10]) |
| A confirmed finding | By the rule | Request for changes resting on its comments |
| Assess places it human-suggested, or a gap | Human-suggested | Lane review's, applying unless a person steps in |
| Assess high and hard | Human-required | Lane review's verdict as the suggested review; never an approval |
| Unsure, failed twice, too large, unreadable (binary or mode only), a finding neither confirmed nor refuted, or a request for changes whose every finding was refuted | Human-required, by cause: `unsure`, `failed`, `too-large`, `unreadable`, `unconfirmed`, `disagreed` (14.4, 14.13) | None; the note "No agent decision in this run" |
| Not reached by the cut-off | Not settled: its batch waits for the follow-on run; human-required, cause `not-reached`, only once no follow-on run is left (at most 8) | None |
| A provider quota refusal | Pending, with a disclosed gap; no follow-on run asked for | None |
| Lockfiles and declared-generated files | The code-only batch, as today | As today |

Credential failures (`auth`, `sign_in`, `binding`) still hold the review. The backstop note is a gap disclosure, never a lane rationale ([10.110][A10]), and a backstopped unit has no suggested review. Code ranks each unit's findings and Lane review's comments (impact first, then confirmed defects, risks, questions, pattern notes): the desk shows the top three, the rest keep rank and fate.

### 2.5 Identity and records (on main)

- A unit's key is the hash of its section keys; its ID keeps the cycle and run key. Same ID means the same sections, so nothing a person decided ever covers lines they did not see.
- A batch's key is the hash of its sorted file paths, never Map's group number.
- New record versions, never a widened kind, because an older build reads a known kind that fails its schema as corrupt ([12.56][A12]): `unit.recorded@3` (sections by reference, no grouping bound, no truncation past 1,024 ranges), `assessment.recorded@4` (lane, rule version, per-section trail and undecided counts by cause), `comment.recorded@3` (the `impact` kind with its effect, 13.20), `lineage.recorded@1` (how a unit relates to earlier units: `unchanged` or `changed`), `packet.published@2` (cumulative, with pending and undecided counts). Projector version 11; store schema 20 (the eviction tables).
- Older builds skip every new kind and show no review for a new-style review, with a one-line notice (14.13).
- `neuve review show` indents stored text so it cannot pose as one of its own lines (14.14).

### 2.6 Per-batch publication, follow-on runs and carried decisions

- **The publisher (on main, not called).** `publishSettled` publishes settled batches in the review's batch order as cumulative packets, each superseding the last; a published batch is frozen; each publication's plan is decided once as shared work keyed by cycle, run key and the previous packet, so a replay writes the same bytes (14.3). Because the finders hunt across the whole change, the first batch publishes after the four finders and their Verify calls have settled. A later review of the same range under another configuration publishes once, when complete (14.13).
- **Follow-on runs (on main, not called).** Records' `requestFollowOn` appends the next generation of a request under a cap the caller passes (at most 8 follow-on runs; none on a quota refusal, 14.6). Nothing asks for one yet.
- **A person's decision carries (on main, through the publisher only).** When every section of a new unit has the same key in one earlier unit a person decided, that decision is recorded on the new unit as carried and closes it (14.12). A carried request for changes keeps its comments; an approval is not carried when the new review disputes the unit.
- **The carry rule is rebuilt (waiting to land).** Reviews found orderings in which a decision the person withdrew or replaced was still carried on main; all are reachable only through `publishSettled`. The new rule: a person's last act, in the store's order, on any earlier unit that holds one of the new unit's section keys, following overlapping units too, decides what carries; anything else is withheld with a gap saying a person decides again. Nothing may call `publishSettled` in a real review until it lands.
- **Not started:** one waiter per batch that publishes a batch as soon as it is settled, and the review task's publish phase calling the new publisher.
- **The desk (on main).** Told of new results by push, not by a one-second read (14.14); a unit no agent decided shows "No agent decision in this run" with no suggested review; carried decisions close unchanged units under "Decided"; a review replaced whole tells a reader once. The words are "Needs your decision" (14.16). **Being built:** the dock change, last. **Not started:** "same pattern as" and the rule disclosures.

### 2.7 How the durable task runtime shapes it

| Need | How pi-durable and record 0016 give it | What it avoids |
| --- | --- | --- |
| Readings start right after Precompute, riskiest first | The review task creates one `neuve.reading` task per reading group and kind, each with its rank, a sort order from code facts that is never stored or shown as a score ([10.22][A10]). Sections already judged under the same key are left out of the plan | A coordinator that releases work and polls slots or timers, which record 0016 forbids |
| A reading's own work | Four phases: read (one agent step); check (every section answered, the rest read once more alone); claims (Lane review only: one Verify per distinct finding, created in one commit); done. It always completes, with one outcome per section | A failed child failing the review |
| Frame starts early | Precompute commits the front child once hunks and scope exist; leads and both tree indexes run as keyed background children that the link phase still awaits | Ordering waits with no data dependency |
| Verify at record time | `record_finding` creates the Verify child in its own tool commit, owned by the finder task, so a crash replay creates it once | Waiting for the finder's submit |
| A batch is decided (not started) | One batch waiter per batch, whose `on` names that batch's reading tasks and the four finders (a finder's end includes its Verify children; `on` may name tasks that are not children). So no batch publishes before the last finder ends | A wake on any child, which pi-durable does not have |
| Two callers, one model run | The conversation becomes the `compute` of the step's own `store.run`, the existing cross-process claim: the step claims its key before it sends and settles or fails it when it ends, also on a resume or a hold (on main) | Lookup, then call, then store, where both callers call the model |
| Failure per section | The collector maps a failed, faulted or orphaned reading to "not judged" and never fails the review; inside the step a provider failure on these kinds ends the step with a recorded outcome instead of a hold | One held step ending the whole attempt |
| The cut-off | A reading not started is `not-reached`; one in flight is interrupted. Neither is stored, so the follow-on run's lookups find every stored answer and run only the rest | A partial batch on the desk |
| Readings and finders share the slots | The scheduler's contract: a rank from 0 to 1,000,000 within one run; a turn reserve for each review's own steps (Frame, Map, finder turns, Verify); readings always hold at least a quarter of the limit (2 of 8, 4 of 16); between runs, the run with the fewest calls in flight goes next; at most 4,096 waiting calls on the machine; an older budget host ignores the rank and admits in the old order | Starvation in either direction |

The patterns, and why each is there:

| Pattern | Where | Why |
| --- | --- | --- |
| Content-addressed computation | Sections, readings, packets | Replays are identical and judgements can be carried |
| One run per key, subscribers wait (record 0016) | Model calls, tree indexes, Graph reads | No duplicate work, no locks, no polling |
| Fan out, then verify, dedupe and rank | Readings and finders, then Verify, then code | The convergent industry shape; noise stays bounded |
| Two independent keys | Every approval that closes without a person | A closure needs two unrelated errors |
| Judgement in the model, policy in code | Lane rule, proof state, units, dispositions | Recomputable by the lanes eval; immune to injected repository text |
| Fail closed per item | The backstop | A failure costs a section, never the review or an approval |
| Event-sourced records with explicit supersession | Packets, assessments, lineage | Readers never fold or guess which version stands |
| A priority queue instead of a coordinator | Scheduler ranks | Ordering is the scheduler's job; nothing polls |

## 3. What it costs

Every row is marked measured (the build before NEU-148, on Modal, main `33ee8a1e`) or estimated; the local times after the reordering are in the starting facts. The estimates come from the speed review's recomputation over the raw runs, which used a heuristic of 1,269 / 4,233 / 8,591 sections; real Graph sections are 1,754 / 5,384 / 10,792. Scaled to real counts the reading costs rise by 1.38 / 1.27 / 1.26 at most, since per-file and fixed costs do not grow with sections.

| | Normal pull request (≤10 files) | 25 commits | 100 commits | 420 commits |
| --- | --- | --- | --- | --- |
| Changed files (measured) | 3 median, 10 at p95 | 104 | 374 | 975 |
| Graph sections (measured) | — | 1,754 | 5,384 | 10,792 |
| Before, on Modal: calls, slot-seconds (measured) | Not measured | 49, 670 | 49, 623 | 48, 669 |
| Before, on Modal: output and input tokens (measured) | Not measured | 21.2k, 1.76M | 19.5k, 1.93M | 22.3k, 2.29M |
| Before, on Modal: published at (measured) | Not measured | 305 s | 282 s | 362 s |
| One reading per section, compact answer: calls, output, input (est., heuristic counts) | — | 210, 97k, 2.37M | 627, 307k, 7.31M | 1,280, 644k, 14.5M |
| Two readings, cold: slot-seconds (est., heuristic counts) | — | ~4.4k | ~14.4k | ~30k |
| The same at real section counts (est., upper bound) | — | ~6.1k | ~18.3k | ~37.7k |
| Assess carried from commits, Lane review cold (est., heuristic → real counts) | — | ~2.5k → 3.5k | ~7.5k → 9.5k | ~15.4k → 19.3k |
| Readers lane's estimate at real counts, two readings: reading groups, model calls, slot-seconds (est.) | 3, 7, ~215 | ~58, ~135, ~4,100 | ~180, ~415, ~12,500 | ~360, ~830, ~25,100 |
| Its share read in the first run at 8 / 16 slots, and follow-on runs needed (est.) | all / all, 0 | 85% / all, 1 / 0 | 28% / 61%, 3 / 1 | 14% / 30%, 6 / 3 |
| Its wall time in all, 8 / 16 slots (est.) | Readings done about 80–90 s in; the batch still waits for the finders | ~11 / ~6 min | ~37 / ~15 min | ~65 / ~28 min |

The readers lane's figures assume about 40 output tokens per section for Assess and 48 for Lane review; at 60 or 150 the slot-seconds move by about −25% or +60%. Tokens per section is the first number the probe replaces.

Wall time is about slot-seconds ÷ call slots + 45 s, against a cut-off at 550 s (est.):

| Two readings, cold | 8 slots | 16 slots | 32 slots |
| --- | --- | --- | --- |
| Normal pull request | ~2–2.5 min, set by the finders' chain | same | same |
| 25 commits | 595–807 s: does not fit | 320–425 s | 183–235 s |
| 100 commits | does not fit | 945–1,189 s: does not fit | 495–617 s: fits only at the heuristic count |
| 420 commits | does not fit | does not fit | 983–1,223 s: does not fit |

- **Tokens grow with the change.** One reading per section writes 4.6 / 16 / 29 times today's output tokens and reads up to six times the input (est.); the second reading adds about half as much again (est.). Durable commits go from 2,174–2,533 per run (measured) to about 15–18k at 1,280 calls (est.).
- **The fixed parts**: Frame, Map, the four finders and their Verify calls are about 470 slot-seconds (est.). The finders' target is 4–5 turns after the new opening, down from 9–12.
- **Eight slots is our own default**, not a measured provider ceiling. The limiter that should raise it is off and would cut for the wrong reason; WP9 and a 32-slot measurement settle the real number.
- **Review as commits land is the route for large branches.** [12.36][A12] already allows background model work for branches with an open pull request or reviewed before. Assess has no goal in its key, so it runs as each commit lands and is carried ([12.35][A12]); asking for the review then costs Frame, Map, the finders, Lane review and whatever changed. Spread over a branch's life, the cumulative work is 1.35 / 1.69 / 2.43 times the cold work (est.).
- **Only Assess carries between reviews.** Lane review is keyed by the goal (Frame's output) and is never carried across goals in this build, so a warm review still pays for every Lane review reading. Carrying Assess removes about 45% of the slot-seconds (est., readers lane). The speed review's 1.5–3 minutes for a warm review at any size assumed every reading was prepared, and does not hold here.
- **A cold review that does not fit** publishes its settled batches and continues in follow-on runs, at most 8 (14.6), and every run reads up to its cut-off.

## 4. Work packages and their impact

Paths are from the repository root; `harness/` means `packages/harness/src/`. Line numbers are at `a96fc634`. Sizes and risks are the impact maps' estimates. Each package is one Linear child of NEU-148; its number in the scope brief is given.

| Package | Linear child | Lane: worktree under the owner's worktrees folder, branch | State on 13 November |
| --- | --- | --- | --- |
| WP0 Measurement | 1 | `lanes/ladder-merged`, `codex/neu148-ladder-merged` | Local "before" and paired timing runs done (starting facts) |
| WP1 Reorder the steps | 2 | `lanes/timeline`, `codex/neu148-timeline`; Verify on record in `lanes/timeline-verify`, `codex/neu148-timeline-verify` | On main |
| WP2 The finders' opening | 3 | `lanes/timeline`, after WP1's first slice | On main |
| WP3 Route controls | 4 | None yet | Effort per reading on main; the rest not started, waiting for the Claude sign-in work |
| WP4 Sections, facts, floors, groups | 5 | `lanes/sections`, `codex/neu148-sections` | On main, off by default; test declarations waiting to land |
| WP5 Records and identity | 6, 7 | `lanes/records`, `codex/neu148-records` | On main: the kinds, identity, lineage and eviction; the carry rule's redesign waiting to land |
| WP6 The two readings | 8 | `lanes/readers`, `codex/neu148-readers` | On main in probe mode; content rounds being built |
| WP7 Code decides | 10 | `lanes/readers` | On main, used only in probe mode |
| WP8 Publication and the desk | 7, 11 | Publisher in `lanes/records`; desk in `lanes/desk`, `claude/neu148-desk` | Publisher on main, not called; desk on main; the dock change being built |
| WP9 Scheduler and limiter | 9 | `lanes/scheduler`, `codex/neu148-scheduler` | Ranks, turn reserve and the readings' share on main; the budget host's upgrade open |
| WP10 Carried judgements, review on commit | 14 | None yet; to the readers lane later | A person's decisions carry (on main, through the publisher); agent judgements not started |
| WP11 Graph relations | 13 | `lanes/graph`, `codex/neu148-graph` | Callers per commit on main; the call's own line being built |
| WP12 Gates | 12 | `lanes/gates`, `codex/neu148-gates` | Set C and the runner in use |
| WP13 Documents | 15 | The coordinator | This revision |

### WP0. Measurement

- **Scope.** The size ladder on merged main, run locally at 25 / 100 / 420 commits, two runs per rung: one run per rung cannot show a change, since builds alone moved Find at 420 by 74 s. Local section counts. Collector fields: unit, section and reading IDs on calls; input waits by key; time to the first published batch; publication sequence and reversals; per-call throttles and retry-after; the returned service tier; reasoning tokens. Later, a thin probe of both readings inside the harness behind a setting ([10.97][A10] rules out scripts), and one review at 32 slots.
- **Changes.** The local runner and collector on the ladder lane's branch (`research/pr-bench/replay/large-review/`, not on main); harness fields land with each package; the per-call throttle flag in `harness/pi/call-slots.ts` (WP9's file); tier fields in `harness/call-telemetry.ts` (sign-in's file).
- **Depends on it.** Every gate and every before-and-after claim.
- **Hazards.** Modal numbers are never compared with local ones. Compiled builds default telemetry off, so ladders switch it on and say so, and anything a spot check needs after launch must be a record, not a span. Each local review gets its own budget host, so the machine-wide budget is not exercised. Other sessions draw on the same account. Tokens per section cannot be observed in a call over several sections: report call tokens ÷ sections and answer characters per section.
- **Gate.** None of its own; it is the instrument. **Size** S–M, **risk** low. **Blocked by** nothing but a free machine.

### WP1. Reorder the steps

- **Scope.** Frame starts when hunks and scope exist. Lead search becomes keyed background work, off the critical path, still awaited before the review ends and stored for its readers. Both tree indexes start when their trees are known, through `indexOf`. Verify starts per recorded finding, keyed by its claim. Every wait is attributed: for inputs, for a call slot, running. The four finders, their prompts, outputs, the units and the call count do not change.
- **Changes.** `harness/manifest.ts` `computeManifest` splits into a facts manifest and a leads step (`manifestSpec`); `harness/pipeline.ts` `precomputeSpec` opVersion 2→3, with the scope fetch running beside the manifest; `harness/pi/stages/index.ts` (the precompute port); `harness/pi/review-task.ts` commits the front child once facts exist and awaits the leads child in the link phase (task version 2→3); `apps/neuve-cli/src/review-cli.ts` (the lead line of `review show`); leads readers in `packages/evaluation/src/harness-compare/harness-side.ts`, `score.ts` and `full-test/measures.ts`. For Verify: `harness/pi/stages/tools.ts` (child creation inside the tool's commit), `harness/pi/stages/find-steps.ts` (`record_finding`; `harness.verify` key 1→2, by claim hash), `harness/pi/stages/run.ts`, `harness/pi/stages/finder-task.ts` (early verifies reconciled with dedupe, superseded fates, version 1→2), `harness/verify.ts`. Wait spans in the task files; the queued time on an agent step is a sign-in file, reported, not edited.
- **Depends on it.** Map, Find, Verify, Fill and Link all key on the range manifest, so every stored review goes cold once (accepted: there are no users). Every reader of leads.
- **Hazards.** In-flight review checkpoints across the task version bump. Double verifies after a resume. Up to 5 extra Verify calls per finder for findings dedupe later merges. A leads child nothing awaits is aborted and stops storing leads. Index building competes with the finders' tools for CPU, so it takes a preparation-class grant. Fill may block the event loop at the finders' start (inferred). NEU-150 blocks measuring prepared branches.
- **Gate.** Local ladder before and after, two runs per arm; finder openings byte-identical; catches per category no lower than the lower baseline run on the planted sets; publish time down past the two-run spread.
- **Size** L, 900–1,300 lines; **risk** high. **Blocked by** WP0 for proof; NEU-150 for prepared branches.

### WP2. The finders' opening and reads

- **Scope** (14.2, amends [12.49][A12]). The bounded, structured opening of section 2.3, built from what Precompute holds; the bound measured at two sizes. Handed-over lines citable, old side included. A many-range read and a diff-by-file lookup. Code assigns each finding's group, so finders stop waiting for Map. The last-turn submit and per-lens lookups need sign-in files and move to WP3's lane.
- **Changes.** `harness/initial-context.ts` (a new renderer in place of `renderInitialContext`'s form); `harness/find.ts` (`findSystem`'s text, `HeadRead` gains a side, `contextAnchor`, the group checks); `harness/pi/stages/find-steps.ts` (the shared opening, `harness.find` 4→5, the find key drops Map); `harness/pi/stages/tool-state.ts` (seeded with the handed ranges); `harness/pi/stages/docs.ts`; `harness/lookups.ts` (`ReadInput` takes ranges, a new `diff(path)`); `harness/budget.ts` caps; `harness/link.ts` (`placeFindings` by primary hunk); the initial-context section of record 0015.
- **Depends on it.** `findCounters`; 31 tests in `initial-context.test.ts` break by design.
- **Hazards.** A changed opening changes catches with no gate unless WP12's sets exist. The per-kind tool freeze refuses a changed tool list on a resumed run. At 420 commits the 6.9 million changed characters must fold, never drop a file's owned lines silently. The opening is not a raw dump of 72–150k characters: small structured readings beat raw context.
- **Gate.** As WP1, plus deleted lines read above zero, output tokens and turns per finder down, and no category's catches lower, including deleted-line and cross-file plants.
- **Size** L, 900–1,400 lines; **risk** high. **Blocked by** WP1's Verify change in `find-steps.ts`; WP12's set C.

### WP3. Route controls

- **Scope.** The credential lookup before the call slot is taken, with a refused account store still holding the review. Effort selectable per kind of step, defaults unchanged, and no setting that turns on a paid fast tier or fast mode (14.15); on Claude-subscription routes effort passes as a call option, and a runtime that cannot honour it says so in its capabilities. The finders' last turn is an ordinary turn whose prompt names the submit tool (14.15). Lookups offered only to lenses that can use them.
- **Changes.** `harness/pi/providers/agent-route-provider.ts` (`leaseToken`, `toRouteRequest`, the last-turn tool choice); `harness/route.ts` (per-stage effort); `harness/config.ts` `runSpec`; `harness/pipeline.ts` `agentStageSpec`; `harness/pi/bindings.ts`; `harness/pi/stages/agent-step.ts` (the final phase; the tool freeze keyed per lens); `harness/call-telemetry.ts` and `packages/records-schema/src/telemetry.ts` (effort per call). The slot's acquire order touches `harness/pi/call-slots.ts`, which WP9 owns.
- **Hazards.** Every agent stage is keyed by effort: a default run's key must stay byte-identical or every stored stage goes cold. Whether the ordinary last turn keeps the prefix cache is unmeasured.
- **Gate.** Default request digests identical; a refused account store holds the review and takes no slot; effort recorded per call.
- **Size** M, 300–500 lines; **risk** medium. **Blocked by** the Claude sign-in work on main.

### WP4. Sections, change facts, floors and reading groups

- **Scope.** The stored blob structure, section key, change facts and reading groups of section 2.1, wired into unit building behind the setting `review.responsibilitySections`: off, a review's run key, stage keys and units are unchanged. First a defect on main: `describeHunks` puts both sides of a modified file in one outline batch under one path, graph-client refuses the duplicate, and the whole group falls back to line windows. The removed-row pairing by index, which gives one symbol's removal to another's section, is fixed. The lane exports `sectionIdentities`, `orderedSectionKeys` and `sectionKeySetHash` for the records and readers lanes. Floors are built with WP7 in `lane-rule.ts`. Hunk records already stored under `harness.file-hunks@2` stay without symbols until the manifest's owner bumps or stops storing them.
- **Changes.** `harness/search-index.ts` (`blobChunks` stores the structure; outline batches never hold a path twice); `harness/hunks.ts` (`describeHunks` reads it back); `harness/sections.ts` (`spanKey`, the removed-row pairing, one fallback vocabulary with the chunker); new `harness/blob-structure.ts`, `section-identity.ts`, `section-facts.ts`, `reading-groups.ts`; `harness/link.ts` (`fill` and `batchInputs` only); `harness/settings.ts`, `request.ts`, `config.ts` (one optional block each).
- **Depends on it.** WP5's identity, WP6's readings, WP7's floors.
- **Hazards.** Storing anything in the stored chunk bumps `CHUNK_RECIPE` in [`chunker.ts`](../../packages/harness/src/chunker.ts) and sends every blob, tree index, manifest and lead key cold. `structuresFor` as written is a second Graph read. The first review after the change reads outlines once for blobs whose chunks are cached. `structureOf` maps any partial failure to a parse error while the chunker treats it as retryable; a retryable outcome is never stored. About 1,950 blobs at 420 are processed synchronously, so they batch in CPU work. "Section" clashes with the scope sections finders already see.
- **Gate.** Zero extra Graph runs per review (`structuresFor` alone costs 7.4 / 11.9 / 37.7 s and 5 / 9 / 20 Graph runs today, measured); section keys stable across a rebuild and across a later head; groups deterministic; with the setting off, the same run key and units.
- **Size** L, 1,000–1,500 lines; **risk** medium-high. **Blocked by** nothing.

### WP5. Records and identity

- **Scope.** The identity, the five record kinds and the backstop's records of section 2.5; the publication chain of section 2.6; compatible reads for older builds ([12.24][A12], [12.56][A12]). Built in three steps: the kinds and every reader, with nothing writing them; IDs from section keys and lineage; the publication chain. A recompose run publishes as its own sequence in its scratch store.
- **Changes.** `packages/records-schema/src/events.ts` (the union, `FEEDBACK_TARGET_KINDS`), `packet.ts` (`AssessedSections`, manifest version 8), the compatibility refusal registry; `packages/records-core/src/projectors.ts` (`PROJECTOR_VERSION` 10→11, baseline 9; no table change), `published-packets.ts` (new read functions for both packet shapes; the existing `standingPacket`, `exactPacket` and `runPacket` return nothing for a `packet.published@2` cycle; the citation resolver), `checkpoints.ts`, `review-stats.ts`, `review-progress.ts`, `admin.ts`, and one shared function for a unit's ranges in every version; `harness/publish.ts` (IDs, packet key, clock, plan), `harness/units.ts`, identity in `harness/compose.ts`, `harness/packet-view.ts`; the CLI readers, including the Ace card in `apps/neuve-cli/src/workspace-native-review.ts`; `apps/neuve-host/src/review-protocol.ts` (a pending count on the card). Granted outside the lane: new test files under `packages/records-core/tests/` and additive hunks in `review-fixtures.ts` and the reader-root registry; the one-call change in `human-commands.ts` as the last commit of step 2, after checking the NEU-146 branch; `harness/handler.ts`'s interrupted-publish check as a patch in `coordination/neu-148/handovers/`; `harness/link.ts`'s local IDs agreed with the sections lane.
- **Depends on it.** Every reader of units, assessments, comments, gaps and packets; the lanes eval, which refuses an assessment kind it does not know so a new-shape run can never score as nothing assessed.
- **Hazards.** A key built from completion order is not replay-stable. People's work on an ID that is not in the standing packet must be reached through lineage, never moved. Without the shared ranges function every unit citation in a digest reads "not published". A missing ranges blob or sections body is disclosed as undecoded, never thrown. `rules.ts` refuses an agent approval appended after a rise to human-required, so Publish writes the assessment before the disposition.
- **Gate.** Key transfer line by line (on the gates branch); a Map reorder keeps every unit and batch ID; a later commit that leaves a unit alone gives `unchanged`; a file over 1,024 ranges keeps every range; a replay after a stop at each point, with batches settling in another order, gives the same packets, IDs and bytes; two publishers on one base write one packet; an older decoder over a new-shape cycle skips, never corrupts; an existing store opens with the same projection checksum.
- **Size** L, 1,400–1,900 lines across about 22 files; **risk** high. **Blocked by** WP4's section key (decided).

### WP6. The two readings

- **Scope.** Assess and Lane review (section 2.2) in the task shape of section 2.7: the plan computation, one `neuve.reading` task per reading group and kind, a waiter per batch, the review task as the one publisher; compact answers; Lane review's lookup turn; the model step's claim; failures as recorded outcomes; the stage kinds `assess` and `lane-review`. First a probe behind the setting `review.sectionReadings: "probe"`, off unless set so every key stays: a real review also plans, runs and collects both readings and runs the deciding code, with **published units unchanged**, and writes counts, lanes, causes and tokens (no model text) to `readings.json` in the run folder and the receipt.
- **Changes.** New reading modules: Assess (from `9dde51ad:packages/harness/src/assemble.ts`), Lane review (from `dispose.ts` there), the reading renderer, `harness/pi/stages/reading-task.ts`, `harness/pi/stages/step-claim.ts`; the port in `harness/pi/review-task.ts` (applied by the timeline lane, with one task version bump shared with theirs); the rank through the binding (`pi/contracts.ts`, `pi/host.ts` `reviewPriority`) under the scheduler lane's contract; stage plumbing in `harness/budget.ts`, `receipt.ts`, `config.ts`, `pi/stages/docs.ts` and `kinds.ts`, whose owner for the two new kinds the readers lane asked the coordinator to name. Sign-in files, as patches after their merge: five changes in `pi/stages/agent-step.ts` (the claim at start, on resume, at finish, on failure and on hold), a recorded outcome instead of a hold for these kinds on non-credential failures, a per-kind route for the second model, receipt fields.
- **Hazards.** One held provider failure still ends the whole attempt until the hold change lands. When a holder dies and a waiter takes over, the holder's resumed task must subscribe, not run its own; the dead holder's turns and usage are lost. A waiter's shared failure carries no retryability, so its tag is mapped back through the failure policy. About 12 commits per reading, roughly 9,000 at 420 commits on one writer (est.); one socket per open claim against 256 open files by default on this Mac. The capture journal grows from 22–28 MB to about 100–170 MB against a 512 MB object limit (est.). Hundreds of renderings on the event loop. The "at most 70 calls" shape test, which is record 0005's cap, breaks by design.
- **Gate.** The thin probe first: tokens per section, lane agreement against the owner's and the replay keys, catches. Then: every section read or backstopped; replay aims within noise and guards not up; every planted light-file problem caught ([12.33][A12]); no category's catches lower; false comments at most one in ten; late positions in a reading group no worse ([12.34][A12]); publish time not later past noise.
- **Size** L, 2,000–3,000 lines in about 20 files, 6 new; **risk** very high. **Blocked by** WP1, WP4, WP5, WP9 and the sign-in work.

### WP7. Code decides

- **Scope.** Section 2.4: lane rule version 3 with the one floor; proof state by code; units and the verdict fold; dispositions; the outcome table, one test per row; ranking with fates; `decided(plan, outcomes, batch)` and the waiter list per batch as pure functions.
- **Changes.** `harness/lane-rule.ts` (`LANE_RULE_VERSION` 2→3; the removal floor after `laneOf` and `withPublicSurface`); `harness/disposition.ts` (`applyLane` and `approvalProof` unchanged); new `harness/decide.ts`, `proof-state.ts`, `unit-verdict.ts`; Publish accepting approvals (`harness/publish.ts`, the records lane's file); `packages/evaluation/src/harness-compare/full-test/lanes-eval.ts` rule 3 per section, by the gates lane over the exported function.
- **Hazards.** If any floor input is recomputed from the repository instead of recorded, the lanes eval can no longer check that what was measured is what runs. Public names from Graph for every language need visibility facts that `SymbolObservation` in [`symbol-observation.ts`](../../packages/graph-client/src/symbol-observation.ts) does not carry; today's rule matches ECMAScript and Go only, and stays as it is in this build.
- **Gate.** The lanes eval's identity check exact per section; a census of every terminal state with zero undefined; the static share and proof states set by code.
- **Size** L, 700–1,100 lines; **risk** high. **Blocked by** WP4, WP5, WP6.

### WP8. Publication and the desk

- **Scope.** The per-batch rule and follow-on runs of section 2.6 (14.3, 14.6). The desk: four lanes on real data; a unit no agent decided, with "No agent decision in this run" and no suggested review; a review still in progress, counted once; removals first in digests and impact findings first in the margin; a lane raised since the last review, and earlier people's work shown through lineage; the progress list's stage names, which still name the pipeline before 4 November; live events without a timer in place of the one-second poll. Four implementers with disjoint files: the overview, Reviews page and header; the rail and unit page; the server projection and progress list; live events. UI work by Opus sessions with Interface Craft (13.7), preserving the existing design.
- **Changes.** Publisher: `harness/publish.ts`, `harness/pi/review-task.ts` (batch waiters, the publish phase), the interrupted-publish check in `harness/handler.ts` (a sign-in file), gap keys in `harness/receipt.ts`. Desk: `apps/neuve-web/apps/web/src/server/**` behind one new seam, `lane-facts.ts`, except the write side of `desk.server.ts`; `apps/neuve-web/packages/ui/src/neuve/batch-overview/**`, `reviews/**`, `review-desk/unit-rail.tsx`, `briefing.tsx`, `read-only-neighbor.tsx`, `section-rows.tsx`, `states/**`, the agreed fields in `types.ts`, and new fixtures; removals first in `groupDigest` (`harness/link.ts`) and `codeFacts` (`harness/compose.ts`). The dock change is a patch proposed to the NEU-146 track, not applied.
- **Hazards.** A pending unit with no disposition reads as waiting on a person and inflates "waiting on you" ([10.127][A10]); only published units are counted. A unit that leaves the standing packet becomes "unknown unit" on reload. Later packets show earlier gaps unless gaps come from the manifest. The generated real fixtures predate 4 November and are regenerated from a real redesigned review.
- **Gate.** Zero reversals; a replay publishes identical packets; Chrome DevTools screenshots and video of each lane on a real review ([7.2][A7]); new batches arrive by push.
- **Size** L for the publisher (1,200–1,600 lines), M for the desk; **risk** high for the publisher, medium for the desk. **Blocked by** WP5; NEU-146 for the dock.

### WP9. The scheduler and the limiter

- **Scope.** Stage kinds and ranks under which hundreds of one-turn readings and a few long finders do not starve each other. A fair share between two interactive reviews; interactive-first across the machine is mostly built ([12.37][A12]). The limiter cuts on throttling, not on mixed call lengths. Per-call throttles recorded. The measured slot ceiling.
- **Changes.** `harness/pi/priority.ts`, `harness/budget/scheduler.ts` (`rank`, `ProviderLimit.record`, `Priority`), `harness/budget/local.ts`, `harness/pi/call-slots.ts`, and a load script `packages/harness/scripts/scheduler-load.ts`.
- **The settled call-site contract** is the last row of section 2.7's first table. A reading passes `reviewPriority(stage, continued, rank)`, with `stage` `assess` or `review` as a `CallStage` beside `AgentStage`; the scheduler's word for it is still to align with the stage name `lane-review`.
- **Hazards.** The budget socket speaks a strict version 1 schema; an older host ignores the rank and admits readings in the old order, so the order holds only once the machine's host is this build. More than about a thousand readings per run must be released in bounded batches under the 4,096 cap. Starvation in either direction.
- **Gate.** A 300-reading queue does not starve finder continuations, nor the reverse; two reviews interleave; mixed 4 s and 40 s calls cause no cut; a 32-slot run with each limiter change's cause recorded.
- **Size** M, 250–400 lines; **risk** medium. **Blocked by** nothing; lands before WP6.

### WP10. Carried judgements and review as commits land

- **Scope.** A person's own decisions already carry (14.12, section 2.6). Assess outputs keyed by section key, reading recipe, prompt and route, carried between reviews and shown as carried, with a ledger of what each read. The lane is never carried: floor, rule and proof state are recomputed every run. A background sample re-run checks agreement ([12.35][A12]). Background model work only for [12.36][A12]'s branches, deduplicated by the branch's latest head. The interactive review subscribes to a background reading in flight; work that holds a CPU grant never waits on a key.
- **Changes.** The runner removed on 4 November (`carried-judgement.ts`, `background-judgements.ts`, from `1ef3018b`); the `judgement.prepare@1` handler, a no-op today, in `harness/handler.ts` (a sign-in file); `packages/records-core/src/jobs.ts`; `apps/neuve-host/src/judgement-hooks.ts` (configured, never today); `apps/neuve-cli/src/workspace-cli.ts`; writers for `disposition.carried@1` and `comment.carried@1`; record 0005's trial text.
- **Hazards.** A carried judgement that is stale because a neighbour it read changed is the one hard-guard path still partly open. The background slot runs one job at a time, so a long model job would block commit preparation.
- **Gate.** Carried against fresh agreement at least the two-fresh-run floor; zero stale carried judgements on planted neighbour changes; a re-review after one commit redoes only what changed. No dataset exists yet.
- **Size** L, 1,500+ lines; **risk** high. **Blocked by** WP6, WP7 and NEU-150.

### WP11. Graph relations

- **Scope.** Trust first: precision and recall of inbound calls on about 30 TypeScript and 10 Go changed symbols, test edges (from naming only today), the join between outline sections and snapshot IDs, cost cold and warm. Then one bulk read per commit, cached in the computation store under record 0016 and shared across reviews, with stated coverage; relation slices in the readings and context markers. Absence reads "no evidence", never "no callers".
- **Changes.** In the Graph submodule: a commit selector on `snapshot` and `edges`, a lean edges dump under Graph's 64 MiB cache, one run per submodule pin. In `packages/graph-client`: a streaming reader and a relation-slice observation reusing `GraphRelationObservation`. In the harness: the join by side, path and line overlap, and the slices.
- **Facts.** A full snapshot of Neuve takes 22.5 s wall, 40.4 s CPU, 610 MB and 226,688 records (measured); the cost is about the same at every ladder size, one head plus one shared base (est.); per-symbol queries would take hours (est.).
- **Hazards.** Name-only resolution, callbacks credited to the enclosing function, root-only aliases, a known wrong zero; no precision or recall figure exists; two snapshots at once need about 1.2 GB.
- **Gate.** Within record 0013's bound; a false "no callers" never shown; cross-file catches up on set C.
- **Size** L; **risk** high on precision, low on cost. **Blocked by** nothing.

### WP12. Gates

- **Scope.** The evaluation commits carried onto merged main. A local case runner and a finders' quality gate: a catch is a finding Verify kept whose anchor overlaps a planted line, against a noise bar from two baseline runs. Set C: at least 15 plants in ordinary source, deleted lines, across files, missing tests and out of scope, at least one not in TypeScript per category, toward 10 per category. The lanes eval at section grain. The units-per-call benchmark of [12.34][A12] by reading-group size and position. Set B's light-file plants, never run so far. A merit pack for the false-comment rate. The hard guard is not established here (14.7).
- **Changes.** `packages/evaluation/src/harness-compare/full-test/**` and `validation/`.
- **Hazards.** The lanes eval reads one `assessment.recorded@3` per unit: a run of the new shape reads as nothing assessed and passes silently unless the producer and the eval change together. A 10% margin per category needs about 30 plants each, about 360 in all. Local reviews run one at a time: two baselines and a candidate over sets B and C is about 144 reviews (est.).
- **Gate.** Each gate runs locally and states what it can and cannot prove. **Size** L; **risk** medium. **Blocked by** nothing.

### WP13. Documents

Decision rows for every ruling and amendment (section 5); records [0005](../../architecture/decisions/0005-harness-pipeline.md) and [0007](../../architecture/decisions/0007-batches-units-lanes-and-cycles.md) revised, and 0015's initial-context section and 0016 where touched; vocabulary and [foundation 04](../../foundations/04-review-units-and-context.md) text that still describes proximity units, after the owner's approval; the launch description of lanes for release prep; this guide. **Blocked by** the lanes.

### File ownership between lanes

Owners as the board's roster (`coordination/neu-148/board/ROSTER.md`) gives them; a file not listed there is agreed between the lanes that need it, or named by the coordinator.

| Lane | Owns |
| --- | --- |
| Timeline (and timeline-verify) | `harness/manifest.ts`, `pipeline.ts`, `pi/review-task.ts`, `pi/stages/find-steps.ts`, `finder-task.ts`, `run.ts`, `tools.ts`, `find*.ts`, `initial-context.ts`, `lookups.ts`; the evaluation's readers of leads |
| Gates | `packages/evaluation/**` |
| Sections | `harness/search-index.ts`, `hunks.ts`, `sections.ts`, `section-identity.ts`, `section-facts.ts`, `reading-groups.ts`, `link.ts` (`batchInputs`) |
| Scheduler | `harness/budget/**`, `pi/priority.ts`, `pi/call-slots.ts` |
| Records | `packages/records-schema/**`, `packages/records-core/src/**` (but not NEU-146's files), `harness/publish.ts`, `packet-view.ts`, identity in `compose.ts`, `units.ts`, the CLI readers |
| Graph | The Graph repository, `packages/graph-client/**`, `relations.ts` |
| Readers | New reading modules, `harness/lane-rule.ts`, `disposition.ts`, the proof-state modules |
| Desk | `apps/neuve-web/**` except the decision dock |
| Ladder | Measurement only |
| The Claude sign-in work (another track) | `pi/attempt.ts`, `route*.ts`, `pi/providers/*`, `pi/stages/agent-step.ts`, `pi/control.ts`, `failure-policy.ts`, `handler.ts`, `contract-*.ts`, `packages/records-schema/src/telemetry.ts` |
| NEU-146 (another track) | The decision dock files, `packages/records-core/src/rules.ts`, `human-commands.ts`, existing files under `packages/records-core/tests/` |

Files several packages touch, and the order:

| File | Packages | Order |
| --- | --- | --- |
| `harness/pi/review-task.ts` (timeline) | WP1, WP6 (the port), WP8 (waiters, publish phase) | WP1 → the readers' port, one shared task version bump → WP8 |
| `harness/pi/stages/find-steps.ts`, `finder-task.ts`, `run.ts`, `tools.ts` (timeline) | WP1 (Verify), WP2, WP6 | Verify on record → citable lines → opening → many-range read → WP6's stage kinds |
| `harness/manifest.ts`, `pipeline.ts` (timeline) | WP1, WP3 (`agentStageSpec` only), WP6 | WP1 first |
| `harness/link.ts` (sections for `batchInputs`) | WP4, WP2 (`placeFindings`), WP5 (local IDs, agreed with sections), WP7 (`linkedReview`), WP8 (digest order) | WP4 → WP5 → WP2 → WP7 → WP8 |
| `harness/compose.ts` (records for identity) | WP5, WP7 (coverage moves to `proof-state.ts`), WP8 | WP5 → WP7 → WP8 |
| `harness/publish.ts` (records) | WP5, WP7 (approvals), WP8 | One lane, never split |
| `harness/budget.ts`, `config.ts`, `pi/stages/docs.ts`, `kinds.ts` (not in the roster) | WP2 (caps), WP6 (stage kinds), WP9 | Owner for WP6's kinds to be named by the coordinator; WP9 → WP6 |
| `harness/pi/call-slots.ts` (scheduler) | WP9, WP3 | WP9 → WP3 |
| `pi/contracts.ts`, `pi/host.ts` (not in the roster) | WP6 (rank on the binding) | The readers lane, under the scheduler's contract |
| Sign-in files | WP1 (queued time), WP3, WP6 (claim, hold), WP8 and WP10 (`handler.ts`) | Patches after the sign-in merge: WP3, then WP6's parts; WP8's `handler.ts` hunk waits in `handovers/` |
| NEU-146 files | WP5 (`human-commands.ts` one call), WP8 (the dock) | After checking its branch; the dock as a proposed patch |
| `packages/evaluation/src/harness-compare/**` (gates; timeline for leads readers) | WP1 (leads), WP7 (rule 3), WP12 | WP1's leads readers first; rule 3 when WP7 exports the function |
| `apps/neuve-cli/src/workspace-native-review.ts` (records, CLI readers) | WP5 and WP8 (Ace card), WP6 (progress list) | WP5 → WP6 |

## 5. What this changes in the decisions

The owner's rulings are rows 14.1 to 14.22 of [Area 14][A14]. The record points from each row they amend to the row that amends it. Row by row:

| Row | What it says | What changes |
| --- | --- | --- |
| [12.41][A12] | A fixed shape whose size does not grow with the change; four finders with 12 turns, 200,000 characters, 5 findings; "never one agent per behaviour, partition or unit"; one check per surviving finding | Amended: readings grow with the change within each run's budget; the four finders keep their lenses with a new opening (14.2) and start when Frame lands; Verify checks each distinct finding from finders and Lane review |
| [12.31][A12] | Large reviews do less model work "rather than spreading today's work over more runs" | Amended by 14.6: work grows with the change, and a review too large for one run continues in a follow-on run. "No lever removes a hunk from coverage" stands |
| 13.17 | Assess (≤6 calls) and lane review (≤8), no tools, ≤84 calls, gated on lanes eval v1 and 12.34's benchmark | Replaced in shape, already superseded for scope by 13.18. Its gates carry over in WP12, except the hard guard (14.7) |
| [12.34][A12] | Several units per agent once a benchmark at 1, 2, 4 and 8 shows no loss | The grain becomes the reading group; the benchmark runs at reading-group sizes before readings go live |
| [12.33][A12] | Light hunks get one judgement; every planted light problem must still be caught | Stands, and applies to every reading's compact answer |
| [10.64][A10], [10.65][A10], [10.66][A10] | One fresh reviewer per unit; the agent verifies its own defect claims | Amended: Lane review reads a reading group's sections; Verify, independent, checks findings |
| [10.33][A10], [10.61][A10], [2.16][A2] | Lane-blind review; Dispose sees only Facts; other agents' outputs never where an agent works | Stand. Assess and Lane review are separate contexts, and finders see neither |
| [4.4][A4], [4.6][A4], [10.42][A10], [10.100][A10] | Gaps send a unit to human-suggested; human-required units also get suggestions; units never assessed go to human-suggested | Amended by 14.4: work no agent could judge is human-required with a plain note and no suggested review; 14.13 adds a request whose every finding was refuted. Gaps from missing evidence still go to human-suggested (14.5) |
| [10.73][A10], [12.38][A12], [8.7][A8], [5.5][A5] | One append transaction per batch, the manifest written last; finished batches publish as they complete; a manifest per published package; the package frozen when published | Amended by 14.3: `packet.published@2`, several cumulative packets per run, each superseding the last; a published batch is frozen and publishes only when settled; a second configuration's review publishes once, when complete (14.13). The vocabulary's Packet entry needs the owner's approval to follow |
| [12.40][A12] | Framing, mapping, ranking and judging are separate steps | Stands; Map no longer gates the finders or the readings, only batches and publication |
| [12.49][A12] | One form for an agent's initial context, with a 50,000-character opening | Amended by 14.2 for the finders' opening |
| [12.6][A12], [7.1][A7], [12.54][A12] | Codex only for development and independent review | Amended by 14.9: Opus implementers, Codex for well-specified slices, a separate Claude reviewer with fresh context for every change; Codex never approves. 13.7 stands, and 14.69 adds that Codex touches no frontend code |
| [12.4][A12], [12.25][A12] | The owner's integrated run before a merge | Amended by 14.11 for NEU-148: reviewed work lands once its full check passes on the exact commit; work a person sees waits for the owner |
| [8.3][A8] | The web app watches a sequence number | Amended by 14.14: a push when it moves |
| [10.19][A10] | Effort fixed per context | Amended by 14.15: effort per kind of step; no paid fast tier |
| [10.93][A10] | The machine budget's scheduling class | Amended by 14.20: background children lower CPU priority only |
| [9.34][A9], [10.129][A10] | Benchmark compute and replay runs on Modal | Amended by 14.10: Modal is retired and runs are local |
| The constitution's neutrality rule | No trust from file-name or extension lists | 14.18: GitHub Linguist's two lists may mark files |
| [8.10][A8] | Outputs the pipeline reuses are kept permanently | Revised by 14.21: declared recomputable outputs may be evicted under a byte cap |
| [4.1][A4] | Units "always grouped by filename and proximity" | Superseded in substance by [10.109][A10] and [10.120][A10]; record 0007's proximity text is rewritten |
| [10.140][A10] | The public-name rule, ECMAScript and Go patterns | Stands as it is in this build. A removal floor is added, off until the lanes eval measures it (14.13). Graph's facts for every language wait for visibility facts |
| [10.98][A10] | The owner's directions, among them generated files never for human eyes and CI files at most human-suggested | Not in lane rule 3: a ceiling lowers a lane, and nothing lowers one until the lanes eval measures it (14.13). The generated-files batch stays as today |
| [10.83][A10] | An agent's approval cites its proof or says plainly none is recorded | Stands; code sets the proof state, and an agentic approval may stand with none recorded, saying so |
| [10.15][A10], [10.26][A10] | Ten minutes, the run's whole lifetime | Stand per run (14.6); a run keeps reading to its cut-off, and a review may take up to 8 follow-on runs |
| [9.23][A9], [10.2][A10] | At least 4,000 tokens of context per hunk | Readings carry a bounded relation slice instead. Needs the owner's amendment |
| [10.146][A10] | Rank instead of drop, with each item's fate | Stands; kept from today |
| 13.20 | Impact is a first-class finding | Applied: an impact kind in `comment.recorded@3`, listed first. The vocabulary gains an "Impact finding" entry; how far a change reaches is the blast radius (14.22) |
| [12.35][A12], [12.36][A12], record 0005 | Carried judgements and background preparation, disabled in the trial | A person's decision on unchanged code carries and closes the unit (14.12). Carried agent judgements come back with WP10 before the cut (14.8); 12.36's branches stay the scope |
| 13.25 | Agentic: request changes only; static automation: red or green | Stands. A confirmed defect on agentic work goes back to the inner loop, and no person can approve over it |
| Record 0005 | At most 70 model calls; units without a kept defect get no disposition | Revised: those rules hold with the readings off |

Moot under the rulings: dropping lead search (it stays, with readers), unsure and unconfirmed outcomes (the backstop), a separate check of approvals (the two readings are the two keys), and finders reading other agents' outputs (they don't).

**Put to the owner under 13.19 and ruled:** lanes stay cautious at launch, static automation stays empty until proof is recorded, a request for changes whose every finding was refuted goes to human-required, a second review of the same range publishes once, older builds show no review for a new-style review, and the proximity-grouping numbers end (14.13); a backstopped unit has no suggested review (14.4); a quota refusal leaves batches pending (14.6); a published batch is never revised and the first batch waits for the finders (14.3). Still open: model-written Briefed and Explained stops and the batch digest, absent since 4 November, are not restored (section 6).

## 6. Open points

| Point | Who settles |
| --- | --- |
| Briefed and Explained stops and the batch digest, absent since 4 November, are not restored by NEU-148 | The owner, under 13.19 |
| How withdrawing or replacing one carried copy affects other reviews that already stand with their own copy | The owner |
| Two units holding the same sections that no lineage connects (a review of an earlier range published after a later range's only review) | The records lane, with a key-to-unit index |
| Whether "Assess" and "Lane review" stay the shown words | The owner, after using them (14.16) |
| Which second model reviews, on which route, and the cost of Claude-subscription calls at hundreds per review | The Claude sign-in work, then the owner |
| When the machine's budget host moves to a build that reads the rank (an older host admits in the old order) | The scheduler lane |
| Precision of Graph's name-only matches and unmeasured languages, shown as not measured | The graph lane |

## 7. Guidance for implementing sessions

- **The board.** Each lane keeps one file of at most 20 lines in `coordination/neu-148/board/`, rewritten each turn, and reads `README.md`, `ROSTER.md` and `coordinator.md` there at the start of each turn. Lanes decide engineering themselves and record it in their file; product questions go to the owner with a recommendation and the cautious path meanwhile; another lane's file or contract is agreed with that lane and written in both files.
- **Who builds.** Opus implementers, or Codex for a well-specified slice on disjoint files that holds no frontend code (14.69); one independent Claude reviewer per change, in a fresh session, given the brief, diff and evidence but never the implementer's reasoning; Codex never approves (14.9). Visual work by Opus sessions with Interface Craft (13.7). Follow the [adversarial review standard](../adversarial-review-standard.md) and load the [reviewer skills](../../apps/neuve-cli/skills/neuve/SKILL.md#references); only correctness or security defects block.
- **Landing.** A head enters the integration branch once its reviewer approves; it lands on main only when the lane's Neuve review cycle for that range has run, as the [lane loop](../neuve-in-the-loop.md) describes, and each finding has a verdict ([12.54][A12]). Name each approved head in your board file. Nothing merges into integration while its full check runs. Visible UI and turning the readings on wait for the owner (14.11).
- **Before naming a head**, run at the repository root, on your head merged with main: `NEUVE_MODE=check bun run build:ace-types && bun run typecheck`. The web app compiles the harness under stricter options.
- **The real engine.** Every round that consumes Graph's data has at least one test on the real engine and a real repository; a fixture engine never gives data the real engine does not.
- **Where.** Worktrees are cut from the clone on the owner's drive, never from the Mac checkout. `TMPDIR` and `BUN_TMPDIR` under the `tmp` path of the owner's storage profile (`scripts/pi-storage.ts`). Run data stays on that drive. In a worktree whose Graph module is a linked worktree, check that it matches the gitlink.
- **Heavy runs** go through the capacity gate, `coordination/neu-148/tools/run-heavy.sh <log> <command>`, full checks included: three slots, a full check takes two, quality runs at most two at nice 10, and a job starts only with enough free memory and normal memory pressure. No Modal and no `check:remote` (14.10). `coordination/oss-release/tools/hold-tests` stops every new start. During a landing window, write code and tests but run nothing. Ad-hoc runs in a worktree: focused files only.
- **Shared scripts** are never edited in place: write a new file and rename it over the old one, since a running shell reads a script as it goes.
- **Keys.** A default configuration keeps byte-identical keys; new behaviour sits behind its setting or its own key. Never widen a kind, enum or limit in place: add a version ([12.56][A12]).
- **Shared work** is [record 0016](../../architecture/decisions/0016-shared-work.md) only: one run per idempotency key, every other caller subscribes. Never a duplicate run, a poll or a new lock.
- **Evidence converges** ([7.2][A7], [11.1][A11]): code, tests, telemetry and logs agree; browser work adds screenshots and video. Timings come from real reviews through telemetry ([10.97][A10]). Compare builds back to back in one run and report the load beside the seconds.
- **Tests** only where needed, each with its reason; a test is never approval ([7.3][A7]), and in the product a test's existence is never evidence (14.19).
- **Narrowing.** Anything that removes, disables or narrows product behaviour goes to the coordinator, who puts it to the owner before it lands (13.19).
- **Files other tracks own:** the Claude sign-in work (`pi/attempt.ts`, `route*.ts`, `pi/providers/*`, `pi/stages/agent-step.ts`, `handler.ts`, `failure-policy.ts`, `contract-*.ts`, `records-schema/src/telemetry.ts`) and the NEU-146 cleanup (the decision dock, `records-core/src/rules.ts`, `human-commands.ts`). Changes to them go as patches to `coordination/neu-148/handovers/`.
- **Commits** carry no attribution trailer. Reports go to `coordination/neu-148/reports/`, design notes to `design/`. Accepted requirements move into the decisions record, an architecture record or the Linear scope ([7.12][A7]).

## 8. Build order

On 13 November steps 1 to 3 are on main, with step 5's probe, step 6 in probe mode, step 7's records and publisher and step 8's bulk read; steps 4 and 9 have not started.

| Step | Packages | Unblocks |
| --- | --- | --- |
| 1 | WP0 local "before"; WP12 runner and set C | Every later comparison and gate |
| 2 | In parallel, disjoint files: WP1, WP4, WP9, WP11's measurements | WP2, WP5, WP6 |
| 3 | WP2 after WP1's Verify change and set C; WP5's step 2, the new kinds and their readers, which nothing writes yet; WP6's and WP7's pure functions | The readings' records; per-batch publication |
| 4 | WP3, once the Claude sign-in work is on main | WP6's step routes and failure model |
| 5 | WP6's probe behind `review.sectionReadings: "probe"`, published units unchanged, through the timeline lane's port; then the full readings once the claim and hold patches land after the sign-in merge | WP7, WP10 |
| 6 | WP7 with the lanes eval at rule 3 | Real lanes; WP8's closing dispositions |
| 7 | WP5's identity and lineage, then the publication chain; WP8's desk on real data once NEU-146 merges | Lanes on the desk |
| 8 | WP11's bulk read and relation slices | Relation gaps closing; context markers |
| 9 | WP10, after NEU-150 | Large reviews as commits land |
| 10 | WP13, then the cut: everything lands before it (14.8) | The release |

## 9. Where the 12 November design and the code disagree

1. **Public names in change facts.** The design listed public names added or removed among the change facts. The code has none: no stored form gave them correctly, and `withPublicSurface` stays their one authority.
2. **Reading turns.** The design gave Assess one turn with no tools and Lane review two. The code gives Assess two turns (the second only to resend a refused answer) and Lane review three (the first for lookups).
3. **What lifts the missing-callers gap.** The design expected callers and covering tests to lift it once Graph gave them in bulk. The code needs both a caller row and a test row for every changed symbol, at the call's own line, which no index records, so nothing lifts. Under 14.19 the test row must go; that change is being built.
4. **Caller rows.** The design said a row shows the call site. Every engine index today records the calling function's first line, and file-level calls (every call in a test callback) have no line.
5. **Who ruled the call-line rule.** The rule that a caller row placed at the calling function's first line is not evidence is the coordinator's engineering ruling. The comment in `readings/evidence.ts` calls it the owner's; the readers' next round corrects the comment.
6. **Publication.** The design has one waiter per batch and a publisher called per settled batch. The publisher exists and nothing calls it; `review.sectionReadings` accepts only `"probe"`, so readings never publish.
7. **Carried decisions.** The design had earlier decisions shown and never closing. The owner ruled that they carry and close (14.12); main carries them, with known unsafe orderings that the redesign waiting to land closes.
8. **Code-decided sections.** The owner approved code-decided sections skipping the readings (14.17). The sections lane computes the rule judgements, the readings do not use them yet, and the coordinator narrowed the skip to generated files only.
9. **The backstop note's home.** The design had the NEU-146 cleanup export the note from the decision dock. The desk defines it in `packages/ui/src/neuve/shared/lane-facts.tsx`; the dock change is not on main.
10. **Undecided causes.** The design named four or five causes. The code has seven: `failed`, `not-reached`, `unsure`, `unconfirmed`, `disagreed`, `too-large` and `unreadable` (a binary or mode-only change).
11. **The finders and Map.** The design had finders wait for Map until code assigned groups. They now start when Frame lands; this file is corrected, the code was right.
12. **Declared tests on this repository.** The gap exemption for declared tests rests on repository declarations. On Neuve itself the declaration rule recognised 48 of 717 test files, because its packages run tests through a wrapper; the fix is waiting to land. Under 14.19 a declared test still never counts as evidence.

[A2]: ../decisions.md#area-2-harness-pipeline-16-october-2026
[A4]: ../decisions.md#area-4-units-lanes-and-dispositions-16-october-2026
[A5]: ../decisions.md#area-5-system-of-records-16-october-2026
[A7]: ../decisions.md#area-7-how-agents-build-neuve-16-october-2026
[A8]: ../decisions.md#area-8-records-rebuild-m2-17-october-2026
[A9]: ../decisions.md#area-9-benchmark-m4-17-october-2026
[A10]: ../decisions.md#area-10-harness-m3-18-october-2026
[A11]: ../decisions.md#area-11-verification-and-review-delivery-19-october-2026
[A12]: ../decisions.md#area-12-ace-style-pi-transition-28-october-2026
[A14]: ../decisions.md#area-14-lane-assignment-and-agent-dispositions-redesigned-12-november-2026
