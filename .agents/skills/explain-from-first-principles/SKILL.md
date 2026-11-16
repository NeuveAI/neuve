---
name: explain-from-first-principles
description: Explain research findings, failures, consequential changes, and product tradeoffs from engineering fundamentals, with verified visuals and links to Neuve's product principles. Use when the user needs understanding to judge a direction, not for routine status or a one-step answer.
---

# Explain from first principles

Use this skill whenever explaining findings or deeper changes that the user needs to judge. Teach the mechanism and its product consequences before asking for a decision. Scale the depth to the question. A routine fact does not need a lecture.

## Ground the explanation

Read the [repository constitution](../../../CONSTITUTION.md) for ownership and communication rules. Read the [product vocabulary](../../../vocabulary.md) for the established meanings. Select the relevant foundation documents rather than loading every foundation.

Start with the concrete problem the user is judging. Define unfamiliar technical concepts in ordinary language before using them to argue for a solution. Separate the user-established requirement from current behavior, measured evidence, proposals, and unknowns. Cite the evidence that supports causal or historical claims. If a reason is not recorded, say so rather than inventing a rationale.

Choose a small concrete example that exposes the distinction. Mark illustrative examples as illustrative. Explain what a test actually exercises, why its cases were selected when known, and what passing it cannot establish. A fixture is not product scope or comprehensive coverage.

## Show where the problem occurs

Identify the relevant stages, owners, inputs, and outputs before comparing solutions. Distinguish ingestion and enrichment, retained information, retrieval, response allocation, and review judgment when those stages matter. Missing knowledge, missing returned metadata, and an unsupported conclusion require different remedies.

Follow [show, don't tell](../../../foundations/10-show-dont-tell.md). Place a rendered, accessible, inspected visual beside the explanation it supports. Build complicated pictures in small steps instead of presenting one dense diagram. Show current and proposed behavior distinctly. Label uncertainty and the exact decision branch. Do not deliver raw diagram source as the visual.

For each relevant fact, explain:

- What evidence establishes it, and at which stage.
- What the user or agent can do with it.
- What it does not establish or enable.
- What remains available through a focused follow-up.

Avoid implying that source presence proves identity coverage, that a name proves a binding, or that a static relationship proves runtime impact. An identity does not confer approval. Preserve committed provenance and visibly unapproved same-batch context as different dimensions.

## Connect engineering choices to product principles

Name the established principle affected and show the concrete consequence for a review unit, contextual marker, investigation, or human decision. Use the [product purpose](../../../foundations/01-product-purpose.md) and [reviewer's-tax principle](../../../foundations/05-reviewers-tax.md) when judging information quality and cost.

Track wrong attribution separately from missing attribution. Compare total investigation cost, including repeated lookups, against the quality of the information retained. Fewer bytes, fewer tool calls, or more metadata are not sufficient benefits by themselves.

When the user proposes another approach, locate it in the same flow. Explain which failure it could address and which failures remain. Do not reject an upstream improvement because it differs from a downstream fix. Do not claim upstream enrichment automatically guarantees that a bounded response includes its metadata. Identify complementary work and any ownership or trust constraint.

## Make the decision understandable

Compare viable alternatives using the same evidence obligation. Show what each changes, preserves, loses, costs, and would need to prove. Include a smaller change or reuse option when relevant. Do not manufacture choices to meet a quota.

Keep recommendations separate from findings. Explain the engineering reason for the recommendation and the evidence that could overturn it. State remaining uncertainty and needed authority. An explanation or a proposal is not authorization to install tools, change production behavior, revise an oracle, or update vocabulary.

Before sending, check whether the user can explain the failure, connect it to a product principle, and understand the consequences of each choice without decoding opaque terms or opening every source. Provide the explanation itself, not a report about the explanatory process.
