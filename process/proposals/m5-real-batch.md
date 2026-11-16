# M5 "Real batch in the desk": design proposal

Historical proposal. Its review-stage graph and budgets are superseded by the [fixed-shape pipeline record](../../architecture/decisions/0005-harness-pipeline.md), which describes the NEU-111 trial. The [owner's decisions](../decisions.md) remain authoritative for accepted product meaning and the other topics below.

Status: accepted by the owner on 22 October 2026 as [10.100](../decisions.md#area-10-harness-m3-18-october-2026), with unassessed units taking the agent's disposition (RD5 option B) and, by [10.101](../decisions.md#area-10-harness-m3-18-october-2026), no design round: D1 is dropped and the UI slices build from the design system in Figma and the Storybook components. Drafted 22 October 2026 for the [plan's milestone M5](../plan.md#milestones), "Real batch in the desk": the BFF projects the package, margin pins come from the contract, the desk shows quadrant rationale, suggested reviews and content for each delivery stop, and "Start a review" and the web events are fixed. Revised the same day after an independent review. Nothing here is built. The [decisions record](../decisions.md) wins wherever this text differs from it. The shape follows the [M3 harness proposal](m3-harness.md): starting facts, conflicts that need a ruling, numbered sections with options and a recommendation, slices, decision rows and open points.

**Why now.** [Ruling 10.99](../decisions.md#area-10-harness-m3-18-october-2026) puts every hill-climb behind one step: Neuve is connected end to end first, so the owner can open a real batch in the review desk and annotate it there, where problems are more evident. That step is also the first scope's exit, the full test of [ruling 1.10](../decisions.md#area-1-product-loop-and-roles-16-october-2026): the owner opens a batch and sees human-suggested and human-required units with correctly attributed surrounding context, pre-generated dispositions and digests. The end-to-end check's catalog (kept in the private archive) lists the climbs that wait for it.

**The shortest path.** The owner asked for the connection first, so the slices are ordered to reach it early: the owner's first checkpoint is a real batch in today's design, where they record dispositions and comments (slice S3), and the feedback controls follow with only their own canvas boards (S7). The rationale card, verification, batch menu and the running state of "Start a review" come beside or after, and the full test does not wait for them.

**What this proposal is not.** It does not improve lanes, dispositions, retrieval or review time; those are the catalog's climbs, taken one at a time after M5 (10.99). For M5 the harness's pipeline and its Publish step stay as they are: the desk reads what is already published, including the assembled computation that each reference already names (§2).

**Words.** Product words follow the [vocabulary](../../vocabulary.md): batch overview, review desk, current review batch, review unit, owned range, surrounding context, contextual marker, marker pin, disclosure layers (L0–L3), Before you decide, citation chip, digest (batch and unit), review lane, human-suggested, human-required, disposition (a "review" in UI copy), suggested review, review delivery (Facts, Briefed, Explained, Guided), decision dock, unit rail, lane bar, review comment, Agree, Start a review, review cycle and validation requirement. Internal words, not product terms: _packet_ (the vocabulary's internal word for the prepared package), _manifest_, _read model_ (code that reads Records into one shape), _projection_ (the BFF's mapping from that shape to a screen's data), _sequence_ (the record log's position counter), _finding_ (one claim in the agent's review, as in M3), _local ID_ (an ID an agent cites inside a run, such as `p1.e34`), _assembled computation_ (Assemble's stored output for one batch), and _feedback_ (the owner's word in 10.99 for annotating within the experience). "Feedback" has no vocabulary entry; [open point 1](#11-open-points) asks the owner for one.

## At a glance

Where a real batch travels today, and where it stops. Each gap names the section that closes it.

| Step | Today | Gap | Closed by |
| --- | --- | --- | --- |
| `neuve review <range>` runs the harness; Publish appends the packet to Records | Works (M3); `neuve review show` prints it in the terminal | Delivery content cites local IDs; references fold "why it applies" and "Before you decide" into one summary string. Both are resolvable from the assembled computation each reference already names | §2 |
| A read model reads the packet from Records | Lives in the harness, for the terminal only; the stored content's schemas live in the harness | The BFF would need the harness's internals to read it | §1 |
| The BFF projects it into the overview and desk data | Returns "no batch" for every page | Everything | §3 |
| The owner decides and comments | The dock "decides" locally; comments stay in browser storage | Nothing reaches Records | §3, §6 |
| The owner annotates units, findings, margin references and digests | Done on a separate sheet page (the end-to-end check) | No record, no control in the desk | §7, §8 |
| The page learns that Records changed | Nothing listens | No web events; the live indicator is never provided | §4 |
| "Start a review" asks the harness | Not offered on the live page; a timed delay on the sample page | Nothing is requested, and a request from the BFF would be attributed to an agent | §5 |

## Starting facts

What exists today, checked rather than assumed. Paths are relative to the repository root; line numbers are at the time of writing.

### The web app

| Finding | Evidence |
| --- | --- |
| Every live page load returns the empty shape: "The BFF does not read Records yet" | [`apps/neuve-web/apps/web/src/server/review-loads.ts`](../../apps/neuve-web/apps/web/src/server/review-loads.ts), lines 7–19 |
| The web app has no dependency on `@neuve/records-core`, `@neuve/records-schema`, `@neuve/harness`, `@neuve/review-rules` or `effect` | [`apps/neuve-web/apps/web/package.json`](../../apps/neuve-web/apps/web/package.json), dependencies |
| The live overview passes no "Start a review" handler, and without one the empty state shows no button, only "A review batch appears when a commit is registered for review" | [`routes/index.tsx`](../../apps/neuve-web/apps/web/src/routes/index.tsx), lines 16–18; [`states/empty-states.tsx`](../../apps/neuve-web/packages/ui/src/neuve/states/empty-states.tsx), lines 35–38 |
| The sample page's "Start a review" waits 800 ms and reloads the sample batch: "Nothing is registered" | [`routes/mock/index.tsx`](../../apps/neuve-web/apps/web/src/routes/mock/index.tsx), lines 15–16 and 37–46 |
| The button shows only on an empty overview and knows three states: idle, starting, failed. A review run lasts up to 10 minutes (10.26), so "starting" would spin for minutes with no word of a queued job, a worker waiting for a sign-in, or progress | [`states/start-review.tsx`](../../apps/neuve-web/packages/ui/src/neuve/states/start-review.tsx), lines 23–55 |
| A live indicator (connecting, live, reconnecting) is designed and reads a context that only Storybook's frames provide | [`shared/app-header.tsx`](../../apps/neuve-web/packages/ui/src/neuve/shared/app-header.tsx), lines 23–40 and 59–90; [`story-kit/frames.tsx`](../../apps/neuve-web/packages/ui/src/neuve/story-kit/frames.tsx), line 93 |
| The desk takes optional decision, comment and undo sinks. The live desk route passes none, and with no sink the dock moves to "approved" or "changes requested" without recording anything. With a sink, a refusal shows in the dock's existing error line | [`review-desk/review-desk-screen.tsx`](../../apps/neuve-web/packages/ui/src/neuve/review-desk/review-desk-screen.tsx), lines 135–167; [`routes/review/$unitId.tsx`](../../apps/neuve-web/apps/web/src/routes/review/$unitId.tsx), lines 20–27; [`review-desk/atoms.ts`](../../apps/neuve-web/packages/ui/src/neuve/review-desk/atoms.ts), lines 406–466 |
| Review comments default to a browser-storage repository, so a comment on the live desk would stay in that browser | [`review-comments/repository.ts`](../../apps/neuve-web/packages/ui/src/neuve/review-comments/repository.ts), lines 147–156 |
| The view types call themselves "presentation shapes only — no backend contract yet". They name the agentic lane `agentic-review`; Records names it `agentic`. Verdicts are `approved` and `changes-requested` against Records' `approve` and `request-changes` | [`neuve/types.ts`](../../apps/neuve-web/packages/ui/src/neuve/types.ts), lines 4–21; [`records-schema/src/events.ts`](../../packages/records-schema/src/events.ts), lines 29–52 |
| The types still carry "Assessment unresolved" and "Assessment pending" states, and the overview's call to action turns into "Inspect assessments" when they exist. Ruling 4.4 rules such states out: a unit with gaps goes to human-suggested with no special label | [`neuve/types.ts`](../../apps/neuve-web/packages/ui/src/neuve/types.ts), lines 414–440 and 860–866; [`batch-overview/batch-hero.tsx`](../../apps/neuve-web/packages/ui/src/neuve/batch-overview/batch-hero.tsx), lines 192–200 |
| No screen shows a unit's quadrant or its rationale; "rationale" appears only on the lineage page, for dispositions. Ruling 4.2 says the rationale reaches the UI | Search for `quadrant`, `rationale` and `complexity` across `apps/neuve-web/packages/ui/src` |
| The delivery payload expects Facts as cited segments, Explained as a before-and-after flow of boxes (each box optionally landing on lines) with at most three terms each anchored to a file and lines, and Guided as rows (met, not met, no evidence, outside) with evidence chips, plus a suggested review on human-required units | [`shared/delivery.ts`](../../apps/neuve-web/packages/ui/src/neuve/shared/delivery.ts), lines 150–257 |
| A citation chip can already open the source sheet directly (`presentation: "source-sheet"`) | [`neuve/types.ts`](../../apps/neuve-web/packages/ui/src/neuve/types.ts), lines 368–377 |
| The overview's verification cards are `missing`, `capture`, `browser` (with Playwright fields) and `test`; proof records in Records have the kinds `static-analysis`, `test-run`, `telemetry`, `log`, `screenshot` and `video` | [`neuve/types.ts`](../../apps/neuve-web/packages/ui/src/neuve/types.ts), lines 781–839; [`records-schema/src/proofs.ts`](../../packages/records-schema/src/proofs.ts), line 12 |
| The overview hero already has a "Recorded limitations" disclosure, which can carry a run's disclosed gaps | [`batch-overview/batch-hero.tsx`](../../apps/neuve-web/packages/ui/src/neuve/batch-overview/batch-hero.tsx), lines 162–181 |
| Destinations know one overview with no batch: `{ to: "overview" }`. A range can produce several batches (4.10); no screen lets the reader move between them | [`shared/nav-link.tsx`](../../apps/neuve-web/packages/ui/src/neuve/shared/nav-link.tsx), lines 14–24 |
| The BFF runs under Vite on Bun (`[run] bun = true`, "Needed for bun:sqlite in the BFF's SSR"), started by `bun run dev` on 127.0.0.1:3000 with no other service, because Records is a library (8.3). `bun run dev` gives each child `--no-env-file` and an allowlist of session variables only, so no model credential reaches the BFF | [`apps/neuve-web/bunfig.toml`](../../apps/neuve-web/bunfig.toml); [`scripts/dev.ts`](../../scripts/dev.ts), lines 1–60 and 88–124 |
| The app has no `src/start.ts`, so TanStack Start applies its CSRF middleware (`createCsrfMiddleware`: Origin and `Sec-Fetch-Site` must be same-origin, Referer as a fallback) to server functions by default; adding a `start.ts` drops that default unless it is listed again. Vite's dev server checks the `Host` header against its allowed hosts | `@tanstack/start-client-core` 1.170.32, `dist/esm/createCsrfMiddleware.d.ts`; the reviewer's reading of Start's defaults; [`apps/web/vite.config.ts`](../../apps/neuve-web/apps/web/vite.config.ts) sets no `server` options |
| `records-core` loads under the BFF's Vite dev server and an SSR build on Bun, but a production build leaves `effect` as an import the web app does not declare. `records-core` does not typecheck under the web app's TypeScript configuration: it has no Bun types there, and two files fail its stricter options (`noUnusedLocals` at `computation-admin.ts` line 1, `exactOptionalPropertyTypes` at `transcripts.ts` line 1133) | The independent review's checks, 22 October; [`apps/web/tsconfig.json`](../../apps/neuve-web/apps/web/tsconfig.json) |
| The installed UI dependencies already include `@tanstack/react-query`, `jotai`, `motion` and `zod`. `effect` 4.0.0 is already in the workspace, with the user-approved release-age exception in the web app's `bunfig.toml`. Nothing in this proposal needs a package from the registry that the workspace does not already hold | [`packages/ui/package.json`](../../apps/neuve-web/packages/ui/package.json); [`apps/neuve-web/bunfig.toml`](../../apps/neuve-web/bunfig.toml) |

### Records

| Finding | Evidence |
| --- | --- |
| Records holds everything the desk reads as events: `batch.recorded@1`, `unit.recorded@2` (owned ranges with sides), `context.referenced@2` (anchor, stance, committed or same-batch origin, retrieval, provenance), `assessment.recorded@2` (quadrant, both axes with cited factors and validation requirements, movement, lean, gaps, rationale), `delivery.recorded@1` (batch digest, Facts, Briefed, Explained, Guided; the text is a referenced computation), `comment.recorded@2` (anchor and finding), `disposition.recorded@2` (rests on comments, cites proof), `gap.disclosed@1`, `packet.published@1` and the run's receipt | [`records-schema/src/events.ts`](../../packages/records-schema/src/events.ts), lines 461–850 |
| A context reference's `summary` is the only text it carries, at most 2,000 characters | Same file, lines 503–548 |
| `records-schema` already exports a `PacketView`: the projection row of one published packet | [`records-schema/src/projections.ts`](../../packages/records-schema/src/projections.ts), line 183 |
| The append transaction refuses an approval on a human-required unit unless the actor is a registered human, and lets only a disposition's author replace or retract it | [`records-core/src/rules.ts`](../../packages/records-core/src/rules.ts), lines 18–100 |
| `Dispositions.judge` reads closure against the current lane (4.13), marks each disposition recorded before the current assessment (`beforeAssessment`), and says a unit with no assessment "needs an assessment" and cannot close; it does not say which verdict stands when a person and the agent disagree on human-suggested work | [`records-core/src/dispositions.ts`](../../packages/records-core/src/dispositions.ts), lines 50–184 |
| A human actor is the fingerprint of the git email (`humanFingerprint`) registered with `actor.registered@1`, harness `git`. Identity is for attribution, not access (0009) | [`records-core/src/identity.ts`](../../packages/records-core/src/identity.ts), lines 32–37; [record 0009](../../architecture/decisions/0009-identity-without-auth.md) |
| The record log exports `append`, `history`, `get`, the vent-key helpers and their types; nothing reads the log's sequence for a watcher, though 8.3 says the web app learns about changes by watching it | [`records-core/src/log.ts`](../../packages/records-core/src/log.ts), lines 24–333 |
| No code anywhere appends a human's disposition or comment: the only producers of `disposition.recorded` and `comment.recorded` are the harness's Publish and tests | Search for those kinds across `apps` and `packages` |
| The worker starter runs `neuve` from the PATH unless given a command, which would start the installed copy rather than this checkout | [`records-core/src/starter.ts`](../../packages/records-core/src/starter.ts), lines 46–90 |
| This repository's own Records store holds agent activity, commits and three proof records, but no review packet: the end-to-end check ran in scratch clones, each with its own store | `.git/neuve/records.sqlite`, counted by event kind on 22 October; [full-test proposal](full-test.md), line 54 |
| The check's packets survive as exports of the read model, one per run, under the check's results | For example `validation/benchmarks/m4/results/full-test/runs/neuve_0c874b72_1..0c874b72/A.json.gz` (kept in the private archive) |

### The harness

| Finding | Evidence |
| --- | --- |
| `@neuve/harness` has one export, its index, which re-exports the ACP client, the MCP client and server, the stack store and the chunker; its dependencies include the ACP SDKs, the MCP client, `oxc-parser` and four `sigstore` packages. The request's configuration imports the model route, which imports `@effect/ai-anthropic` | [`harness/package.json`](../../packages/harness/package.json), lines 6–24; [`harness/src/index.ts`](../../packages/harness/src/index.ts), lines 18–35; [`harness/src/config.ts`](../../packages/harness/src/config.ts), line 16; [`harness/src/route.ts`](../../packages/harness/src/route.ts), line 1 |
| The packet read model (the standing packet of a cycle, its manifest, its events, the delivery content they reference, the run's gaps and each unit's closure) lives in the harness, beside the terminal printer. The manifest's shape is typed only there, as an interface | [`harness/src/packet-view.ts`](../../packages/harness/src/packet-view.ts), lines 29–266 |
| The stored shapes of the assembled batch and its delivery content are zod schemas in the harness | [`harness/src/assemble.ts`](../../packages/harness/src/assemble.ts), lines 1931–2023; [`harness/src/dispose.ts`](../../packages/harness/src/dispose.ts), lines 52–75 |
| Delivery content cites local IDs: hunks (`h47dffd002f5681b`), ledger entries (`p1.e34`), proof records and units. Briefed links them as `[phrase](id)`. What each ID points to is kept in the assembled computation, not in the content | [`harness/src/assemble.ts`](../../packages/harness/src/assemble.ts), lines 1046–1146 and 1274–1296; an exported unit in `A.json.gz` above |
| Every `context.referenced@2` names the assembled computation of its batch as its content; Publish's disclosure for an unpublished reference says "it stays in the assembled batch's computation" | [`harness/src/publish.ts`](../../packages/harness/src/publish.ts), lines 683–696 |
| Publish turns local IDs into Records citations for assessments and findings, but stores Facts, Briefed and Explained with the local IDs unchanged | [`harness/src/publish.ts`](../../packages/harness/src/publish.ts), lines 563–608 and 820–866 |
| Explained is prose (`before`, `after`), with terms that carry no file or lines. The same submission per unit also carries the axes, factors, validation requirements, movement, lean and gaps that decide the lane | [`harness/src/assemble.ts`](../../packages/harness/src/assemble.ts), lines 1186–1296 |
| A reference is published with its first anchor only, its grade (necessary or useful), "why it applies" and "Before you decide" folded into one summary string, and no title. References from scope have no git provenance and are not published; Publish discloses each as `reference-not-published` | [`harness/src/publish.ts`](../../packages/harness/src/publish.ts), lines 1423–1500 and 676–688 |
| A unit the run did not assess is set to human-suggested inside the harness, gets no assessment event, only a `not-assessed` gap, and its agent review still becomes a disposition through `applyLane`, so an agent approval is recorded on a unit Records holds no assessment for | [`harness/src/assemble.ts`](../../packages/harness/src/assemble.ts), lines 2297–2310; [`harness/src/publish.ts`](../../packages/harness/src/publish.ts), lines 703–718 and 1069–1085; [`harness/src/dispose.ts`](../../packages/harness/src/dispose.ts), lines 791–805 |
| Stage completions reach Records during the run, not only at Publish, so a watcher sees progress | [`harness/src/pipeline.ts`](../../packages/harness/src/pipeline.ts), line 352 |
| A review request always resolves who asks itself: the calling agent session first, then git's user email. Called from a BFF started in an agent's shell, it would attribute the request to that agent | [`harness/src/request.ts`](../../packages/harness/src/request.ts), lines 63–97 and 139 |
| `neuve review` follows a run by polling the job and the run log, says when the worker lacks the route's sign-in (10.17), and starts a worker from the shell that has it | [`apps/neuve-cli/src/review-cli.ts`](../../apps/neuve-cli/src/review-cli.ts), lines 200–270 |
| The shared review rules (owned ranges, submitted hunks, comment anchors, lineage) are imported by the harness and not yet by the web app | [`packages/review-rules/src/index.ts`](../../packages/review-rules/src/index.ts); [`harness/package.json`](../../packages/harness/package.json), line 17 |

### What the owner annotated on the end-to-end check's sheet

The sheet answers (kept in the private archive) hold 49 answered items of 93. They are what the desk must let the owner record, so later climbs can compare like with like.

| Item | What the owner gave | Count answered |
| --- | --- | --- |
| A unit | Complexity (low or high), ease of validation (easy or hard), lane, verdict (approve or request changes) and a note, first before the harness's call was revealed and then final | 26 (20 from the most escalated group of phase C, 6 from phase A); one has a first answer only |
| A finding (one agent comment) | Valid, invalid or unsure | 37 findings across those units: 17 valid, 5 invalid, 15 unsure |
| A margin card (one context reference) | Necessary, useful or irrelevant, with notes that sometimes place it between two grades (10.98 reads that as an in-between signal), first and a few final corrections | 20 |
| A digest (batch and unit) | Accurate, complete, misleading claim, neutral before the verdict, and a note; the owner marked these as notes, not judgements, because a digest could not be judged without wider context | 2 |
| A later fix | One answer; the owner asked for three reviewers instead (catalog, "Now, during the desk work") | 1 |

The owner's notes on the sheet ask for things only the desk can give: wider context around a digest, better formatting of context notes, a rubric for them, and FYIs raised into the briefing (10.98).

### What the decisions say about owner feedback

- 10.99 asks that the owner "can annotate and give feedback within the experience".
- 9.51 makes the adjudication method an eval that "runs again on a live dataset collected from real review sessions", from "session data in Records once the review desk records human judgments of context". Its method is decide-then-reveal with neutral context and first and final grades (9.38).
- 9.38 says the desk needs neutral, highlighted context and protection from anchoring.
- The vocabulary covers dispositions, review comments, Agree, drafts (not recorded) and Mark viewed (not part of review history). It has no term for a reader's judgement of a finding, a margin reference, a digest or a unit's lane. No decision says whether such feedback is a product feature for every reviewer or the owner's instrument for the climbs, whether it changes a unit's lane, or whether it becomes context for the next cycle. These are [open points](#11-open-points), not something this proposal settles.

## Conflicts that need a ruling

| # | Conflict | Proposed reading | Section |
| --- | --- | --- | --- |
| C1 | Three rules meet on a unit the run never assessed. 4.4 and 10.42 send it to human-suggested. Records' `judge` says it "needs an assessment" and can never close. And 4.13 says an agent approval given "before any assessment" no longer closes a unit and reaches the human as context, while the harness records the agent's approval on such a unit through `applyLane`, so reading it as human-suggested would let that approval close it. The vocabulary's "Human-suggested" entry says the opposite of 4.13 here: "Without human input, the existing agent disposition applies" | Records reads a published unit with no assessment as human-suggested, and applies 4.13: the agent's disposition on it is context, not closure, so the unit waits for a person. That departs from the vocabulary's Human-suggested entry, and it means every unassessed unit (all of a timed-out run's unfinished units) needs a person. RD5 puts the alternatives to the owner | §1.4 |
| C2 | 1.7 keeps business logic out of the BFF, yet showing a batch needs rules: which packet stands, whether a unit is closed, which verdict stands when a person overrides the agent, what a local ID points to | Every such rule lives in records-core, which the CLI and the BFF both read; the BFF only maps shapes (RD1, RD5, RD6) | §1, §3 |
| C3 | 9.38 asks the desk to protect the reader from anchoring, and 9.51's live dataset assumes its decide-then-reveal method; the desk as designed shows lanes in the rail, the agent's review on human-suggested work and the suggested review at Guided before the reader decides | The desk keeps its design; feedback records what the reader could see when answering, the export marks desk answers as not decide-then-reveal, and blind calibration stays on sheets (FB3, FB4) | §7 |
| C4 | The vocabulary says a reader's review-delivery stop for one unit "is not recorded"; recording what the reader saw with each piece of feedback would record it | Feedback records whether the harness's call was visible, never the stop (FB4) | §7 |
| C5 | 4.12 makes range selection part of the review request; the empty overview has no range control | M5's button asks for the current branch against its base, shown before it starts; the full test itself is requested with `neuve review <range>`; a range picker is an open point (ST2) | §5, §9 |
| C6 | The vocabulary's "Start a review" asks the harness to begin a review; the overview hero's "Start review" opens the desk at the first unit | Raised as an open point; this proposal does not rename either | §5 |
| C7 | 10.99 holds every climb until the desk is connected, and lanes are the first climb. The Assemble submission that writes Explained also writes the axes, movement, lean and gaps that decide the lane, so changing Explained's shape there changes the lane call and its cache key; carrying references whole would change Publish | M5 leaves Assemble and Publish unchanged: references and citations are read through the assembled computation (§2.1), and Explained's prose is shown as written (PB3, option B). Changing what the harness publishes waits until after the climbs that measure it | §2 |

## 1. The packet read model and the rules it needs

### 1.1 Where the read model lives, and what the BFF may import

**Facts.** The read model is in [`harness/src/packet-view.ts`](../../packages/harness/src/packet-view.ts) and reads only Records, but it knows the manifest's shape, which the harness alone types, and the stored content's schemas are in the harness too. Record [0001](../../architecture/decisions/0001-layers-and-responsibilities.md) says Records stores and coordinates and the BFF projects Records state; record [0011](../../architecture/decisions/0011-zod-schemas.md) makes zod the one schema for stored and wire types, defined once.

**Options.**

| Option | What it means | Against it |
| --- | --- | --- |
| A | The BFF imports the read model from `@neuve/harness` | The web app links the harness's ACP, MCP, model provider, parser and sigstore code to read Records; the manifest stays an untyped harness interface |
| B | The manifest's shape and the stored shapes of the assembled batch and its delivery content move to `records-schema` as zod; the read model moves to `records-core` as a module with a name distinct from the existing `PacketView` projection row (for example `PublishedPackets`, returning a `StandingPacket`); the harness imports the schemas from there, and its terminal printer reads the model from there | One move of the read model (about 270 lines) and of the stored schemas; `neuve review show` must print the same |
| C | A new shared read package | Another place for review rules beside `review-rules`, with no gain over B |

**Recommendation: B.** A published packet and its referenced content are stored state, so their schemas and reader belong with Records, and `neuve review show` and the desk then read one thing.

**What else the BFF imports from the harness.** Two things the BFF needs are harness code: the review request (§5) and git object reads for the diff (§3.3). The harness gains narrow subpath exports for exactly those (`@neuve/harness/request` and `@neuve/harness/git-objects`), and the BFF imports nothing else from it. The request's configuration imports the model route today, which imports `@effect/ai-anthropic`; the slice that adds the subpath moves the route's configuration types apart from its provider code if needed, so the subpath pulls in no ACP, MCP, model provider, parser or sigstore code. The subpaths' own import graphs are S2's check, and the web app's production build is S3's.

### 1.2 Watching for changes

**Facts.** 8.3 says the web app learns about changes by watching a sequence number; no read of it exists. The log's highest sequence is one indexed read.

**Recommendation.** `records-core` gains one read, the log's current sequence. §4 uses it.

### 1.3 Human commands

**Facts.** Nothing appends a person's disposition or comment. The rules that guard them already run in the append transaction (rules.ts).

**Recommendation.** `records-core` gains a small command module for a person's review work: record a disposition (approve or request changes, with the comments a request rests on, as 10.69 requires of the agent), retract or replace it (author only, as today), and record a comment anchored to owned lines. Each command takes the human actor as an input, registers it once, and appends in one transaction. The BFF calls it; nothing else in the BFF decides anything.

### 1.4 Rules the screens need from Records

| # | Rule | Options | Recommendation |
| --- | --- | --- | --- |
| RD5 | A published unit with no assessment (C1) | A: human-suggested on read, and 4.13 applied: the agent's disposition on it was given before any assessment, so it reaches the person as context and the unit stays open until a person decides. B: human-suggested on read, and the agent's disposition closes it, as Publish intends today through `applyLane`; this reads 4.4 and 10.42 over 4.13. C: Publish stops recording a disposition on an unassessed unit (a Publish change, after the climbs) | **A, for the owner to confirm.** It is the only reading that keeps 4.4, 10.42 and 4.13 together without changing the harness: the unit shows as human-suggested with its limitation, and the agent's approval is shown, not counted. It departs from the vocabulary's Human-suggested entry ("Without human input, the existing agent disposition applies") and means every unassessed unit, including all of a timed-out run's unfinished units, needs the owner, which the lanes climb may revisit |
| RD6 | Which verdict stands on human-suggested work when a person and the agent differ | A: `judge` returns the standing verdict: a person's current disposition overrides the agent's, as the vocabulary's decision dock and Agree say. B: the BFF decides | **A** |

## 2. Reading what the harness already published

### 2.1 References and citations (PB1, PB2)

**Facts.** Facts, Briefed and Explained cite local IDs. A reference's reason, grade and "Before you decide" are folded into one summary, with one anchor. Every reference event names its batch's assembled computation, which holds each reference whole (`why`, `beforeYouDecide`, `grade`, every anchor, the ledger entries it came from) and the index from every local ID to what it points to.

**Options.**

| Option | What it means | For and against |
| --- | --- | --- |
| A | Publish resolves the content's local IDs into Records citations and writes a new reference version carrying the fields whole | Self-standing content; but it changes Publish before the climbs (C7) and old packets stay unresolved |
| B | Every reader resolves through the harness | Couples the BFF to the harness (§1.1) |
| C | The read model resolves through the assembled computation the reference events already name, using its schema from `records-schema` (§1.1): a ledger entry becomes the reference it was projected into, a hunk its path, side and lines, a unit or proof its event; an ID that resolves to nothing published stays plain text and is counted | Publish untouched; Records references the computation and never copies it, as 5.3 intends; works for every packet already in a store, since outputs the pipeline reuses are kept permanently (8.10) |

**Recommendation: C for M5.** The count of citations that resolve to nothing measures, for free, the published-context loss that climb 3 will diagnose. Option A stays available as a contract cleanup once the climbs have measured what they need.

### 2.2 Explained (PB3)

**Facts.** The desk's Explained is a before-and-after flow of short boxes, each able to land on lines, plus up to three terms anchored to owned lines ([round 4](../../design/neuve-web/changes/round-4.md)); the harness writes two prose paragraphs and unanchored terms, in the same submission that decides the lane.

**Options.** A: Assemble writes the flow and anchored terms (changes the lane-deciding submission and its cache key, so it is not climb-neutral, C7). B: the desk's Explained layer shows the prose before and after and the terms as written, a focused design change on the canvas. C: the Explained stop is not offered on real units until a climb.

**Recommendation: B**, with C in the meantime: until UI7 lands (S6), real units do not offer the Explained stop. The plan's M5 asks for content at each delivery stop and the content exists; the harness stays untouched before the lanes climb. A can follow as its own climb if the owner wants the flow.

### 2.3 Proof in briefings (PB4)

**Recommendation.** A cited proof record becomes a citation chip that opens the source sheet with the proof's kind, revision, claim and artefact, using the chip's existing source-sheet presentation. No new UI and no harness change.

## 3. The BFF read path

### 3.1 Which Records the BFF reads (RD2)

**Facts.** Records lives in each repository's `.git/neuve/` (8.6). `bun run dev` starts the BFF from this repository.

**Recommendation.** The BFF reads the repository it was started in, with an environment variable to point it at another; the user-level list of repositories (8.6) can drive a picker later. The full test reads this repository's own store (dogfooding, 7.6).

### 3.2 What a page opens (RD3)

**Options.** A: `/` opens the newest cycle's standing packet at its first batch, each batch gets its own address, and the desk keeps `/review/<unit>` (unit IDs are unique). B: `/` lists cycles and batches (a new screen). C: `/` takes a range in its address.

**Recommendation: A**, with a menu between a range's batches later (UI3, §8); until then other batches open by address. The standing-packet rule comes from the read model, never from the projection tables, which keep rows of superseded packets ([plan follow-ups](../plan.md#follow-ups), M3 H8 reviews).

### 3.3 Server functions and the projection (RD4)

**Recommendation.**

- Page loads become TanStack Start server functions that run only on the server, read Records through `records-core` and return the same `BatchOverviewLoad` and `ReviewDeskLoad` shapes, so the screens do not change.
- The projection maps names and shapes only: lane and verdict names; Facts and Briefed into briefing segments (phrases land on lines, files or markers; proofs open the sheet); no Explained content until UI7 lands (the Explained stop is not offered on real units, rather than prose pushed into today's flow boxes); Guided rows into criteria with evidence chips; the suggested review; the agent's review, comments and disposition into the unit's attribution and comment records with agent authors; references into markers, anchors, shared-unit dots and source sheets; gaps into the hero's limitations; validation requirements and proof records into today's verification cards as far as they fit. Every item keeps the Records event ID it came from, so later slices can attach to it without changing the projection.
- The diff's contents come from git objects at the range's base and head, tracked work only (10.34), through the harness's git-objects subpath (§1.1). Owned ranges and sibling-owned lines come from `unit.recorded@2` through the shared review rules (10.21), so the desk and the harness agree on what a unit owns.
- The dock, comment and undo sinks call the human commands of §1.3. A person's request for changes records its comment first and rests on it.
- The web app gains what it needs to link Records: `effect` (already in the workspace) and the workspace packages as declared dependencies, so the production build has no undeclared import, and Bun types for its server files. The two `records-core` files that fail the web app's stricter options are fixed in `records-core` (S1), not by loosening the web app's configuration.

### 3.4 Who the BFF writes as (ID1)

**Facts.** The review request and any caller resolution look for the calling agent session first. `bun run dev` is often started from an agent's shell.

**Recommendation.** Every BFF command, the review request included (§5), acts as the person git names in the repository (user email and name, 10.5), registered once as a human actor; caller resolution is never used in the BFF. With no email set, the command is refused and the refusal shows where the screen already shows errors (the dock's error line, the button's failed state), so no new UI is needed.

### 3.5 Writes only from the desk's own page (ID2)

**Facts.** The BFF listens on 127.0.0.1 with no authentication, by design (6.6). TanStack Start's CSRF middleware applies by default only while no `src/start.ts` exists; Vite's dev server checks the `Host` header.

**Recommendation.** The app declares Start's CSRF middleware explicitly in a `src/start.ts` (same-origin `Sec-Fetch-Site` and `Origin`), so adding the file for any other reason can never drop it, and limits Vite's allowed hosts to the loopback names it serves. One test posts to a command cross-site and sees it refused; that is the test this slice needs, because it is a security boundary (7.3). The event stream (§4) is a server route the middleware does not cover; it only reads, and it is limited to the same allowed hosts.

### 3.6 Any local process can act as the owner (ID3)

Any process on the machine can call the BFF, or link `records-core` directly as the CLI does, and record an approval as the person git names. This is accepted under 6.6 and [record 0009](../../architecture/decisions/0009-identity-without-auth.md): identity is attribution, not access control. It is stated here because the BFF's commands are the first path that records a human's disposition, including on human-required work.

### 3.7 Storybook from a real packet

**Recommendation.** One captured real packet (an export the end-to-end check already kept, or the full test's own) is run through the projection once and saved as a fixture in `packages/ui/src/fixtures`, so Storybook shows a real batch beside the designed one. The fixture is regenerated by a named command when the projection changes, never edited by hand.

## 4. Web events (LV)

**Facts.** No web event exists; the live indicator is never provided. Stage completions and packets land in Records during and after a run.

**Options.**

| Option | How | Against it |
| --- | --- | --- |
| A | The page asks a server function for the sequence every few seconds | Each tab polls; delay up to the interval; the live indicator has nothing to say about a lost connection |
| B | One server-sent event stream per tab: the BFF reads the sequence (one cheap read every second, shared by every open stream) and sends the new value; the page invalidates its loaders, debounced | One server route; reconnection comes with the browser's `EventSource` |
| C | A WebSocket | Two-way, which nothing needs: commands go through server functions |

**Recommendation: B.** It is one-way, matches the designed connecting, live and reconnecting indicator, reconnects on its own, and a hosted Neuve can serve the same stream from a Durable Object (10.92). A page reloads its data only when the sequence moved, and nothing the reader is holding (an open composer, an open card) is reset by a reload, because that state lives in jotai atoms, not in the loader data.

## 5. "Start a review" (ST)

**Facts.** Ruling 1.1 calls the button and the web events broken; they are not wired at all. A request writes `review.requested@1` and enqueues a `review.run` job; a worker started without the route's sign-in leaves the job waiting and says why (10.17). The request resolves its own requester. The worker starter defaults to the installed `neuve`, and `bun run dev` gives the BFF no model credential.

| # | Decision | Options | Recommendation |
| --- | --- | --- | --- |
| ST1 | How the BFF relays the request | A: call the harness's request function through its narrow subpath (§1.1). B: run `neuve review --detach` as a child process. C: append the request event itself | **A**, with one change to the request function: it takes the requester as an input. The CLI keeps resolving the caller (agent session, then git's email) and passes it; the BFF passes the git human (ID1). Run key, configuration and cycle rules stay in one place, and no model work runs in the BFF |
| ST2 | Which range | A: the current branch's head against its base branch's merge base, shown before it starts; on a branch with nothing ahead of its base the request is refused with the CLI's reason, in the button's existing failed state. B: a range picker (4.12) | **A for M5**; the picker is an open point (C5). The full test does not depend on the button (§9, S8) |
| ST3 | What the reader sees while it runs | The button's three states cannot carry a run of minutes. A new running state: queued, waiting for a worker that has the sign-in (the CLI's own words), working through the stages as they complete, then the batch arriving through the web events; a timed-out run arrives with its limitations | **A new state, designed on the canvas first** (UI5, §8) |
| ST4 | Which worker picks the job up | A: the realistic flow: the owner starts the worker from a shell that holds the route's sign-in (`neuve worker start`, or the CLI from source in this checkout); the BFF only wakes a running worker and, when the job waits, shows why. B: the BFF spawns the worker itself with the CLI from source as the starter's command; that worker has the BFF's environment, which holds no model credential, so for the OpenAI route it can still read the user-level sign-in (10.85) but for the Anthropic route the job waits | **A, unless the owner rules otherwise.** When the BFF does spawn one (B), the command is always the CLI from this checkout, never the installed copy |
| ST5 | "Start a review" when a batch exists | The vocabulary scopes it to the current batch; a new commit is announced by the new-commit notice | **Out of M5**: M5 fixes the empty state's button; a new head gets its review from the CLI or the inner loop (1.1) |

## 6. The owner's dispositions and comments

Covered by §1.3 and §3.3: the dock records a person's approval, Agree, request for changes, suggested review sent as their own (the vocabulary's Suggested review), and undo as a retraction; comments are `comment.recorded@2` on owned lines. This is the owner's first checkpoint (S3), in today's design. Comment threads with agents, and resolving a comment, have no Records event yet and stay out of M5 (open point 7): the inner loop is not a product flow yet (1.2).

## 7. The owner's feedback (FB)

What the owner needs in order to annotate in the experience, recorded in Records as the owner's events under the identity rules of [record 0009](../../architecture/decisions/0009-identity-without-auth.md) and Area 8: the human actor from git's email, append-only, corrections as new events that supersede, never edits.

| # | Decision | Options | Recommendation |
| --- | --- | --- | --- |
| FB1 | How feedback is recorded | A: one new event kind whose target is a unit, a finding (an agent's comment), a context reference, or a digest or delivery stop, named by event ID. B: one kind per target. C: comments with tags | **A.** One shape, one projection, one export; targets are Records events, so feedback attaches to exactly what the owner saw |
| FB2 | The values | The sheet's scales, unchanged: on a unit, complexity, ease of validation, lane and verdict; on a finding, valid, invalid or unsure; on a reference, necessary, useful, irrelevant or misleading, with an optional "between" second grade (10.98); on a digest, accurate, complete, misleading claim and neutral before the verdict; a note on any of them | **The sheet's scales**, so the climbs compare desk answers with the end-to-end check's answers (catalog's baseline). "Misleading" is added because the margin is where it shows (9.9) |
| FB3 | What feedback changes, and what it is | It is never a disposition, never changes a lane or a unit's closure, never ends a cycle (4.11), is durable (not a raw capture, 8.10), and is read back by the climbs. Answers given in the desk are not decide-then-reveal, so they do not match 9.51's method: they are a dataset of their own, labelled as desk answers, beside the sheets' blind answers | **As stated.** Whether a person's lane judgement should re-assess the unit (4.13) and whether feedback becomes next-cycle context like comments are open points |
| FB4 | Decide-then-reveal in the desk (C3, C4) | A: none; each answer records whether the harness's call on that item was visible when the owner answered (on a unit, the lane always is, in the rail). B: a judging mode that hides lanes, the agent's review and the reference's grade until the owner answers (new UI). C: blind for the feedback control only | **A for M5.** The owner asked for feedback within the experience as it is; first and final answers are kept (a final answer supersedes the first, as on the sheet), and blind calibration stays on sheets. B is a later call if the answers show anchoring |
| FB5 | Reading it back | A CLI read for agents (1.9) that exports feedback in the sheet answers' shape, marked as desk answers | **Yes**, so each climb's measure reads desk answers the way it read the sheet |

## 8. UI: what is new and what is a focused correction

New UI goes to the Claude design canvas, kept privately first, then Pen, code and the design export, with parity across the five surfaces (Pen, Storybook, app, live canvas, export) as the [design workflow](../../design/neuve-web/README.md#workflow) requires. Each item gives structurally different options for the canvas round, not one idea in variants. The round is approved in two parts, so the feedback controls are not held up by the rest: part one is UI6; part two is UI1–UI5 and UI7.

| # | Item | New or correction | Options for the canvas | Lean |
| --- | --- | --- | --- | --- |
| UI1 | **Quadrant rationale** (4.2, 10.55–10.57): both axes with their levels and cited factors, validation requirements with coverage, movement signals with direction, the lean, gaps, and the rationale | New | A: a card opened from the lane label in the desk's unit header, built like the context card (layers, Escape and press-outside dismissal). B: a section at the top of the desk's briefing column. C: a row per unit in the overview's judgment table that expands | A, because it reuses a layer the reader already knows and keeps the rationale out of the code until asked |
| UI2 | **Verification on Records' proof kinds**, coverage solid, shallow or missing per requirement, stale proof disclosed (11.10) | Correction of the verification grid | A: one card per validation requirement with its proofs. B: one card per proof record with the requirements it serves | A, since a requirement is what the reader judges (10.58) |
| UI3 | **Moving between a range's batches** (4.10) | New | A: the batch title in the header becomes a menu of the cycle's batches. B: a strip above the overview hero. C: the unit rail groups by batch | A, the smallest change that keeps one batch per screen |
| UI4 | **Remove the unresolved and pending assessment states** (4.4) | Correction | Delete the states and the "Inspect assessments" call to action; a not-assessed unit shows as human-suggested with its limitation | No canvas choice; sweep the boards that show them |
| UI5 | **Start a review while it runs** (ST3) | New | A: the empty overview shows the run's progress in place of the button. B: the button keeps its place and a status line under it updates | To be judged on the canvas |
| UI6 | **Feedback controls** (FB2) | New | A: each control lives where its item is: a grade row on the context card (L2), valid/invalid/unsure on a finding's card, a rubric under each digest, and the owner's call on the unit next to the lane label. B: one feedback drawer per unit listing every item. C: a "feedback" composer kind beside comment and request changes | A, where problems are most evident (10.99); B risks a second sheet inside the desk |
| UI7 | **Explained as prose** (PB3, option B) | Correction of the Explained layer | A: the flow card holds the before and after paragraphs in its two rows, terms below without landing. B: the briefing column shows them under a "Before" and "After" pair | To be judged on the canvas |

Every UI slice follows the web rules the owner set: jotai holds all state and `useState` is never used; motion comes from `motion/react` with the neuve-motion tokens and respects reduced motion; Storybook validates the UI, with fixtures in `packages/ui/src/fixtures`; Bun only, and no new registry dependency against the release-age policy; no gradients and no edge rails; and no captions that describe how content was made. The feedback controls follow standard form practice from the modern-web-guidance forms guide: real `<form>`, `<fieldset>` and `<legend>` for each scale, visible labels, the note as a `<textarea>` with a label, errors announced through a live region, the submit disabled only after a valid submit to prevent doubles, and the desk's existing ⌘↵ shortcut checking `isComposing` so IME input is never sent early.

## 9. Slices

Each slice runs with one implementer and one independent reviewer, in this shared checkout with disjoint file ownership (7.1, 7.7), and ends in something the owner can open and judge. Evidence converges (7.2, 11.1): backend slices show logs, telemetry and Records state through Neuve's own commands (`neuve review show`, `neuve records`, `neuve jobs`); browser slices add Chrome DevTools MCP screenshots, video, console and network logs. Verify scripts are not evidence. Tests are written only where a slice states why. `bun run check` runs before every review and is never the judgement.

| # | Slice | Kind | Built | The owner opens and judges | Depends on |
| --- | --- | --- | --- | --- | --- |
| D1 | **Design round**, in two parts | Canvas first | Part one: UI6's feedback boards. Part two: UI1–UI5 and UI7, with the boards that show UI4's states swept. Nothing in Pen or code changes for an item until its part is approved | The canvas boards, with the options of §8 side by side | — |
| S1 | **Records read model, stored schemas and human commands** | Plumbing | The manifest's and the stored content's zod schemas in `records-schema`, imported by the harness's Assemble, Dispose and terminal printer; the read model in `records-core` under a distinct name, resolving local IDs through the assembled computation (§2.1) and counting what stays unresolved; the sequence read; the human command module; RD5 and RD6 in `Dispositions.judge`; the two `records-core` fixes the web app's typecheck needs; every caller of the moved read model updated (`neuve review show` in `review-cli.ts`, `proof-cli.ts`, the harness's index and its dispose-publish test). Moving the schemas changes imports only: the agents' submission schemas (the JSON schema each tool sends) and every computation key stay byte-identical. Decoding stays tolerant of older stored outputs: the read model is tried on an older store (one of this repository's pre-migration stores or an end-to-end check clone, if one remains) and anything it cannot decode is disclosed, never thrown. Tests: the human-required approval refusal through the new commands, because it guards who decides; RD5's reading on a unit with no assessment and an agent approval, because it decides closure; the submission schemas and computation keys unchanged before and after the move, because a change would silently invalidate every cached run | `neuve review show` printing the same packet before and after the move, plus each unit's resolved citations and the unresolved count, on a review of a small range in this repository, and its output on an older store; `neuve records rebuild --verify`. The human commands are judged where first used, in S3 | S2 for `review-cli.ts` only: S1 starts beside S2 and edits `review-cli.ts` once S2 is committed |
| S2 | **Harness seams for the web app** | Plumbing | The review request takes its requester as an input, with the CLI resolving the caller and passing it; the `request` and `git-objects` subpath exports, with the route's configuration split from its provider code if the subpath needs it | `neuve review --detach` from an agent's shell still attributed to that agent session, and a request made through the subpath with a given human attributed to that human, both shown by `neuve records`; the subpaths' own import graphs (the modules a Bun build of each subpath entry bundles), with no ACP, MCP, model provider, parser or sigstore code | — (first; its `review-cli.ts` change is committed before S1 edits that file) |
| S3 | **A real batch in the desk: the owner's first checkpoint** | Plumbing; no visual change | Server functions over `records-core`; the projection with every item's event ID; git reads for the diff; batch addresses (RD3); the dock, comment and undo sinks (§1.3, ID1); the explicit CSRF middleware and host allowlist with the cross-site test (ID2); `effect`, the workspace packages and Bun types in the web app; the real-packet fixture and its Storybook stories | A real batch, requested with `neuve review <range>` on this repository, open in the overview and desk, by screenshots and a video; the owner records dispositions and comments on it, and `neuve review show` shows them as the owner's; the Storybook story of the real batch; the modules the web app's production build includes, with no ACP, MCP, model provider, parser or sigstore code. Pen, canvas and export: not applicable | S1, S2 |
| S5 | **Feedback records** | Plumbing | FB1–FB3 and FB5: the event, its projection and migration, the command, the CLI export in the sheet answers' shape. Tests: decoding, and that feedback can never append as a disposition, because that would let feedback close a unit | Judged where first used, in S7 | S1 (beside S3) |
| S7 | **Feedback in the desk** | UI, after D1 part one | UI6 in `packages/ui` (feedback components in their own files, mounted in the desk components before S6 edits them, and feedback state added to `types.ts` after S3), the BFF's feedback command and read in their own server file and the desk route, Storybook stories on the real fixture; Pen, canvas and export to parity | The owner grading margin cards, judging findings, rating digests and giving their call on units of the real batch, then the export read back with `neuve records` | S3, S5, D1 part one |
| S4 | **Web events and Start a review** | Plumbing, plus UI5 | The event route, `__root.tsx`'s live status, the start handler in its own server file, the running state in `states/`; ST1–ST4; Pen, canvas and export to parity | A video: Start a review on a branch with work ahead of its base and an empty store, the job queued, the sign-in wait when the worker lacks it, stages ticking in, the batch arriving without a reload; a disposition appended from the CLI showing up in an open desk; the indicator reconnecting after the BFF restarts | S3, D1 part two |
| S6 | **Rationale, verification, batches and Explained** | UI, after D1 part two | UI1–UI4 and UI7 in the overview and desk components; the projection files' new fields; Storybook stories on the real fixture; Pen, canvas and export to parity | The real batch's units showing their quadrant rationale, verification by requirement, Explained as written, a multi-batch range moving between batches, and no pending states, in the app and in Storybook | S3, S7 (it edits the same desk components after S7), D1 part two |
| S8 | **The full test** (1.10) | The owner's session | No build. The coordinator requests the review with `neuve review <range>` on the range the owner names (open point 4) and the owner opens it in the desk, reviews and annotates; the export goes to the catalog for the first climb. The later fixes by three reviewers run during this desk work, as the catalog says. The full test passes without the quadrant rationale on screen (S6): 1.10 names units, context, dispositions and digests, and the owner asked for the shortest path, while the plan's M5 lists the rationale; whether the full test waits for S6 is the owner's choice (open point 11) | The full test itself | S3, S7 |

**Shared files.** Lanes run side by side only on disjoint files. These pass from slice to slice in order:

| File | Owners, in order |
| --- | --- |
| `packages/records-schema/src/events.ts`; `packages/records-core/src/projectors.ts` and `schema.ts` (migrations) | S5 only |
| The new stored-content and manifest schemas in `records-schema` | S1 only |
| `packages/records-core/src/dispositions.ts`, `log.ts`, `computation-admin.ts`, `transcripts.ts`, the new read model | S1 only |
| The new human command module in `records-core` | S1, then S5 (which adds the feedback command) |
| `packages/harness/src/packet-view.ts`, `assemble.ts`, `dispose.ts` (schema imports only), `index.ts`, `tests/dispose-publish.test.ts`; `apps/neuve-cli/src/proof-cli.ts` | S1 only |
| `apps/neuve-cli/src/review-cli.ts` | S2 (passing the requester), then S1 (the moved read model and `neuve review show`) |
| `packages/harness/src/request.ts`, `config.ts`, `route.ts`, `package.json` | S2 only |
| `apps/neuve-web/apps/web/package.json`, `tsconfig.json`, `vite.config.ts`, `src/start.ts` | S3 only |
| The projection files under `apps/neuve-web/apps/web/src/server/` | S3, then S6 |
| `apps/neuve-web/apps/web/src/routes/index.tsx` | S3, then S4 (the start handler) |
| `apps/neuve-web/apps/web/src/routes/review/$unitId.tsx` | S3, then S7 (the feedback read and command) |
| Other page routes under `src/routes/` | S3 only |
| `apps/neuve-web/apps/web/src/server/` feedback file | S7 only |
| `apps/neuve-web/apps/web/src/server/` event route and start handler, `src/routes/__root.tsx` | S4 only |
| `apps/neuve-web/packages/ui/src/neuve/types.ts` | S3, then S7 (feedback state on the desk data), then S6 |
| The desk components that mount feedback or the rationale: `review-desk/review-desk-screen.tsx` (the lane label), `context-margin.tsx`, `thread-card.tsx`, `briefing.tsx` | S7, then S6 |
| `apps/neuve-web/packages/ui/src/neuve/states/*` | S4 only |
| The feedback components and their types in `packages/ui` | S7 only |
| `design/neuve-web/design.pen` (kept in the private archive), the canvas and `design-export/` | D1, then one slice at a time as each reaches parity (S7 and S4 in the order they finish, then S6), never two at once |

**Order.** D1, S2 and S1 start together; S2 commits its `review-cli.ts` change before S1 edits that file. S3 follows S1 and S2; S5 runs beside S3. S7 follows S3, S5 and D1's first part. S4 follows S3 and D1's second part and runs beside S7, since their files are disjoint (S4 owns `routes/index.tsx`, S7 `routes/review/$unitId.tsx`). S6 follows S7 and D1's second part, because it edits the same desk components and `types.ts` after S7. Pen, canvas and export updates take turns. S8 follows S3 and S7 and does not wait for S4 or S6.

**Which slices need the canvas first:** S7 (D1 part one), S4 and S6 (D1 part two). **Plumbing only:** S1, S2, S3 and S5.

**After M5, not in it:** Publish resolving its own citations and carrying references whole (PB1, PB2 option A), and Assemble writing Explained as a flow (PB3 option A), each judged as its own change once the climbs that measure lanes and published context have run.

## 10. Decision rows

| # | Decision | Recommendation |
| --- | --- | --- |
| RD1 | Where the packet read model and the stored schemas live | The read model in `records-core` under a name distinct from the `PacketView` projection row; the manifest's and stored content's zod schemas in `records-schema`; the terminal and the BFF read the same model (§1.1) |
| RD2 | Which Records the BFF reads | The repository it starts in, overridable by an environment variable; this repository for the full test (§3.1) |
| RD3 | What a page opens | `/` opens the newest cycle's standing packet at its first batch; each batch has an address; units keep `/review/<unit>` (§3.2) |
| RD4 | How the BFF builds a page | Server-only functions over `records-core`; a projection that maps shapes only and keeps event IDs; diff contents from git objects at the range, tracked work only; ownership through the shared review rules (§3.3) |
| RD5 | A published unit with no assessment | Human-suggested on read, with the agent's disposition on it held as context under 4.13, so a person decides; this departs from the vocabulary's Human-suggested entry and makes every unassessed unit need a person; the owner chooses between this and the alternatives in §1.4 (C1) |
| RD6 | The standing verdict on human-suggested work | A person's current disposition overrides the agent's, returned by `judge` (§1.4) |
| HX1 | What the BFF imports from the harness | Only the `request` and `git-objects` subpath exports, which pull in no ACP, MCP, model provider, parser or sigstore code (§1.1) |
| ID1 | Who the BFF writes as | The person git names, as a registered human, for every command including the review request; never the caller's agent session (§3.4) |
| ID2 | Guarding the BFF's writes | Start's CSRF middleware declared explicitly in `src/start.ts`, Vite's host allowlist, and one cross-site test; the read-only event stream outside the middleware (§3.5) |
| ID3 | Local processes acting as the owner | Accepted under 6.6 and 0009, and stated (§3.6) |
| PB1, PB2 | Citations and references in M5 | Read through the assembled computation each reference names; Publish unchanged; unresolved citations counted (§2.1) |
| PB3 | Explained in M5 | The desk shows the prose and terms as written (UI7); Assemble unchanged (§2.2) |
| PB4 | Proof cited in a briefing | A chip that opens the proof in the source sheet (§2.3) |
| LV1 | Web events | One server-sent event stream per tab carrying the sequence; loaders reload when it moves (§4) |
| ST1 | Relaying Start a review | The harness's request function through its subpath, taking the git human as requester (§5) |
| ST2 | The range Start a review asks for | The current branch against its base, shown first; a picker later (§5) |
| ST3 | Start a review while it runs | A running state, designed on the canvas (§5, UI5) |
| ST4 | The worker | The owner starts it from a shell with the sign-in; if the BFF ever spawns one, it runs the CLI from this checkout (§5) |
| FB1 | Recording feedback | One event kind targeting a unit, a finding, a reference or a digest (§7) |
| FB2 | Feedback scales | The sheet's scales, plus "misleading" on references and an optional in-between grade (§7) |
| FB3 | What feedback changes | Nothing in the review; durable; desk answers labelled as not decide-then-reveal, apart from 9.51's method (§7) |
| FB4 | Decide-then-reveal in the desk | Not in M5; each answer records whether the harness's call was visible, never the delivery stop; first and final answers kept (§7) |
| FB5 | Reading feedback back | A CLI export in the sheet answers' shape (§7) |
| UI1–UI7 | The canvas round's items | As §8, approved in two parts, with the leans shown there for the owner to judge on the canvas |
| SL1 | Slices and order | As §9: the owner's first checkpoint at S3, feedback at S7, the full test after S3 and S7; S6 after S7 |

## 11. Open points

1. **A vocabulary term for the owner's feedback.** "Feedback" is the owner's word in 10.99 and stays internal until the owner names it. Related: whether the controls are a product feature for every reviewer or the owner's instrument for the climbs, which decides whether they show for everyone.
2. **Whether a person's lane judgement re-assesses the unit.** 4.13 describes a unit's lane changing, but not who may change it. M5 records the owner's call as feedback only (FB3).
3. **Whether feedback becomes context for the next cycle**, as comments do (4.11).
4. **Which range the full test reviews.** A range of this repository that the end-to-end check also ran would let the owner compare the desk with the sheet; a fresh range would show work the owner has not seen. The owner chooses.
5. **A range picker for Start a review** (4.12, C5).
6. **"Start review" on the overview hero against the vocabulary's "Start a review"** (C6): whether the hero's link keeps its label.
7. **Resolving a comment, and threads with agents**, which have no Records event; out of M5 unless the owner wants them for the full test.
8. **The agents control and the lineage page**, which stay empty in M5: Records knows sessions and actors, but which of them work on a branch is not defined for the desk.
9. **The review delivery setting** stays in browser storage until a workspace setting has a home in Records.
10. **The timed-out review's readability** is climb 5; M5 shows what such a run published and disclosed, no more.
11. **Whether the full test waits for the quadrant rationale.** The plan's M5 lists it; 1.10 does not name it, and the owner asked for the shortest path. The proposal lets the full test run after S3 and S7, with the rationale arriving in S6.

## 12. Sources and limits

**Relied on.** The [decisions record](../decisions.md), especially rulings 1.1, 1.7, 1.9, 1.10, Area 4, Area 8, 9.38, 9.51, 10.42, 10.61, 10.69, 10.85, 10.98, 10.99 and Area 11; the [plan](../plan.md); architecture records [0001](../../architecture/decisions/0001-layers-and-responsibilities.md), [0002](../../architecture/decisions/0002-event-driven-processes.md), [0005](../../architecture/decisions/0005-harness-pipeline.md), [0006](../../architecture/decisions/0006-hybrid-retrieval-and-context-references.md), [0007](../../architecture/decisions/0007-batches-units-lanes-and-cycles.md), [0009](../../architecture/decisions/0009-identity-without-auth.md) and [0011](../../architecture/decisions/0011-zod-schemas.md); the [vocabulary](../../vocabulary.md); the [M3 proposal](m3-harness.md); the end-to-end check's catalog (kept in the private archive) and sheet answers (kept in the private archive); the [design handover and workflow](../../design/neuve-web/README.md); the modern-web-guidance forms guide; TanStack Start's CSRF middleware types; the independent review's checks of how `records-core` loads and typechecks in the web app; and the code cited in Starting facts.

**Unverified.**

- Whether the request's subpath can drop the model provider by splitting the route's configuration types alone, or needs more of the configuration moved; S2 finds out from each subpath's import graph.
- How long a read model call takes on a packet of 40 or more units, including the assembled computation's read; S3 measures it with the page's spans.
- Whether the end-to-end check's exported packets can feed the Storybook fixture with resolved citations: the exports hold the read model's output, not the assembled computations, so the fixture may need the full test's own packet instead (§3.7).
