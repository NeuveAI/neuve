# Show, don't tell

Status: established by the user on 2026-09-30, and scoped on 2026-10-16 by [design decision 7.5](../process/decisions.md).

## Scope

This principle applies to explanations for the owner: impact assessments, plans, architecture proposals, comparisons, and requests for the owner's decisions. Write them in product language, using the [product vocabulary](../vocabulary.md). The owner is very technical, so architecture can be discussed in depth, but the explanation must be well formatted and give the background needed to follow it.

Agent handovers, briefs and records stay short and plain. They do not need rendered visuals or rendered pages.

## Established principle

Show connected information when a visual representation materially reduces the work required to understand it. The visual is part of the reasoning, not an illustration added afterwards. It should expose the relationships, sequence, ownership, alternatives, or uncertainty that the reader would otherwise have to reconstruct from prose.

## Trigger test

Use a visual when the subject includes one or more of these shapes:

- three or more dependent steps, states, actors, components, or downstream effects;
- a current state and a proposed state whose difference matters;
- ownership, hierarchy, data flow, branching, or change over time;
- several exact mappings or trade-offs that must be compared;
- a question where the owner's answer chooses a consequential branch;
- an interaction or failure whose cause is difficult to explain linearly.

These are recognition aids, not quotas. Use concise prose for a single fact, one-step action, or short list. The test is whether the reader would otherwise need to hold and connect several facts in their head.

## Choose the smallest useful form

- A flow for sequence, lifecycle, data movement, and cause and effect.
- An architecture diagram for components, boundaries, and ownership.
- A table for exact mappings and repeated-field comparisons.
- A timeline for revisions, events, and state changes over time.
- A tree for hierarchy, decomposition, and branching.
- A decision view when asking the owner to choose: the alternatives, their consequences, the established constraints, and the exact decision point.
- A wireframe when layout or interaction is the subject.

Do not force a graph when a table or three labelled boxes communicates the point better.

## Delivery standard

A qualifying explanation is complete only when:

1. The visual appears near the claim, plan, or question it explains.
2. Established facts, proposals, uncertainty, and requested input are visibly distinct.
3. Labels carry the meaning without relying on colour alone.
4. A concise textual conclusion states what the visual shows and why it matters.
5. Sources stay attributable under the [contextual-linkage rule](../CONSTITUTION.md#contextual-linkage).
6. The result has been rendered and inspected where the owner will read it. Raw Mermaid, diagram source, a broken embed, or unreadable labels are a failed delivery.

## Applying it to questions

When asking the owner something whose answer changes architecture, scope, behaviour, or sequencing, show the decision space. Mark what is already established, which alternatives remain viable, what each changes, and the exact point that needs the owner's judgment. Then ask the smallest question that resolves it.

## Applying it to reviews

When reviewing an explanation meant for the owner, challenge dense prose that hides important relationships, and reject a visual that is ornamental, misleading, unrendered, or detached from its evidence. The goal is lower reader load with preserved precision.
