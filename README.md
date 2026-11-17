# Neuve

[![License: MIT](https://img.shields.io/badge/license-MIT-1C1A16)](LICENSE)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./design/brand/assets/social/readme-hero-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="./design/brand/assets/social/readme-hero-light.png">
  <img alt="Large code changes never felt so small - Focus only on parts that require human attention or approval, with the certainty your codebase deserves." src="./design/brand/assets/social/readme-hero-light.png">
</picture>

> [!NOTE]
> Neuve is early. Expect rough edges and changing commands.

Neuve is an open-source code review tool that allows developers and agents ship code with more confidence.

Neuve works using a hybrid agentic, graph and semantic layer on your code changes to abstract changes into different lanes.

**Automation**: CI/CD covered code with low complexity.
**Agentic**: Code that can easily be validated or its complexity does not require human attention or validation.
**Human Suggested**: Code that have risen above of changes that could safely be assigned to agentic reviews, but does not warrant immediate human attention.
**Human Required**: Code that either is difficult to validate through agentic checks, has high complexity score or has enough context signals that requires human attention.

Today it runs on your machine, using your Codex or Claude Code local setup. Neuve posts no reviews or comments to GitHub at this moment.

Neuve works by creating a review desk with changes assigned to one of four lanes as review units. Each range given to Neuve might come with more than one review desk, which is called a batch.

## Why

I started out building agents for QA, and soon realized that the highest friction point wasn't on QA but much earlier in the SDLC. From scoping work, to ensuring the right work is respecting the scope planend and afterwards auditing and reviewing that work to a satisfactory status.

As software engineers we used to say _done is better than perfect_ as a phrase to promote speed and avoid drawn out iterations. We now can get to **done** very easily and quickly, but getting to **good** is a challenge for mosts teams trying to operate at agentic speeds and volume.

I wanted large changes to stop being something to be overwhelmed by or hard to process within teams, so decided to rethink reviews all together.

## Quick start

One line installs the `neuve` command on Macs with Apple silicon (still working on Linux and Win builds).

```sh
curl -fsSL https://neuve.ai/install.sh | sh
```

Reviews run on your own model account. Choose one of three:

- **An Anthropic API key**, the default. Put it in the shell you run `neuve review` in:

  ```sh
  export ANTHROPIC_API_KEY=...
  ```

- **A Claude subscription**, through Claude Code. Install Claude Code, then sign in with its own login if you haven't yet. Neuve runs reviews through Claude Code and never reads your sign-in. Choose it with `neuve setup --route claude`.

  ```sh
  claude auth login
  ```

  If you installed Neuve before it offered this choice, update it first: run `neuve upgrade`, or the install line again if your `neuve` has no `upgrade`. An older `neuve` refuses a settings file that names `claude`.

- **A ChatGPT subscription.** Choose it with `neuve setup --route openai`, then sign in:

  ```sh
  neuve auth login openai
  ```

Run `neuve setup` in your repository. At a terminal it asks which of the three to use; `--route claude` or `--route openai` chooses without asking. It ends by checking that your sign-in is available. `neuve doctor` names anything that's missing and how to fix it. For a Claude subscription, doctor checks only that Claude Code is installed; `neuve auth status claude --check` checks the sign-in once Claude Code is installed, without spending usage.

```sh
cd /path/to/your/repository
neuve setup
```

In the same repository, point Neuve at a commit range, then open the review in the review desk:

```sh
neuve review main..my-branch
neuve review desk
```

`neuve review` starts a review and follows its run. A background worker runs the review, so closing the terminal doesn't stop it. Without `neuve setup`, `neuve review` and `neuve review desk` stop and print the setup command to run. `neuve review desk` prints the desk's address, such as `http://127.0.0.1:4141/`. The desk stays open until you press Ctrl-C. While it's open, `neuve review` also prints a link to the review. The [CLI guide](apps/neuve-cli/SETUP.md) covers setup, review settings, the desk and the other commands, and `neuve --help` lists them all.

### Upgrade and uninstall

```sh
neuve upgrade
curl -fsSL https://neuve.ai/install.sh | sh -s -- --uninstall
```

`neuve upgrade` installs the latest release. To install a given release, add its tag, such as `neuve upgrade --version v0.1.0`. The second line uninstalls Neuve.

### If an install was cut off

If you close the terminal or press Ctrl-C during an install, upgrade or uninstall, the installer puts the previous version back. Run the same command again.

If the machine lost power or the install was stopped with `kill -9`, the next run may stop with "Another install holds …/.install.lock". The folder is in your install folder, `~/.neuve` by default. If none is running, delete that empty folder. Then run the same command again, adding `--force` after `sh -s --`:

```sh
rmdir ~/.neuve/.install.lock
curl -fsSL https://neuve.ai/install.sh | sh -s -- --force
curl -fsSL https://neuve.ai/install.sh | sh -s -- --uninstall --force
```

The second line is for an install or upgrade, and the third for an uninstall. After an upgrade, use the install line above, because `neuve upgrade` has no `--force`.

If you installed into another folder with `NEUVE_INSTALL_DIR`, delete `.install.lock` in that folder instead. The installer's message gives the lock's full path, so you can copy it from there. Keep `NEUVE_INSTALL_DIR` set when you run the command again. Without it, the installer uses `~/.neuve`.

`--force` also lets the installer replace a copy built from source. Use it only when no other install is running.

Each user account has one launchd agent on macOS, or one systemd timer on Linux, that starts background workers. If you install into two folders, the install that finishes last takes it over. Running two installs into different folders at the same time isn't supported.

### Working on Neuve itself

To build Neuve from source or work from a checkout, see [CONTRIBUTING.md](CONTRIBUTING.md).

## How it works

```
commit range ─▶ goal, batches and parts ─▶ four agents look for problems ─▶ each finding checked again ─▶ you record your review in the review desk
```

| Step                    | What happens                                                                                                                                                                                                                                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Goal, batches and parts | Neuve states the change's goal and what done means, from the ticket or plan it can fetch, and says when there isn't one. Each changed line belongs to one part, even when a run is cut off                                                                                                                      |
| Looking for problems    | Scope fit says whether the change meets what done means, or that a person must judge it. Correctness follows the changed code to a failure you could see. Risky edges checks data, auth and interfaces such as exports, config and wire formats. Tests checks whether tests or other proof show what done means |
| Checking                | The check runs against evidence that Neuve's code gathers, with no lookup tools for the model. A finding that couldn't be checked is counted, never shown as a comment                                                                                                                                          |
| Your call               | From the overview of a batch, open one of its parts. The checked findings sit beside the lines they're about, and you record your review in the review desk                                                                                                                                                     |

The [product vocabulary](vocabulary.md) defines Neuve's terms, including the review unit, its name for a part, and the [architecture overview](architecture/README.md) describes the six layers behind them: harness, system of records, graph, CLI, MCP and web app.

## Documentation

- [Contributing](CONTRIBUTING.md): building Neuve from a checkout, the contributor check and how review works
- [CLI guide](apps/neuve-cli/SETUP.md): setting Neuve up in a repository, review settings, the desk and the other `neuve` commands
- [Architecture](architecture/README.md) and its records: how the system is built, and why
- [Packages](CONTRIBUTING.md#packages): the repository's packages and what each one is
- [Product vocabulary](vocabulary.md) and [foundations](foundations): what Neuve's terms and ideas mean
- [Design decisions](process/decisions.md): Neuve's product decisions, which override older text

## Contributing

Neuve is built by coding agents under independent review, and contributions go through the same review. [Contributing](CONTRIBUTING.md) explains how to propose a change, how review works and what a pull request needs. Please read the [code of conduct](CODE_OF_CONDUCT.md), and report security problems privately as the [security policy](SECURITY.md) describes.

## Credits

Neuve's host and channel packages (`@ace/host` and `@ace/channel`) are adapted from GitHub Next's [Ace](https://github.com/githubnext/ace), and Neuve Graph is a fork of [Entire Graph](https://github.com/entireio/entire-graph). Both are MIT-licensed. The review desk's diffs render with a modified copy of Pierre's [`@pierre/diffs`](https://github.com/pierrecomputer/pierre) (Apache-2.0). The notices for all three are kept in the repository.

Other third-party components, icons and fonts keep their own licenses. Some packages list them in a notice, such as the web app's interface package ([`apps/neuve-web/packages/ui`](apps/neuve-web/packages/ui/NOTICE.md)).

## License

[MIT License](LICENSE) · Copyright (c) 2026 Neuve AI
