# Existing Neuve product evidence

Later clarification: the user established Git hunks and surrounding hunk clusters as the review-unit starting point. Proposals below to make behavioral claims the primary unit are superseded. See [the current foundation](../foundations/04-review-units-and-context.md).

Research snapshot: 2026-09-17. Repository: the legacy Neuve repository (kept privately), HEAD `522501bc007beefc8d1ed116d805ec0454a56392`. The worktree was clean when inspected. This is a read-only investigation of selected original documents, history, current whitepapers, and routing code. It does not accept any existing architecture as a constraint on the rebuild.

## The original promise

Source fact. The first repository commit, `020c4438` on 2026-05-01, contains seven research documents. Its `docs/research/review-triage/concept-report.md`, lines 3–25, describes an author-side pre-review assistant. Its job is to explain review posture, evidence gaps, and reviewer focus before a human opens the diff. The earliest artifact inspected is already a synthesis, not a verbatim original user PRODUCT record. Reproduce with `git show 020c4438:docs/research/review-triage/concept-report.md`.

Source fact. The next concept revision, `f7bb9dd1`, makes correctness explicit. The current concept report (legacy repository `docs/research/review-triage/concept-report.md:5`, kept privately), lines 5–25, asks what correct means, how clear the source of truth is, which parts are verifiable, which evidence is missing, and who should review. It identifies the PR author as primary user and the reviewer as secondary user.

Source fact. The report's outcome is better allocation of attention. Its calibration section (legacy repository `docs/research/review-triage/concept-report.md:134`, kept privately), lines 134–184, proposes measuring useful review, missing context requests, correction patches, false posture classifications, and reviewer satisfaction. It does not make artifact volume or number of checks a success measure.

Inference. The most reusable product promise is that Neuve helps a person know what a change claims, which claims have support, and where their judgment is still needed. The old command names and stores are mechanisms that attempted to deliver that promise.

## Original product records beyond filenames

A focused follow-up checked `PRODUCT` as a possible record category, not only a filename. Text searches covered documentation and hidden `.neuve` files. Read-only SQLite queries inspected the source index and the `local-workflow` board snapshot. No `PRODUCT` category appeared in the inspected source registry. This is a bounded search, not a claim that the user's original records do not exist.

The strongest additional early record is V0 criteria and interview notes (legacy repository `docs/research/review-triage/workstreams/criteria-interview.md:3`, kept privately), introduced in commit `9590f7c6` on 2026-05-02. Lines 3–23 explicitly claim to capture criteria established by the user. They name correctness, decomposition into verifiable parts, posture-controlled automation, an evidence ledger, privacy, and provider-neutral integrations. They also include stack decisions, which the current user explicitly wants reopened. The document is a recorded summary of owner direction, not a raw conversation transcript.

The local board also registers the concept report as a primary source. The record is in the legacy repository's `.neuve/kanban/boards/local-workflow/kanban.sqlite`, table `board_snapshots`, row `slug=local-workflow`, JSON collection `sourceRefs`, record `sourceId=SRC-CLI-1784035126852-3`. Its `classification` is `primary` and its `pathOrUrl` is `docs/research/review-triage/concept-report.md`. The board currently contains 308 source references classified as primary, decision, supporting, evidence, or anti_source. None uses a product category. These are local mutable records outside the commit identity stated above.

The metadata database at the legacy repository's `.neuve/metadata.sqlite` contains source references in `source_file_index_entries` and extracted claim categories in `source_file_index_claim_refs`. The inspected categories are acceptance criterion, ambiguity, constraint, non-goal, requirement, risk, user impact, and verification instruction. Product-related source paths led to product review memos rather than an original PRODUCT registry.

An early concrete expression of the intent appears in early review-readiness product requirements (legacy repository `docs/research/review-triage/workstreams/v0-03-local-mcp-review-readiness/prd.md:3`, kept privately), lines 3–19. It asks for source truth, decomposition, verification plans, evidence, and posture, and explicitly separates easy verification, proxy verification, human judgment, and unknowns. These early records are stronger grounding for product intent than later implementation closeout reports.

## Product claims worth bringing into discussion

These are claims supported by the old documents, not newly accepted principles.

