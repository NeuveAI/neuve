# Neuve messaging

Status: round 6, written 11 November 2026 for the owner's yes. The owner rejected round 5's copy, so this round uses the owner's own lines and writes no new ones. The landing hero takes one pair and the README, the posts and the launch images take the other. Body copy adds only plain facts about what Neuve does, each true of `main`. The copy doesn't say "agents never approve", and it keeps "review units" out of headlines, leads, images and posts. It follows decision 13.9: the first release is Neuve's review on its own, so the copy covers `neuve setup`, `neuve review`, the batch overview and the review desk, and leaves out the coding workspace. The owner's article, "Code review is now a data problem" (X, 2 November 2026), is the voice source, not the script. Nothing here is approved, and nothing gets posted without the owner's explicit yes. Approved strings go to the `oss-copy` hand-off notes, and `oss-site`, `oss-brand` and `oss-frontdoor` take their copy from there.

The copy makes two kinds of statement, and they stay apart:

- **The owner's lines and view:** the two pairs below and the article's argument. They're the owner's words and need no proof.
- **Product claims** in body text are true of the code on `main` today. Each one links to its source in [the proof points](#proof-points-true-today).

## The owner's lines

| Slot | String |
| --- | --- |
| Landing hero, headline | Understand and validate change with a clear mind |
| Landing hero, subline | Validate changes without breaking your flow or overwhelming humans with context they don't need to see. |
| README hero and launch images, headline | Large code changes never felt so small |
| README hero and launch images, subline (the images' lead) | Focus only on parts that require human attention or approval, with the certainty your codebase deserves. |
| X header, short lead (only if the full lead doesn't fit) | Focus only on parts that require human attention or approval. |
| One-liner (landing's final call to action, article hero) | Large code changes never felt so small |
| Landing footer tagline | Understand and validate change with a clear mind. |
| Repository description | Large code changes never felt so small. Focus only on parts that require human attention or approval, with the certainty your codebase deserves. |

The feeling the owner wants is not being overwhelmed by a large change, or afraid of it, because Neuve filters out the parts people aren't required to see and attaches the right information to the parts that matter.

No line sits above a headline: the owner removed the landing hero's eyebrow and the article hero's overline (11 November).

The short lead is the owner's lead cut at its first clause, for the X header, where the profile picture covers a corner. It isn't a new line, and it's used only if the full lead doesn't fit.

**In publication copy, "parts", not "review units".** "Parts" is the owner's own word in the subline. Docs use "review unit" only where a reader needs the term.

## What the lines mean in the product

The [review lanes](../../../vocabulary.md#responsibility-and-review-flow) are how agents and people share the work. Neuve puts each review unit in one of four:

- **Static automation:** checks decide, once recorded proof shows a unit meets its validation requirements (10.82). It may be empty at launch, so the copy never names it as working.
- **Agentic review:** agents decide, and people can comment.
- **Human-suggested:** the work can arrive with the agents' decision already made. A person can add judgment or request changes, and without that, the agents' decision stands.
- **Human-required:** a person decides. Agents prepare a suggested review and comments, and may request changes, but never approve.

A unit's complexity and how easy it is to validate set its lane, and history, outages and blast radius can move it.

**What's true of `main` today.** A rule in code ([`lane-rule.ts`](../../../packages/harness/src/lane-rule.ts)) maps a unit's cited assessment to its lane. The assessment that feeds it isn't part of today's trial, so today's runs record every unit as human-suggested and not assessed, and the agents only request changes or comment ([record 0007](../../../architecture/decisions/0007-batches-units-lanes-and-cycles.md#fixed-shape-trial)). So every part still comes to a person, with the verified findings attached. Body copy that describes the lanes says so once. The owner's lines stand as written.

**Launch limits (NEU-148, early warning, 11 November).** The checks-only lane may be empty at launch, and on very large reviews some units get a lane but no agent decision. Until NEU-148 sends its plain launch paragraph, the copy doesn't claim that every unit is decided by an agent or a person, and doesn't name the static-automation lane as working. That paragraph becomes the fact-check source for these sentences.

**Taglines:**

1. Large code changes never felt so small.
2. Understand and validate change with a clear mind.

## Why a reader can trust it

Each reason is a product claim with a source in [the proof points](#proof-points-true-today):

- **Findings are checked before you see them.** Each one is checked again in a fresh context, against evidence that Neuve's code gathers, with no lookup tools for the model. A finding that couldn't be checked is counted, never shown as a comment.
- **Findings show their evidence.** Verified findings cite the source locations they rest on.
- **No changed line is left out.** Each one sits in a review unit, even when a run is cut off.
- **Human-required work waits for a person.** Records refuses an agent's approval there.
- **The record stays put.** Records are append-only, so a recorded decision is never rewritten.
- **The code is always there.** The review desk shows each unit's diff, with the verified findings on the lines they're about.

## The argument, in the owner's words

This is the owner's view, condensed from the article. It's the source for the voice and the ideas. The copy restates it in new words and adds nothing.

- **Code review is now a data problem.** It's no longer a process problem, so the way we build for it and reason about it has to change.
- **Today's coping strategies miss three marks.** Those strategies are agent digests, triage and "there's an agent for that". The three marks: validation has no natural place in the process, the changes are hard to understand, and the pull request is often the wrong unit to triage and automate on.
- **Not all code has the same importance.** Blast radius, history (outages, hot paths), complexity and structural importance should decide whether CI, an agent or a person reviews each part of a change.
- **We are all bankrupt, cognitively.** Reviewer bots appeal because they take away the burden of a codebase we no longer understand. But we're still responsible for it, and we should still understand it: as a system of changes, if not line by line. "Our products cannot thrive without our careful curation."
- **Verify the changes, don't assess the code.** Like any data problem, this one needs the right visualisation tools.
- **Attribute change to context,** for people and for agents, so agents can find and review the scope of a change on their own instead of getting lost in the larger goal.

**The owner's comments on round 3 (11 November 2026)** set how the copy uses this. The main goal is understanding and validating changes. Not having to assess code is something a reader gains once they can trust the system of changes to surface the important parts, but code stays an optional surface. Neuve wins readers by trust in the system to help them validate and assess a change.

**The owner's comment on round 4 (11 November 2026)** ruled out "every change". The selling point is that Neuve helps with what needs human attention. Readers are overloaded, and some are coding in languages or on platforms they don't know well. "Every change" would drive them away.

**The owner's rejection of round 5 (11 November 2026)** replaced the copy's own lines with the owner's two pairs, above. It also set three rules:

- **"Agents never approve" is wrong.** Human-suggested work and the lanes below it are agent-approved. The whole point is agents and people collaborating, while people focus on the important parts only.
- **"Review units" is internal.** People don't know the term, so it isn't publication material.
- **The owner's lines stand as written.** Filtering what people need to see is the product's meaning, so round 5's rule that kept "what needs human attention" out is dropped. Concrete feature claims in body text stay true of `main`.

## How it works today

1. **Start a review.** Run `neuve setup` in your repository first. Then give `neuve review` a commit range there (`neuve review main..my-branch`).
2. **Frame and split.** Neuve states the change's goal and up to five done-when conditions. It works from the ticket or plan it can fetch, or from the change itself when there's none, and it says when scope is missing. Then it splits the change into batches, and each batch into review units ("smaller parts" in publication copy). No changed line is left out.
3. **Find and check.** Four agents look for problems: scope fit, correctness, risky edges and tests. Each finding is checked again in a fresh context before you see it. A finding that couldn't be checked is counted, never shown as a comment.
4. **Findings on their lines.** Each batch's digest says why the batch exists and links verified findings to the units that hold them, up to its length limit. Verified defects arrive as requests for changes, pinned to the lines they're about, and risks and questions arrive as comments.
5. **Validate and decide.** You work through the batch overview and the review desk, read the code wherever you want to, and record your review. Your coding agents can read the same review through the CLI.

## Where it's heading

- **The assessment that sets each unit's lane,** described above. Today's runs record every unit as human-suggested.
- **Change attributed to its context, for people and agents.** Some pieces are true today:
  - Verified findings cite their source locations.
  - Hooks link commits to the agent session that made them, where that session can be identified.

  Context attributed to every review unit is still the design.

## Who it's for

- **Developers who work with coding agents** (Claude Code, Codex) and are still responsible for what those agents write, including code in languages or on platforms they don't know well.
- **Small teams** where review limits how much agent work can land.
- **People building agent workflows** who want their agents to read a review through a CLI, from the same record a person decides on.

## What it isn't

- **Not a bot on your pull request.** The review happens in Neuve's own review desk, and Neuve posts no reviews or comments to GitHub.
- **Not CI.** It doesn't run your tests.
- **Not finished.** It's early. It runs on macOS and Linux, and on Windows through WSL.

## Proof points true today

An independent Codex reviewer checked each row against `main`: three passes in round 1, and again in rounds 2, 3, 3.1, 4, 5 and 6. Round 5 added the last two rows. Round 6 rewrites the first: it no longer says "agents never approve".

| Claim | Where it's true |
| --- | --- |
| In today's runs, the agents' findings arrive as requests for changes (from verified defects) and comments, and Records refuses any approval of human-required work from an actor that isn't a human | [Record 0005](../../../architecture/decisions/0005-harness-pipeline.md#trial-publication-rules), [`publish.ts`](../../../packages/harness/src/publish.ts), [`rules.ts`](../../../packages/records-core/src/rules.ts) |
| Four independent finders (scope fit, correctness, risky edges, tests) | [Record 0005](../../../architecture/decisions/0005-harness-pipeline.md#decision) |
| Each finding is checked in a fresh context, against evidence that code supplies, before it's published. Unchecked findings become counts, never comments | [Record 0005](../../../architecture/decisions/0005-harness-pipeline.md#decision) |
| No changed line is left out of a review unit, even when a run is cut off | [Record 0005](../../../architecture/decisions/0005-harness-pipeline.md#decision) |
| Frame states the goal and up to five done-when conditions, and missing scope is disclosed | [Record 0005](../../../architecture/decisions/0005-harness-pipeline.md#decision), [`scope-text.ts`](../../../packages/harness/src/scope-text.ts) |
| Verified findings cite the source locations they rest on | [`link.ts`](../../../packages/harness/src/link.ts) |
| Records are append-only. The database refuses to update or delete an event | [`schema.ts`](../../../packages/records-core/src/schema.ts) |
| The record log is `<git common directory>/neuve/records.sqlite`, with larger artefacts stored beside it | [`location.ts`](../../../packages/records-core/src/location.ts), [record 0009](../../../architecture/decisions/0009-identity-without-auth.md) |
| Model calls go to an Anthropic API key or a ChatGPT subscription | [`route.ts`](../../../packages/harness/src/route.ts) |
| Hooks record Claude Code and Codex sessions, with each turn's model and token counts, and never reject a prompt or a commit | [Setup guide](../../../apps/neuve-cli/SETUP.md#capture-commits-and-agent-sessions) |
| Reviews are recorded in Neuve's desk, and the review pipeline posts no reviews or comments to GitHub | [`desk.server.ts`](../../../apps/neuve-web/apps/web/src/server/desk.server.ts) |
| Since 9 November 2026, our build process requires each new workstream to run a Neuve review, and the independent reviewer confirms or refutes its findings | [Lane loop](../../../process/neuve-in-the-loop.md), [decision 12.54](../../../process/decisions.md#area-12-ace-style-pi-transition-28-october-2026) |
| `neuve review` reviews the repository in the current folder unless `--repo` names another | [`review-cli.ts`](../../../apps/neuve-cli/src/review-cli.ts) |
| Neuve's host and channel packages (`@ace/host` in `apps/neuve-host`, `@ace/channel` in `packages/channel`) are adapted from GitHub Next's Ace at commit fe66277 (MIT). Neuve Graph forks Entire Graph (MIT), and the review desk's diffs render with a modified copy of Pierre's `@pierre/diffs` (Apache-2.0) | [`apps/neuve-host/NOTICE`](../../../apps/neuve-host/NOTICE), [`packages/channel/NOTICE`](../../../packages/channel/NOTICE), the `LICENSE` in the `apps/neuve-graph` submodule, [`apps/neuve-web/packages/diffs/NOTICE.md`](../../../apps/neuve-web/packages/diffs/NOTICE.md) |
| The review desk shows each review unit's diff, with review comments, including the agents' verified findings, on the lines they're about | [`diff-file.tsx`](../../../apps/neuve-web/packages/ui/src/neuve/review-desk/diff-file.tsx), [`review-comments/record.ts`](../../../apps/neuve-web/packages/ui/src/neuve/review-comments/record.ts) |
| Each batch's digest states the change's goal, why the batch exists and how many units it has. It links verified findings to the review units that hold them, up to the digest's length limit. Findings past the limit stay in their units' comments, and the digest's limitations say how many | [`link.ts`](../../../packages/harness/src/link.ts) (`groupDigest`) |
| Today's runs record every review unit as human-suggested and not assessed, so every unit comes to a person | [Record 0007](../../../architecture/decisions/0007-batches-units-lanes-and-cycles.md#fixed-shape-trial), [`compose.ts`](../../../packages/harness/src/compose.ts) |

**The owner's statements, not product claims:** the owner's two pairs of lines, "built for almost a year", the article's argument, and that readers are overloaded or reviewing languages and platforms they don't know well.

**Claims that hold only at launch:**

- **Platforms** (13.13): install runs on macOS and Linux at launch, and on Windows through WSL at first. The copy says so once `oss-dist`'s release builds and tests cover those platforms.
- **Approving any human-required unit** (13.11): a person can approve any human-required review unit, with or without findings. The desk and the rules that record a person's disposition change for it, and that isn't on `main` yet. Until it is, the copy says what's true today: Approve is offered only to overrule an agent's request for changes.

## Voice rules

1. **The owner's lines are the copy.** Use the two pairs word for word, in the slots set above. Don't write new headlines, sublines, leads or taglines. Editing is for grammar and consistency only.
2. **The owner speaks in the first person** in the posts, the article and the README's "why". The product pages say "you".
3. **The article is the voice source, not the script.** Don't lift its lines into the headlines, sublines, images, hero or README.
4. **No "agents never approve".** Agents and people review together: agents decide agentic work, and a decision they've made on human-suggested work stands unless a person steps in. Don't present agents as never approving. Copy can say that on human-required work only a person approves.
5. **"Review units" stays internal.** Keep it out of headlines, leads, images and posts, and say "parts" there. Docs use it only where a reader needs the term.
6. **No promise of reading it all.** Don't promise "every change", "every finding" or "every line". Completeness can be a reason to trust the review ("no changed line is left out").
7. **Body claims are true of `main`.** The owner's lines stand as written. Every concrete feature claim in body text has a source in the proof points. Where body copy describes the review lanes, it says once that today's runs put every part in human-suggested.
8. **Never say Neuve proves a change correct,** teaches a language or explains code in plain words.
9. **Common terms for readers** (13.24). Reader-facing explanations use common words, or link a product term visibly to what it names: "parts" for review units, "summary" for a batch's digest, "what done means" for done-when conditions, "an overview of the change, one batch of related work at a time" for the batch overview. Where the copy does use a product term, use it exactly as [the vocabulary](../../../vocabulary.md) defines it, and never coin a product noun.
10. **Don't name or knock other tools.** Describe Neuve directly.
11. **No internal numbers** (13.12, 13.24): no model-call counts, call budgets, run limits, finding caps, or eval, benchmark or scored-check numbers, and no "hours saved" or "x% faster". A number that describes the product's shape, such as four agents, is fine.
12. **Say the stage once, plainly:** early, and the platforms as 13.13 sets them. The landing page carries no stage line: the owner removed it (round 6.1).
13. **British spelling** (behaviour, visualisation, artefact) and **sentence case** for every heading, button and label. When the article is quoted, its spelling stays as published.

## Decided since round 1

- **Licence:** MIT, "Copyright (c) 2026 Neuve AI" (13.8). The strings say MIT, but none of them ships until the `LICENSE` file is on `main`.
- **Install:** a one-line install at launch: `curl -fsSL https://neuve.ai/install.sh | sh`, then `neuve setup` (13.5). Until `oss-dist` ships it, it's labelled "Coming with the first release", and "Get started" doesn't point at it.
- **Domain:** neuve.ai. **Conduct contact:** support@neuve.ai (13.6).
- **The four review lanes** are how agents and people share the work. Body copy that describes them says once that today's runs put every part in human-suggested.
- **Review only** (13.9, 11 November): the first release is Neuve on its own. The copy shows `neuve setup`, `neuve review`, the batch overview and the review desk. `neuve workspace`, `@neuve` in a coding chat and Ace's coding app are left out. The host and channel packages adapted from Ace ship as part of Neuve (13.9 as corrected on 11 November), so GitHub Next's Ace keeps its credit for them. The credit isn't presented as a feature.
- **The current folder** (13.10): a review runs on the current folder, after `neuve setup` has run there. The copy orders the steps that way and doesn't claim that a review stops when setup hasn't run, because that isn't on `main` yet.
- **Approving any human-required unit** (13.11): settled. The copy says so only once it's on `main`.
- **No internal numbers** (13.12, widened by 13.24): the landing page, README, posts and images quote no benchmark, eval or scored-check numbers, no model-call counts and no call budgets.
- **No hosted-service or account claims** (13.24): the copy never says there's no hosted service or no Neuve account. It says what's true today, that reviews run on your machine with your own model provider, only where needed, and never promises it stays that way.
- **Platforms and the README's scope** (13.13): macOS and Linux at launch, and Windows through WSL at first. The README covers installing, setting up and running Neuve. Working from a checkout, including building from source, goes in `CONTRIBUTING.md`, which the README links to.
- **Ace in the public tree** (13.16): Ace stays in the public tree as part of the monorepo, unpresented. The copy doesn't mention it beyond the credits.
- **Positioning** (the owner's comments on round 3): lead with understanding and validating changes, win the reader by trust, keep code as an optional surface, and lift no lines from the article.
- **The promise** (the owner's comment on round 4): not "every change".
- **The owner's lines** (the owner's rejection of round 5, 11 November): the two pairs above, word for word. No "agents never approve", and no "review units" in headlines, leads, images or posts.

## Open for the owner

- **The X header's short lead,** only if `oss-brand` finds the full lead doesn't fit there.
- **Claude Code sign-in.** Add it to the model-provider line once it's on `main` and Anthropic's approval for claude.ai sign-in is confirmed (NEU-143).

## Open for other tracks

- **The public repository's URL,** from 13.2's new repository, for "View on GitHub" and the README clone line.
- **`oss-frontdoor`:** "Build from source" links to `CONTRIBUTING.md` (13.13), and stays the route until the one-line install works.
- **`oss-dist`:** the platform line ships once the release builds and tests cover macOS, Linux and Windows through WSL (13.13).
- **Opening the desk** from the installed `neuve`, without the coding workspace (13.9). It's `neuve review desk` on NeuveAI/neuve#20. The copy names it once #20 is on `main`, and until then says "open the review in the review desk".
- **Setup's credential check** (#20): `neuve setup` ends with a check of the review credential, and `neuve doctor` checks the provider. The README already puts the provider step before `neuve setup`. The copy names both checks once #20 is on `main`.
- **Approve on every human-required unit** (13.11): the copy switches to "approve a part or request changes" once it's on `main`.
