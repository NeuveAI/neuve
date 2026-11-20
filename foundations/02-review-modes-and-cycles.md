# Review modes and cycles

Status: user-established, updated 2026-10-16 to match the owner's [design decisions](../process/decisions.md), Areas 1, 2 and 4. Numbers such as 4.11 refer to entries there. Items marked open remain open.

## Planning and scope precede the development loop

Neuve skills guide a coding harness such as Codex or Claude Code through a prescribed workflow: planning, then the inner implementer and adversarial-reviewer loop, then a fully independent final review (1.1). Establish scope and resolve human scoping decisions during planning. During the inner loop, agents use Neuve to drill into that scope as needed. Do not introduce routine human clarification into the inner loop.

Scope comes from whatever is available: a Linear ticket, a markdown plan, or ad hoc (1.8). Planning skills establish the sources of truth for task scope, definition of done and validation requirements, together with applicable technical requirements and documentation. These sources become indexed context with their original version, attribution and applicability, as do documents that occur naturally in the repository (7.4). A missing source never stops the work: disclose the gap and continue. Planning is prescriptive and cannot guarantee sufficient scope.

This planning boundary is distinct from the final human review gate. The [context-querying workflow](#context-for-agent-reasoning) supports conflict resolution during implementation and review.

## Context for agent reasoning

The implementer and reviewer can query Neuve for surrounding context about a file, function, or section of code. Pin the current task or ticket's scope from its source as the reference for scope, constraints, non-goals, and definition of done.

Agents reason about conflicts using this context, the pinned task reference, and their available tools. Neuve aggregates, resolves, and gathers context to support that reasoning. Conflict resolution is mostly the agents' workflow responsibility; it does not require a separate Neuve-controlled interruption or replanning process.

## Two modes

| Mode | Who drives it | Neuve's role | Measurement |
| --- | --- | --- | --- |
| Inner development loop | Neuve skills, running in the developer's local coding harness (1.1, 2.2) | The CLI, MCP and ACP connections give agents context and carry their work, identity and evidence into Records (1.1, 1.2) | Internal acceptance and quality, tracked separately, including context and token cost |
| Final review | Neuve's own harness, which owns the pipeline entirely (2.2) | Prepare the batch package and collect dispositions on it | Final-review outcomes and their contribution to the cycle |

The first scope is final-review preparation. The inner loop is not built as a product flow yet, but its data-collection surfaces are (1.2). Final review never depends on an external coding agent being connected; ACP connections are for live communication with editors and external harnesses when one is available (2.2), and none is built yet. Where Neuve drives an external coding harness itself, it does so through the [runtime contract](../architecture/decisions/0017-runtime-contract-and-accounts.md), by that harness's own interface: Claude Code through its Agent SDK ([12.59](../process/decisions.md#area-12-ace-style-pi-transition-28-october-2026)), and Codex, once the [Codex runtime proposal](../process/proposals/codex-runtime.md) is built, through its app server ([14.63](../process/decisions.md#area-14-lane-assignment-and-agent-dispositions-redesigned-12-november-2026), which replaced, for Codex, the ACP route decisions 2.9 and 2.12 kept warm).

One harness pipeline produces the whole package (1.6, 2.1): scope gathering, hybrid retrieval with refinement and reranking, deterministic checks, matching units to context, digests, lanes, and pre-generated dispositions. Scope gathering is an internal pipeline step with no product name (1.9). The [harness pipeline record](../architecture/decisions/0005-harness-pipeline.md) describes its stages.

Human reviewers see only the batch overview and the review desk. Inner and outer agentic reviewers drill into the same data through the CLI (1.9). Reviewers assess the matched work, its context, verification and digests, then give scoped dispositions and comments. The [reviewer-package rules](04-review-units-and-context.md#reviewer-package-and-digests) describe attribution and drilldown.

## Cycle boundary and corrections

A review cycle runs through these steps (4.11):

| Step | What happens |
| --- | --- |
| 1. Scope gathering | Collect the available scope sources for the inner loop |
| 2. Inner loop | The implementer and adversarial reviewer iterate until the reviewer approves |
| 3. Harness pipeline | Neuve's harness prepares the batch package, including pre-generated dispositions |
| 4. Review | The outer reviewers (human, agent or both) give their dispositions |
| End | Every needed disposition is in, approval or request for changes. A new cycle begins |

Gathering every needed disposition ends the cycle; comments alone do not. Comments, including those on approvals, feed into the next cycle as context. Inner-loop correction iterations happen inside a cycle and do not count as cycles.

Any reviewer can send corrections back to the implementer: the inner-loop adversarial reviewer, the agentic reviewer, or the human reviewer. Each correction remains connected to the relevant review unit, which can have multiple requests or comments. Agents use the [pinned scope and surrounding context](#context-for-agent-reasoning) to reason about corrections.

When a newer commit arrives during review, the existing review stays tied to its original range and the newer work gets new units, following the [revision-bound review rule](04-review-units-and-context.md#recluster-for-each-new-cycle). Concurrent scheduling remains open.

**Fresh context for later dispositions** (4.7). The pipeline first produces dispositions for the whole batch. Any later disposition, such as a re-review after comments or changes, starts from a fresh context that reads the frozen package. Dispositions are stored for later reference and never regenerated.

Evidence can be reused, and a marker can support attribution to more than one review unit through shared dependencies or blast radius.

<a id="cycle-attribution-and-immutable-preparation-snapshots"></a>

## Cycle attribution and the prepared package

Reviewed work and the context supplied to assess it have separate attribution. Use the [product vocabulary](../vocabulary.md#review-units-and-context) in preparation, review and agent handoffs.

| Concept | What it refers to | Attribution to retain |
| --- | --- | --- |
| Review unit | The work receiving a review decision, with its owned line ranges | Exact source, responsibility and cycle |
| Surrounding context | Supporting code, dependencies, references, blast radius, documents, history and other evidence | Original source and why it informs this unit in this cycle |
| Disposition | The agent or human approval or request for changes | Original actor, reviewed work, stage and cycle |
| Packet | Internal wording for the prepared package of one cycle | Assembled from references; frozen when published; transient for its cycle (5.5) |

Supporting fragments appear through contextual markers in the context margin. They remain evidence for assessing the unit, not additional owned work receiving its disposition. An input supplied to a reviewer is recorded separately from an assertion that the reviewer read or accepted it. Historical dispositions do not transfer to a different unit, changed work or another cycle merely because their source appears in its surrounding context.

Comments and dispositions append to the history of the cycle whose package they reviewed, with their original actor and stage. They do not alter the frozen package. Changed work or newly selected surrounding context after the review basis is frozen belongs to the next cycle, with explicit links to prior work and applicable evidence. Before a cycle identity exists, keep the actual batch, run and work anchors and bind them to the cycle later. A late response keeps its original unit, source and cycle; arrival order does not move it onto the current review.

Computations such as generations, retrieval results and embeddings live in a computation store, addressed by a hash of their inputs. Records reference them rather than copying them, and nothing is recomputed for the same range ([persistence record](../architecture/decisions/0004-persistence-and-range-immutability.md)).

Evidence attached to a unit describes what was presented and which unit and cycle it concerns. Judgements about factual support, applicability and coverage are recorded separately. A frozen package establishes historical identity, not factual support. Corrections use linked, attributed records; original evidence is preserved.

## Human review is the last gate

All automated review and processing for a submitted range happen before human review, including the inner loop and the final agentic review. Human review is the last gate.

Once every needed disposition is in, including any human request for changes, the cycle ends; the work returns to the inner loop and the next cycle prepares it again (4.11).

Human-suggested units arrive at the human stage with an agent review and disposition already completed. This reduces delay and helps humans concentrate on the judgment they can add.

## Every review obligation gets a disposition

Units in the agentic, human-suggested and human-required lanes need approval, or a request for changes or comment indicating that further work is needed. A unit does not become approved merely because it is hidden or receives no human input.

The agent's pre-generated dispositions follow the lane (4.5):

| Lane | What the agent prepares |
| --- | --- |
| Agentic, human-suggested | Approval or request for changes |
| Human-required | A suggested review and comments. It may request changes, but never approves |

The pipeline also generates content for every review-delivery stop (Facts, Briefed, Explained, Guided) in every lane (4.6, [0007](../architecture/decisions/0007-batches-units-lanes-and-cycles.md)).

Human-suggested units can be shown or hidden in the human review interface. If humans provide no input and do not manually approve them, the existing agent disposition applies. No new agent review is launched merely because the human did not intervene. An outstanding human request for changes cannot be erased by treating it as no input.

An agent request for changes remains a request for changes when there is no human input; absence of input does not turn it into approval.

Human-required units retain their human decision requirement. A static-automation unit qualifies when proof whose applicable kinds converge meets its validation requirements (4.3, 11.1).

## Adversarial review

The inner-loop adversarial reviewer is responsible for the quality and validity of the changes, including the evidence offered to verify them. It challenges the implementation using the unit's surrounding context and must not merely affirm the implementer's account.

Before checking whether an implementation conforms to its plan, the reviewer challenges the plan's premise and ownership boundaries. Identify which component already owns each new responsibility, whether the proposal creates a second authority, and which established requirement justifies that duplication. Reject duplicated responsibility when the only basis is an experiment, an implementation convenience, or the plan under review.

The inner loop advances to final review only when the adversarial reviewer approves. Proof converges: code, tests, telemetry, logs, and screenshots and video where they apply must point to the same result, judged against the plan's scope and definition of done, and every applicable kind belongs in the system of records for the range (11.1, 11.3). Invalid or inadequate evidence must be refuted and corrected within the loop. It is not enough to carry a known verification failure forward as an unresolved signal. This approval establishes readiness for final review; it does not replace final-review dispositions or required human approval. Handling an inability to obtain approval remains open.

The [review standard](../process/adversarial-review-standard.md) that Neuve's own build lanes follow is one example of what Neuve skills can prescribe (7.4). It draws on pstack's reviewer prompt and lead judgment guidance (neither is in this repository): seek concrete failures against the intended behaviour, cite the relevant code or evidence, and distinguish defects from preferences. No findings is a valid result, and producing objections is not itself evidence of review quality. The [reviewer skills](../.agents/skills/) carry this frame of reference for the inner-loop reviewer and for the harness's final reviewer alike, and reviewers work independently and without bias (11.4, 11.7). These are sources of inspiration, not a decision to copy pstack's model panel or output format. An additional reviewer's cost must earn its place; independent evidence matters more than agreement.

## Legacy reference

The inspected legacy unit list (legacy repository `apps/web/src/features/mcp-review-shell/shell-review-units.tsx:38`, kept privately) defaults to required units and lets the person filter to suggested units. This supports separating visibility from obligation. It does not by itself establish the agent fallback behaviour.

The legacy tier display (legacy repository `apps/web/src/features/mcp-review-shell/view-model.ts:117`, kept privately) labels suggested and agent-delegable groups non-blocking. The new product rule requires their disposition nevertheless. Do not import those old labels as completion semantics.

Revision attribution and regression-driven movement belong in [unit history and metrics](03-unit-history-and-metrics.md).