- A review should start with expected behavior and intent. Code, tests, runtime observations, system fit, and uncertainty all matter. A ticket is evidence about intent, not merely a link on a PR. Concept report, lines 31–43 (legacy repository `docs/research/review-triage/concept-report.md:31`, kept privately).
- A change can contain different review obligations. An authentication change, copy edit, and rollback path need not share a single verdict. Concept report, lines 45–62 (legacy repository `docs/research/review-triage/concept-report.md:45`, kept privately).
- Every correctness claim needs a source, supporting evidence, an account of missing evidence, and a relation to the intended outcome. The evidence ledger is a Neuve synthesis. The document explicitly does not attribute that term to Lauritzen. Concept report, lines 64–92 (legacy repository `docs/research/review-triage/concept-report.md:64`, kept privately).
- Agents should receive bounded correctness work, including verification and skeptical review. Concept report, lines 105–119 (legacy repository `docs/research/review-triage/concept-report.md:105`, kept privately).
- A risk label is a routing judgment, not proof or permission to merge. The initial concept already warns about false authority and alert fatigue. Concept report, lines 60–62 and 186–190 (legacy repository `docs/research/review-triage/concept-report.md:60`, kept privately).
- Users need compact decisions with inspectable reasons. Progressive disclosure begins with the next useful review action and preserves the evidence behind it. Review intelligence whitepaper, lines 472–485 (legacy repository `docs/whitepapers/review-triage/review-intelligence-whitepaper.md:472`, kept privately).

## Quadrants currently mean several different things

Source fact. The legacy review-unit decision-matrix document records accepted owner direction as validation difficulty on X and complexity, blast radius, semantic effect, or similar effect on Y. It assigns lower-left work to deterministic checks, higher-left work to agents unless a hard gate applies, and higher-right work to humans. It does not define a precise lower-right policy in that accepted-direction list. accepted decision-matrix direction, lines 7–16 (legacy repository `docs/research/review-triage/workstreams/v0-44-review-unit-decision-matrix/hitl-decisions.md:7`, kept privately).

Source fact. The current whitepaper calls X ease of validation and Y risk/impact. It explicitly says complexity is not a route input. It also distinguishes quadrant, route, and assignment tier. Review intelligence whitepaper, lines 185–189 (legacy repository `docs/whitepapers/review-triage/review-intelligence-whitepaper.md:185`, kept privately).

Source fact. The implementation maps quadrants to routes only after hard gates. Its normal mapping is:

| Quadrant | Route before later assignment projection |
| --- | --- |
| Low risk, easy validation, with qualifying passed verifier evidence | `CiClearable` |
| High risk, easy validation | `AgentDelegable` |
| Low risk, hard validation | `FocusedHuman` |
| Low risk, easy validation, without qualifying evidence | `FocusedHuman` |
| High risk, hard validation | `StrictHuman` |
| Unknown | `Unmapped` |

Source: review_unit_route, lines 16–51 (legacy repository `crates/git-scan/src/review_matrix_routing.rs:16`, kept privately). Security/policy, schema/contract, runtime/lifecycle, and broad/destructive gates force `StrictHuman`. Missing verifier evidence forces `FocusedHuman`. Missing change evidence forces `Unmapped`.

Source fact. The subsequent assignment projection collapses `CiClearable` and `AgentDelegable` into one `AgentDelegable` tier. It maps focused review to `HumanSuggested` and strict review to `HumanRequired`. An unmapped unit with missing change evidence can become human-suggested if no stronger gate intervenes. review_assignment_tier, lines 54–90 (legacy repository `crates/git-scan/src/review_matrix_routing.rs:54`, kept privately).

Inference. The user's four desired review categories are not equivalent to the four geometric quadrants in this implementation. Keeping all four categories visible will require specifying whether they represent responsibility, verification method, residual risk, or workflow state. These can disagree. A high-impact unit can have a deterministic proof for one obligation and need human judgment for another.

Unresolved questions for the rebuild:

