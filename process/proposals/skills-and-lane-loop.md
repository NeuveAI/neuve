# One loop, one copy of the skills: proposal

Status: proposal, drafted 18 November 2026 for the point [decision 14.35](../decisions.md#area-14-lane-assignment-and-agent-dispositions-redesigned-12-november-2026) leaves open ("moving the reviewer skills in `.agents/skills/` into what the CLI ships, so one copy serves both") and for its direction on scope retrieval. The owner ruled on it on 19 November 2026 ([14.36 to 14.50](../decisions.md#area-14-lane-assignment-and-agent-dispositions-redesigned-12-november-2026)); the rulings are listed first, below. Nothing here is built yet. The [decisions record](../decisions.md) wins wherever this text differs from it. Product words follow the [vocabulary](../../vocabulary.md); "leads" is the harness's internal word for the search results it stores per hunk ([`leads.ts`](../../packages/harness/src/leads.ts), lines 14–17) and is used here only in that sense.

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
| What is prepared in the background | As much as possible, so expensive work is never repeated. Snapshots stay in place and are pruned at the start of the next cycle, within what the machine can hold | 14.41 |

The pruning boundary of 14.41 is the start of the next review cycle, confirmed by the owner on 19 November. The design that follows these rulings is [Part 2: design](#part-2-design), whose open questions the owner ruled on the same day (14.44 to 14.47); what is still to design is listed at its end. Linear over MCP exists in the harness's scope snapshot and is tested against fixture servers only (14.40).

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

## Part 2: design

Status: proposal for the owner, written 19 November 2026 after rulings 14.37 and 14.39 to 14.41. Nothing here is built. It follows the rulings; where it needs product meaning they don't give, it says "open". Two working words are used and are not product terms: "first read" is the owner's phrase for the implementer's opening `neuve query` (14.37), and "pruning boundary" names the one place where a cycle's kept copies are removed, which is the start of the next review cycle (14.41; section 4).

```
neuve query (first read on a branch)
  │
  ├─► opens the review cycle ─────────────► Records: one opening event (base, branch)
  │                                           └─► enqueues, in the same transaction:
  ├─► code read  ┐ in parallel,                     scope fetch   (joins the query's own fetch)
  ├─► scope read ┘ one answer                       base preparation (code only, background)
  │
  ▼
answer: code candidates + scope sources, each with its citation, gaps disclosed

… implementer commits (commit.prepare runs per commit, as today) … reviewer runs the same query …

neuve review <base>..<head>
  └─► joins that cycle: reads its stored scope, reads commit text from Git, finds the base prepared
       └─► after its run publishes, the next first read on the branch opens the next cycle
            └─► pruning boundary: the previous cycle's kept copies go
```

### 1. What the answer holds

Today the answer is a stream of `retrieval`, `relationship` and `complete` events, or one collected object ([`domain.ts`](../../apps/neuve-cli/src/domain.ts), lines 330–373). The design adds one event kind per scope source and one list in the collected object. It adds no second record shape: each entry is the scope source record the review already stores ([`scope.ts`](../../packages/harness/src/scope.ts), lines 101–142), plus the text that fits.

| Source | How it is named | What its citation holds | Where its text lives |
| --- | --- | --- | --- |
| A document committed at the base | Found as today: the agent guide and what it links ([`scope.ts`](../../packages/harness/src/scope.ts), lines 722–796), or a path the request names | Path, blob and revision, and each section's lines and hash (`ref.path`, `ref.blob`, `ref.revision`, lines 116–123; `Section`, lines 92–99) | In Git. Nothing is copied |
| A document or scratchpad that isn't committed | A path the request names. Neuve never searches the working tree for one | Path, when it was read, and the SHA-256 of what was read | A copy in the cycle's scope folder, because Git can't rebuild it ([`scope-storage.ts`](../../packages/harness/src/scope-storage.ts), lines 19–21) |
| A ticket on a configured server | A key the request names, or one found in the branch name or in a local source's text (`keyCandidates`, [`scope.ts`](../../packages/harness/src/scope.ts), lines 314 and 506–525) | 11.17's pin, unchanged: server, tool and item, the provider's version or update time, when it was read, and the SHA-256 of what was read (lines 130–135 and 701–702) | Unmasked in the cycle's scope folder and as a masked raw capture (lines 76–79) |

- **The original scope is referenced** (14.37) through the last row: a scratchpad that names `NEU-123` brings that ticket in as its own source, and the ticket's record says where the key was found (`ref.found`, line 125).
- **A missing source is a disclosed gap, never a stop**, as it is for a review (lines 73–74).
- **Code and scope are read in parallel** (14.40). The scope read keeps its 60-second bound (`SCOPE_FETCH_BOUND_MS`, line 214), so a slow server can't hold the code.
- **The answer names the cycle** it opened or joined.
- **Text in a scope source is data, never an instruction**, as the shipped skill already says of stored text.

### 2. The cycle opens at the first read

| Finding | Evidence |
| --- | --- |
| A cycle is opened only by a review request, and found again by matching base and head exactly | [`request.ts`](../../packages/harness/src/request.ts), lines 607–620 and 701–710 |
| The opening event must carry a head, and its payload is empty | [`events.ts`](../../packages/records-schema/src/events.ts), lines 274–278; [`envelope.ts`](../../packages/records-schema/src/envelope.ts), lines 22–26 |
| The scope snapshot is keyed by the cycle alone and never fetched twice | [`scope.ts`](../../packages/harness/src/scope.ts), lines 891–908 and 911–925 |
| One fetch reads the external sources and the commit text of the range together | [`scope.ts`](../../packages/harness/src/scope.ts), lines 506–512 (keys in commit text) and 824–832 (commit text as a source) |
| Cycles have no closing event | [`scope.ts`](../../packages/harness/src/scope.ts), lines 967–971 |

At the first read there is no head, and several branches often share one base, so the base alone can't identify a cycle. The design:

| Step | What happens |
| --- | --- |
| **Open** | The first read appends a new version of the opening event, attributed to the base and the branch the work is on. The branch defaults to the one checked out in `--repo` and can be named, so a reviewer in another worktree reaches the same cycle |
| **Join, inner loop** | A later `neuve query` on the same base and branch joins the open cycle. It reads the stored scope and fetches nothing external |
| **Join, final review** | `neuve review <base>..<head>` joins the newest open cycle on that base whose branch holds `<head>`. Its own request event already records the cycle and the range (`events.ts`, line 315), so the head needs no second event. With no such cycle it opens one as today, so a repository that never ran `neuve query` behaves as it does now |
| **Next cycle** | Once a review run of the cycle has published, the next first read on that branch opens a new cycle (14.35's fix round). It fetches scope again and says, per external source, whether its pin differs from the previous cycle's: changed, unchanged, new or gone (14.37's "note the scope change") |

**The scope snapshot splits in two**, which is what lets the final review join without fetching again:

| Part | Holds | Key | Fetched |
| --- | --- | --- | --- |
| The cycle's part | External sources, documents at the base, named working files | The cycle, as today | Once, at the first read. "No-cache" (14.37) |
| The range's part | Commit text, and documents the commits name | Base and head | At the review, from Git only. No server is called |

The rule that decides "this cycle is over, the next read opens a new one" lives in one function. Section 4's pruning boundary is that same function.

### 3. What the background prepares

The opening event enqueues jobs in its own append transaction, as every event does ([`jobs.ts`](../../packages/records-core/src/jobs.ts), lines 12–13). Each piece of work is a stored computation keyed by content and run through the Computations store, which already uses the shared-work helper across processes ([`computations.ts`](../../packages/records-core/src/computations.ts), lines 349 and 684; [record 0016](../../architecture/decisions/0016-shared-work.md)). So the query, the worker and a later review that ask for the same key get one run, and the others subscribe.

| Prepared | Key | Builds on | New? |
| --- | --- | --- | --- |
| The cycle's scope | The cycle | `scope.fetch`, which a review already shares with an attempt in flight ([`jobs.ts`](../../packages/records-core/src/jobs.ts), lines 229–236). The query runs or joins the same computation | Existing job, new caller |
| The base tree's keyword index | Each blob, then the tree and recipe | `blobChunks` and `treeIndex` ([`search-index.ts`](../../packages/harness/src/search-index.ts), lines 432 and 1327–1343) | Existing computations, new trigger |
| The base's Graph relations | As `commitRelations` stores them | The computation a review's relations task reads ([`commit-prepare.ts`](../../packages/harness/src/commit-prepare.ts), lines 86–88 and 412) | Existing computation, new trigger |
| The base's Graph snapshot | The repository and revision | Already made by the query itself in the shared Graph cache ([`graph-query.ts`](../../apps/neuve-cli/src/graph-query.ts), lines 635–638) | Nothing to add |
| The query's own answer for the code | Revision, question, limits, relationship plan and the engine's identity | Nothing today: the answer is unrecorded (lines 597–600) | New. The reviewer's same command then reads it or subscribes |
| Searches of the base from each scope section's text | Section hash, base tree and retriever recipe, shaped like a hunk's leads ([`leads.ts`](../../packages/harness/src/leads.ts), lines 69–85) | The retrievers `commit.prepare` uses | New (slice 8); ruled in by 14.47 |

- **Per commit, nothing changes.** `commit.prepare` keeps preparing hunks, chunks and leads as commits land ([`commit-prepare.ts`](../../packages/harness/src/commit-prepare.ts), lines 70–88).
- **No model work.** The rulings ask that expensive computations not be repeated (14.41); none asks for model work in the background, and `commit.prepare` has none (line 72).
- **Machine budget.** The base preparation runs as `commit.prepare` does: in the background slot, inside one background CPU grant, with only its CPU priority lowered, and it skips any key another caller holds (lines 83–85, 95–99 and 715; 10.93, 14.20).
- **Dogfooding data** (14.39) is the opening event and one event per later query: revision, question, counts and timings, written locally to Records. Nothing is sent.

### 4. What is kept and what is pruned

| Kept thing | Where | Rule | When it goes |
| --- | --- | --- | --- |
| Committed documents | Git; cited by path and blob | 12.45's precedent: what Git rebuilds isn't copied | Never copied, so nothing to prune |
| Unmasked text of tickets and uncommitted files | The cycle's scope folder | 10.79, 14.41 | At the pruning boundary. The 7-day idle sweep stays as the backstop for a cycle no one continues ([`scope.ts`](../../packages/harness/src/scope.ts), lines 964–973 and 1023–1024) |
| Masked raw captures of fetched text | Blobs | 8.10 | 30 days, unchanged ([`retention.ts`](../../packages/records-core/src/retention.ts), line 26) |
| The scope snapshot's record: sources, pins, section index | A stored computation | 8.10: an output the pipeline reuses | Kept. It holds no ticket text (`scope.ts`, line 79) |
| Indexes, relations, stored query answers, scope-section searches | Stored computations keyed by content | 14.21: each kind is declared recomputable with a byte cap, and Records evicts the oldest past it ([`evictable.ts`](../../packages/records-core/src/evictable.ts), lines 7–13 and 186) | At the boundary when the pruning check shows no open cycle can still reuse them (14.44); otherwise under their caps. A new cycle on the same base reuses them |
| The base's Graph snapshot | The machine's shared Graph cache | Its own cache rules | Unchanged |

**The pruning boundary is one named function.** The owner confirmed on 19 November 2026 that "the next checkpoint" of 14.41 is the start of the next review cycle: not the cycle's end, not each commit, not the merge. The design puts the boundary where section 2 decides the next cycle opens, and nowhere else. `deleteCycleScope` already exists for it and already expects a second caller ([`scope.ts`](../../packages/harness/src/scope.ts), lines 967–973).

### 5. Linear over MCP: what exists, and what the query reuses

| Exists | Evidence | Reused by the query |
| --- | --- | --- |
| A user-level file names each MCP server, its read-only tools, the variables it may receive and how one item is fetched by key. The repository's `.mcp.json` is never read. Neuve stores no credential | [`integrations.ts`](../../packages/harness/src/integrations.ts), lines 7–18 and 72–110 | As is |
| A client that connects each server at most once, on first use, and closes with its scope | [`mcp-client.ts`](../../packages/harness/src/mcp-client.ts), lines 311–330 | As is |
| The ticket fetch: keys filtered by each server's prefixes, a shared time bound, the pin, the kept copies | [`scope.ts`](../../packages/harness/src/scope.ts), lines 529–560 and 667–702 | As is, with keys from the request and local sources instead of commit text |
| An explicit selection of one item on one server, admitted before the cycle opens | [`events.ts`](../../packages/records-schema/src/events.ts), lines 259–271; [`request.ts`](../../packages/harness/src/request.ts), lines 569–588 | The query's way to name a ticket |
| A Linear mapping (`linear-v1`: search, issue, dependencies) and a session over it, used by the coding home | [`integrations.ts`](../../packages/harness/src/integrations.ts), lines 50–70; [`linear-planning.ts`](../../packages/harness/src/linear-planning.ts), lines 22–150 | Not needed for the first slices: the query fetches named items, it doesn't search Linear |
| Tests against local fixture servers only | [`scope-integration.test.ts`](../../packages/harness/tests/scope-integration.test.ts), lines 4 and 13; [`linear-planning.test.ts`](../../packages/harness/tests/linear-planning.test.ts), line 12 | No capture against the real Linear is recorded (14.40). Slice 5 needs one, and the owner's sign-in |

### 6. Build order

Each slice is one implementer and one reviewer. Slices 1 to 5 run in order; 6 and 7 need only slice 2; 8 is last.

| # | Slice | Done when |
| --- | --- | --- |
| 1 | **Record the query.** One Records event per `neuve query` run: revision, question, counts, timings | The event is in the store's history after a run; the printed answer is byte-for-byte what it was; with telemetry off the event is still written (12.55 keeps Records' records) |
| 2 | **Open and join the cycle.** The new opening event, the branch, the join rules and the one function that decides the next cycle | A first read opens a cycle; a second on the same base and branch joins it; two branches on one base get two cycles; a review of `<base>..<head>` joins and enqueues no second scope fetch; a review with no earlier query behaves as today; a first read after a published run opens a new cycle |
| 3 | **Split the scope snapshot.** The cycle's part and the range's part | A review that joins a cycle reads commit text and calls no server (the fixture server counts zero calls); a review that opens its own cycle reads what it reads today |
| 4 | **Local scope in the answer.** Committed documents and named uncommitted files, with citations, in parallel with the code | The answer and the stream carry each source with its citation; an uncommitted file is hashed and copied into the cycle's folder; a missing path is a gap in the answer and the code still arrives; the skill's reference teaches it and `skill-drift.test.ts` passes |
| 5 | **Tickets in the answer.** A named key, or one found in the branch or a local source, through the configured server; the change note against the previous cycle | Against the fixture server: pin, masked capture and gap cases pass, and a changed ticket is reported as changed in the next cycle. Against the real Linear: one recorded capture, run by the owner's sign-in |
| 6 | **Base preparation.** The background job for the base tree's index and relations, and the stored code answer | After a first read, a review of that base finds each stored and computes none again; a query and the job asking at once make one run per key; the job stays inside its grant |
| 7 | **The pruning boundary.** `deleteCycleScope` and the pruning check (14.44) called from slice 2's function; new kinds declared recomputable with caps | Opening the next cycle removes the previous cycle's unmasked copies, and each content-keyed output the check shows no open cycle can reuse; nothing an open cycle still needs is removed; the snapshot record remains; the 7-day sweep still runs |
| 8 | **Scope-section searches.** Stored searches from scope text, given to the review's readers (14.47) | A review of a cycle whose scope has sections finds a stored search per section and its readers receive them; a query and the job asking at once make one run per key |

### Ruled by the owner, 19 November 2026

| Question | Ruling | Row |
| --- | --- | --- |
| What goes at the pruning boundary | Whatever can or should be pruned, decided by a check that nothing still needs it. Not a fixed list. This replaces section 4's "never at the boundary" for content-keyed outputs: one goes when no open cycle can still reuse it, and otherwise stays under its cap | 14.44 |
| Uncommitted files | Read only when the request names them, as designed. A copy of every external source is held as part of the scope and is what citations rest on, through the review to the review desk, which links out to the source where that fits. External means an integration such as Linear over MCP, and nothing else for now | 14.45 |
| Transcripts | Kept locally under a size cap, not expired at 30 days. A transcript joins a dataset only after it is analysed, graded and labelled, and can then be moved there | 14.46 |
| Scope-section searches | Yes: the review's readers receive them. Slice 8 is part of the work | 14.47 |
| Sources nobody named | Yes: Neuve also looks for scope on its own, beyond the agent guide and what it links | 14.47 |

### 7. The pruning check (14.44)

Proposal, written 19 November 2026. Nothing here is built. It is the design of slice 7.

**Principle.** A kept thing goes when nothing that can still be asked for leads to it, and the check works that out from Records and Git at the moment it runs; it keeps no list of its own. How strict the check is depends on one question: can the thing be rebuilt? A wrong prune of something rebuildable costs time. A wrong prune of something that can't be rebuilt loses it, so that check must be certain.

| Kept thing | Rebuildable? | The check reads | It goes when |
| --- | --- | --- | --- |
| A cycle's unmasked scope copies (ticket text, named uncommitted files) | No. An external source is fetched once per cycle (14.37) and a scratchpad may be gone | Records: whether a later cycle is open on that cycle's branch, and whether any job of the cycle is queued or running | All three hold: the cycle is over, no job of it is unfinished, and every human-required unit of it is decided (14.48). Otherwise it stays. The 7-day idle sweep must not remove the copies of a cycle with an undecided human-required unit either |
| Outputs keyed by a tree: the tree's keyword index, relations, stored query answers, scope-section searches | Yes | Nothing at the boundary | Never at the boundary. They stay under their byte cap (14.21, 14.48), so a branch cut later from the same base reuses them |
| Outputs keyed by a blob: chunks, and leads by blob pair | Yes | Nothing at the boundary | Never at the boundary. They stay under their byte cap (14.21). Deciding whether any open tree still holds a blob would cost more than the output |

What it builds on:

| Need | Exists | Evidence |
| --- | --- | --- |
| Removing a cycle's copies | `deleteCycleScope`, written to gain a second caller | [`scope.ts`](../../packages/harness/src/scope.ts), lines 967–979 |
| Knowing when a cycle last did anything | `lastRunActivity`, read from Records | [`scope.ts`](../../packages/harness/src/scope.ts), lines 981–997 |
| A reader that arrives after the copy is gone | It gets no text and discloses that the copy is gone; it does not fail | [`scope.ts`](../../packages/harness/src/scope.ts), lines 948–962; [`lookups.ts`](../../packages/harness/src/lookups.ts), lines 1622–1632 |
| Reading a stored output's inputs | The key's material holds them, and Records already selects outputs by an input's value | [`computations.ts`](../../packages/records-core/src/computations.ts), lines 84–93 and 309–316 |
| Removing a stored output safely | Eviction of a kind declared recomputable: one output per write transaction, never one stored in the last 15 minutes, files removed after the commit | [`evictable.ts`](../../packages/records-core/src/evictable.ts), lines 7–17 and 446–454 |
| Never removing what must stay | The store refuses to evict an output an event names or a model produced | [`evictable.ts`](../../packages/records-core/src/evictable.ts), lines 139–178 |
| A reader that races a removal | `evictedMeanwhile`: the read is a miss, and the output is computed again under the same key | [`evictable.ts`](../../packages/records-core/src/evictable.ts), lines 255–273 |

- **Two branches on one base.** Scope copies sit in a folder per cycle, never per base ([`scope-storage.ts`](../../packages/harness/src/scope-storage.ts), lines 19–21), so one branch's boundary can't touch another's copies. Content-keyed outputs for the shared base are not touched at the boundary at all (14.48).
- **A prune that races a reader.** No lock and no polling are added. For outputs, the existing contract holds: a reader that loses the race recomputes under the same key, through the shared-work helper, so two readers that both miss still make one run ([record 0016](../../architecture/decisions/0016-shared-work.md)). That contract now matters only for eviction at the cap, since nothing content-keyed is removed at the boundary. For scope copies, the next cycle opens only after a run of the previous one has published (section 2), later requests join the new cycle, and a late reader discloses the missing copy.
- **"Open cycle" is defined once**, in the function section 2 names: opened, not followed by a later cycle on its branch, and active within the idle limit the sweep already uses.
- **Where it runs.** As a background job enqueued by the opening event, like the daily prune ([`jobs.ts`](../../packages/records-core/src/jobs.ts), lines 215–223), never inside the query's answer.
- **No addition to Records' eviction.** The owner ruled that content-keyed outputs go only at their caps (14.48), so the oldest-past-the-cap rule is all that is needed. The check adds one thing to read: whether a cycle still has an undecided human-required unit.

**Ruled by the owner, 19 November 2026 (14.48):** a cycle's copies stay while any of its human-required units still waits for a decision; an output no open cycle needs goes only at its byte cap.

**Not verified:** whether the review desk reads the unmasked copies or only what the review stored; the store's eviction triggers themselves (the migration was not read); what the log scan for "named by an event" costs on a large store; whether every tree-keyed kind names its tree as an input that can be selected on.

### 8. Finding scope nobody named (14.47)

Proposal, written 19 November 2026. Nothing here is built.

**Principle.** A document is found by what points at it or what it says, never by what it is called. Every found document is shown as found, with the reason, and is kept apart from what the request named.

What a review does today: it reads the agent guide by a declared reader and follows its relative links one hop, reads paths the commit texts name, and treats ticket keys as candidates that an integration's declared prefixes confirm ([`scope.ts`](../../packages/harness/src/scope.ts), lines 310–330, 356–365 and 735–764).

| Signal | Builds on | It can establish | It cannot establish |
| --- | --- | --- | --- |
| A link from a document already in scope | `linkedPaths`, today from the agent guide only (lines 336–353) | That the repository's own text points there | That the target is about this work |
| A path named in a text already in scope: a ticket, a named scratchpad, a commit message | `namedPaths`, today for commit text only (lines 322–330 and 758–764) | That the work's own scope points at that file | That the file is a plan rather than code the ticket mentions |
| The cycle's ticket key in a document's text | `keyCandidates` (lines 310–320) and the base tree's keyword index | That the document mentions this work's ticket | Whether it is the plan, a changelog or a note in passing |
| Retrieval from the question's text | The query's own code read, and the keyword index, which reads prose through a declared capability ([`chunker.ts`](../../packages/harness/src/chunker.ts), lines 50–63) | That the text is about the same subject | That anyone meant it as scope. It is the weakest signal |
| The repository's own declarations | The `gitattributes` reader, including `linguist-documentation` ([`declarations.ts`](../../packages/harness/src/declarations.ts), lines 27–29) | That the repository calls the file documentation | Anything about this work. It can order candidates; it finds none |

- **Order.** The first three signals are references, and a document they reach is read as scope. Retrieval only proposes: its candidates are listed in the answer, with their citation, and their text is not read as scope unless a reference signal also reaches them.
- **Disclosure.** Every source already records how it was found (`ref.found`, [`scope.ts`](../../packages/harness/src/scope.ts), lines 124–125). The answer shows named sources first and found ones after, each with its reason in plain words: "linked from …", "named in ticket …", "mentions NEU-123".
- **Bounds.** The existing ones hold for named and found sources together: 20 documents, 262,144 bytes each, 20 tickets, and 60 seconds for the whole scope read (lines 214–219). Named sources take their places first. What is left unread is a disclosed gap, as today (lines 765–769). Links are followed one hop from each document in scope, as today from the agent guide. Retrieval adds no search of its own at the first read: it reuses the code read the query already runs, and the keyword searches are stored computations made inside the base preparation's grant (section 3).
- **No name and no extension is trusted.** The one name already in use is the agent guide's, read by its declared reader (lines 356–365). This design adds none.

**Asked of the owner**

1. **What a found document counts for.** Ruled on 19 November 2026 (14.49): context only. Its "Done when" items become validation requirements only when a person or the request confirms it.
2. **A constitution exception, not assumed.** Two shortcuts would find more and both trust names: reading other agents' guide files by their fixed names, and preferring files under conventionally named folders. Neither is in this design. If the owner wants either, it needs an exception to the [neutrality rule](../../CONSTITUTION.md#repository-language-neutrality) of the kind 14.18 and 14.24 are.
3. **Prose by declared capability.** The keyword index decides which files it reads as prose by a capability that declares path suffixes. The design uses that only to split text into sections, never to decide what is scope. Say if even that use needs a ruling.

**Not verified:** whether the Graph engine's retrieval returns prose documents at all, or only code; how often a ticket key appears in documents that are not about the ticket; whether 20 documents is enough once found sources share the limit; the cost of the key searches on a large tree. No signal was tried on a real repository.

### 9. Transcripts into datasets (14.46)

Proposal, written 19 November 2026. Nothing here is built. It is outside the slices of section 6 and has its own build order below.

**What exists**

| Finding | Evidence |
| --- | --- |
| An agent session's transcript is captured in segments: each turn's end records the transcript's size, and a background job copies the new segment into a raw-capture blob. Consecutive segments tile the whole transcript. Prompt text exists only in that blob; the stored summary holds counts and the model's name | [`transcripts.ts`](../../packages/records-core/src/transcripts.ts), lines 33–45; [`jobs.ts`](../../packages/records-core/src/jobs.ts), lines 37–48 |
| Raw captures expire 30 days after capture, with no exemptions. A pruned blob keeps its row, so events that name it still resolve and say when it was pruned | [`retention.ts`](../../packages/records-core/src/retention.ts), lines 21–26 |
| A dataset is already a defined thing for review runs: `neuve review export-dump` files a run's session dump into a folder outside the Records store, by redaction mode (`restricted` or `portable`), in the `neuve.session-dump` format, and the dataset's own root keeps it | [`review-cli.ts`](../../apps/neuve-cli/src/review-cli.ts), lines 133–135, 375–378, 677 and 728; [`candidate/capture.ts`](../../packages/evaluation/src/candidate/capture.ts), lines 21–27 |
| Exporting is a copy: it "does not change the age or identity of a stored raw capture" | [Record 0004](../../architecture/decisions/0004-persistence-and-range-immutability.md), line 31 |
| `neuve query` runs no model, so it has no transcript of its own. Its transcript is the agent session that ran it, captured as above, plus the query's own event (slice 1) | [`graph-query.ts`](../../apps/neuve-cli/src/graph-query.ts), lines 602–659 |

So there is a dataset shape to reuse, but only review runs can be exported into it, and the transcripts 14.46 is about still expire by age.

**The design**

```
captured ──► analysed ──► graded ──► labelled ──► moved into a dataset
(raw, in Records,          each step is one Records event          (outside Records;
 counts toward the cap)    naming the session and who did it        no longer counts)
```

| Question | Answer |
| --- | --- |
| What the unit is | A whole session, never a segment. Segments are how it is stored |
| What the cap changes | The transcripts of query and inner-loop sessions stop expiring by age. Once their bytes pass the cap, the oldest sessions go, whole, leaving the same row behind that pruning leaves today. Every other raw capture keeps its 30 days |
| What a state is | A Records event against the session: who analysed, graded or labelled it, and a reference to what they wrote. The state is read from those events; the transcript itself is never edited |
| What the cap may not remove | A session that has a grade or a label and has not been moved yet. Work a person or agent put into it is not thrown away by a size rule. If such sessions alone pass the cap, capture continues and `neuve doctor` says so |
| What "moving" means | The session is filed into a dataset folder outside the Records store, in the existing dump format and redaction modes, with its analysis, grades and labels beside it. The filed copy is checked against the stored hashes. Only then is the copy in Records released, and its row says it was moved and where. From then on the dataset's own root keeps it and the cap no longer counts it |
| What stays local | Everything. The dataset folder is on this machine. Nothing is sent (14.39) |

Moving, unlike today's export, removes the copy in Records. That amends record 0004's sentence for these transcripts.

**Left for later, on purpose:** sending anything, and the anonymisation that must come before it (14.39); the rubric a grade follows and the set of labels; any screen for grading; a cap that scales with free disk space (14.21 left the same follow-up); reading these datasets from `packages/evaluation`.

**Build order**

| # | Slice | Done when |
| --- | --- | --- |
| T1 | **Measure.** A read-only report of the bytes held as transcript captures, by session and age | The report runs on this Mac's store and its numbers are in the ticket, so the cap is chosen from a measurement |
| T2 | **Cap in place of age.** The pruner stops expiring these transcripts by age and removes the oldest whole sessions past the cap | A 31-day-old session under the cap is still readable; past the cap the oldest session goes whole and its row says so; a review run's raw captures still expire at 30 days |
| T3 | **States.** Events for analysed, graded and labelled, and a listing of sessions with their state | Each event is in the store's history against its session; the listing shows the state; the cap skips a graded or labelled session |
| T4 | **Move.** File a labelled session into a dataset folder and release the copy in Records | An unlabelled session is refused; a folder inside the store is refused, as export refuses it today; the filed copy matches the stored hashes; the cap's count drops; the session's events still resolve and say where it went |

**Asked of the owner**

1. **The cap's size.** A fixed number, chosen after T1's measurement, as 14.21 chose 1 GiB.
2. **What each state requires.** What makes a transcript "analysed", what a grade is measured against, and which labels exist are not designed here. Who may grade, and whether an agent may grade a session of its own lane, is product meaning the owner has not ruled.
3. **Graded but not moved.** Ruled on 19 November 2026 (14.50): the cap never removes such a session.
4. **Review runs.** 14.46 names query and inner-loop sessions. A review run's session dump keeps 30 days and copy-only export. Say if those should follow the same path.

**Not verified:** which stored field tells a transcript capture from any other raw capture; how large the transcripts on this machine are; whether the `neuve.session-dump` format can hold a hook-captured transcript as it is or needs a second kind beside it; whether the labelling code in `packages/evaluation/src/pr-replay` could be reused for grading; what NEU-54's pi session capture adds for sessions run through the coding home (its modules under `packages/harness/src/pi/capture/` were listed, and only `export.ts`'s imports were read).

### Not verified

- **Branch as the cycle's identity.** Not checked against a worktree with a detached `HEAD`, a renamed branch, or a reviewer's worktree on another branch. Slice 2 settles it.
- **"Newest open cycle whose branch holds the head"** is a proposed rule; no code was run to try it.
- **The Graph answer is the same for the same revision and question.** The help calls it "revision-bound" ([`cli.ts`](../../apps/neuve-cli/src/cli.ts), line 115); that a stored answer equals a fresh one was not tested.
- **The query process can run the scope computation itself** when no worker is up. `review` does so inside Precompute; that `neuve query`'s process can load the same code was not tried.
- **`computations.ts` shares every stored computation across processes.** Lines 349 and 684 name the helper; the paths around them were not read through.
- **How much the base preparation saves** a later review. No timing was taken.
- **The answer's byte limit.** How scope text shares `--max-context-bytes` with the code was not designed.
- **Line numbers** were read on branch `lane-loop-unify` on 19 November 2026, and those of sections 7 to 9 on `part2-design-rulings` the same day. They will drift.
- **Linear itself.** Nothing was run against the real service.

## Found on the way

- The lane loop's `neuve query` command was missing two required flags. Fixed on 18 November.
- Record 0016 named `packages/harness/src/shared-build.ts`, which no longer exists, and said "not built across processes" while `packages/records-core/src/shared-work*.ts` exist. The record's status and consequences were brought level with the code on 19 November.
- The harness side of 11.7 is not built (Part 1's table).
