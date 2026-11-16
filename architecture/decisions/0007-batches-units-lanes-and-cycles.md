# 0007: Batches, units, lanes and cycles

Status: accepted, 16 October 2026; revised 23 October 2026 and for NEU-148, November 2026. Source: decisions [1.10, 2.8, 4.1–4.14, 10.4, 10.9, 10.55–10.59, 10.109, 10.110, 10.120, 11.1, 11.8, 11.16–11.21, 13.23 and 14.3–14.6, 14.12, 14.13 and 14.19](../../process/decisions.md).

## Fixed-shape trial

The NEU-111 trial uses Frame's done-when conditions and Map's groups in place of agent-confirmed candidate batches. Code assigns each group proximity units, or, with responsibility sections on, units by section, preserving every changed range. Lockfiles and declared-generated files form one code-only batch.

With the readings off, code fill records Facts, human-suggested and not-assessed for units without an assessment. Link adds kept, verified findings to the unit that owns their primary anchor. A defect produces a request for changes resting on its comments. Risks and questions add comments without a disposition. Link never approves, and untouched units have no disposition. Publish records pending Guided rows and one assessment gap per batch.

These trial rules hold only for a review with the readings off. Carried judgements and background model preparation are disabled during the trial. Old events and packets remain readable. The [pipeline record](0005-harness-pipeline.md) holds execution bounds. The owner settled the target in 13.23 and [Area 14](../../process/decisions.md#area-14-lane-assignment-and-agent-dispositions-redesigned-12-november-2026): every unit in the agent-decided lanes carries its lane's judgement and disposition; work no agent could judge is human-required; results are published per settled batch. The established policy below is that target.

## Established product policy

The policy below remains the product reference where the trial has not replaced execution. It does not describe the trial's assessment coverage.

- **Batches** come from behaviour and obligation. One commit range can produce several batches, each with a single focus. The batch overview shows one batch and its batch digest.
- **Review units** are one file's sections that share a review lane, within a batch (10.109, 10.120). A section is part of a file's changed lines cut at Graph's symbol boundaries (a class kept whole, Markdown by heading, a named line-window fallback elsewhere). A unit owns only its sections' line ranges, removed lines included, plus surrounding context that may include padding and other code.
- **Identity follows the code.** A section's key is a hash of its path, side, kind, name, span text and its own changed rows, with no line number and nothing from a model or a run. A unit's key is the hash of its section keys; its ID keeps the cycle and run key. The same ID always means the same sections, so nothing a person decided covers lines they did not see. A batch's key is the hash of its sorted file paths. How a unit relates to earlier units, unchanged or changed, is recorded as lineage.
- The proximity thresholds and the grouping counts end for new reviews; older reviews keep them.
- **Lanes** come from where a unit falls on the complexity × ease-of-validation matrix. History, prior bugs, outages and blast radius can move a unit. The agent fills both axes for each section with cited evidence; code maps the result to a lane (lane rule 3), raises it for a changed public surface and for any code risk floor, and the rationale reaches the reader. A unit's lane is the lane its sections share.

| | Easy to validate | Hard to validate |
| --- | --- | --- |
| **Low complexity** | Static automation or agentic | Human-suggested |
| **High complexity** | Agentic or human-suggested | Human-required |

- **Assessment.** The agent judges each axis at two levels with cited factors and no numeric scores, weighing movement signals into the axis they bear on (10.56, 10.57). A gap sends a section to human-suggested, except that evidence of high and hard on both axes keeps it human-required (4.4, 10.9, 10.55). Missing callers are a gap on every section not declared test, documentation or generated, until trusted call rows show how the code is used. Work no agent could judge (a reading failed twice, unsure, too large, unreadable, a finding neither confirmed nor refuted, or a request for changes whose every finding was refuted) is human-required, with its cause recorded and counted, and the note "No agent decision in this run".
- **Static automation** is assessed against validation requirements: a unit qualifies when its applicable kinds of proof converge on meeting its requirements (10.58, 11.1); none in M3 until proof recording lands (10.4, 11.8). A test's existence, or a test that calls the changed code, is never a kind of proof here (14.19); whether a recorded, current test run under 11.20 counts is unchanged.
- **Checkpoints.** Each validation requirement reaches the reader as a checkpoint: named in the unit's briefing and marked on the owned lines that meet it (10.110). Assemble anchors it to those lines when the batch is created and pins any external source it rests on; a requirement that reaches no owned line is anchored to the unit as a whole and disclosed (11.17). Code sets its proof state from its proof records and their currency: Missing, Out of date, Conflicting, Proven or Thin, in that order (11.16, 11.19); Proven needs a current test run wherever the behaviour can be tested (11.20). A ticket item no requirement covers is tied to one when the batch is created, or shown as a Missing checkpoint (11.21). Every run checks currency and pinned sources again (11.18).
- **Best effort, always.** If gaps prevent a confident assessment, the section goes to human-suggested, with no special label. Work no agent could judge at all is the one exception: it goes to human-required with one plain note.
- **Pre-generated dispositions.**
  - The agent approves or requests changes on agentic and human-suggested units.
  - On human-required units it writes a suggested review and comments, and never approves. A unit no agent decided has no suggested review.
  - It may request changes on any lane.
  - The pipeline generates content for every review-delivery stop: Facts, Briefed, Explained, Guided. In NEU-148's build only Facts and Guided are generated, and the batch digest is written by code; whether Briefed and Explained come back is the owner's open question under 13.19.
- **Digests.** The batch digest is the isolated briefing on the batch overview. The unit digest is the contextual briefing on the review desk.
- **Cycles.** A cycle runs from scope gathering, through the inner loop and the harness pipeline, to review. It ends when every needed disposition is in; comments alone do not end it. Whether a disposition is needed and in is judged against the unit's current lane: when a unit becomes human-required, earlier agent dispositions, approvals and requests for changes alike, become context for the human reviewer and never close it (4.13, 4.14). Comments, including those on approvals, become context for the next cycle. Any disposition after the first full set runs in a fresh context that reads the frozen package. A person's own decision carries to a unit whose sections all have the same keys in the one earlier unit they decided, and closes it there; nothing asks them again, and the unit is never counted as waiting. A changed unit shows the earlier decision as made on an earlier version and carries nothing. Inside one review, settled batches are published one by one as cumulative packets and frozen; a follow-on run continues the same review and never re-judges a published batch.

## Consequences

- With the readings off, the trial generates no quadrant assessments or suggested approvals. With them, every section is assessed and `assessment.recorded@4` records the lane, the rule version, each section's lane trail and the undecided counts by cause; the desk reads both the old and the new records. Older builds skip the new kinds and show no review for a new-style review, with a one-line notice.
- Gaps never stop a package from reaching people. A batch waits only while one of its sections is not reached and a follow-on run remains, or while a quota refusal leaves it pending; both are disclosed.
- Records keeps each checkpoint's anchors with its requirement, so the BFF projects them and never infers lines.
- The vocabulary entries for "review cycle" and "packet" need the owner's approval to reflect these definitions. The design's working words (section, reading group, code risk floor, backstop) do not become vocabulary.
