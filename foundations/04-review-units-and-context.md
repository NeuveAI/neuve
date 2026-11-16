# Review units and surrounding context

Status: user-established, updated 2026-10-16 to match the owner's [design decisions](../process/decisions.md). Numbers such as 4.1 refer to entries there. Range input, batches by behaviour, units by file and proximity, reclustering, separate work and context attribution, and digests are established. Hunk matching across patches, impact detection, exact proximity limits, and where committed context ends and same-batch context begins remain open.

## Start with the changed code

Neuve rethinks review and the pull-request concept while retaining Git as a primitive. A review takes a **commit range**, attributed to a base branch, as its input (1.4). The range is the fingerprint: Git immutability means the same range always carries the same changes. The range, together with the pipeline version and configuration that processed it, identifies work so that nothing is recomputed ([persistence record](../architecture/decisions/0004-persistence-and-range-immutability.md)).

The closest base unit is a Git diff hunk. Nearby hunks are clustered into review units to avoid a noisy review interface. Review unit and cluster are synonyms. Review units are directly connected to the commits they concern, and the main workflow is driven by [Git hooks and events](08-ingestion-and-setup.md#ongoing-ingestion).

Behaviour decides the batch, not the unit. A behavioural question is context for assessing the changed code; it does not replace the hunk-based review unit.

## Batches and units

| Grouping | Decided by | Purpose |
| --- | --- | --- |
| Batch | Behaviour or obligation (4.1, 4.10) | One range can produce several batches, so each review has a single area of focus and a cohesive digest |
| Review unit | File and proximity, within a batch (4.1) | Reviewers read and reason about the diff without excessive fragmentation |

The agent does not regroup units by behaviour; behaviour and obligation decide the batch, and units are a code-proximity grouping within it. For example, the Storybook batch overview shows one batch, "Revoked share links stop working immediately", containing 26 units, each with a behaviour label and its scope in files and hunks. The exact proximity rule, and whether a unit can span files, remain open.

Once a unit is assigned to a lane, it owns only its relevant line ranges (hunks), plus surrounding context that may include padding and other code (2.8). Context stays separate from owned work.

## Keep committed history separate from work under review

The [product vocabulary](../vocabulary.md) distinguishes the durable committed graph from the current review batch. The committed graph accumulates repository state, history and prior review attribution over time. The batch contains the changed work in the range under review; its hunks form the review units being assessed.

A commit creates durable identity and lineage, but does not confer approval; only a recorded disposition establishes one.

A review unit can supply transient context to a sibling unit from the same range. The marker must identify the source unit and visibly state that it is unreviewed same-batch context. It cannot carry prior approval into the batch, transfer a disposition between units, or appear elsewhere as approved context.

For example, a caller hunk can depend on a helper hunk in the same range. The helper can explain the caller during their review. Approving either unit does not approve the other.

Ranges vary. A reviewer may narrow the range to commits ahead of the base, or inspect ranges outside it. Same-batch context is work inside the selected range. Work outside it is context that carries its own review status, such as reviewed in an earlier cycle or not yet reviewed (4.12).

## Grouping and decision scope

Shared context can connect more distant code through an attributed briefing. Contextual assessment may split or recompute a candidate cluster before assigning its review responsibility, so initial proximity grouping is revisable. Markers remain linked to their hunks, while risk, complexity, and classification are assessed for the resulting review unit as a whole.

Decision scope and surrounding context are synonyms. This is supporting information selected for a review unit in a given cycle: code connected through dependencies, references or blast radius, Git history, tickets, documentation and prior reviews. Contextual markers connect traceable fragments to the hunks they help explain and appear through the context margin. The review unit represents the work; its surrounding context informs assessment and remains separate from the hunks receiving a disposition.

**Surrounding context anchors on changed lines** (3.5). Surrounding context exists only for changed lines. It may describe other parts of the codebase, but its anchor is always a changed line in the unit, and the margin pin for retrieved context attaches there.

Agent and human dispositions stay tied to the exact unit, owned work and cycle. The prepared package for a cycle is transient and assembled from references; the [cycle attribution rules](02-review-modes-and-cycles.md#cycle-attribution-and-immutable-preparation-snapshots) record that comments and dispositions stay in the reviewed cycle, while changed work or newly selected surrounding context after the review basis is frozen belongs to the next cycle.

Reviewing the unit applies an approval or request for changes to its constituent hunks under the relevant responsibility segment. Neighbouring hunks from other lanes remain visible for context, with their classifications and any automated review notes clearly distinguished. Displaying them does not transfer their decision authority or overwrite their review attribution.

Human-suggested and human-required work can receive the same human decision when included in the human review scope. Their classifications remain distinct, including the required-human obligation. The exact presentation of such a combined scope remains open.

This resembles retrieval chunking: include enough surrounding material to understand the subject without confusing that material with what the reviewer is deciding.

### Example

A permission-check hunk needs human review. A neighbouring generated-code hunk has already passed its automated review. The human sees both, with the automated notes available. Approving the human review unit applies to its human review scope; it does not replace the generated-code hunk's automated decision or attribution.

If another nearby human-review hunk belongs to the same cluster and human responsibility segment, the unit's decision covers it too. The next cycle recomputes the review unit rather than automatically reopening every hunk in the previous unit.

## Recluster for each new cycle

Recompute review units for the new cycle using evidence accumulated across prior cycles. A previous unit is not a permanent approval boundary. Relevant supporting context may overlap between old and new units; that overlap is acceptable. Avoid demanding repeated human decisions or presenting unnecessary repeated information.

When units regroup, treat the resulting groupings as new units with explicit links to earlier hunks, comments, evidence, and decisions. Preserve a connected history while keeping each prior approval tied to the work it covered. Exact matching across changed patches and branches remains a design question.

If commit B arrives while commit A is under review, keep that review and its decisions tied to A and clearly surface B's changes. B's work receives new review units that attest to and attribute its changes and surrounding context. Carry forward applicable history and evidence under the no-repetition principle: new units do not require repeating unaffected review work, and prior decisions do not automatically approve B's changed work.

A previously approved hunk may appear as context in the new cluster when it helps explain the work. "Read-only neighbor" is reserved for a neighbouring hunk belonging to a different lane from the cluster's responsibility segment. Prior approval alone does not establish that lane distinction. A previously approved hunk shown as context provides a contextual signal and does not require another decision merely because it appears beside changed work. It remains commentable: feedback on that context can lead to changes in a subsequent cycle.

Unchanged text does not guarantee that an approval still applies. If a dependency or surrounding change alters the code's meaning, outcome, or side effects, raise a new decision signal for the affected code. How the system detects and substantiates that impact remains open.

For example, two hunks were approved together. In the next cycle, one changes and the other remains unaffected. Recluster around the work requiring a decision; the unaffected hunk may be shown for context without a new decision obligation. If a helper change alters the approved hunk's access-control behaviour, that hunk requires renewed attention even though its text is unchanged.

The [product vocabulary](../vocabulary.md) defines decision signals, contextual signals, and read-only neighbours consistently across product, UI, and engineering discussions.

## Surface changes and explain changes to reviewed work

These rules clarify the [no-repetition goal](05-reviewers-tax.md#established-principle). Showing what changed and why lets reviewers focus on justified renewed work while reusing prior context and decisions where applicable.

Changes must always be surfaced in the appropriate review venues for their responsibility and relevant surrounding context. This includes automated and agentic review; it does not require every change to receive a human decision.

Changes to previously reviewed pieces must be well justified. Corrections are a valid justification, and their reason must be available through contextual markers or the surrounding context. Link the relevant correction request, finding, or supporting source fragment so reviewers can understand what changed and why. A prior review must not conceal later changes, and a correction label alone does not explain them.

Minimize friction by reducing duplicate work and decomposing work into smaller units that can be delegated to appropriate lanes. Decomposition must not remove the context needed to understand connected changes. The [decomposition foundation](06-escalation-and-decomposition.md#use-the-policy-before-implementation-too) records how this guides work before implementation.

## Shared context across separate units

Separate review units retain their own dispositions even when correctness depends on their interaction. Their shared relationship and relevant verification remain visible in both surrounding contexts. Splitting a cluster must not erase that dependency.

Isolated briefings can explain this shared context across units. They are advisory, as established in the [briefing rules](05-reviewers-tax.md#supported-uncertainty), and do not introduce a joint approval requirement. They do not replace either unit's disposition.

For example, an authorization change and its caller update may be separate units. An isolated briefing can explain why they must work together and connect the relevant verification, while each unit retains its own review responsibility.

This rule also applies within one range. Transient context from one unreviewed sibling can explain another sibling without becoming historical attribution or sharing either unit's disposition. The presentation must distinguish that same-batch source from committed markers.

## Give the reviewer an attributed briefing

The system, UI, and product specifications share these definitions of hunks, units, decision scope, and surrounding context. Alongside the changed code, a reviewer needs a generated briefing that summarizes relevant code, tickets, documentation, and Git history. Connected sources provide attribution and allow drilldown into supporting information.

The briefing reduces the reviewer's tax: the effort of gathering and reconstructing why the change exists, its surrounding constraints, and relevant earlier work. It also informs the regression history described in [unit history and metrics](03-unit-history-and-metrics.md). It must respect the [context and token cost commitments](01-product-purpose.md). How summaries distinguish conflicting or inferred information remains open.

**Descriptive text links to what it describes.** A generated briefing is written so that each phrase describing part of the change (a hunk, a file, a marker, a recorded review) links to that part, and following it lands there, as a citation chip lands on its range. The generator emits these links with the text, so attribution and drilldown come from the words themselves rather than from separate references.

### Reviewer package and digests

One harness pipeline prepares the whole package (1.6): the batches, their review units, attributed surrounding context, digests, the lane assessment for each unit, pre-generated dispositions, and content for each review-delivery stop (4.6). The [batches, units, lanes and cycles record](../architecture/decisions/0007-batches-units-lanes-and-cycles.md) describes it.

| Digest | Where it appears | What it is |
| --- | --- | --- |
| Batch digest | Batch overview | The isolated briefing for the whole batch: advisory, no decision required (4.8) |
| Unit digest | Review desk | The contextual briefing for one unit within its batch, with phrase links and citation chips such as Conflict, Gap and Same batch (4.8) |

Human reviewers use the batch overview and review desk; inner and outer agentic reviewers drill into the same data through the CLI (1.9). Reviewers give dispositions and comments on the matched work with its context.

Digests are generated interpretations with connected sources for attribution and drilldown. Their claims, verification interpretation and remaining gaps must stay distinguishable from original evidence and reviewer dispositions. Retrieval relevance or a generated digest never becomes review approval. Gaps are disclosed in the package and never stop it from reaching people ([harness pipeline](../architecture/decisions/0005-harness-pipeline.md)).

Each unit's lane comes from its quadrant on the complexity × ease-of-validation matrix. The package keeps the assessment, its evidence and limitations, and the rationale for the lane alongside the owned work, context and digests. The [decision-matrix rules](06-escalation-and-decomposition.md#batch-assembly-includes-the-decision-matrix) give the starting quadrants.

## Legacy grounding

The review-intelligence whitepaper (legacy repository `docs/whitepapers/review-triage/review-intelligence-whitepaper.md:171`, kept privately) identifies hunks as the base change metadata, while describing path-level grouping in the implementation. The legacy review-unit decision-matrix scope (legacy repository `docs/research/review-triage/workstreams/v0-44-review-unit-decision-matrix/scope.md:60`, kept privately) distinguishes the longer-term hunk-level direction from an initial file/path-group implementation. Those implementation compromises must not be mistaken for the desired product primitive.

## Open boundaries

- What evidence establishes that surrounding changes affect previously approved code, and how should uncertain impact be handled?
- How do we preserve hunk history when patches or unit membership change?
- What limits proximity grouping, and can a review unit span files?
- How does a digest distinguish source facts, inferred relationships, conflicts, and missing context?

Automated processing precedes the human gate, as specified in [review sequencing](02-review-modes-and-cycles.md#human-review-is-the-last-gate).
