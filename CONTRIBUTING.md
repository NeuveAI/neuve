# Contributing to Neuve

Thanks for wanting to help. Neuve is early, so the most useful contributions right now are bug reports with a reproduction, fixes to them, and accounts of where setup or review got in your way.

Please read this page before opening a pull request. It is short, and it saves both of us a round of review.

## Using AI

Neuve is built by coding agents under independent review, so we are glad to see agents in your work too. Two rules keep that honest:

- **Write to us in your own words.** Issues, comments and pull-request descriptions are a conversation with people. Say what you saw and what you think, briefly. Grammar doesn't matter; a long generated summary does, because someone has to read it.
- **Understand what you submit.** You are responsible for every line, whoever typed it. If you can't explain why a change is correct, it isn't ready for review.

## Before you start

- **Bugs:** open an issue with the [bug template](https://github.com/NeuveAI/neuve/issues/new?template=bug_report.yml). Include the exact command, its output and `neuve --version`. A small repository and range that reproduces it is the best report there is.
- **Features and larger changes:** open an issue first and wait for a maintainer's answer. Neuve's product decisions are written down in the [design decisions](process/decisions.md), which override older text; a change that conflicts with one needs a decision before it needs code.
- **Small fixes** such as typos or a broken link can go straight to a pull request. Batch several into one pull request.

## Build Neuve from a checkout

This is how you work on Neuve. To use it, install a release with the [README's one-line install](README.md#quick-start) instead. You need [Git](https://git-scm.com), [Bun](https://bun.sh) 1.4.4 and [Go](https://go.dev) 1.27 (an older Go downloads 1.27 on its first build). Maintainers run Neuve from a checkout on macOS, and pull-request CI runs the contributor check below on Linux.

```sh
git clone --recurse-submodules https://github.com/NeuveAI/neuve.git
cd neuve
bun install --frozen-lockfile
bun run build:graph
bun run install:cli --prefix ~/.neuve-src
export PATH="$HOME/.neuve-src/bin:$PATH"   # add this line to your shell profile
```

Then choose a model, run `neuve setup` in your repository, review a range and open the review desk, as the [README's quick start](README.md#quick-start) shows.

Maintainers build Neuve in a coding workspace, `bun workspace`, which runs only from a checkout. It isn't part of the public build of Neuve. [Developing Neuve](docs/development.md) has the development setup, the full command table and [how to open the workspace](docs/development.md#open-the-workspace).

## Packages

The [architecture overview](architecture/README.md) explains how they fit together.

| Package | What it is |
| --- | --- |
| [`apps/neuve-cli`](apps/neuve-cli) | The `neuve` command: setup, reviews, records, the worker, capture hooks and the MCP server |
| [`apps/neuve-web`](apps/neuve-web) | The web app for people: the batch overview and the review desk |
| [`apps/neuve-host`](apps/neuve-host), [`packages/channel`](packages/channel) | Neuve's host and channel packages. The README's [credits](README.md#credits) say where they come from |
| [`apps/neuve-graph`](https://github.com/NeuveAI/neuve-graph) | Neuve Graph, the structural and semantic code graph, in its own repository: a fork of Entire Graph |
| [`packages/harness`](packages/harness) | The review pipeline: it prepares review units, looks for problems and checks each finding |
| [`packages/records-schema`](packages/records-schema), [`packages/records-core`](packages/records-core) | The system of records: its schemas, and the library over one SQLite file per repository |
| [`packages/review-rules`](packages/review-rules) | The rules the harness and the web app share for what a review unit owns |
| [`packages/graph-client`](packages/graph-client), [`packages/semantic-client`](packages/semantic-client) | The validated boundaries to Neuve Graph and to the semantic workers |
| [`packages/runtime`](packages/runtime), [`packages/runtime-claude`](packages/runtime-claude), [`packages/runtime-codex`](packages/runtime-codex) | The account and runtime contracts, the runtime that runs reviews on a Claude subscription through Claude Code, and the client for Codex's app server that a Codex runtime is to be built on |
| [`packages/evaluation`](packages/evaluation) | Evaluation cases and evaluators |
| [`apps/website`](apps/website) | The neuve.ai site, which also serves the one-line installer from [`scripts/install.sh`](scripts/install.sh) |

## Check your change

The contributor check is three commands, and it needs only Git and Bun 1.4.4. Pull-request CI runs the same checks on Linux, leaving out the cases that need macOS or the Neuve Graph engine:

| Command | When |
| --- | --- |
| `bun run format` (CI runs `bun run format:check`) | Before every commit |
| `bun run typecheck` | Before every push |
| `bun run test` | Before every push; it runs every package's tests, one package at a time |

Tests that need the Neuve Graph engine skip when it isn't built. To run them too, install Go 1.27 and build it with `bun run build:graph`. Neuve Graph lives in [its own repository](https://github.com/NeuveAI/neuve-graph), mounted at `apps/neuve-graph`, with its own Go tooling and guide. `bun run check` is the maintainers' full check; you don't need it.

## How review works

Every change to Neuve, a maintainer's or yours, gets an independent reviewer who did not write it. The reviewer works from the change's goal and definition of done, not from the author's account, and follows the [adversarial review standard](process/adversarial-review-standard.md). Maintainers also run a Neuve review on each pull request's range, and the reviewer confirms or refutes each of Neuve's findings.

| Finding | Effect |
| --- | --- |
| A correctness or security defect | Blocks the change until it is fixed |
| Tests or proof that don't show what they claim | Blocks |
| Code in the wrong layer, or a second authority for something that already has one | Blocks |
| Missing proof | Left to the reviewer: it passes if the proof present is enough to trust the change |
| Style, preference or a possible improvement | Noted; doesn't block |

A green CI run or a passing `bun run check` is not approval; only review is.

## What a pull request needs

- **One change, explained.** Say what changed and why, and link the issue. Keep unrelated clean-ups out.
- **Proof that fits the change.** Logs or test output for the CLI and libraries; screenshots or a short video for anything in a browser; nothing extra for documentation. Proof from different sources should agree.
- **Tests only where they earn their place.** Each new test says why it exists, tests behaviour at the boundary it belongs to, and covers errors and bad input, not only the happy path.
- **Neuve's words.** Use the terms in the [product vocabulary](vocabulary.md) exactly, and don't coin new product terms; if you think one is missing, ask in the issue. Links say what they point to and why it matters, as the [repository constitution](CONSTITUTION.md) asks.
- **Plain commits.** Messages say what changed and why. No `Co-Authored-By` or other agent attribution trailers.
- **A draft until it is ready.** Open the pull request as a draft and mark it ready once CI passes and you have answered the template's checklist.

## Code of conduct

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md). Report security problems privately, as the [security policy](SECURITY.md) describes, never in a public issue.
