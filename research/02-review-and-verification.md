# Code review, verification, and agent supervision

Research date: 2026-09-17. Status: research input for discussion, not accepted architecture. All linked sources were retrieved on this date. This is a bounded representative survey, not a product ranking or a claim that one technique is state of the art on every workload.

The strongest common direction is to turn a proposed change into explicit claims and collect evidence for each claim. The weak point is deciding whether those claims cover what matters. More reviewers, passing tests, and a larger repository context do not settle that question by themselves.

## What the sources actually establish

### Production review systems

**Anthropic Code Review.** Its March 9, 2026 announcement describes parallel bug discovery, a separate verification step, severity ranking, and review effort that scales with the change. Anthropic reports substantive comments on 54% of internal PRs compared with 16% previously, and fewer than 1% of findings marked incorrect. These are vendor-reported deployment observations. The denominator for correctness is reported findings, not all defects; unmarked findings do not establish correctness. The system does not approve PRs. Useful mechanism: distinguish candidate discovery from admission of a finding into the human queue. Missing evidence: independently measured escaped defects and total human investigation time. [Primary announcement](https://claude.com/blog/code-review).

**Atlassian RovoDev.** The authors describe context-aware generation with review guidance and quality checking. Their year-long offline, online, and user-feedback study reports that 38.70% of comments led to subsequent code changes, alongside 30.8% shorter PR cycle time and 35.6% fewer human comments. This is a vendor-authored empirical paper accepted at ICSE 2026 SEIP, stronger evidence than an isolated demonstration but still specific to its deployment and evaluation. A code change following a comment is an operational usefulness measure, not proof that the comment fixed a defect. Fewer human comments could reflect reduced work or reduced scrutiny. [Paper, January 20 revision](https://arxiv.org/abs/2601.01129v2).

**GitHub Copilot review.** GitHub's application card treats review outputs as feedback and suggested changes, describes overreliance as a limitation, and asks users to verify findings. This establishes the intended authority boundary of the product, not its detection rate. Its documentation is useful evidence that a review agent's access, permissions, and output role deserve explicit treatment apart from its model capability. [Application card](https://docs.github.com/en/copilot/responsible-use/agents).

### Evaluation that challenges the sales story

**c-CRAB.** This benchmark converts human review concerns into executable tests, validates that tests fail before and pass after the human fix, then has a coding agent revise code using the tested reviewer's comments. Its 184 PR instances contain 234 test oracles. Version 3 reports 67 repositories in Table 4 but 56 in the threats-to-validity section, an internal inconsistency that this memo leaves unresolved. The authors report that the tested reviewers collectively cover only around 40% of tasks. This measures actionable recovery of selected human concerns, not universal bug recall. It also measures a reviewer-plus-fixer pipeline. The construction filters for concerns expressible as tests and fixable by the chosen coding agent, and does not directly credit every valid additional finding. Useful mechanism: evaluate whether feedback supports a correct change, not whether its wording resembles a reference comment. [Paper, April 7 revision](https://arxiv.org/html/2603.23448v3).

**CR-Bench.** This separate benchmark reconstructs defect-bearing PRs from SWE-bench histories. Its verified subset has 174 tasks; the study compares single-pass and Reflexion protocols with GPT-5.2 and GPT-5-mini, using Claude Sonnet 4.5 as judge. For GPT-5.2, Reflexion increases reported recall from 27.01% to 32.76%, while the study's useful-to-spurious finding ratio falls from 5.11 to 1.95. Crucial caveat: the published Reflexion prompt favors adding missed findings and discourages empty results. This is evidence about that protocol, not proof that all iterative review adds noise. The ground-truth defect list is incomplete, the task mix is skewed, and model judging affects measurements. [Paper and prompts](https://arxiv.org/html/2603.11078v1).

**Benchmark oracles can be wrong.** OpenAI audited 138 frequently failed SWE-bench Verified tasks and reports material issues in 59.4% of that selected subset. It identifies tests that require an unspecified implementation and tests that demand behavior beyond the task description, plus evidence of training contamination. Do not generalize 59.4% to the full dataset. The practical lesson for Neuve is that an executable check needs a traceable relationship to an agreed requirement. A reproducible wrong expectation remains wrong. This is a provider's analysis of a benchmark it previously helped curate. [Research report, February 23, 2026](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/).

**Execution environment affects results.** Anthropic reports a six-percentage-point spread between resource configurations in Terminal-Bench 2.0 experiments. CPU, memory, enforcement policy, and time limits changed which agent approaches succeeded. This does not measure code review directly. It does show why an apparent verification failure can be an infrastructure failure, and why run configuration belongs with the evidence. [Experimental report, February 5, 2026](https://www.anthropic.com/engineering/infrastructure-noise).

### Repository and development environments

**OpenAI's internal repository experiment.** The team describes repository-local knowledge with a short entry point, linked documents, mechanical document checks, architecture constraints enforced by linters, and agent review loops. This is an engineering account, not a controlled causal study. The transferable idea is to convert stable, agreed constraints into tools that give specific corrective feedback. Its chosen architecture is specific to that product and should not become Neuve's architecture by imitation. A rule that is easy to enforce still needs a product reason to exist. [Engineering account, February 11, 2026](https://openai.com/index/harness-engineering/).

**Anthropic's long-running development experiment.** It uses an initializer, a feature list, incremental work, progress records, Git history, and checks of the running application. The account describes premature completion and poor handoffs as recurring failures. Its scope is largely web applications, and it does not establish that a particular file format or multi-agent topology is universally best. Useful distinction: persistent records describe what an agent believes happened; a fresh check of the application establishes what currently happens. [Engineering account, November 26, 2025](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents).

**Generator and evaluator contracts.** Anthropic's March 24, 2026 application experiment has a generator and evaluator agree on testable sprint criteria before implementation. The evaluator then exercises the application through Playwright. The author reports that early evaluators found defects yet excused them, or tested superficially; prompts improved through inspection of disagreements with human judgment. This supports examining the evaluator as a fallible system with its own acceptance criteria. It does not prove that two agents agreeing on a contract means the contract represents the user's intent. [Engineering account](https://www.anthropic.com/engineering/harness-design-long-running-apps).

**Static analysis has a model too.** CodeQL's documentation distinguishes syntax structure from data-flow relationships, local from global analysis, and ordinary flow from taint tracking. Missing library source, runtime dispatch, aliasing, and computational cost complicate completeness. A precomputed repository graph can help find relevant code, but the presence or absence of an edge is meaningful only relative to how that graph was built. A graph index alone is not a sound program analysis. [CodeQL technical documentation](https://codeql.github.com/docs/writing-codeql-queries/about-data-flow-analysis/).

### Supervision and independence

**Multi-agent failure taxonomy.** In version 3, Cemri and colleagues report more than 1,600 annotated traces across seven frameworks. They developed the taxonomy through expert-guided analysis of 150 traces, identifying 14 failure modes spanning system design, inter-agent misalignment, and task verification. The work is not a direct evaluation of Neuve's proposed workflow, and the original experiments predate current models. It gives concrete categories for testing the workflow itself, including failures that adding another agent does not automatically fix. [Research paper, version 3, October 26, 2025](https://arxiv.org/abs/2503.13657v3).

**Debate incentives matter.** Chen and colleagues distinguish competitive debate, consensus-seeking debate, and a collaborative protocol. Their July 2026 revision argues that the first two can encourage misleading persuasion or premature agreement, and reports gains for their alternative on evaluated tasks. These are research results on the tested protocols, not a guarantee for code review. An antagonistic reviewer should seek a falsifying example, not be rewarded for winning a disagreement or producing a minimum number of objections. [Research paper, July 14 revision](https://arxiv.org/abs/2510.20963v2).

**Agent evaluation needs multiple kinds of judgment.** Anthropic's evaluation guide separates code-based, model-based, and human graders, and distinguishes execution traces from resulting state. It recommends calibration and combining methods according to what is being evaluated. This is methodological guidance from deployment experience. It supports measuring user-visible outcomes and reviewing grader quality rather than treating a persuasive transcript as successful execution. [Engineering guide, January 9, 2026](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents).

## Consequences to discuss, not decisions already made

The following are proposed interpretations of the evidence above. They need testing against Neuve's actual product commitments and examples.

### Separate the question, evidence, and authority

The four quadrants appear to mix two different dimensions. Static and agentic describe how a claim is checked. Human suggested and human required describe how much authority the system retains or delegates. A single review unit might need a compiler result, an agent's analysis, and a mandatory human decision. If quadrants are exclusive buckets, that unit may lose information when it moves between them.

Before choosing a representation, settle whether a quadrant classifies a unit's current unresolved obligation, the producer of evidence, or the person allowed to discharge the obligation. These are different concepts.

CI/CD is also broader than static analysis. It can execute integration tests, deploy previews, run fuzzers, and collect runtime observations. A check can execute deterministically while depending on a fallible test oracle. We need language that describes this without implying that every automated result proves a property of the entire program.

### Define review units around claims that can be challenged

A candidate unit could name the behavior or constraint, the source that authorizes it, the affected change, expected evidence, and the remaining decision. This is a discussion aid, not a proposed schema.

Consider a change to retry a payment request. A type check may show a valid return shape. A deterministic test may show that one repeated request creates one charge. A reviewer may identify a race between concurrent requests. A human may still need to accept a product tradeoff about how long an uncertain payment remains pending. Calling the whole feature either automated or human-required obscures what has been established.

Counterexample to unlimited decomposition: individually correct units can interact incorrectly. Two changes can each preserve a local limit while together exhausting a shared resource. We need a way to discuss both a unit's boundary and obligations that cross units. A small diff is not necessarily a small semantic change.

### Keep the inner development loop and acceptance separate

The implementer/reviewer loop helps discover and correct defects while the change is being made. Its comments and experiments are useful history. Final review asks whether the exact resulting change satisfies the accepted obligations and whether anyone still owes a decision.

This does not necessarily require another model call for every unit. It requires a rule for when existing evidence remains applicable. A reviewer checking commit A cannot automatically approve commit B because B contains a small follow-up. Conversely, rerunning every expensive investigation after a spelling correction wastes attention. Evidence invalidation is therefore a product question before it is a scheduling algorithm.

An agent agreeing with the implementer is a judgment. A test passing on a named revision is an observation under defined conditions. A human authorizing a release is a decision. Neuve should help a person distinguish these statements even if all three appear in one review.

### Independence has several forms

A new context removes some conversational anchoring. A different model may change some error patterns. Neither gives statistical independence when both consume the same ambiguous requirement, incomplete retrieved context, and mistaken test expectations.

We should ask which independent information an additional reviewer contributes. Examples include a requirement the implementer omitted, a check produced before the implementation, a runtime trace, a property test, or a user who understands the operational consequence. Adding a third prose opinion to the same evidence may contribute less than one executable counterexample.

Counterexample to trusting execution alone: implementation and test both assume money uses binary floating point. All tests pass, both agents agree, and rounding violates the actual requirement. The failure originates in the shared assumption. Counterexample to requiring every finding to reproduce locally: a reviewer identifies an externally imposed rate limit that the local environment cannot simulate. The finding needs evidence and appropriate uncertainty, not automatic dismissal.

### Human review should resolve an intelligible obligation

Human-required should have a stated reason, such as deciding an unresolved requirement, accepting a consequential tradeoff, or fulfilling an explicit authority rule. It should not become a dumping ground for everything agents could not finish explaining. Human-suggested also needs a clear meaning: optional sampling, an uncertain but useful concern, and a preference question impose different obligations.

The routing error that matters most may be a unit incorrectly declared safe to leave out of the human queue. Measuring only the quality of displayed findings will miss that failure. A quiet review is useful only if silence has a defined meaning and the system exposes its coverage limits.

## Experiments worth defining before an architecture

1. Build a small corpus of real changes and past failures from Neuve's history. Include clean changes, stale documentation, incomplete tests, cross-unit interactions, and defects outside the changed lines. Separate test construction from later reviewer runs.
2. Ask humans to label the actual obligations and necessary decisions, then record disagreements. Do not force an apparently precise ground truth where the product requirement is unsettled.
3. Compare a single reviewer, independent parallel reviewers, and an implementer/reviewer loop at comparable time or token budgets. Measure unique confirmed discoveries and total human investigation time, not comment count.
4. Add execution evidence and repository-graph retrieval as separate interventions. Measure what each adds, including missed context and misleading edges. Do not assume that more context improves decisions.
5. Test unit invalidation explicitly. Change a requirement, dependency, implementation, or runtime configuration after evidence is collected. Check which claims remain supported and which need work.
6. Audit units routed away from humans. Track escaped defects and inappropriate discharge of human decisions, alongside false positives, duplicates, repair regressions, and time spent by reviewers.
7. Test completion and disagreement handling. An unresolved reviewer objection, a timed-out check, a missing environment, and a verified failure should not collapse into one vague status.

## Questions for the collaborative specification

- What promise does Neuve make when it says a unit is complete?
- Is a review unit a requirement, a claim about a change, a verification task, or a decision? Which relationships connect these if they differ?
- Are the quadrants exclusive, or can one unit have obligations in several?
- What makes a human decision required, and who is allowed to change that requirement?
- Which evidence can the implementer produce, and when is independent evidence necessary?
- What must remain understandable without trusting the agent's summary?
- How do we distinguish missing evidence, contradictory evidence, and a failing requirement?
- When does a unit become stale, and how can a person inspect why?
- What is the smallest complete example that demonstrates Neuve reduced human effort without hiding a decision the human needed to make?

No stack, model family, reviewer count, schema, or approval policy is selected by this research note.

## Follow-up: discovery before routing mechanics

The user's clarification calls for graded assessment that can change with discovery, not importing legacy marker gates. A focused source check on 2026-09-18 revisited [Anthropic's Code Review description](https://claude.com/blog/code-review): it describes agents searching, verifying candidate bugs to reduce false positives, and ranking findings by severity. This supports investigating discovery and verification separately from consequence, but the vendor description does not establish a calibrated routing algorithm for Neuve.

The [CodeQL data-flow overview](https://codeql.github.com/docs/writing-codeql-queries/about-data-flow-analysis/) is a reference for investigating graph-based relationships and analysis limits. The existing [Entire Graph investigation](03-entire-and-code-context.md) already distinguishes heuristic relation confidence from calibrated safety assurance. Neither reference selects Neuve's scoring model.

Next research question: how can new evidence revise a marker assessment, with explainable uncertainty and measured discovery cost? This focused check is not a completed comparative state-of-the-art evaluation.
