# Landing page copy

Status: round 6, on the owner's rejection of round 5. The hero is the owner's own pair, word for word: "Understand and validate change with a clear mind" and "Validate changes without breaking your flow or overwhelming humans with context they don't need to see." The final call to action uses the owner's other headline, "Large code changes never felt so small". The rest of the page says plainly what Neuve does, and each product claim there is true of `main`. The page doesn't say "agents never approve", because agents and people review together, and it doesn't say "review units", a term readers don't know: it says "parts". It takes no lines from the owner's article. The first release is Neuve's review on its own (decision 13.9), so the page shows `neuve setup`, `neuve review`, the batch overview and the review desk, and nothing of the coding workspace. `oss-site` builds from the approved hand-off, not from this draft. Labels are in sentence case. **Open** marks copy that waits on a decision or on work that hasn't landed.

## Hero

- **Headline:** Understand and validate change with a clear mind
- **Subline:** Validate changes without breaking your flow or overwhelming humans with context they don't need to see.
- **Primary CTA:** View on GitHub
- **Secondary CTA:** Read the launch post
- **Install block,** labelled **Coming with the first release:**

  ```sh
  curl -fsSL https://neuve.ai/install.sh | sh
  neuve setup
  ```

  Link under it: **Build from source →** (to `CONTRIBUTING.md`, which holds working from a checkout under 13.13).

The primary CTA becomes **Get started**, pointing at the install block, only once the install line works. Until then, "Get started" would lead to a command that doesn't run.

The subline replaces round 5's hero paragraph. What Neuve does is told under "How it works". The hero has no eyebrow: the owner removed it (11 November).

**Hero visual:** the owner's own desk captures, such as the units "Index writes retry when the database is busy" and "Revoke cuts off open sessions". Use real captures, not mocks.

## How it works

- **Heading:** From a commit range to your call

| Step | Title | Body |
| --- | --- | --- |
| 1 | Start a review | Run `neuve setup` in your repository first. Then run `neuve review` there with a commit range. |
| 2 | Frame and split | Neuve states the change's goal and what done means, from the ticket or plan it can fetch, and says when there isn't one. Then it splits the change into batches, and each batch into smaller parts. No changed line is left out. |
| 3 | Find and check | Four agents look at scope fit, correctness, risky edges and tests. Each finding is checked again in a fresh context, and one that can't be checked never becomes a comment. |
| 4 | Findings on their lines | Each batch's summary says why the batch exists and links findings to the parts that hold them. Verified defects arrive as requests for changes, pinned to their lines. Risks and questions arrive as comments. |
| 5 | Validate and decide | Read as much of the code as you want, then record your review in the review desk. |

## The review desk

- **Heading:** From the overview to the line
- **Body:** From the overview of a batch, open one of its parts to review it. The facts say what changed. The diff shows the code, as much of it as you want to read. Findings sit beside the lines they're about, each citing the code it rests on. Then record your review in the decision dock.
- **Callout links** (for `oss-site`): the paragraph names the capture's four numbered callouts once each, in order: "The facts" (1), "The diff" (2), "Findings sit beside the lines" (3) and "the decision dock" (4). Each name links to its number, the way briefings cite code, so the product terms point at what they name.
- **Open:** how the installed `neuve` opens the desk. Today the desk runs from a checkout, and decision 13.9 needs a way that doesn't go through the coding workspace. Show at launch only desk features that `oss-site` can capture from a real run.

## Agents and the CLI

- **Heading:** Built for two readers
- **Body:** People review in the desk. Agents read the same review through the `neuve` CLI, from the same record you decided on. Hooks record your Claude Code and Codex sessions, link commits to the agent session that made them where it can be identified, and count each turn's tokens. They never reject a prompt or a commit.

```sh
neuve setup                      # first, in your repository
neuve review main..my-branch     # review a commit range in this repository
neuve review show --run <run-id> # read a finished review
```

- **Small print:** Model calls go to the provider you set up: an Anthropic API key or a ChatGPT subscription. **Open:** add Claude Code sign-in once it's on `main` and approved (NEU-143).

## Where it's heading

- **Heading:** The right reviewer for each part of a change
- **Body:** Some parts of a change matter more than others. Neuve puts each part in one of four review lanes: static automation, agentic review, human-suggested review and human-required review. Its complexity and how easy it is to validate set the lane. Agents decide agentic work. On human-suggested work, a decision the agents have made stands unless a person steps in. Human-required work waits for a person.
- **Today line** (beside the lane matrix): Agents approve agentic parts or request changes on them. A part no agent could judge comes to you, with a note saying so.

## Open source

- **Heading:** Open source
- **Body:** Neuve is MIT-licensed, and we use Neuve to review Neuve. Today, reviews run on your machine, with the model provider you set up.
- **Facts list** (unchanged): Licence MIT · Records append-only in your repository's shared Git directory · GitHub: Neuve posts no reviews or comments to GitHub · Dogfood.
- **Credits line:** Neuve's host and channel packages are adapted from GitHub Next's [Ace](https://github.com/githubnext/ace), and its graph engine is a fork of [Entire Graph](https://github.com/entireio/entire-graph), both MIT-licensed. Diffs render with a modified copy of Pierre's [`@pierre/diffs`](https://github.com/pierrecomputer/pierre) (Apache-2.0). **Open:** `oss-cleanup` owns the final credits line, including any font credit.
- **CTA:** Read the source
- **Open:** the MIT strings wait on the `LICENSE` file landing on `main`.

## Final call to action

- **Heading:** Large code changes never felt so small
- **Primary CTA:** View on GitHub
- **Secondary CTA:** Read the launch post

## Footer

- **Tagline:** Understand and validate change with a clear mind.
- **Columns:** Product (How it works, Review desk, CLI) · Project (GitHub, Changelog, Contributing, Security) · Writing (Launch post)
- **Fine print:** MIT License · Copyright (c) 2026 Neuve AI · support@neuve.ai
- **Open:** the public repository URL and the social handles.
