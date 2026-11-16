# Launch article outline

Status: round 6, on the owner's rejection of round 5. The post's headline and lead are the owner's own pair, word for word: "Large code changes never felt so small" and "Focus only on parts that require human attention or approval, with the certainty your codebase deserves." The feeling the owner wants: not being overwhelmed by a large change or afraid of it, because Neuve filters out the parts people aren't required to see and attaches the right information to the parts that matter. The post doesn't say "agents never approve", because agents and people review together, and it says "parts", not "review units". It presents Neuve's review only, as decision 13.9 sets for the first release, and quotes no internal numbers (13.12, 13.24). The owner has already published the argument, in "Code review is now a data problem" (X, 2 November 2026). This outline is for the launch post that follows it. That post builds on the article in new words, adds what Neuve does today, and points to the repository. The owner writes it. Each section gives its job, the points it could make and the repository source behind each product claim. The owner's view needs no source.

## Working title

The post's headline and lead come from the image strings in [social](social.md#banner-and-og-image-text): "Large code changes never felt so small" and "Focus only on parts that require human attention or approval, with the certainty your codebase deserves." The article hero has no overline: the owner removed "Why I built Neuve" (11 November).

## 1. Where this started

**Job:** the owner's story, short, linking back to the article.

- Building agents for QA showed that QA wasn't where teams were stuck. Code review was. **Owner's story.**
- The coping strategies: agent digests, triage and "there's an agent for that". They miss three marks: validation, understanding the change, and the unit of change. **Owner's view;** don't name or knock other tools.
- The pull request is often the wrong unit to review in. **Owner's view;** say it in new words, not the article's.

## 2. What review is for now

**Job:** the post's thesis, in new words: the goal is to understand and validate a change.

- **Understand and validate the change.** That's the main goal. **Owner's view.**
- **We're overloaded.** A large diff is more than anyone can hold in their head, and more of us review code in languages and on platforms we don't know well. Large changes shouldn't be something to be overwhelmed by or afraid of. **Owner's view;** say it in new words, not the article's "bankrupt, cognitively".
- **Trust in the system, not an end to reading code.** A reader can spend less time assessing code once they trust the system to surface the important parts, but the code stays an optional surface they can always open. **Owner's view;** no "stop assessing code" absolutes.
- **We're still responsible,** so we should understand the change as a system of changes. **Owner's view.**
- **Agents and people review together.** Some parts of a change matter more than others, and people should focus only on the parts that need human attention or approval. **Owner's view;** in the product, these are the review lanes (section 5).

## 3. Why you can trust what Neuve shows you

**Job:** walk one real review through from start to finish, using the owner's desk captures, and let each step give a reason to trust it.

- The input: in a repository where `neuve setup` has run, `neuve review` takes a commit range.
- Frame: the goal and what done means (done-when conditions, in the product's terms; the post says "what done means"), from the ticket or plan Neuve can fetch, with missing scope disclosed ([pipeline record 0005](../../../architecture/decisions/0005-harness-pipeline.md)).
- Split: batches, and smaller parts within each batch (review units, in the product's terms; the post says "parts"). No changed line is left out, even when a run is cut off.
- Find: four independent agents for scope fit, correctness, risky edges and tests.
- Check: each finding is checked again in a fresh context, against evidence Neuve gathers up front (no lookup tools), and the verified ones cite the source locations they rest on ([`link.ts`](../../../packages/harness/src/link.ts)). Unchecked findings are counted, never shown as comments.
- The summary (the digest, in the product's terms; the post says "summary"): each batch's summary states why the batch exists and links verified findings to the parts that hold them, up to its length limit ([`link.ts`](../../../packages/harness/src/link.ts)).
- Decide: verified defects become requests for changes on the lines they're about, and risks and questions become comments. The person reads as much of each part's diff as they want and records their review in the review desk. On human-required work only a person can approve: Records refuses an agent's approval there ([`rules.ts`](../../../packages/records-core/src/rules.ts)).
- **Once 13.11 is on `main`:** a person can approve any human-required part, with or without findings. Until then, say that Approve overrules an agent's request for changes.
- Two readers: people use the overview of each batch and the review desk, and agents read the same review through the CLI.

## 4. Change and context, for agents too

**Job:** the article's last idea, and how much of it is true today.

- Agents should be able to find and review the scope of a change on their own. **Owner's view.**
- What's true today: verified findings cite their source locations ([`link.ts`](../../../packages/harness/src/link.ts)), and hooks link commits to the agent session that made them, where it can be identified ([setup guide](../../../apps/neuve-cli/SETUP.md#capture-commits-and-agent-sessions)).
- Context attributed to every part is where it's heading.

## 5. Where it's heading

**Job:** the design, clearly apart from today's runs.

- How agents and people share the work: the four review lanes. Agents decide agentic work. On human-suggested work a decision the agents have made stands unless a person steps in, and human-required work waits for a person ([vocabulary](../../../vocabulary.md#responsibility-and-review-flow)). A rule in code maps a cited assessment to a lane ([`lane-rule.ts`](../../../packages/harness/src/lane-rule.ts)).
- Today's runs put every part in human-suggested, and the agents only request changes or comment, so each part still comes to a person ([record 0007](../../../architecture/decisions/0007-batches-units-lanes-and-cycles.md#fixed-shape-trial)).
- **Owner to choose** which next steps to name. Current scope lives in Linear.

## 6. Built with itself

**Job:** credibility through practice.

- Since 9 November 2026, our build process requires each new workstream to run a Neuve review, and an independent reviewer confirms or refutes its findings ([lane loop](../../../process/neuve-in-the-loop.md)).
- Quality and total token cost are the measures. Estimated time saved deliberately isn't one ([measurement commitments](../../../foundations/01-product-purpose.md#measurement-commitments)).
- No internal numbers: no benchmark, eval or scored-check numbers, model-call counts or call budgets (13.12, 13.24).

## 7. Open, local and the ask

**Job:** the open-source story and an invitation.

- MIT-licensed, "Copyright (c) 2026 Neuve AI". **Open:** this waits on the `LICENSE` file landing on `main`.
- Today the review desk runs as a local web server, and the append-only record log lives in the repository's shared Git directory ([`location.ts`](../../../packages/records-core/src/location.ts)). Don't claim there's no hosted service or no Neuve account, and don't promise it stays local (13.24).
- Model calls leave your machine for the provider you set up: an Anthropic API key or a ChatGPT subscription ([`route.ts`](../../../packages/harness/src/route.ts)).
- Credits: Neuve's host and channel packages are adapted from GitHub Next's Ace (MIT), Neuve Graph forks Entire Graph (MIT), and the desk's diffs use a modified copy of Pierre's `@pierre/diffs` (Apache-2.0).
- The install: `curl -fsSL https://neuve.ai/install.sh | sh`, then `neuve setup` in your repository, labelled "Coming with the first release" until it works. It runs on macOS and Linux, and on Windows through WSL, once `oss-dist`'s release builds cover them (13.13).
- The ask, from the article: tell me your struggles, friction points and sticking points with code review. Try it on a real branch.

## Visuals the post needs (for `oss-brand`)

- The article hero, with "Large code changes never felt so small" and "Focus only on parts that require human attention or approval, with the certainty your codebase deserves."
- The owner's desk captures from the article.
- An optional strip: commit range → frame → split → find → check → you decide.
