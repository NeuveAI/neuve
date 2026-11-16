# Verification and supervision in poteto's writing

Research date: 2026-09-17. Status: research and interpretation, not an accepted Neuve specification.

The three requested X sources were read through authenticated Chrome after web retrieval returned HTTP 403. Two substantive linked posts were also read. Their rendered text is preserved locally as Markdown. These captures omit images, navigation, and reply feeds. Embedded quoted posts can be truncated as displayed. The full original gardener and organic-architecture posts have their own captures.

## Source register

| Source | Published | Local capture | Main contribution |
| --- | --- | --- | --- |
| [The Complete Guide to pstack Pt. 1](https://x.com/poteto/status/2094457600259842065) | 2026-08-31 | Part one (kept in the private archive) | Reusable verification controls and a maintained feature map. |
| [The gardener post](https://x.com/poteto/status/2090546476464451907) | 2026-08-20 | Gardener (kept in the private archive) | Convert recurring maintenance observations into lasting constraints. |
| [The Complete Guide to pstack Pt. 2](https://x.com/poteto/status/2097732320606507506) | 2026-09-09 | Part two (kept in the private archive) | Establish shared understanding, investigate intent, and compare concrete alternatives. |
| [Loops You Can Trust](https://x.com/poteto/status/2069824386283319343) | 2026-06-24 | Loops (kept in the private archive) | Stage-specific evidence, stop conditions, and learning from verification failures. |
| [Organic architecture](https://x.com/poteto/status/2078527882499150286) | 2026-07-18 | Organic architecture (kept in the private archive) | Encode stable constraints in architecture and executable checks. |

The capture manifest (kept in the private archive) records original URLs, capture call IDs, dates, and hashes. The browser's direct content-export API was unsupported. The archive instead preserves the text read through the browser from this task's own recorded tool outputs. These are source captures, not model-written reconstructions.

## Verification is a maintained capability

Part one argues that agents need tools to operate and inspect the actual application. The article includes UI interaction, runtime inspection, profiles, screenshots, and repeatable environment setup. The transferable idea is a reusable verification interface with known preconditions and observable results. The specific browser, desktop framework, cloud provider, and CLI shape are examples, not requirements for Neuve.

The feature map adds another kind of context. It describes what a user can do, how to reach that behavior, and what can mislead an inspection. It is maintained alongside the application. This differs from a symbol graph, which describes code structure. A behavior can span many symbols; a symbol does not by itself explain the intended user outcome.

The linked [verification-skill example](https://github.com/poteto/verification-skill-example) is explicitly fictional. Its README says the driver scripts are omitted. It demonstrates documentation shape and example commands, not a runnable verification implementation. We should not count reading that repository as evidence that its commands work.

Inference for discussion. Neuve may need to connect a review obligation to an executable way to observe the relevant behavior. It may also need to record when that verification path was last checked. A stored command and an old screenshot are insufficient to establish that today's change behaves correctly.

Counterexample. A UI driver reaches the correct screen and captures a screenshot, but never reloads the app. The screenshot supports the displayed state. It does not establish that the setting was saved.

## Supervision begins with shared understanding

Part two identifies poor specification and missing context as recurring failure modes in the author's experience. Its proposed response starts by asking the agent to restate the problem before prescribing the implementation. It separates investigation of current mechanics from investigation of historical intent.

This distinction matters to Neuve's sources of truth. Current code can establish what the implementation does. A decision record can establish why someone chose it. A product requirement can establish what it ought to do. Those sources can disagree without any one source being fake.

Part two also advocates describing use before machinery. A tutorial or caller example makes a proposed design tangible. Competing prototypes answer empirical questions. This supports our decision to begin with user decisions and concrete review examples before component diagrams.

The article warns that adversarial review of abstract plans can invent hypothetical risks. That warning is relevant to this process. Research should expose observed failure modes and explicit tradeoffs. It should not generate an ever-growing list of speculative requirements.

Inference for discussion. Human understanding belongs in Neuve's product outcome. Reducing the number of items shown to a reviewer is not enough if the remaining summary cannot be explained or challenged.

## Verification has stages and limits

Loops You Can Trust is the most relevant source for distinguishing development work from post-validation review. The author describes separate triage, reproduction, and fixing stages. Each can stop when its own evidence is inadequate. Before-and-after artifacts help humans judge whether the agent understood the problem, leaving code quality and remaining judgment as separate review work.

The article also describes checking a change already in progress and rerunning verification after merge. This supports thinking about evidence applicability across stages. It does not prescribe a new agent review at every transition.

Its strongest counterexample is the large StyleX migration. The author reports visual parity for the captured states, followed by defects found during dogfooding involving stacking order, global class consumers, and specificity. The response was smaller migration units, broader dependency checks, and additional state coverage. These are author-reported observations, not independently reproduced results.

Inference for discussion. A passing result must keep its scope attached. Neuve should make it possible to say that the captured visual states passed while other interactions remain unexamined. Decomposition reduces the cost of finding and repairing mistakes, but it does not eliminate obligations that cross unit boundaries.

The article's human-objection window is a workflow example. It does not establish a general rule that silence authorizes action. The authority needed to close a human-required unit must be specified separately.

## Maintenance should improve the checking system

The gardener and organic-architecture posts argue for turning repeated defects or code smells into lasting constraints. The linked [anti-slop repository](https://github.com/dmmulroy/anti-slop) makes an important qualification. Its README calls the rules the author's preferences and taste, and asks adopters to adapt them. It is an example of enforcing chosen standards, not evidence that those standards are universally correct.

Inference for discussion. A recurring human review should prompt a question about whether some of that obligation can become a deterministic check. The proposed rule still needs a demonstrated failure case, acceptable false-positive behavior, an owner, and a way to revise it. Otherwise reducing one person's repetitive work can impose unnecessary restrictions on everyone else.

This is a possible feedback loop for Neuve. A human resolves an ambiguity, the decision becomes an explicit constraint, a tool enforces the portion that can be checked, and later changes receive narrower human obligations. The product need not create every checker itself to support that loop.

## Claims we are not adopting as ground truth

Part one claims very large productivity multipliers and reports thousands of PRs. Part two reports high throughput and quality. The articles do not provide controlled evidence that isolates the effects of the workflow, models, codebase, team, and infrastructure. We retain the mechanisms as hypotheses and experience reports, not Neuve performance targets.

The claim that agents can write better code than people is the author's framing. It does not remove the need to establish authority, completeness, or user intent. Repeated model agreement also does not prove independent verification.

The articles favor deleting temporary execution plans after completion. Our durable corpus has a different purpose. It records agreed product definitions and architecture rationale, which the user explicitly wants to retain. Historical plans can be evidence without remaining active instructions.

## Questions this adds to the specification

- Does Neuve merely display evidence, or does it help obtain missing evidence during development?
- How does it connect user-visible behavior, intended constraints, code changes, and verification results?
- What does an agent reviewer have to contribute before its judgment changes the work assigned to a human?
- How can a human correct one decision without rerunning unrelated work?
- What observation would show that a repeated human obligation can safely become an automated check?
- Which decisions remain human-required even when all available checks pass?

The current proposal is to discuss these through one ordinary change and one difficult change. No implementation framework, agent topology, permission policy, or storage design is selected here.
