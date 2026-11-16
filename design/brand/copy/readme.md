# README copy

Status: round 6, on the owner's rejection of round 5. The hero is the owner's own pair, word for word: "Large code changes never felt so small" and "Focus only on parts that require human attention or approval, with the certainty your codebase deserves." The intro says plainly what Neuve does, and each product claim in it is true of `main`. It doesn't say "agents never approve", because agents and people review together, and it doesn't say "review units", a term readers don't know. It takes no lines from the owner's article. It presents Neuve's review only, as decision 13.9 sets for the first release, and covers installing, setting up and running Neuve; working from a checkout goes in `CONTRIBUTING.md` (13.13). This is copy for `oss-frontdoor`, which owns `README.md` and its command sections. It follows antfu's pattern: one line, a hero image, short sections, then commands.

## Hero line

Under the logo, the headline and its subline:

> **Large code changes never felt so small**
>
> Focus only on parts that require human attention or approval, with the certainty your codebase deserves.

Below the line, the light and dark hero image from `oss-brand`, then one status callout:

> [!NOTE]
> Neuve is early. It runs on macOS and Linux, and on Windows through WSL. Expect rough edges and changing commands.

**Open:** the platform sentence ships once `oss-dist`'s release builds and tests cover those platforms (13.13). If the README merges before they land, the NOTE reads "Neuve is early. Expect rough edges and changing commands." until they do.

## Intro

> Neuve is open-source code review, MIT-licensed, for code that agents write. Give it a commit range. It states what the change is for and splits it into batches, and each batch into smaller parts. Four agents look for problems (scope fit, correctness, risky edges and tests), and each finding is checked again in a fresh context before you see it. Each batch's summary says why the batch exists and links findings to the parts that hold them, and each finding cites the code it rests on. The diff is there whenever you want to read it, and you record your review in the review desk. Today it runs on your machine, and model calls go to the provider you set up. Neuve posts no reviews or comments to GitHub.
>
> How agents and people share the work: Neuve is designed to put each part of a change in one of four review lanes. Agents decide agentic work. On human-suggested work, a decision the agents have made stands unless a person steps in, and human-required work waits for a person. Today's runs put every part in human-suggested, and the agents only request changes or comment, so each part still comes to a person.

**Open:** the MIT wording waits on the `LICENSE` file landing on `main`.

## Why

In the owner's voice, in the first person:

> I started out building agents for QA, and soon saw that teams weren't stuck on QA. They were stuck on code review. I wanted large changes to stop being something to be overwhelmed by or afraid of: a review that filters out the parts people aren't required to see, and attaches the right information to the parts that matter. I've been building Neuve for almost a year to be that review.

Link: "Read the launch post →" (the article). **Open:** its final URL.

## Quick start

The commands belong to `oss-frontdoor`. The prose around them:

The order is install, then the model provider, then `neuve setup`, then review. Once NeuveAI/neuve#20 is on `main`, setup ends with a check of the review credential, so the provider comes before it.

- **Install** (labelled "Coming with the first release" until `oss-dist` ships it): "One line installs the `neuve` command."

  ```sh
  curl -fsSL https://neuve.ai/install.sh | sh
  ```

- **Connect a model provider:** "Reviews run on your own model account: an Anthropic API key or a ChatGPT subscription." **Open:** add Claude Code sign-in once it's on `main` and approved (NEU-143).
- **Set up your repository:** "Run `neuve setup` in your repository. It ends by checking that your provider's key or sign-in is available. `neuve doctor` names anything that's missing and how to fix it." The credential check and `neuve doctor` both land with #20. Until it's on `main`, leave out the last two sentences.

  ```sh
  neuve setup
  ```

- **Review a change:** "In the same repository, point Neuve at a commit range, then open the review in the review desk."

  ```sh
  neuve review main..my-branch
  neuve review desk
  ```

  `neuve review desk` lands with #20. Until it's on `main`, drop its line from the block and name no command for the desk.
- **Working on Neuve itself:** "To build Neuve from source or work from a checkout, see [CONTRIBUTING.md](CONTRIBUTING.md)." The checkout commands move there (13.13). Until the one-line install works, this link is also the way to try Neuve.

## Packages

A two-column table of package and what it is, as pulls.review has. `oss-frontdoor` takes the rows from the workspace table in `AGENTS.md`, reworded for readers who aren't agents: the `neuve` CLI, the web review desk, Records, the review rules, Neuve Graph and the graph client. No coding-workspace rows (decision 13.9). The host and channel packages the credits name may get one row, if `oss-frontdoor` lists internal packages.

## Credits

> Neuve's host and channel packages (`@ace/host` and `@ace/channel`) are adapted from GitHub Next's [Ace](https://github.com/githubnext/ace), and Neuve Graph is a fork of [Entire Graph](https://github.com/entireio/entire-graph). Both are MIT-licensed. The review desk's diffs render with a modified copy of Pierre's [`@pierre/diffs`](https://github.com/pierrecomputer/pierre) (Apache-2.0). The notices for all three are kept in the repository.

## License

> MIT License · Copyright (c) 2026 Neuve AI