- Is risk an inherent property of a change, or residual uncertainty after evidence? Those produce different movement through the matrix.
- Does validation difficulty describe a task before tooling exists, or the evidence actually available now?
- Is agentic review a distinct kind of evidence, a routing destination, or a procedure used in every quadrant?
- Does human-required mean only a person can decide, or that an automated system has insufficient evidence?
- Is unknown a temporary investigation state, a fifth route, or grounds for mandatory human intervention?
- Can several review obligations coexist within one unit, or must splitting always produce one route per unit?

## What a review unit means is not settled

Source fact. The legacy decision-matrix defaults start with file/path groups carrying hunk references. Hunk-level splitting is deferred. initial grouping defaults, lines 18–35 (legacy repository `docs/research/review-triage/workstreams/v0-44-review-unit-decision-matrix/hitl-decisions.md:18`, kept privately).

Source fact. Current code defines hunk, hunk group, and file granularities. It marks semantic hunk grouping as reserved for future work. A `ReviewChangeUnit` has a path, optional previous path, parent file unit, hunk identities, and line ranges. Change unit types, lines 6–15 and 60–83 (legacy repository `crates/git-scan/src/change_units/types.rs:6`, kept privately).

Inference. A diff fragment is not necessarily a independently verifiable behavioral claim. One behavior can span files, and one hunk can implement several obligations. The current structural units provide useful anchors, but they do not establish the product definition of a review unit.

Proposal for discussion only. Define a unit using a concrete claim, its authority, affected behavior, a verification method, and residual judgment before deciding how files and hunks represent it. Test the definition against an authorization change spanning middleware, routes, migration, and tests. Do not select a graph schema yet.

## Decomposition is central in the research but incomplete in the command implementation

Source fact. Lauritzen's saved notes identify planning and reviewing as expensive relative to execution. They connect trust to verifiable loops, proxy checks, decomposition, control at intermediate work nodes, and persistent artifacts. Talk notes, lines 15–29 (legacy repository `docs/research/review-triage/jacob-lauritzen-talk-notes.md:15`, kept privately).

Source fact. The raw saved excerpt describes decomposing contract drafting so humans choose risk profile, precedent documents, and negotiation stance while tools check formatting and definitions. It distinguishes an actual verification from a proxy such as similarity to prior contracts. Saved transcript, lines 5–13 (legacy repository `docs/research/review-triage/vide-transcript.txt:5`, kept privately).

Source fact. The whitepaper says a good slice has source-backed expected behavior, inspectable scope, a scoped check where possible, an explicit proxy label when necessary, and escalation for genuine human judgment or missing authority. Decomposition and verification, lines 487–497 (legacy repository `docs/whitepapers/review-triage/review-intelligence-whitepaper.md:487`, kept privately).

Source fact. `scope` and `decompose` still dispatch through `stub_repo_command` in current code. CLI dispatch, lines 1152–1165 (legacy repository `apps/local-cli/src/main.rs:1152`, kept privately). The whitepaper's broad statement that `verify` is a stub is stale or incomplete. The current dispatcher has concrete `verify evidence required` and `verify scoped-checks` command paths. CLI dispatch, lines 1170–1186 (legacy repository `apps/local-cli/src/main.rs:1170`, kept privately). This investigation has not audited those implementations.

Inference. The system developed substantial routing machinery before fully expressing the decomposition mechanism that should reduce review work. This ordering is a plausible source of architectural complexity, not a proven sole cause.

## Specific tensions in the accumulated design

### Conservative routing can create the human burden it aims to reduce

Source fact. `hard_gates_for_review_unit` turns ordinary `SourceChange` into a `RuntimeOrLifecycle` hard gate unless particular structured metadata, test, or generated conditions exempt it. This gate forces strict human review. Routing implementation, lines 93–124 (legacy repository `crates/git-scan/src/review_matrix_routing.rs:93`, kept privately).

Inference. For changes satisfying these conditions, routing to humans follows from file classification before semantic investigation can establish a narrower obligation. This is a concrete design tension with the goal of moving verifiable work into automated review. It does not establish how often that happened in production; that needs a corpus measurement.

### The classifier can investigate but cannot reduce the routing burden

Source fact. Current classifier output is advisory. It cannot clear blockers, lower required human posture, resolve source conflict, or make a file agent-ready. Classifier boundary, lines 175–181 (legacy repository `docs/whitepapers/review-triage/review-intelligence-whitepaper.md:175`, kept privately).

