# Escalation and decomposition

Status: user-established, updated 2026-10-16 to match the owner's [design decisions](../process/decisions.md), Area 4. Numbers such as 4.2 refer to entries there. The lanes, the matrix axes and the starting quadrants are established. Marker weighting, scoring and thresholds remain open. Legacy rules are historical snapshots, not guiding principles.

## The lanes form an escalation policy

Static automation, agentic review, human-suggested review, and human-required review form an escalation policy. Risk and supported uncertainty can require human review without a separate organizational mandate.

Retrieve and connect markers per hunk, but assess risk, complexity, and classification for the review unit as a whole using its surrounding context. Whole-unit assessment must account for relationships that individual hunks cannot establish alone.

Git history, documentation, and ticket information are the main source pillars. Retrieval must filter for relevance to the hunk attribution, rather than collect everything reachable through the graph.

Security and historical problem context are risk factors. Complexity draws on impact, connections, dependency-graph position, architectural role, and total unit size. Blast radius also matters. Exact meanings, overlap between factors, and scoring remain open.

### Batch assembly includes the decision matrix

Assembling the batch includes assessing each review unit and assigning its lane. The harness places each unit on a matrix of **complexity** and **ease of validation**, using its collected and attributed evidence (4.2). The starting quadrants are:

| | Easy to validate | Hard to validate |
| --- | --- | --- |
| **Low complexity** | Static automation or agentic | Human-suggested |
| **High complexity** | Agentic or human-suggested | Human-required |

The agent fills both axes with cited evidence, code maps the quadrant to a lane, and the rationale reaches the reader ([batches, units, lanes and cycles](../architecture/decisions/0007-batches-units-lanes-and-cycles.md)). History, prior bugs, outages and blast radius can move a unit to a different quadrant.

| Evidence | Contribution to the unit assessment |
| --- | --- |
| Git history, prior bugs, outages and patch notes | Explain applicable previous failures, fragility and connections to important system behaviour. A seemingly easy change can need a different quadrant when that history changes the assessment of its effects or the validation needed |
| Blast radius and other complexity markers | Identify potentially affected work, dependencies and architectural responsibilities within declared relationship semantics, scope and coverage |
| Applicable validation evidence | Show how directly and reliably the affected behaviour can be checked, which obligations the evidence covers and what remains uncertain |

**Static automation is assessed against validation requirements** (4.3). A unit qualifies when its validation requirements are met by proof whose applicable kinds converge on the same result (11.1). Each requirement reaches the reader as a checkpoint with its proof state: Proven, Thin, Conflicting, Out of date or Missing (10.110, 11.16, 11.19).

**Assessment is always best effort** (4.4). When gaps prevent a confident assessment, the unit goes to human-suggested, not human-required, and the best-effort assignment carries no special label. Gaps never block a unit or the package.

Historical evidence must explain its connection to the unit. A prior incident or co-change supplies context; it does not by itself establish a current runtime effect. The package keeps the original source, version, applicability and limitations, together with the assessment and lane rationale. Discovery can revise candidate grouping and classification before the package is frozen. Later review information keeps its original cycle attribution under the [cycle attribution rules](02-review-modes-and-cycles.md#cycle-attribution-and-immutable-preparation-snapshots).

Semantic evidence assessment and reranking determine what context is useful and what it supports. The decision matrix uses that assembled context to classify review responsibility. Both belong to the harness. The agent never approves human-required work. The [reviewer-package rules](04-review-units-and-context.md#reviewer-package-and-digests) define what reviewers receive.

Post-retrieval enrichment can interpret markers and assess their meaning, including security labelling. This is a direction to critique, not a fixed boundary excluding security information from graph representations.

A contextual marker is a retrieved semantic fragment supporting an attribution to a hunk, traceable to its larger source. Weight, score, or certainty should guide how markers contribute to assessment, rather than impose black-and-white routing by their presence alone. The precise meanings, scales, and combination rules are not selected. The [history and metrics foundation](03-unit-history-and-metrics.md) tracks the results of those movements across patches and branches.

The policy must fit the [reviewer's tax principle](05-reviewers-tax.md): present material support and relevant context for decision signals, build on prior evidence, and avoid reopening resolved work without a new reason. The separate uncertainty briefing remains advisory; its existence does not create a blocking review obligation.

## Assessment can change with discovery

Agents can investigate contextual markers and contribute discovery evidence that changes the assessment of review units and their surrounding context. Both escalation and de-escalation must be possible as understanding improves.

Structural and static analysis are separate, explicit operations, and the graph serves semantic retrieval ([graph and structural analysis](09-structural-engine.md)). Their relationships and heuristic confidence still need evaluation before they influence lane assignment. The [Entire Graph evidence and limitations](../research/03-entire-and-code-context.md) remain the inspected baseline.

## Use the policy before implementation too

The policy also guides task decomposition and architectural decisions in Neuve's opinionated workflow and skills. It should help shape work that can be verified and reviewed with appropriate responsibility, not only classify a completed diff.

Decomposition should minimize friction and duplicate work by producing smaller units suitable for delegation, including static automation and agentic review. Relevant information must remain in the surrounding context for attribution and comprehension. The [change visibility and justification rules](04-review-units-and-context.md#surface-changes-and-explain-changes-to-reviewed-work) apply when decomposition or corrections affect previously reviewed work.

Proposed example: isolate a permission-policy decision from mechanical updates and give the latter direct verification. Human attention can then focus on the policy while the mechanical work becomes suitable for automation. Splitting a diff alone does not prove that risk or dependencies have been reduced.

The exact guidance, skills, and tests of successful decomposition remain to be designed. Lower routing must reflect better verification or reduced risk, rather than concealment of relevant context.

## Historical snapshot, not design guidance

The accepted legacy decision-matrix direction (legacy repository `docs/research/review-triage/workstreams/v0-44-review-unit-decision-matrix/hitl-decisions.md:7`, kept privately) uses validation difficulty on one axis and complexity, blast radius, or semantic effect on the other. It connects easy validation to automation or agents and difficult, consequential work to humans.

The inspected legacy scoring implementation (legacy repository `crates/git-scan/src/review_matrix_scoring.rs:15`, kept privately) assigns categorical risk and validation levels from reason codes and verifier references, then maps those levels to fixed numeric values. This is not a demonstrated weighted aggregation of contextual markers.

The legacy routing implementation (legacy repository `crates/git-scan/src/review_matrix_routing.rs:16`, kept privately) applies mandatory gates before quadrant routing, and its gate extraction (legacy repository `crates/git-scan/src/review_matrix_routing.rs:93`, kept privately) broadly classifies ordinary source changes as needing human review. In Neuve, lanes come from the matrix (4.2); broad gates like these are not part of it.

## Next investigation and discussion

The [contextual-marker research and correction](../research/05-contextual-markers.md) records the accepted fragment-based definition. Its [feasibility critique](../research/05-contextual-markers.md#feasibility-critique-of-hunk-markers-and-unit-assessment) identifies attribution noise, graph coverage, and aggregation risks. Attribution must explain what the fragment establishes, why it applies to a hunk, and what remains uncertain.

Scoring is researched alongside the [retrieval build order](11-retrieval-context-and-investigation.md#build-order-and-measurement), which measures how much each added source helps. Keep three questions separate: how consequential a marker is, how strongly the evidence supports it, and how well available verification covers the affected behaviour. These are analytical distinctions, not product terms or an agreed scoring model.

Do not ask the user to select universal gates for individual risk markers. Explicit organizational human-review obligations remain a separate requirement in the [product purpose](01-product-purpose.md).
