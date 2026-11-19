# One loop, one copy of the skills: proposal

Status: proposal, drafted 18 November 2026 for the point [decision 14.35](../decisions.md#area-14-lane-assignment-and-agent-dispositions-redesigned-12-november-2026) leaves open ("moving the reviewer skills in `.agents/skills/` into what the CLI ships, so one copy serves both") and for its direction on scope retrieval. The owner ruled on it on 19 November 2026 ([14.36 to 14.41](../decisions.md#area-14-lane-assignment-and-agent-dispositions-redesigned-12-november-2026)); the rulings are listed first, below. Nothing here is built yet. The [decisions record](../decisions.md) wins wherever this text differs from it. Product words follow the [vocabulary](../../vocabulary.md); "leads" is the harness's internal word for the search results it stores per hunk ([`leads.ts`](../../packages/harness/src/leads.ts), lines 14–17) and is used here only in that sense.

## Rulings, 19 November 2026

| Question | Ruling | Row |
| --- | --- | --- |
| One skill or several | One skill. The reviewer's guidance becomes references of the shipped `neuve` skill | 14.36 |
| Does `final-reviewer` ship | Yes, as part of the full cycle. This replaces Part 1's answer that it stays in `.agents/skills/` | 14.36 |
| Pi sessions | Ace must reach and use the same skills. Whatever that needs is a follow-up in the backlog, not part of this work | 14.36 |
| When the review cycle opens | At the implementer's first read. A scope change after that belongs to the next cycle. Scope from an external source is fetched fresh for each cycle | 14.37 |
| Where scope comes from | Local documents and agents' scratchpads, referencing the original scope where there is one. Linear over MCP is part of the design | 14.37 |
| How the reviewer gets the scope | It runs the same command itself and decides what more it needs, as Part 2's step 1 recommends | 14.37 |
| What the reviewer's guidance must instil | Skepticism, reading first, results against the scope, planted problems to probe tests and validations, and a short loop | 14.38 |
| What data is kept | Full session transcripts and timings, locally. Nothing is sent; sending will be opt-in, after anonymisation | 14.39 |
| Which command reads the scope | `neuve query`, which fetches code and scope in parallel. No separate command for documents. Local sources are pre-processed; external ones are attributed and cited | 14.40 |
| What is prepared in the background | As much as possible, so expensive work is never repeated. Snapshots stay in place and are pruned at the next checkpoint, within what the machine can hold | 14.41 |

Still open: which boundary "the next checkpoint" names (14.41 records the coordinator's reading), and the design of scope reading inside `neuve query`, which is to be right from first principles before anything is built. Linear over MCP exists in the harness's scope snapshot and is tested against a fixture server only (14.40).

## At a glance

```
TODAY                                                  PROPOSED
.agents/skills/            read by Neuve's lanes       apps/neuve-cli/skills/neuve/
  inner-loop-reviewer        only; links into            SKILL.md
  review-verification        process/, foundations/      references/  (6 today)
  review-independence        and vocabulary.md           + the reviewer's guidance, written to
  review-against-scope                                     stand alone, with no link out of
  stack-sources                                            the folder
  final-reviewer                                       .agents/skills/
  explain-from-first-principles                          final-reviewer, explain-from-first-
apps/neuve-cli/skills/neuve/  shipped to users;          principles (Neuve's own; they link
  SKILL.md + 6 references       no reviewer guidance,    to the shipped files)
                                no scope retrieval
```

Part 1 moves the reviewer's guidance into the one shipped skill. Part 2 makes the implementer's opening retrieval a recorded step that the later review can build on. Each part ends with what the owner is asked.

## Part 1: the reviewer skills as a single copy

### What is there today

| Finding | Evidence |
| --- | --- |
| The CLI ships exactly one skill, named `neuve`. The share manifest accepts one skill entry and only that name | [`skill-bundle.ts`](../../apps/neuve-cli/src/skill-bundle.ts), lines 27, 191 and 199–200 |
| The template reader takes `SKILL.md` and any Markdown file under `references/`, and refuses anything else. A new reference needs no code change | [`skill-bundle.ts`](../../apps/neuve-cli/src/skill-bundle.ts), lines 128–155 |
| `neuve skills` installs into one `neuve/` folder per agent and scope, owned through one receipt whose `skill` field is that one name | [`skills-cli.ts`](../../apps/neuve-cli/src/skills-cli.ts), lines 39–51, 73 and 240–253 |
| The local install, the release build and the CLI's own lookup each name the template folder `apps/neuve-cli/skills/neuve` | [`install-local.ts`](../../apps/neuve-cli/scripts/install-local.ts), lines 771–775 and 1072–1079; [`scripts/release/build.ts`](../../scripts/release/build.ts), lines 111–112; [`skills-cli.ts`](../../apps/neuve-cli/src/skills-cli.ts), lines 146 and 155 |
| `skill-drift.test.ts` fixes the list of six references by name, requires a "Worked example" heading in each, requires each file to show at least one `neuve` command, and checks every command and flag against the built CLI's help | [`skill-drift.test.ts`](../../apps/neuve-cli/tests/skill-drift.test.ts), lines 306–328, 407–421 and 423–468 |
| `skills-cli.test.ts` tests installing, updating, refusing and uninstalling the one `neuve/` folder. It names no reference file | [`skills-cli.test.ts`](../../apps/neuve-cli/tests/skills-cli.test.ts), lines 141–222 |
| The five reviewer skills hold 59 links out of `.agents/skills/`: 40 into `process/decisions.md`, the rest into `foundations/`, `vocabulary.md`, the review standard and the M3 proposal | Counted with `grep` on each `.agents/skills/*/SKILL.md`; for example [`inner-loop-reviewer`](../../.agents/skills/inner-loop-reviewer/SKILL.md), lines 8, 12, 22–26 and 36 |
| `inner-loop-reviewer` says it serves "the inner-loop reviewer that Neuve skills prescribe to the people who install the CLI". The shipped skill has one paragraph on where a review sits and no guidance for that reviewer | [`inner-loop-reviewer`](../../.agents/skills/inner-loop-reviewer/SKILL.md), line 8; [shipped `SKILL.md`](../../apps/neuve-cli/skills/neuve/SKILL.md), line 47 |
| `stack-sources` and the shipped `references/stack.md` already say the same thing twice | [`stack-sources`](../../.agents/skills/stack-sources/SKILL.md), lines 8–28; [`references/stack.md`](../../apps/neuve-cli/skills/neuve/references/stack.md), line 21 |
| **No harness code reads the reviewer skills.** [Decision 11.7](../decisions.md#area-11-verification-and-review-delivery-19-october-2026) says the harness's Dispose prompts draw their guidance from these files. `git grep -i skill -- packages/harness/src` finds one comment and no reader, and no file there imports Markdown as text | [`stack/store.ts`](../../packages/harness/src/stack/store.ts), line 224, is the only match; [`text-modules.d.ts`](../../packages/harness/src/text-modules.d.ts), line 1, declares text imports that nothing uses |
| Pi sessions list skills from the checkout's `.agents/skills` and `.claude/skills` only | [`packages/channel/src/context.ts`](../../packages/channel/src/context.ts), lines 7 and 53–65 |

### Recommendation

**Move the reviewer's guidance into the shipped `neuve` skill, as references, written to stand alone.** The single copy lives in `apps/neuve-cli/skills/neuve/references/`. Neuve's lanes load the installed skill, as they already run the installed `neuve`.

| Question | Answer |
| --- | --- |
| Where it lives | `apps/neuve-cli/skills/neuve/references/`. Every build path already points there, so no path changes |
| Which skills ship | `inner-loop-reviewer`, `review-verification`, `review-independence` and `review-against-scope`, as four references. `stack-sources` folds into the existing `references/stack.md` |
| Which stay in `.agents/skills/` | `final-reviewer`, which describes the harness's own Dispose stage, and `explain-from-first-principles`, which is about writing for the owner. Both link to the shipped files instead of to siblings |
| Links for a user who has none of our files | The shipped text carries no link out of its folder and no decision number. Each rule is stated in place, with the product terms it needs defined in a sentence, as the shipped `SKILL.md` already does (line 14). Which decision row backs which rule stays on our side, in the [review standard's table](../adversarial-review-standard.md), which already maps each skill to its rows (lines 11–13) |
| `skill-bundle.ts`, `skills-cli.ts`, `install-local.ts` | No change. One skill, one manifest entry, one receipt |
| `skill-drift.test.ts` | The fixed reference list grows by four. One new check: no shipped file holds a link that leaves the skill folder. The "Worked example" and "shows a command" rules either get met by each new reference or are narrowed to the command references; that is the implementer's call |
| `skills-cli.test.ts` | No change |
| The shipped `SKILL.md` | Its description, "When not to load it" and reference table gain the reviewer's case, so an agent asked to review an implementer's work loads it |
| Our own process documents | The review standard, the lane loop and `AGENTS.md` link to the shipped references. A change to the reviewer's guidance reaches lanes with the next release, through `neuve upgrade`, as a CLI change does ([lane loop](../neuve-in-the-loop.md#which-neuve-runs)) |
| The harness prompts (11.7) | Nothing breaks, because nothing reads the files today. When that part of 11.7 is built, the harness inlines the shipped references and the two internal skills at build time. This proposal doesn't build it |

**Amends 11.7**, whose row says the skills "live in `.agents/skills/` as the single authority".

### Options rejected

| Option | Why not |
| --- | --- |
| Ship each reviewer skill as its own skill folder | Each would have its own trigger, which reads well. But the manifest, the receipt, the install targets, `list`, `doctor` and most of `skills-cli.test.ts` assume one skill. It is the larger change for the same text, and it can follow later without moving the text again |
| Keep `.agents/skills/` as the source and copy it into the bundle at build time | Two places to look, and the links would still need stripping by a script. The copy a user gets would not be the file we review |
| Rewrite the links to public URLs at build time | A user's agent would be sent to read maintainers' decision rows, at whatever state the default branch is in rather than the installed version |
| Commit a repository-scope install (`neuve skills install --scope repo`) into this repository | It puts a second, generated copy beside the source, which is the split this proposal removes |

### Open, for the owner

1. **One skill or several.** The recommendation folds the reviewer's guidance into `neuve`. Rule on that, or on separate skills.
2. **Does `final-reviewer` ship?** It covers "an outer agentic reviewer" as well as the harness's Dispose stage ([`final-reviewer`](../../.agents/skills/final-reviewer/SKILL.md), line 3). Whether a user's own agent is ever that outer reviewer is product meaning this proposal doesn't answer. It stays internal until ruled.
3. **Pi sessions.** They would no longer list the reviewer's guidance from the checkout, only from wherever the skill is installed. Whether Ace should list user-scope skills is open.

## Part 2: scope retrieval in the inner development loop

### What is there today

| Finding | Evidence |
| --- | --- |
| `neuve query` answers a question about the **code** at one revision: a Graph retrieval and the relationships asked for. It reads no ticket and no document as scope | [`cli.ts`](../../apps/neuve-cli/src/cli.ts), lines 41–43 and 115; [`domain.ts`](../../apps/neuve-cli/src/domain.ts), lines 26–35; [`graph-query.ts`](../../apps/neuve-cli/src/graph-query.ts), lines 602–659 |
| It prints its result and records nothing. Its return value is `kind: "unrecorded"`. What it leaves behind is the Graph snapshot in the machine's shared Graph cache, the one reviews' Graph reads also use | [`graph-query.ts`](../../apps/neuve-cli/src/graph-query.ts), lines 597–600, 635–638 and 658; [`cli.ts`](../../apps/neuve-cli/src/cli.ts), lines 127–174 |
| It requires `--max-results` and `--max-context-bytes`. The lane loop's command leaves both out | [`boundary.ts`](../../apps/neuve-cli/src/boundary.ts), lines 283–294; [lane loop](../neuve-in-the-loop.md), line 15 |
| The shipped skill doesn't teach it. Its only mention is a note about external disks | [`references/setup.md`](../../apps/neuve-cli/skills/neuve/references/setup.md), line 15 |
| A review's scope is the cycle's scope snapshot: tickets through a configured integration, documents at the base revision, then commit text. It is keyed by the cycle and never reused across cycles | [`scope.ts`](../../packages/harness/src/scope.ts), lines 62–80 and 891–908 |
| That snapshot is fetched when a cycle opens, and a cycle opens when a review is requested: `cycle.opened@1` enqueues `scope.fetch` | [`jobs.ts`](../../packages/records-core/src/jobs.ts), lines 76–83 |
| [Decision 3.12](../decisions.md) says scope is fetched "at the start of every cycle, for the inner loop and for the cycle's final review", and the vocabulary's review cycle runs "from scope gathering, through the inner development loop" | [`decisions.md`](../decisions.md), line 63; [`vocabulary.md`](../../vocabulary.md), line 65 |
| Background precompute exists for commits: `commit.prepare` runs code-only work in the worker's background slot as each commit lands, and stores hunks, chunks and per-hunk leads under keys made of tree and blob identities, so a later review reads them. No model work | [`commit-prepare.ts`](../../packages/harness/src/commit-prepare.ts), lines 70–104; [`leads.ts`](../../packages/harness/src/leads.ts), lines 69–85 |
| That precompute already follows [record 0016](../../architecture/decisions/0016-shared-work.md): jobs are enqueued once per key in the event's own transaction, and the child skips any key another caller holds | [`jobs.ts`](../../packages/records-core/src/jobs.ts), lines 12–28; [`commit-prepare.ts`](../../packages/harness/src/commit-prepare.ts), lines 4–5 and 1117–1119 |

So the product meaning and the code differ in one place. In the decisions and the vocabulary, a review cycle starts with scope gathering, before the inner development loop. In the code, scope is gathered only when the final review is requested, and the inner loop's `neuve query` is a code search that leaves no record.

### Recommendation

**Do it in two steps, and only the first now.**

**Step 1, teach what exists.** A new reference in the shipped skill covers the inner development loop:

- **Implementer.** Before reading the code, run `neuve query` at the base revision with the ticket's goal and done-when as the question, with all its required flags. The reference says plainly that this returns code to read and is not the scope; the ticket or document stays the scope.
- **Reviewer.** Run the same command at the same base revision. The answer is bound to the revision, and the Graph snapshot is already cached, so the reviewer gets the same context without taking a file from the implementer. That keeps the reviewer's independence.
- **The lane loop** links to that reference and drops its own copy of the command, which fixes the missing flags.

`skill-drift.test.ts` then checks the taught command against the CLI's help, as it does every other.

**Step 2, record the retrieval and prepare from it, after the owner rules on the open questions below.** The shape, if the owner agrees:

```
neuve query ──► answer streams to the implementer (unchanged)
     │
     └─► one Records event for the retrieval (revision, question, counts, timings)
              │   this is the dogfooding data 14.35 asks for
              └─► one background job, keyed by the base tree and the scope text's hash
                     code-only, in the worker's background slot, as commit.prepare is
                     stores what a later review of that base can read under the same key
```

- **One mechanism, both purposes.** The event is the record of the inner retrieval, and it is what enqueues the background work.
- **Shared work follows 0016 only.** One run per key through the existing Computations store and shared-work helper. No new claim, no polling, no duplicate run.
- **Keys are content, never the session.** Work keyed by tree, blob and text hash is found by any later review of the same base, as `commit.prepare`'s is.
- **No model work in the background**, as for `commit.prepare`.

### Options rejected

| Option | Why not |
| --- | --- |
| Teach the reviewer to re-read a file the implementer saved | The reviewer would judge scope adherence from the implementer's copy. Running the command again costs little and keeps the two sessions apart |
| Open the review cycle and fetch its scope snapshot at the implementer's first command, now | It may be what 3.12 means, but a snapshot belongs to one cycle and is never silently refetched. A ticket edited during the inner loop would then reach final review stale. That is the owner's call (open question 1) |
| Have `neuve query` write straight into the review's stores | It would be a second writer beside the worker's jobs, outside 0016 |
| Start a `neuve review` at the base to warm everything | 14.35 rules it out: no Neuve review runs in the inner loop |

### Open, for the owner

1. **When does the review cycle open?** 3.12 and the vocabulary put scope gathering at the cycle's start, before the inner loop. The code opens the cycle at the final review. If the implementer's opening retrieval opens the cycle, what happens to its scope snapshot when the ticket changes before final review?
2. **Should the opening retrieval read the scope itself?** The owner's words are "allow neuve to source scope", from Linear or local documents. `neuve query` reads code only. Whether Neuve should fetch the ticket and documents for the implementer, as the cycle's scope snapshot does for a review, and through which command, is not decided. This proposal names no command.
3. **What are "leads for the review's readers" here?** Stored leads belong to a changed file's hunks, and none exist before the implementer writes code. Before that, the base tree's Graph snapshot and keyword chunks can be prepared, and code could be searched from each scope section's text. Whether the review's readers should receive results searched from scope text is a change to what the harness reads, and is open.
4. **What data is kept for dogfooding?** The recommendation keeps one Records event per retrieval. Whether the question's text is kept, and for how long, follows the scope-text rules (3.12, 10.8) unless the owner says otherwise.

## Found on the way

- The lane loop's `neuve query` command was missing two required flags. Fixed on 18 November.
- Record 0016 named `packages/harness/src/shared-build.ts`, which no longer exists, and said "not built across processes" while `packages/records-core/src/shared-work*.ts` exist. The record's status and consequences were brought level with the code on 19 November.
- The harness side of 11.7 is not built (Part 1's table).
