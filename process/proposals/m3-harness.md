# M3 "Harness": design proposal

Historical proposal. Its review-stage graph and budgets are superseded by the [fixed-shape pipeline record](../../architecture/decisions/0005-harness-pipeline.md), which describes the NEU-111 trial. The [owner's decisions](../decisions.md) remain authoritative for accepted product meaning and the other topics below.

Status: accepted on 19 October 2026 with [Area 10's rulings](../decisions.md#area-10-harness-m3-18-october-2026) (10.1–10.77), which win where they differ. Drafted 18 October 2026 and revised through an independent review and seven rounds of rulings. The [decisions record](../decisions.md) is the source of truth. It follows the shape of the [M2 Records proposal](m2-records.md): starting facts, conflicts that need a ruling, numbered sections with options and a recommendation, milestone slices and a decision list. It sits beside the [M4 benchmark proposal](m4-benchmark.md), whose retriever interface and per-hunk share rules M3 consumes.

Each section separates **Facts** (checked in code or docs, cited as path and line at the time of writing), **Options**, a **Recommendation**, **Risks** and **Parallels** (what Entire, Unblocked, this repository's research and published work did with the same problem). "Unverified" marks something I could not check. "Abstract only" marks a paper I saw only as an abstract or a secondary summary. Numbers such as 4.13 refer to rows of the decisions record.

**What the harness is for (11.6).** It collects, analyses, categorises, maps and allocates context, and helps prove or disprove a change, for merge or for another iteration. Every stage below serves that purpose. [Area 11](../decisions.md#area-11-verification-and-review-delivery-19-october-2026) also sets the ground rules for verification and review delivery that sections 8 and 9 apply (11.1–11.5), and makes proof recording a slice of M3 (11.8, slice H4b in section 12).

**How to read it.** Sections 1–4 are shared by every phase: runtime, model routes and budgets, harness techniques, and the retriever. Sections 5–10 are the six pipeline phases (Precompute, Understand, Investigate, Assemble, Dispose, Publish). Each phase section can be read and ruled on alone and ends with its own decision rows, tagged with the phase. Section 11 covers how M3's output is judged before M6, section 12 the slices, section 13 vocabulary proposals and section 14 the full decision list.

**Words.** Product words follow the [vocabulary](../../vocabulary.md): batch, review unit, owned range, surrounding context, contextual marker, same-batch context, digest (batch and unit), lane, human-suggested, human-required, disposition, suggested review, review delivery (Facts, Briefed, Explained, Guided), Before you decide, review cycle and prepared package. The following are internal implementation words, not product concepts: _packet_ (the vocabulary's internal wording for the prepared package), _stage_, _run_, _route_, _activity_, _turn_, _handle_, _lead_, _allowance_, _evidence ledger_, _change map_, _candidate batch_, _behaviour_ (the decisions' "behaviour or obligation" that decides a batch, 4.1), _change facts_ (code-computed measures of a change, section 5), _movement_ (a history, prior-bug, outage or blast-radius signal on a lane axis, 4.2), _lean_ (the agent's stated preference in a quadrant with two possible lanes), _finding_ (one claim in the agent's review of a unit), _coverage line_ (Investigate's per-hunk statement of what it found and searched), _run folder_ (`.git/neuve/runs/<run-id>/`, a run's temporary directory holding in-flight working copies and the unmasked scope, deleted on every path a run ends; ACP sessions get separate empty folders), _partition_ (the part of a candidate batch one Investigate agent handles, 10.1), _procedural lookup_ (a deterministic read, search or outline at the revision, 10.10), _lineage_ (how a ledger entry was found), _final generation_ (an agent's last, tool-free round at its turn limit, 10.11) and _run receipt_. No new product term is used; section 13 proposes one definition for the owner.

## Starting facts

What exists today, checked rather than assumed.

| Finding | Evidence |
| --- | --- |
| Records already has events for a cycle, a batch (title, focus), a unit (title and owned ranges as path, start and end lines), a context reference (marker kind, source kind and locator, a summary of at most 2,000 characters), an assessment (lane, complexity low or high, ease of validation easy or hard, a rationale of at most 4,000 characters), a disposition (verdict, reviewed head OID, a note of at most 4,000 characters) and a comment | [`packages/records-schema/src/events.ts`](../../packages/records-schema/src/events.ts), lines 253–331 |
| Those events cannot yet carry what the harness must produce: a unit's owned range has no old or new side; a context reference has no anchor line, stance, retriever, query, rank or provenance; an assessment has no cited evidence, factors, movement or gaps; there is no event for digests, review-delivery content, suggested reviews, a published package (8.7) or a pipeline run | Same file; [context-reference contract](../../architecture/decisions/0006-hybrid-retrieval-and-context-references.md#context-reference-contract) for the fields the margin needs |
| The append transaction refuses an agent approval on a unit whose current lane is human-required, and only a disposition's author may retract or replace it | [`packages/records-core/src/rules.ts`](../../packages/records-core/src/rules.ts), lines 7–60 |
| `Dispositions.judge` implements 4.13: static automation needs no disposition, agentic and human-suggested need one from anyone, human-required needs a human's, and earlier non-closing dispositions reach the human as context. It has no consumer until M3 or M5 | [`packages/records-core/src/dispositions.ts`](../../packages/records-core/src/dispositions.ts), lines 60–130; [plan follow-ups](../plan.md#follow-ups) |
| The computation store looks every computation up by key before running it, keys include the operation, its version, inputs, configuration and model route, keeps every attempt with token usage, and binds only the first success. Only the worker runs computations | [`packages/records-core/src/computations.ts`](../../packages/records-core/src/computations.ts), lines 34–70 and 133–185 |
| The job queue knows four job kinds. `commit.prepare` is enqueued with each commit but has no handler "until the M3 harness". Each kind has a deadline, retry count, backoff and stall limit | [`packages/records-schema/src/operational.ts`](../../packages/records-schema/src/operational.ts), lines 24–29; [`packages/records-core/src/worker.ts`](../../packages/records-core/src/worker.ts), line 70; [`packages/records-core/src/jobs.ts`](../../packages/records-core/src/jobs.ts), lines 42–89 |
| An event payload is at most 64 KB; larger content is a referenced blob or computation | [`packages/records-schema/src/envelope.ts`](../../packages/records-schema/src/envelope.ts), line 20 |
| No package in the repository depends on `effect/workflow` or `@effect/ai-anthropic` yet. The only `effect/ai` use is the CLI's stdio MCP server | `git grep` over `packages` and `apps/neuve-cli`; [`apps/neuve-cli/src/mcp.ts`](../../apps/neuve-cli/src/mcp.ts), line 5 |
| graph-client asks Neuve Graph a question at a revision with `topK` and a byte limit, plus explicit relationship requests that are always one hop (`depth: 1`). It also exports qualified git reads of blobs at a revision | [`packages/graph-client/src/domain.ts`](../../packages/graph-client/src/domain.ts), lines 478–498; [`packages/graph-client/src/index.ts`](../../packages/graph-client/src/index.ts), lines 16–18 |
| Graph has known faults on benchmark hunks: it stalls on one dev hunk, returns a line range inside an empty file on another, and returns fewer results than the Opus share on 10–11 dev hunks | [plan follow-ups](../plan.md#follow-ups), M4 B4 reviews |
| The benchmark's one retriever interface returns ranked regions (path, line span, chunk, source kind, tokens, score) per hunk, keeps the top 50 for labelling and deeper rankings up to 512,000 tokens | [`packages/evaluation/src/retrieval-bench/retriever.ts`](../../packages/evaluation/src/retrieval-bench/retriever.ts), lines 11–60 |
| The benchmark computes each hunk's real share as `max(4,000, window × 0.5 × hunk changed lines ÷ range review lines)`. The 0.5 working share is "pre-registered; re-read when M3 fixes it". Its denominator excludes generated files, lockfiles and binaries using file-extension lists, which is a benchmark rule, not a product rule | [`packages/evaluation/src/retrieval-bench/policy.ts`](../../packages/evaluation/src/retrieval-bench/policy.ts), lines 69–90; [9.17, 9.23, 9.27](../decisions.md#area-9-benchmark-m4-17-october-2026) |
| Across the 57 ranges of the M4 corpus, a range has a median of 21 hunks (Q1 6, Q3 43, p90 144, max 886) and, under AS1's gap and size rule only (so the counts are upper bounds; shared-symbol merges would give fewer), 9 units (Q1 4, Q3 22, p90 56, max 152); 9 ranges have more than 30 units | `git diff -U0 base head` on each range of `validation/benchmarks/m4/manifest.json` (kept in the private archive), read-only at nice 10, 18 October (section 2.5) |
| M4 has not chosen a semantic-layer strategy: the dev report waits for dev gold | [plan, M4 row](../plan.md#milestones) |
| The kept backend review rules (decision ranges, submitted hunks, responsibility scope, comment anchors, lineage; 1,015 lines with tests) live in the web app and "need a home the harness can import" | `apps/neuve-web/packages/backend/src` (moved to [`packages/review-rules`](../../packages/review-rules/src/index.ts) in H3); [plan follow-ups](../plan.md#follow-ups) |
| No code fetches scope from Linear, Notion or Jira | `git grep` for Linear and Notion clients over `apps/neuve-cli` and `packages` |
| The runtime spike proved Opus 5.5 through `@effect/ai-anthropic` 4.0.0 (generation, structured output, a hand-written tool loop), the output cap on the wire, an ACP client to `codex-acp` with Neuve's MCP tools, and durable workflow resume after SIGKILL. Activities run at least once; `Activity.retry` has no backoff schedule; activity timeouts are not durable. Five risks remain open, including thinking across tool turns and the missing read-only mode in `codex-acp` | [0003](../../architecture/decisions/0003-effect-native-harness-runtime.md); spike README at `~/code/neuve-spikes/harness-runtime-20261016/README.md` |
| The spike authenticated to Anthropic with an OAuth bearer token read from `ant auth`, not an API key | Spike README, "Setup" table |
| Opus 5.5: 1,000,000 input tokens, 128,000 output tokens, 4 USD per million input and 20 USD per million output, adaptive thinking always on, default effort `medium`. Prompt-cache reads cost 5% of input on Opus 5.5; cache writes cost 1.25 times input for 5 minutes and 2 times for 1 hour; the minimum cacheable prompt is 512 tokens; changing effort between requests invalidates the cache | [Anthropic models overview](https://platform.claude.com/docs/en/about-claude/models/overview); [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching); [prompting Opus 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5) |
| Opus 5.5 rejects forced tool use (`tool_choice` of `any` or a named tool) with a 400 error on every request; Anthropic advises `tool_choice: auto` with strict tool use or structured outputs instead | [Thinking, "Response prefill and forced tool use"](https://platform.claude.com/docs/en/build-with-claude/thinking#response-prefill-and-forced-tool-use) |
| Clearing or shortening an earlier tool result on the client invalidates every later thinking block, as does adding, removing, renaming or editing a tool in `tools`. For accounts created on or after 31 August 2026 that is a 400 error on Opus 5.5 unless `prefix_mismatch_behavior: "drop_block"` is set, which the docs call a stopgap that raised output tokens by up to 67% at `max` effort in Anthropic's testing. Appending messages, changing `effort` or `max_tokens`, and server-side compaction or context editing stay valid | [Preserved thinking, "What changes invalidate later thinking blocks"](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking) |
| On Opus 5.5 a text-only end of turn is a progress report, not proof the task is done; Anthropic recommends a checklist, a short continuation naming open items, and stopping after two or three automatic continuations | [Prompting Opus 5.5, "Unattended agentic runs"](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5#unattended-agentic-runs) |
| The labelling track runs headless Claude Code with restricted and safe modes, read-only tools confined to the run directory, and an environment built from a five-variable allowlist. Headless runs once drew on prepaid API credit through a stored token instead of the subscription; 9.55 now fixes the credential order and records the route used on each receipt | [`packages/evaluation/src/retrieval-bench/labelling/routes.ts`](../../packages/evaluation/src/retrieval-bench/labelling/routes.ts) (another lane's uncommitted work); [9.55](../decisions.md#area-9-benchmark-m4-17-october-2026) |
| The labelling council (9.52) caps each member's investigation at about 15 tool calls and the round table at 3 rounds; the neutral briefing is refused if it contains a grade word | `labelling/council.ts`, lines 35–36, and `labelling/briefing.ts`, line 42 (both another lane's uncommitted work) |
| The review desk's delivery contract already fixes what each stop needs: Facts is one sentence with every claim cited; Explained adds a before-and-after flow and at most three terms; Guided replaces the diff with criteria rows (met, not met, no evidence, outside) with evidence chips, from the ticket's "Done when", else its scope, else a gathered scope, plus a suggestion on human-required units | [`apps/neuve-web/packages/ui/src/neuve/shared/delivery.ts`](../../apps/neuve-web/packages/ui/src/neuve/shared/delivery.ts), lines 150–250 |
| The batch overview's verification cards include tests graded "solid" or "shallow" and "missing" cards with a reason. The UI types still carry "Assessment unresolved" and "Assessment pending" states with gap lists, which 4.4 rules out for the harness's output | [`apps/neuve-web/packages/ui/src/neuve/types.ts`](../../apps/neuve-web/packages/ui/src/neuve/types.ts), lines 415–440 and 786–870 |
| Producer-minted far-future ULIDs can pin a projection's lane, model and labels; reconciliation IDs for vents are caller-supplied until the harness issues them | [plan follow-ups](../plan.md#follow-ups) |

## Conflicts, as ruled by the owner

Round 1 of this proposal raised ten conflicts between earlier rulings. The owner ruled on all ten on 18 October 2026 ([Area 10](../decisions.md#area-10-harness-m3-18-october-2026)) and corrected two of the proposal's techniques (10.11, 10.12). The phase sections now apply the rulings; their settled options were removed.

| # | Conflict | Ruling | What was ruled |
| --- | --- | --- | --- |
| C1 | Batch split before Investigate, against [0005](../../architecture/decisions/0005-harness-pipeline.md)'s stage table | 10.1 | Batches also partition a large diff by estimated context need; Understand proposes, Investigate runs per partition, Assemble confirms or re-splits; 0005 revised |
| C2 | The 9.23 floor against one window's share | 10.2 | The allowance belongs to each hunk in the package; contexts are bounded by the 10.1 estimate |
| C3 | History moving units (4.2) against the pass 1 order (3.7) | 10.3 | No history in M3; disclosed once per run, never per unit |
| C4 | Static automation (4.3) against deferred verification (7.9) | 10.4 | No static automation lane in M3; would-be units go agentic, naming the missing check evidence |
| C5 | Credentials against 6.6 | 10.5 | Neuve stores, generates and manages no credentials; identification uses git's user name and email |
| C6 | Fresh-context Dispose against 1.6 and 4.7 | 10.6 | Per-unit reviews are stages of the one pipeline producing the first full set; 4.7 governs later dispositions |
| C7 | Turn limits under 2.13 | 10.7, revised by 10.41 | 35 for Understand and 35 per Investigate agent (10.41, replacing 70 and 70); 40 per batch for Assemble (10.28); 15 per unit for Dispose; measured per review batch |
| C8 | Scope text in captures against 3.12 | 10.8 | Captures keep scope text with clear identifiers masked; amends 3.12 for captures |
| C9 | Gaps lowering high-and-hard units | 10.9 | A gap never lowers a unit that cited evidence places as high and hard; otherwise 4.4 |
| C10 | Graph relations against "structural analysis is separate" | 10.10 | Retrieval stays hybrid; the semantic layer points onward through chunk metadata and graph provenance; structural lookups are procedural and agentic; no Graph structural tool in M3 |

Corrections to techniques: **10.11** (at a turn limit the last round is one final generation, not a tool call; section 3.4) and **10.12** (no compaction, pruning or clearing; tool results sized so a full turn budget fits; section 2.2).

**Round 2, as ruled** ([10.13–10.25](../decisions.md#area-10-harness-m3-18-october-2026)). The owner answered thirteen of round 2's decisions; they are removed from the open list in §14.

| Former decision | Ruling | What was ruled |
| --- | --- | --- |
| XC1, XC19 (where a run lives; lifecycle owner, runner storage) | 10.13 | A background job owned by the job queue; the command queues and follows; memory runner storage, no time lease |
| XC2 (stored turns and resume) | 10.14 | Unmasked working copy of the running stage, masked on completion, deleted on every ending; completed turns never re-called |
| XC3 (run deadline) | 10.15 | Replaced: a review never takes more than 10 minutes from Precompute to disposition; target under 2 (section 2.5, new conflict C11) |
| XC4 (route and preflight) | 10.16, 10.17 | Receipts show route, key variable and organisation if named; costs from the owner's local keys; a worker without the key leaves review jobs waiting and says why |
| XC5 (ceiling and sizing) | 10.18 | Half the window per context, 3,000-token results, closed worst-case sums |
| XC7 (caps, effort, concurrency) | 10.19 | 128,000 cap, `medium` effort, 3 calls in flight; concurrency revisited under 10.15 |
| PC1 (when Precompute runs) | 10.20 | Per commit, file and tree in the background; range facts at the request |
| PC2 (kept review rules) | 10.21 | A shared package imported by the harness and the web app |
| PC3 (change facts) | 10.22 | Citable facts, never a risk score |
| PC4, PC7 (generated, test and doc files) | 10.23 | Guide, don't impose: declarations suggest, Understand judges; a general rule (section 3.9) |
| PC6 (masking) | 10.24 | Declared identifiers plus fetched key shapes with their literal prefix |
| PC8 (Graph, embeddings) | 10.25 | Off in M3 until M4 selects them |

**New conflicts from round 2.**

| # | Conflict | The tension | What this proposal recommends | Section |
| --- | --- | --- | --- | --- |
| C12 | 8.12's queue and the M2 worker model against 10.15 | The M2 worker runs one job at a time (`worker.ts`, lines 552–560) and the queue takes the oldest waiting job of any kind (`queue.ts`, line 383, `ORDER BY job_seq`). A rebase burst of `commit.prepare` jobs, each allowed 10 minutes, can hold a `review.run` behind it without bound; "newest first" and "yield to a review" are not possible as built | Two slots in the one worker: an interactive slot for review runs and a background slot for everything else, each claiming by priority within its kinds | 1 |
| C11 | 10.7 (70 / 70 per agent / 40 / 15 turns) and 10.19 (3 calls in flight) against 10.15 (at most 10 minutes from Precompute to disposition) | Measured Opus 5.5 calls take about 6 s at the median and 10 s on average; one 70-turn agent alone takes about 7–12 minutes, and a 30-unit batch's Dispose at 3 in flight takes far longer | Per-stage wall-clock deadlines that trigger the final generation (10.11), turn limits kept as ceilings, stages pipelined across batches, more calls in flight for fan-out stages, and more work moved to commit and cycle-start time | 2.5 |

**Round 3, as ruled** ([10.26–10.40](../decisions.md#area-10-harness-m3-18-october-2026)). Conflicts C11 and C12 are ruled; the decisions below are removed from the open list.

| Former decision | Ruling | What was ruled |
| --- | --- | --- |
| XC20 and the Assemble turn reading (C11) | 10.26, 10.28 | Ten minutes is the run's total lifetime, timing out like an endpoint; no time limit per stage or turn; turn limits stand (since revised to 35 and 35 by 10.41); Assemble's 40 per batch shared by its groups, at least 2 for the digest |
| XC21 (C11) | 10.27 | Eight model calls in flight per run, shared by every stage (revises 10.19) |
| XC22, XC23 | 10.29, 10.30 | Pipelined stages; no lighter or faster calls in M3 |
| XC28 (C12) | 10.31 | Two worker slots, interactive and background, each taking its most urgent job first |
| XC24–XC26 | 10.32 | Telemetry as tabled; Records the source of truth; OTLP only from user-level settings; cost from a frozen price table |
| XC27 | 10.33 | The guide-not-impose sweep, including lane-blind Dispose |
| XC29 | 10.34 | Release binary without `.env` and `bunfig.toml` autoloading; tracked work only |
| UN5, UN7, UN8, UN10, UN11 | 10.35–10.38 | Partition fit by both loads; partitions nested in batches; least-fragmentation splits; the Understand merge agent at 20 turns |
| UN1–UN4 | 10.39, 10.40 | Obligations extracted with exact text; Understand's tools, change map and fallback |

The one question round 3 opened, what the 10-minute timeout publishes, is XC30 (section 2.5), the first decision of round 4.

**Round 4, as ruled** ([10.42–10.54](../decisions.md#area-10-harness-m3-18-october-2026)). Every recommendation was accepted.

| Former decision | Ruling | What was ruled |
| --- | --- | --- |
| XC30 (the 10-minute timeout) | 10.42 | Stop new work at 9:45, interrupt running agents, Publish what completed; disclose the rest; never-assessed units go to human-suggested; nothing invented |
| IN2 | 10.43 | Top leads preloaded per hunk as handles with metadata |
| IN4 | 10.44 | The seven procedural lookups; symbol-aware ones only where a capability parses the file (TypeScript, JavaScript and Markdown in M3) |
| IN7 | 10.45 | Onward-pointing metadata on every result; kind filters only reorder |
| IN8 | 10.46 | Specific identifiers from code positions where parsed; √N cutoff between 3 and 200; at most 8 per chunk |
| IN9 | 10.47 | The follow-up loop as guidance; lineage on every ledger entry |
| IN3 | 10.48 | The agent keeps within the allowance; code trims only the excess |
| IN5, IN6 | 10.49 | Why and Before you decide written at recording; necessary and useful kept; look-alikes kept for measurement |
| IN1 | 10.50 | Partitions in parallel on the shared 8 calls; shared queries computed once |
| PC9 | 10.51 | The official MCP TypeScript SDK client in an Effect service |
| PC10 | 10.52 | Integrations defined only in the user's own file; listed variables only; no `.mcp.json`, no OAuth storage |
| PC11 | 10.53 | Cycle-start fetch, at most 10 Understand additions per run, frozen snapshot reused by retries; schemas converted to zod |
| PC12 | 10.54 | No integration: repository scope, then weak scope; unfetched tickets disclosed |

**Round 5, as ruled** ([10.55–10.61](../decisions.md#area-10-harness-m3-18-october-2026)), with "validation requirement" added to the [vocabulary](../../vocabulary.md) and [0007](../../architecture/decisions/0007-batches-units-lanes-and-cycles.md) revised.

| Former decision | Ruling | What was ruled |
| --- | --- | --- |
| AS5 | 10.55 | Quadrant to lane as the matrix and 10.9 rule; a high-complexity unit with a validation gap stays human-suggested, counted by telemetry |
| AS4 | 10.56 | The agent weighs each movement signal into the axis it bears on, cites it and states its direction; code checks citations only |
| AS3 | 10.57, 10.58 | Two levels per axis with cited factors, no numeric scores; validation means observed proof |
| VO1 | 10.58 | "Validation requirement" added to the vocabulary, met by observed proof; custom scripts are not proof; tests a minimal base; bogus or forged tests or proof are defects |
| AS1 | 10.59 | Grouping is mostly procedural, with thresholds assessed against the range's diff as guidelines and ranges; 20 lines to start; the agent adjusts for proximity or readability |
| AS2 | 10.60 | Unit groups with a shared prefix, then one digest call; no minimum group size, an upper bracket of 4 to start |
| AS6 | 10.61 | Assemble writes the digests and lower stops; citations must resolve; verdict words flagged; Dispose sees only Facts |

**Round 6, as ruled** ([10.62–10.70](../decisions.md#area-10-harness-m3-18-october-2026)). Every recommendation was accepted, and two rulings extend to the inner loop.

| Former decision | Ruling | What was ruled |
| --- | --- | --- |
| DI10 | 10.62 | In M3 the agent may approve agentic and human-suggested units without recorded proof, saying so plainly; telemetry counts it by lane |
| DI9 | 10.63 | Bogus or forged tests or proof are defects that support a request for changes; uncovered behaviour and test bloat are risk comments; also a guideline for inner-loop reviewers |
| DI1 | 10.64 | A bounded review per unit in a fresh context, up to 15 turns, one Codex session per unit on that route; also for inner-loop reviewers. Settles the "Open from Area 2" question on bounded per-unit calls over ACP for Dispose; Assemble's unit groups over ACP stay open. That section's other question, the turn limits, was settled by 10.7 and 10.41 |
| DI2 | 10.65 | One reviewer per unit in M3; M6 tests whether disagreeing independent reviews should raise a unit |
| DI3 | 10.66 | The agent verifies its own defect claims by reading the code; code checks citations; a separate verifier only in M6 if needed |
| DI5 | 10.67 | The Guided stop follows the desk's contract |
| DI7 | 10.68 | Later reviews in a fresh context over the frozen package; earlier dispositions as context, never rewritten |
| DI8 | 10.69 | Findings become line-anchored review comments; a request for changes links its defect comments |
| AS7 | 10.70 | 20 lines by default, 10–40 as the agent's range; telemetry decides any adaptive rule |

**Round 7, as ruled** ([10.71–10.77](../decisions.md#area-10-harness-m3-18-october-2026)). Every recommendation was accepted; with this round every decision in the proposal is ruled.

| Former decision | Ruling | What was ruled |
| --- | --- | --- |
| JU1 | 10.71 | Judged before M6 by the owner reading one real packet, Investigate scored on M4's development cases, a decide-then-reveal sheet weighted toward what telemetry flags, and dogfooding; evidence from receipts, telemetry and logs; no model judge decides |
| SL1 | 10.72 | Slices H1–H9 as tabled in section 12; files two slices touch are handed on in order. 11.8 later added slice H4b, proof records |
| PU1–PU6 | 10.73 | One append transaction per batch; always publish, gaps disclosed, manifest last; events reference computations; `neuve review show` until M5; the event versions of section 10.2; the run receipt as tabled |
| PC14 | 10.74 | A review cycle starts at planning, when the inner loop begins; how the inner loop's skills open it is their own design |
| PC13, PC15, PC16 | 10.75 | Code-only work at each commit, the range manifest kept current, bursts coalesced newest first in the background slot; no model work at commit time in M3 |
| PC5 | 10.76 | Each scope source records its stratum and fetch time; Guided rows and obligations cite their source; a missing source is a disclosed gap |
| XC9–XC18, UN6, UN9 | 10.77 | The engineering defaults as proposed: tool rules, evidence ledger, no context growth beyond sizing, prompt layout and caching, concise output, stopping, retries, isolation and bounded CPU, vent actors, the retriever port with M4's winner as a setting, the partition count and the diff-size estimate |

## Pipeline at a glance

```
range (base..head) ──► Precompute ──► Understand ──► Investigate ──► Assemble ──► Dispose ──► Publish
   code, cached        code           agent, 35      one agent per   code + one     bounded     code
   per commit,         + scope        turns: change  partition, 35   agent per      agent loop  freeze refs,
   tree and blob       fetch at       map, candidate turns each:     batch: units,  per unit:   manifest,
                       cycle start    batches and    evidence        context refs,  verdict,    judge
                                      partitions     ledger          lanes,         Guided,
                                      (10.1)                         digests        comments
```

| Stage | Code does | Agent reasoning does | Output (durable, by computation key) |
| --- | --- | --- | --- |
| Precompute | Hunks, changed-line counts, enclosing symbols, change facts, indexes, per-hunk queries, scope fetch | Nothing | Range manifest, indexes, scope section index |
| Understand | Lays out the range and scope, checks the change map's coverage, estimates each candidate batch's context need and partitions it (10.1) | Restates the change, groups hunks into behaviours, maps obligations, names questions | Change map with candidate batches and partitions |
| Investigate | Preloads leads, runs semantic search and procedural lookups, counts tokens, resolves quotes, enforces allowances | Follows each result's metadata to the next lookup, judges relevance, prunes, writes why and Before you decide | Evidence ledger per partition |
| Assemble | Confirms batches, groups units by file and proximity, attaches references, maps quadrant to lane | Fills both axes with cited evidence, writes digests and Facts, Briefed and Explained | Batches, units, context references, assessments, digests |
| Dispose | Hides the lane, maps verdicts to dispositions or suggested reviews, checks citations | Reviews each unit, fills Guided criteria, writes comments and the review text | Dispositions, suggested reviews, Guided content, comments |
| Publish | Appends records once, writes the manifest, judges closure | Nothing | Packet manifest and records |

## 1. Runtime: workflow, activities and where a run lives

**Question (ruled: 10.13, 10.14, 10.31).** How a review request becomes a durable run, what an activity is, and whether a run is a worker job or a foreground command.

**Facts.** Only the worker runs workflows and computations (8.2, and the [M2 proposal's worker rules](m2-records.md#5-event-queue-and-worker)). The M2 proposal put the workflow engine in its own `workflow.sqlite`, apart from the records. The spike resumed a SIGKILLed workflow under Bun on `ClusterWorkflowEngine` with `SingleRunner` and SQLite, without the caller resubmitting ([0003](../../architecture/decisions/0003-effect-native-harness-runtime.md#validation-spike-16-october-2026)). The worker exits after 60 s idle and stays alive while an ACP session is open ([0002](../../architecture/decisions/0002-event-driven-processes.md)). Every job kind has an execution deadline (8.12).

**What it serves.** The never-a-dead-end rule (2.5), never recompute (5.4, 8.10), and bounded work (6.10). For the reader: a run that crashed halfway finishes on its own, and running the same range twice costs nothing the second time.

**Options for where a run lives.**

| | A. Worker job, CLI follows | B. Foreground command | C. CLI claims the worker role |
| --- | --- | --- | --- |
| Shape | `neuve review <range>` appends a review request, `review.requested@1` (opening the cycle if none is open), and the queue's event-to-job rule (`jobsFor` in `records-core/src/jobs.ts`) enqueues a `review.run` job in the same transaction; it starts the worker and follows progress by watching the log's sequence number; `--detach` returns at once | The CLI process runs the workflow itself | The CLI becomes the worker if none runs, otherwise enqueues |
| Fits 8.2 (only the worker runs workflows) | Yes | No | Yes, but the CLI's lifetime becomes the worker's |
| Survives closing the terminal | Yes | No | No while the CLI is the worker |
| ACP sessions | Owned by the worker, which stays alive while a session is open (the M2 proposal's decision on live ACP sessions) | Owned by the CLI | Mixed |
| Cost | A new job kind and a progress view | Least code | Lifecycle edge cases |

**Ruled (10.13): A.** The `review.run` job's dedupe key is the run's computation key (range OIDs, pipeline version, configuration, route), so a second request for the same range and configuration is the same job and the same cached work. Its deadline is the run's 10-minute lifetime (10.26), with no per-stage or per-turn limit; the run's clock is durable through `DurableClock` (untested in the spike), so a resumed run does not restart it. `neuve review show <range>` prints the published package in the terminal until M5's desk exists.

**Activities and stored turns.** One activity per stage, plus one per fan-out item (each partition in Investigate, each unit in Dispose). Every activity first looks up its computation key, so the at-least-once replay the spike observed becomes a cache hit. Inside an agent loop each model turn is stored too, keyed by route, configuration, prompt version and the hash of the message prefix, so after a crash completed turns are never re-called; only the turn that was in flight at the crash is called again.

| | A. Turns as raw captures, identifiers masked (recommended) | B. Turns as durable computations | C. Turns not stored |
| --- | --- | --- | --- |
| Retention | 30 days (8.10); stage outputs are the durable results | Forever | — |
| Replay after a crash | Completed turns are never re-called; the turn in flight is called again | Same | Re-calls the model from the stage start |
| Scope text (10.8) | Kept, with clear identifiers masked (section 5.2), so captures can seed eval datasets | Kept forever, which 10.8 does not allow | Nothing kept |
| Cost evidence | Usage is on every attempt either way (M2's attempts table) | Same | Same |

A turn is only needed while its run is in flight; once a stage's output is stored, nothing reads its turns again except for diagnosis and, under 10.8, eval datasets. Hence A. Masking is applied to captures, never to what is sent: the model always sees the scope as fetched.

**Resume under preserved thinking, with masked captures.** Resuming a stage after a crash means resending its exact earlier prefix: rebuilding it from masked captures would edit earlier messages, which preserved thinking rejects (a 400 on newer accounts), and fetching the scope source again would be a new snapshot, which 3.12 forbids inside a cycle. So the two copies have different lives:

| Copy | Holds | Lives | Used for |
| --- | --- | --- | --- |
| Working copy, in the run folder | The stage's exact, unmasked message prefix, turn by turn, and the unmasked scope as fetched | The stage's life (the fetched scope: the run's life, deleted at Publish) | Resuming the stage after a crash, by resending the exact prefix |
| Masked capture, in the blob store | The same turns with clear identifiers masked (10.8) | 30 days (8.10) | Diagnosis and eval datasets |

When a stage completes, its turns are masked into captures and its working copy is deleted. A crash mid-stage resumes from the working copy. If the working copy is lost (the folder was cleaned, the disk failed), the stage restarts from its first turn as a new attempt, and the receipt discloses the restart; stages that need scope after the unmasked copy is lost use the masked capture and disclose that too, never a re-fetch. The run folder is `.git/neuve/runs/<run-id>/`, beside the rest of Records' local state (8.6) and outside the working tree. It holds unmasked tickets, so it must never become the standing copy 3.12 forbids:

| When | What happens to `.git/neuve/runs/<run-id>/` |
| --- | --- |
| A stage completes | Its working copy is masked into captures and deleted |
| Publish | The whole folder is deleted, including the unmasked scope |
| The job's final failure (8.12) | Deleted, after the masked captures are written |
| The run is abandoned: superseded by a newer pipeline version, or its job dropped with `neuve jobs drop` | Deleted when the newer run starts or the drop is recorded |
| The daily `retention.prune` job (5.8, 8.10) | Sweeps every run folder whose run has no waiting, delayed or active job, and any folder older than 30 days whatever its state (the 8.10 bound) |

No agent can see the folder through Neuve's tools (2.16): harness agents have no filesystem. That protection must not depend on Codex: Codex's sandbox can read outside its own folder, so on the ACP route a Codex session running as the same user could read `.git/neuve/runs/`. That is one more reason the ACP route is not used for review roles in M3; before it is, the design must keep working copies out of its reach (a separate OS user, or verified sandbox read roots), which is open.

**Who owns a run's lifecycle.** The queue and the workflow engine can both restart a run after a crash: the queue recovers a job a dead worker left active, and the spike showed the engine resuming a stored workflow on boot by itself. Two owners would race.

| | A. The job queue owns it (recommended) | B. The workflow engine owns it |
| --- | --- | --- |
| Start | The `review.run` handler calls `Workflow.execute` with the job's dedupe key as the idempotency key | Same |
| Crash recovery | The queue's stall recovery requeues the job; its handler re-executes with the same key, and the engine replays stored activities | The engine resumes on boot; the job only waits for the result |
| Retries, deadline, final failed state, `neuve jobs` | The queue's (8.12), in one place | Split between engine and queue |
| Needs | The engine's own boot-time resume turned off or proved to be a no-op without the job (unverified; slice H1) | The queue's stall recovery must never re-execute |

**Runner storage.** The M2 proposal found that Effect's SQL runner storage takes shard locks that expire after 35 s and refresh every 10 s ([M2 §5 facts](m2-records.md#5-event-queue-and-worker)). That is a time lease, which 8.2 rules out. With one worker per repository, runner storage can be `"memory"` while message storage stays SQL and durable, as the M2 proposal's D20 already allowed.

**Risks.** Activities replayed out of order are safe only if every side effect goes through a keyed computation or an idempotent append; direct writes from inside a tool would break that. A run that needs a newer pipeline version than a half-finished run gets a new key and starts fresh, leaving the old one orphaned in `workflow.sqlite`.

**The worker's slots (C12).** As built in M2, the worker loops over one job at a time and the queue hands out the oldest waiting job of any kind (`packages/records-core/src/worker.ts`, lines 552–560; `packages/records-core/src/queue.ts`, line 383). A burst of `commit.prepare` jobs from a rebase, each with a 10-minute deadline, can then hold a review behind it without bound, which breaks 10.15; and the Precompute proposals ("newest first", "yield to an active review") cannot be expressed.

| | A. Priority ordering by kind | B. Separate slots per kind, within one worker (recommended) | C. The review claims the next slot and preempts |
| --- | --- | --- | --- |
| How | `take` orders by a per-kind priority, then by sequence | The single worker (8.2) runs two loops: an interactive slot for `review.run` and a background slot for `commit.prepare`, `transcript.capture` and `retention.prune`; each takes by priority within its kinds, and the background slot may take `commit.prepare` newest first | A waiting review interrupts the running background job, which goes back to waiting without counting an attempt |
| Wait for a review | Up to one background job's run time (as long as 10 minutes) | None | Seconds |
| 6.10 | Unchanged | Two jobs at once: the background slot keeps its subprocesses at nice 10 with bounded threads, and starts no new heavy subprocess while a review runs | Unchanged |
| Cost | Small | One more fiber, an idle check over both slots | Interrupt-safe background jobs; wasted partial work |

**Ruled (10.31): B, with A's ordering inside each slot.** What changes in `records-core` (0002 is revised): `JOB_POLICIES` gains a slot and a priority per kind (and an order, oldest or newest first, for `commit.prepare`); `JobQueue.take` takes a slot and orders by priority, then by sequence in the kind's order; the worker runs one loop per slot and exits only when both are idle and no ACP session is open; stall recovery, retries, deadlines and the single-worker socket (8.2, 8.12) are unchanged. A review run whose range still has unprepared commits does that work itself at request time, bounded by Precompute's 15-second window.

**Parallels.** Entire's review command spawns each reviewer with its own environment variables (`ENTIRE_REVIEW_SESSION` and others) so lifecycle hooks can tag the session without a shared marker file (`docs/architecture/review-command.md` in `entireio/cli`, "Flow" step 4); the harness's reconciliation ID (8.16) plays that role. Entire Graph's boundary rule, "would this make two identical requests differ?", is the same test the computation key applies (`docs/brain-and-graph-boundaries.md` in `entireio/entire-graph`).

Ruled and no longer open here: XC28 (10.31: two worker slots, most urgent job first). XC1 and XC19 (10.13), XC2 (10.14), XC3 (replaced by 10.15's 10-minute limit).

## 2. Model routes, billing and budgets

**Question (ruled: 10.5, 10.16–10.19, 10.27, 10.41).** How a route is checked and recorded when Neuve holds no credentials (10.5), the context ceiling and the sizing rule that keeps every context inside it (10.12), output caps, effort and concurrency. The per-hunk allowance (10.2) and the turn limits (10.7) are ruled.

**Facts.** M3 builds on Opus 5.5 through the Anthropic API, with the ACP path to Codex kept runnable (2.12). Each route's window comes from provider metadata and is frozen into the run's configuration ([0008](../../architecture/decisions/0008-model-routes-and-budgets.md)). The spike found the provider defaults `max_tokens` to 128,000 for an unknown model ID, so the cap must be set. On Opus 5.5 thinking counts toward `max_tokens`, and Anthropic reports 128,000 working well for long agentic turns ([prompting Opus 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5#calibrate-effort)). Token counting is free and rate-limited separately ([token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting#pricing-and-rate-limits)). There is no token or dollar cap; cost is tracked (2.5).

### 2.1 Credentials and the route, as ruled (10.5)

**Ruled (10.5, C5).** Neuve stores, generates and manages no credentials, and identification uses what git provides, the user name and email. The recorded consequence, confirmed on 18 October: "no credentials" means Neuve's own; credentials that model providers or scope sources need "are the user's own environment, read at run time and passed only to the call that needs them, as MCP servers are", and integrations such as Linear are reached through MCP servers or SDKs that Neuve proxies as ephemeral agent tools (10.5).

What that leaves for the harness:

| Concern | Design |
| --- | --- |
| Where a credential comes from | Neuve has none of its own (10.5, as confirmed). A model provider's credential is its own standard environment variable, as the provider's client reads it (for Anthropic, `ANTHROPIC_API_KEY`); a scope source's credential belongs to the MCP server or SDK the user configured, which reads it from the user's environment or its own store (section 5.2). Neuve reads no `.env` file and keeps no credential source, account label or keychain entry |
| Who sees it | Only the HTTP client of the call that needs it, or the child process that needs it (Codex for the ACP route); never logs, captures or records |
| Preflight | Before any model stage, one free token-counting call proves the route works ([token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting#pricing-and-rate-limits)); for the ACP route, Codex's own login status in the isolated Codex home. Signing in there is the user's own action (for example `codex login` run with that `CODEX_HOME`); Neuve never copies, links or places credential files, unlike the runtime spike, which linked the owner's `auth.json`. The ACP route stays runnable for tests and is not used for review roles in M3 (XC16) |
| What a run records | The route (provider, model, effort) and the name of the environment variable that supplied the credential, never its value; this is the run receipt's route line |
| If the preflight fails | The job is delayed with backoff; after the last attempt the run publishes a code-only packet so the review still reaches a person (2.5): one batch, proximity units, every unit in the human-suggested lane by the best-effort rule (4.4) but carrying **no agent disposition**. `Dispositions.judge` shows each of these units as still needing a disposition, so nothing closes without a person, and the run discloses the missing agent review as a gap |

**As ruled in round 2 (10.16, 10.17).** Every receipt shows the route, the variable that supplied the key, and the organisation if the provider names it. For now costs come from the API keys the owner set up in the repository: the gitignored `.env.local`, as in 9.55, read as the user's environment under 10.5 and never copied or logged. That reconciles with "Neuve reads no `.env` file" without Neuve code parsing it, **in development only**: when run from source in this repository, Bun loads `.env`, the `NODE_ENV`-specific files and `.env.local` into the process environment by itself ([Bun environment variables](https://bun.com/docs/runtime/env); this repository's `bunfig.toml` does not turn it off, and only `.env.local`, gitignored, exists here), so the development worker sees the owner's key as an ordinary variable.

The release build must not inherit that behaviour. Bun's compiled executables load `.env` and `bunfig.toml` from the directory they run in by default ([Bun single-file executables](https://bun.com/docs/bundler/executables)), so a release worker started in a user's repository would load a committed `.env` (or a repository's `bunfig.toml`) into its environment. A repository could then, for example, set `OTEL_EXPORTER_OTLP_ENDPOINT` and receive the worker's spans. So: the release binary is built with `--no-compile-autoload-dotenv` and `--no-compile-autoload-bunfig`; its provider key comes from the user's own shell environment; and the OTLP opt-in is read only from user-level configuration (section 3.8), never from environment variables a repository can shape. A worker that lacks the key leaves review jobs waiting and says why in `neuve jobs`; a worker started from the user's shell picks them up, and commit preparation still runs in the background (10.17).

**Still open:** whether the provider's responses name the billed organisation (so the receipt can show it), and whether the provider's terms allow a subscription route for the harness.

### 2.2 The context ceiling and the sizing rule (10.12)

**Ruled (10.12, 10.18).** The turn limits exist so a context never overflows; the harness needs no compaction, pruning or clearing of tool results. The earlier rounds of this proposal added server-side clearing, compaction and a "ledger restart"; those were this proposal's own ideas and are withdrawn.

Two numbers that start at the same value stay separate. The **allowance share** is 9.17's working share, which sizes each hunk's surrounding context in the packet (section 2.3); it stays at 0.5 so the M4 headline, read at the real share, stays valid (9.17, 9.41). The **context ceiling** C is how much input any one model context may reach: C = 0.5W = 500,000 tokens on Opus, half the window, which leaves the other half as headroom and keeps every context far from the provider's limit.

**The sizing rule.** A context's worst case is its fixed prompt plus its inputs plus a full turn budget of tool results and the agent's own turns:

`F + Z + I + T × (r + o) ≤ C`

where F is the fixed prompt (tools, system, examples; about 20,000 tokens), Z a reserve of 10,000 tokens for the final generation's instruction and the provider's injected structured-output prompt (section 3.4), I every input the stage receives, each with its own bound, T the turn limit (10.41 for Understand and Investigate, 10.28 and 10.7 for Assemble and Dispose), r the cap on one tool result, and o the agent's own output per turn that stays in context (its preserved thinking, the call and any note; budgeted at 2,000 tokens and measured). Tool results are capped at **r = 3,000 tokens**: a search returns handles plus short excerpts, a read returns one page of about 200 lines, a grep returns a bounded list of matches. A result larger than r is never sent; the tool returns its first page and a handle for the next.

Every input is counted, and each has a bound. Anything larger is reached through a paging tool rather than inlined.

| Input | Bound | Beyond the bound |
| --- | --- | --- |
| Range-wide hunk index (about 40 tokens per hunk) | Understand: 245,000 (about 6,100 hunks). Other stages: not inlined | Understand partitions by code area (UN8); other stages page it with `hunks(page)` |
| Commit texts | 10,000 (subject plus the first 20 lines of each) | Paged with `commit(oid)` |
| Scope sections | Understand: 40,000. Investigate: the sections its obligations cite, 10,000 | `scope_section(id)` |
| One batch's change-map entry, obligations and questions | 6,000 (schema caps: titles, focus, at most 20 obligations and 20 questions) | — |
| Preloaded leads | 30,000 per partition: `k = min(3, ⌊30,000 ÷ (250 × hunks(P))⌋)` leads per hunk at about 250 tokens each (handle, metadata, three-line excerpt); none when that is 0 | `search` |
| Sibling partitions' hunk index | 10,000 | `hunks(page, partition)` |
| A partition's diff load `Σ D(u) + A × areas` | 239,000 (the remainder, used by UN5) | More partitions (UN6) |
| Assemble's ledger index and change facts | 100,000 and 20,000 | Unit groups across contexts |
| Dispose's references' excerpts for one unit | What its partition could gather, at most T × r = 35 × 3,000 = 105,000 | — |

| Stage | F + Z | T × (r + o) | Inputs I | Worst case |
| --- | --- | --- | --- | --- |
| Understand | 30,000 | 35 × 5,000 = 175,000 | Hunk index 245,000 + commit texts 10,000 + scope 40,000 = 295,000 | 500,000 |
| Investigate, per partition | 30,000 | 35 × 5,000 = 175,000 | Change-map entry, obligations and questions 6,000 + cited scope 10,000 + leads 30,000 + sibling index 10,000 + diff load 239,000 = 295,000 | 500,000 |
| Assemble, per unit group (at most 4 units) | 30,000 | up to the batch's whole 40 × 6,000 = 240,000 (a one-group batch) (o budgeted at 3,000: submissions run longer) | The batch's ledger index 100,000 + change facts 20,000 + change-map entry and obligations 6,000 = 126,000 | 396,000 |
| Assemble, batch digest call | 30,000 | at most 5 × 5,000 = 25,000, from the batch's 40 | The groups' Facts and unit titles, about 150 tokens a unit, at most 30,000 | 85,000 |
| Understand merge pass (UN10), when Understand is partitioned | 30,000 | 20 × 5,000 = 100,000 | Behaviour lists from every Understand partition, about 300 tokens each, at most 60,000 (about 200 behaviours; beyond that, `behaviours(page)`) | 190,000 |
| Dispose, per unit | 30,000 | 15 × 5,000 = 75,000 | Unit diff 8,000 (units capped at 400 changed lines) + Facts, obligations and change-map entry 8,000 + excerpts 105,000 = 121,000 | 226,000 |

Understand and Investigate close exactly at C by construction: their diff and index bounds are what is left after everything else is counted.

If a context nonetheless crosses C before its turn limit (because turns ran longer than o), the harness goes straight to the final generation (section 3.4). Because C is half the window, a provider overflow error should not occur; if one does, the pending tool call is answered with a one-line result ("not returned: context full") and the final generation follows (10.11, 0005).

### 2.3 The per-hunk allowance, as ruled (10.2)

**Ruled (10.2, C2).** The allowance, `max(4,000, floor(W × 0.5 × hunk changed lines ÷ range review lines))` with a result that crosses it counted by its leading lines (9.39), belongs to each hunk in the package, not to one context. The package may hold more surrounding context than one window, because no single agent loads it all: Understand and Investigate are bounded by the partition estimate (10.1, section 6.4), Assemble by its index cap and unit groups, Dispose by one unit. A hunk's allowance is an upper bound on what the packet attaches to it; what is actually attached is also bounded by what its Investigate partition could gather within its turn budget.

The review-lines denominator needs a product rule for generated files that does not map file types (9.31 and the [constitution](../../CONSTITUTION.md#repository-language-neutrality)); section 5 proposes one.

### 2.4 Output caps, effort, concurrency and turns

| Setting | Recommendation | Why |
| --- | --- | --- |
| `max_tokens` | 128,000 on every call, set explicitly | Thinking counts toward it on Opus 5.5; the cap bounds runaway output without truncating normal turns; output is tracked, not capped by price (2.5) |
| Effort | `medium` everywhere in M3, fixed per context | Opus 5.5's default; Anthropic reports `medium` matching or beating Opus 5 at `high` on coding and knowledge-work evaluations; changing effort mid-context invalidates the cache |
| Concurrency | 8 model calls in flight per run, shared by every stage (10.27, revising 10.19's 3) | Rate limits (to be verified for 8) and the 6.10 rule for the tools those calls trigger |

**Turns, as ruled (10.41, 10.28, 10.7, 10.38).** Understand 35 turns per agent and each Investigate agent 35, 70 over the two stages (10.41, replacing 10.7's 70 and 70); Investigate's total is 35 times its agents. Assemble keeps 40 per batch, shared by its unit groups with at least 2 for the digest call (10.28), Dispose 15 per unit (10.7), and the Understand merge pass 20 (10.38). Actual needs are measured per review batch while the harness is dogfooded: every run receipt records, per agent, the turns used, whether the limit was reached, whether the final generation ran, and tokens in and out (PU6).

**Risks.** A 128,000 cap with adaptive thinking can let one turn spend heavily on thinking, which also eats into o; the receipt shows it and the sizing constants are re-read from measurements. Effort `medium` may be too low for lane assessment and dispositions; section 11 measures it.

**Parallels.** Anthropic's multi-agent research post reports agents using about 4 times the tokens of chat and multi-agent systems about 15 times, and token use explaining 80% of variance on one browsing benchmark ([How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system); secondary summary only). That supports fan-out only where it buys quality, and tracking tokens as a KPI ([product purpose](../../foundations/01-product-purpose.md#measurement-commitments)).

Ruled and no longer open here: XC4 (10.5, 10.16, 10.17), XC5 (10.18), XC6 (10.2), XC7 (10.19), XC8 (10.7).

### 2.5 The wall-clock budget (10.15) and conflict C11

**Ruled (10.15).** A review never takes more than 10 minutes from Precompute to disposition; the limit is set high at first so the bottlenecks can be understood, and the target is under 2 minutes. Precompute hooks into the inner loop and git events, Records aggregates apart from the harness, and work is always event-driven, in the background and mindful of bursts.

**What a turn costs in time (measured where possible).** The runtime spike's logs carry no per-call timings (checked). I measured Opus 5.5 tool-loop calls read-only from this repository's own Claude Code transcripts on 18 October, timing each call from the tool result that preceded it to the last streamed block of the response:

| Sample | Calls | Median | p10 | p90 | Mean |
| --- | --- | --- | --- | --- | --- |
| This session's subagents | 813 | 5.8 s | 2.7 s | 18.9 s | 9.7 s |
| One other session in this repository | 700 | 6.2 s | 2.4 s | 20.4 s | 10.1 s |

Output ran at about 100 tokens a second on calls longer than 500 output tokens, and tool execution took a median of 0.6 s (p90 7.2 s, shell commands included). Limits: these are Claude Code sessions at their own effort settings with large, mostly cached contexts, not the harness at `medium`; the per-turn figure for the harness is an **estimate of 8 s** (about 7.5 s of model time plus 0.5 s of tools) until H1 measures it. A final generation that writes 2,000–3,000 tokens takes about 20–30 s at the measured speed.

**How big a range is (measured).** For all 57 ranges of the M4 benchmark corpus (this repository and `neuve_effect`), `git diff -U0 base head` read-only, at nice 10. Units are counted with AS1's gap and size rule only: hunks in the same file whose unchanged gap is at most 20 lines join one unit, split past 400 changed lines. AS1 also merges hunks that share an enclosing symbol, which would give fewer units, so these counts are **upper bounds** (splitting a range into batches can add a few back).

| Statistic | Hunks | Units | Files |
| --- | --- | --- | --- |
| Median | 21 | 9 | 5 |
| Q1 | 6 | 4 | 3 |
| Q3 | 43 | 22 | 12 |
| p90 (nearest rank) | 144 | 56 | 25 |
| Max | 886 | 152 | 132 |

Seven of the 57 ranges have more than 100 hunks; 9 have more than 30 units and 5 more than 60. The corpus is two repositories' history selected for the benchmark, so other repositories may differ.

**What is measured and what is estimated.** Measured: per-call latency and output speed of Opus 5.5 tool loops (the table above), but in Claude Code sessions, not the harness at `medium`; and the range sizes above. Estimated: every stage's turn use (for example Investigate's 1.33 turns per unit), the output size of each submission (taken from the schemas' caps), and the 45 s per Dispose unit. H1's telemetry replaces the estimates.

**The time model.** A stage's wall time is its turns times the time per turn, plus any output beyond a typical turn's, at the measured output speed:

`time ≈ turns × t + extra output ÷ v`, with t = 8 s or 10 s per turn (the measured means are 9.7–10.1 s) and v ≈ 100 tokens a second.

The per-turn time already includes a typical turn's output; the extra term is for submissions that write much more, such as a change map, an Assemble group's assessments and digests, or a unit's review. The expected times below include it.

**Why it was a conflict (C11, now ruled by 10.26–10.30).** For an illustrative batch of 30 units and about 100 hunks in one partition (a range between Q3 and p90 above; the figures are estimates):

| Stage | Turn limit (10.7, before 10.41) | Time at the limit, t = 8 s / 10 s | With expected use (estimate), t = 8 s / 10 s |
| --- | --- | --- | --- |
| Understand | 70 | 9.3 / 11.7 min | 10 turns plus a 6,500-token change map: 2.4 / 2.8 min |
| Investigate, per agent | 70 | 9.3 / 11.7 min | 15 turns plus 3,000 tokens of coverage lines: 2.5 / 3.0 min |
| Assemble, per batch, one context | 40 | 5.3 / 6.7 min, plus about 27,000 output tokens (900 per unit for the assessment, Facts, Briefed and Explained): 4.5 min more | 20 turns plus the 27,000 tokens: 7.2 / 7.8 min |
| Dispose, per unit | 15 | 2.0 / 2.5 min per unit; 30 units at 3 in flight: 20 / 25 min | 4 turns plus 1,200 tokens: 44 / 52 s per unit; at 3 in flight, 7.3 / 8.7 min |
| **Total** | | **about 49 / 60 min** | **about 20 / 22 min** |

Assemble as one context per batch cannot meet the 10 minutes: its output alone takes 4–5 minutes, which is why it now works in unit groups (10.28). Even expected use misses 10 minutes, and the limits as written allow five or six times that. 10.7 and 10.15 cannot both hold as ceilings that agents may reach, and 10.19's 3 calls in flight is the tightest constraint on fan-out.

**As ruled (10.26–10.30, C11).** Ten minutes is the total lifetime of a review run, from beginning to end; it times out the way an endpoint would. There is no time limit per stage or per turn: the turn limits (10.7) stand, and telemetry identifies the bottlenecks (10.26). Eight model calls are in flight per run, shared by every stage (10.27). Assemble's 40 turns are per batch, shared by its unit groups of up to four units, with at least two kept for the batch digest (10.28). Stages are pipelined: each unit is reviewed as soon as its Assemble group submits it, and each batch is assembled as soon as its partitions finish (10.29). No lighter or faster calls in M3 (10.30). The final generation (10.11) still runs at a turn limit or at the context ceiling, never on a clock.

**The expected schedule.** Not a limit: what telemetry compares each run against, to find the bottlenecks. All figures are estimates on the estimated 8 s (10 s) per turn; the measured transcript figures are medians of 5.8–6.2 s and means of 9.7–10.1 s per call. At 8 calls in flight per run, for the median range and a constructed p90 range (p90 hunks paired with p90 units, not an observed range):

| Stage | Median range (21 hunks, 9 units, 1 partition), 8 s (10 s) per turn | Constructed p90 range (144 hunks, 56 units, 5 partitions), 8 s (10 s) per turn |
| --- | --- | --- |
| Precompute at the request | 0:15 | 0:15 |
| Understand | About 6 turns plus a 2,000-token change map: 1:10 (1:20) | About 10 turns plus a 6,600-token change map: 2:30 (2:50) |
| Investigate | 1 agent, about 12 turns: 1:45 (2:05) | 5 agents in parallel, about 16 turns each: 2:20 (2:50) |
| Assemble | 3 groups in parallel and the digest call: 1:30 (1:40) | 14 groups and the digest call, sharing the 8 slots with Dispose |
| Dispose | 9 units in 2 waves, partly overlapping Assemble: 1:30 (1:40) | 56 units at about 45 s (51 s) each; with Assemble's groups, about 3,500 (3,900) slot-seconds over 8 slots: 7:20 (8:10) for the two stages together |
| Publish | 0:15 | 0:15 |
| **Expected total** | **about 6:25 (7:15)** | **about 12:40 (14:20)** |

A Q3 range (43 hunks, 22 units, 2 partitions) at 8 s: Precompute 0:15; Understand about 7 turns plus a 3,000-token change map, 1:25; Investigate 2 agents of 11 units, about 15 turns each, 2:05; then Assemble's 6 groups (6 × 70 = 420 slot-seconds), the digest call (20) and Dispose's 22 units at 45 s (990), about 1,430 slot-seconds over 8 slots, 3:00; Publish 0:15. That is about **7:00**, and with slot waits and pipelining gaps rounded up, **about 7:30** (about 8:30 at 10 s). The run is expected to reach the timeout only for large ranges: with about 4 minutes left after Investigate, 8 slots and about 61 s of Assemble-plus-Dispose slot time per unit, the expectation fits up to roughly **30 units** at 8 s per turn (about 27 at 10 s). In the corpus that is the 9 ranges of 57 above 30 units, about one in six; the median and Q3 ranges finish with several minutes in hand. An agent that takes many more turns than estimated, or a slower provider, moves that line down. The receipt records each stage's actual time, turns and output tokens against these expectations (section 3.8).

**A run that uses every turn (10.41).** At the turn limits, Understand and Investigate alone take 35 × 8 s + 35 × 8 s = **9:20** (11:40 at 10 s), before any submission output; Assemble, Dispose and Publish come after that. For the median range (9 units, 3 Assemble groups, 1 partition):

| Stage, at its limit | 8 s per turn | 10 s per turn |
| --- | --- | --- |
| Precompute | 0:15 | 0:15 |
| Understand, 35 turns plus a 2,000-token change map | 5:00 | 6:10 |
| Investigate, 35 turns plus coverage lines | 4:46 | 5:56 |
| Assemble, the batch's 40 turns over 3 groups in parallel (about 13 each) plus output, then the digest call | 2:50 | 3:20 |
| Dispose, 15 turns per unit plus output, 9 units in 2 waves | 4:30 | 5:30 |
| Publish | 0:15 | 0:15 |
| **Total** | **about 17:40** | **about 21:30** |

Such a run reaches the 10-minute timeout well before Dispose, and the timeout's outcome (XC30) decides what it publishes. That is the intended use of 10.26 and 10.41: the limits stay generous, and a run that hits the timeout leaves a receipt showing which stage used its turns, so telemetry explains the friction. Batching and splitting the work in parallel is what keeps the expected runs above under 10 minutes.

**What the 10-minute timeout does, as ruled (10.42).** Option B was accepted; the options are kept as the record of the choice.

| | A. Fail like an endpoint | B. Publish what is complete, disclose the rest (recommended) | C. Final generations at 9:00, then Publish |
| --- | --- | --- | --- |
| At 10:00 | The run fails; nothing is published; the job's final failure deletes the run folder | At 9:45 the harness stops starting new work, interrupts running agents, and Publish runs on every stage output that completed; units whose stages did not finish are published with gaps ("not assessed" lanes fall to human-suggested under 4.4 and 10.9; no agent disposition is invented). Publish needs a reserve of about 15 s before 10:00 | At 9:00 every running agent gets its final generation (10.11) and Publish follows |
| Fits 10.26 ("times out the way an endpoint would", no per-stage limit) | Exactly | The run still ends at 10 minutes; only the last reserve is a clock, and no stage or turn has one | Adds a clock-driven step that 10.26 removed |
| Fits 2.5 (always produce the batch, never a dead end) | No: a dead end | Yes | Yes |
| What the reviewer gets | Nothing; a retry is a new run of up to 10 minutes, mostly cache hits (5.4) | A packet with the finished parts and disclosed gaps | A more complete packet, at the cost of a time trigger per agent |
| Wasted work | Everything since the last stored computation is kept in the computation store, but nothing reaches the reviewer | Interrupted agents' partial ledgers are kept as stage outputs, disclosed | Little |

**Recommendation: B.** It honours 10.26's single run-level timeout (no stage or turn limit, and the run ends at 10:00 like an endpoint) while keeping 2.5's rule that a stage failing never becomes a dead end. Its only clock is Publish's 15-second reserve. A's endpoint semantics are the most literal reading of 10.26 but leave the reviewer with nothing; C reintroduces a per-agent time trigger.

**What can happen earlier (10.15, 10.20, 2.10).** The M2 hooks already record, as commits land: the commit's OID, parents, tree and author with its link to the agent session (`commit.recorded`, which enqueues `commit.prepare`, de-duplicated per commit with a 10-minute deadline), rewrites (`commit.rewritten`), and the inner loop's sessions, turns and transcript offsets ([`events.ts`](../../packages/records-schema/src/events.ts) and [`jobs.ts`](../../packages/records-core/src/jobs.ts)). Proposed use:

| When | Work | Saves at review time |
| --- | --- | --- |
| Each commit (`commit.prepare`) | Hunks with enclosing symbols; the BM25 and identifier index for the new tree, updated only for changed blobs; per-hunk queries and their top leads against the parent tree; change facts | Index build and lead search; Understand and Investigate start with leads. Leads are computed against each commit's parent, which differs from the range's base, so at the request a lead is reused only when its hunk's text equals the range's hunk (the range diff can merge or reshape commit hunks) and its blob at that path is the same in the base tree; anything else is dropped and re-queried against the base index, which BM25 answers in milliseconds |
| As commits land on a branch | The range manifest from the merge-base with the base branch, kept current incrementally | The manifest at the request |
| At the start of the inner loop's cycle (3.12 already places the fetch there) | The scope fetch and its dated snapshot | The fetch, and its latency to the integration |
| Optionally, each commit | A draft change-map entry by a model | Part of Understand; but it spends model tokens on every inner-loop commit, most of which never reach review; not in M3, measured later |

Bursts (a rebase lands dozens of commits): `commit.prepare` coalesces work by tree and blob and runs in the worker's background slot, newest head first, at nice 10, starting no new heavy subprocess while a review runs in the interactive slot. None of that is possible with M2's single sequential, oldest-first worker; it depends on conflict C12's ruling (XC28).

Ruled and no longer open here: XC30 (10.42).

Ruled and no longer open here: XC20 and the Assemble reading (10.26, 10.28), XC21 (10.27), XC22 (10.29), XC23 (10.30).

## 3. Harness techniques shared by every agent stage

**Question (ruled: 10.11, 10.12, 10.32–10.34, 10.77).** Tool design, context-growth control, the evidence ledger, prompt layout and caching, stopping, retries, isolation, bounded CPU and the vent tool. The phases below refer back here instead of repeating it.

### 3.1 Tools

| Rule | How | Why and parallel |
| --- | --- | --- |
| Schemas | Each tool's input is a zod schema; the agent sees the JSON Schema zod produces, stripped of the keywords strict tools and structured outputs reject (length and numeric bounds, `additionalProperties` other than false), so those caps are enforced only by zod after the response; the tool parses with zod (8.11). Tools with no input omit `parameters` | The spike's 400 on empty parameters; 8.11 |
| Read-only, at a revision | Reads go through graph-client's qualified git reads of blobs at the range's OIDs, never the working tree | Isolation (2.16); Entire's research found working-tree snapshots can describe live files while naming HEAD ([Entire research](../../research/03-entire-and-code-context.md#identity-and-revision-binding)) |
| Handles plus excerpts | Search returns handles (path at revision, lines, kind, tokens, rank) with a short excerpt; `read` pages a handle up to about 200 lines; the server resolves quotes and offsets (0005) | SWE-agent's interface work found a windowed file viewer and succinct search results essential ([SWE-agent, arXiv 2405.15793](https://arxiv.org/abs/2405.15793); abstract and summaries only) |
| Explicit empty results | A search that finds nothing says so, with the scope it searched | Unblocked's demo showed a valid query returning nothing while the answer existed (Unblocked notes, kept in the private archive) |
| Few, distinct tools | Per stage, only what it needs: Understand has `hunk`, `read`, `commit`, `scope_section`; Investigate has one semantic `search`, the procedural lookups `read`, `uses`, `defs`, `outline`, `symbol_at`, `tree`, `same_batch` (IN4), the pagers `hunks` and `scope_section`, and `record_evidence`, `drop_evidence`; Assemble and Dispose have `read` and their pagers; every stage has its `submit_<stage>` and `vent`; each tool answers a different question | Anthropic warns that overlapping tools confuse agents ([Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)) |
| Same tools on both routes | One `Toolkit` used in-process for Opus and served over stdio MCP to Codex, with all four MCP hints set explicitly | The spike showed both work and that hints default to destructive |

**Tracked work only (10.34).** The harness reviews tracked work only: files and folders `.gitignore` lists, and anything untracked, are never read. Every read path goes through git objects at the range's OIDs, so the working tree is never consulted:

| Path | How it reads |
| --- | --- |
| Precompute (`commit.prepare`, range manifest, change facts) | The commit's or range's diff between OIDs, and blobs by OID; repository declarations (`.gitattributes`, test and docs tool configuration) read from the tree at the base or head OID, never from the working tree |
| Indexes (BM25, identifiers, chunks) | Built from the blobs listed in the tree OID (`ls-tree`, then blob reads) |
| Agent tools | `read` reads a blob at a path and revision; `uses` runs `git grep` against the tree OID, which searches only that tree's blobs; `defs`, `outline` and `symbol_at` read the index built from the tree; `tree` lists the tree OID; `hunks`, `commit` and `same_batch` read the range's diff and commit objects |
| Scope from repository plans and docs | Read from git at the base OID (and the range's commits for plans inside the range), never the working copy |
| Graph snapshots, if M4 enables them | Committed-tree snapshots only; Entire Graph's interactive commands default to the working tree ([Entire research](../../research/03-entire-and-code-context.md#precomputation-is-not-continuous-incremental-indexing)), which the harness must never use |

Not git objects, and never read by agents: Records, the run folder, user-level configuration, and integration responses (external by design, section 5.2). A file that is force-added despite `.gitignore` is tracked, so it is reviewed like any other.

### 3.2 The evidence ledger and context-growth control

The ledger is the structured, durable record of what a stage found. It is what survives a stage failing (2.5), and the source the packet's context references are projected from.

| Field | Content |
| --- | --- |
| Identity | Entry ID, stage, agent context, turn |
| Anchor | Hunk, side, changed line or lines (3.5) |
| Source | Origin (repository, scope excerpt, same-batch; history in pass 2), declared kind (`test`, `doc` or `undeclared`, PC7), provenance (repository, revision, blob, path, lines, or URL and fetch time) |
| Retrieval | Retriever, query, rank and score, or "agent read" |
| Judgement | Grade (necessary or useful, 9.11), stance (supports, contradicts, background, unresolved; [0006](../../architecture/decisions/0006-hybrid-retrieval-and-context-references.md#context-reference-contract)), one sentence of why it applies, one sentence of Before you decide (9.8) |
| Cost | Tokens counted against the hunk's allowance |

**Growth control (10.12).** There is none beyond sizing. The message list is append-only for its whole life: nothing is cleared, shortened, compacted or restarted. That is what the owner ruled, and it is also what Opus 5.5's preserved thinking needs, since clearing or shortening an earlier tool result on the client invalidates every later thinking block ([preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking)). Contexts stay inside the ceiling because every tool result is capped before its first send (handles plus excerpts, paged reads, bounded greps; r = 3,000 tokens) and the turn limits are sized against the ceiling (section 2.2). The ledger is the stage's durable output and what survives a failure, not a memory the context is rebuilt from.

### 3.3 Prompt layout and caching

| Order | Block | Cache |
| --- | --- | --- |
| 1 | Tool definitions, fixed for the whole context | Part of the prefix; any change invalidates everything |
| 2 | System: role, the stage's rules, 3–5 short examples, the vent examples, the untrusted-data note | Breakpoint, 1-hour TTL when many calls share it (Dispose, Investigate fan-out) |
| 3 | The stage's shared inputs, exactly as section 2.2 bounds them. Understand: hunk index (245,000), commit texts (10,000), scope sections (40,000). Investigate: the batch's change-map entry, obligations and questions (6,000) and the scope sections they cite (10,000). Assemble: the batch's change-map entry and obligations (6,000). Dispose: the batch's change-map entry (2,000). Outside Understand, the range-wide hunk index and commit texts are never inlined; `hunks(page)` and `commit(oid)` page them | Breakpoint; shared across a stage's fan-out |
| 4 | This context's own inputs. Investigate: the partition's diffs and code-area outlines (239,000), preloaded leads (30,000), the sibling partitions' hunk index (10,000). Assemble: the batch's ledger index (100,000) and change facts (20,000). Dispose: the unit's diff (8,000), its Facts, obligations and validation requirements, and its references' excerpts | Automatic caching as the conversation grows |
| 5 | The task, the completion condition and the budget line, last | Not cached |

Long material goes above the task, as Anthropic's long-context guidance advises ([prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices#long-context-prompting)), and stable material goes first so the prefix is reused. Diffs, code, comments and scope text are wrapped in tags carrying a random ID, with a system note that text inside is data, never instructions, following [Anthropic's pasted-content guidance](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5#mark-pasted-text-in-user-messages) and Entire's judge prompt, which treats reviewer reports as "untrusted DATA" (`cmd/entire/cli/review/synthesis_prompt.go` in `entireio/cli`). Reminders (turns left, open items) are appended as new messages, never edits to the system block, so the cache keeps matching.

**Reviewer guidance from the skills (11.7).** Dispose's system block, and Assemble's where it judges coverage, draws its guidance from the reviewer skills in `.agents/skills/` (review-verification, review-independence, review-against-scope, inner-loop-reviewer, final-reviewer; being written in another lane), rather than restating it, so the inner-loop reviewer and the harness share one authority. The skills' text sits in the stable, cached part of the prompt (order 2 above).

**Concise output (2.14).** Schemas cap every text field (one sentence for why and Before you decide, a paragraph for a digest). The prompt says to cite instead of quote, to say a thing once, and to use more words only when a consideration needs them. Sections are optional arrays, not mandatory headings: Entire found that forcing fixed headers "produced padded 'none' filler on small/clean changes" (same file). **Examples versus rules:** rules only for what code cannot enforce and the agent must know (what the stage owns, what it must not decide); examples for judgement and style (a good and a bad Before you decide, a good and a bad vent, as 2.15 asks). Anthropic recommends a few diverse canonical examples over lists of edge cases ([Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).

### 3.4 Stopping

A stage ends normally when the agent calls its `submit_<stage>` tool (declared strict from the first request and never edited) with output that passes the zod schema and code's coverage checks. A text-only end of turn is a report: the harness replies with the open items by name, at most three times ([prompting Opus 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5#unattended-agentic-runs)). Every tool result carries a budget line (`turn 21 / 35`, allowance used per hunk), the turn-count analogue of Anthropic's time signals, and at 85% of the limit the harness appends a reminder to finish.

**At the turn limit or the ceiling: one final generation (10.11).** When the agent reaches its turn limit or its context crosses the ceiling (never on a clock: 10.26 sets no stage or turn time limit), its last round is one final generation, not another tool call. The harness appends a short instruction to produce the stage's best-effort output from the tool results it already has, sets `tool_choice: none` and asks for the stage's output schema as structured output. Nothing in `tools`, `system` or the earlier messages changes, so the agent's thinking stays valid: changing `tool_choice` and other top-level parameters is allowed under preserved thinking, while editing `tools` is not ([preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking)), and no tool is forced, which Opus 5.5 would reject ([thinking, "Response prefill and forced tool use"](https://platform.claude.com/docs/en/build-with-claude/thinking#response-prefill-and-forced-tool-use)). The stage therefore never errors on a limit. That one call pays for its whole prefix at full input price: switching on `output_config.format` invalidates any prompt cache for the conversation and adds an injected system prompt describing the format ([structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)), on top of `tool_choice`'s effect on the message cache ([prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)). The Z reserve in the sizing rule covers the injected prompt. It is still valid under preserved thinking, because `output_config` and `tool_choice` are top-level parameters outside `system`, `tools` and `messages`, which the preserved-thinking rules leave valid. Structured outputs and strict tools reject schemas that use `minLength`, `maxLength`, numeric bounds or `additionalProperties` other than false with a 400, so the wire schema carries none of them (H1 confirms the Effect provider strips them) and the caps are enforced by parsing the response with zod: a response that fails is returned to the agent with zod's error, at most twice, before the ledger backstop. Only if that generation itself fails (an API error after retries, or output that fails the schema twice) does code build the stage's output from the ledger and record the gap; that is the backstop, not the plan.

### 3.5 Retries and recovery (2.6)

| Failure | Recovery | Bound |
| --- | --- | --- |
| Rate limit, overload, 5xx, network | Exponential backoff with jitter, honouring `retry-after`, inside the activity (no `Activity.retry` schedule exists) | 4 attempts per call |
| Context overflow (should not occur below the ceiling) | Answer the pending tool call with "not returned: context full", then the final generation (10.11) | Once; no trimming |
| `stop_reason: max_tokens` | Continue once with "finish your submission" | 1 |
| `stop_reason: refusal` | Record the category; continue the stage without that call's output | 0 retries |
| Codex error as assistant text with `end_turn` (spike finding 2) | Detect by pattern and treat as a failed call | As rate limits |
| Schema-invalid submission | Return the zod error to the agent | 2, then build from the ledger |
| Tool failure (Graph stall, git error) | Per-call timeout; return the error to the agent as data | 2 per tool call |
| Integrity failure in Records | Stop the run (0005) | — |

Every attempt is recorded with its usage and cause, as the computation store already does for every attempt.

### 3.6 Isolation (2.16) and bounded CPU (6.10)

Each agent sees only its task's inputs. Investigate never sees dispositions; Dispose never sees sibling units' verdicts, the lane, or the Briefed and Explained content written in the same context as the lane assessment (section 9). Harness agents have no filesystem: their tools read git objects. On the ACP route, Codex runs in its own empty folder outside the repository (never the run folder that holds working copies), with an isolated Codex home and `HOME` the user has signed in to themselves (10.5: Neuve never copies or places credential files), an environment built from an allowlist (the labelling track's five variables), and only Neuve's read-only MCP tools. Because `codex-acp` lacks a true read-only mode (0003 risk 2), the ACP route stays runnable for tests but is not used for review roles until it has one (2.12). Subprocesses run at nice 10; git runs with `-c grep.threads=2`; at most one Graph process and one encoder at a time, the encoder with 4 threads (the benchmark's settings in [`encoder.ts`](../../packages/evaluation/src/retrieval-bench/encoder.ts), lines 21–22).

### 3.7 Vents (2.15, 8.8, 8.16, 8.17)

Every agent context gets the optional `vent` tool, never required. The harness issues one reconciliation ID per review cycle. Each fan-out stage is one actor for the run, so the one-vent limit applies per stage, not per unit: 30 Dispose contexts do not produce 30 vents. Vent text never enters any review context.

### 3.8 Telemetry from the start (10.16)

**Ruled (10.16).** Telemetry captures cost, product metrics, engineering metrics and logs from the first run, as a general rule.

**What is recorded.**

| Level | Records |
| --- | --- |
| Each model call | Route, model, effort, `max_tokens`, stage, agent, turn; input, 5-minute and 1-hour cache writes, cache reads, output, and thinking tokens (read from the raw usage, since the spike found the Effect provider drops them); request start, first byte and end; stop reason; retries and error class; cost |
| Each tool call | Tool, a hash of its arguments (never their content), result tokens, latency, whether it paged or found nothing, errors |
| Each agent context | Turns used against its limit, whether the turn limit, the ceiling or the run's timeout ended it, whether the final generation ran, ledger entries recorded, vent sent (yes or no), tokens and cost |
| Each stage | Wall time against its expected time (section 2.5), inputs estimated against measured (the UN9 calibration), gaps disclosed, fallbacks used |
| Each run | The receipt (PU6): route, key variable and organisation if named; total cost and wall time; queue wait from enqueue to start; partitions, batches and units; whether the run timed out and what it published (XC30) |

**Product metrics from day one**, projected from Records events: the lane distribution per batch and run; gaps disclosed by kind; agent dispositions by verdict and lane, and suggested reviews written; time and cost per batch; and the reviewer's-tax measures that are computable before people judge context: context references per unit, references shared across units, the share of hunks whose coverage line is "nothing found" (a missing-attribution proxy), and look-alikes recorded (wrong-attribution candidates); and requests for changes recorded uncited, by lane, since on agentic and human-suggested units they close the unit and send work back (section 9.2); units with evidence of high complexity but a validation gap that went to human-suggested (10.55); agent approvals given with proof not recorded, by lane (DI10); and findings about tests and proof, split into forged or bogus evidence and test-bloat warnings (DI9). Wrong and missing attribution proper need human judgements of context, which the desk records from M5 (9.51). **Engineering metrics:** latency per call, turn and stage; cache-hit ratio (cache reads over all input); retries by class; final-generation and deadline-hit rates; estimate against measured context; tool latency; queue wait; worker CPU time and memory per job.

**How it is exported.** Effect tracing gives every run a span tree, run, stage, agent, turn, then model call or tool call; `effect/ai`'s `Telemetry` adds the GenAI semantic-convention attributes (`gen_ai.system`, request model, token usage) to model-call spans (installed `node_modules/effect/dist/ai/Telemetry.d.ts`). Effect 4.0.0 also ships an OTLP exporter for traces, metrics and logs (`node_modules/effect/dist/observability/`: `OtlpTracer`, `OtlpMetrics`, `OtlpLogger`), used only when the user names an endpoint in user-level Neuve configuration (outside any repository); the OTLP layer is built from those explicit options, never from the constructor that reads its settings (`otlpEnv`) from Effect's `Config`, never from `OTEL_EXPORTER_OTLP_ENDPOINT` or other environment variables, which a repository's `.env` could set in development (section 2.1); it is off by default. Trace-context headers to the provider are turned off on the HTTP client, which the spike found Effect sends by default. Logs go through Effect's logger as structured lines to the worker's existing `.git/neuve/worker.log`, carrying span IDs; prompt bodies, tool content and credentials never enter spans or logs.

**Where it lives.** Durable telemetry is Records data: per-call usage, timing and cost on the computation store's attempt rows (which already keep usage per attempt); `stage.completed@1`, `gap.disclosed@1` and `run.completed@1` (the receipt) as events; product metrics as projections, shown by `neuve review stats`. OTLP, when enabled, is a copy for the user's own tools, never the source of truth.

**Cost.** Usage times a price table frozen into the run's configuration with the route (0008): for Opus 5.5, 4 USD per million input tokens and 20 per million output, cache writes at 1.25 times input for 5 minutes and 2 times for 1 hour, cache reads at 0.05 times ([models overview](https://platform.claude.com/docs/en/about-claude/models/overview), [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)). Costs come from the owner's local keys for now (10.16, section 2.1).

### 3.9 Guide, don't impose (10.23)

**Ruled (10.23).** Guidelines and repository declarations inform the agents' judgement rather than restricting it; Neuve relies on the model's intelligence once the framing and reasoning are right, and keeps hard rules for safety and integrity. A sweep of the proposal:

| Item | Before | Now | Why |
| --- | --- | --- | --- |
| Generated, test and doc files (PC4, PC7) | Declarations decided | Declarations suggest; Understand judges with a reason; allowances recomputed from its judgement | 10.23 itself |
| `search` `kinds` filter (IN7) | Filtered by declared kind | Orders declared kinds first and never excludes undeclared results | Guidance |
| Unit proximity (AS1) | Fixed 20-line, 400-line and same-file rules | Code proposes defaults; Assemble may merge or split within a file for proximity or readability only, with a reason | Guidance on proximity. **Hard:** no regrouping units by behaviour (4.1) and every changed line has exactly one owner (integrity) |
| Request for changes without a cited defect (DI) | Refused | Returned once with the reason, then recorded as decided, marked uncited | Guidance |
| Pattern notes (9.10) | Never a request for changes | A comment unless the shared rule is violated, which the agent judges | Guidance, as 9.10 says |
| Verdict words in Facts, Briefed and Explained; lane words in Facts | Refused | Guided against in the prompt, flagged for measurement | Guidance |
| Dispose's view (DI6) | No lane, assessment, digest, Briefed or Explained | Unchanged as a harness rule; lane words in Facts guided against and flagged | The proposal's own design, motivated by 9.38's anchoring lesson; ruling 10.6 does not establish lane-blindness, so this is for the owner to accept, not an integrity rule |
| Coverage line per hunk (Investigate) | Submission refused without it | Missing line recorded as "not stated", a disclosed gap | Guidance |
| Allowance (IN3) | Code trimmed | The agent chooses within it; code trims only the excess | **Hard** at the bound: the package's limit (10.2) |
| Specific-identifier cutoff (IN8) | Decided which identifiers exist for lookups | Decides only what metadata lists; the agent may look up any identifier | Guidance |
| Lookup loop (IN9) | Stated loop | Stated as guidance the agent may vary | Guidance |
| Movement direction (AS4) | Default toward the human end | Unchanged, as guidance the agent weighs | Guidance |
| Partition sizes (UN5, UN6) | Caps | Caps unchanged; Understand may name areas to keep together, which packing honours within the caps | **Hard** caps: the closed sums of 10.18. Packing order is guidance |
| Every hunk in exactly one behaviour; obligations cite their basis | Checked | Unchanged | **Hard:** integrity of ownership and provenance |
| Proxied tools: read-only allowlist; lossy schemas refused; only listed variables expand; repository `.mcp.json` never read | Hard | Unchanged | **Hard:** safety (no writes to external systems, no credential exfiltration) and integrity (8.11) |
| Additions to the scope snapshot (PC11) | At most 10 per run | Unchanged | **Hard:** a bounded snapshot per cycle (3.12) and the time limit (10.15) |
| Masking (10.24) | Hard | Unchanged | **Hard:** privacy of captures, as ruled |
| Agent never approves human-required work; quadrant-to-lane mapping; gaps, static automation and history | Hard | Unchanged | **Hard:** rulings 4.5, 4.2, 10.9, 10.4 and 10.3 |
| Tool-result cap, turn limits, the run's 10-minute lifetime | Hard | Unchanged | **Hard:** 10.18, 10.41 (with 10.7's Assemble and Dispose limits) and 10.26 budgets |
| Understand has no search tool (UN2) | Tool set | Unchanged | A stage-design choice, not a limit on judgement: reads stay available |

**Ruled (10.77).** XC9–XC17 are accepted as recommended below.

| # | Decision | Recommendation |
| --- | --- | --- |
| XC9 | Tool rules | Zod schemas, read-only reads at OIDs, handles plus excerpts, explicit empty results, one toolkit for both routes |
| XC10 | Evidence ledger fields | As tabled; the ledger is the durable output of Investigate and the source of context references |
| XC11 | Context-growth control | None beyond sizing: append-only messages, tool results capped before their first send, turn limits sized to the ceiling. This already follows from 10.12 and 10.18; it is listed only so the owner can close it |
| XC12 | Prompt layout and caching | Tools, system, shared range block, context inputs, task last; two explicit breakpoints; data wrapped in tagged blocks; reminders appended |
| XC13 | Concise output and examples | Capped fields, optional sections, cite don't quote; rules only for what code cannot enforce, examples for judgement |
| XC14 | Stopping | Strict submit tool from the first request for normal completion; continuations at most three; 85% reminder; at the turn limit or the ceiling one final generation with `tool_choice: none` and the stage schema as structured output (10.11); the ledger fallback only if that generation fails. 10.11 rules the final generation; what is open is the normal path (strict submit tool, continuations, reminder) and the backstop |
| XC15 | Retry policy | As tabled |
| XC16 | Isolation and CPU | Inputs scoped per context; no filesystem for harness agents; ACP in its own empty folder with an allowlisted environment and a Codex home the user signed in to, not used for review roles in M3; nice 10, git 2 threads, one Graph and one encoder. Reads are already limited to tracked work (10.34). 10.64 rules how a per-unit review runs on Codex (one session per unit); this row keeps that route off review roles until `codex-acp` has a true read-only mode, after which 10.64's shape applies |
| XC17 | Vent actors | One reconciliation ID per cycle; one actor per stage per run for fan-out stages |

Ruled and no longer open here: XC24–XC26 (10.32, telemetry as tabled), XC27 (10.33, the guide-not-impose sweep, including lane-blind Dispose), XC29 (10.34, the release binary without `.env` and `bunfig.toml` autoloading).

## 4. The semantic retriever M3 uses before M4 decides

**Ruled (10.10).** Retrieval stays hybrid: the semantic layer does not answer structural lookups. It points to where more context can be found, through each retrieved chunk's metadata and the provenance on the graph. Structural lookups are procedural or deterministic, and agentic. There is no Graph structural tool in M3. Section 7 designs the metadata, the procedural lookups and how Investigate combines them; this section only chooses the semantic lead source.

**Ruled (10.77, with 10.25).** Investigate's semantic lead source while the benchmark's dev results are pending is the recommendation below: a retriever port with BM25 by default and M4's winner as a setting.

**Facts.** The benchmark compares Graph (fork and Entire baseline), BM25, five dense models, fusions and a reranker through one interface ([`retriever.ts`](../../packages/evaluation/src/retrieval-bench/retriever.ts)). Its winner rule keeps the simpler arm when results are inconclusive (9.21). On the earlier smoke set Qwen3-Embedding-0.6B led and untuned fusion lost to dense alone ([M4 proposal](m4-benchmark.md#starting-evidence)). Graph has open faults (Starting facts). Retrieval is semantic first, then scope, then agentic (3.6, 3.7).

| | A. BM25 over the shared chunker | B. Graph through graph-client | C. One dense model (Qwen3-Embedding-0.6B) | D. A port with A as default, others pluggable |
| --- | --- | --- | --- | --- |
| Cost | No model; one index per base tree | Graph build per revision; known stalls | Local encoder, bounded threads | As A, plus the port |
| Provenance for citation (3.4) | Path, lines, blob at revision | Yes, with the open faults | Path, lines, blob | Per arm |
| Risk of building on a loser | Low: it is a control arm | Medium: the fork may be reset | Medium | Low |
| Matches 3.1 (graph is semantic, structure is separate) | Yes | Mixes the two | Yes | Yes |

**Recommendation: D, defaulting to BM25, with agentic read and grep tools carrying the refinement.** The port is the benchmark's region list (without its path-derived `kind`, which stays a benchmark rule; kinds come only from PC7's declarations) plus the provenance fields of the ledger, so M4's winner drops in as configuration and enters the computation key. Braintrust's comparison found agentic search matched vector retrieval's accuracy on about twenty bug-fix tasks at a quarter of the cost, while warning against a universal winner (agentic search notes, kept in the private archive).

**Risks.** BM25 misses paraphrased context, which the agent must recover with more turns; the M4 agentic-stage scoring (section 11) will show how much. Hub chunks (manifests, lockfiles, central documents) rank high for many hunks; the port deduplicates by signal, never by file name (9.31; [hub signals](../../research/hub-signals.md)).

**Ruled (10.77).**

| # | Decision | Recommendation |
| --- | --- | --- |
| XC18 | Retriever before M4 | A retriever port shaped like the benchmark's interface; BM25 by default; M4's winner swaps in as configuration and enters the computation key. 10.25 already rules the BM25 start behind the port; what is open is the port's shape and how M4's winner replaces BM25 |

## 5. Phase 1: Precompute (and the scope fetch at cycle start)

### 5.1 What it is for

Precompute does the deterministic work once, when commits land, so the review-time pipeline starts from stable, cached facts. It serves **never recompute** (5.4, 8.10), **precompute at commit time** (2.10) and the **reviewer's tax** dimension of repetition: the same hunk is never re-parsed or re-indexed. The reader never sees Precompute directly, but every owned range, every L0 anchor in the context margin and every lane rationale that cites "touches 7 files in 3 directories" rests on it. It also fetches the cycle's scope sources, because 3.12 requires a fresh, dated snapshot at the start of each cycle.

### 5.2 What it is built on (all code, 2.3)

| Work | When | Key | Built on |
| --- | --- | --- | --- |
| Hunks of each commit, with changed-line counts and old and new sides | `commit.prepare` job | Commit OID | The kept backend rules (`decision-ranges.ts`, `submitted-hunks.ts`), moved where the harness can import them |
| Enclosing symbol or section per hunk | `commit.prepare` | Blob OID | The benchmark's shared chunker: symbol chunks where a declared capability parses the file, headings for Markdown, line windows otherwise ([`chunk.ts`](../../packages/evaluation/src/retrieval-bench/chunk.ts), lines 21–55) |
| BM25 index of the base tree | First review of a base | Tree OID | The benchmark's BM25 (k1 1.2, b 0.75), without the benchmark's exclusion rules (below) |
| Graph snapshot | Optional, only if Graph is enabled as a semantic lead source (XC18) | Tree OID, profile | graph-client `prepareGraphSnapshot` |
| Embeddings | After M4 | Blob OID, model | semantic-client |
| Range manifest: merge base, range diff hunks, review lines, per-hunk allowance, per-hunk query text (the benchmark's Q1 recipe: path, enclosing symbol, the hunk with three context lines) | At the review request | Base, head and merge-base OIDs | The above |
| Change facts per hunk and file: changed lines, files and directories touched, whether a hunk only deletes, whether a file is new or renamed or binary, and whether the repository declares the file as a test or documentation (below) | At the review request | Range key | Git |
| Scope fetch | At the start of each cycle | Each source's content hash (text kept as a masked raw capture, 10.8) | The integration client (PC9) for tickets; markdown plans read from git at the base OID; commit and PR text |

The range diff is not the union of commit diffs, so per-commit hunks serve indexing and identity, and the range manifest is computed once per range at request time. That is cheap (git plus counting) and cached by OIDs.

**What the product index excludes.** The benchmark's views drop files by name: `pathExclusion` in [`views.ts`](../../packages/evaluation/src/retrieval-bench/views.ts), lines 125–135, removes lockfiles and generated paths through `classifyPath`'s regexes in `policy.ts`, and benchmark paths through `isBenchmarkPath`; its content rule also drops files with a generated-file marker. Those are benchmark rules only. The product index keeps only safety bounds: non-blobs and submodule links, symlinks, binary content and files over the size limit. Generated, test and doc files are indexed like any other; whether they matter is left to the repository's declarations and Understand's judgement (10.23, and the generated-file paragraph below), and a generated-file marker becomes a suggestion Understand sees, not an exclusion.

**Generated files in the denominator (9.27).** The benchmark detects generated files and lockfiles by path or content marker with extension lists, which a product rule may not use (9.31, constitution). Proposal: a file counts as generated when the repository declares it so (`.gitattributes` `linguist-generated` or `-diff`), or its first lines carry a generated-file marker, and lockfiles are recognised from what the package manager declares (the workspace manifest names its lockfile), never from a name list. These declarations are suggestions (10.23): Understand sees them and may mark a file as generated, or as not generated, with a reason; its judgement then sets the review-lines denominator and the allowances are recomputed before Investigate starts. Unverified: whether every package manager declares its lockfile in a readable way.

**Tests and documentation without name lists.** Code may not decide that a file is a test or a document from its name or extension (constitution). Proposal: a file is a test or documentation only when the repository itself declares it so, for example through the test globs its own test-runner configuration names or the source paths its documentation tool is configured with; everything else is "undeclared". Reading those configurations is tool-specific parsing, so each reader sits behind a declared capability (a provider that states which tool's configuration it reads), as the constitution requires for language-specific analysis; a repository whose tools no provider declares gets no such facts. Under 10.23 these declarations suggest and Understand judges: its hunk roles (`test`, `doc`, section 6) may agree with a declaration, differ from it with a reason, or cover files nothing declares, cited per hunk. Gap: repositories without such configuration get no code-declared test or doc facts, and whether common test runners expose their globs in a readable form is unverified. The benchmark chunker's Markdown heading rule is also picked by file type, so reusing it in the product needs the same treatment (a declared capability, not an extension).

**Scope fetch (10.5, 10.8).** Sources in order: the ticket named by the branch, commit text or plan (through a configured integration, PC9–PC11), the markdown plan at the base OID, decisions and docs in the repository, and commit or PR text as weak scope (9.13). Each fetched item gets a fetch time and a stratum (plan or ticket at base, plan only inside the range, commit or PR text, nothing; 9.13). The fetch goes through a user-configured integration, never a credential Neuve holds (10.5; the integration design follows). The fetch activity stores a section index and content hashes. The fetched text is kept twice: unmasked in the run folder for the run's life, which agents read through `scope_section`, and as a masked raw-capture blob (30 days, 8.10) referenced by hash, so the workflow database never holds a ticket and retention applies to it.

**Integrations: user-configured MCP servers or SDKs, proxied as ephemeral tools (10.5).** The owner confirmed that "no credentials" means Neuve's own: providers' and scope sources' credentials are the user's environment, as MCP servers handle theirs, and integrations such as Linear are reached through MCP servers or SDKs that Neuve proxies as ephemeral agent tools. Their design is research and development under those guidelines; this is the proposal for M3.

_What I checked (local clones and docs)._

| Finding | Source | Verified |
| --- | --- | --- |
| Effect ships an MCP **server** (`McpServer`, `McpProtocol`, `McpSchema`) but no MCP client. `McpProtocol` has only a "reverse client" for requests a server sends back (sampling, elicitation); `McpSchema` has the client-side request schemas | Installed `effect` 4.0.0 (`node_modules/effect/dist/ai/`: `McpProtocol`, `McpSchema`, `McpServer` only) and the clone at `~/code/.better-coding-agents/resources/effect` (`6389d9ac64`, 2 October 2026), `packages/effect/src/ai/McpProtocol.ts`, lines 164–176 | Yes, by reading the code |
| The official TypeScript SDK's v2 client, `@modelcontextprotocol/client` (2.3.0 in the clone), connects over Streamable HTTP with an SSE fallback or over stdio (it spawns the command and closes it with stdin, then SIGTERM, then SIGKILL); `listTools` walks pages; a failed `callTool` returns `isError` rather than throwing; responses are cached per the server's hints | `~/code/.better-coding-agents/resources/mcp-typescript-sdk` (`8aabbdc`, 2 October 2026), `docs/clients/connect.md`, `calling.md`, `caching.md` | Yes, by reading the docs; not run |
| For OAuth the SDK's client needs an `OAuthClientProvider`, "the storage ... surface" for tokens and client registrations: whoever runs the client stores the tokens | Same clone, `docs/clients/oauth.md` | Yes, by reading the docs |
| The v1 client (`@modelcontextprotocol/sdk` 1.32.1) worked under Bun in the runtime spike | Spike README, Q3 | Yes, as reported by the spike |
| Claude Code's `.mcp.json` expands `${VAR}` in `command`, `args`, `env`, `url` and `headers`. In the remote `url` and `headers` of every server, it reads a fixed set of names as empty: Claude Code's own and cloud providers' credentials, and a few others such as `NPM_TOKEN`. That keeps a project file or plugin "from sending your Claude Code or cloud provider credentials to a server it names". Ordinary names such as `API_KEY` still expand | [Claude Code MCP docs](https://code.claude.com/docs/en/mcp) | Yes, by reading the docs |
| Zod 4.6.5, the repository's version, has `z.fromJSONSchema`. It throws on an external `$ref`, `not` other than `{ not: {} }`, `if`/`then`/`else`, `unevaluatedItems`/`unevaluatedProperties` and `dependentSchemas`/`dependentRequired`. It enforces `uniqueItems` and the `contains` family through `checkArrayGuards`. It recognises some keys without handling them, such as `$dynamicRef` (kept as metadata). Known `format` values map to zod checks; unknown ones pass as plain strings, which is acceptable because `format` is only an annotation in JSON Schema 2020-12 | Installed `zod` 4.6.5, `v4/classic/from-json-schema.js`, lines 108, 285–300, 361–373, 452–462, 746–751 and 810 | Yes, by reading the installed code; not run |
| Whether Linear's hosted MCP server accepts an API-key header instead of OAuth, and whether `@modelcontextprotocol/client` 2.x is old enough for the 10-day release-age policy | — | No |

_The design._

| Concern | Proposal |
| --- | --- |
| Client | The official SDK's client wrapped in a small Effect service: one connection per run, opened with `acquireRelease` in the run's scope and closed when the run ends, so the tool is ephemeral |
| Where servers are declared | Only a user-level Neuve file (never committed), defining every proxied server in full: its command or URL, the tools allowed, and the **names** of the environment variables it may receive; values are `${VAR}` references resolved from the user's environment at run time and passed only to that server's process or request. The harness never reads the repository's `.mcp.json`, so no commit in a reviewed range can change what the worker starts or contacts |
| Which variables may expand | Exactly the variables the user lists by name for that server in the user-level file. Nothing expands unless the user listed it by name for that entry |
| Authentication | Stdio servers handle their own credentials (from their environment or their own login store), as MCP servers do. HTTP servers only with headers built from the user's variables. Servers that need OAuth would make Neuve the token store, which 10.5 rules out; they are reachable only through a bridge the user runs that keeps its own tokens |
| Proxying | At run start the harness lists the server's tools and exposes only those the user allowed as read-only (the server's `readOnlyHint` is untrusted and not enough on its own). Each server schema (input, and output where the server declares one) is converted to zod with `z.fromJSONSchema`; the agent sees the JSON Schema zod produces from it, and inputs and outputs are parsed with zod, which keeps 8.11 literally and needs no second validator. A tool's schema is lossy when conversion throws (external `$ref`, `not` other than `{ not: {} }`, `if`/`then`/`else`, `unevaluated*`, `dependentSchemas`/`dependentRequired`) or when it uses a recognised but unhandled key such as `$dynamicRef`; a lossy tool is refused and the refusal disclosed on the receipt. Unknown `format` values pass as plain strings, which is acceptable because `format` is an annotation in 2020-12. Results are untrusted data in tagged blocks, capped at r and paged |
| Per-system SDKs | Where no usable MCP server exists, a small adapter over the system's own SDK, reading its key from the user's environment; the same proxy and snapshot rules apply |

_Reconciling with 3.12 (fetch at cycle start, dated excerpts, no silent update)._

| | A. Cycle-start fetch only | B. Cycle-start fetch, then bounded additions during Understand (recommended) | C. Live tools in every stage |
| --- | --- | --- | --- |
| How | Code calls the proxied read tool at cycle start for the tickets named by the branch, commits and plan, and one hop of their links; agents read only that snapshot through `scope_section` | As A; then Understand may call the proxied read tools for further items (at most 10 per run, shared by all Understand partitions), each result joining the same cycle's snapshot with its own fetch time; an item already in the snapshot is served from it, never fetched again, and two partitions asking for the same item at once share one in-flight fetch and one snapshot entry (keyed by source and item, as the computation store shares concurrent attempts); the snapshot freezes when Understand completes, and later stages read only it. A second run in the same cycle (for example a retry after a timeout) reuses the frozen snapshot and makes no new additions; new items wait for the next cycle's fetch | Every stage calls the integration as needed |
| 3.12 | Holds | A reading of 3.12 for the owner: "fetches at the start of every cycle" read as the period that ends when Understand completes; one snapshot per cycle, every excerpt dated, no item updated within a cycle | Breaks: the same ticket could differ between stages |
| Discovery | Only what code can name | The agent can follow a link a ticket mentions | Most |

_When no integration is configured._ Scope comes from what the repository holds: plans and decision documents read at the base OID, then commit and PR text as weak scope (9.13). Ticket keys found in the branch name or commit text are recorded as "named, not fetched: no integration configured", stratum "commit or PR text". The run never stops (1.8), and the batch overview's Guided basis falls back to the scope or a gathered scope, as the desk contract already provides. The inner loop's coding harness may have its own Linear connection; final review never depends on it (2.2).

**Scope text in captures (10.8).** Captures keep scope text, because its rubric (what "done" means, what was decided) is useful for eval datasets; only **clear identifiers** are masked. That applies to the scope blob, to stored model turns whose prompt carried scope (XC2), to `scope_section` tool results, and to model output that quotes scope, at the moment each is captured. Agents always see the scope unmasked, from the run folder's copy of the fetch, which lives for the run and is deleted at Publish; resume needs it (section 1). The packet's attached excerpts are not captures: they keep their citation to the source item and its fetch time (3.12).

Recognising identifiers without per-system hard-coding:

| | A. Learn from what the fetch returned (recommended) | B. A pattern list per source system | C. A model pass that finds identifiers |
| --- | --- | --- | --- |
| Rule | Mask every value the source's own response marks as an identifier: the item's ID or key, its URL, and the people fields (assignee, author, creator) with their emails. Then mask other occurrences of the same shapes in the text: a key's shape is learned from the keys actually fetched and keeps its literal prefix (fetching `NEU-13` yields `NEU-<digits>`, never `<letters>-<digits>`, so `UTF-8` or `SHA-256` is never masked), URLs on the source's host, and email addresses by the standard address form | Hand-written key patterns for Linear, Jira and the like | An agent marks identifiers |
| Hard-coding | None per system; one generic rule for each field the response declares | Per system | None, but nondeterministic |
| Misses | Keys of a shape never fetched in this run; names that appear only in prose | Systems without a pattern | Varies |

Masks are stable within a capture (`[ticket-1]`, `[person-2]`), so a dataset built later keeps references consistent. What counts as a people field depends on each source's response schema; the fetcher for each source declares which of its fields are identifiers, which is a declared capability, not a pattern list.

### 5.3 Options

**When to compute.**

| | A. Everything at review time | B. Per commit, tree and blob in the background; per range at request time | C. Eagerly per branch against a guessed base |
| --- | --- | --- | --- |
| Review-time latency | Highest | Low | Lowest |
| Wasted work | None | Little: trees and blobs recur | High: the base is unknown until review |
| Bounded CPU (6.10) | Bursty at review time | Progressive, as commits land (3.9) | Bursty per push |

**Ruled (10.20): B.** `commit.prepare` gets its handler in M3: hunks and enclosing symbols per commit at nice 10, one job at a time. Indexes per tree are built at the first review of a base and reused. Graph snapshots and embeddings stay off by default until XC18 and M4 say otherwise.

**Change facts as facts, not scores.** Kamei and colleagues' just-in-time defect prediction used change-level measures such as size, diffusion across files and directories, history and developer experience, and reported finding 35% of defect-inducing changes with 20% of the inspection effort ([Kamei et al., TSE 2013](https://sail.cs.queensu.ca/data/pdfs/TSE_ALarge-ScaleEmpiricalStudyOfJust-in-TimeQualityAssurance.pdf); abstract only). That supports computing size and diffusion in code and handing them to the lane assessment as citable facts. It does not support turning them into a risk score: foundation 06 leaves weights unset, and the legacy routing that gated on broad classes was rejected ([escalation foundation](../../foundations/06-escalation-and-decomposition.md#historical-snapshot-not-design-guidance)).

### 5.4 Risks

- The chunker's symbol capability covers only some languages; elsewhere it falls back to line windows, so enclosing-symbol facts are uneven across languages. That is observation data, disclosed per hunk, never a reason to treat languages differently (constitution).
- A stalled Graph snapshot must not hold the run: it runs only when enabled, with a deadline, and its absence is a disclosed gap.
- Linear's API and credentials are new surface; a failed fetch leaves weaker scope, recorded per 9.13's strata.

### 5.5 Parallels

| Source | What it did | Fit for Neuve |
| --- | --- | --- |
| Entire Graph | Committed caches keyed by tree, profile and limits; no per-edit incremental invalidation; working-tree reads bypass caches ([Entire research](../../research/03-entire-and-code-context.md#precomputation-is-not-continuous-incremental-indexing)) | Key by tree and blob, never by working tree; Neuve reviews commits only |
| Entire CLI | Hooks record events fast; heavy work runs later (sessions and checkpoints (`docs/architecture/sessions-and-checkpoints.md` in `entireio/cli`)) | Already Neuve's capture model (0002); `commit.prepare` is the heavy half |
| ClusterChanges (Microsoft) | Partitions a changeset's diff regions by def-use relationships; secondary summaries report that over 40% of changes submitted for review at Microsoft could be split ([Barnett et al., ICSE 2015](https://www.microsoft.com/en-us/research/publication/helping-developers-help-themselves-automatic-decomposition-of-code-review-changesets/); abstract and secondary summaries only) | Enclosing symbols and shared identifiers computed here feed batch candidates in Understand |
| Unblocked | Schema discovery and identity resolution in plain code, a model only as tiebreaker (Unblocked notes, kept in the private archive) | Ticket linking from branch and commit text is code first, Understand confirms |

### 5.6 Decisions (Precompute)

**Ruled.** PC5 (10.76), PC13, PC15 and PC16 (10.75), PC14 (10.74), as recommended below.

| # | Decision | Recommendation |
| --- | --- | --- |
| PC5 | Scope sources and strata | At cycle start: tickets through a configured integration, the plan at the base OID, repository docs, commit and PR text; fetch time and 9.13 stratum recorded per source; a missing source is a gap. 10.53 rules the fetch at cycle start and 10.54 the order without an integration; what is open is recording the stratum and fetch time per source |
| PC13 | Commit-time precomputation (10.15, 10.20) | At each commit: hunks with enclosing symbols, the BM25 and identifier index updated for changed blobs, per-hunk queries and top leads against the parent tree, change facts; the range manifest kept current as commits land. At the request, a cached lead is reused only if its hunk's text matches the range's hunk and its blob at that path is unchanged in the range's base tree; otherwise it is dropped and the hunk's query re-run against the base index |
| PC14 | Scope snapshot at the inner loop's cycle start | The scope fetch runs when the cycle opens for the inner loop, as 3.12 already places it, so the snapshot is ready before the review request; a Neuve skill opens the cycle at planning. 10.53 rules the fetch at cycle start; what is open is when the inner loop's cycle starts. This proposal does not design that skill |
| PC15 | Bursts | `commit.prepare` coalesces by tree and blob, in the background slot, newest head first, at nice 10, no new heavy subprocess during a review; the background slot is ruled (10.31) |
| PC16 | Model work at commit time | Not in M3: a per-commit draft change map would spend tokens on every inner-loop commit; measure first |

Ruled and no longer open here: PC9 (10.51), PC10 (10.52), PC11 (10.53), PC12 (10.54); PC1 (10.20), PC2 (10.21), PC3 (10.22), PC4 and PC7 (10.23: declarations suggest, Understand judges), PC6 (10.24), PC8 (10.25).

## 6. Phase 2: Understand

### 6.1 What it is for

Understand builds the shared understanding every later stage depends on: what the range changes, against which scope, and which parts belong together. It restates the change in its own words, groups hunks by **behaviour or obligation** into candidate batches (4.1, 4.10) that code then partitions by estimated context need (10.1), extracts the obligations that decide correctness (the ticket's "Done when" items, else its scope, else a gathered scope), and names the questions Investigate must answer. It is multi-turn, never one-shot and never a gate (2.4, 0005).

It serves the **single area of focus** per review (4.10), **scope is part of context** (9.6, 9.13) and the reviewer's tax dimension of **finding and reconstructing context**: Bacchelli and Bird found that understanding the change is reviewers' main challenge and that tools mostly fail to support it ([ICSE 2013](https://www.microsoft.com/en-us/research/publication/expectations-outcomes-and-challenges-of-modern-code-review/); abstract and secondary summaries only).

The reader gets, through later stages: each batch's title and focus on the batch overview, the behaviour label on each unit, the source line of the Guided stop (ticket, scope or gathered, and whether the change is unlinked), and the seed of the batch digest.

### 6.2 What it is built on

| Code | Agent reasoning |
| --- | --- |
| Lays out the range manifest: a hunk index (ID, path, lines, changed lines, enclosing symbol, commit), commit texts, scope sections with IDs, fetch times and strata | Reads hunks and scope, restates the change, assigns each hunk to a behaviour with a role, maps obligations to hunks, writes questions |
| Extracts checklist items under "Done when" or acceptance headings from fetched scope, as candidate obligations | Confirms, merges or rejects them; adds obligations the scope implies; marks gathered ones |
| Checks the change map: every hunk in exactly one behaviour; every obligation cites a scope section or is marked gathered; titles within length | — |
| Estimates each candidate batch's context need and partitions it for Investigate (10.1, section 6.4) | — |
| Falls back if the stage fails: one behaviour per commit (or one for the range), obligations from commit text as weak scope, no questions, a disclosed gap; partitioning still runs on the fallback batches | — |

Tools: `hunk(id)` with the diff and its enclosing symbol, `read(path@rev, lines)`, `commit(oid)` for commit texts beyond the inlined bound, `scope_section(id)`, `submit_change_map`, `vent`. No search: discovering surrounding context is Investigate's job, and keeping it out keeps the stages' outputs distinct. Built on `effect/ai` `Chat` with the hand-written loop, one `Workflow` activity, the computation store, and the scope fetch.

### 6.3 How the prompt is framed

- **Role.** "You prepare the final review of a commit range. You are not reviewing it yet. Your job is to say what it changes and what it was meant to do."
- **Inputs and layout.** Section 3.3's order: tools, system, then the hunk index (up to 245,000 tokens) and commit texts (up to 10,000, longer ones through `commit(oid)`), then the scope block (sections tagged with ID, source, fetch time and stratum, up to 40,000, the rest through `scope_section`), then the task. Past those bounds the range is partitioned for Understand (UN8).
- **Output schema (zod).** `behaviours[]` (ID, title up to 80 characters, focus up to 300, hunk IDs, scope section IDs, `obligations[]` with text, basis `done-when | scope | gathered` and scope section ID), `hunkRoles[]` (hunk ID, behaviour ID, role `core | supporting | mechanical | test | doc`, note up to 120), `questions[]` (hunk IDs, question up to 200), `scopeGaps[]`, `unlinked` (no ticket, doc, decision or earlier review links to the change, as the Guided contract requires).
- **Stopping.** Done when every hunk has a behaviour and a role, every obligation is mapped to hunks or marked unmapped, and the questions are the ones Investigate cannot skip. The turn budget (35, 10.41) appears on every tool result; small ranges should need far fewer.
- **Concise.** One-line notes; restate once, in the focus field.
- **Examples.** One worked example of a range split into two behaviours with a mechanical third (for instance the Storybook batch "Revoked share links stop working immediately" beside its formatting changes), and one counterexample of splitting by file instead of behaviour.
- **Vent.** Available; one per stage.
- **When the stage fails.** The change map is built from whatever the agent submitted or recorded, filled by the fallback above. Investigate starts regardless.

### 6.4 Options

**Ruled (10.1, C1).** Understand proposes candidate batches, Investigate runs per partition, and Assemble confirms or re-splits; reviewer-facing batches stay by behaviour or obligation (4.1, 4.10). Batches are also how the harness partitions a large diff, so no Understand or Investigate agent's context is overwhelmed. Herzig and Zeller's finding that up to 15% of bug-fix commits are tangled ([MSR 2013](https://www.st.cs.uni-saarland.de/publications/files/herzig-msr-2013.pdf); abstract only) is why behaviours, not commits, decide candidate batches. What follows designs the partitioning the ruling asks for.

**The estimate (10.1).** For a partition P of a candidate batch, made of whole proximity units (AS1's rule, which is deterministic, so Precompute can apply it before Assemble confirms units):

| Term | Meaning | Starting value |
| --- | --- | --- |
| D(u) | Tokens of unit u's diff as the agent sees it (owned hunks with three context lines) | Estimated (UN9) |
| A | Fixed cost per code area (a directory with changed files): the changed files' outlines and the area's surrounding conventions | 2,000 per area |
| γ | Context-gathering allowance per unit: the least surrounding context each unit must be able to receive, the 9.23 floor | 4,000 per unit |
| F, T, r, o | Fixed prompt, turn ceiling (10.41), tool-result cap and per-turn output, from the sizing rule (section 2.2) | 20,000; 35; 3,000; 2,000 |
| τ | Turns an Investigate agent uses per unit, a rate that does not depend on partition size (10.35) | Starts at 16 ÷ 12 ≈ 1.33; then, from receipts, the larger of the median turns per unit over the last 20 Investigate agents that submitted before their limit, and γ ÷ g, where g is the median gathered tokens per turn |
| T_plan | The turns an agent plans to use: section 2.5's expected Investigate time divided by the measured time per turn, never above the ruled 35 (10.41) | 16 at 8 s |

P fits one Investigate agent when both hold:

- **Diff load:** `Σ D(u) + A × areas(P) ≤ C − (F + Z) − T × (r + o) − (other inputs)`, that is `≤ 500,000 − 30,000 − 175,000 − 56,000 = 239,000` on Opus, where the other inputs are the batch's change-map entry, obligations and questions, cited scope, preloaded leads and sibling index, each bounded in section 2.2;
- **Gathering load:** `units(P) ≤ ⌊T_plan ÷ τ⌋`, that is `⌊16 ÷ 1.33⌋ =` **12 units** with the starting figures, so every unit can receive at least its floor within the turns an agent plans to use.

The two loads use different turn counts on purpose. The diff load protects the context ceiling, so it must close at the ruled ceiling of 35 turns (10.41; 10.18: the turn limits are the only bound), which gives 239,000. The gathering load is about what an agent actually gathers (10.35), measured as a **rate per unit**, not as the turns a partition took. A median of turns per partition would feed on itself: smaller partitions use fewer turns, which would lower the median and shrink the next partitions, drifting toward the fragmentation 10.1 warns against. Turns per unit, and gathered tokens per turn against the 4,000-token floor γ, stay roughly the same whatever the partition size, so the cap `⌊T_plan ÷ τ⌋` moves only when agents really need more or fewer turns per unit. Agents that reached their turn limit are left out of the median, because their per-unit figure is truncated. The 35 remains the ceiling (10.41).

**The partition count.** For a candidate batch B, `n = max(⌈(Σ D + A × areas) ÷ 239,000⌉, ⌈units(B) ÷ ⌊T_plan ÷ τ⌋⌉)`, the smallest count that could fit: for the 30-unit example, `max(1, ⌈30 ÷ 12⌉) = 3` partitions, which run in parallel on 3 of the run's 8 slots (section 2.5's expectation). Code then packs B's code areas into n partitions, largest first, keeping each area whole and each file whole where possible; if the packing does not fit, it tries n + 1. Smallest n and whole areas are what "without splitting and fragmenting context more than necessary" means in practice. With 35 turns (10.41) the diff load allows 239,000 tokens per partition, up from 64,000: of the 57 corpus ranges, 8 have whole-range diffs over 64,000 estimated tokens but only 2 over 239,000 (bytes ÷ 3 × 1.3 on `git diff -U3`), so the diff load now almost never splits a partition. The gathering load decides: batches above 12 units get more, smaller partitions, which suits 8 calls in flight; up to 8 partitions run at once, and more wait for slots inside Investigate's window, at fewer turns each.

**Partitions and reviewer-facing batches.**

| | A. Partitions nested in batches (recommended) | B. Partitions may also merge small batches | C. Partitions independent of batches |
| --- | --- | --- | --- |
| Rule | Each partition belongs to exactly one candidate batch; only an oversize batch has several | As A, and two small candidate batches may share one agent when both fit together | Pack the whole range by code area, then draw batches across partitions |
| Investigate's focus | One behaviour per agent | Two behaviours in one agent | Mixed |
| Prefix cost | One per partition | Fewer agents | Fewest |
| What the reviewer sees | Batches by behaviour, unchanged | Same | Same, but context was gathered without the behaviour in view |

Under A, the agents of one batch's partitions share its change-map entry and obligations, see the other partitions' hunk index (never their bodies) so they can mark same-batch context, and share the run's search cache, so the same query is never run twice (5.4). The reviewer never sees partitions: Assemble works per batch.

**A behaviour too big for one agent.** Split in order of increasing fragmentation: by code area; then, for one area too big, by file; then, for one file too big, by its units in file order. Units are never split (AS1 caps them at 400 changed lines, a few thousand tokens). The partitions of one behaviour stay one candidate batch.

**A range too big for one Understand agent.** Understand's own inputs are the hunk index (about 40 tokens per hunk) and the scope; past 245,000 tokens of hunk index (about 6,100 hunks; the largest corpus range has 886), code first packs the range by code area into Understand partitions with the same rule, each Understand agent proposes behaviours for its areas, and code merges behaviours across Understand partitions that cite the same scope section or obligation. Behaviours it cannot match stay separate, with the split disclosed. Each Understand partition is one agent with 35 turns (10.41's "35 turns per agent"). Ranges this large are rare; small ranges never trigger it.

**When Understand is partitioned and scope is weak.** Code merges behaviours across Understand partitions only when they cite the same scope section or obligation. With weak scope (commit text only, 9.13) there is little to match on, so a behaviour that spans several code areas stays split by area, and the reviewer sees batches split by area. That pulls against 10.1's "review batches still have to make sense to the reviewer".

| | A. Code merge only | B. An agent merge pass over the partition outputs (recommended) | C. Fewer, larger Understand partitions with paged hunk reads |
| --- | --- | --- | --- |
| How | Merge on shared scope sections or obligations; disclose the rest | One small agent reads every Understand partition's behaviour list (title, focus, obligations, code areas, about 300 tokens each, never diffs), proposes merges with reasons, and code checks that each hunk stays in exactly one behaviour | Raise the hunk-index bound by paging it through `hunks(page)` so one Understand agent covers more of the range |
| Reviewer sees | Area-shaped batches when scope is weak | Behaviour batches in most cases | Behaviour batches, at the cost of thinner reading per hunk |
| Cost | None | One small context; its turn limit needs a ruling (10.7 does not cover it) | Uses Understand's turns for paging |

**Obligations.** A: the agent extracts all obligations; B: code extracts checklist items and the agent confirms and completes (recommended, because code-extracted items keep their exact source text, which Guided cites); C: code only.

**Search in Understand.** A: none (recommended); B: a small search budget for orientation. B blurs the line between Understand and Investigate and doubles retrieval cost for little gain on small ranges.

### 6.5 Risks

- A plausible but wrong behaviour split propagates through every later stage. Mitigation: Assemble may re-split with a reason (section 8), and the split is one of the things the owner judges in section 11.
- Invented obligations look like scope. Mitigation: every obligation cites a section or is marked gathered, and Guided shows the basis.
- Anchoring: Investigate inherits Understand's framing through its questions. Mitigation: Investigate may add its own questions and must cover every hunk, not only those with questions.

### 6.6 Parallels

| Source | What it did | Fit |
| --- | --- | --- |
| pstack, "in your own words" | Ask the agent to restate the problem before acting, which compresses noise and exposes misunderstanding early ([pstack part 2](https://x.com/poteto/status/2097732320606507506)) | The focus field is that restatement, read by the owner in section 11 |
| Agentless | A fixed localisation pipeline, files then functions then lines, with retrieval and model steps, no autonomous tool choice ([arXiv 2407.01489](https://arxiv.org/abs/2407.01489); abstract only) | Supports giving Understand structure (the hunk index, symbols) rather than open search |
| Entire's review command | Pins the scope clause (base ref and range) in code so different agents cannot default to different ranges (`cmd/entire/cli/review/prompt.go` in `entireio/cli`) | The range is fixed by OIDs in the run's key and every tool, never by prompt text |
| Unblocked | Task-specific context bundles that combine code, documents, earlier PRs and issues, with links (Unblocked notes, kept in the private archive) | Understand gathers the task side (scope); Investigate the code side |
| The labelling track | Scope is traced to the plan, ticket or decision that defines correctness, with weak scope stratified (9.6, 9.13) | Directly adopted: strata on every source, basis on every obligation |

### 6.7 Decisions (Understand)

**Ruled (10.77).** UN6 and UN9 as recommended below.

| # | Decision | Recommendation |
| --- | --- | --- |
| UN6 | Partition count and packing | `n = max(⌈diff load ÷ 239,000⌉, ⌈units ÷ ⌊T_plan ÷ τ⌋⌉)` (3 for 30 units), with τ a measured turns-per-unit rate and T_plan the planned turns (16 at 8 s, never above 35); pack whole code areas, largest first, then whole files, honouring areas Understand keeps together within the caps (10.23); n + 1 if the packing fails; partitions in parallel |
| UN9 | How D(u) is counted | A local estimate, bytes ÷ 3 times a 1.3 safety factor (the tokenizer since Opus 4.7 counts about 30% more than earlier ones, and bytes ÷ 3 is not shown to be conservative), calibrated in H1 against the provider's free token counts and recorded on receipts |

Ruled and no longer open here (round 3): UN1 (10.39), UN2–UN4 (10.40), UN5 (10.35), UN7 (10.36), UN8 (10.37), UN10 and UN11 (10.38).

Ruled and no longer open here: candidate batches proposed by Understand and confirmed by Assemble (10.1).

## 7. Phase 3: Investigate

### 7.1 What it is for

Investigate finds the **surrounding context** a reviewer needs to decide whether each hunk is correct, attributes each piece to a changed line, and prunes the rest. Its output becomes the **contextual markers** in the context margin: the L0 pin, the L1 one-line reason, the L2 card's "why it applies" and **Before you decide**, and the L3 source sheet (3.11). It also produces **same-batch context** where one changed unit explains another, and conflict and gap markers where scope and code disagree or evidence is missing.

It serves the reviewer's tax's primary measures, **missing attribution and wrong attribution** (foundation 05), and the hybrid retrieval rule: semantic leads, then scope, then agentic refinement and pruning (3.6, 3.7). The labelling rules say what counts: anything without which the reviewer cannot confirm the change is correct is necessary; what speeds understanding is useful (9.11); context is never smaller than a call site (9.7); sibling code that shares the rule the change implies counts, look-alikes do not (9.10).

### 7.2 What it is built on

| Code | Agent reasoning |
| --- | --- |
| Builds each hunk's query (the benchmark's Q1 recipe) and preloads the top leads per hunk as handles carrying their metadata (7.3), so the first turn starts with candidates | Follows each lead's metadata to the next lookup, judges each candidate's relevance, grades necessary or useful, sets stance, writes why and Before you decide |
| Runs the semantic retriever port (XC18) and the procedural lookups (7.3), all at the revision and bounded | Decides which lookup answers what remains unanswered; prunes irrelevant and misleading items; records look-alikes it rejected as wrong-attribution candidates (9.9) |
| Counts tokens against each hunk's allowance and trims results by leading lines (9.39) | Decides what to drop when an allowance is full |
| Resolves quotes and offsets server-side; deduplicates the same region found for several hunks into one ledger entry with several anchors | Notes when context found for one hunk also explains another |
| Classifies a source inside the selected range as same-batch, and outside it by its own review status (4.12) | — |
| Reads the submission: a hunk without a coverage line is recorded as "not stated", a disclosed gap, not refused (10.23) | States, per hunk, what it found and searched, guided by the prompt |

One agent context per partition (10.1), drawing on the run's 8 calls in flight (10.27), each with 35 turns (10.41). Tools: `search(query, kinds?, k)` for semantic leads; the procedural lookups `read`, `uses`, `defs`, `outline`, `symbol_at`, `tree` and `same_batch` (7.3); the pagers `hunks(page, partition?)` and `scope_section(id)`; `record_evidence(entry)`, `drop_evidence(id, reason)`, `submit_investigation`, `vent`. Built on `effect/ai` `Chat` and `Toolkit`, graph-client's git reads, the retriever port, the computation store (search results keyed by query and index), and `effect/workflow` fan-out.

`search(query, kinds?, k)`'s `kinds` filter may only select among declared kinds, and it never excludes `undeclared` results: a filter for `test` returns declared tests first and undeclared results after them, so no file is made ineligible by its name. The semantic port (XC18) carries the same rule: the benchmark's path-based `Region.kind` is not used in the product.

### 7.3 Hybrid retrieval: where each result points, and the procedural lookups (10.10)

**Ruled (10.10, C10).** The semantic layer does not answer structural lookups. It points to where more context can be found, through each retrieved chunk's metadata and the provenance on the graph. Structural lookups are procedural or deterministic, and agentic. No Graph structural tool in M3.

**What the research found.** The retrieval introspection audit of 13 October (kept privately; this was the only copy) found that the old system's investigation strategy was "largely supplied by the reviewer agent's instructions", and that the inspected path "does not demonstrate a maintained, evaluated process that combines multiple discoveries, identifies missing evidence, selects further queries, and produces a sufficient combined context for each unit". Its briefings could cite only one capture, so independently found evidence was never aggregated; provider ranking favoured "an editable fix site" over the contract, configuration or decision a reviewer needs; and Graph's relationship plan was one hop, caller-supplied, never re-planned from its own results. Its candidate direction, drawn as a flow, is: start with the exact change and the reviewer's question; find complementary sources; qualify and combine them; ask what remains unanswered (a missing caller, contract or historical condition) and run a focused follow-up; keep owned work apart from context. The Unblocked notes (kept in the private archive) add that similarity ranks candidates while explicit queries over identities and relationships answer exact questions, and that a valid query can still fail the need. The NEU-13 scope (snapshot of 5 October, kept privately) requires every retrieved source to keep its exact revision, blob and range identity, its budgets and omissions, and to make stale or missing vectors explicit.

**What every semantic result carries, and where it points.**

| Metadata on a result | Where it comes from | What it points to |
| --- | --- | --- |
| Identity: repository, revision, blob OID, path, line span, chunk ID and chunker recipe | The retriever port (NEU-13's identity rule) | `read` of the exact text; the citation (3.4) |
| Source kind: `test` or `doc` only where the repository declares it (PC7), otherwise `undeclared`; and the language a provider declares | PC7's declared-capability readers of the repository's own configuration; providers' declarations, as observation data (constitution). Never path or extension rules: the benchmark's `kindOf` in [`corpus.ts`](../../packages/evaluation/src/retrieval-bench/corpus.ts), lines 22–26, classifies by path and stays a benchmark rule only | Which declared capabilities apply; a `kinds` filter on `search` |
| Enclosing symbol or section: name, kind, qualified name where declared; for documents, the heading path | The chunker's symbol and section chunks; Graph's symbol results when Graph is the lead source | `read` of the whole symbol or section, never a fragment smaller than a call site (9.7); `outline` of its file |
| Contained callables | graph-client's contained-callable identities, when Graph is the lead source | `read` of each; `uses` of their names |
| Specific identifiers it defines and uses | Precompute's identifier index (IN8) | `defs` and `uses` |
| Neighbours: previous and next chunk in the file, the file's outline handle | The chunker | `read` around it |
| Retrieval: retriever, query, rank, score, tokens, and how many other queries retrieve it (the 9.32 hub measure) | The port and the run's search cache | Treating frequent chunks as hubs, preferring specific signals (9.31) |
| Coverage: truncated, omitted, stale or missing vectors | The port | Disclosure in the coverage line |

**The procedural lookups M3 offers.** All are deterministic, read git objects at the range's OIDs, return at most r = 3,000 tokens with a handle for the next page, and say what they searched.

| Lookup | What it returns | Language-neutral? | Bound |
| --- | --- | --- | --- |
| `read(handle \| path@rev, lines)` | Exact text, one page | Yes | One page |
| `uses(identifier, paths?)` | Whole-word occurrences at the revision (`git grep -w` on the tree), grouped by file, each with its line and enclosing symbol where an outline exists | Yes: textual, not semantic; it says so | 50 matches per page, 2 grep threads |
| `defs(identifier)` | Where the identifier is declared, from the symbol chunks of files a declared capability parses | Behind a declared capability; elsewhere it answers "no capability for these files, use `uses`" | One page |
| `outline(path@rev)` | The file's symbols or sections with line spans | Declared capability; line windows otherwise | One page |
| `symbol_at(path@rev, line)` | The enclosing symbol or section of a line | As `outline` | One result |
| `tree(prefix@rev)` | Files under a path at the revision | Yes | One page |
| `same_batch(hunk)` | Other changed hunks in the range that share a specific identifier with this hunk | Yes | One page |

Not in M3: Graph relationships (10.10), history and prior Records (10.3, pass 2).

**How the agent combines them.** The prompt states the loop, and the ledger records it. For each hunk: read its enclosing symbol; take its specific identifiers; read the preloaded semantic leads; follow a plausible lead's metadata (its whole symbol, `uses` of identifiers it shares with the hunk, `defs` of identifiers the hunk uses but does not define); then ask what remains unanswered against the obligations and Understand's questions (a missing caller, contract, test or decision) and run one focused search or lookup for it. Every ledger entry records how it was found: the lookup, its arguments and the entry it was followed from. That lineage is what the old system lacked: context found by several lookups is combined in one ledger and cited together, and the coverage line says which lookups ran and which capabilities were missing.

### 7.4 How the prompt is framed

- **Role.** "You gather the context a reviewer needs to decide whether each hunk is correct. You do not decide whether it is correct."
- **Inputs and layout.** Exactly the section 2.2 inputs, in section 3.3's order: tools, system and examples; the batch's change-map entry, obligations and Understand's questions, and the scope sections they cite; then this partition's diffs and code-area outlines with each hunk's allowance, the preloaded leads as handles with their metadata, and the sibling partitions' hunk index; then the task with the completion condition. The rest of the change map, the range-wide hunk index and commit texts are not inlined; `hunks(page)`, `commit(oid)` and `scope_section` page them.
- **Output.** Ledger entries (section 3.2) plus a per-hunk coverage line (`covered | partial | nothing-needed | nothing-found`, with what was searched), conflicts (two sources that disagree, both cited) and gaps.
- **Stopping.** Done when every hunk has its coverage line and every question is answered or marked open. More context is not better: stop when the next item would not change what a reviewer checks.
- **Concise.** Why it applies and Before you decide are one sentence each; the labelling brief's worked example shows the register.
- **Examples.** From the labelling brief's worked example (the BOM fix): the budget code in the same function, the caller passing the budget, the failure path, a sibling decoder, the commit that introduced the behaviour (pass 2), the test. A counterexample of a look-alike with no shared rule (9.10).
- **Vent.** Available; one per stage.
- **When the stage fails.** The ledger written so far is the output; hunks without coverage get "not investigated" gaps; the preloaded leads for those hunks enter the ledger ungraded, marked as such.

### 7.5 Options

**IN1: the unit of fan-out.** Ruled in substance by 10.1, 10.41 and 10.27: one agent per partition, 35 turns each (10.41), on the run's shared 8 calls in flight. All partitions run in parallel, as section 2.5's expectation assumes; the same query from two partitions is never run twice, because the computation store already shares one in-flight attempt per key (`computations.ts`, lines 133–143) and stores the result for the other.

**IN2: preloading leads.** A: none, the agent searches from scratch; B: top leads per hunk preloaded as handles (recommended); C: fill each allowance up front. B is the hybrid Anthropic recommends, pre-loading some data and letting the agent explore further ([Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)); C spends context on unjudged candidates.

**IN3: who enforces allowances.** A: the agent manages them from the budget line; B: code trims at submission; C: both (recommended): the agent decides what to keep within each allowance, and code trims only what exceeds it, by grade (necessary before useful) and then by rank, because the allowance is the package's bound (10.2).

**What capabilities exist in M3.** Only two declared capabilities exist, both from the benchmark's shared chunker ([`chunk.ts`](../../packages/evaluation/src/retrieval-bench/chunk.ts), lines 38–55): `ecmascript-symbols` (oxc-parser; TypeScript and JavaScript, including JSX and TSX) and `markdown-sections` (ATX headings 1–3). Each capability declares the file types it parses, which is the capability-declared boundary the constitution allows for language-specific analysis. So in M3:

| Lookup | TypeScript, JavaScript | Markdown | Every other language and file type |
| --- | --- | --- | --- |
| `defs` | Declarations from symbol chunks | Section headings | No answer: "no capability for these files, use `uses`" |
| `outline`, `symbol_at` | Symbols with line spans | Sections | Line windows of about 4 KB, which name no symbol |
| `uses`, `read`, `tree`, `same_batch` | Full | Full | Full: textual and language-neutral |

Coverage is uneven, and the coverage line says so per hunk: in a Go, Python or Rust change, Investigate has textual occurrences and reads but no declarations or symbol outlines. That is a stated limit of M3, not a judgement about those languages; more capabilities are M4's separate structural operations or later work.

**IN4: the procedural lookup set.**

| | A. Read and `uses` only | B. The set in 7.3 (recommended) | C. B plus a language-specific call-graph tool behind a capability |
| --- | --- | --- | --- |
| Callers and callees | Textual occurrences only | Textual occurrences, plus declarations and enclosing symbols where a capability parses the file | Resolved calls where the tool supports the language |
| Language neutrality | Full | Full, with capability-declared extras | Uneven by language, disclosed |
| Cost to build in M3 | Lowest | Low: the chunker and the identifier index already exist in Precompute | New work that overlaps M4's separate structural operations |

**IN7: metadata on every result.** A: identity only (what NEU-13 requires); B: the table in 7.3 (recommended), so every result says where to look next; C: B plus precomputed one-hop textual neighbours for every chunk, which front-loads work most hunks never use.

**IN8: specific identifiers, without language lists.** A chunk's identifiers are its word-like tokens (Unicode letters, digits and underscores, at least three characters), unless a declared capability for the file states its own identifier pattern. Which are _specific_ is decided by document frequency in the base tree's BM25 index, never by keyword lists: with N chunks in the index, an identifier is specific when it appears in at most `c(N) = clamp(⌈√N⌉, 3, 200)` chunks, and each chunk lists at most its 8 rarest specific identifiers. The cutoff only decides what result metadata lists by default (10.23): the agent sees each identifier's rarity and may look up any identifier with `uses` or `defs`. Language keywords and hub names are frequent, so they fall out without a list, following 9.31's "increase specificity".

| Chunks in the index (N) | Cutoff c(N) | As a share of chunks |
| --- | --- | --- |
| 50 | 8 | 16% |
| 1,000 | 32 | 3.2% |
| 10,000 | 100 | 1% |
| 100,000 | 200 (capped) | 0.2% |

A fixed share fails at both ends: 1% of 50 chunks is under one chunk, and 1% of 100,000 is 1,000 chunks, enough to keep common helpers. The square root keeps small repositories usable and the cap keeps large ones specific.

**Known limit: the neutral token rule is uneven across languages.** It splits kebab-case names (`--brand-color`, `with-open-file`), drops sigils (`$user`, `@decorator`), drops `?` and `!` suffixes (`empty?`, `save!`) and splits qualified names (`Foo::bar`). Where a declared capability parses the file (in M3, TypeScript and JavaScript), identifiers come from code positions only, so words in comments and string literals never count. Elsewhere (Markdown and every file without a capability) the word rule also picks up one-off words from comments, prose and string literals, which can then appear among a chunk's "rarest" identifiers in its metadata and make `same_batch` link two hunks that merely share an unusual word; the coverage line states that, and the agent weighs it. Where a declared capability exists, its identifier pattern also replaces the rule; elsewhere the limit is stated in the coverage line, and `uses` switches from `git grep -w` (whose word characters are letters, digits and underscore) to a fixed-string search with explicit boundaries for any identifier containing other characters.

A: the neutral rule with this cutoff and the stated limit; B: declared-capability identifiers only; C: the capability's pattern where declared and the neutral rule elsewhere (recommended).

**IN9: how lookups combine.** A: free agentic use of the tools; B: the loop in 7.3 stated in the prompt, with lineage recorded on every ledger entry (recommended); C: a code-driven sequence the agent cannot vary, Agentless-style. B keeps judgement agentic and the result auditable; C would be cheaper but cannot ask "what remains unanswered".

**IN5: where why and Before you decide are written.** A: Investigate, at the moment of recording, with the evidence in context (recommended); B: Assemble, later, for all markers at once. B costs another pass over every source.

### 7.6 Risks

- **Stricter or looser than people.** The labelling council drew "necessary" more strictly than the owner's first instincts (9.53), and the benchmark now reports relevant recall beside necessary recall for that reason (9.54). An Investigate agent may prune context a person would want. Mitigation: keep useful items within the allowance, never only necessary ones, and drop only irrelevant or misleading items.
- **Misleading context.** Look-alikes are wrong attribution, tracked separately (9.9, 9.10). The guard from M4's winner rule should become an M3 measure too.
- **Hubs.** Manifests and central documents can appear for every hunk. Deduplicate by region and by signal (the specific dependency line or decision row), never by file name (9.31).
- **Cost.** Three behaviours at 35 turns each with growing context can be expensive; the per-turn caching and the sizing rule (results capped before they are sent, turn limits sized to the ceiling; section 2.2) are what keep it bounded. Usage per agent is recorded.

### 7.7 Parallels

| Source | What it did | Fit |
| --- | --- | --- |
| SWE-agent | Interface design (windowed viewer, compact search, guardrails) moved agent results more than prompt changes ([arXiv 2405.15793](https://arxiv.org/abs/2405.15793); abstract and summaries only) | Handles plus excerpts, paged reads, explicit empty results |
| Agentless | Combined classic retrieval with model-based narrowing at each localisation level ([arXiv 2407.01489](https://arxiv.org/abs/2407.01489); abstract only) | Preloaded BM25 leads, then agent narrowing |
| Unblocked | Semantic discovery plus explicit filters, traversal and aggregation; generated queries validated, errors fed back with bounded repair; "valid but empty" results flagged (Unblocked notes, kept in the private archive) | Search for leads that point onward; procedural lookups for structure (10.10); Records for review history in pass 2; every empty result states its scope |
| Braintrust talk | Agentic investigation matched vector retrieval's accuracy at a quarter of the cost on about twenty tasks; repeated vector searches lacked caller and import context (talk notes, kept in the private archive) | Agentic read and grep carry refinement; the retriever only seeds |
| Entire Graph | A ranked query is "a selected view, not an exhaustive inventory"; health is not recall ([Entire research](../../research/03-entire-and-code-context.md#what-the-graph-actually-describes)) | Coverage lines say what was searched, never "nothing exists" |
| Hub-signal survey | Cross-encoder rerankers have the strongest code evidence; duplicate collapse is cheapest ([hub signals](../../research/hub-signals.md#techniques-by-stage)) | Duplicate collapse in code now; a reranker only if M4 selects one |
| Lost in the middle | Models use information at the start and end of long contexts better than in the middle ([Liu et al., TACL 2024](https://arxiv.org/abs/2307.03172); abstract only) | Keep each context small; put the task last and the hunks being investigated just before it |

### 7.8 Decisions (Investigate)

All ruled in round 4: IN1 (10.50), IN2 (10.43), IN3 (10.48), IN4 (10.44), IN5 and IN6 (10.49), IN7 (10.45), IN8 (10.46), IN9 (10.47); structural relations through Graph earlier (10.10).

## 8. Phase 4: Assemble

### 8.1 What it is for

Assemble turns investigated changes into what the reader opens: **batches** with one focus each, **review units** grouped by file and proximity inside each batch, **context references** attached to units with anchors on changed lines, a **lane** for every unit with its rationale, and the **digests**. It also writes the Facts, Briefed and Explained content of review delivery. Guided and the dispositions belong to Dispose (section 9), because they judge rather than describe.

| What it produces | What the reader sees | Principle it serves |
| --- | --- | --- |
| Batches by behaviour or obligation | One batch overview per focus, with its title and branch | One area of focus per review (4.10) |
| Units by file and proximity | The unit rail; owned ranges in the diff; sibling-owned lines and read-only neighbours shown, not decided | Reviewers read code without fragmentation (4.1); a unit owns only its ranges (2.8) |
| Context references | Pins, peeks, cards and source sheets; shared-unit dots; same-batch markers dashed | Attribution on changed lines (3.5); the reviewer's tax |
| Lane assessment | The lane bar's counts; the units needing the reader's judgement; the rationale on each unit | Concentrate human judgement where it is needed (foundation 01); best effort (4.4) |
| Batch digest | The isolated briefing on the batch overview, "advisory, no decision required" | Shared dependencies and verification across units without a joint approval (foundation 05) |
| Unit digest, Facts, Briefed, Explained | The desk's contextual briefing with phrase links and citation chips; the dial's lower three stops | Understanding before deciding, every claim cited (foundation 04) |

### 8.2 What it is built on

| Step | Code | Agent reasoning |
| --- | --- | --- |
| Confirm batches | Checks Understand's candidate batches against Investigate's findings: every hunk in exactly one batch, no empty batch; applies any re-split the agent requests, with its reason | May request a re-split or merge with a reason (for example two behaviours sharing one obligation) |
| Units | Groups each batch's hunks per file by proximity (below); splits at symbol boundaries past a size cap; owned ranges from the kept responsibility rules | May request splitting a candidate unit before assessment, with a reason (foundation 04 allows it); never merges across files |
| Context references | Projects ledger entries onto the unit owning each anchor line; one reference for a region cited by several units; same-batch and outside-range classification | — |
| Lane assessment | Supplies change facts (Precompute) and ledger IDs; validates that every cited ID resolves; returns an uncited factor once, then records it marked uncited; maps the quadrant to a lane (table below) | Fills both axes and any movement with cited evidence, lists gaps |
| Digests and delivery content | Validates that every phrase link and citation resolves (hard); flags verdict words in descriptive content for measurement (8.5, 10.33) | Writes the batch digest, unit digests, Facts, Briefed and Explained |

One agent context per **unit group** (no minimum size; an upper bracket of 4 units to start, guarding against noise, 10.60), at every batch size (section 2.5's time model: a batch's output alone takes minutes in one context), with up to 8 groups in flight; each group submits its units through `submit_unit_assessment` and `submit_unit_content`, and one short call then writes the batch digest from the groups' Facts with `submit_batch_digest`. Every group shares the batch's cached prefix (its ledger index and change facts, never the bodies) and the same examples, so the standard stays consistent across groups; cross-unit blast radius stays visible through the batch's ledger index, and each unit's references are read when that unit is assessed. Groups follow file order, so a file's units share a group where possible. The group size of 4 is derived from estimates, not measured: about 900 output tokens per unit (the schemas' caps for an assessment, Facts, Briefed and Explained) at the measured 100 tokens a second, so a group's output takes about 36 s; H1's telemetry re-reads it.

### 8.3 Batches and units

**Proximity, as guidance (10.23, 10.33).** Code proposes default units: within one batch and one file, hunks whose unchanged gap is at most 20 lines or that share an enclosing symbol, split at symbol boundaries past 400 changed lines. The Assemble agent sees the defaults and may merge or split within a file for proximity or readability only (for example, joining two hunks a short helper separates, or splitting a long rewrite at a symbol boundary), giving a reason. Two rules stay hard, for integrity: units are never regrouped by behaviour (4.1: behaviour decides the batch, proximity the unit), and every changed line is owned by exactly one unit. Cross-file units stay out of M3 by default (foundation 04 leaves them open). Deletion-only and binary hunks keep the "whole non-text" responsibility the kept rules already define.

**Where the numbers come from.** The 20-line gap and the 400-line split are starting values, not derived from data. On the M4 corpus (section 2.5's method; gap and size only, so upper bounds), the gap sets how many units a reader meets:

| Gap allowed between hunks | Units per range, median | p90 | All 57 ranges |
| --- | --- | --- | --- |
| 0 lines (every hunk its own unit) | 20 | 144 | 2,907 |
| 10 | 10 | 73 | 1,315 |
| 20 (the default) | 9 | 56 | 1,138 |
| 40 | 8 | 54 | 983 |
| 80 | 7 | 47 | 872 |

Most of the reduction comes before 10 lines; 20 against 40 changes the total by about 14%.

**Adapting the threshold to a range (10.59, AS7).** 10.59 asks for thresholds assessed against each range's diff, as guidelines and ranges. One procedural rule would pick, per range, the smallest gap between 10 and 40 lines after which doubling it removes fewer than 15% of units (a starting value, not derived). Tried on the corpus, that rule picks 10 lines for 27 of the 39 ranges with at least 10 hunks, 20 for 3, 40 for 3, and runs past 40 for 6; the 18 smaller ranges keep 20. It would therefore override the ruled 20-line default for most ranges, with no evidence yet that smaller units help a reviewer. So the recommendation is to keep 20 as the default and 10–40 as the guideline range the agent adjusts within, and let telemetry decide: each run records its unit counts at 10, 20 and 40 lines and every merge or split the agent made, with its reason; a rule is adopted only when those adjustments, and later the desk's judgements of unit size, show a pattern. The 400-line split barely acts at hunk granularity (1,138 units with it, 1,135 without), because a unit that large is usually one large hunk, which only a symbol boundary can split, and in M3 only TypeScript and JavaScript have one (10.44). The median unit has 11 changed lines and the p90 unit 294.

| | A. Code defaults, agent adjusts within a file (recommended) | B. Def-use clustering inside a batch | C. Agent-grouped units |
| --- | --- | --- | --- |
| Matches 4.1 (file and proximity) | Yes | Partly: def-use crosses files | Only if constrained to proximity |
| Deterministic and cached | The defaults are; the agent's adjustments are recorded with reasons | Yes | No |
| Risk | A fixed gap is arbitrary, softened by the agent's adjustment | Behaviour-like groups inside a batch, which 4.1 rules out | Regrouping by behaviour, which 4.1 forbids |

**Batch confirmation.** Ruled in 10.1: agent-proposed in Understand and code-checked here. A fallback always exists: if confirmation fails, every candidate batch stands as proposed, or the whole range is one batch.

### 8.4 Scoring the lane matrix

The matrix has two axes (4.2): **complexity** and **ease of validation**. The agent fills both with cited evidence, history and blast radius may move a unit, code maps the quadrant to a lane, and the rationale reaches the reader. Foundation 06 sets the inputs: complexity draws on impact, connections, dependency-graph position, architectural role and total unit size; security and historical problems are risk factors; blast radius matters; weights are not set.

**The assessment the agent submits per unit (zod).**

| Part | Content | Must cite |
| --- | --- | --- |
| Complexity | `low` or `high`, with factor findings: impact, connections, dependency position, architectural role, size, security | Ledger entries or change facts per factor |
| Ease of validation | `easy` or `hard`, with the unit's **validation requirements** (from its obligations and what the change implies). Each names the observed proof it needs (10.58): for browser-facing work, server, browser and network logs, screenshots and video, as the Chrome DevTools MCP captures them; for server-facing work, telemetry and logs. Custom scripts are not proof, and tests are a minimal base, not proof on their own. Verification is convergence (11.1): coverage is `solid` only when every applicable kind of proof (the code itself, tests, telemetry, logs, and screenshots and video where they apply) agrees on the same result; one kind alone is at most `shallow`. Assemble reads the range's proof records (slice H4b, 11.3, 11.8), sees who recorded each, and matches each to the requirement it serves. **Current for the unit:** a record counts for a unit only if it observed a commit in the range after which none of the unit's owned files changed up to the head; code checks this from git objects (the diff from that commit to the head over the owned paths is empty). A record that fails the check is **stale**: it counts at most toward `shallow` and is disclosed as stale, never as a defect: stale proof is not forged, though it may be outdated (11.10). Coverage is `missing` when no record serves the requirement; `shallow` when only one kind does, the kinds disagree, or the only records are stale; `solid` only when every applicable kind is present in records current for the unit and they agree. The agent judges agreement; code checks that every cited record resolves and applies the currency rule. Self-recorded proof from the implementer is weighed with 10.63's skepticism, as guidance. Until H4b lands no proof is recorded, so coverage is `missing` or `shallow` (10.4 and 10.62 hold until H4b's proof records land, and are revisited then (11.8)) | The obligation, and the proof or its absence |
| Movement | Each signal found (prior bug, outage, blast radius): its finding, the axis it bears on, and its direction. With no history in M3 (10.3), prior-bug and outage signals can come only from scope sources or repository documents (a ticket, plan or incident note that names them); blast radius comes from Investigate's ledger | Ledger entries; history joins in pass 2 |
| Lean | For the two quadrants with two possible lanes, `agentic` or `human-suggested`, with a reason | — |
| Gaps | What prevented a confident reading of each axis, per axis, and why it matters | — |
| Rationale | Two or three sentences for the reader (the proposal's guidance, not a rule) | Built from the above |

**How a movement signal's direction is set.** The agent sets it from the cited finding, toward the human end of an axis (higher complexity, harder validation) or away from it. The default is toward the human end: a prior bug, an outage or a wide blast radius makes a unit more consequential or harder to validate. A signal points away only when its evidence says so, for example an earlier fix in the same code that added a regression test covering this path. Code checks that every signal cites a ledger entry and names an axis and a direction; it never infers a direction.

**How movement reaches the axes.** Foundation 06 asks that weight and certainty guide how markers contribute, "rather than impose black-and-white routing by their presence alone".

| | A. Code moves the axis | B. The agent folds signals into its axis judgements (recommended) |
| --- | --- | --- |
| Rule | Each signal moves the axis it names toward its direction, capped at the end of the axis (an upward signal on an axis already high or hard changes nothing), counted once; opposite signals on one axis leave it as the agent judged it | The agent's `low`/`high` and `easy`/`hard` already account for every signal, and each signal is cited among that axis's factors or marked "considered, no effect" with a reason; code only checks the citations |
| Double counting | None: movement is applied once and the lean no longer counts it | None: movement lives only inside the axis judgement |
| Fit with foundation 06 | Routing by a signal's presence, which foundation 06 warns against | Weight and certainty stay in the judgement, with the evidence visible |
| Auditability | The rule is mechanical | The reader sees which signals the agent weighed and how |

**Gaps and human-required work, as ruled (10.9, C9).** A gap never lowers a unit that cited evidence on both axes places as high complexity and hard to validate: it stays human-required. Otherwise 4.4 applies, and a gap that affects an axis sends the unit to human-suggested.

**What code does with it.**

| Step | Rule |
| --- | --- |
| 1. Check | A cited ledger entry or change fact must resolve (hard: integrity); a factor, movement signal or gap without a citation, axis or direction is returned to the agent once with the reason, then recorded marked uncited and shown so in the rationale (10.33) |
| 2. Axes | Under option B, the agent's axis values stand; under option A, code applies each movement once, capped |
| 3. Gaps | As ruled in 10.9; history is not consulted in M3, which the run discloses once, never as a unit gap (10.3) |
| 4. Quadrant to lane | Low and easy: static automation when every validation requirement is met by a solid observed check, otherwise agentic; in M3 always agentic, naming the missing check evidence (10.4, which holds until H4b's proof records land and is revisited then, 11.8). Low and hard: human-suggested. High and easy: agentic, or human-suggested if the lean says so with a reason; movement is not counted again here. High and hard: human-required |
| 5. Record | The axes, factors, movement, gaps, quadrant, lane and rationale, with references to the ledger (a new assessment event version) |

**Scale options.**

| | A. Two levels per axis with cited factors (recommended) | B. Three-level scales per factor, rolled up by rule | C. Numeric scores with thresholds |
| --- | --- | --- | --- |
| Matches the matrix and today's schema | Yes | Needs a roll-up rule nobody has set | Needs weights foundation 06 leaves open |
| Calibration | Checked against owner labels later (section 11) | Same | Same, but a number looks calibrated when it is not |
| Evidence | — | — | Verbalised model confidence tends to be overconfident ([Xiong et al., ICLR 2024](https://arxiv.org/abs/2306.13063); abstract only) |

**Best-effort routing to human-suggested.** 4.4 is a selective-prediction rule: when the system cannot assess confidently, it defers to a person, but to the suggested lane, not the required one. The literature on deferral (abstaining at a target risk, [Geifman and El-Yaniv, NeurIPS 2017](https://arxiv.org/abs/1705.08500); learning when to defer from an expert's past decisions, [Mozannar and Sontag, ICML 2020](https://arxiv.org/abs/2006.01862); asking for help when a calibrated prediction set holds more than one option, [Ren et al., KnowNo, CoRL 2023](https://arxiv.org/abs/2307.01928); all abstract only) shares one requirement M3 cannot meet yet: labelled outcomes to calibrate against. M3 therefore uses the stated-gap rule and records every assessment so that later calibration is possible once the desk records human judgements (9.51).

**The static automation lane, as ruled (10.4, C4).** No static automation lane in M3: a unit that would qualify goes to agentic, naming the missing check evidence, because no proof was recorded and a test that exists is not a check that ran. 11.8 supersedes 7.9's deferral: proof records arrive in slice H4b, and 10.4 holds until then and is revisited once they land. Running the repository's declared checks inside the harness is a later design.

### 8.5 Digests and the lower delivery stops

| Content | Shape (from the desk's delivery contract) | Written by |
| --- | --- | --- |
| Batch digest | The isolated briefing: what the batch does, shared dependencies and verification across its units, supported uncertainty, limitations; advisory | Assemble agent, once per batch, after its units |
| Unit digest (Briefed) | A cited paragraph; each phrase about a hunk, file, marker or recorded review links to it (foundation 04) | Assemble agent, per unit |
| Facts | One sentence, every claim cited | Assemble agent, per unit |
| Explained | A before-and-after flow of the behaviour, and at most three terms from the owned lines; symbols and code excerpts only where they support the flow | Assemble agent, per unit |

**What the stops are about (11.5).** Review delivery is about understanding the change and whether it was done correctly against its scope. Every stop is written about behaviour, scope and proof first; in Explained and Guided (Guided is written by Dispose, section 9), code is a secondary tool or abstracted away entirely, as the desk's delivery concept in Storybook shows (`screens-review-desk-delivery--dial-change`). Code excerpts appear only as support, cited like any other evidence.

Code validates every citation against the ledger and the owned ranges (a hard rule: a citation that does not resolve is an integrity failure). The prompt guides the agent to keep descriptive content free of verdicts ("approve", "correct", "safe to merge" and the like); code flags any it finds for measurement rather than refusing it (10.23), unlike the labelling briefing's refusal of grade words (9.38). That keeps Facts, Briefed and Explained neutral, so the desk can show them before revealing the agent's review if M5 adopts decide-then-reveal (sections 9.2 and 9.6).

### 8.6 Prompt framing

- **Role.** "You assess each review unit of one batch: how complex it is, how hard it is to validate, and what a reader needs to know first. You do not approve or reject anything."
- **Inputs.** Exactly the section 2.2 inputs: system and examples; the batch's change-map entry and obligations; the batch's ledger index and change facts; then the group's units (at most 4), each unit's owned ranges and attached references read on demand with `read`.
- **Output.** The assessment and content schemas above.
- **Stopping.** A group is done when each of its units has an assessment and content; the digest call is done when the batch digest is submitted. Turns come from the batch's shared 40 (10.28), with at least 2 kept for the digest call; there is no time limit per stage (10.26).
- **Examples.** A low and easy unit that is still agentic because its tests were not observed running; a unit whose blast radius across batches, folded into its validation judgement, makes it high and hard and so human-required; a high and easy unit whose lean, with its reason, puts it in human-suggested; a unit with a gap that goes to human-suggested.
- **When the stage fails.** Units without an assessment are human-suggested with the gap "not assessed" (4.4); units without content get a Facts line built by code from the change map and change facts.

### 8.7 Risks

- **Over-escalation.** A model that lists gaps freely sends everything to human-suggested, which moves work back to people. The gap list must name what is missing and why it matters; section 11 measures the lane distribution against owner labels.
- **Under-escalation.** Complexity judged from the diff alone misses blast radius outside it. Investigate's ledger and cross-batch references are the mitigation; McIntosh and colleagues found that low review coverage and participation predict post-release defects ([MSR 2014](https://rebels.cs.uwaterloo.ca/papers/msr2014_mcintosh.pdf); abstract only), a reminder that routing work away from people has a quality cost if wrong.
- **Consistency.** Unit groups share the batch's prefix and examples but are separate contexts, so two groups can judge similar units differently, and batches more so. The owner's calibration sample (section 11) spans groups and batches, and the lane distribution per batch is a day-one product metric (section 3.8).
- **The UI's unresolved states.** The desk types still model "Assessment unresolved" with gaps; the harness never emits that state (4.4), which M5 must reconcile.

### 8.8 Parallels

| Source | What it did | Fit |
| --- | --- | --- |
| Legacy Neuve routing | Hard gates before quadrants, sending ordinary source changes to strict human review ([escalation foundation](../../foundations/06-escalation-and-decomposition.md#historical-snapshot-not-design-guidance)) | Rejected: no gates; movement signals are weighed inside the axis judgements, with cited evidence, instead |
| Anthropic Code Review | Review effort scales with the change; candidate findings are verified separately before ranking ([research memo](../../research/02-review-and-verification.md#production-review-systems)) | Effort scales through fan-out; verification belongs to Dispose |
| Kamei, JIT defect prediction | Change size and diffusion predict risky changes at check-in (abstract only) | Size and diffusion are cited complexity facts, not a score |
| Fregnan et al. | Files shown first in review get more comments; for one seeded defect, reviewers had 64% lower odds of finding it when its file came last ([ESEC/FSE 2022](https://arxiv.org/abs/2208.04259); abstract only) | A suggestion for M5, not an Assemble rule: order the rail and the batch digest by lane and consequence, never alphabetically |
| ClusterChanges | Def-use partitions helped reviewers understand changesets (abstract only) | Informs batch candidates, not units (4.1) |
| Entire's judge | Keeps "only real defects backed by concrete evidence" and drops speculative claims (`synthesis_prompt.go`) | Every factor and movement should cite; an uncited one is returned once, then recorded as uncited rather than dropped |

### 8.9 Decisions (Assemble)

All Assemble decisions are ruled: AS7 (10.70), AS1 (10.59), AS2 (10.60), AS3 (10.57, 10.58), AS4 (10.56), AS5 (10.55), AS6 (10.61); gaps on high-and-hard units (10.9), no static automation lane (10.4), no history in M3 (10.3).

### 8.10 Round 5 at a glance, as put to the owner (now ruled as 10.55–10.61)

| Decision | What the reader sees | Product principle it serves | Parallels |
| --- | --- | --- | --- |
| AS1 unit proximity | The unit rail's entries and how many there are (a median range has about 9 units under the default, section 8.3); each unit's owned ranges in the diff, with gap rows between them and sibling-owned lines shown read-only | Review units are grouped by file and proximity, never by behaviour (4.1); a unit owns only its ranges (2.8); fewer, readable units lower the reviewer's tax without hiding work (foundation 05) | Risk triage: ClusterChanges found decomposing a changeset helps reviewers understand it (abstract only), but its def-use grouping is behaviour-like, which 4.1 rules out for units. Legacy: path-level groups were an implementation compromise, not the hunk-based intent (foundation 04, legacy grounding) |
| AS2 assembling agents | Consistent rationales across a batch's units, and the batch digest on the overview | Quality and token cost are the KPIs (foundation 01); a run lives at most 10 minutes (10.26) | Risk triage: Anthropic Code Review scales review effort with the change (vendor report). Fan-out has a token premium (Anthropic's multi-agent post; secondary summary) |
| AS3 assessment schema | The lane rationale on each unit; the batch overview's Verification section, each validation requirement shown missing or shallow (solid only when the applicable kinds of proof in the range's records converge, 11.1; never solid before H4b's proof records land, following 10.4 until it is revisited, 11.8); assessment-gap markers in the context margin where an axis could not be read | Lanes come from cited evidence on two axes (4.2); verification must deserve trust, and a test that exists is not a check that ran (foundation 07, 10.4); gaps are disclosed, never hidden (2.5) | Risk triage: just-in-time defect prediction's change measures (size, diffusion) become cited facts, not a score (Kamei et al.; abstract only). Deferral: verbalised confidence is overconfident (Xiong et al.; abstract only), so no numeric confidence is asked for. Legacy: categorical levels from reason codes mapped to fixed numbers were not a weighted aggregation of evidence (foundation 06), and are not reused |
| AS4 movement | Which prior-bug, outage or blast-radius signals the rationale weighed, and in which direction. With no history in M3 (10.3), prior bugs and outages come only from scope sources or repository documents | Weight and certainty guide how markers contribute, not their presence alone (foundation 06); delegation is not permanent evidence of safety, and regression history can move a unit up (foundation 03) | Legacy: hard gates before the quadrants routed ordinary source changes to strict human review, and are rejected (foundation 06). Risk triage: review coverage and participation predict post-release defects (McIntosh et al.; abstract only), so moving a unit away from people needs evidence |
| AS5 quadrant to lane | The lane bar's counts; the unit rail grouped by lane; the human-gate meter for units that need the reader; the decision dock's actions, which depend on the lane (vocabulary) | Concentrate human judgement on what remains unresolved (foundation 01); best effort to human-suggested, never to human-required, except that a gap cannot lower an evidenced high-and-hard unit (4.4, 10.9); human-required work keeps its human decision (vocabulary) | Deferral: abstaining at a target risk (Geifman and El-Yaniv; abstract only), learning when to defer from past expert decisions (Mozannar and Sontag; abstract only), asking for help when a calibrated set holds more than one answer (KnowNo; abstract only); all need labelled outcomes, which the desk's judgements will supply (9.51). Legacy: the old assignment collapsed automated and agent-delegable routes into one tier and forced strict human review through gates ([existing product research](../../research/01-existing-product.md#quadrants-currently-mean-several-different-things)); the lanes here keep static automation, agentic, human-suggested and human-required distinct |
| AS6 digests and lower stops | The batch overview's isolated briefing ("Advisory briefing · no decision required"); the desk's contextual briefing with phrase links and citation chips; the dial's Facts, Briefed and Explained stops | Digests are advisory and never confer approval (4.8, vocabulary); descriptive text links to what it describes (foundation 04); facts stay neutral of verdicts so the reader is not anchored (9.38's lesson, 10.33) | Risk triage: understanding the change is reviewers' main challenge (Bacchelli and Bird; abstract and summaries only). Unblocked's task-specific context bundles keep every source linked (research notes). Review order matters (Fregnan et al.; abstract only) |
| VO1 "validation requirement" | The Verification section's requirement rows | Static automation is assessed against validation requirements (4.3); terms are defined before use (vocabulary discipline) | — |

## 9. Phase 5: Dispose

### 9.1 What it is for

Dispose writes the agent's review of every unit: the **pre-generated dispositions** and the **suggested reviews**, the comments anchored to lines, and the **Guided** content of review delivery. The rules are fixed (4.5, 4.6, 4.13, 4.14): on agentic and human-suggested units the agent approves or requests changes; on human-required units it writes a suggested review and comments and never approves; it may request changes on any lane; and whether a unit's needed dispositions are in is judged against its current lane.

This is the stage whose errors cost most. On a human-suggested unit, when the person gives no input, the agent's disposition applies (foundation 01, vocabulary). So the reader gets: on human-suggested units, an agent review already done, which they can agree with or override; on human-required units, a suggested review at the Guided stop reasoned from the ticket's "Done when" items and their evidence, which becomes a disposition only if they send it; on agentic units, a disposition they can comment on. It serves **concentrating human judgement** and the **human gate** (foundation 02).

**The final review never blocks (11.11).** The harness's review shares the evidence and gives best-effort dispositions and comments; it never blocks a merge, a cycle or the inner loop. A request for changes is a disposition that informs the next iteration, not a gate, and a gap or a failed unit loop leaves the unit open with the gap disclosed, never a stop (2.5). Offered proof that cannot show what it claims is still a defect (10.63); missing proof is disclosed, not weighed as a reason to hold anything back.

### 9.2 What it is built on

| Code | Agent reasoning |
| --- | --- |
| Builds each unit's context: owned ranges with the diff, its context references with excerpts, its obligations and validation requirements (without the assessment's coverage grades) and its Facts sentence; never its lane, the assessment rationale, sibling units' verdicts, or the batch digest, Briefed and Explained, which the Assemble agent wrote in the same context as the lane assessment | Reviews the unit against its obligations and context; decides approve or request changes; fills each criterion's status and evidence; writes findings and the review text |
| Checks that each finding's cited lines exist and are in the owned ranges or the ledger (hard: integrity of citations). A request for changes without a cited defect is returned to the agent once with the reason, then recorded as the agent decided, marked uncited (10.23) | Verifies its own defect claims with read-only reads before submitting; treats pattern notes as comments unless the shared rule is violated (9.10) |
| Maps the verdict by lane: on agentic and human-suggested units, a disposition with the review text as its note; on human-required units, the verdict and text become the suggested review, and a request for changes is also recorded as the agent's disposition, reaching the human as context (4.14) | — |
| Turns each finding into a `comment.recorded` event on the unit at Publish: anchored to the finding's lines, the text as body, its kind and evidence as references (a new comment version, PU5); a disposition that requests changes references its defect comments | — |
| Judges each unit with `Dispositions.judge` after Publish | — |

One bounded agent loop per unit, at most 15 turns, drawing on the run's 8 calls in flight (10.27), with read, grep and scope tools, `submit_unit_review` and `vent`. The batch's shared block (its change-map entry; not the ledger index, which section 2.2's Dispose bound leaves out) is the cached prefix; each unit's material follows it.

**Keeping the lane out.** Briefed, Explained and the batch digest are written in the same context as the lane assessment, so lane wording could reach Dispose through them. Two guards: Dispose receives only Facts and the references, not Briefed, Explained or the batch digest (lane-blind review, ruled in 10.33 and 10.61); and the Assemble prompt guides Facts away from naming a lane or quadrant, with code flagging any that do for measurement (10.23).

**Blind to the lane.** Dispose does not see the lane while it reviews; code applies the lane afterwards. This is the labelling track's decide-then-reveal (9.38) applied to the agent itself: the verdict on whether the code is correct is formed without the routing judgement that might anchor it ("it's only agentic, approve"), and the same review text serves every lane. The cost is nil, because every lane needs the review text anyway (as a disposition note or as the suggested review).

**Judging tests and proof (10.58).** Validation means observed proof: for browser-facing work, server, browser and network logs, screenshots and video, which the Chrome DevTools MCP captures; for server-facing work, telemetry and logs. Custom scripts are not proof. Tests are a base requirement, kept to the minimum good practice needs; many tests in generated code is a warning sign, and bogus or forged tests or proof are defects (vocabulary, "Validation requirement"). Verification is convergence: every applicable kind of proof must agree, and no one kind is enough alone (11.1). Good tests are not more tests: they verify the right things at the right boundaries, including error handling and input handling (11.2). Dispose applies all of that to every unit:

| What the reviewer checks | How it reads it | What it becomes |
| --- | --- | --- |
| Does each validation requirement have observed proof? | Reads the proof records Assemble matched to the unit's requirements (slice H4b): each record's kind, the revision it observed and whether it is current for the unit (section 8.4), who recorded it, its claim and its artefact, paged through `proof(id)` within the tool-result cap; screenshots are read as images; video is judged from its claim and any frames recorded with it, because the model does not take video. With the plan's scope and definition of done, these records are what the reviewer judges against (11.3) | `met` only when every applicable kind is in records current for the unit and they converge (11.1); `not-met` when a record contradicts the requirement; `no-evidence` when none is recorded, and the review text says so. Never `met` on the strength of a test's existence. A stale record is disclosed as stale and supports at most a partial reading, never `met` and never a defect. A custom script's output offered as proof, or a record that claims to describe the head while its artefact shows it observed another revision, is a `defect` (10.63). Proof the implementer recorded about its own work is weighed with 10.63's skepticism, as guidance. Until H4b lands, every such row is `no-evidence` (10.4 and 10.62 hold until H4b's proof records land, and are revisited then (11.8)) |
| Do the range's tests observe the changed behaviour? | Reads each changed test: does it claim to verify the changed behaviour, and if so does it exercise the real path or mock it away; does it assert the outcome, or only that a call returned (foundation 07's revoke-link example) | A test that claims to verify the changed behaviour but mocks it away or cannot observe it is bogus: a `defect` finding about the tests. A test that simply does not cover the behaviour is a `risk` finding. Either way the requirement stays `no-evidence` |
| Are tests or proof bogus or forged? | Signs, as guidance the agent weighs, not a rule list: tautological or constant-only assertions; a test that claims to verify the changed behaviour but mocks it away; assertions deleted or loosened in the same range; tests skipped, disabled or narrowed to one case; snapshots rewritten wholesale with the change; a custom script offered as proof; a proof record that claims to describe the head while its artefact shows another revision (stale proof is not forged, though it may be outdated: 11.10, section 8.4) | A `defect` finding about the tests or proof, with its evidence; it supports a request for changes on any lane (4.5) |
| Do the sources agree? (11.1) | Compares what the code does with what its tests assert and with any proof present (telemetry, logs, screenshots, video): the same behaviour, the same revision, the same result | A disagreement between sources is a finding: a `defect` when one source contradicts the change's claimed behaviour, a `risk` when the sources cannot be reconciled from what is recorded |
| Do the tests verify the right things at the right boundaries? (11.2) | Judges whether the changed behaviour's boundaries, error handling and input handling are exercised, not how many tests there are | A missing boundary, error or input case the change implies is a `risk` finding about the tests |
| Is the change carrying more tests than good practice needs? | Weighs test volume against what the change implies, especially in generated code; no fixed ratio | A `risk` finding (a warning sign, 10.58), a comment rather than a request for changes unless the volume hides missing proof |

Each finding records what it is about (`code`, `tests` or `proof`), so telemetry can count forged-evidence defects and test-bloat warnings separately (section 3.8). The prompt carries one example of each and asks the reviewer to stay skeptical of every test and every claimed proof (7.3): agents can be convincingly wrong without meaning to be.

### 9.3 How the prompt is framed

- **Guidance (11.7).** The reviewer's guidance on verification, independence and judging against scope comes from the reviewer skills in `.agents/skills/` (review-verification, review-independence, review-against-scope, inner-loop-reviewer, final-reviewer; being written in another lane), loaded into the system block, rather than restated here (section 3.3). The points below are the stage's own framing.
- **Role.** "You are the agentic reviewer of one review unit. Decide whether its owned changes are correct against what they were meant to do. Context is evidence; it is not yours to approve."
- **Inputs.** Exactly the section 2.2 inputs: system and examples; the batch's change-map entry; then the unit: owned ranges with the diff, sibling-owned lines and read-only neighbours marked as not yours, context references with excerpts, obligations, validation requirements and the Facts sentence.
- **Output (zod).** `verdict: approve | request-changes`; `criteria[]` (obligation ID, status `met | not-met | no-evidence | outside`, what the change does about it in up to 200 characters, evidence IDs); `findings[]` (anchor, kind `defect | risk | question | pattern-note`, about `code | tests | proof`, text up to 400 characters, evidence IDs); `message` (the review text, up to 1,200 characters); `gaps[]`. The character caps are this proposal's starting values, not derived, and are enforced by zod after the response (section 3.4).
- **Stopping.** Done when every obligation has a status and the verdict follows from the findings. A request for changes should rest on a cited defect; "could be improved" is a comment.
- **Concise.** The message says what is wrong or why it is fine, once, and cites. CR-Bench found that a reflection protocol pushing reviewers to add missed findings raised recall but cut the ratio of useful to spurious findings from 5.11 to 1.95 ([research memo](../../research/02-review-and-verification.md#evaluation-that-challenges-the-sales-story)), so the prompt never asks for more findings or discourages an empty result.
- **Examples.** An approval with one sentence and two citations, stating that proof is not recorded; a request for changes with one verified defect; a request for changes on a test that claims to verify the changed behaviour but mocks it away (a `defect`); a `risk` comment on a changed behaviour no test covers; a test-bloat warning left as a comment; a pattern note left as a comment.
- **Vent.** Available; one per stage.
- **When a unit's loop fails.** No disposition is invented. On agentic and human-suggested units the unit stays open (judge: "a disposition" needed) and the gap is disclosed; on human-required units, Guided shows the criteria code can fill (statuses `no-evidence`) and no suggestion.

### 9.4 Options

**DI1: one session or bounded per-unit calls (open from Area 2).**

| | A. One agent session per batch | B. Bounded per-unit agent loops (recommended) | C. One call per unit, no tools |
| --- | --- | --- | --- |
| Independence across units | Each verdict sees the earlier ones; anchoring | Fresh context per unit; sibling verdicts unseen | Fresh |
| Can verify its own claims | Yes | Yes, up to 15 turns | No |
| Cost | Lowest prefix cost, growing context | One cached prefix per batch, plus each unit | Lowest |
| Fits 2.4 (avoid one-shot) | Yes | Yes | No |
| Over ACP | One Codex session with one prompt per unit; context accumulates | One Codex session per unit through `session/new`; the spike measured about 20,000 cached system-prompt tokens per session | One session per unit, one turn |

**Recommendation: B on both routes.** Per-unit independence matters most where the agent's disposition ships without a person. Over ACP, a session per unit is the same shape as the Anthropic route and needs no ACP feature the spike did not prove.

**DI2: one reviewer or a council.** The labelling track's four-member council (Opus and Sol, each at medium and high effort, anonymous deliberation, a round table until three of four agree; 9.52) is the strongest independence pattern in this repository. Its fit here:

| For | Against |
| --- | --- |
| Human-suggested and agentic dispositions apply without a person, so a second family's view would catch errors one model shares with itself | About four times the cost of every unit's review (an estimate: four members instead of one, before any round-table turns) |
| The council was validated against the owner's labels (19 of 29, 9.53) | The Sol route is not usable for review roles in M3 (no true read-only mode, 0003) |
| | "Debate or vote" found majority voting accounts for most of the gains credited to multi-agent debate ([Choi, Zhu and Li, NeurIPS 2025](https://arxiv.org/abs/2508.17536); abstract only), so the round table may add cost without accuracy |

**Recommendation: one reviewer in M3, with a seam.** Record every Dispose output with its route and effort, so that M6 can test, on a sample, whether k independent reviews by majority change verdicts. If they do, the cheapest use is escalation, not consensus: when independent reviews of an agentic unit disagree, a new assessment moves it to human-suggested (foundation 06 allows reassessment with discovery), which is the KnowNo pattern of asking for help when the answer set holds more than one option.

**DI3: verifying requests for changes.** A: in-loop verification required by the prompt and checked by code (recommended); B: a second, separate verifier call per defect, as Anthropic's Code Review does ([research memo](../../research/02-review-and-verification.md#production-review-systems)); C: none. B is the natural M6 addition once false positives are measured.

**Effort**, formerly DI4, is ruled: `medium` everywhere, fixed per context, re-measured on the judging sample (10.19); no lighter calls in M3 (10.30).

**DI5: Guided basis.** "Done when" from the ticket, else the ticket's scope, else a gathered scope, with `unlinked` when nothing links to the change (the desk's contract). Criteria found by the margin outside the ticket are `outside`, for the reader's judgement.

**DI7: dispositions after the first full set (4.7).** Fresh-context per-unit reviews for the first full set are ruled stages of the one pipeline (10.6); 4.7 governs what follows. A re-review after comments or new commits runs the same Dispose activity in a fresh context that reads the frozen packet's manifest plus the new comments; it never regenerates a stored disposition. Earlier agent dispositions on a unit that has since become human-required reach the human as context (4.13), which `Dispositions.judge` already computes.

**DI9: how findings about tests and proof are classed.** A: bogus or forged tests or proof, including a test that claims to verify the changed behaviour but mocks it away or cannot observe it, are `defect` findings that support a request for changes; a test that simply does not cover the behaviour, and test bloat, are `risk` findings, comments only (recommended, following the vocabulary's "bogus or forged tests or proof are defects" and 10.58's "warning sign"); B: every test concern is a `defect`, which would send back work for test volume alone; C: test concerns are comments only, which would let forged proof through on agentic and human-suggested units.

**DI10: approving without recorded proof.** Until H4b's proof records land, no validation requirement can show observed proof (10.4), so every Guided row that needs proof reads `no-evidence`. 10.62 holds until then and is revisited once they land (11.8); the options below are the record of the round 6 choice.

| | A. Approval allowed, the missing proof disclosed (recommended) | B. Request changes whenever proof is missing | C. Approve only units whose requirements need no runtime proof |
| --- | --- | --- | --- |
| Effect in M3 | Every agentic and human-suggested unit the agent approves is closed by that approval without any of the observed proof 10.58 defines as validation; on human-suggested units it applies when the person gives no input. The review text and the Guided rows say proof is not recorded; telemetry counts how often | Nearly every agentic and human-suggested unit is sent back to the inner loop, because no proof can be recorded in M3; the cycle cannot close on agent review alone until proof records exist (7.9) | Units needing runtime proof get a comment instead of a verdict, so agentic and human-suggested units stay open until a person decides |
| Principle | Missing evidence never receives verification credit (foundation 01): the approval is a code judgement, visibly not a verified one | Verification must deserve trust, taken to the point of blocking everything | Same, at the cost of 4.5's approve-or-request on those lanes |
| Measured | Approvals with proof not recorded, by lane (section 3.8) | Returns for missing proof | Units left without a verdict |

### 9.5 Risks

- **Silent wrong approvals** on human-suggested units. Mitigations: blind-to-lane review, a defect-or-approve rule with evidence, the owner sample in section 11, and DI2's later escalation test.
- **Noise.** Industrial studies found automated review comments acted on (73.8% resolved) but pull requests closing more slowly and complaints about irrelevant comments ([Cihan et al., ICSE SEIP 2025](https://arxiv.org/abs/2412.18531); abstract only). Hence comments only with evidence, pattern notes separate, no quotas.
- **Same-family judging.** Investigate, Assemble and Dispose all run on Opus, so they share blind spots; the M4 proposal raised the same risk for grading (its option table, row B). Independence across families waits for the Sol route.
- **Position bias in long contexts.** LLM judges favour answers by position ([Zheng et al., NeurIPS 2023](https://arxiv.org/abs/2306.05685); abstract and summaries only); per-unit contexts keep the unit's code in a predictable place, last before the task.

### 9.6 Parallels

| Source | What it did | Fit |
| --- | --- | --- |
| Labelling: neutral briefing, decide-then-reveal (9.38) | The adjudicator grades before seeing the labellers; the briefing carries no grades | Dispose reviews before the lane is applied; Facts, Briefed and Explained carry no verdict words (8.5), so M5 can show them before the agent's review to reduce anchoring for people too |
| Labelling: isolated run folders, environment allowlist (2.16) | Each run sees only what it may | The ACP route's per-unit sessions (XC16) |
| Labelling: the council (9.52, 9.53) | Four anonymous members, round table to three of four | A later escalation test, not M3's default (DI2) |
| Labelling: stricter "necessary" | Model adjudicators drew the line stricter than the owner's first instincts; the owner then sided with the single adjudicator where they differed (9.53) | Direction is unknown for verdicts; the section 11 sample measures whether Dispose is stricter or looser than the owner |
| Entire's judge | Merges reviewer reports, rejects unsupported claims, keeps the verdict brief, refuses fixed templates (`synthesis_prompt.go`) | The defect-with-evidence rule and optional arrays |
| GitHub Copilot review | Treats outputs as feedback the user must verify ([research memo](../../research/02-review-and-verification.md#production-review-systems)) | Matches human-suggested semantics: the agent's review is visible and overridable |
| Google AutoCommenter | Deployed LLM-enforced best-practice comments gradually, measuring developer reaction ([arXiv 2405.13565](https://arxiv.org/abs/2405.13565); abstract only) | Pattern notes as a separate comment kind, measured before any becomes a request for changes |

### 9.7 Decisions (Dispose)

All ruled: DI1 (10.64), DI2 (10.65), DI3 (10.66), DI4 (10.19, 10.30), DI5 (10.67), DI6 (10.33, 10.61), DI7 (10.68), DI8 (10.69), DI9 (10.63), DI10 (10.62, which holds until H4b's proof records land and is revisited then, 11.8); fresh-context per-unit reviews as stages of the one pipeline (10.6). 10.64 also settles the "Open from Area 2" question on how bounded per-unit calls run over ACP for Dispose: one Codex session per unit. How Assemble's unit groups run over ACP stays open; ACP is not used for review roles in M3 (XC16), so nothing in M3 waits on it. That section's other question, whether the turn limits cover Understand and Investigate together and how they scale, was settled by 10.7 and 10.41.

**The inner loop.** Two of these rulings reach beyond the harness. The judging of tests and proof (10.63) is also a guideline for inner-loop reviewers, and the bounded, fresh-context review per unit (10.64) applies to them too. The Neuve skills that drive the inner loop (1.1) carry both; this proposal does not design those skills. **Missing proof is the inner loop's call (11.11):** the inner-loop reviewer may let the loop proceed when the proof present gives enough signal that the change is correct. Only the inner loop has that discretion; the harness's Dispose discloses missing proof and never holds anything on it.

### 9.8 Round 6 at a glance, as put to the owner (now ruled as 10.62–10.70)

| Decision | What the reader sees | Product principle it serves | Parallels |
| --- | --- | --- | --- |
| DI1 per-unit reviews, including over ACP | On human-suggested units, the agent's review already done, which the decision dock lets the reader agree with or override; on human-required units, the suggested review at the Guided stop; on agentic units, a disposition to comment on. Each written in a fresh context, never seeing sibling verdicts | Human-suggested work arrives with an agent disposition that applies if the person gives no input (foundation 02, vocabulary); fresh contexts are ruled stages of the pipeline (10.6) | Entire's review command runs each reviewer as its own process with its own environment (`review-command.md`, "Flow"). Decide-then-reveal (9.38) applied to the agent itself |
| DI2 one reviewer or a council | One agent review per unit; later, units whose independent reviews disagree would move to human-suggested | An additional reviewer's cost must earn its place (foundation 02) | The review and verification memo's discussion that independent evidence matters more than agreement ("Independence has several forms", a consequence to discuss, not a principle). The labelling council (9.52, 9.53). Majority voting carries most of debate's gains ("Debate or Vote"; abstract only). Asking for help when answers disagree (KnowNo; abstract only) |
| DI3 verifying requests for changes | Requests for changes that cite a defect the agent checked by reading the code | Noise and repeated, unsupported comments are reviewer's tax (foundation 05); no findings is a valid result (foundation 02, adversarial review) | The memo's "Debate incentives matter": a reviewer should not be rewarded for producing objections (a consequence to discuss). Anthropic Code Review verifies candidate findings separately (vendor report). A reflection protocol raised recall but cut the useful-to-spurious ratio from 5.11 to 1.95 (CR-Bench, research memo). Automated comments were mostly resolved but slowed pull requests (Cihan et al.; abstract only) |
| DI5 Guided content | The Guided stop: what the ticket asked for ("Done when", else its scope, else a gathered scope), each row met, not met, no evidence or outside, with evidence chips; a suggestion on human-required units | Review delivery never changes the facts, the lane or who decides (vocabulary); a suggested review is not a disposition until a person sends it (vocabulary); scope is part of context (9.6) | Anthropic's generator and evaluator agreed testable criteria before work, and evaluators still excused defects (research memo). The labelling brief's "Before you decide" (9.8) |
| DI7 later dispositions | A re-review after comments or new commits, with earlier dispositions shown as context, never rewritten | Dispositions are stored and never regenerated (4.7, 4.11); earlier agent dispositions reach a human-required unit's reviewer as context (4.13, 4.14) | Records' append-only log (0004); Entire condenses session work into checkpoints rather than rewriting it |
| DI8 findings as comments | Line-anchored review comments in the margin, and a request for changes that links its defects | A review comment is informational until a disposition references it (vocabulary); attribution stays on the unit and cycle (foundation 02) | GitHub Copilot review's outputs are feedback to verify (research memo). AutoCommenter measured developer reaction before enforcing (abstract only) |
| DI9 findings about tests and proof | Comments marked as about tests or proof; requests for changes when tests or proof are bogus or forged, including a test that claims to verify the behaviour but mocks it away; warnings, not returns, for uncovered behaviour and test bloat | Validation is observed proof; tests are a minimal base; bogus or forged evidence is a defect (10.58, vocabulary); stay skeptical of tests (7.3) | OpenAI's audit found material test problems in 59.4% of a hard subset of SWE-bench Verified (research memo). A passing assertion can reproduce an implementation's mistake (test-oracle survey, foundation 07). Mutation testing exposes tests that detect nothing (PIT, foundation 07) |
| DI10 approving without recorded proof | Approvals whose review text and Guided rows say proof is not recorded. Under option A an agentic or human-suggested unit is closed by an agent's approval without observed proof, and on human-suggested units that applies when the person gives no input; telemetry counts how often. Under option B nearly every such unit is sent back | Missing evidence never receives verification credit (foundation 01); a verdict is a judgement, visibly not a verification (research 02's question, evidence and authority) | Selective prediction: decide under stated uncertainty rather than hide it. c-CRAB found the tested reviewers together covered only around 40% of its tasks (research memo), a reminder that a code reading is not proof |
| AS7 grouping threshold (carried from Assemble) | How many units a range shows, and the agent's merges or splits with reasons | Grouping is mostly procedural, with guidelines and ranges (10.59); guide, don't impose (10.23) | ClusterChanges' decomposition aided understanding (abstract only); the corpus measurement in section 8.3 |

## 10. Phase 6: Publish

### 10.1 What it is for

Publish freezes the cycle's packet as references in Records, so later information never rewrites it (5.5, 8.7). It appends each event once, writes the packet's small content-addressed manifest, discloses every gap the run recorded, and judges which units already have their needed dispositions. The reader gets a batch that exists in Records exactly as reviewed, with lanes, digests, context and the agent's reviews, which the CLI shows now and the desk shows from M5. It serves **range immutability**, **dispositions never regenerated** and **gaps disclosed, never a dead end** (2.5).

### 10.2 What it is built on (all code)

| Step | Detail |
| --- | --- |
| Order | Per batch: batch, units, context references, assessments, then dispositions and comments. Assessments come first because the append rule checks the current lane when an agent's approval arrives (rules.ts) |
| Transactions | One append transaction per batch, so a batch is all there or not at all; each event within the 64 KB payload cap, larger content by reference |
| Idempotency | Keys from the run's computation key and stable positions (`review:<run>:batch:<n>`, `…:unit:<n>:assessment`), so a replayed Publish appends nothing new |
| IDs | ULIDs minted by the harness from its own clock, refusing a clock far in the future (the plan's far-future ULID follow-up) |
| Manifest | Hashes of every batch, unit, reference, assessment, digest, delivery content and disposition, plus the run configuration and route; one `packet.published` event names it (8.7) |
| Gaps | One record per disclosed gap (scope missing, stage fell back, Graph unavailable, history not consulted), attributed to the run and stage, and summarised in the manifest |
| Run receipt | Route (provider, model, effort), the name of the environment variable that supplied the credential (never its value) and the organisation if the provider names it (10.5, 10.16); tokens and cost by stage (input, cache writes, cache reads, output); per agent and per review batch: turns used against its limit (10.41, 10.28, 10.7), whether the turn limit or the ceiling was reached, whether the final generation ran (10.11); actual against expected time per stage; whether the run timed out and what it published (10.42); partitions per batch with estimated and measured context (10.1); the day-one counts the rulings added (approvals without recorded proof by lane, 10.62; forged-evidence defects and test-bloat warnings, 10.63; high-complexity units with a validation gap sent to human-suggested, 10.55; unit counts at 10, 20 and 40 lines and the agent's merges and splits, 10.70); queue wait; retries; wall time |
| Closure | `Dispositions.judge` per unit, so the CLI can say which units need a person |
| Proof artefacts | Promotes every proof artefact the packet cites from raw capture (30-day retention, 8.10) to durable, because re-reviews reuse them (4.7, 10.68); uncited artefacts keep the raw-capture retention (slice H4b) |
| Cleanup | Deletes the run folder `.git/neuve/runs/<run-id>/`, including the unmasked scope copy, and ACP sessions' empty folders; masked scope captures follow raw-capture retention (10.8). Final failure, abandonment and the retention sweep delete it on the other paths (section 1) |

**Schema additions M3 needs** (zod in `records-schema`, new versions, old ones still decoded): `review.requested@1`, the review request that opens or joins a cycle and enqueues `review.run` (section 1; added in H1 with the job kind, not with the others); `unit.recorded@2` with sides on owned ranges and, when the agent moved the unit away from the 20-line default by merging or splitting, that change and its reason (10.70); `context.referenced@2` with the anchor, stance and the attribution fields of [0006](../../architecture/decisions/0006-hybrid-retrieval-and-context-references.md#context-reference-contract) that M3 can fill (M4 completes the contract); `assessment.recorded@2` with axes, factor and movement references, gaps and quadrant; `comment.recorded@2` with a finding kind, what the finding is about (`code`, `tests` or `proof`, which 10.63's separate counts need) and evidence references; `disposition.recorded@2` with a list of the comment event IDs a request for changes rests on (today's `Causation.causedBy` holds one ID and `Reference` points only to computations or blobs); a digest and delivery-content event that references computations; `packet.published@1`; `gap.disclosed@1`; `stage.completed@1` (stage telemetry, 10.32); and `run.completed@1` carrying the receipt. `proof.recorded@1` is added by slice H4b (11.8). 10.69 requires the comment and disposition versions; 10.32 the stage and run events; 10.70 the grouping reason on units. A suggested review is content on the unit, not a disposition event (vocabulary: "not a disposition until a person sends it").

### 10.3 Options

| Question | Options | Recommendation |
| --- | --- | --- |
| PU1. Transaction size | A, one per batch; B, one per event; C, one for the whole packet | A: atomic per batch, small enough to keep transactions short, since a busy SQLite lock blocks the waiting process (the M2 proposal's note on blocking) |
| PU2. Partial packets | A, always publish, with gaps; B, publish only complete packets | A (2.5) |
| PU3. Where content lives | A, events reference computations (digests, delivery content, ledger); B, content inline in events | A: records reference computations and never copy them (5.3) |
| PU4. Viewing before M5 | A, `neuve review show` prints batches, lanes with rationale, digests and dispositions in the terminal; B, an HTML page | A for M3, since the desk is M5's; a rendered page only if the owner wants one for the section 11 review |

### 10.4 Risks

- Schema additions touch Records' projectors; they belong in a Records slice reviewed against M2's rules, not inside the harness.
- A Publish that fails after some batches appended leaves a partial packet; the manifest is written last, so a packet without a manifest is visibly incomplete and a replay completes it.

### 10.5 Parallels

Entire condenses session work into a checkpoint at natural boundaries and marks review sessions with a summary flag for O(1) lookup (`CheckpointSummary.HasReview`, review command, "Flow" step 8 (`docs/architecture/review-command.md#flow` in `entireio/cli`)); the manifest plays the same role for a packet. The M2 proposal's manifest option A is the design adopted in 8.7.

### 10.6 Decisions (Publish)

**Ruled (10.73).** PU1–PU6 as recommended below; section 14 keeps the round 7 table that was put to the owner.

| # | Decision | Recommendation |
| --- | --- | --- |
| PU1 | Transaction size | One append transaction per batch |
| PU2 | Partial packets | Always publish, with gaps disclosed; manifest last |
| PU3 | Content placement | Events reference computations |
| PU4 | Viewing before M5 | `neuve review show` in the terminal |
| PU5 | Schema additions | `review.requested@1` (in H1, with the `review.run` job kind); `unit.recorded@2` with sides and the merge or split reason (10.70), `context.referenced@2`, `assessment.recorded@2`, `comment.recorded@2` with its finding kind and `about` field (10.63, 10.69), `disposition.recorded@2` (10.69), a digest and delivery-content event, `packet.published@1`, `gap.disclosed@1`, `stage.completed@1` and `run.completed@1` (10.32), built in a Records slice with projectors and rebuild |
| PU6 | Run receipt | As tabled in 10.2: route, key variable and organisation; cost by stage; turns per agent and batch against the ruled limits; final generation; actual against expected time; timeout outcome (10.42); partitions; the day-one counts of 10.55, 10.62, 10.63 and 10.70; queue wait; retries; wall time |

## 11. How M3's output is judged before M6

**Ruled (10.71).** What the owner judges at M3's exit, and what measurements exist before M6's scorecard: the recommendation below, with the sample drawn from telemetry's counts. Evidence rules apply: a passing check or test is not approval (7.2, 7.3).

| | What it shows | Cost | Limits |
| --- | --- | --- | --- |
| A. Owner reads one real small range's packet (the plan's exit) | Whether batches, units, lanes, digests and dispositions make sense end to end (1.10) | One owner session | One range, impressions only |
| B. Score Investigate on M4's dev cases with M4's scorer | Necessary and relevant recall, wrong-attribution share, at the real share, for the agentic stage on the same hunks as the retrievers (the M4 proposal's option B for 3.7) | Model spend on the dev cases | Needs dev gold; same-family grading caution |
| C. Owner calibration sheet, decide-then-reveal | For about 20 units across 2–3 ranges (both starting sizes), the owner picks lane and verdict first, then sees the agent's; records first and final answers (9.38, 9.51) | About an hour (an estimate) | Small sample |
| D. Model judge rubric | Cheap, repeatable | Low | LLM judges show position and verbosity biases (Zheng et al.) and share the harness's model family |
| E. Dogfooding on this repository's lanes (7.6) | Real use, vents as friction signals | Ongoing | Slow to produce numbers |

**Recommendation: A, B and C, with E from the first working run.** B makes Investigate comparable to the retrievers it refines, so M4 and M3 report on one scale. C is the first labelled data for lane calibration (section 8.4, 10.57) and for whether Dispose is stricter or looser than the owner. D is not used for any decision.

**What the rulings add to C.** The calibration sample is chosen from what telemetry already counts, so the owner checks the decisions most likely to be wrong:

| In the sample | Why | Count from |
| --- | --- | --- |
| Every request for changes recorded uncited | It closes or returns work on the agent's word alone | Section 3.8 |
| A sample of approvals given without recorded proof, from agentic and human-suggested units | They close units on a code reading, not observed proof (10.62) | The per-lane count of 10.62 |
| Every defect for bogus or forged tests or proof, and a few test-bloat warnings | The new judgement 10.63 asks of the agent | The counts of 10.63 |
| Units with evidence of high complexity but a validation gap, sent to human-suggested | Where an agent's approval can close high-complexity work (10.55) | The count of 10.55 |
| Any run that timed out | What it published and what it disclosed (10.42) | The receipt |

"About 20 units" and "about an hour" are this proposal's starting sizes, not derived; the sheet grows if those counts are larger. **Evidence for judging** follows 7.2 and 10.58: the packet as the CLI shows it, receipts, telemetry and logs; never verify scripts, and a passing test is never the judgement.

**Ruled (10.71).**

| # | Decision | Recommendation |
| --- | --- | --- |
| JU1 | Judging M3 before M6 | Owner reads one real range's packet; Investigate scored on M4 dev cases; a decide-then-reveal sheet of about 20 units (a starting size) drawn from telemetry's counts: every uncited request for changes, a sample of approvals without recorded proof, every forged-evidence defect, units at 10.55's case, and any timed-out run; dogfooding with vents; evidence from receipts, telemetry and logs only |

## 12. Milestone slices

Each slice runs as one implementer and one independent reviewer with disjoint file ownership (7.1, 7.7), and ends with something the owner can open and judge. **Evidence follows 7.2 and 10.58:** this is backend work, so evidence is logs and telemetry: worker and run logs, the run receipt, `neuve review stats`, and Records state shown through Neuve's own commands (`neuve jobs`, `neuve records`, `neuve review show`). Verify scripts are not evidence. `neuve review show` is built in H1 for a run's stages and receipt, and each later slice adds what it produces to it. Tests are written only where a slice states why it needs them (7.3); a passing test or `bun run check` is never the judgement. `neuve records rebuild --verify` is Records' own command, which prints projection checksums before and after a rebuild, not a script written for the slice.

**Shared files.** Lanes run beside each other only when they own disjoint files. Six files are touched by more than one slice, so the slice order hands each one on, never sharing it between running lanes:

| File | First owner | Later owners, after the earlier slice is committed |
| --- | --- | --- |
| `packages/records-schema/src/operational.ts` (`JobKind`) | H1 adds `review.run` | H2 (slot and priority on jobs), H5 (`scope.fetch`) |
| `packages/records-core/src/jobs.ts` (`jobsFor`, `JOB_POLICIES`) | H1 adds `review.requested@1` → `review.run` and its policy | H2 (slots and priorities for every kind), H5 (`cycle.opened@1` → `scope.fetch` and its policy) |
| `packages/records-schema/src/events.ts` | H1 adds `review.requested@1` | H4 (the other versions of section 10.2), then H4b (`proof.recorded@1`) |
| `packages/records-core/src/projectors.ts` | H4 | H4b (the proof projection) |
| `apps/neuve-cli/src/mcp.ts` (Neuve's stdio MCP server, M2's `vent`) | H1, if serving Neuve's tools to the ACP route needs it | H4b (`record_proof`) |
| `packages/records-core/src/schema.ts` (the `migrations` map and `SCHEMA_VERSION`, 6 today) | H4, which reserves migration 7 for its projector tables | H2 needs no migration, because its take query reads slot and priority from `JOB_POLICIES`. If it turns out to need one, it takes migration 8 and commits after H4, since migrations apply in version order. H4b takes the next free version after those, committing after H4 (and after H2 if H2 took 8) |

H4b also owns its new files outright: the proof schema in `records-schema`, the proof store and queries in `records-core`, and `neuve proof` in `apps/neuve-cli`; and `records-core/src/blobs.ts` for the byte-storage port, which no other slice touches.

**Run-folder cleanup has one owner per path** (section 1's table): H1 deletes the folder on the job's final failure and on abandonment (a newer pipeline version, or `neuve jobs drop`), and at the end of its stub pipeline; H2 adds run folders to the daily `retention.prune` sweep (`records-core/src/retention.ts`); H8 moves the success-path deletion into Publish's cleanup step.

| # | Slice | Built | The owner opens and judges (logs and telemetry) | Depends on |
| --- | --- | --- | --- | --- |
| H1 | **Runtime, routes and telemetry** | The review request `review.requested@1`, the `review.run` job kind, its policy and the rule that enqueues it (the exact lines named under shared files); `neuve review <range>` and a first `neuve review show`; run-folder deletion on final failure and abandonment; the workflow with stub stages; keyed activities; stored turns with the run folder's working copies and masking on stage completion (10.14); the Anthropic route with its preflight (10.5, 10.16, 10.17); retries; the budget module with 10.41's turn limits, the shared 8 calls in flight (10.27) and the 10-minute lifetime with the 9:45 cut-off (10.26, 10.42); the toolkit (zod, MCP hints); the final generation (10.11); the vent tool with reconciliation IDs; telemetry as tabled in 3.8 (10.32): spans, attempt usage and cost, the stage records and the receipt written to the run log until H4's `stage.completed` and `run.completed` events land, after which Records holds them (10.32), and the OTLP export only from user-level settings; the ACP route kept runnable for tests. It also records what `@effect/ai-anthropic` 4.0.0 does with the strict tool flag, `tool_choice: none` with structured output, the JSON Schema keywords structured outputs reject, and the append-only message list; retires spike risk 3; converts sample and configured MCP tool schemas with `z.fromJSONSchema`, refusing lossy ones (10.53); measures per-turn latency at `medium` to replace section 2.5's 8-second estimate; calibrates UN9's byte estimate against the provider's free token counts | Worker logs of a SIGKILL mid-stage and the resume, showing completed turns never re-called and no prefix-mismatch error; the same after deleting the working copy, with the stage restart disclosed on the receipt; a stub run stopped by the 10-minute limit, its receipt showing what it published; the receipt's route, credential variable name (never its value), turns against limits and cost; the measured turn latency and the estimate-against-count calibration in the run log; the conversion log listing any refused tools; one ACP turn calling Neuve's tools; `neuve jobs` showing the `review.run` job enqueued with its request, and the run folder gone after a dropped job and after a final failure | M2 |
| H2 | **Worker slots (10.31) and the run-folder sweep** | In `records-schema/src/operational.ts` and `records-core`'s queue, worker, job policies and retention files only: each job kind gains a slot and a priority; two worker loops, an interactive slot for `review.run` and a background slot for everything else, each taking its most urgent job first; retries, stall recovery and deadlines unchanged; still one worker per repository with no lease (8.2); `retention.prune` sweeps run folders whose run has no waiting, delayed or active job, and any older than 30 days (8.10) | `neuve jobs` showing each job's slot and priority; worker logs from a commit burst queued behind and around a `review.run`, showing the review taken at once in its slot while the background backlog drains; the prune job's log listing the run folders it removed | H1 |
| H3 | **Shared review rules (10.21)** | The kept rules (owned ranges, submitted hunks, comment anchors, lineage) moved from the web app's backend into a package the harness and the web app both import, ported to zod and plain TypeScript. The slice's tests are the rules' existing tests, moved with them, because these rules decide what a unit owns | Judged where the rules are first used: H5's range manifest, with each hunk's owned ranges and sides on a real range, shown by `neuve review show`. Nothing in the web app imports these rules today and the desk shows empty states until M5 (8.5), so the desk cannot show the move; the moved tests passing is not the judgement | M2; beside H1 |
| H4 | **Records event versions (PU5)** | In `records-schema/src/events.ts` and the `records-core` projectors and rebuild (not the files H2 owns), after H1: the event versions of section 10.2 other than `review.requested@1`, old versions still decoded, with projectors (including the product-metric projections `neuve review stats` reads) and rebuild. Tests only for decoding old and new versions side by side, because a rebuild must never lose an event | `neuve records rebuild --verify` over a log holding old and new events, showing matching checksums; the new events listed by `neuve records` | H1; beside H2 |
| H4b | **Proof records (11.3, 11.8)** | A proof record is one `proof.recorded@1` event: its **kind** (`static-analysis`, `test-run`, `telemetry`, `log`, `screenshot`, `video`; `static-analysis` is the output of an analyser the repository declares, such as a type checker or linter, because a plain reading of the code adds nothing beyond the diff the reviewer already reads); the **range** and the **revision** (commit OID) it observed; its **claim**, a capped sentence of what it shows; the **validation requirement** it serves, named by the scope snapshot's obligation or definition-of-done item when the cycle has one, else in the recorder's words for Assemble to match; the recorder (actor and session, M2's identity); and a **reference to the stored artefact** in the computation store's blobs, with its hash and media type. Records keep every record; nothing is overwritten. **Retention:** an artefact is a raw capture with the 30-day retention (8.10) until a published packet cites it; Publish then promotes it to durable, because re-reviews reuse it (4.7, 10.68). **Recording:** `neuve proof record` on the CLI, and a `record_proof` tool on Neuve's stdio MCP server for inner-loop agents; browser work records what the Chrome DevTools MCP captured (screenshots, video, console and network logs), saved by the agent and recorded through the same tool (7.2, 7.6). Neuve does not proxy DevTools. Recording is outside the harness, so the harness's tracked-work rule (10.34) is unchanged: agents read only the records and their stored artefacts. Assemble and Dispose see who recorded each proof, and weigh the implementer's own proof with 10.63's skepticism, as guidance. **Reading:** a `proofs` pager and `proof(id)` reader for Assemble and Dispose (sections 8.4 and 9.2), within the tool-result cap, so no closed sum changes. Telemetry counts records by kind, stale records and coverage by level (10.32). **Storage (11.12):** artefacts are kept on the local filesystem for now, with no storage-cost tracking. They go through the computation store's `BlobStore` service (`records-core/src/blobs.ts`), which is already content-addressed (`put`, `get`, `inspect`, `prune` by hash, with media type and retention class). It is not yet the hosted-ready interface: its one layer couples the SQLite row with the local file and keeps small blobs inline in the database. H4b splits a byte-storage port out of it (put, get and delete by content hash, with media type; no listing, renaming or partial writes), designed so Cloudflare Durable Objects or a similar hosted object store can implement it; the local filesystem implements it now, and rows and retention stay in Records. Tests only for decoding and the currency check, because a record wrongly treated as current would pass as proof | `neuve proof list <range>` showing an inner-loop agent's records from dogfooding this repository, with kind, revision, requirement, claim and the stored artefact; a browser change's DevTools captures recorded through MCP; a record made before a later change to the unit's files shown as stale; a promoted artefact's retention after a published packet cites it; `neuve records rebuild --verify` with proof events | H4 |
| H5 | **Precompute, scope and integrations** | The `commit.prepare` handler in the background slot (10.20, PC13, PC15); range manifest and change facts (10.22); the BM25 index and retriever port (10.25, XC18); the scope fetch with strata (PC5) and identifier masking (10.8, 10.24); the MCP client service (10.51), the user-level integration file (10.52), the proxied read tools and the cycle snapshot (10.53); the fallback with no integration configured (10.54). The cycle-start fetch runs as a `scope.fetch` job in the background slot (10.31), enqueued by the existing `cycle.opened@1` event and keyed by cycle; a review whose snapshot is not ready runs the same keyed computation inside Precompute, sharing the in-flight attempt, so a cycle's scope is fetched once. H5 owns that kind, its policy and its `jobsFor` case | `neuve jobs` showing commit preparation in the background slot at nice 10 during a burst; a range manifest for a real range with allowances, strata, and each hunk's owned ranges and sides from H3's rules, shown by `neuve review show`; `neuve jobs` showing the `scope.fetch` job a cycle opening enqueued; a stored scope capture for a real Linear ticket with identifiers masked; the gap disclosed on a range with no integration; the fetch's spans and timing in the run log | H1, H2, H3, H4 |
| H6 | **Understand and Investigate** | Both agents; the partition estimate and packing (10.1, 10.35–10.38, UN6, UN9); the merge agent; the evidence ledger with lineage (10.47); preloaded leads (10.43); the procedural lookups (10.44–10.46); parallel partitions on the shared calls (10.50); fallbacks | A change map and ledgers for a real range, shown by `neuve review show`; the receipt's turns, tokens and estimated against measured context per partition; per-agent spans showing partitions running in parallel | H5 |
| H7 | **Assemble** | Batch confirmation; units with the 20-line default inside the 10–40 range (10.59, 10.70); context references; lane assessments with two levels per axis and cited factors (10.55–10.58); digests and the Facts, Briefed and Explained stops (10.60, 10.61) | Batches with units, lanes and rationales for a real range in `neuve review show`; each validation requirement's coverage with the proof records it cites, including one `solid` requirement whose kinds converge and one `shallow` with a single kind; telemetry's unit counts at 10, 20 and 40 lines with every merge and split; the count of 10.55's case | H6, H4, H4b |
| H8 | **Dispose and Publish** | Lane-blind per-unit reviews in fresh contexts (10.33, 10.64, 10.65), with defect claims checked against the code (10.66) and tests and proof judged under 10.63; Guided rows judged against the unit's proof records, with disagreements between sources as findings (11.1); approvals without recorded proof disclosed (10.62, while it holds); the Guided stop (10.67); findings as anchored comments (10.69); Publish per section 10, including the success-path run-folder deletion; `neuve review show` completed | **The plan's M3 exit:** `neuve review <range>` on a small real range produces the whole packet in Records, read through `neuve review show`, with its receipt and the day-one counts in `neuve review stats`, and Guided rows `met` where the recorded proof converges | H7, H4, H4b |
| H9 | **Judging** | Section 11: M4 dev-case scoring of Investigate; the decide-then-reveal sheet drawn from telemetry's counts | The scores beside M4's retrievers, and the owner's sheet with first and final answers | H8, M4 dev gold |

**Not a slice here.** The release binary with Bun's `.env` and `bunfig.toml` autoloading off (10.34) is the separate session the owner scoped, outside these slices.

**Ruled (10.72).** The slices and the shared-files table above are the build plan.

| # | Decision | Recommendation |
| --- | --- | --- |
| SL1 | Slice order | H1 first, with H3 beside it; H2 and H4 beside each other once H1 is committed; H4b once H4 is committed, beside H5 and H6; then H7, H8 and H9 in order, H7 after H4b. Shared files pass from slice to slice as tabled above |

## 13. Vocabulary proposals

**Ruled (10.58).** "Validation requirement" is now in the [vocabulary](../../vocabulary.md), in the owner's wording: met by observed proof (logs, screenshots and video for browser-facing work; telemetry and logs for server-facing work), not custom scripts, with tests as a minimal base and bogus or forged tests or proof treated as defects. No other vocabulary proposal is open.

Internal words (packet, stage, run, route, activity, turn, handle, lead, allowance, evidence ledger, change map, candidate batch, behaviour, change facts, movement, lean, finding, coverage line, run folder, partition, procedural lookup, lineage, final generation, run receipt) stay internal and need no entries.

## 14. Decision list for the owner

**No decision is open.** Conflicts C1–C12 and every decision in this proposal are ruled in [Area 10](../decisions.md#area-10-harness-m3-18-october-2026), 10.1–10.77, and aligned with [Area 11](../decisions.md#area-11-verification-and-review-delivery-19-october-2026) (11.1–11.12). No open point remains. 11.8 makes proof recording slice H4b of M3 (section 12); 10.4 and 10.62 hold until H4b's proof records land, and are revisited then (11.8). Section 12's slices and shared-files table are the build plan (10.72).

**Round 7 at a glance, as put to the owner (now ruled as 10.71–10.77).**

| Decision | What the reader sees | Product principle it serves | Parallels |
| --- | --- | --- | --- |
| PU1 transaction per batch | A batch is in Records with all its units, references, assessments and dispositions, or not at all; never half a batch | Range immutability: a package does not change after it is frozen (5.5, 8.7) | The M2 proposal's note that a busy SQLite lock blocks the waiting process, which keeps transactions short |
| PU2 partial packets | A packet even when a stage failed or the run timed out, with what is missing listed as gaps; a packet without its manifest shows as incomplete | Gaps disclosed, never a dead end (2.5); a timed-out run publishes what completed (10.42) | No outside parallel found; this follows the rulings |
| PU3 content placement | Digests and delivery content that are exactly what the agent wrote, unchanged by later runs | Records reference computations and never copy them (5.3); dispositions are never regenerated (4.7) | Entire Graph's boundary rule, "would this make two identical requests differ?", which the computation key applies (section 1) |
| PU4 viewing before M5 | In the terminal: batches, units, lanes with rationale, digests, dispositions and gaps | The desk is M5's; M3's exit is the owner reading one real packet (the plan) | Neuve's own M2 commands (`neuve records`, `neuve jobs`) show Records state the same way |
| PU5 schema additions | Comments anchored to lines, requests for changes linked to their defects, gaps and receipts, all surviving a rebuild | Records is the source of truth (10.32); a review comment is informational until a disposition references it (vocabulary) | Records' append-only log with versioned events (0004) |
| PU6 run receipt | For the owner: what a run cost, how long each stage took against what was expected, whether it timed out, and how often the rulings' watched cases occurred | Telemetry from the start (10.16, 10.32); tokens as a tracked measure (foundation 01) | Anthropic's multi-agent post: token use explained most of the variance on one benchmark (secondary summary only) |
| JU1 judging before M6 | One real packet to read; Investigate's scores on the same scale as M4's retrievers; a sheet where the owner decides before seeing the agent's call, weighted toward the cases telemetry flags | Approval comes from review, never from checks or tests (7.2, 7.3); validation is observed proof (10.58) | The labelling track's decide-then-reveal (9.38, 9.51). LLM judges show position and verbosity biases (Zheng et al.; abstract only), so no model judge decides. OpenAI's audit of SWE-bench Verified (research memo), a reminder that passing tests are not the judgement |
| SL1 slice order | After each slice, something to open: logs, receipts, `neuve jobs`, `neuve review show` (section 12) | One implementer and one reviewer per lane (7.1); evidence is logs and telemetry (7.2, 10.58) | The M2 proposal's slices, each ending in logs or a command's output the owner can judge (for example, logs of a SIGKILL mid-job, then restart) |
| XC9 tool rules | Context references at the reviewed revision with path and lines; "searched here, found nothing" instead of silence | Tracked work only (10.34); gaps disclosed (2.5) | SWE-agent's windowed viewer and compact search (abstract and summaries only); Unblocked's valid but empty query; Anthropic's warning on overlapping tools |
| XC10 evidence ledger | Each context reference with why it applies, Before you decide, its stance and how it was found | The context reference contract (0006); Before you decide (9.8) | Unblocked's context bundles with links; Entire Graph's "selected view, not an exhaustive inventory", which the coverage lines follow |
| XC11 context growth | Nothing directly: an agent never loses earlier evidence mid-review | 10.12 and 10.18, already ruled | Anthropic's preserved-thinking rules, under which clearing or shortening an earlier tool result invalidates later thinking |
| XC12 prompt layout and caching | Nothing directly: lower cost and time on the receipt | The 10-minute run (10.26); tokens as a tracked measure (foundation 01) | Anthropic's long-context and pasted-content guidance; Entire's judge prompt treating reports as untrusted data; "Lost in the Middle" (abstract only) |
| XC13 concise output | Short digests and reviews; no padded "none" sections | Concise output (2.14); noise is reviewer's tax (foundation 05) | Entire found fixed headers padded clean changes; Anthropic recommends a few canonical examples over lists of edge cases |
| XC14 stopping | A stage's output even at its turn limit, never an error; the receipt says when the final generation ran | 10.11; gaps, never a dead end (2.5) | Anthropic's guidance for unattended agentic runs on Opus 5.5 |
| XC15 retries | Retries and their causes on the receipt; a refused or failed call as a disclosed gap | Recovery (2.6); gaps disclosed (2.5) | Unblocked feeds query errors back with bounded repair |
| XC16 isolation and CPU | Nothing directly: reviews never read untracked files, and the machine stays responsive during a review | Isolation (2.16); bounded CPU (6.10); tracked work only (10.34); 10.64 for Codex once it can run read-only | Entire's review command gives each reviewer its own environment; Entire Graph's interactive commands default to the working tree, which the harness avoids |
| XC17 vent actors | In the owner's vents, at most one per stage per run, grouped by cycle | Vents (2.15, 8.16, 8.17) | Entire tags each review session through its own environment variables |
| XC18 retriever before M4 | Leads in context references marked by how they were retrieved | M4 decides the retriever; the simpler arm wins when results are inconclusive (9.21); 10.25 | Braintrust's comparison: agentic search matched vector retrieval at a quarter of the cost on about twenty tasks (talk notes) |
| PC5 scope strata | Guided rows and obligations citing the ticket, plan or commit text they rest on, with its stratum; "scope missing" when nothing was found | Scope is part of context (9.6); weak scope is stratified (9.13) | The labelling track's strata; Unblocked resolves identities in plain code, with a model only as tiebreaker |
| PC13 commit-time precomputation | A review that starts sooner, with the same leads it would compute at the request | The 10-minute limit and the two-minute target (10.15); Precompute per commit (10.20) | Entire CLI's hooks record fast and do heavy work later; Entire Graph keys caches by tree |
| PC14 when the inner loop's cycle starts | The Guided stop's scope ready when the review starts | Scope fetched at cycle start (3.12, 10.53) | No outside parallel found |
| PC15 bursts | Commits landing during a review do not slow it | Bounded CPU (6.10); two worker slots (10.31) | Entire Graph keys its caches by tree and has no per-edit incremental invalidation, as coalescing by tree and blob does |
| PC16 model work at commit time | Nothing directly: no model spend on every commit | Measure before spending (10.30); tokens as a tracked measure (foundation 01) | Anthropic's multi-agent post on token cost (secondary summary only) |
| UN6 partition count | Batches by behaviour, whatever the partitions (10.36) | Least fragmentation (10.1, 10.35–10.37) | ClusterChanges splits changesets by def-use relationships (abstract and secondary summaries only) |
| UN9 counting D(u) | On the receipt, each partition's estimated and measured context | The estimate decides partitions (10.1); every worst case under the ceiling (10.18) | The provider's free token counting, which H1 calibrates against |

**Ruled index.** From round 7, JU1 (10.71), SL1 (10.72), PU1–PU6 (10.73), PC14 (10.74), PC13, PC15 and PC16 (10.75), PC5 (10.76), XC9–XC18, UN6 and UN9 (10.77); from round 6, DI1 (10.64, which also settles the "Open from Area 2" question on per-unit calls over ACP for Dispose; Assemble's unit groups over ACP stay open, and the turn-limit question there was settled by 10.7 and 10.41), DI2 (10.65), DI3 (10.66), DI5 (10.67), DI7 (10.68), DI8 (10.69), DI9 (10.63), DI10 (10.62), AS7 (10.70); from round 5, AS1 (10.59), AS2 (10.60), AS3 (10.57, 10.58), AS4 (10.56), AS5 (10.55), AS6 (10.61), VO1 (10.58); DI4 (10.19, 10.30); DI6 (10.33, lane-blind review); from round 4, XC30 (10.42), IN1 (10.50), IN2 (10.43), IN3 (10.48), IN4 (10.44), IN5 and IN6 (10.49), IN7 (10.45), IN8 (10.46), IN9 (10.47), PC9 (10.51), PC10 (10.52), PC11 (10.53), PC12 (10.54); from round 3, XC20–XC23 (10.26–10.30), XC24–XC26 (10.32), XC27 (10.33), XC28 (10.31), XC29 (10.34), UN1 (10.39), UN2–UN4 (10.40), UN5 (10.35), UN7 (10.36), UN8 (10.37), UN10 and UN11 (10.38); from round 2, XC1, XC19 (10.13), XC2 (10.14), XC3 (10.15), XC4 (10.16, 10.17), XC5 (10.18), XC7 (10.19), PC1 (10.20), PC2 (10.21), PC3 (10.22), PC4 and PC7 (10.23), PC6 (10.24), PC8 (10.25); from round 1, the former XC6 (10.2), XC8 (10.7, since revised by 10.41), the batch-split decision (10.1), Graph relations (10.10), gaps on high-and-hard units (10.9), static automation (10.4), history (10.3), the 1.6 reading (10.6) and the external-fetch credentials (10.5).

## 15. Sources and limits

**Relied on most.** The [decisions record](../decisions.md), including [Area 10](../decisions.md#area-10-harness-m3-18-october-2026); the retrieval introspection audit (kept privately) and its diagrams (gitignored scratchpad); the NEU-13 scope snapshot (`.scratchpad/neu-design-20261005/coordinator/neu11-upstream-next-01/research/NEU-13.json`); architecture records [0003](../../architecture/decisions/0003-effect-native-harness-runtime.md), [0005](../../architecture/decisions/0005-harness-pipeline.md), [0006](../../architecture/decisions/0006-hybrid-retrieval-and-context-references.md), [0007](../../architecture/decisions/0007-batches-units-lanes-and-cycles.md) and [0008](../../architecture/decisions/0008-model-routes-and-budgets.md); the [M2](m2-records.md) and [M4](m4-benchmark.md) proposals; the code cited in Starting facts; the runtime spike's README; Anthropic's documentation on [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), [preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking), [thinking and forced tool use](https://platform.claude.com/docs/en/build-with-claude/thinking#response-prefill-and-forced-tool-use), [structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs), [prompting Opus 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5) and [context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents), read through a summarising fetch rather than in full; Entire's review command (`docs/architecture/review-command.md` in `entireio/cli`) and judge prompt; the repository's Unblocked notes (kept in the private archive), [review and verification survey](../../research/02-review-and-verification.md) and [hub-signal survey](../../research/hub-signals.md).

**Seen only as abstracts or secondary summaries.** SWE-agent; Agentless; "Debate or Vote"; KnowNo; Kamei et al.; McIntosh et al.; Cihan et al.; AutoCommenter; Fregnan et al.; Zheng et al.; Mozannar and Sontag; "Lost in the Middle"; Bacchelli and Bird; Xiong et al.; Geifman and El-Yaniv; ClusterChanges (its "over 40%" figure comes from secondary summaries); Herzig and Zeller; Anthropic's multi-agent research post; Anthropic's "Writing effective tools for agents" (introduction only, not cited for specifics). Their numbers are quoted as the abstracts state them.

**Measured here.** Per-call latency of Opus 5.5 tool loops (section 2.5), read-only from this repository's Claude Code transcripts in `~/.claude/projects/` on 18 October, with a script in the session's temporary folder; Claude Code sessions, not the harness at `medium`.

**Thin evidence.** No published study measures lane-style routing of review units to agents and humans; the deferral literature is from classification and robotics, and the JIT defect work predicts defects, not reviewability. The proximity numbers (20 lines, 400 changed lines), the sizing constants (r = 3,000, o = 2,000, F = 20,000), the estimate's constants (A = 2,000, γ = 4,000), the 1% specificity threshold and the turn limits are starting points to measure on receipts, not findings.

**Unverified.**

- Whether `@effect/ai-anthropic` 4.0.0 passes the strict tool flag, `tool_choice: none` together with structured output for the final generation, and turn-scoped system messages, and whether its message handling stays append-only under preserved thinking; slice H1 checks each.
- Whether the provider's responses identify the billed organisation, so a receipt could show it without Neuve managing credentials (2.1).
- How a background worker started by launchd or a hook gets the user's provider environment variable under 10.5 (2.1).
- Whether bytes ÷ 3 × 1.3 (UN9) is conservative for every language and for diffs heavy in non-Latin text; H1 calibrates it.
- Whether `@effect/ai-anthropic` strips the JSON Schema keywords structured outputs and strict tools reject; H1 checks it.
- That `git grep -w` treats only letters, digits and underscore as word characters on every platform the worker runs on (IN8's fallback assumes it).
- Whether the workflow engine's boot-time resume can be left to the job queue, and whether `"memory"` runner storage behaves as the M2 proposal expected (XC19).
- Whether common test runners and documentation tools expose their globs in a form PC7 can read.
- The owner's API account creation date; the design assumes preserved-thinking checks are enforced (accounts from 31 August 2026).
- Whether the provider's terms allow a subscription route for the harness (2.1).
- The harness's real per-turn latency at `medium` (estimated at 8 s), the owner's API rate limits for 8 calls in flight (XC21), and whether `--no-compile-autoload-dotenv` and `--no-compile-autoload-bunfig` behave as [Bun's executables page](https://bun.com/docs/bundler/executables) describes; H1 checks the release build.
- Whether Linear's hosted MCP server accepts an API-key header (otherwise it needs OAuth, which PC10 cannot store), and whether `@modelcontextprotocol/client` 2.x passes the 10-day release-age policy (PC9).
- That `z.fromJSONSchema` converts real servers' tool schemas (Linear's in particular) without loss; H1 checks it on the configured servers, and a lossy schema means the tool is refused.
- Whether Opus 5.5's preserved thinking survives the hand-written tool loop (spike risk 3); slice H1 retires it.
- Whether `DurableClock` gives the run's 10-minute clock durably across a resume (untested in the spike).
- Whether every package manager declares its lockfile in a way PC4 can read.
- Effect 4's `Tokenizer` for Anthropic; the budget module can fall back to the free token-counting endpoint.