Inference. This preserves a useful authority boundary, but a rebuild must identify what accepted evidence or authorized action can change a route. Otherwise every route reduction requires a separate mechanism or human intervention even after a good agent investigation.

### Decision provenance is an intended feature with fragmented implementation

Source fact. The breadcrumb proposal reports three stores and three actor/event models. It describes coarse MCP actor identity, missing cross-store decision correlation, and unequal recording across CLI, MCP, and Kanban. It also says the specified `DataManifest`, `DecisionLog`, and `record_decision` were not built at that paper's baseline. Breadcrumb paper, lines 33–89 (legacy repository `docs/whitepapers/unified-breadcrumb-substrate-whitepaper.md:33`, kept privately).

Inference. A shared vocabulary for observation, decision, evidence, actor, and scope deserves discussion before storage architecture. The paper's proposed compatibility layer should not become a rebuild constraint. Its as-built claims require a fresh code audit before being treated as current implementation facts.

### The compact review brief grew into a campaign system

Source fact. The progressive-review current-state paper describes broad lazy scans, focus seeds, focused investigation, branch blocks, checkpoints, and remaining campaign work. It reports that metadata-first subject decomposition remains a large-range gap and that output still crowds the local question. Current-state paper, lines 42–80 (legacy repository `docs/whitepapers/review-triage/v1-73-large-branch-progressive-graph/progressive-review-current-state-whitepaper.md:42`, kept privately).

Inference. This may be necessary for large changes, but it expands the original author-side readiness job into ongoing review coordination. The rebuild should explicitly decide how development supervision, in-loop antagonistic review, post-validation review, and merge decisions relate. The existing commands do not answer that product question by their existence.

### Local-first operation had a measurable resource cost

Source fact. The July 3 incident report records a system freeze, 42 Git subprocesses for one two-file triage fixture, repeated branch-context construction, and unbounded test concurrency. Incident report, lines 11–83 (legacy repository `docs/workstreams/resource-consciousness/incident-report-2026-07-03.md:11`, kept privately). These are historical incident measurements, not measurements of current HEAD.

Inference. Human attention and machine cost both need budgets in the rebuilt product. More evidence collection can make the product worse if it repeats work or obstructs the developer's machine. This supports discussing incremental observations and snapshot identity, without selecting a cache or graph implementation.

## Evidence limitations

No literal `PRODUCT`-named file appeared in the worktree search or all-ref Git path-history search. The initial concept report and V0 criteria/interview record are the strongest early product artifacts located. The focused record-category search above also checked the local source registry. This does not prove the user's PRODUCT records never existed elsewhere or inside another record format.

The Lauritzen notes say they came from auto-generated captions fetched on 2026-05-01. They are timestamped paraphrases, and the saved excerpt is not a verified human-edited transcript. The speaker's name is spelled Lauritzen in the repository. Source status (legacy repository `docs/research/review-triage/jacob-lauritzen-talk-notes.md:3`, kept privately).

Repository documents are evidence of the previous team's intent and claims. They are not independent evidence of product effectiveness. This memo did not run Neuve, its tests, its Kanban workflows, or its agents. It did not verify historical competitor claims or inspect all handover packets.

The old AGENTS.md (legacy repository `AGENTS.md:1`, kept privately) prescribes workstream and Kanban procedures for implementation. No implementation happened in that repository. The user explicitly requested a new collaborative rethink, so the previous workflow is treated as research evidence, not imported into the new corpus.

## Proposed discussion order

This is a proposal, not a decision record.

1. Agree what successful development and review feel like for the author and the human reviewer. Pick observable outcomes and failure cases.
2. Describe what can authorize a correctness claim. Separate requirement, observation, inference, decision, and accepted residual risk.
3. Define a review unit using examples before formal fields. Include cross-file behavior, partial verification, and changes to the requirements themselves.
4. Define the four review categories and the role of unknowns. Explain who can move a unit and which evidence permits the move.
5. Describe separate loops for implementation, antagonistic review during development, post-validation review, and human decisions.
6. Specify durable identity, evidence freshness, attribution, and invalidation across commits, rebases, and local changes.
7. Only then compare architectural components and technology choices.
